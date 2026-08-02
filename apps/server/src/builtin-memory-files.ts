import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/** Matches Office / Hermes profile identifier shape (before case normalization). */
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FILE_KEYS = ["memory", "user"] as const;
export type BuiltinMemoryFileKey = (typeof FILE_KEYS)[number];

const FILE_NAMES: Readonly<Record<BuiltinMemoryFileKey, string>> = {
  memory: "MEMORY.md",
  user: "USER.md",
};

/** Per-file UTF-8 budget for Office raw memory editing (aligned with SOUL). */
export const BUILTIN_MEMORY_MAX_BYTES = 256 * 1024;

/** Prefer O_NOFOLLOW when the platform exposes it (POSIX / modern Node). */
const O_NOFOLLOW = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
const O_DIRECTORY = "O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0;

export interface BuiltinMemoryFileDto {
  key: BuiltinMemoryFileKey;
  content: string;
  exists: boolean;
  bytes: number;
  revision: string;
}

export interface BuiltinMemoryFilesDto {
  profile: string;
  memory: BuiltinMemoryFileDto;
  user: BuiltinMemoryFileDto;
}

export interface BuiltinMemoryFilesStoreOptions {
  /**
   * Hermes root used for profile resolution (default: platform Hermes root,
   * including HERMES_HOME Docker/custom handling).
   */
  hermesRoot?: string;
  /** Override for tests; must resolve only under the configured root. */
  resolveProfileHome?: (profile: string) => Promise<string> | string;
  maxBytes?: number;
}

export class BuiltinMemoryFilesError extends Error {
  readonly code: "conflict" | "invalid_request" | "not_found" | "rejected";
  constructor(code: BuiltinMemoryFilesError["code"], message: string) {
    super(message);
    this.name = "BuiltinMemoryFilesError";
    this.code = code;
  }
}

/**
 * Office-owned safe reader/writer for built-in MEMORY.md / USER.md.
 * Targets only `<resolved HERMES_HOME>/memories/{MEMORY,USER}.md`.
 * Refuses path traversal, intermediate and leaf symlinks, and non-regular files.
 */
export class BuiltinMemoryFilesStore {
  readonly #hermesRoot: string;
  readonly #resolveProfileHome?: BuiltinMemoryFilesStoreOptions["resolveProfileHome"];
  readonly #maxBytes: number;

  constructor(options: BuiltinMemoryFilesStoreOptions = {}) {
    this.#hermesRoot = options.hermesRoot === undefined
      ? defaultHermesRoot()
      : requireAbsolutePath(options.hermesRoot, "Hermes root");
    this.#resolveProfileHome = options.resolveProfileHome;
    // Production uses the 256 KiB default. Smaller explicit values are useful
    // for bounded tests and remain strictly safer than the production budget.
    this.#maxBytes = bounded(options.maxBytes, BUILTIN_MEMORY_MAX_BYTES, 1, 512 * 1024);
  }

  async readAll(profile: string): Promise<BuiltinMemoryFilesDto> {
    const validProfile = requiredProfile(profile);
    const home = await this.#resolvedProfileHome(validProfile);
    const memories = await resolveMemoriesDirectory(home, { create: false });
    if (memories === null) {
      return { profile: validProfile, memory: emptyFile("memory"), user: emptyFile("user") };
    }
    const [memory, user] = await Promise.all([
      this.#readOne(home, memories, "memory"),
      this.#readOne(home, memories, "user"),
    ]);
    // Re-validate after reads so a TOCTOU swap of `memories` cannot silently succeed.
    await assertMemoriesUnchanged(home, memories);
    return { profile: validProfile, memory, user };
  }

