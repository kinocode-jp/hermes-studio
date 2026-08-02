import type { IncomingMessage, ServerResponse } from "node:http";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import { writeError, writeJson } from "./server-http.js";

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SESSION_PATH = /^\/api\/v1\/sessions\/([^/]+)$/;
export const SESSION_BULK_DELETE_PATH = "/api/v1/sessions/bulk-delete";
const MAX_DELETE_BATCH = 500;

export function isSessionResourcePath(pathname: string): boolean {
  return pathname === SESSION_BULK_DELETE_PATH || SESSION_PATH.test(pathname);
}

export async function handleSessionDelete(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  runtime: HermesRuntimeSource | undefined,
  maxJsonBytes: number,
  maxResponseJsonBytes: number,
): Promise<void> {
  if (requestUrl.pathname === SESSION_BULK_DELETE_PATH) {
    await handleSessionBulkDelete(request, response, runtime, maxJsonBytes, maxResponseJsonBytes);
    return;
  }
  const match = SESSION_PATH.exec(requestUrl.pathname);
  if (match === null) {
    writeError(response, 404, "not_found", "Route not found.", maxJsonBytes);
    return;
  }

  let sessionId: string;
  try {
    sessionId = decodeURIComponent(match[1]!);
  } catch {
    writeError(response, 400, "bad_request", "Session identifier is malformed.", maxJsonBytes);
    return;
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    writeError(response, 400, "bad_request", "Session identifier is invalid.", maxJsonBytes);
    return;
  }

  const profile = (requestUrl.searchParams.get("profile") ?? "default").trim();
  if (!PROFILE_PATTERN.test(profile)) {
    writeError(response, 400, "bad_request", "profile is invalid.", maxJsonBytes);
    return;
  }

  if (runtime?.deleteSession === undefined) {
    writeError(response, 503, "runtime_unavailable", "Hermes runtime is unavailable.", maxJsonBytes);
    return;
  }

  try {
    await runtime.deleteSession(profile, sessionId);
    writeJson(response, 200, { ok: true, profile, sessionId }, maxResponseJsonBytes, {
      "Cache-Control": "no-store",
    });
  } catch {
    // All client-controlled identifiers were validated above. Never classify
    // or expose arbitrary runtime diagnostics by matching Error.message text.
    writeError(response, 502, "runtime_unavailable", "Hermes rejected the session delete request.", maxJsonBytes);
  }
}

async function handleSessionBulkDelete(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: HermesRuntimeSource | undefined,
  maxJsonBytes: number,
  maxResponseJsonBytes: number,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(request, maxJsonBytes);
  } catch (error) {
    if (!request.readableEnded) request.resume();
    writeError(response, 400, "bad_request", error instanceof Error ? error.message : "Request body is invalid.", maxJsonBytes);
    return;
  }
  if (Object.keys(body).some((key) => key !== "profile" && key !== "sessionIds")) {
    writeError(response, 400, "bad_request", "Session delete fields are invalid.", maxJsonBytes);
    return;
  }
  const profile = typeof body.profile === "string" ? body.profile.trim() : "";
  const rawIds = body.sessionIds;
  if (!PROFILE_PATTERN.test(profile) || !Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > MAX_DELETE_BATCH
    || rawIds.some((id) => typeof id !== "string" || !SESSION_ID_PATTERN.test(id))) {
    writeError(response, 400, "bad_request", "Session delete batch is invalid.", maxJsonBytes);
    return;
  }
  const sessionIds = [...new Set(rawIds as string[])];
  if (runtime?.deleteSessions === undefined) {
    writeError(response, 503, "runtime_unavailable", "Hermes runtime does not support bulk session deletion.", maxJsonBytes);
    return;
  }
  try {
    await runtime.deleteSessions(profile, sessionIds);
    writeJson(response, 200, { ok: true, profile, deleted: sessionIds.length }, maxResponseJsonBytes, {
      "Cache-Control": "no-store",
    });
  } catch {
    writeError(response, 502, "runtime_unavailable", "Hermes rejected the session delete request.", maxJsonBytes);
  }
}

async function readJsonObject(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("Content-Type must be application/json.");
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Content-Length is invalid.");
    if (size > limit) { request.resume(); throw new Error("Request body is too large."); }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > limit) { request.resume(); throw new Error("Request body is too large."); }
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
