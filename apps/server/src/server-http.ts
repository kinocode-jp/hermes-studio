import { createHmac } from "node:crypto";
import type { EventEnvelope, EventTopic, Operation, ProtocolError } from "@hermes-studio/protocol";
import { WebSocket } from "ws";
import { STUDIO_SERVER_PROTOCOL_VERSION } from "./demo-state.js";
import { normalizeOrigin } from "./origin.js";
import type { StaticWebAsset } from "./static-web.js";

export const DESKTOP_PROOF_PATH = "/api/v1/health/desktop-proof";
// Compatibility proof domain for desktop readiness HMAC. Renaming would break
// already-running desktop shells mid-upgrade; keep the historical domain string.
export const DESKTOP_PROOF_DOMAIN = "hermes-office-desktop-readiness";
export const DESKTOP_PROOF_VERSION = "1";
export const DESKTOP_PROOF_NONCE_PATTERN = /^[0-9a-f]{64}$/;

export function kanbanOperation(method: string | undefined, pathname: string): Operation {
  if (method === "POST" && pathname.endsWith("/comments")) return "kanban.card.comment";
  if (method === "POST") return "kanban.card.create";
  if (method === "PATCH") return "kanban.card.update";
  return "state.read";
}

export function teamsOperation(method: string | undefined): Operation {
  if (method === "POST") return "team.create";
  if (method === "PATCH" || method === "PUT") return "team.update";
  if (method === "DELETE") return "team.delete";
  return "state.read";
}

export function settingsOperation(method: string | undefined, pathname: string): Operation {
  // Raw MEMORY.md / USER.md bodies are sensitive. Require memory.update for
  // both reads and writes (step-up/local for remote). Other memory GETs
  // (status / provider schema without secrets) stay on state.read.
  if (/\/memory\/files(?:\/|$)/.test(pathname)) return "memory.update";
  // Desktop-native secret deposit (no browser JSON secret body on consume).
  if (pathname === "/api/v1/secret-transfers") return "secret.write";
  if (pathname === "/api/v1/settings/chat-model-preferences") {
    return method === "GET" ? "state.read" : "chat-model-preferences.update";
  }
  // Privileged config + secrets: never state.read. Owner + local-only ops;
  // handlers also require desktop-capability (ordinary loopback browser fails closed).
  if (/\/profiles\/[^/]+\/privileged-config(?:\/|$)/.test(pathname)) {
    return method === "GET" ? "privileged-config.read" : "privileged-config.update";
  }
  if (/\/profiles\/[^/]+\/secrets(?:\/|$)/.test(pathname)) {
    return method === "GET" ? "privileged-config.read" : "secret.write";
  }
  if (method === "GET") return "state.read";
  if (pathname === "/api/v1/settings/global") return "global-settings.update";
  if (/\/skills\/[^/]+\/content$/.test(pathname)) return "skill.install";
  if (/\/skills\/[^/]+$/.test(pathname)) return "skill.enable";
  if (pathname.endsWith("/soul")) return "profile.update";
  if (pathname.includes("/memory/")) return "memory.update";
  // Safe schema-driven Hermes config leaves (fail-closed policy).
  if (/\/profiles\/[^/]+\/config(?:\/|$)/.test(pathname)) return "profile-config.update";
  return "profile.update";
}

export function writeAuthorizationError(
  response: import("node:http").ServerResponse,
  reason: "unauthenticated" | "csrf" | "tier" | "step_up_required" | "local_only",
  maxBytes: number,
): void {
  if (reason === "unauthenticated") {
    writeError(response, 401, "unauthenticated", "Studio session is required.", maxBytes);
    return;
  }
  const message = reason === "csrf" ? "A valid CSRF token is required."
    : reason === "step_up_required" ? "This operation requires verified local access because remote step-up is not available."
      : reason === "local_only" ? "This operation is local-only."
        : "The device permission tier does not allow this operation.";
  writeError(response, 403, "forbidden", message, maxBytes);
}

export function makeOriginAllowlist(origins: readonly string[]): ReadonlySet<string> {
  const normalized = origins.map(normalizeOrigin);
  if (
    normalized.length === 0 ||
    normalized.some(
      (origin) => origin === "" || origin === "*" || origin === "null",
    )
  ) {
    throw new Error("Origin allowlist must contain explicit, non-null origins.");
  }
  return new Set(normalized);
}

