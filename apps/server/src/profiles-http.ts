import type { IncomingMessage, ServerResponse } from "node:http";
import { HermesCommitUnconfirmedError, HermesProfileError, type HermesRuntimeSource } from "./hermes-backend.js";
import { writeError, writeJson } from "./server-http.js";

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROFILES_PATH = "/api/v1/profiles";
const PROFILE_RESOURCE = /^\/api\/v1\/profiles\/([^/]+)$/;
const MAX_PROFILE_BODY_BYTES = 8 * 1024;

export function isProfilesHttpPath(pathname: string): boolean {
  return pathname === PROFILES_PATH || PROFILE_RESOURCE.test(pathname);
}

export function isProfilesMutation(method: string | undefined): boolean {
  return method === "POST" || method === "DELETE";
}

export function profilesOperation(method: string | undefined): "profile.create" | "profile.delete" | "state.read" {
  if (method === "POST") return "profile.create";
  if (method === "DELETE") return "profile.delete";
  return "state.read";
}

/** POST /api/v1/profiles and DELETE /api/v1/profiles/{name}, proxied to upstream Hermes. */
export async function handleProfilesHttp(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  runtime: HermesRuntimeSource | undefined,
  maxJsonBytes: number,
  maxResponseJsonBytes: number,
): Promise<void> {
  if (request.method === "POST" && requestUrl.pathname === PROFILES_PATH) {
    if (runtime?.createProfile === undefined) {
      request.resume();
      writeError(response, 503, "runtime_unavailable", "Hermes runtime does not support profile creation.", maxJsonBytes);
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(request, Math.min(MAX_PROFILE_BODY_BYTES, maxJsonBytes));
    } catch (error) {
      if (!request.readableEnded) request.resume();
      writeError(response, 400, "bad_request", error instanceof Error ? error.message : "Request body is invalid.", maxJsonBytes);
      return;
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!PROFILE_PATTERN.test(name)) {
      writeError(response, 400, "bad_request", "Profile name is invalid (letters, digits, dot, dash, underscore; max 64).", maxJsonBytes);
      return;
    }
    const description = typeof body.description === "string" ? body.description.slice(0, 500) : undefined;
    try {
      await runtime.createProfile(name, {
        cloneFromDefault: body.cloneFromDefault !== false,
        ...(description === undefined ? {} : { description }),
      });
      writeJson(response, 201, { ok: true, name }, maxResponseJsonBytes, { "Cache-Control": "no-store" });
    } catch (error) {
      if (error instanceof HermesCommitUnconfirmedError) {
        writeJson(response, 409, {
          code: "commit_unconfirmed",
          message: "Hermes may have created this profile; refresh the profile list before retrying.",
          retryable: false,
        }, maxResponseJsonBytes, { "Cache-Control": "no-store" });
        return;
      }
      if (error instanceof HermesProfileError && (error.code === "invalid" || error.code === "exists")) {
        const message = error.code === "exists" ? "A profile with this name already exists." : "Profile name is invalid.";
        writeError(response, 400, "bad_request", message, maxJsonBytes);
        return;
      }
      writeError(response, 502, "runtime_unavailable", "Hermes rejected the profile create request.", maxJsonBytes);
    }
    return;
  }

  const resource = PROFILE_RESOURCE.exec(requestUrl.pathname);
  if (request.method === "DELETE" && resource !== null) {
    let name: string;
    try {
      name = decodeURIComponent(resource[1]!);
    } catch {
      writeError(response, 400, "bad_request", "Profile name is malformed.", maxJsonBytes);
      return;
    }
    if (!PROFILE_PATTERN.test(name)) {
      writeError(response, 400, "bad_request", "Profile name is invalid.", maxJsonBytes);
      return;
    }
    if (name === "default") {
      writeError(response, 400, "bad_request", "The default profile cannot be deleted.", maxJsonBytes);
      return;
    }
    if (runtime?.deleteProfile === undefined) {
      writeError(response, 503, "runtime_unavailable", "Hermes runtime does not support profile deletion.", maxJsonBytes);
      return;
    }
    try {
      await runtime.deleteProfile(name);
      writeJson(response, 200, { ok: true, name }, maxResponseJsonBytes, { "Cache-Control": "no-store" });
    } catch (error) {
      if (error instanceof HermesProfileError && error.code === "not_found") {
        writeError(response, 404, "not_found", "Hermes profile was not found.", maxJsonBytes);
        return;
      }
      if (error instanceof HermesProfileError && (error.code === "invalid" || error.code === "default")) {
        const message = error.code === "default" ? "The default profile cannot be deleted." : "Profile name is invalid.";
        writeError(response, 400, "bad_request", message, maxJsonBytes);
        return;
      }
      writeError(response, 502, "runtime_unavailable", "Hermes rejected the profile delete request.", maxJsonBytes);
    }
    return;
  }

  writeError(response, 405, "bad_request", "Only POST (create) and DELETE (remove) are supported.", maxJsonBytes, {
    Allow: "POST, DELETE",
  });
}

async function readJsonObject(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("Content-Type must be application/json.");
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Content-Length is invalid.");
    if (size > limit) {
      request.resume();
      throw new Error("Request body is too large.");
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > limit) {
      request.resume();
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }
  if (size === 0) throw new Error("A JSON request body is required.");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}
