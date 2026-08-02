import type { ApprovalChoice, ChatSession } from "./domain";

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function approvalChoices(value: unknown, allowPermanent: boolean): ApprovalChoice[] {
  const allowed = new Set<ApprovalChoice>(["once", "session", "deny", ...(allowPermanent ? ["always" as const] : [])]);
  return stringArray(value).filter((choice): choice is ApprovalChoice => allowed.has(choice as ApprovalChoice));
}

export function gatewayMessageId(payload: Record<string, unknown>): string | undefined {
  return stringValue(payload.messageOccurrenceId)
    ?? stringValue(payload.message_occurrence_id)
    ?? stringValue(payload.messageId)
    ?? stringValue(payload.message_id);
}

export function nowTimestamp(): string {
  return new Date().toISOString();
}

export function nextChatTimelineSequence(
  session: Pick<ChatSession, "messages" | "operationEvidence">,
): number {
  let maximum = -1;
  for (const item of [...session.messages, ...(session.operationEvidence ?? [])]) {
    if (typeof item.timelineSequence === "number" && Number.isSafeInteger(item.timelineSequence)) {
      maximum = Math.max(maximum, item.timelineSequence);
    }
  }
  return Math.max(maximum + 1, session.messages.length + (session.operationEvidence?.length ?? 0));
}