export function allowedCorsOrigin(origin: string, allowlist: ReadonlySet<string>): string | undefined {
  const normalized = normalizeOrigin(origin);
  if (normalized === "" || normalized === "null" || normalized === "*") return undefined;
  // Return the canonical allowlist entry itself rather than the request-derived
  // normalized string. This keeps the CORS response header value sourced from
  // the configured allowlist even when the strings are semantically equal.
  for (const allowed of allowlist) {
    if (allowed === normalized) return allowed;
  }
  return undefined;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export function createDesktopReadinessProof(capability: string, nonce: string): string {
  return createHmac("sha256", capability)
    .update(`${DESKTOP_PROOF_DOMAIN}\n${DESKTOP_PROOF_VERSION}\n${nonce}`, "utf8")
    .digest("hex");
}

export function isDesktopProofRequest(request: import("node:http").IncomingMessage, requestUrl: URL): boolean {
  if (
    request.method !== "GET"
    || requestHasBody(request)
    || request.headers.origin !== undefined
    || request.headers["x-hermes-office-desktop-capability"] !== undefined
  ) return false;
  if (!isLoopbackPeer(request.socket.remoteAddress) || !isTrustedProofHost(request.headers.host)) return false;
  if (
    request.headers.forwarded !== undefined
    || request.headers["x-forwarded-for"] !== undefined
    || request.headers["x-forwarded-host"] !== undefined
    || request.headers["x-forwarded-proto"] !== undefined
    || request.headers["x-real-ip"] !== undefined
  ) return false;
  const entries = [...requestUrl.searchParams.entries()];
  if (entries.length !== 3) return false;
  const nonce = requestUrl.searchParams.get("nonce");
  return requestUrl.searchParams.getAll("nonce").length === 1
    && requestUrl.searchParams.getAll("domain").length === 1
    && requestUrl.searchParams.getAll("version").length === 1
    && nonce !== null
    && DESKTOP_PROOF_NONCE_PATTERN.test(nonce)
    && requestUrl.searchParams.get("domain") === DESKTOP_PROOF_DOMAIN
    && requestUrl.searchParams.get("version") === DESKTOP_PROOF_VERSION
    && request.url === `${DESKTOP_PROOF_PATH}?nonce=${nonce}&domain=${DESKTOP_PROOF_DOMAIN}&version=${DESKTOP_PROOF_VERSION}`;
}

export function isLoopbackPeer(value: string | undefined): boolean {
  const normalized = value?.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

export function isTrustedProofHost(value: string | undefined): boolean {
  if (value === undefined || value.length > 255 || /[\s,@\\]/.test(value)) return false;
  const normalized = value.toLowerCase();
  const match = /^(?:(?:127\.0\.0\.1|localhost)|\[::1\]):(\d{1,5})$/.exec(normalized);
  if (match === null) return false;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

export function makeEvent<T>(
  sequence: number,
  topic: EventTopic,
  payload: T,
  aggregateId?: string,
): EventEnvelope<T> {
  return {
    protocolVersion: STUDIO_SERVER_PROTOCOL_VERSION,
    eventId: `event-${sequence}`,
    topic,
    sequence,
    occurredAt: new Date().toISOString(),
    ...(aggregateId === undefined ? {} : { aggregateId }),
    payload,
  };
}

export function sendBoundedEvent(
  websocket: WebSocket,
  event: EventEnvelope,
  maxBytes: number,
): boolean {
  if (websocket.readyState !== WebSocket.OPEN) return false;
  if (websocket.bufferedAmount > maxBytes * 4) {
    websocket.close(1013, "Client is too slow; resync required");
    return false;
  }

  if (hasForbiddenWireKey(event.payload)) return false;
  const body = serializeJson(event, maxBytes);
  if (body === undefined) return false;
  websocket.send(body);
  return true;
}

export function parseRequestUrl(value: string | undefined): URL | undefined {
  if (value === undefined || value.length > 2_048) return undefined;
  try {
    return new URL(value, "http://office.local");
  } catch {
    return undefined;
  }
}

export function requestHasBody(request: import("node:http").IncomingMessage): boolean {
  if (request.headers["transfer-encoding"] !== undefined) return true;
  const declaredLength = request.headers["content-length"];
  if (declaredLength === undefined) return false;
  const length = Number(declaredLength);
  return !Number.isSafeInteger(length) || length > 0;
}

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function writeStaticWebAsset(
  response: import("node:http").ServerResponse,
  method: "GET" | "HEAD",
  asset: StaticWebAsset,
): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; form-action 'self'",
  );
  response.writeHead(200, {
    "Content-Type": asset.contentType,
    "Content-Length": asset.body.byteLength.toString(),
    "Cache-Control": asset.cacheControl,
  });
  response.end(method === "HEAD" ? undefined : asset.body);
}

export function writeJson(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
  maxBytes: number,
  headers: Record<string, string> = {},
): void {
  const body = hasForbiddenWireKey(value) ? undefined : serializeJson(value, maxBytes);
  if (body === undefined) {
    const fallback = '{"code":"internal_error","message":"Response unavailable.","retryable":false}';
    response.writeHead(500, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(fallback).toString(),
    });
    response.end(fallback);
    return;
  }
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body).toString(),
    ...headers,
  });
  response.end(body);
}

export function writeError(
  response: import("node:http").ServerResponse,
  status: number,
  code: ProtocolError["code"],
  message: string,
  maxBytes: number,
  headers: Record<string, string> = {},
): void {
  const error: ProtocolError = { code, message, retryable: false };
  writeJson(response, status, error, maxBytes, headers);
}

export function applySecurityHeaders(response: import("node:http").ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("Cross-Origin-Resource-Policy", "same-site");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

export function serializeJson(value: unknown, maxBytes: number): string | undefined {
  try {
    const body = JSON.stringify(value);
    return body !== undefined && Buffer.byteLength(body) <= maxBytes ? body : undefined;
  } catch {
    return undefined;
  }
}

export function hasForbiddenWireKey(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/[-_]/g, "").toLowerCase();
    if (
      normalizedKey === "secret" ||
      normalizedKey === "secretvalue" ||
      normalizedKey === "password" ||
      normalizedKey === "authorization" ||
      normalizedKey === "token" ||
      normalizedKey === "accesstoken" ||
      normalizedKey === "refreshtoken" ||
      normalizedKey === "apikey" ||
      normalizedKey === "credential" ||
      normalizedKey === "credentials" ||
      normalizedKey === "environment"
    ) {
      return true;
    }
    if (hasForbiddenWireKey(child, seen)) return true;
  }
  return false;
}

export function rejectUpgrade(
  socket: import("node:stream").Duplex,
  status: number,
  reason: string,
): void {
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

export function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isSafeInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}
