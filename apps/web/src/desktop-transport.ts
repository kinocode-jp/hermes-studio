// Compatibility WebSocket subprotocols / capability prefix. Changing these would
// desync desktop shell ↔ server mid-session; product brand is Hermes Studio.
const DESKTOP_PROTOCOL_PREFIX = "hermes-office.desktop.";
const OFFICE_PROTOCOL = "hermes-office.v1";

type TauriInternals = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

// The desktop shell returns a capability only when it started and owns the
// Studio Server child. A fresh IPC call revalidates the owned listener before
// each HTTP or WebSocket send that requires the capability; the root capability
// is never cached in this module or a Studio session. Invalid or unavailable
// desktop ownership is rejected rather than silently falling back to cookies.

export function isTauriAssetLocation(value: Pick<Location, "protocol" | "hostname">): boolean {
  return value.protocol === "tauri:" || value.hostname === "tauri.localhost";
}

/**
 * Whether HTTP/WebSocket auth should go through the Tauri desktop capability
 * bridge instead of browser-like local cookies.
 *
 * - Packaged asset origins (`tauri://` / `tauri.localhost`): always capability.
 * - Tauri dev shell on `http://localhost` (Vite) with an injected bridge: capability.
 * - Loopback Studio UI on `http://127.0.0.1` (browser or WebView attached to an
 *   existing server): **never** capability — Tauri rejects custom IPC from that
 *   remote origin unless a remote ACL is configured, and cookie auth is the
 *   intended browser-equivalent path.
 */
export function shouldUseDesktopCapability(
  value: Pick<Location, "protocol" | "hostname">,
  bridgeAvailable: boolean,
): boolean {
  if (isTauriAssetLocation(value)) return true;
  return bridgeAvailable && value.protocol === "http:" && value.hostname === "localhost";
}

export function desktopCapability(): Promise<string | undefined> {
  if (!shouldUseDesktopCapability(location, window.__TAURI_INTERNALS__ !== undefined)) return Promise.resolve(undefined);
  return loadDesktopCapability();
}

/**
 * True only when this shell currently owns a proven Studio Server child.
 * A bridge-backed origin must fail closed when it reports unowned; normal
 * loopback browser locations return false before invoking the bridge and keep
 * their cookie-auth path.
 */
export async function desktopOwnershipIsAuthenticated(): Promise<boolean> {
  if (!shouldUseDesktopCapability(location, window.__TAURI_INTERNALS__ !== undefined)) return false;
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== "function") throw new Error("Hermes Studio desktop bridge is unavailable.");
  const value = await invoke<boolean>("desktop_owned");
  if (typeof value !== "boolean") throw new Error("Hermes Studio desktop ownership response is invalid.");
  if (!value) throw new Error("Hermes Studio does not own an authenticated desktop server.");
  return true;
}

export async function createAuthenticatedOfficeWebSocket(url: string, desktopRequired = false): Promise<WebSocket> {
  const capability = await desktopCapability();
  if (desktopRequired && capability === undefined) {
    throw new Error("Hermes Studio lost its authenticated desktop server.");
  }
  return capability === undefined
    ? new WebSocket(url)
    : new WebSocket(url, [OFFICE_PROTOCOL, `${DESKTOP_PROTOCOL_PREFIX}${capability}`]);
}

export function desktopCapabilityHeader(capability: string | undefined): Record<string, string> {
  return capability === undefined ? {} : { "X-Hermes-Office-Desktop-Capability": capability };
}

/**
 * Deposit secret bytes for one-shot consume.
 * - Packaged desktop: Tauri native bridge (value never traverses ordinary browser fetch).
 * - Remote owner Web UI: authenticated HTTPS POST to /api/v1/secret-transfers
 *   (owner + CSRF; response is transferId only).
 */
export async function depositSecretTransfer(value: string): Promise<string> {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("Secret value is invalid.");
  }
  if (new TextEncoder().encode(value).byteLength > 8 * 1024) {
    throw new Error("Secret value is too large.");
  }
  if (typeof window === "undefined" || typeof location === "undefined") {
    throw new Error("Secret transfer requires the Hermes Studio desktop bridge or an authenticated browser.");
  }
  // Prefer desktop native path when the Tauri bridge is available.
  if (shouldUseDesktopCapability(location, window.__TAURI_INTERNALS__ !== undefined)) {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== "function") throw new Error("Hermes Studio desktop bridge is unavailable.");
    const transferId = await invoke<string>("deposit_secret_transfer", { value });
    return validateTransferId(transferId);
  }
  // Authenticated remote (or local-cookie) owner deposit over Studio HTTPS.
  const { officeFetchJson } = await import("./office-api");
  const response = await officeFetchJson<{ transferId?: unknown; expiresAt?: unknown }>(
    "/api/v1/secret-transfers",
    { method: "POST", body: { value } },
  );
  return validateTransferId(response.transferId);
}

function validateTransferId(transferId: unknown): string {
  if (typeof transferId !== "string" || transferId.length < 22 || transferId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(transferId)) {
    throw new Error("Secret transfer id is invalid.");
  }
  return transferId;
}

async function loadDesktopCapability(): Promise<string | undefined> {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== "function") throw new Error("Hermes Studio desktop bridge is unavailable.");
  const value = await invoke<string | null>("desktop_capability");
  if (value === null) return undefined;
  if (typeof value !== "string" || value.length < 32 || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Hermes Studio desktop capability is invalid.");
  }
  return value;
}