  async write(
    profile: string,
    key: BuiltinMemoryFileKey,
    content: string,
    expectedRevision: string,
  ): Promise<BuiltinMemoryFileDto> {
    const validProfile = requiredProfile(profile);
    const validKey = requiredKey(key);
    if (typeof content !== "string" || content.includes("\0")) {
      throw invalid("Built-in memory content is invalid.");
    }
    if (!isStrictUtf8(content)) {
      throw invalid("Built-in memory content must be UTF-8 text.");
    }
    if (Buffer.byteLength(content, "utf8") > this.#maxBytes) {
      throw invalid("Built-in memory content is too large.");
    }
    const expected = requiredRevision(expectedRevision);
    const home = await this.#resolvedProfileHome(validProfile);
    const memories = await resolveMemoriesDirectory(home, { create: true });
    if (memories === null) throw new BuiltinMemoryFilesError("rejected", "Unable to prepare built-in memory directory.");

    const target = safeMemoryFilePathInMemories(home, memories, validKey);
    const current = await this.#readAt(home, memories, target, validKey);
    if (current.revision !== expected) throw conflict();

    await assertWritableTarget(target);
    await atomicWriteText(home, memories, target, content);
    await assertMemoriesUnchanged(home, memories);
    return await this.#readAt(home, memories, target, validKey);
  }

