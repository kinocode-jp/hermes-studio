import { spawn } from "node:child_process";
import { redactSecrets } from "./secret-scrubber.js";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CLI_OUTPUT_BYTES = 8 * 1024;
export type HermesRuntimeState = "incompatible" | "ready" | "unavailable";
export type HermesCliState = "available" | "incompatible" | "not_configured" | "unavailable";

export type HermesRuntimeReason =
  | "invalid_response"
  | "network_error"
  | "ready"
  | "response_too_large"
  | "timed_out"
  | "unexpected_status"
  | "unsupported_version";

export interface HermesRuntimeConfig {
  /** Explicit operator-configured Hermes origin. Credentials are forbidden. */
  baseUrl: string;
  /** Explicit executable path/name. PATH discovery is intentionally not performed. */
  executable?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface HermesCliHealth {
  state: HermesCliState;
  version?: string;
}

/** Public, redacted health DTO. It never includes process output, paths, headers, or errors. */
export interface HermesRuntimeHealth {
  state: HermesRuntimeState;
  reason: HermesRuntimeReason;
  checkedAt: string;
  baseUrl: string;
  latencyMs: number;
  cli: HermesCliHealth;
  runtime?: {
    version: string;
    releaseDate: string;
    configVersion: number;
    latestConfigVersion: number;
    gatewayRunning: boolean;
    gatewayState: null | string;
    activeSessions: number;
    authRequired: boolean;
    authProviders: string[];
  };
}

interface HermesStatusWire {
  version: string;
  release_date: string;
  config_version: number;
  latest_config_version: number;
  gateway_running: boolean;
  gateway_state: null | string;
  active_sessions: number;
  auth_required?: boolean;
  auth_providers?: string[];
}

interface ProbeLimits {
  timeoutMs: number;
  maxResponseBytes: number;
}

export async function discoverHermesRuntime(
  config: HermesRuntimeConfig,
): Promise<HermesRuntimeHealth> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const limits: ProbeLimits = {
    timeoutMs: boundedInteger(config.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 15_000),
    maxResponseBytes: boundedInteger(
      config.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      1_024,
      1024 * 1024,
    ),
  };
  const startedAt = performance.now();
  const [runtime, cli] = await Promise.all([
    probeStatus(baseUrl, limits),
    probeHermesCli(config.executable, limits.timeoutMs),
  ]);

  return {
    ...runtime,
    checkedAt: new Date().toISOString(),
    baseUrl: baseUrl.origin,
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    cli,
  };
}

export function normalizeBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Hermes baseUrl must be an absolute HTTP(S) URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Hermes baseUrl must use HTTP or HTTPS.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Hermes baseUrl must not contain credentials.");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("Hermes baseUrl must not contain a query or fragment.");
  }
  if (url.pathname !== "/") {
    throw new Error("Hermes baseUrl must be an origin without a path.");
  }
  return url;
}

export async function probeHermesCli(
  executable: string | undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<HermesCliHealth> {
  if (executable === undefined || executable.trim() === "") {
    return { state: "not_configured" };
  }
  if (executable.includes("\0")) return { state: "unavailable" };
  if (signal?.aborted === true) return { state: "unavailable" };

  const boundedTimeout = boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 100, 15_000);

  return await new Promise((resolve) => {
    let settled = false;
    let output = "";
    const child = spawn(executable, ["--version"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: createVersionProbeEnvironment(),
    });
    const finish = (result: HermesCliHealth, stopChild = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.stdout.off("data", capture);
      child.stderr.off("data", capture);
      child.off("error", onError);
      child.off("close", onClose);
      if (stopChild && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ state: "unavailable" });
    }, boundedTimeout);
    timer.unref();
    function abort(): void {
      child.kill("SIGKILL");
      finish({ state: "unavailable" });
    }

    const capture = (chunk: Buffer): void => {
      if (output.length >= MAX_CLI_OUTPUT_BYTES) return;
      output += chunk.toString("utf8", 0, MAX_CLI_OUTPUT_BYTES - output.length);
      const match = /^Hermes Agent v([^\s]+)/m.exec(output);
      if (match?.[1] !== undefined) {
        finish(isRecognizedHermesVersion(match[1])
          ? { state: "available", version: match[1] }
          : { state: "unavailable" }, true);
      }
    };
    const onError = (): void => finish({ state: "unavailable" });
    const onClose = (code: number | null): void => {
      if (code !== 0) {
        finish({ state: "unavailable" });
        return;
      }
      const match = /^Hermes Agent v([^\s]+)/m.exec(output);
      if (match?.[1] === undefined) {
        finish({ state: "unavailable" });
        return;
      }
      finish(isRecognizedHermesVersion(match[1])
        ? { state: "available", version: match[1] }
        : { state: "unavailable" });
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", onError);
    child.on("close", onClose);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
  });
}

