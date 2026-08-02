import type { ChatSession } from "./domain";

export function mergeServerSessionStatus(previous: ChatSession | undefined, activity: string): ChatSession["status"] {
  const incoming = serverSessionStatus(activity);
  if (!previous) return incoming;
  if (previous.pendingInteraction || previous.status === "waiting") return "waiting";
  if (previous.connectionState === "error") return previous.status;
  if (incoming !== "ready") return incoming;
  return isChatRunActive(previous) ? "streaming" : "ready";
}

export function canSubmitChatPrompt(session: ChatSession): boolean {
  const connected = session.remoteKind === "demo"
    || session.connectionState === "ready"
    || session.connectionState === "queued";
  return connected && session.status === "ready" && session.steerPending !== true
    && session.interruptPending !== true && session.pendingModelChange?.applying !== true
    && session.slashPending !== true
    && !isChatRunActive(session);
}

export function composerBlockedReason(session: ChatSession): "pending-interaction" | "connecting" | "disconnected" | "running" | "stopping" | undefined {
  if (session.pendingInteraction) return "pending-interaction";
  if (session.interruptPending) return "stopping";
  if (session.slashPending) return "running";
  if (isChatRunActive(session) && !canSteerChatSession(session)) return "running";
  if (session.remoteKind === "demo") return undefined;
  if (session.connectionState === "connecting") return "connecting";
  if (session.connectionState === "queued") return undefined;
  if (session.connectionState !== "ready") return "disconnected";
  return undefined;
}

export function canSteerChatSession(session: ChatSession): boolean {
  return session.remoteKind !== "demo"
    && session.connectionState === "ready"
    && typeof session.liveSessionId === "string" && session.liveSessionId.length > 0
    && isChatRunActive(session)
    && session.pendingInteraction === undefined
    && session.steerPending !== true
    && session.interruptPending !== true;
}

export function isChatRunActive(session: ChatSession): boolean {
  return session.status === "streaming" || session.status === "waiting"
    || session.pendingInteraction !== undefined
    || session.streamingMessageId !== undefined
    || hasPendingPromptOperation(session)
    || session.messages.some((message) => message.status === "streaming");
}

/** A prompt RPC that has not reached a commit outcome still owns this turn. */
export function hasPendingPromptOperation(session: ChatSession): boolean {
  return session.operationEvidence?.some((operation) => (
    operation.kind === "prompt" && operation.state === "pending"
  )) === true;
}

/**
 * Hidden panes retain their Hermes lease while any conversation/control-plane
 * operation can still settle into visible state.
 */
export function isChatSessionLeaseProtected(session: ChatSession): boolean {
  return isChatRunActive(session)
    || session.steerPending === true
    || session.interruptPending === true
    || session.slashPending === true
    || session.pendingModelChange?.applying === true;
}

export function mergeGatewayStatusUpdate(session: ChatSession, payload: Record<string, unknown>): ChatSession {
  const statusField = normalizedString(payload.status);
  if (statusField) return mergeKnownGatewayStatus(session, statusField);

  const kind = normalizedString(payload.kind);
  if (!kind) return session;
  if (kind === "status") {
    const text = normalizedString(payload.text) ?? normalizedString(payload.message);
    return text ? mergeKnownGatewayStatus(session, text) : session;
  }
  return mergeKnownGatewayStatus(session, kind);
}

function mergeKnownGatewayStatus(session: ChatSession, value: string): ChatSession {
  if (session.pendingInteraction) return session;
  if (value === "thinking" || value === "using-tool" || value === "streaming" || value === "running") {
    return session.status === "streaming" ? session : { ...session, status: "streaming" };
  }
  if (value === "waiting" || value === "waiting-for-user") {
    return session.status === "waiting" ? session : { ...session, status: "waiting" };
  }
  if (value === "ready" || value === "idle") {
    return isChatRunActive(session) || session.status === "ready" ? session : { ...session, status: "ready" };
  }
  return session;
}

function normalizedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  return normalized || undefined;
}

function serverSessionStatus(activity: string): ChatSession["status"] {
  if (activity === "thinking" || activity === "using-tool") return "streaming";
  if (activity === "waiting-for-user") return "waiting";
  return "ready";
}
