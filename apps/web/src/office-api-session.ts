import type { RemoteConfigStatus } from "@hermes-studio/protocol";
import { classifyDeviceLoginFailure, isLocalOfficeClient, normalizeDeviceName } from "./auth-state";
import { createAuthenticatedOfficeWebSocket, desktopCapability, desktopCapabilityHeader, desktopOwnershipIsAuthenticated } from "./desktop-transport";
import {
  beginOfficeSynchronization as beginSynchronizationBarrier,
  rejectOfficeSynchronization as rejectSynchronizationBarrier,
  waitForOfficeSynchronization,
} from "./office-synchronization";
import {
  FETCH_TIMEOUT_MS,
  REMOTE_PROXY_CONFIGURATION_MESSAGE,
  DeviceRevokeError,
  OfficeDeviceAuthRequiredError,
  OfficeHttpError,
  OfficeRemoteConfigError,
  OfficeSessionUnavailableError,
  errorMessage,
  type DeviceLoginResult,
  type DeviceRevokeFailureCode,
  type OfficeApiRequestOptions,
  type OfficeClientSession,
  type OfficeWebSocketLease,
} from "./office-api-types";

export { subscribeOfficeSessionSynchronizations } from "./office-synchronization";

export function beginOfficeSynchronization(serverUrl: string, authRevision: number): void {
  beginSynchronizationBarrier(
    serverUrl,
    authRevision,
    new OfficeSessionUnavailableError("Studio recovery was superseded.", 0, false),
  );
}

export function rejectOfficeSynchronization(serverUrl: string, authRevision: number, message: string): void {
  rejectSynchronizationBarrier(serverUrl, authRevision, new OfficeSessionUnavailableError(message, 0, false));
}

const officeSessions = new Map<string, Promise<OfficeClientSession>>();
const officeSessionRefreshes = new Map<string, Promise<OfficeClientSession>>();
const officeSessionRecoveryPending = new Set<string>();
const officeAuthChangeObservers = new Set<(serverUrl: string) => void>();
export const officeSessionRecoveryObservers = new Set<(serverUrl: string, authRevision: number) => void>();
let authRequiredObserver: ((serverUrl: string) => void) | undefined;
let nextOfficeConnectionGeneration = 0;
export function allocateOfficeConnectionGeneration(): number {
  return ++nextOfficeConnectionGeneration;
}
let nextOfficeAuthRevision = 0;

export function setAuthRequiredObserver(observer: ((serverUrl: string) => void) | undefined): void {
  authRequiredObserver = observer;
}

export function officeServerUrl(): string {
  const configured = import.meta.env.VITE_OFFICE_SERVER_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  // Dev-only port override so the dev API (e.g. 4318) can run alongside the
  // desktop app's fixed 4317 server. Production/desktop builds leave it unset.
  const configuredPort = (import.meta.env.VITE_OFFICE_API_PORT as string | undefined)?.trim();
  const apiPort = configuredPort && /^\d{2,5}$/.test(configuredPort) ? configuredPort : "4317";
  if (location.protocol === "tauri:" || location.hostname === "tauri.localhost") {
    return `http://127.0.0.1:${apiPort}`;
  }
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    return `${location.protocol}//${location.hostname}:${apiPort}`;
  }
  return location.origin;
}

export function subscribeOfficeAuthChanges(observer: (serverUrl: string) => void): () => void {
  officeAuthChangeObservers.add(observer);
  return () => officeAuthChangeObservers.delete(observer);
}

/**
 * Opens a WebSocket only after this tab has a current Studio session. Remote
 * device credentials remain in the HttpOnly cookie; the returned revision is
 * an in-memory generation used solely to coalesce expiry recovery.
 */
