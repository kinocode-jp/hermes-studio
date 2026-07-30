import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { HermesChatTransport, HermesHistoryDto, HermesHistoryMessageDto } from "./hermes-chat.js";

const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 50;
const MAX_HISTORY_OFFSET = 100_000_000;
const CURSOR_SECRET = randomBytes(32);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const DEFAULT_HISTORY_AGGREGATE_LIMITS: HistoryAggregateLimits = {
  maxPages: 40,
  maxMessages: 500,
  maxBytes: 8 * 1024 * 1024,
};

export type HistoryTruncationReason = "page_limit" | "message_limit" | "byte_limit" | "upstream_invalid_rows";
export type HistoryAggregateLimits = { maxPages: number; maxMessages: number; maxBytes: number };
type HistoryCursorState = {
  sessionId: string;
  start: number;
  end: number;
  offset: number;
  pages: number;
  messages: number;
  bytes: number;
};

export interface OfficeHistoryPage extends Omit<HermesHistoryDto, "pagination"> {
  pagination: {
    limit: number;
    offset: number;
    returned: number;
    hasMore: boolean;
    nextCursor?: string;
    direction: "older";
    pageLimitedByBytes: boolean;
    truncated: boolean;
    partial: boolean;
    truncationReason?: HistoryTruncationReason;
    cumulative: { pages: number; messages: number; bytes: number };
    limits: HistoryAggregateLimits;
    window: { start: number; end: number; omittedBefore: boolean };
    source: { returned: number; normalizedReturned: number; dropped: number };
  };
}

export class HistoryHttpInputError extends Error {}

/** Loads a signed, bounded tail window from newest to oldest. */
export async function fetchOfficeHistoryPage(
  chat: HermesChatTransport,
  requestUrl: URL,
  requestedSessionId: string,
  maxResponseBytes: number,
  limits: HistoryAggregateLimits = DEFAULT_HISTORY_AGGREGATE_LIMITS,
): Promise<OfficeHistoryPage> {
  validateQuery(requestUrl);
  validateLimits(limits);
  const profile = requestUrl.searchParams.get("profile") ?? "default";
  const limit = parseLimit(requestUrl.searchParams.get("limit"));
  const encodedCursor = requestUrl.searchParams.get("cursor");
  const cursor = encodedCursor === null
    ? await initialCursor(chat, requestedSessionId, profile, limits)
    : decodeCursor(encodedCursor, requestedSessionId, profile, limits);
  const fetchOffset = Math.max(cursor.start, cursor.offset - limit);
  const fetchLimit = cursor.offset - fetchOffset;
  const history = fetchLimit === 0
    ? emptyHistory(cursor.sessionId, profile, fetchOffset)
    : await chat.fetchHistory({ sessionId: cursor.sessionId, profile, limit: fetchLimit, offset: fetchOffset });
  if (history.sessionId !== cursor.sessionId || history.profile !== profile
    || history.pagination.offset !== fetchOffset || history.pagination.limit !== fetchLimit
    || !Number.isSafeInteger(history.pagination.returned) || history.pagination.returned !== fetchLimit
    || !Number.isSafeInteger(history.pagination.normalizedReturned) || history.pagination.normalizedReturned < 0
    || !Number.isSafeInteger(history.pagination.dropped) || history.pagination.dropped < 0
    || history.pagination.normalizedReturned !== history.messages.length
    || history.pagination.dropped !== history.pagination.returned - history.pagination.normalizedReturned) {
    throw new Error("Hermes history changed while its tail window was loading.");
  }
  return fitPage(history, limit, cursor, requestedSessionId, profile, maxResponseBytes, limits);
}

async function initialCursor(
  chat: HermesChatTransport,
  requestedSessionId: string,
  profile: string,
  limits: HistoryAggregateLimits,
): Promise<HistoryCursorState> {
  const summary = await chat.inspectHistory({ sessionId: requestedSessionId, profile });
  if (!ID_PATTERN.test(summary.sessionId) || !Number.isSafeInteger(summary.total) || summary.total < 0 || summary.total > MAX_HISTORY_OFFSET) {
    throw new Error("Hermes returned invalid history metadata.");
  }
  return {
    sessionId: summary.sessionId,
    start: Math.max(0, summary.total - limits.maxMessages),
    end: summary.total,
    offset: summary.total,
    pages: 0,
    messages: 0,
    bytes: 0,
  };
}