  async #resolvedProfileHome(profile: string): Promise<string> {
    if (this.#resolveProfileHome !== undefined) {
      const home = requireAbsolutePath(await this.#resolveProfileHome(profile), "Profile home");
      return await assertExistingDirectory(home, "Hermes profile does not exist.");
    }
    const root = await resolveExistingDirectory(this.#hermesRoot, "Hermes home was not found.");
    // Reject a symlink leaf for the Hermes root / profile container where practical.
    await assertNotSymlinkLeaf(this.#hermesRoot, "Hermes root");
    const canon = canonicalizeProfileName(profile);
    if (canon === "default") return root;

    const profilesDir = join(root, "profiles");
    await assertExistingDirectoryComponent(profilesDir, root, "profiles");
    const home = join(profilesDir, canon);
    const resolved = await assertExistingDirectory(home, "Hermes profile does not exist.");
    if (!isPathInside(root, resolved)) {
      throw invalid("Profile home escapes the Hermes root.");
    }
    await assertNotSymlinkLeaf(home, "Profile home");
    return resolved;
  }

  async #readOne(
    home: string,
    memories: string,
    key: BuiltinMemoryFileKey,
  ): Promise<BuiltinMemoryFileDto> {
    const target = safeMemoryFilePathInMemories(home, memories, key);
    return await this.#readAt(home, memories, target, key);
  }

  async #readAt(
    home: string,
    memories: string,
    target: string,
    key: BuiltinMemoryFileKey,
  ): Promise<BuiltinMemoryFileDto> {
    // lstat the leaf first so platforms without O_NOFOLLOW still reject symlinks.
    let leaf;
    try {
      leaf = await lstat(target);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return emptyFile(key);
      throw new BuiltinMemoryFilesError("rejected", "Unable to read built-in memory.");
    }
    if (leaf.isSymbolicLink()) throw invalid("Built-in memory path must not be a symbolic link.");
    if (!leaf.isFile()) throw invalid("Built-in memory path must be a regular file.");
    if (leaf.size > this.#maxBytes) throw invalid("Built-in memory file is too large.");
    await assertPathStillUnderMemories(home, memories, target);

    // Final-component O_NOFOLLOW when available; intermediate dirs must already be validated.
    let handle;
    try {
      handle = await open(target, constants.O_RDONLY | O_NOFOLLOW);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return emptyFile(key);
      if (isNodeError(error, "ELOOP")) {
        throw invalid("Built-in memory path must not be a symbolic link.");
      }
      // Fall back to a second lstat + read when open flags are unsupported.
      const again = await lstat(target).catch(() => undefined);
      if (again === undefined) return emptyFile(key);
      if (again.isSymbolicLink()) throw invalid("Built-in memory path must not be a symbolic link.");
      if (!again.isFile()) throw invalid("Built-in memory path must be a regular file.");
      try {
        return decodeMemoryBuffer(await readFile(target), key, this.#maxBytes);
      } catch {
        throw new BuiltinMemoryFilesError("rejected", "Unable to read built-in memory.");
      }
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw invalid("Built-in memory path must be a regular file.");
      if (stats.size > this.#maxBytes) throw invalid("Built-in memory file is too large.");
      const buffer = await handle.readFile();
      return decodeMemoryBuffer(buffer, key, this.#maxBytes);
    } finally {
      await handle.close();
    }
  }
}

/**
 * Resolve and validate `<home>/memories`.
 * - Missing: returns null when `create` is false; creates a real directory when true.
 * - Existing symlink or non-directory: rejected.
 * - Realpath must stay inside the verified profile home.
 */
export async function resolveMemoriesDirectory(
  profileHome: string,
  options: { create: boolean },
): Promise<string | null> {
  const home = requireAbsolutePath(profileHome, "Profile home");
  const memories = join(home, "memories");
  if (dirname(memories) !== home && resolve(dirname(memories)) !== resolve(home)) {
    throw invalid("Built-in memory directory path is invalid.");
  }

  let stats;
  try {
    stats = await lstat(memories);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw new BuiltinMemoryFilesError("rejected", "Unable to inspect built-in memory directory.");
    }
    if (!options.create) return null;
    try {
      // Single segment under a verified home — never recursive mkdir (avoids following parents).
      await mkdir(memories, { recursive: false, mode: 0o700 });
    } catch (createError) {
      if (!isNodeError(createError, "EEXIST")) {
        throw new BuiltinMemoryFilesError("rejected", "Unable to create built-in memory directory.");
      }
    }
    try {
      stats = await lstat(memories);
    } catch {
      throw new BuiltinMemoryFilesError("rejected", "Unable to inspect built-in memory directory.");
    }
  }

  if (stats.isSymbolicLink()) throw invalid("Built-in memory directory must not be a symbolic link.");
  if (!stats.isDirectory()) throw invalid("Built-in memory directory must be a regular directory.");

  // Prefer opening as a directory without following a leaf symlink when the OS allows it.
  if (O_DIRECTORY !== 0 || O_NOFOLLOW !== 0) {
    try {
      const dirHandle = await open(memories, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      await dirHandle.close();
    } catch (error) {
      if (isNodeError(error, "ELOOP") || isNodeError(error, "EINVAL") || isNodeError(error, "ENOTDIR")) {
        throw invalid("Built-in memory directory must be a regular directory.");
      }
      // Platforms without these flags: continue with lstat/realpath checks.
    }
  }

  let resolved: string;
  try {
    resolved = await realpath(memories);
  } catch {
    throw new BuiltinMemoryFilesError("rejected", "Unable to resolve built-in memory directory.");
  }
  if (!isPathInside(home, resolved)) {
    throw invalid("Built-in memory directory escapes the profile home.");
  }

  // Re-lstat the path we joined (not only the realpath) to catch a leaf symlink race.
  const leaf = await lstat(memories);
  if (leaf.isSymbolicLink()) throw invalid("Built-in memory directory must not be a symbolic link.");
  if (!leaf.isDirectory()) throw invalid("Built-in memory directory must be a regular directory.");

  return resolved;
}

/** Fixed relative segments only — never accept a user-supplied path fragment. */
export function safeMemoryFilePath(profileHome: string, key: BuiltinMemoryFileKey): string {
  const home = requireAbsolutePath(profileHome, "Profile home");
  const memories = join(home, "memories");
  return safeMemoryFilePathInMemories(home, memories, key);
}

function safeMemoryFilePathInMemories(
  profileHome: string,
  memoriesDir: string,
  key: BuiltinMemoryFileKey,
): string {
  const validKey = requiredKey(key);
  const home = requireAbsolutePath(profileHome, "Profile home");
  const memories = requireAbsolutePath(memoriesDir, "Memories directory");
  if (!isPathInside(home, memories) && memories !== home) {
    // memories must be strictly under home (realpath of memories is never equal to home).
    if (!isPathInside(home, memories)) throw invalid("Built-in memory path escapes the profile home.");
  }
  const target = join(memories, FILE_NAMES[validKey]);
  if (dirname(target) !== memories) throw invalid("Built-in memory path is invalid.");
  if (!isPathInside(memories, target) && target !== join(memories, FILE_NAMES[validKey])) {
    throw invalid("Built-in memory path escapes the memories directory.");
  }
  if (!isPathInside(home, target)) throw invalid("Built-in memory path escapes the profile home.");
  return target;
}

/**
 * Mirror Hermes `get_default_hermes_root()` for Office's local trust model.
 * - native root when HERMES_HOME is unset or under the native home
 * - grandparent when HERMES_HOME is `<root>/profiles/<name>`
 * - HERMES_HOME itself for Docker/custom deployments
 */
export function defaultHermesRoot(env: NodeJS.ProcessEnv = process.env): string {
  const native = platformNativeHermesHome(env);
  const configured = env.HERMES_HOME?.trim();
  if (!configured || configured.includes("\0")) return native;

  const envPath = resolve(configured);
  const nativeResolved = resolve(native);
  if (envPath === nativeResolved || isPathInside(nativeResolved, envPath)) return nativeResolved;

  if (basenameOf(dirname(envPath)) === "profiles") {
    return dirname(dirname(envPath));
  }
  return envPath;
}

export function resolveProfileHomePath(profile: string, hermesRoot: string = defaultHermesRoot()): string {
  const canon = canonicalizeProfileName(requiredProfile(profile));
  const root = requireAbsolutePath(hermesRoot, "Hermes root");
  return canon === "default" ? root : join(root, "profiles", canon);
}

function platformNativeHermesHome(env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA?.trim();
    if (local && !local.includes("\0")) return join(local, "hermes");
    return join(homedir(), "AppData", "Local", "hermes");
  }
  return join(homedir(), ".hermes");
}

function emptyFile(key: BuiltinMemoryFileKey): BuiltinMemoryFileDto {
  return { key, content: "", exists: false, bytes: 0, revision: revisionOf("") };
}

function decodeMemoryBuffer(buffer: Buffer, key: BuiltinMemoryFileKey, maxBytes: number): BuiltinMemoryFileDto {
  if (buffer.byteLength > maxBytes) throw invalid("Built-in memory file is too large.");
  if (buffer.includes(0)) throw invalid("Built-in memory file contains a NUL byte.");
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw invalid("Built-in memory file is not valid UTF-8.");
  }
  return {
    key,
    content,
    exists: true,
    bytes: buffer.byteLength,
    revision: revisionOf(content),
  };
}

async function assertExistingDirectory(path: string, notFoundMessage: string): Promise<string> {
  const resolved = await resolveExistingDirectory(path, notFoundMessage);
  await assertNotSymlinkLeaf(path, "Profile home");
  return resolved;
}

async function assertExistingDirectoryComponent(
  path: string,
  root: string,
  label: string,
): Promise<string> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new BuiltinMemoryFilesError("not_found", "Hermes profile does not exist.");
    }
    throw new BuiltinMemoryFilesError("rejected", `Unable to inspect ${label} directory.`);
  }
  if (stats.isSymbolicLink()) throw invalid(`${label} directory must not be a symbolic link.`);
  if (!stats.isDirectory()) throw invalid(`${label} directory must be a regular directory.`);
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch {
    throw new BuiltinMemoryFilesError("not_found", "Hermes profile does not exist.");
  }
  if (!isPathInside(root, resolved) && resolved !== root) {
    throw invalid(`${label} directory escapes the Hermes root.`);
  }
  return resolved;
}