export function isRecognizedHermesVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor) && Number.isSafeInteger(patch);
}

export function createVersionProbeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "HERMES_HOME"] as const) {
    const value = source[key];
    if (value !== undefined && value !== "" && !value.includes("\0")) environment[key] = value;
  }
  return environment;
}

async function probeStatus(
  baseUrl: URL,
  limits: ProbeLimits,
): Promise<Pick<HermesRuntimeHealth, "reason" | "runtime" | "state">> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  timer.unref();

  try {
    const statusUrl = new URL("/api/status", baseUrl);
    const response = await fetch(statusUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return { state: "incompatible", reason: "unexpected_status" };

    let body: string;
    try {
      body = await readBoundedBody(response, limits.maxResponseBytes);
    } catch (error) {
      if (error instanceof ResponseTooLargeError) {
        return { state: "incompatible", reason: "response_too_large" };
      }
      throw error;
    }

    const status = parseHermesStatus(body);
    if (status === undefined) return { state: "incompatible", reason: "invalid_response" };
    if (!isRecognizedHermesVersion(status.version)) {
      return { state: "incompatible", reason: "unsupported_version" };
    }

    return {
      state: "ready",
      reason: "ready",
      runtime: {
        version: status.version,
        releaseDate: safePublicText(status.release_date, 200),
        configVersion: status.config_version,
        latestConfigVersion: status.latest_config_version,
        gatewayRunning: status.gateway_running,
        gatewayState: status.gateway_state === null ? null : safePublicText(status.gateway_state, 200),
        activeSessions: status.active_sessions,
        authRequired: status.auth_required ?? false,
        authProviders: status.auth_providers === undefined
          ? []
          : status.auth_providers.slice(0, 100).map((provider) => safePublicText(provider, 100)),
      },
    };
  } catch (error) {
    return {
      state: "unavailable",
      reason: isAbortError(error) ? "timed_out" : "network_error",
    };
  } finally {
    clearTimeout(timer);
  }
}

function safePublicText(value: string, maxChars: number): string {
  return redactSecrets(value).value.slice(0, maxChars).replace(/[\u0000-\u001f\u007f]/g, "");
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new ResponseTooLargeError();
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ResponseTooLargeError();
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
    if (size > maxBytes) await response.body.cancel();
  }
}

function parseHermesStatus(body: string): HermesStatusWire | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (
    typeof value.version !== "string" || value.version.length === 0 ||
    typeof value.release_date !== "string" ||
    !isNonNegativeInteger(value.config_version) ||
    !isNonNegativeInteger(value.latest_config_version) ||
    typeof value.gateway_running !== "boolean" ||
    !(value.gateway_state === null || typeof value.gateway_state === "string") ||
    !isNonNegativeInteger(value.active_sessions) ||
    !(value.auth_required === undefined || typeof value.auth_required === "boolean") ||
    !(value.auth_providers === undefined || isStringArray(value.auth_providers))
  ) return undefined;

  return value as unknown as HermesStatusWire;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 32 && value.every((item) => typeof item === "string");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

class ResponseTooLargeError extends Error {}