function fitPage(
  history: HermesHistoryDto,
  limit: number,
  cursor: HistoryCursorState,
  requestedSessionId: string,
  profile: string,
  maxResponseBytes: number,
  limits: HistoryAggregateLimits,
): OfficeHistoryPage {
  const messages: HermesHistoryMessageDto[] = [];
  let addedBytes = 0;
  let budgetReason: HistoryTruncationReason | undefined;
  const integrityReason: HistoryTruncationReason | undefined = history.pagination.dropped > 0 ? "upstream_invalid_rows" : undefined;
  for (let index = history.messages.length - 1; index >= 0; index -= 1) {
    const message = history.messages[index]!;
    if (cursor.messages + messages.length >= limits.maxMessages) { budgetReason = "message_limit"; break; }
    const messageBytes = Buffer.byteLength(JSON.stringify(message)) + 1;
    if (cursor.bytes + addedBytes + messageBytes > limits.maxBytes) { budgetReason = "byte_limit"; break; }
    const candidateMessages = [message, ...messages];
    const candidateBytes = addedBytes + messageBytes;
    const candidateOffset = message.index;
    const candidateHasMore = candidateOffset > cursor.start;
    const candidateReason = integrityReason ?? (candidateHasMore ? undefined : terminalOmissionReason(cursor));
    const candidate = makePage(history, candidateMessages, limit, cursor, candidateOffset, candidateBytes, candidateHasMore && integrityReason === undefined, false, candidateReason, requestedSessionId, profile, limits);
    if (Buffer.byteLength(JSON.stringify(candidate)) > maxResponseBytes) break;
    messages.unshift(message);
    addedBytes = candidateBytes;
  }

  const pageLimitedByBytes = messages.length < history.messages.length && budgetReason === undefined;
  const nextOffset = messages[0]?.index ?? cursor.offset;
  const moreAvailable = nextOffset > cursor.start;
  const cumulative = { pages: cursor.pages + 1, messages: cursor.messages + messages.length, bytes: cursor.bytes + addedBytes };
  if (moreAvailable && budgetReason === undefined) {
    if (cumulative.pages >= limits.maxPages) budgetReason = "page_limit";
    else if (cumulative.messages >= limits.maxMessages) budgetReason = "message_limit";
    else if (cumulative.bytes >= limits.maxBytes) budgetReason = "byte_limit";
  }
  if (!moreAvailable && budgetReason === undefined) budgetReason = terminalOmissionReason(cursor);
  const truncationReason = integrityReason ?? budgetReason;
  const truncated = truncationReason !== undefined;
  const hasMore = moreAvailable && !truncated;
  if (messages.length === 0 && history.messages.length > 0 && (cursor.offset > cursor.start || (truncated && cursor.messages === 0))) {
    throw new Error("A single history message exceeds the Office response or aggregate budget.");
  }
  const page = makePage(history, messages, limit, cursor, nextOffset, addedBytes, hasMore, pageLimitedByBytes, truncated ? truncationReason : undefined, requestedSessionId, profile, limits);
  if (Buffer.byteLength(JSON.stringify(page)) > maxResponseBytes) throw new Error("History metadata exceeds the Office response budget.");
  return page;
}

function makePage(
  history: HermesHistoryDto,
  messages: HermesHistoryMessageDto[],
  limit: number,
  cursor: HistoryCursorState,
  nextOffset: number,
  addedBytes: number,
  hasMore: boolean,
  pageLimitedByBytes: boolean,
  truncationReason: HistoryTruncationReason | undefined,
  requestedSessionId: string,
  profile: string,
  limits: HistoryAggregateLimits,
): OfficeHistoryPage {
  const cumulative = { pages: cursor.pages + 1, messages: cursor.messages + messages.length, bytes: cursor.bytes + addedBytes };
  const truncated = truncationReason !== undefined;
  return {
    sessionId: cursor.sessionId,
    profile: history.profile,
    messages,
    pagination: {
      limit,
      offset: history.pagination.offset,
      returned: messages.length,
      hasMore,
      ...(hasMore ? { nextCursor: encodeCursor({ ...cursor, offset: nextOffset, ...cumulative }, requestedSessionId, profile) } : {}),
      direction: "older",
      pageLimitedByBytes,
      truncated,
      partial: truncationReason === "upstream_invalid_rows" || (truncated && cumulative.messages > 0),
      ...(truncationReason === undefined ? {} : { truncationReason }),
      cumulative,
      limits,
      window: { start: cursor.start, end: cursor.end, omittedBefore: cursor.start > 0 },
      source: {
        returned: history.pagination.returned,
        normalizedReturned: history.pagination.normalizedReturned,
        dropped: history.pagination.dropped,
      },
    },
  };
}