async function resolveExistingDirectory(path: string, notFoundMessage: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch {
    throw new BuiltinMemoryFilesError("not_found", notFoundMessage);
  }
  const stats = await lstat(resolved);
  if (!stats.isDirectory()) throw invalid("Profile home must be a regular directory.");
  return resolved;
}

async function assertNotSymlinkLeaf(path: string, label: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new BuiltinMemoryFilesError("not_found", `${label} was not found.`);
    }
    throw new BuiltinMemoryFilesError("rejected", `Unable to inspect ${label}.`);
  }
  if (stats.isSymbolicLink()) throw invalid(`${label} must not be a symbolic link.`);
}

async function assertMemoriesUnchanged(home: string, expectedResolved: string): Promise<void> {
  const again = await resolveMemoriesDirectory(home, { create: false });
  if (again === null || again !== expectedResolved) {
    throw invalid("Built-in memory directory changed during the operation.");
  }
}

async function assertPathStillUnderMemories(
  home: string,
  memories: string,
  target: string,
): Promise<void> {
  if (!isPathInside(memories, target) && dirname(target) !== memories) {
    throw invalid("Built-in memory path escapes the memories directory.");
  }
  if (!isPathInside(home, target)) {
    throw invalid("Built-in memory path escapes the profile home.");
  }
}

