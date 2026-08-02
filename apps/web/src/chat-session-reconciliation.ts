import type { ChatSession } from "./domain";
import { invalidatePendingInterrupt, invalidatePendingSteer } from "./chat-run-actions";
import type { RuntimeMessage } from "./i18n";
import { advanceSequence } from "./chat-event-ledger";
import { hasPendingPromptOperation } from "./session-runtime";

export type ChatSessionReadyRuntime = {
  running?: boolean;
  status?: string;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
};

export function reconcileChatSessionConnecting(session: ChatSession): ChatSession {
  const pendingFirstPrompt = hasPendingPromptOperation(session);
  return {
    ...terminateChatRun(session, "cancelled"),
    ...(pendingFirstPrompt ? { status: "streaming" as const } : {}),
    connectionState: "connecting",
    liveSessionId: undefined,
    readOnly: true,
    errorMessage: undefined
  };
}

export function reconcileChatSessionQueued(session: ChatSession): ChatSession {
  return {
    ...session,
    connectionState: "queued",
    liveSessionId: undefined,
    readOnly: false,
    errorMessage: undefined,
  };
}

export function reconcileChatSessionReady(
  session: ChatSession,
  liveSessionId: string,
  storedSessionId?: string,
  runtime?: ChatSessionReadyRuntime
): ChatSession {
  const runtimeStatus = sessionStatusFromRuntime(runtime);
  // session.ready for a newly-created draft arrives before its queued first
  // prompt is submitted. It must not reopen the composer or make the lease
  // look idle during that hand-off.
  const effectiveStatus = hasPendingPromptOperation(session) ? "streaming" : runtimeStatus;
  const targetChanged = session.liveSessionId !== liveSessionId;
  const reconciled = runtimeStatus === "ready" || targetChanged ? terminateChatRun(session, "cancelled") : session;
  return {
    ...reconciled,
    ...(storedSessionId ? { storedSessionId } : {}),
    ...(effectiveStatus ? { status: effectiveStatus } : {}),
    ...(runtime?.model ? { model: runtime.model } : {}),
    ...(runtime?.provider ? { provider: runtime.provider } : {}),
    ...(runtime?.reasoningEffort ? { reasoningEffort: runtime.reasoningEffort } : {}),
    liveSessionId,
    connectionState: "ready",
    remoteKind: storedSessionId ? "stored" : session.remoteKind,
    readOnly: false,
    errorMessage: session.historyState === "error" ? session.errorMessage : undefined
  };
}

export function reconcileChatSessionDisconnected(session: ChatSession): ChatSession {
  return {
    ...terminateChatRun(session, "cancelled"),
    liveSessionId: undefined,
    connectionState: "disconnected",
    readOnly: true
  };
}

export function reconcileChatSessionError(session: ChatSession, message: RuntimeMessage): ChatSession {
  return {
    ...terminateChatRun(session, "failed"),
    connectionState: "error",
    readOnly: true,
    errorMessage: message
  };
}

function terminateChatRun(session: ChatSession, terminalStatus: "cancelled" | "failed"): ChatSession {
  return {
    ...invalidatePendingInterrupt(invalidatePendingSteer(session)),
    status: "ready",
    streamingMessageId: undefined,
    streamingSourceMessageId: undefined,
    interimMessageIds: undefined,
    chatRunStarted: undefined,
    chatRunId: undefined,
    chatRunServerSequence: undefined,
    completedChatRunServerSequence: advanceSequence(
      session.completedChatRunServerSequence,
      session.chatRunServerSequence,
    ),
    chatRunSourceMessageId: undefined,
    chatRunSequence: undefined,
    toolMessageBindings: undefined,
    pendingInteraction: undefined,
    messages: session.messages.map((message) => message.status === "streaming" ? { ...message, status: terminalStatus } : message)
  };
}

function sessionStatusFromRuntime(runtime: ChatSessionReadyRuntime | undefined): ChatSession["status"] | undefined {
  if (runtime?.running === true) return "streaming";
  if (runtime?.running === false) return "ready";
  if (typeof runtime?.status !== "string") return undefined;
  const status = runtime.status.trim().toLowerCase().replaceAll("_", "-");
  if (status === "thinking" || status === "using-tool" || status === "streaming" || status === "running") return "streaming";
  if (status === "waiting" || status === "waiting-for-user") return "waiting";
  if (status === "ready" || status === "idle") return "ready";
  return undefined;
}