function terminalOmissionReason(cursor: HistoryCursorState): HistoryTruncationReason | undefined {
  return cursor.start > 0 ? "message_limit" : undefined;
}

function emptyHistory(sessionId: string, profile: string, offset: number): HermesHistoryDto {
  return { sessionId, profile, messages: [], pagination: { limit: 0, offset, returned: 0, normalizedReturned: 0, dropped: 0 } };
}

function validateQuery(url: URL): void {
  const allowed = new Set(["profile", "limit", "cursor"]);
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    if (!allowed.has(key) || seen.has(key)) throw new HistoryHttpInputError("History query parameters are invalid.");
    seen.add(key);
  }
}

function parseLimit(value: string | null): number {
  if (value === null) return DEFAULT_PAGE_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_LIMIT) throw new HistoryHttpInputError(`History limit must be between 1 and ${MAX_PAGE_LIMIT}.`);
  return parsed;
}

function encodeCursor(state: HistoryCursorState, requestedSessionId: string, profile: string): string {
  const resolvedId = Buffer.from(state.sessionId, "utf8").toString("base64url");
  const payload = `v3:${resolvedId}:${state.start}:${state.end}:${state.offset}:${state.pages}:${state.messages}:${state.bytes}`;
  const signature = signCursor(payload, requestedSessionId, profile).toString("base64url");
  return Buffer.from(`${payload}:${signature}`, "utf8").toString("base64url");
}

function decodeCursor(value: string, requestedSessionId: string, profile: string, limits: HistoryAggregateLimits): HistoryCursorState {
  if (value.length > 512) throw new HistoryHttpInputError("History cursor is invalid.");
  const outer = decodeCanonicalBase64Url(value);
  if (outer === undefined) throw new HistoryHttpInputError("History cursor is invalid.");
  const decoded = outer.toString("utf8");
  const match = /^v3:([A-Za-z0-9_-]{2,171}):(0|[1-9][0-9]{0,8}):(0|[1-9][0-9]{0,8}):(0|[1-9][0-9]{0,8}):(0|[1-9][0-9]{0,2}):(0|[1-9][0-9]{0,5}):(0|[1-9][0-9]{0,8}):([A-Za-z0-9_-]{43})$/.exec(decoded);
  if (match === null) throw new HistoryHttpInputError("History cursor is invalid.");
  const resolvedId = decodeCanonicalBase64Url(match[1]!);
  const actual = decodeCanonicalBase64Url(match[8]!);
  if (resolvedId === undefined || actual === undefined) throw new HistoryHttpInputError("History cursor is invalid.");
  const payload = decoded.slice(0, decoded.lastIndexOf(":"));
  const expected = signCursor(payload, requestedSessionId, profile);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HistoryHttpInputError("History cursor is invalid.");
  const sessionId = resolvedId.toString("utf8");
  if (!Buffer.from(sessionId, "utf8").equals(resolvedId)) throw new HistoryHttpInputError("History cursor is invalid.");
  const state = { sessionId, start: Number(match[2]), end: Number(match[3]), offset: Number(match[4]), pages: Number(match[5]), messages: Number(match[6]), bytes: Number(match[7]) };
  if (!ID_PATTERN.test(sessionId) || !Object.values(state).slice(1).every(Number.isSafeInteger)
    || state.start > state.offset || state.offset > state.end || state.end > MAX_HISTORY_OFFSET || state.end - state.start > limits.maxMessages
    || state.pages >= limits.maxPages || state.messages >= limits.maxMessages || state.bytes >= limits.maxBytes) {
    throw new HistoryHttpInputError("History cursor is outside the allowed continuation range.");
  }
  return state;
}

function decodeCanonicalBase64Url(value: string): Buffer | undefined {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function signCursor(payload: string, requestedSessionId: string, profile: string): Buffer {
  return createHmac("sha256", CURSOR_SECRET).update(requestedSessionId).update("\0").update(profile).update("\0").update(payload).digest();
}

function validateLimits(limits: HistoryAggregateLimits): void {
  if (!Number.isSafeInteger(limits.maxPages) || limits.maxPages < 1 || limits.maxPages > 100
    || !Number.isSafeInteger(limits.maxMessages) || limits.maxMessages < 1 || limits.maxMessages > 5_000
    || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1_024 || limits.maxBytes > 32 * 1024 * 1024) {
    throw new Error("History aggregate limits are invalid.");
  }
}