async function assertWritableTarget(target: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(target);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw new BuiltinMemoryFilesError("rejected", "Unable to write built-in memory.");
  }
  if (stats.isSymbolicLink()) throw invalid("Built-in memory path must not be a symbolic link.");
  if (!stats.isFile()) throw invalid("Built-in memory path must be a regular file.");
}

async function atomicWriteText(
  home: string,
  memories: string,
  filePath: string,
  content: string,
): Promise<void> {
  // Parent must already be the verified memories directory (no recursive mkdir).
  if (dirname(filePath) !== memories && resolve(dirname(filePath)) !== resolve(memories)) {
    throw invalid("Built-in memory path is invalid.");
  }
  await assertMemoriesUnchanged(home, memories);

  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Reject if the destination became a symlink between check and rename.
    await assertWritableTarget(filePath);
    await rename(temporary, filePath);
  } catch (error) {
    if (error instanceof BuiltinMemoryFilesError) throw error;
    if (isNodeError(error, "ELOOP")) throw invalid("Built-in memory path must not be a symbolic link.");
    throw new BuiltinMemoryFilesError("rejected", "Unable to write built-in memory.");
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function requiredProfile(value: unknown): string {
  if (typeof value !== "string" || !PROFILE_PATTERN.test(value)) {
    throw invalid("Profile name is invalid.");
  }
  return value;
}

function canonicalizeProfileName(profile: string): string {
  if (profile.toLowerCase() === "default") return "default";
  // Hermes stores named profiles lowercase under profiles/<id>/.
  return profile.toLowerCase();
}

function requiredKey(value: unknown): BuiltinMemoryFileKey {
  if (value === "memory" || value === "user") return value;
  throw invalid("Built-in memory file key is invalid.");
}

function requiredRevision(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw invalid("Settings revision is invalid.");
  }
  return value;
}

function revisionOf(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function isStrictUtf8(value: string): boolean {
  try {
    const encoded = Buffer.from(value, "utf8");
    return new TextDecoder("utf-8", { fatal: true }).decode(encoded) === value;
  } catch {
    return false;
  }
}

function requireAbsolutePath(value: string, label: string): string {
  if (value.trim() === "" || value.includes("\0")) throw invalid(`${label} is invalid.`);
  const resolved = resolve(value);
  if (!isAbsolute(resolved)) throw invalid(`${label} must be absolute.`);
  return resolved;
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  if (normalizedCandidate === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  return normalizedCandidate.startsWith(prefix);
}

function basenameOf(value: string): string {
  const parts = value.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.trunc(value)));
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function invalid(message: string): BuiltinMemoryFilesError {
  return new BuiltinMemoryFilesError("invalid_request", message);
}

function conflict(): BuiltinMemoryFilesError {
  return new BuiltinMemoryFilesError("conflict", "Hermes setting changed; refresh before saving.");
}