export async function openOfficeWebSocket(url: string, serverUrl: string, signal?: AbortSignal): Promise<OfficeWebSocketLease> {
  assertOfficeWebSocketTarget(url, serverUrl);
  try {
    const session = await ensureOfficeSession(serverUrl);
    if (new URL(url).pathname === "/api/v1/chat") await waitForOfficeSynchronization(serverUrl, session.authRevision, signal);
    if (signal?.aborted) throw new DOMException("Chat recovery was cancelled.", "AbortError");
    return {
      socket: await createAuthenticatedOfficeWebSocket(url, session.desktop),
      authRevision: session.authRevision,
    };
  } catch (error) {
    if (error instanceof OfficeDeviceAuthRequiredError) publishAuthRequired(serverUrl);
    throw error;
  }
}

function assertOfficeWebSocketTarget(value: string, serverUrl: string): void {
  const socketUrl = new URL(value);
  const server = new URL(serverUrl);
  const expectedProtocol = server.protocol === "https:" ? "wss:" : "ws:";
  if (!["http:", "https:"].includes(server.protocol)
    || socketUrl.protocol !== expectedProtocol
    || socketUrl.host !== server.host
    || !["/api/v1/events", "/api/v1/chat"].includes(socketUrl.pathname)
    || socketUrl.username !== "" || socketUrl.password !== ""
    || socketUrl.search !== "" || socketUrl.hash !== "") {
    throw new Error("Studio WebSocket target is invalid.");
  }
}

/**
 * Recovers a rejected WebSocket lease through the same Origin-checked device
 * renewal endpoint used by HTTP requests. Event and chat transports share the
 * module-level single-flight refresh and therefore cannot stampede renewal.
 */
export async function recoverOfficeWebSocketAuthentication(serverUrl: string, rejectedAuthRevision: number): Promise<void> {
  try {
    await recoverOfficeSession(serverUrl, rejectedAuthRevision);
  } catch (error) {
    if (error instanceof OfficeDeviceAuthRequiredError) {
      publishAuthRequired(serverUrl);
      throw error;
    }
    if (error instanceof OfficeSessionUnavailableError) throw error;
    throw new OfficeSessionUnavailableError(errorMessage(error));
  }
}

export async function officeFetchJson<T>(path: string, options: OfficeApiRequestOptions = {}, serverUrl = officeServerUrl()): Promise<T> {
  const baseUrl = new URL(serverUrl);
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith("/api/v1/")) {
    throw new Error("Studio API path is invalid.");
  }
  try {
    const session = await ensureOfficeSession(serverUrl);
    return await requestOfficeJson<T>(url, options, session, serverUrl, true);
  } catch (error) {
    if (error instanceof OfficeDeviceAuthRequiredError) publishAuthRequired(serverUrl);
    throw error;
  }
}

/**
 * Starts a one-shot device login. The credential is serialized directly into
 * the request body and is never placed in module state, signals, URLs, or logs.
 */
export async function authenticateRemoteDevice(deviceNameInput: string, credential: string, serverUrl = officeServerUrl()): Promise<DeviceLoginResult> {
  const deviceName = normalizeDeviceName(deviceNameInput);
  if (!deviceName) return { ok: false, ...classifyDeviceLoginFailure(400, null) };
  try {
    const response = await fetch(`${serverUrl}/api/v1/auth/device`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ token: credential, deviceName })
    });
    if (!response.ok) return { ok: false, ...classifyDeviceLoginFailure(response.status, response.headers.get("Retry-After")) };
    const session = parseOfficeSession(await response.json() as unknown);
    if (!session) return { ok: false, ...classifyDeviceLoginFailure(500, null) };
    notifyOfficeAuthChange(serverUrl);
    officeSessionRecoveryPending.delete(serverUrl);
    officeSessions.set(serverUrl, Promise.resolve(issueOfficeClientSession(session.csrfToken)));
    return { ok: true };
  } catch {
    return { ok: false, ...classifyDeviceLoginFailure(0, null) };
  }
}

export async function fetchRemoteConfigStatus(serverUrl = officeServerUrl()): Promise<RemoteConfigStatus> {
  try {
    return await officeFetchJson<RemoteConfigStatus>("/api/v1/host/remote", {}, serverUrl);
  } catch (error) {
    if (error instanceof OfficeHttpError) throw new OfficeRemoteConfigError(error.status);
    throw new OfficeRemoteConfigError(0);
  }
}

