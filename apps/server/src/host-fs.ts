import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";

/**
 * Bounded host directory browsing for folder pickers.
 *
 * Read-only, names only (no file contents), depth-one listings. Traversal is
 * limited to absolute, normalized paths; hidden entries and common junk
 * directories are omitted. Errors degrade to an empty listing so the picker
 * never leaks raw errno details to the client.
 */

export interface HostDirListing {
  path: string;
  parent: string | null;
  home: string;
  dirs: { name: string; path: string }[];
  truncated: boolean;
}

const MAX_ENTRIES = 400;
const MAX_HOST_FILE_ACTION_BYTES = 16 * 1024;
const MAX_HOST_PATH_BYTES = 8 * 1024;
const SKIP_NAMES = new Set(["node_modules", "Library", "System", "Volumes/.timemachine"]);

export type HostFileAction = "open" | "reveal";

export class HostFileActionError extends Error {
  constructor(
    readonly status: 400 | 404 | 413 | 500 | 501,
    readonly code: "bad_request" | "not_found" | "unsupported" | "launch_failed",
    message: string,
  ) {
    super(message);
    this.name = "HostFileActionError";
  }
}

export async function listHostDirectories(rawPath: string | null): Promise<HostDirListing> {
  const home = homedir();
  let target = rawPath && rawPath.trim() !== "" ? rawPath.trim() : home;
  if (!isAbsolute(target)) target = home;
  target = normalize(target);
  // Collapse any trailing separator (except filesystem root).
  if (target.length > 1 && target.endsWith(sep)) target = target.slice(0, -1);

  let names: string[] = [];
  let truncated = false;
  try {
    const entries = await readdir(target, { withFileTypes: true });
    const dirs = entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith(".") && !SKIP_NAMES.has(name))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    truncated = dirs.length > MAX_ENTRIES;
    names = dirs.slice(0, MAX_ENTRIES);
  } catch {
    names = [];
  }

  const root = normalize(sep);
  const parent = target === root ? null : normalize(join(target, ".."));
  return {
    path: target,
    parent,
    home,
    dirs: names.map((name) => ({ name, path: join(target, name) })),
    truncated,
  };
}

/** Strictly parse the local-owner file action body without logging its path. */
export async function readHostFileAction(
  request: IncomingMessage,
  maxJsonBytes: number,
): Promise<{ path: string; action: HostFileAction }> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    request.resume();
    throw new HostFileActionError(400, "bad_request", "Content-Type must be application/json.");
  }
  const limit = Math.min(MAX_HOST_FILE_ACTION_BYTES, maxJsonBytes);
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0) {
      request.resume();
      throw new HostFileActionError(400, "bad_request", "File action request size is invalid.");
    }
    if (size > limit) {
      request.resume();
      throw new HostFileActionError(413, "bad_request", "File action request is too large.");
    }
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > limit) {
      request.resume();
      throw new HostFileActionError(413, "bad_request", "File action request is too large.");
    }
    chunks.push(buffer);
  }
  if (size === 0) throw new HostFileActionError(400, "bad_request", "A JSON request body is required.");

  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
  } catch {
    throw new HostFileActionError(400, "bad_request", "Request body must be valid JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HostFileActionError(400, "bad_request", "Request body must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "path" && key !== "action")
    || typeof record.path !== "string"
    || (record.action !== "open" && record.action !== "reveal")) {
    throw new HostFileActionError(400, "bad_request", "File action fields are invalid.");
  }
  return { path: validateHostPath(record.path), action: record.action };
}

/**
 * Open a path with its registered application or reveal it in the host file
 * manager. Commands and flags are fixed per platform and never use a shell.
 */
export async function performHostFileAction(path: string, action: HostFileAction): Promise<void> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() && !metadata.isDirectory()) throw new Error("unsupported node type");
  } catch {
    throw new HostFileActionError(404, "not_found", "The requested local file was not found.");
  }

  const command = hostFileCommand(path, action);
  if (command === undefined) {
    throw new HostFileActionError(501, "unsupported", "Local file actions are not supported on this host.");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, command.args, { shell: false, stdio: "ignore" });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", () => {
      reject(new HostFileActionError(500, "launch_failed", "The local file action could not be started."));
    });
  });
}

function validateHostPath(value: string): string {
  if (value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_HOST_PATH_BYTES
    || /[\u0000-\u001f\u007f]/.test(value)
    || !isAbsolute(value)) {
    throw new HostFileActionError(400, "bad_request", "An absolute local path is required.");
  }
  return normalize(value);
}

function hostFileCommand(
  path: string,
  action: HostFileAction,
): { executable: string; args: string[] } | undefined {
  switch (platform()) {
    case "darwin":
      return { executable: "/usr/bin/open", args: action === "reveal" ? ["-R", path] : [path] };
    case "win32":
      return { executable: "explorer.exe", args: action === "reveal" ? [`/select,${path}`] : [path] };
    case "linux":
      return { executable: "/usr/bin/xdg-open", args: [action === "reveal" ? dirname(path) : path] };
    default:
      return undefined;
  }
}
