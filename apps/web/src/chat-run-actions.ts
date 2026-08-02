import type { Signal } from "@preact/signals";
import type { ChatMessage, ChatOperationEvidence, ChatSession } from "./domain";
import type { ChatSteerResult } from "./chat-api";
import { canSteerChatSession, isChatRunActive } from "./session-runtime";
import { nextChatTimelineSequence, nowTimestamp } from "./chat-store-utils";
import { officeMessage } from "./i18n";
import { isCommitUnconfirmedRpcError } from "./chat-rpc-results";
import { advanceSequence } from "./chat-event-ledger";

type SessionState = Signal<ChatSession[]>;

export const MAX_STEER_EVIDENCE_COUNT = 64;
// Larger than Hermes' maximum accepted steer body so one acknowledged
// operation is never immediately evicted solely because of its own payload.
export const MAX_STEER_EVIDENCE_BYTES = 256 * 1024;

export function boundedOperationEvidence(evidence: readonly ChatOperationEvidence[]): ChatOperationEvidence[] {
  const retained = evidence.slice(-MAX_STEER_EVIDENCE_COUNT);
  let bytes = retained.reduce((total, operation) => total + operationEvidenceBytes(operation), 0);
  while (retained.length > 0 && bytes > MAX_STEER_EVIDENCE_BYTES) {
    bytes -= operationEvidenceBytes(retained.shift()!);
  }
  return retained;
}

export function boundedSteerEvidence(messages: readonly ChatMessage[]): ChatMessage[] {
  const evidence = messages.filter((message) => message.kind === "steer").slice(-MAX_STEER_EVIDENCE_COUNT);
  let bytes = evidence.reduce((total, message) => total + steerEvidenceBytes(message), 0);
  while (evidence.length > 0 && bytes > MAX_STEER_EVIDENCE_BYTES) {
    bytes -= steerEvidenceBytes(evidence.shift()!);
  }
  return evidence;
}

export function invalidatePendingSteer(session: ChatSession): ChatSession {
  if (session.steerPending !== true && session.steerOperationId === undefined && session.steerDelivery === undefined) return session;
  return { ...session, steerPending: false, steerOperationId: undefined, steerDelivery: undefined };
}

export function invalidatePendingInterrupt(session: ChatSession): ChatSession {
  if (session.interruptPending !== true && session.interruptOperationId === undefined) return session;
  return { ...session, interruptPending: false, interruptOperationId: undefined };
}

export async function steerChatRun(
  state: SessionState,
  sendSteer: (sessionId: string, text: string) => Promise<ChatSteerResult>,
  recoverAsPrompt: (sessionId: string, operationId: string) => void,
  sessionId: string,
  body: string,
): Promise<boolean> {
  const trimmed = body.trim();
  const session = state.value.find((item) => item.id === sessionId);
  if (!trimmed || !session || !canSteerChatSession(session)) return false;
  const operationId = crypto.randomUUID();
  updateSession(state, sessionId, (item) => ({
    ...item,
    steerPending: true,
    steerOperationId: operationId,
    steerDelivery: {
      operationId,
      body: trimmed,
      liveSessionId: item.liveSessionId!,
      ...(item.chatRunId ? { runId: item.chatRunId } : {}),
      ...(item.chatRunSequence === undefined ? {} : { runSequence: item.chatRunSequence }),
      acknowledgement: "pending",
    },
    errorMessage: undefined,
  }));
  try {
    const result = await sendSteer(sessionId, trimmed);
    if (result.status !== "queued" && result.status !== "turn-ended") {
      updateSession(state, sessionId, (item) => item.steerOperationId === operationId ? {
        ...item,
        steerPending: false,
        steerOperationId: undefined,
        steerDelivery: undefined,
        errorMessage: result.status === "rejected"
          ? officeMessage("runtime.chat.steerRejected")
          : officeMessage("runtime.chat.steerInvalidAck"),
      } : item);
      return false;
    }
    let shouldRecover = false;
    updateSession(state, sessionId, (item) => {
      if (item.steerOperationId !== operationId || item.steerDelivery?.operationId !== operationId) return item;
      const delivery = {
        ...item.steerDelivery,
        acknowledgement: "queued" as const,
        ...(result.status === "turn-ended" ? { terminalObserved: true } : {}),
      };
      // turn-ended is generated only by Hub's pre-request terminal fence and
      // proves steer never reached Hermes. It is safe to recover regardless of
      // Browser event ordering. A real queued ACK is never auto-promoted after
      // terminal because consumption cannot be proven either way.
      shouldRecover = result.status === "turn-ended";
      const clearDelivery = result.status === "queued" && delivery.activityObserved === true;
      return {
        ...item,
        steerPending: false,
        steerOperationId: undefined,
        steerDelivery: clearDelivery ? undefined : delivery,
        operationEvidence: boundedOperationEvidence([
          ...(item.operationEvidence ?? []),
          {
            id: operationId,
            timelineSequence: nextChatTimelineSequence(item),
            kind: "steer",
            body: trimmed,
            at: nowTimestamp(),
            state: "accepted",
          },
        ]),
      };
    });
    const accepted = state.value.some((item) => item.id === sessionId && item.operationEvidence?.some(({ id }) => id === operationId));
    if (accepted && shouldRecover) recoverAsPrompt(sessionId, operationId);
    return accepted;
  } catch (reason) {
    const unconfirmed = isCommitUnconfirmedRpcError(reason);
    let recorded = false;
    updateSession(state, sessionId, (item) => {
      const evidence = unconfirmed ? boundedOperationEvidence([
        ...(item.operationEvidence ?? []),
        {
          id: operationId,
          timelineSequence: nextChatTimelineSequence(item),
          kind: "steer" as const,
          body: trimmed,
          at: nowTimestamp(),
          state: "unconfirmed" as const,
          message: reason.message,
        },
      ]) : undefined;
      if (item.steerOperationId !== operationId) {
        // A stop or terminal event may have cleared the pending marker while
        // the ACK was in flight. Preserve ambiguity evidence without restoring
        // any obsolete running/pending state.
        if (!evidence || item.operationEvidence?.some(({ id }) => id === operationId)) return item;
        recorded = true;
        return { ...item, operationEvidence: evidence };
      }
      recorded = true;
      return {
        ...item,
        steerPending: false,
        steerOperationId: undefined,
        steerDelivery: undefined,
        ...(unconfirmed ? {
          errorMessage: undefined,
          operationEvidence: evidence,
        } : { errorMessage: officeMessage("runtime.chat.steerSendFailed") }),
      };
    });
    // An unknown commit outcome must never invite an automatic/user replay.
    // Returning true lets the composer clear exactly as it does for accepted
    // guidance while the evidence ledger communicates the ambiguity.
    return unconfirmed && recorded;
  }
}

