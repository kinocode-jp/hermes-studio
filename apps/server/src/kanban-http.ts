import type { IncomingMessage } from "node:http";
import type { ProtocolError } from "@hermes-studio/protocol";
import {
  HermesKanbanAdapter,
  HermesKanbanCommitUnconfirmedError,
  HermesKanbanUpstreamError,
  KanbanValidationError,
  type CreateKanbanCardInput,
  type UpdateKanbanCardInput,
} from "./hermes-kanban.js";

const OFFICE_KANBAN_PATH = "/api/v1/kanban";
const MAX_KANBAN_BODY_BYTES = 64 * 1024;

export interface KanbanHttpResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  changedCardId?: string;
  changedOperation?: "card.created" | "card.updated" | "comment.created";
}

export function isKanbanHttpPath(pathname: string): boolean {
  return pathname === OFFICE_KANBAN_PATH || pathname.startsWith(`${OFFICE_KANBAN_PATH}/`);
}

export function isKanbanMutation(method: string | undefined): boolean {
  return method === "POST" || method === "PATCH";
}

export async function routeKanbanHttp(
  request: IncomingMessage,
  requestUrl: URL,
  adapter: HermesKanbanAdapter,
  maxJsonBytes: number,
): Promise<KanbanHttpResult> {
  try {
    validateQuery(requestUrl, request.method === "GET" && requestUrl.pathname === OFFICE_KANBAN_PATH
      ? ["board", "includeArchived"]
      : ["board"]);
    const board = optionalQuery(requestUrl, "board");

    if (request.method === "GET" && requestUrl.pathname === OFFICE_KANBAN_PATH) {
      const includeArchived = optionalBooleanQuery(requestUrl, "includeArchived");
      return {
        status: 200,
        body: await adapter.getBoard({
          ...(board === undefined ? {} : { board }),
          ...(includeArchived === undefined ? {} : { includeArchived }),
        }),
      };
    }

    const detailMatch = /^\/api\/v1\/kanban\/cards\/([^/]+)$/.exec(requestUrl.pathname);
    if (request.method === "GET" && detailMatch !== null) {
      return {
        status: 200,
        body: await adapter.getCard(decodePathSegment(detailMatch[1]!), boardOptions(board)),
      };
    }

    if (request.method === "POST" && requestUrl.pathname === `${OFFICE_KANBAN_PATH}/cards`) {
      const raw = await readJsonObject(request, maxJsonBytes);
      assertKeys(raw, ["title", "body", "assignee", "priority", "triage"]);
      if (!("title" in raw)) throw badRequest("title is required.");
      const input: CreateKanbanCardInput = {
        title: raw.title as string,
        ...(raw.body === undefined ? {} : { body: raw.body as string | null }),
        ...(raw.assignee === undefined ? {} : { assignee: raw.assignee as string | null }),
        ...(raw.priority === undefined ? {} : { priority: raw.priority as number }),
        ...(raw.triage === undefined ? {} : { triage: raw.triage as boolean }),
      };
      const card = await adapter.createCard(input, boardOptions(board));
      return { status: 201, body: card, changedCardId: card.id, changedOperation: "card.created" };
    }

    const updateMatch = /^\/api\/v1\/kanban\/cards\/([^/]+)$/.exec(requestUrl.pathname);
    if (request.method === "PATCH" && updateMatch !== null) {
      const raw = await readJsonObject(request, maxJsonBytes);
      assertKeys(raw, ["status", "assignee"]);
      const input: UpdateKanbanCardInput = {
        ...(raw.status === undefined ? {} : { status: raw.status as NonNullable<UpdateKanbanCardInput["status"]> }),
        ...(raw.assignee === undefined ? {} : { assignee: raw.assignee as string | null }),
      };
      const card = await adapter.updateCard(
        decodePathSegment(updateMatch[1]!),
        input,
        boardOptions(board),
      );
      return { status: 200, body: card, changedCardId: card.id, changedOperation: "card.updated" };
    }

    const statusMatch = /^\/api\/v1\/kanban\/cards\/([^/]+)\/status$/.exec(requestUrl.pathname);
    if (request.method === "PATCH" && statusMatch !== null) {
      const raw = await readJsonObject(request, maxJsonBytes);
      assertKeys(raw, ["status"]);
      if (!("status" in raw)) throw badRequest("status is required.");
      const card = await adapter.setStatus(
        decodePathSegment(statusMatch[1]!),
        raw.status as NonNullable<UpdateKanbanCardInput["status"]>,
        boardOptions(board),
      );
      return { status: 200, body: card, changedCardId: card.id, changedOperation: "card.updated" };
    }

    const assigneeMatch = /^\/api\/v1\/kanban\/cards\/([^/]+)\/assignee$/.exec(requestUrl.pathname);
    if (request.method === "PATCH" && assigneeMatch !== null) {
      const raw = await readJsonObject(request, maxJsonBytes);
      assertKeys(raw, ["assignee"]);
      if (!("assignee" in raw) || (raw.assignee !== null && typeof raw.assignee !== "string")) {
        throw badRequest("assignee must be a profile identifier or null.");
      }
      const card = await adapter.setAssignee(
        decodePathSegment(assigneeMatch[1]!),
        raw.assignee,
        boardOptions(board),
      );
      return { status: 200, body: card, changedCardId: card.id, changedOperation: "card.updated" };
    }

    const commentMatch = /^\/api\/v1\/kanban\/cards\/([^/]+)\/comments$/.exec(requestUrl.pathname);
    if (request.method === "POST" && commentMatch !== null) {
      const raw = await readJsonObject(request, maxJsonBytes);
      assertKeys(raw, ["body"]);
      if (!("body" in raw)) throw badRequest("body is required.");
      const cardId = decodePathSegment(commentMatch[1]!);
      await adapter.addComment(cardId, raw.body as string, boardOptions(board));
      return {
        status: 201,
        body: { ok: true, cardId },
        changedCardId: cardId,
        changedOperation: "comment.created",
      };
    }

    const allowed = allowedMethods(requestUrl.pathname);
    if (allowed !== undefined) {
      return {
        status: 405,
        body: protocolError("bad_request", "Method not allowed."),
        headers: { Allow: allowed },
      };
    }
    return { status: 404, body: protocolError("not_found", "Kanban route not found.") };
  } catch (error) {
    return errorResult(error);
  }
}

