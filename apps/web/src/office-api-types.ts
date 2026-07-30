import { OPERATION_POLICIES } from "@hermes-studio/protocol";
import type { OfficeRuntimeState, OfficeSnapshot, OfficeSnapshotRequestIdentity } from "./domain";
import type { DeviceLoginFailure } from "./auth-state";

export type HealthResponse = {
  ok: true;
  protocolVersion: number;
  runtime: OfficeRuntimeState;
};

export type OfficeEvent = {
  topic: string;
  sequence: number;
  payload?: unknown;
};

export type OfficeApiCallbacks = {
  onConnecting(serverUrl: string): void;
  onSnapshot(snapshot: OfficeSnapshot, identity: OfficeSnapshotRequestIdentity): void;
  onEventStream(state: "closed" | "connecting" | "open"): void;
  onError(message: string, serverUrl: string): void;
  onRecoveryUnavailable?(message: string, serverUrl: string): void;
  onAuthRequired?(serverUrl: string): void;
  onEvent?(event: OfficeEvent): void;
};

export type OfficeApiConnection = {
  stop(): void;
  retry(): void;
  refresh(expected?: Pick<OfficeSnapshotRequestIdentity, "serverUrl" | "connectionGeneration">): Promise<OfficeSnapshotRequestIdentity | undefined>;
};

export type OfficeApiRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  timeoutMs?: number;
};

export type DeviceLoginResult = { ok: true } | ({ ok: false } & DeviceLoginFailure);

export class OfficeDeviceAuthRequiredError extends Error {
  constructor() {
    super("Remote device authentication is required.");
    this.name = "OfficeDeviceAuthRequiredError";
  }
}

export class OfficeSessionUnavailableError extends Error {
  constructor(message: string, readonly retryAfterMs = 0, readonly retryAutomatically = true) {
    super(message);
    this.name = "OfficeSessionUnavailableError";
  }
}

export const REMOTE_PROXY_CONFIGURATION_MESSAGE = "Studio Serverのtrusted HTTPS proxyまたは転送ヘッダー設定を修正してから再接続してください。端末の再認証は不要です。";
export class OfficeHttpError extends Error {
  constructor(readonly status: number, readonly code?: string) {
    super(`Studio Server returned HTTP ${status}.`);
    this.name = "OfficeHttpError";
  }
}

export class OfficeRemoteConfigError extends Error {
  constructor(readonly status: number) {
    super("Remote host configuration is unavailable.");
    this.name = "OfficeRemoteConfigError";
  }
}

export type RemoteConfigFailureCode = "not_allowed" | "load_failed";

export type DeviceRevokeFailureCode = "not_found" | "forbidden" | "unavailable" | "unknown";

export class DeviceRevokeError extends Error {
  constructor(readonly status: number, readonly code: DeviceRevokeFailureCode) {
    super("Device revoke failed.");
    this.name = "DeviceRevokeError";
  }
}

export type OfficeClientSession = { csrfToken: string; authRevision: number; desktop: boolean };
export type OfficeWebSocketLease = { socket: WebSocket; authRevision: number };

// A cold Hermes snapshot can legitimately take several seconds while its
// profile/session indexes initialize. Keep the UI responsive, but do not
// drop into demo fallback during a normal first launch.
export const FETCH_TIMEOUT_MS = 30_000;
export const RECONNECT_DELAY_MS = 3_000;
export const RECONNECT_MAX_DELAY_MS = 8_000;
export const MAX_RECONNECT_ATTEMPTS = 5;
export const MAX_PREOPEN_WEBSOCKET_FAILURES = 3;
export const SNAPSHOT_RETRY_DELAY_MS = 1_000;
export const SNAPSHOT_RETRY_MAX_DELAY_MS = 10_000;
export const MAX_SNAPSHOT_RETRIES = 5;

export function shouldRetrySnapshotFailure(error: unknown): boolean {
  if (error instanceof OfficeDeviceAuthRequiredError || error instanceof OfficeRemoteConfigError) return false;
  if (error instanceof OfficeSessionUnavailableError) return error.retryAutomatically;
  if (error instanceof OfficeHttpError) return error.status === 408 || error.status === 429 || error.status >= 500;
  return error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError");
}

export function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Studio Serverへの接続がタイムアウトしました。";
  if (error instanceof Error) return error.message;
  return "Studio Serverへ接続できませんでした。";
}

export function isHealthResponse(value: unknown): value is HealthResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HealthResponse>;
  return candidate.ok === true && typeof candidate.protocolVersion === "number" && typeof candidate.runtime === "string";
}

export function isOfficeSnapshot(value: unknown): value is OfficeSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OfficeSnapshot>;
  return typeof candidate.generatedAt === "string"
    && typeof candidate.sequence === "number"
    && Array.isArray(candidate.profiles)
    && Array.isArray(candidate.sessions)
    && Array.isArray(candidate.boards)
    && isInventoryPagination(candidate.inventory?.profiles)
    && isInventoryPagination(candidate.inventory?.sessions)
    && typeof candidate.capabilities?.protocolVersion === "number"
    && typeof candidate.capabilities.runtime?.state === "string"
    && Array.isArray(candidate.capabilities.features)
    && candidate.capabilities.features.every((feature) => ["chat", "profiles", "skills", "memory", "kanban", "teams", "global-inheritance", "demo"].includes(feature))
    && isOfficeAccess(candidate.capabilities.access);
}

function isInventoryPagination(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const page = value as Record<string, unknown>;
  return typeof page.returned === "number" && page.returned >= 0 && page.returned <= 100 && Number.isSafeInteger(page.returned)
    && typeof page.available === "number" && page.available >= page.returned && Number.isSafeInteger(page.available)
    && typeof page.hasMore === "boolean" && typeof page.truncated === "boolean"
    && typeof page.partialFailures === "number" && page.partialFailures >= 0 && Number.isSafeInteger(page.partialFailures)
    && (page.total === undefined || (typeof page.total === "number" && page.total >= page.available && Number.isSafeInteger(page.total)))
    && (page.partialFailures === 0 || page.truncated === true)
    && (!page.hasMore || (typeof page.nextCursor === "string" && page.nextCursor.length <= 256));
}

function isOfficeAccess(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const access = value as Record<string, unknown>;
  return typeof access.deviceId === "string" && access.deviceId.length > 0 && access.deviceId.length <= 128
    && ["viewer", "operator", "manager", "owner"].includes(String(access.tier))
    && ["loopback", "tailnet", "public"].includes(String(access.exposure))
    && ["desktop-capability", "local-cookie", "device-cookie", "tailscale-identity", "oidc"].includes(String(access.authentication))
    && Array.isArray(access.allowedOperations)
    && access.allowedOperations.length <= 128
    && access.allowedOperations.every((operation) => typeof operation === "string" && Object.hasOwn(OPERATION_POLICIES, operation));
}

export function shouldRecoverOfficeWebSocket(event: Pick<CloseEvent, "code" | "reason">, opened: boolean, failedBeforeOpen = false): boolean {
  if (!opened && (event.code === 1006 || failedBeforeOpen)) return true;
  return event.code === 1008 && /(?:auth|credential|device|session)/i.test(event.reason);
}

export function parseEvent(data: unknown): OfficeEvent | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const value = JSON.parse(data) as Partial<OfficeEvent>;
    if (typeof value.topic !== "string" || typeof value.sequence !== "number") return undefined;
    return value as OfficeEvent;
  } catch {
    return undefined;
  }
}

export function toWebSocketUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/v1/events";
  url.search = "";
  return url.toString();
}