export async function interruptChatRun(
  state: SessionState,
  sendInterrupt: (sessionId: string) => Promise<void> | void,
  sessionId: string,
): Promise<boolean> {
  const session = state.value.find((item) => item.id === sessionId);
  if (!session || session.connectionState !== "ready" || !isChatRunActive(session) || session.interruptPending) return false;
  const operationId = crypto.randomUUID();
  updateSession(state, sessionId, (item) => ({
    ...item,
    // Stop is an explicit instruction not to continue this turn. It cancels a
    // queued steer-recovery fence before the interrupt RPC can race terminal.
    steerPending: false,
    steerOperationId: undefined,
    steerDelivery: undefined,
    interruptPending: true,
    interruptOperationId: operationId,
    errorMessage: undefined,
  }));
  try {
    await sendInterrupt(sessionId);
    let acknowledged = false;
    updateSession(state, sessionId, (item) => {
      if (item.interruptOperationId !== operationId) return item;
      acknowledged = true;
      return {
        ...item,
        status: "ready",
        streamingMessageId: undefined,
        streamingSourceMessageId: undefined,
        interimMessageIds: undefined,
        chatRunStarted: undefined,
        chatRunId: undefined,
        chatRunServerSequence: undefined,
        completedChatRunServerSequence: advanceSequence(
          item.completedChatRunServerSequence,
          item.chatRunServerSequence,
        ),
        chatRunSourceMessageId: undefined,
        chatRunSequence: undefined,
        toolMessageBindings: undefined,
        pendingInteraction: undefined,
        steerPending: false,
        steerOperationId: undefined,
        interruptPending: false,
        interruptOperationId: undefined,
        messages: item.messages.map((message) => message.status === "streaming" ? { ...message, status: "cancelled" } : message),
      };
    });
    return acknowledged;
  } catch {
    updateSession(state, sessionId, (item) => {
      if (item.interruptOperationId === operationId) return {
        ...item,
        interruptPending: false,
        interruptOperationId: undefined,
        errorMessage: officeMessage("runtime.chat.interruptFailed"),
      };
      // A commit-unknown interrupt enters the history barrier first, which
      // invalidates pending operation markers and the live id synchronously.
      // Preserve the user-visible failure only on that disconnected target;
      // never attach a delayed error to a replacement live generation.
      if (item.interruptOperationId === undefined
        && item.connectionState === "disconnected"
        && item.liveSessionId === undefined) {
        return { ...item, errorMessage: officeMessage("runtime.chat.interruptFailed") };
      }
      return item;
    });
    return false;
  }
}

function updateSession(state: SessionState, sessionId: string, update: (session: ChatSession) => ChatSession): void {
  state.value = state.value.map((session) => session.id === sessionId ? update(session) : session);
}

function steerEvidenceBytes(message: ChatMessage): number {
  return new TextEncoder().encode(`${message.id}\0${message.timelineSequence ?? ""}\0${message.body}\0${message.at}`).byteLength;
}

function operationEvidenceBytes(operation: ChatOperationEvidence): number {
  return new TextEncoder().encode(`${operation.id}\0${operation.timelineSequence ?? ""}\0${operation.kind}\0${operation.state}\0${operation.body}\0${operation.at}\0${operation.message ?? ""}`).byteLength;
}