function errorResult(error: unknown): KanbanHttpResult {
  if (error instanceof BodyTooLargeError) {
    return { status: 413, body: protocolError("bad_request", "Kanban request body is too large.") };
  }
  if (error instanceof KanbanValidationError || error instanceof RequestBodyError) {
    return { status: 400, body: protocolError("bad_request", error.message) };
  }
  if (error instanceof HermesKanbanCommitUnconfirmedError) {
    return {
      status: 409,
      body: {
        code: "commit_unconfirmed",
        message: "Hermes may have committed this Kanban change; refresh before retrying.",
        retryable: false,
      },
    };
  }
  if (error instanceof HermesKanbanUpstreamError) {
    if (error.status === 404) return { status: 404, body: protocolError("not_found", "Kanban card was not found.") };
    if (error.status === 409) return { status: 409, body: protocolError("conflict", "Kanban update conflicts with current state.") };
    return { status: 502, body: protocolError("runtime_unavailable", "Hermes Kanban is unavailable.", true) };
  }
  return { status: 502, body: protocolError("runtime_unavailable", "Hermes Kanban is unavailable.", true) };
}

async function readJsonObject(request: IncomingMessage, maxJsonBytes: number): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw badRequest("Content-Type must be application/json.");
  const limit = Math.min(MAX_KANBAN_BODY_BYTES, maxJsonBytes);
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0) throw badRequest("Content-Length is invalid.");
    if (size > limit) { request.resume(); throw new BodyTooLargeError(); }
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > limit) { request.resume(); throw new BodyTooLargeError(); }
    chunks.push(buffer);
  }
  if (size === 0) throw badRequest("A JSON request body is required.");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw badRequest(`Unknown field: ${unknown}.`);
}

function validateQuery(url: URL, allowed: readonly string[]): void {
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    if (!allowed.includes(key) || seen.has(key)) throw badRequest("Kanban query parameters are invalid.");
    seen.add(key);
  }
}

function optionalQuery(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  return value === null ? undefined : value;
}

function optionalBooleanQuery(url: URL, key: string): boolean | undefined {
  const value = optionalQuery(url, key);
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw badRequest(`${key} must be true or false.`);
}

function boardOptions(board: string | undefined): { board?: string } {
  return board === undefined ? {} : { board };
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw badRequest("Kanban card identifier is malformed.");
  }
}

function allowedMethods(pathname: string): string | undefined {
  if (pathname === OFFICE_KANBAN_PATH) return "GET";
  if (pathname === `${OFFICE_KANBAN_PATH}/cards`) return "POST";
  if (/^\/api\/v1\/kanban\/cards\/[^/]+$/.test(pathname)) return "GET, PATCH";
  if (/^\/api\/v1\/kanban\/cards\/[^/]+\/(?:status|assignee)$/.test(pathname)) return "PATCH";
  if (/^\/api\/v1\/kanban\/cards\/[^/]+\/comments$/.test(pathname)) return "POST";
  return undefined;
}

function protocolError(code: ProtocolError["code"], message: string, retryable = false): ProtocolError {
  return { code, message, retryable };
}

function badRequest(message: string): RequestBodyError {
  return new RequestBodyError(message);
}

class RequestBodyError extends Error {}
class BodyTooLargeError extends Error {}