export async function revokeRemoteDevice(deviceId: string, serverUrl = officeServerUrl()): Promise<void> {
  try {
    await officeFetchJson<{ ok: true }>(`/api/v1/devices/${encodeURIComponent(deviceId)}/revoke`, { method: "POST" }, serverUrl);
  } catch (error) {
    if (error instanceof OfficeHttpError) {
      let code: DeviceRevokeFailureCode = "unknown";
      if (error.status === 404) code = "not_found";
      else if (error.status === 401 || error.status === 403) code = "forbidden";
      else if (error.status === 0 || error.status >= 500) code = "unavailable";
      throw new DeviceRevokeError(error.status, code);
    }
    throw new DeviceRevokeError(0, "unavailable");
  }
}

export async function logoutRemoteDevice(serverUrl = officeServerUrl()): Promise<void> {
  notifyOfficeAuthChange(serverUrl);
  await officeFetchJson<{ ok: true }>("/api/v1/auth/logout", { method: "POST" }, serverUrl);
  officeSessions.delete(serverUrl);
  officeSessionRefreshes.delete(serverUrl);
  officeSessionRecoveryPending.delete(serverUrl);
}

async function requestOfficeJson<T>(url: URL, options: OfficeApiRequestOptions, session: OfficeClientSession, serverUrl: string, retryAuth: boolean): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TIMEOUT_MS);
  const method = options.method ?? "GET";
  try {
    const capability = session.desktop ? await desktopCapability() : undefined;
    if (session.desktop && capability === undefined) {
      throw new OfficeSessionUnavailableError("Hermes Studio lost its authenticated desktop server.", 0, false);
    }
    const response = await fetch(url, {
      method,
      credentials: "include",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...desktopCapabilityHeader(capability),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(method === "GET" || session.desktop ? {} : { "X-CSRF-Token": session.csrfToken })
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
    if (response.status === 401 && retryAuth) {
      const replacement = await recoverOfficeSession(serverUrl, session.authRevision);
      return await requestOfficeJson<T>(url, options, replacement, serverUrl, false);
    }
    if (!response.ok) throw new OfficeHttpError(response.status, await officeErrorCode(response));
    return await response.json() as T;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function officeErrorCode(response: Response): Promise<string | undefined> {
  try {
    const value = await response.json() as unknown;
    if (!value || typeof value !== "object") return undefined;
    const code = (value as { code?: unknown }).code;
    return typeof code === "string" && code.length <= 64 ? code : undefined;
  } catch {
    return undefined;
  }
}

export function ensureOfficeSession(serverUrl: string): Promise<OfficeClientSession> {
  const current = officeSessions.get(serverUrl);
  if (current) return current;
  const pending = bootstrapLocalSession(serverUrl).catch((error) => {
    if (officeSessions.get(serverUrl) === pending) officeSessions.delete(serverUrl);
    throw error;
  });
  officeSessions.set(serverUrl, pending);
  void pending.then((session) => {
    if (officeSessions.get(serverUrl) === pending && officeSessionRecoveryPending.delete(serverUrl)) {
      beginOfficeSynchronization(serverUrl, session.authRevision);
      notifyOfficeSessionRecovered(serverUrl, session.authRevision);
    }
  }, () => undefined);
  return pending;
}

function refreshOfficeSession(serverUrl: string): Promise<OfficeClientSession> {
  const current = officeSessionRefreshes.get(serverUrl);
  if (current) return current;
  notifyOfficeAuthChange(serverUrl);
  officeSessionRecoveryPending.add(serverUrl);
  officeSessions.delete(serverUrl);
  const pending = ensureOfficeSession(serverUrl);
  officeSessionRefreshes.set(serverUrl, pending);
  void pending.then(
    () => { if (officeSessionRefreshes.get(serverUrl) === pending) officeSessionRefreshes.delete(serverUrl); },
    () => { if (officeSessionRefreshes.get(serverUrl) === pending) officeSessionRefreshes.delete(serverUrl); }
  );
  return pending;
}

async function recoverOfficeSession(serverUrl: string, rejectedAuthRevision: number): Promise<OfficeClientSession> {
  const current = officeSessions.get(serverUrl);
  if (current) {
    const session = await current;
    if (session.authRevision !== rejectedAuthRevision) return session;
  }
  return await refreshOfficeSession(serverUrl);
}

async function bootstrapLocalSession(serverUrl: string): Promise<OfficeClientSession> {
  if (await desktopOwnershipIsAuthenticated()) return issueOfficeClientSession("desktop-capability", true);
  let response: Response;
  try {
    response = await boundedAuthFetch(`${serverUrl}/api/v1/auth/local`, {
      method: "POST", credentials: "include", headers: { Accept: "application/json" }
    });
  } catch (error) {
    throw new OfficeSessionUnavailableError(errorMessage(error));
  }
  if (response.status === 403 && !isLocalOfficeClient(location)) {
    let renewal: Response;
    try {
      renewal = await boundedAuthFetch(`${serverUrl}/api/v1/auth/device/renew`, {
        method: "POST", credentials: "include", headers: { Accept: "application/json" }
      });
    } catch (error) {
      throw new OfficeSessionUnavailableError(errorMessage(error));
    }
    if (renewal.ok) {
      let body: unknown;
      try { body = await renewal.json() as unknown; } catch { throw new OfficeSessionUnavailableError("Studio session renewal response is incompatible."); }
      const renewed = parseOfficeSession(body);
      if (renewed) return issueOfficeClientSession(renewed.csrfToken);
      throw new OfficeSessionUnavailableError("Studio session renewal response is incompatible.");
    }
    if (renewal.status === 401) throw new OfficeDeviceAuthRequiredError();
    if (renewal.status === 403) throw new OfficeSessionUnavailableError(REMOTE_PROXY_CONFIGURATION_MESSAGE, 0, false);
    throw new OfficeSessionUnavailableError(
      `Studio device session renewal failed with HTTP ${renewal.status}.`,
      renewal.status === 429 ? retryAfterMilliseconds(renewal.headers.get("Retry-After")) : 0,
    );
  }
  if (!response.ok) throw new OfficeSessionUnavailableError(`Studio local authentication failed with HTTP ${response.status}.`, response.status === 429 ? retryAfterMilliseconds(response.headers.get("Retry-After")) : 0);
  let body: unknown;
  try { body = await response.json() as unknown; } catch { throw new OfficeSessionUnavailableError("Studio local authentication response is incompatible."); }
  const session = parseOfficeSession(body);
  if (!session) throw new OfficeSessionUnavailableError("Studio local authentication response is incompatible.");
  return issueOfficeClientSession(session.csrfToken);
}

function issueOfficeClientSession(csrfToken: string, desktop = false): OfficeClientSession {
  return {
    csrfToken,
    authRevision: ++nextOfficeAuthRevision,
    desktop,
  };
}

function notifyOfficeAuthChange(serverUrl: string): void {
  for (const observer of officeAuthChangeObservers) {
    try { observer(serverUrl); } catch { /* observers cannot interrupt authentication */ }
  }
}

function notifyOfficeSessionRecovered(serverUrl: string, authRevision: number): void {
  for (const observer of officeSessionRecoveryObservers) {
    try { observer(serverUrl, authRevision); } catch { /* recovery observers cannot interrupt a renewed session */ }
  }
}

function publishAuthRequired(serverUrl: string): void {
  try { authRequiredObserver?.(serverUrl); } catch { /* UI observers cannot restart recovery */ }
}

async function boundedAuthFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function retryAfterMilliseconds(value: string | null): number {
  if (value === null) return 0;
  if (/^\d{1,5}$/.test(value)) return Math.min(3_600_000, Number(value) * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(3_600_000, Math.max(0, date - Date.now())) : 0;
}

function parseOfficeSession(value: unknown): { csrfToken: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const csrfToken = (value as { csrfToken?: unknown }).csrfToken;
  return typeof csrfToken === "string" && csrfToken.length >= 16 && csrfToken.length <= 512
    ? { csrfToken }
    : undefined;
}
