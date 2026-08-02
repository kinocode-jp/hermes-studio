import type { ChatMessage } from "./domain";

// Hermes indexes occupy reserved anchors. Live messages and operation evidence
// use the space between anchors, so a later history reload cannot collide with
// locally captured chronological events.
const HISTORY_TIMELINE_STRIDE = 1_000_000;

export function normalizeHistoryPage(value: unknown, storedSessionId: string, pageNumber = 0): {
  messages: ChatMessage[];
  direction: "older";
  resolvedStoredSessionId?: string;
  hasMore: boolean;
  nextCursor?: string;
  truncated: boolean;
  partial: boolean;
  truncationReason?: string;
} {
  const record = asRecord(value);
  const entries = Array.isArray(value) ? value : Array.isArray(record?.messages) ? record.messages : [];
  const messages = entries.flatMap((entry, index) => {
    const message = asRecord(entry);
    if (!message) return [];
    const role = typeof message.role === "string" ? message.role : typeof message.from === "string" ? message.from : "assistant";
    const body = messageText(message);
    if (!body) return [];
    const historyIndex = typeof message.index === "number"
      && Number.isSafeInteger(message.index)
      && message.index >= 0
      && Number.isSafeInteger(message.index * HISTORY_TIMELINE_STRIDE)
      ? message.index
      : undefined;
    const timelineSequence = historyIndex === undefined ? undefined : historyIndex * HISTORY_TIMELINE_STRIDE;
    return [{
      id: typeof message.id === "string"
        ? message.id
        : historyIndex === undefined
          ? `history-${storedSessionId}-page-${pageNumber}-row-${index}`
          : `history-${storedSessionId}-${historyIndex}`,
      from: role === "user" ? "user" as const : role === "tool" || role === "system" ? "tool" as const : "agent" as const,
      ...(timelineSequence === undefined ? {} : { timelineSequence }),
      body,
      at: messageTime(message),
      status: "complete" as const,
    }];
  });
  const resolvedStoredSessionId = typeof record?.sessionId === "string"
    ? record.sessionId
    : typeof record?.session_id === "string" ? record.session_id : undefined;
  const pagination = asRecord(record?.pagination);
  const hasMore = pagination?.hasMore === true;
  const truncated = pagination?.truncated === true;
  const nextCursor = typeof pagination?.nextCursor === "string" && pagination.nextCursor.length <= 512
    ? pagination.nextCursor
    : undefined;
  if ((hasMore && nextCursor === undefined) || (hasMore && truncated) || pagination?.direction !== "older") {
    throw new Error("Studio Serverの履歴ページ情報に互換性がありません。");
  }
  const truncationReason = typeof pagination?.truncationReason === "string" ? pagination.truncationReason : undefined;
  return {
    messages,
    direction: "older",
    ...(resolvedStoredSessionId ? { resolvedStoredSessionId } : {}),
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
    truncated,
    partial: pagination?.partial === true,
    ...(truncationReason ? { truncationReason } : {}),
  };
}

function messageText(message: Record<string, unknown>): string {
  for (const key of ["content", "text", "body"]) {
    const value = message[key];
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const text = value.map((part) => {
        if (typeof part === "string") return part;
        const record = asRecord(part);
        return typeof record?.text === "string" ? record.text : "";
      }).join("");
      if (text) return text;
    }
  }
  return "";
}

function messageTime(message: Record<string, unknown>): string {
  if (typeof message.at === "string") {
    if (isLegacyClockTime(message.at)) return message.at;
    const explicit = new Date(message.at);
    return Number.isNaN(explicit.valueOf()) ? message.at : explicit.toISOString();
  }
  const value = message.createdAt ?? message.created_at ?? message.timestamp;
  if (value === undefined || value === null || value === "") return "";
  const date = typeof value === "number"
    ? new Date(value < 10_000_000_000 ? value * 1_000 : value)
    : typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  return Number.isNaN(date.valueOf()) ? "" : date.toISOString();
}

function isLegacyClockTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
