import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import type { Operation } from "@hermes-studio/protocol";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import { HermesChatTransportError, HERMES_CHAT_METHODS, type HermesChatEvent, type HermesChatMethod, type HermesChatResult } from "./hermes-chat.js";
import type { OfficeAuth, OfficeAuthSession } from "./office-auth.js";
import { ChatSessionCoordinator, type ChatSessionClaim } from "./chat-session-coordinator.js";
import { ChatCommitUnconfirmedError, ChatUpstreamHub } from "./chat-upstream-hub.js";
import type { UsageTelemetryStore } from "./usage-telemetry.js";
import type { LiveModelsCatalog } from "./hermes-models.js";
import { composeSessionCreateSystemSeed, studioDefaultProfileOrchestrationInstruction, studioFollowUpSessionInstruction, studioProfileAgentBehaviorInstruction } from "./office-agent-behavior.js";

const MAX_IN_FLIGHT = 4;
const MAX_QUEUE = 16;
const RATE_CAPACITY = 30;
const RATE_PER_SECOND = 10;
// Settle slightly before Hermes' own waits so a late response cannot be
// applied to the next FIFO approval after the upstream head times out.
const APPROVAL_TTL_MS = 59_000;
const CLARIFICATION_TTL_MS = 299_000;
const INTERACTION_DEADLINE_LEAD_MAX_MS = 1_000;
const MAX_BUFFERED_BYTES = 256 * 1024;
const MAX_APPROVAL_QUEUE = 8;
const MAX_APPROVAL_SESSIONS = 128;
const MAX_LIVE_EVENT_COUNT = 4_096;
const MAX_LIVE_EVENT_BYTES = 8 * 1024 * 1024;
const READINESS_HEARTBEAT_MS = 5_000;
const DELEGATION_CATALOG_DEADLINE_MS = 2_500;
const DELEGATION_CATALOG_MAX_PROFILES = 32;
const DELEGATION_CATALOG_MAX_PROVIDERS_PER_PROFILE = 16;
const DELEGATION_CATALOG_MAX_MODELS_PER_PROVIDER = 128;
const DELEGATION_CATALOG_MAX_REQUESTS = 128;
const DELEGATION_CATALOG_CONCURRENCY = 4;
const DELEGATION_CATALOG_MAX_UTF8_BYTES = 64 * 1024;
const OWNED_LIVE_METHODS = new Set<HermesChatMethod>(["prompt.submit", "session.steer", "session.interrupt", "slash.exec"]);

export interface ChatGatewayLimits {
  maxInFlight: number;
  maxQueue: number;
  socketRateCapacity: number;
  socketRatePerSecond: number;
  approvalTtlMs: number;
  clarificationTtlMs: number;
  maxBufferedBytes: number;
  maxApprovalQueue: number;
  maxLiveEventCount: number;
  maxLiveEventBytes: number;
}

const DEFAULT_LIMITS: ChatGatewayLimits = {
  maxInFlight: MAX_IN_FLIGHT,
  maxQueue: MAX_QUEUE,
  socketRateCapacity: RATE_CAPACITY,
  socketRatePerSecond: RATE_PER_SECOND,
  approvalTtlMs: APPROVAL_TTL_MS,
  clarificationTtlMs: CLARIFICATION_TTL_MS,
  maxBufferedBytes: MAX_BUFFERED_BYTES,
  maxApprovalQueue: MAX_APPROVAL_QUEUE,
  maxLiveEventCount: MAX_LIVE_EVENT_COUNT,
  maxLiveEventBytes: MAX_LIVE_EVENT_BYTES,
};

export interface ChatGatewayDependencies {
  auth: OfficeAuth;
  officeSession: OfficeAuthSession;
  runtimeSource: HermesRuntimeSource;
  maxJsonBytes: number;
  deviceLimiter: ChatDeviceRateLimiter;
  limits?: Partial<ChatGatewayLimits>;
  now?: () => number;
  sessionIsActive?: () => boolean;
  invalidationSignal?: AbortSignal;
  /** Testable interval for authenticated pre-ready progress frames. */
  readinessHeartbeatMs?: number;
  sessionCoordinator: ChatSessionCoordinator;
  chatHub: ChatUpstreamHub;
  /** Optional Office-owned skill/MCP/tool usage meter (fail-safe). */
  usageTelemetry?: UsageTelemetryStore;
}

type PendingResponseState = "pending" | "claimed" | "consumed";
interface PendingResponse {
  sessionId: string;
  requestId: string;
  leaseToken: symbol;
  createdAt: number;
  createdOrder: number;
  expiresAt: number;
  state: PendingResponseState;
}
interface PendingApproval {
  id: string;
  leaseToken: symbol;
  choices: ReadonlySet<string>;
  event: HermesChatEvent;
  state: PendingResponseState;
  createdAt?: number;
  createdOrder?: number;
  expiresAt?: number;
}
type PendingClaim =
  | { kind: "approval"; key: string; entry: PendingApproval }
  | { kind: "clarification"; key: string; entry: PendingResponse };

export class ChatDeviceRateLimiter {
  readonly #buckets = new Map<string, { tokens: number; updatedAt: number }>();
  readonly #now: () => number;
  readonly #capacity: number;
  readonly #ratePerSecond: number;

  constructor(options: { now?: () => number; capacity?: number; ratePerSecond?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#capacity = options.capacity ?? 60;
    this.#ratePerSecond = options.ratePerSecond ?? 20;
  }

  consume(deviceId: string): boolean {
    const now = this.#now();
    const bucket = this.#buckets.get(deviceId) ?? { tokens: this.#capacity, updatedAt: now };
    bucket.tokens = Math.min(this.#capacity, bucket.tokens + ((now - bucket.updatedAt) / 1_000) * this.#ratePerSecond);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    this.#buckets.set(deviceId, bucket);
    if (this.#buckets.size > 128) {
      const stale = [...this.#buckets].sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0];
      if (stale !== undefined) this.#buckets.delete(stale[0]);
    }
    return true;
  }
}

export function handleOfficeChatConnection(client: WebSocket, dependencies: ChatGatewayDependencies): void {
  const { auth, officeSession, runtimeSource, maxJsonBytes, deviceLimiter, sessionCoordinator, chatHub, usageTelemetry } = dependencies;
  if (!(sessionCoordinator instanceof ChatSessionCoordinator) || !(chatHub instanceof ChatUpstreamHub)) {
    client.close(1011, "Chat session hub unavailable");
    return;
  }
  const canApprovePermanently = auth.effectiveAccess(officeSession).allowedOperations.includes("chat.approval.permanent");
  const now = dependencies.now ?? Date.now;
  const readinessHeartbeatMs = Math.max(1, dependencies.readinessHeartbeatMs ?? READINESS_HEARTBEAT_MS);
  const sessionOwner = {};
  const limits = {
    ...DEFAULT_LIMITS,
    ...dependencies.limits,
    maxBufferedBytes: Math.max(maxJsonBytes, dependencies.limits?.maxBufferedBytes ?? MAX_BUFFERED_BYTES),
  };
  const approvalTtlOverride = dependencies.limits?.approvalTtlMs;
  // Existing focused tests historically used approvalTtlMs for both kinds.
  // Preserve that override contract while production uses the independent
  // Hermes clarification deadline.
  const clarificationTtlOverride = dependencies.limits?.clarificationTtlMs
    ?? dependencies.limits?.approvalTtlMs;
  const queued: Array<{ body: string; receivedAt: number; receivedOrder: number }> = [];
  const pendingApprovals = new Map<string, PendingApproval[]>();
  const pendingClarifications = new Map<string, PendingResponse>();
  const approvalExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const clarificationExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const liveEventBudgets = new Map<string, { leaseToken: symbol; count: number; bytes: number }>();
  let hubReady = false;
  let officeHelloReceived = false;
  let readinessHeartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let inFlight = 0;
  let chronology = 0;
  let rateTokens = limits.socketRateCapacity;
  let rateUpdatedAt = now();
  let closeWhenIdleReason: string | undefined;

  const clearReadinessHeartbeat = (): void => {
    if (readinessHeartbeatTimer !== undefined) clearTimeout(readinessHeartbeatTimer);
    readinessHeartbeatTimer = undefined;
  };

  const clearExpiryTimer = (timers: Map<string, ReturnType<typeof setTimeout>>, key: string): void => {
    const timer = timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(key);
  };

  const sessionIsActive = dependencies.sessionIsActive ?? (() => {
    const expiresAt = Date.parse(officeSession.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > now();
  });

  const purgePendingLease = (leaseToken: symbol): void => {
    for (const [liveId, queue] of pendingApprovals) {
      if (queue.some((entry) => entry.leaseToken === leaseToken)) {
        pendingApprovals.delete(liveId);
        clearExpiryTimer(approvalExpiryTimers, liveId);
      }
    }
    for (const [key, entry] of pendingClarifications) {
      if (entry.leaseToken === leaseToken) {
        pendingClarifications.delete(key);
        clearExpiryTimer(clarificationExpiryTimers, key);
      }
    }
    for (const [liveId, budget] of liveEventBudgets) {
      if (budget.leaseToken === leaseToken) liveEventBudgets.delete(liveId);
    }
  };

  const cleanupOwnedSessions = (): void => {
    void chatHub.closeOwnerSessions(sessionOwner).catch(() => undefined);
  };

  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    clearReadinessHeartbeat();
    queued.length = 0;
    for (const timer of approvalExpiryTimers.values()) clearTimeout(timer);
    for (const timer of clarificationExpiryTimers.values()) clearTimeout(timer);
    approvalExpiryTimers.clear();
    clarificationExpiryTimers.clear();
    pendingApprovals.clear();
    pendingClarifications.clear();
    liveEventBudgets.clear();
    chatHub.detach(sessionOwner);
    cleanupOwnedSessions();
  };

  const invalidate = (reason: string): void => {
    shutdown();
    if (client.readyState === WebSocket.OPEN) client.close(1008, reason);
  };

  const authorizeSideEffect = (): boolean => {
    const active = dependencies.invalidationSignal?.aborted !== true && sessionIsActive();
    if (!active) invalidate("Session expired or revoked");
    return active;
  };

  const closeAfterInFlight = (reason: string): void => {
    hubReady = false;
    queued.length = 0;
    closeWhenIdleReason = reason;
    if (inFlight === 0 && client.readyState === WebSocket.OPEN) client.close(1013, reason);
  };

  dependencies.invalidationSignal?.addEventListener(
    "abort", () => invalidate("Session expired or revoked"), { once: true },
  );
  if (dependencies.invalidationSignal?.aborted === true) invalidate("Session expired or revoked");

  const closeForBackpressure = (): void => {
    if (!closed && client.readyState === WebSocket.OPEN) {
      client.close(1013, "Client too slow; reload history");
    }
  };

  const sendWire = (body: string): boolean => {
    if (closed || client.readyState !== WebSocket.OPEN) return false;
    const buffered = typeof client.bufferedAmount === "number" && Number.isFinite(client.bufferedAmount)
      ? Math.max(0, client.bufferedAmount)
      : limits.maxBufferedBytes + 1;
    if (buffered + Buffer.byteLength(body) > limits.maxBufferedBytes) {
      closeForBackpressure();
      return false;
    }
    try {
      // `ws` delegates to Node's socket write callback, which can report
      // success as either `undefined` or `null` at runtime despite its type.
      client.send(body, (error) => { if (error != null) closeForBackpressure(); });
      return true;
    } catch {
      closeForBackpressure();
      return false;
    }
  };

  const send = (value: unknown): void => {
    if (client.readyState !== WebSocket.OPEN) return;
    let body: string;
    try { body = JSON.stringify(value); } catch { return; }
    if (Buffer.byteLength(body) <= maxJsonBytes) { sendWire(body); return; }
    if (typeof value === "object" && value !== null && "id" in value) {
      const id = (value as { id?: unknown }).id;
      const fallback = JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32005, message: "Office response exceeded the wire budget." } });
      if (Buffer.byteLength(fallback) <= maxJsonBytes) sendWire(fallback);
    }
  };

  const sendReadinessProgress = (): void => {
    send({ jsonrpc: "2.0", method: "office.waiting", params: { phase: "attaching" } });
  };

  const scheduleReadinessHeartbeat = (): void => {
    clearReadinessHeartbeat();
    if (closed || hubReady || !officeHelloReceived || client.readyState !== WebSocket.OPEN) return;
    readinessHeartbeatTimer = setTimeout(() => {
      readinessHeartbeatTimer = undefined;
      if (closed || hubReady || !officeHelloReceived || client.readyState !== WebSocket.OPEN) return;
      sendReadinessProgress();
      scheduleReadinessHeartbeat();
    }, readinessHeartbeatMs);
    readinessHeartbeatTimer.unref();
  };

  const sendInteractionExpired = (
    type: "approval.expired" | "clarify.expired",
    sessionId: string,
    payload: { approvalId: string } | { requestId: string },
  ): void => {
    sendWire(serializeOfficeChatEvent({ type, sessionId, payload }, maxJsonBytes));
  };

  const hasQueuedTimelyResponse = (claim: PendingClaim): boolean => {
    const { createdAt, createdOrder, expiresAt } = claim.entry;
    if (createdAt === undefined || createdOrder === undefined || expiresAt === undefined) return false;
    return queued.some(({ body, receivedAt, receivedOrder }) => {
      if (receivedAt < createdAt || receivedAt >= expiresAt || receivedOrder < createdOrder) return false;
      let frame: unknown;
      try { frame = JSON.parse(body); } catch { return false; }
      if (!isRpcRequest(frame)) return false;
      if (claim.kind === "approval") {
        return frame.method === "approval.respond"
          && frame.params?.session_id === claim.key
          && frame.params?.approval_id === claim.entry.id
          && typeof frame.params?.choice === "string"
          && claim.entry.choices.has(frame.params.choice);
      }
      return frame.method === "clarify.respond"
        && frame.params?.session_id === claim.entry.sessionId
        && frame.params?.request_id === claim.entry.requestId;
    });
  };

  const sendInteractionSettlementError = (sessionId: string): void => {
    sendWire(serializeOfficeChatEvent({
      type: "error",
      sessionId,
      payload: {
        status: "resync_required",
        message: "Hermes interaction expiry could not be confirmed. Reload session history.",
      },
    }, maxJsonBytes));
    closeAfterInFlight("Hermes interaction expiry could not be confirmed; reload history");
  };

  const settleExpiredApproval = async (sessionId: string, approval: PendingApproval): Promise<void> => {
    if (closed || pendingApprovals.get(sessionId)?.[0] !== approval || approval.state !== "pending") return;
    if (sessionCoordinator.routingLeaseToken(sessionOwner, sessionId) !== approval.leaseToken) {
      pendingApprovals.delete(sessionId);
      return;
    }
    approval.state = "claimed";
    let safeToContinue = false;
    try {
      await chatHub.requestOwnedSession(
        sessionOwner,
        sessionId,
        approval.leaseToken,
        { method: "approval.respond", params: { session_id: sessionId, choice: "deny" } },
        authorizeSideEffect,
      );
      safeToContinue = true;
    } catch (error) {
      // A definite Hermes rejection means its own deadline already removed the
      // head. Ambiguous transport outcomes must not expose the next FIFO item.
      safeToContinue = error instanceof HermesChatTransportError && error.code === "backend_rejected";
    }
    if (closed || pendingApprovals.get(sessionId)?.[0] !== approval || approval.state !== "claimed") return;
    const promoted = consumeClaim(
      { kind: "approval", key: sessionId, entry: approval },
      pendingApprovals,
      pendingClarifications,
    );
    sendInteractionExpired("approval.expired", sessionId, { approvalId: approval.id });
    if (!safeToContinue) {
      sendInteractionSettlementError(sessionId);
      return;
    }
    if (promoted !== undefined) activateAndSendApproval(sessionId, promoted);
  };

  const settleExpiredClarification = async (key: string, entry: PendingResponse): Promise<void> => {
    if (closed || pendingClarifications.get(key) !== entry || entry.state !== "pending") return;
    if (sessionCoordinator.routingLeaseToken(sessionOwner, entry.sessionId) !== entry.leaseToken) {
      pendingClarifications.delete(key);
      return;
    }
    entry.state = "claimed";
    let safeToContinue = false;
    try {
      await chatHub.requestOwnedSession(
        sessionOwner,
        entry.sessionId,
        entry.leaseToken,
        { method: "clarify.respond", params: { request_id: entry.requestId, answer: "" } },
        authorizeSideEffect,
      );
      safeToContinue = true;
    } catch (error) {
      safeToContinue = error instanceof HermesChatTransportError && error.code === "backend_rejected";
    }
    if (closed || pendingClarifications.get(key) !== entry || entry.state !== "claimed") return;
    consumeClaim(
      { kind: "clarification", key, entry },
      pendingApprovals,
      pendingClarifications,
    );
    sendInteractionExpired("clarify.expired", entry.sessionId, { requestId: entry.requestId });
    if (!safeToContinue) {
      sendInteractionSettlementError(entry.sessionId);
      return;
    }
    trimClarifications();
  };

  function scheduleApprovalExpiry(sessionId: string, approval: PendingApproval, minimumDelayMs = 1): void {
    clearExpiryTimer(approvalExpiryTimers, sessionId);
    const expiresAt = approval.expiresAt;
    if (closed || expiresAt === undefined) return;
    const timer = setTimeout(() => {
      approvalExpiryTimers.delete(sessionId);
      if (closed) return;
      const queue = pendingApprovals.get(sessionId);
      if (queue?.[0] !== approval) return;
      if (approval.state === "claimed") return;
      // Process a matching frame received before the deadline first. receivedAt
      // and order are the security boundary; unrelated traffic cannot extend
      // the TTL, while a timely response waiting in the FIFO remains valid.
      if (hasQueuedTimelyResponse({ kind: "approval", key: sessionId, entry: approval })) {
        scheduleApprovalExpiry(sessionId, approval, 25);
        return;
      }
      const currentTime = now();
      if (expiresAt > currentTime) {
        scheduleApprovalExpiry(sessionId, approval);
        return;
      }
      if (sessionCoordinator.routingLeaseToken(sessionOwner, sessionId) !== approval.leaseToken) {
        pendingApprovals.delete(sessionId);
        return;
      }
      void settleExpiredApproval(sessionId, approval);
    }, Math.max(minimumDelayMs, expiresAt - now()));
    timer.unref();
    approvalExpiryTimers.set(sessionId, timer);
  }

  function activateAndSendApproval(sessionId: string, approval: PendingApproval): void {
    sendWire(serializeOfficeChatEvent(
      activateApproval(approval, now(), ++chronology, limits.approvalTtlMs),
      maxJsonBytes,
    ));
    scheduleApprovalExpiry(sessionId, approval);
    if (approvalTtlOverride === undefined) {
      const profile = sessionCoordinator.profileForLive(sessionId);
      if (profile !== undefined) {
        void configuredApprovalTtlMs(runtimeSource, profile).then((ttlMs) => {
          if (closed || pendingApprovals.get(sessionId)?.[0] !== approval || approval.state !== "pending"
            || approval.createdAt === undefined) return;
          approval.expiresAt = approval.createdAt + ttlMs;
          scheduleApprovalExpiry(sessionId, approval);
        });
      }
    }
  }

  function scheduleClarificationExpiry(key: string, entry: PendingResponse, minimumDelayMs = 1): void {
    clearExpiryTimer(clarificationExpiryTimers, key);
    if (closed) return;
    const timer = setTimeout(() => {
      clarificationExpiryTimers.delete(key);
      if (closed || pendingClarifications.get(key) !== entry) return;
      if (entry.state === "claimed") return;
      if (hasQueuedTimelyResponse({ kind: "clarification", key, entry })) {
        scheduleClarificationExpiry(key, entry, 25);
        return;
      }
      const currentTime = now();
      if (entry.expiresAt > currentTime) {
        scheduleClarificationExpiry(key, entry);
        return;
      }
      void settleExpiredClarification(key, entry);
    }, Math.max(minimumDelayMs, entry.expiresAt - now()));
    timer.unref();
    clarificationExpiryTimers.set(key, timer);
  }

  const trimClarifications = (): void => {
    while (pendingClarifications.size > 128) {
      const oldest = [...pendingClarifications].find(([, entry]) => entry.state === "pending");
      if (oldest === undefined) return;
      clearExpiryTimer(clarificationExpiryTimers, oldest[0]);
      void settleExpiredClarification(oldest[0], oldest[1]);
      return;
    }
  };

  const cleanupRejectedSessionResult = async (
    binding: "conflict" | "invalid",
    liveSessionId: string | undefined,
  ): Promise<boolean> => {
    if (liveSessionId === undefined) {
      if (binding === "invalid") chatHub.resetAmbiguousSessionResult();
      return false;
    }
    chatHub.discardBufferedSession(liveSessionId);
    if (sessionCoordinator.ownerForLive(liveSessionId) !== undefined) return true;
    try {
      await chatHub.closeDuplicateSession(liveSessionId);
      return true;
    } catch {
      return false;
    }
  };

  const processFrame = async (body: string, receivedAt: number, receivedOrder: number): Promise<void> => {
    if (!authorizeSideEffect()) return;
    let frame: unknown;
    try { frame = JSON.parse(body); } catch { client.close(1007, "Invalid JSON"); return; }
    if (!isRpcRequest(frame)) { client.close(1008, "Invalid RPC request"); return; }
    let claim: PendingClaim | undefined;
    let sessionClaim: ChatSessionClaim | undefined;
    let sessionStartSettlement: { settle(): void } | undefined;
    let ownedRequestLiveId: string | undefined;
    let ownedRequestLeaseToken: symbol | undefined;
    try {
      const access = auth.authorizeSession(officeSession, chatOperation(frame.method));
      if (!access.allowed) { sendRpcError(send, frame.id, -32003, "Operation is not permitted for this device."); return; }
      const targetId = chatTargetId(frame.method, frame.params);
      const targetOwner = targetId === undefined ? undefined : sessionCoordinator.ownerForLive(targetId);
      const targetLeaseToken = targetId === undefined ? undefined : sessionCoordinator.liveLeaseToken(sessionOwner, targetId);
      const targetRoutingLeaseToken = targetId === undefined
        ? undefined
        : sessionCoordinator.routingLeaseToken(sessionOwner, targetId);
      if (OWNED_LIVE_METHODS.has(frame.method) && targetLeaseToken === undefined) {
        sendSessionInUse(send, frame.id);
        return;
      }
      if (OWNED_LIVE_METHODS.has(frame.method)) {
        ownedRequestLiveId = targetId;
        ownedRequestLeaseToken = targetLeaseToken;
      }
      if (frame.method !== "session.resume" && frame.method !== "approval.respond" && frame.method !== "clarify.respond"
        && !OWNED_LIVE_METHODS.has(frame.method) && targetId !== undefined && targetOwner !== undefined && targetOwner !== sessionOwner) {
        sendSessionInUse(send, frame.id);
        return;
      }
      if (frame.method === "approval.respond") {
        const choice = typeof frame.params?.choice === "string" ? frame.params.choice : "";
        if (choice === "always" && !auth.authorizeSession(officeSession, "chat.approval.permanent").allowed) {
          sendRpcError(send, frame.id, -32003, "Permanent approval requires verified local owner access.");
          return;
        }
        const approvalId = typeof frame.params?.approval_id === "string" ? frame.params.approval_id : "";
        const queue = targetId === undefined ? undefined : pendingApprovals.get(targetId);
        const pending = queue?.[0];
        const identityMatches = targetRoutingLeaseToken !== undefined && pending?.leaseToken === targetRoutingLeaseToken;
        const ownsTarget = targetLeaseToken !== undefined && pending?.leaseToken === targetLeaseToken;
        if (!identityMatches && targetId !== undefined) {
          pendingApprovals.delete(targetId);
          clearExpiryTimer(approvalExpiryTimers, targetId);
        }
        if (!ownsTarget || pending === undefined || pending.createdAt === undefined || pending.createdOrder === undefined || pending.expiresAt === undefined || pending.id !== approvalId || pending.state !== "pending" || receivedOrder < pending.createdOrder || receivedAt < pending.createdAt || pending.expiresAt <= receivedAt || !pending.choices.has(choice)) {
          if (targetId !== undefined && pending?.id === approvalId && pending.expiresAt !== undefined && pending.expiresAt <= receivedAt) {
            clearExpiryTimer(approvalExpiryTimers, targetId);
            await settleExpiredApproval(targetId, pending);
          }
          sendRpcError(send, frame.id, -32004, "Pending approval was not found or has expired.");
          return;
        }
        pending.state = "claimed";
        claim = { kind: "approval", key: targetId!, entry: pending };
        ownedRequestLiveId = targetId;
        ownedRequestLeaseToken = pending.leaseToken;
      }
      if (frame.method === "clarify.respond") {
        const sessionId = typeof frame.params?.session_id === "string" ? frame.params.session_id : "";
        const requestId = typeof frame.params?.request_id === "string" ? frame.params.request_id : "";
        const key = clarificationKey(sessionId, requestId);
        const pending = pendingClarifications.get(key);
        const identityMatches = pending !== undefined
          && pending.sessionId === sessionId
          && sessionCoordinator.routingLeaseToken(sessionOwner, sessionId) === pending.leaseToken;
        const ownsTarget = identityMatches
          && sessionCoordinator.ownsLiveLease(sessionOwner, sessionId, pending.leaseToken);
        if (pending !== undefined && !identityMatches) {
          pendingClarifications.delete(key);
          clearExpiryTimer(clarificationExpiryTimers, key);
        }
        if (!ownsTarget || pending === undefined || pending.state !== "pending" || receivedOrder < pending.createdOrder || receivedAt < pending.createdAt || pending.expiresAt <= receivedAt) {
          if (pending?.expiresAt !== undefined && pending.expiresAt <= receivedAt) {
            clearExpiryTimer(clarificationExpiryTimers, key);
            await settleExpiredClarification(key, pending);
          }
          sendRpcError(send, frame.id, -32004, "Pending clarification was not found.");
          return;
        }
        pending.state = "claimed";
        claim = { kind: "clarification", key, entry: pending };
        ownedRequestLiveId = sessionId;
        ownedRequestLeaseToken = pending.leaseToken;
      }
      if (frame.method === "session.create") {
        const profile = typeof frame.params?.profile === "string" ? frame.params.profile : "default";
        if (!sessionCoordinator.canCreateLease(sessionOwner, profile)) {
          sendSessionLimit(send, frame.id);
          return;
        }
        sessionClaim = sessionCoordinator.claimCreate(sessionOwner, profile);
      }
      if (frame.method === "session.resume" && typeof frame.params?.session_id === "string") {
        const profile = typeof frame.params.profile === "string" ? frame.params.profile : "default";
        if (!sessionCoordinator.ownsDurableSession(sessionOwner, profile, frame.params.session_id)
          && !sessionCoordinator.canCreateLease(sessionOwner, profile)) {
          sendSessionLimit(send, frame.id);
          return;
        }
        sessionClaim = sessionCoordinator.claimResume(sessionOwner, profile, frame.params.session_id);
        if (sessionClaim === undefined) { sendSessionInUse(send, frame.id); return; }
      }
      const seed = frame.method === "session.create"
        ? await resolveSessionCreateSystemSeed(
          runtimeSource,
          typeof frame.params?.profile === "string" ? frame.params.profile : "default",
        )
        : undefined;
      if (closed || !authorizeSideEffect()) { sessionCoordinator.releaseFailedClaim(sessionClaim); return; }
      let ownedRequest: { liveSessionId: string; leaseToken: symbol } | undefined;
      if (ownedRequestLiveId !== undefined) {
        if (ownedRequestLeaseToken === undefined) {
          throw new Error("Owned live-session request is missing its lease token.");
        }
        ownedRequest = { liveSessionId: ownedRequestLiveId, leaseToken: ownedRequestLeaseToken };
      }
      if (sessionClaim !== undefined) sessionStartSettlement = chatHub.beginSessionStart(sessionOwner);
      const isDefaultPrompt = frame.method === "prompt.submit" && ownedRequest !== undefined
        && sessionCoordinator.profileForLive(ownedRequest.liveSessionId) === "default";
      const defaultPromptModelCatalog = isDefaultPrompt
        ? await resolveDefaultDelegationModelCatalog(runtimeSource)
        : undefined;
      const promptInternal = frame.method === "prompt.submit"
        ? {
          studioFollowUpTurn: true as const,
          ...(isDefaultPrompt
            ? {
              studioDefaultDelegationTurn: true as const,
              ...(defaultPromptModelCatalog === undefined
                ? {}
                : { studioDefaultDelegationModelCatalog: defaultPromptModelCatalog }),
            }
            : {}),
        }
        : undefined;
      const result = frame.method === "session.close" && typeof frame.params?.session_id === "string"
        ? await chatHub.closeOwnedSession(sessionOwner, frame.params.session_id, authorizeSideEffect)
        : ownedRequest !== undefined
          ? await chatHub.requestOwnedSession(
            sessionOwner, ownedRequest.liveSessionId, ownedRequest.leaseToken,
            { method: frame.method, ...upstreamRequestParams(frame.method, frame.params) },
            authorizeSideEffect,
            promptInternal,
          )
        : await chatHub.request(
          sessionOwner,
          { method: frame.method, ...upstreamRequestParams(frame.method, frame.params) },
          seed === undefined ? undefined : { sessionCreateSystemSeed: seed },
          authorizeSideEffect,
        );
      if (frame.method === "session.close" && targetLeaseToken !== undefined) purgePendingLease(targetLeaseToken);
      let boundLiveId: string | undefined;
      if (sessionClaim !== undefined) {
        const identities = sessionIdentities(result.value, frame.method);
        const binding = sessionCoordinator.bind(sessionClaim, identities, frame.method === "session.create");
        if (binding !== "bound") {
          sessionCoordinator.releaseFailedClaim(sessionClaim);
          if (!await cleanupRejectedSessionResult(binding, identities.liveSessionId)) return;
          if (!closed && binding === "conflict") sendSessionInUse(send, frame.id);
          else if (!closed) sendRpcError(send, frame.id, -32000, "Hermes returned an invalid session identity.");
          return;
        }
        boundLiveId = identities.liveSessionId;
      }
      if (!interactionResultAccepted(frame.method, result.value)) {
        if (frame.method === "approval.respond" || frame.method === "clarify.respond") {
          throw new ChatCommitUnconfirmedError();
        }
        throw new Error("Hermes returned an invalid interaction acknowledgement.");
      }
      const promoted = consumeClaim(claim, pendingApprovals, pendingClarifications);
      if (claim?.kind === "approval") clearExpiryTimer(approvalExpiryTimers, claim.key);
      if (claim?.kind === "clarification") clearExpiryTimer(clarificationExpiryTimers, claim.key);
      if (promoted !== undefined && claim?.kind === "approval") activateAndSendApproval(claim.key, promoted);
      if (!closed) {
        send({ jsonrpc: "2.0", id: frame.id, result: result.value });
        if (boundLiveId !== undefined) chatHub.flushLiveSession(boundLiveId);
      } else {
        cleanupOwnedSessions();
      }
    } catch (error) {
      sessionCoordinator.releaseFailedClaim(sessionClaim);
      // A transport failure after Hermes received an interaction response is
      // ambiguous. Do not put that approval/question back in front of the user:
      // replaying it can answer the same upstream interaction twice.
      const claimExpired = claim !== undefined && claim.entry.expiresAt !== undefined && claim.entry.expiresAt <= now();
      const commitUnconfirmed = error instanceof ChatCommitUnconfirmedError;
      const promoted = commitUnconfirmed
        ? consumeClaim(claim, pendingApprovals, pendingClarifications)
        : undefined;
      if (claim?.kind === "approval") {
        clearExpiryTimer(approvalExpiryTimers, claim.key);
        if (commitUnconfirmed) {
          if (promoted !== undefined) activateAndSendApproval(claim.key, promoted);
        } else if (claimExpired) {
          claim.entry.state = "pending";
          await settleExpiredApproval(claim.key, claim.entry);
        } else {
          restoreClaim(claim, pendingApprovals, pendingClarifications, closed, now());
        }
        if (!claimExpired && !commitUnconfirmed && claim.entry.state === "pending") {
          scheduleApprovalExpiry(claim.key, claim.entry);
        }
      }
      if (claim?.kind === "clarification") {
        clearExpiryTimer(clarificationExpiryTimers, claim.key);
        if (commitUnconfirmed) {
          // consumeClaim above removes this one-shot request so the browser's
          // history barrier can reconcile without replaying the answer.
        } else if (claimExpired) {
          claim.entry.state = "pending";
          await settleExpiredClarification(claim.key, claim.entry);
        } else {
          restoreClaim(claim, pendingApprovals, pendingClarifications, closed, now());
        }
        if (!claimExpired && !commitUnconfirmed && claim.entry.state === "pending") {
          scheduleClarificationExpiry(claim.key, claim.entry);
        }
      }
      if (closed) cleanupOwnedSessions();
      if (error instanceof ChatCommitUnconfirmedError
        && (frame.method === "prompt.submit" || frame.method === "session.steer" || frame.method === "session.interrupt" || frame.method === "slash.exec"
          || frame.method === "approval.respond" || frame.method === "clarify.respond")) {
        sendCommitUnconfirmed(send, frame.id);
      } else {
        sendRpcError(send, frame.id, -32000, "Hermes request failed.");
      }
    } finally {
      sessionStartSettlement?.settle();
    }
  };

  const drain = (): void => {
    while (!closed && hubReady && inFlight < limits.maxInFlight && queued.length > 0) {
      if (!authorizeSideEffect()) return;
      const { body, receivedAt, receivedOrder } = queued.shift()!;
      inFlight += 1;
      void processFrame(body, receivedAt, receivedOrder).finally(() => {
        inFlight -= 1;
        if (inFlight === 0 && closeWhenIdleReason !== undefined && client.readyState === WebSocket.OPEN) {
          client.close(1013, closeWhenIdleReason);
          return;
        }
        drain();
      });
    }
  };

  client.on("message", (data, isBinary) => {
    if (closed || closeWhenIdleReason !== undefined || !authorizeSideEffect()) return;
    if (isBinary) { client.close(1003, "Text frames only"); return; }
    const currentTime = now();
    rateTokens = Math.min(limits.socketRateCapacity, rateTokens + ((currentTime - rateUpdatedAt) / 1_000) * limits.socketRatePerSecond);
    rateUpdatedAt = currentTime;
    if (rateTokens < 1) { client.close(1008, "Chat rate limit exceeded"); return; }
    if (!deviceLimiter.consume(officeSession.principal.id)) { client.close(1008, "Device chat rate limit exceeded"); return; }
    rateTokens -= 1;
    // The browser sends this after installing its message handler so a fast
    // loopback upgrade can deterministically request a fresh readiness frame.
    // It is still rate-limited like every other inbound message.
    if (isOfficeHello(data.toString())) {
      officeHelloReceived = true;
      if (hubReady) send({ jsonrpc: "2.0", method: "office.ready", params: {} });
      else {
        sendReadinessProgress();
        scheduleReadinessHeartbeat();
      }
      return;
    }
    if (queued.length >= limits.maxQueue) { client.close(1013, "Chat queue is full"); return; }
    queued.push({ body: data.toString(), receivedAt: currentTime, receivedOrder: ++chronology });
    drain();
  });
  client.on("close", shutdown);
  client.on("error", shutdown);

  const handleUpstreamEvent = (event: HermesChatEvent): void => {
    if (closed || closeWhenIdleReason !== undefined) return;
    if (event.sessionId !== undefined) {
      const leaseToken = sessionCoordinator.routingLeaseToken(sessionOwner, event.sessionId);
      if (leaseToken === undefined) return;
      const prior = liveEventBudgets.get(event.sessionId);
      const budget = prior?.leaseToken === leaseToken ? prior : { leaseToken, count: 0, bytes: 0 };
      const eventBytes = Buffer.byteLength(serializeOfficeChatEvent(event, maxJsonBytes));
      if (budget.count + 1 > limits.maxLiveEventCount || budget.bytes + eventBytes > limits.maxLiveEventBytes) {
        sendWire(serializeOfficeChatEvent({
          type: "error", sessionId: event.sessionId,
          payload: { status: "resync_required", message: "Live event safety limit exceeded. Reload session history." },
        }, maxJsonBytes));
        closeAfterInFlight("Live event safety limit exceeded; reload history");
        return;
      }
      budget.count += 1;
      budget.bytes += eventBytes;
      liveEventBudgets.set(event.sessionId, budget);
    }
    // Usage telemetry is best-effort and must never affect delivery.
    try {
      const profileHint = event.sessionId === undefined
        ? event.profile
        : sessionCoordinator.profileForLive(event.sessionId) ?? event.profile;
      usageTelemetry?.observeChatEvent(event, profileHint);
    } catch {
      // ignore
    }
    if (event.type === "approval.request" && event.sessionId !== undefined) {
      const leaseToken = sessionCoordinator.routingLeaseToken(sessionOwner, event.sessionId);
      if (leaseToken === undefined) return;
      const normalizedEvent = normalizeApprovalEvent(event, canApprovePermanently);
      const choices = Array.isArray(normalizedEvent.payload.choices)
        ? normalizedEvent.payload.choices.filter((choice): choice is string => typeof choice === "string")
        : [];
      const existingQueue = pendingApprovals.get(event.sessionId);
      const queue = existingQueue?.[0]?.leaseToken === leaseToken ? existingQueue : [];
      if ((existingQueue === undefined && pendingApprovals.size >= MAX_APPROVAL_SESSIONS) || queue.length >= limits.maxApprovalQueue) {
        sendWire(serializeOfficeChatEvent({ type: "error", sessionId: event.sessionId, payload: { status: "resync_required", message: "Approval queue overflow. Reload the session." } }, maxJsonBytes));
        client.close(1013, "Approval queue overflow; reload history");
        return;
      }
      const approval: PendingApproval = {
        id: `approval_${randomBytes(16).toString("base64url")}`,
        leaseToken, choices: new Set(choices), event: normalizedEvent, state: "pending",
      };
      queue.push(approval);
      pendingApprovals.set(event.sessionId, queue);
      if (queue.length === 1) activateAndSendApproval(event.sessionId, approval);
      return;
    }
    if (event.type === "clarify.request" && event.sessionId !== undefined && typeof event.payload.requestId === "string") {
      const leaseToken = sessionCoordinator.routingLeaseToken(sessionOwner, event.sessionId);
      if (leaseToken === undefined) return;
      const createdAt = now();
      const createdOrder = ++chronology;
      const key = clarificationKey(event.sessionId, event.payload.requestId);
      const existing = pendingClarifications.get(key);
      if (existing?.leaseToken !== leaseToken || existing.state !== "claimed") {
        const entry: PendingResponse = {
          sessionId: event.sessionId, requestId: event.payload.requestId, leaseToken, createdAt, createdOrder,
          expiresAt: createdAt + (clarificationTtlOverride ?? limits.clarificationTtlMs), state: "pending",
        };
        pendingClarifications.set(key, entry);
        scheduleClarificationExpiry(key, entry);
      }
      trimClarifications();
    }
    sendWire(serializeOfficeChatEvent(event, maxJsonBytes));
  };

  void chatHub.attach(sessionOwner, {
    onEvent: handleUpstreamEvent,
    onUnavailable: (liveSessionIds) => {
      if (closed) return;
      for (const liveId of liveSessionIds) {
        sendWire(serializeOfficeChatEvent({
          type: "error", sessionId: liveId,
          payload: { status: "resync_required", message: "Hermes chat restarted. Reload session history." },
        }, maxJsonBytes));
      }
      closeAfterInFlight("Hermes chat restarted; reload history");
    },
  }).then(() => {
    if (closed) { chatHub.detach(sessionOwner); return; }
    hubReady = true;
    clearReadinessHeartbeat();
    send({ jsonrpc: "2.0", method: "office.ready", params: {} });
    drain();
  }).catch(() => {
    clearReadinessHeartbeat();
    client.close(1013, "Hermes chat unavailable");
  });
}

function isOfficeHello(value: string): boolean {
  try {
    const frame: unknown = JSON.parse(value);
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return false;
    const record = frame as Record<string, unknown>;
    return record.jsonrpc === "2.0" && record.method === "office.hello";
  } catch {
    return false;
  }
}

function isRpcRequest(value: unknown): value is { id: string | number; method: HermesChatMethod; params?: Record<string, unknown> } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  return frame.jsonrpc === "2.0"
    && (typeof frame.id === "string" || typeof frame.id === "number")
    && typeof frame.method === "string"
    && HERMES_CHAT_METHODS.includes(frame.method as HermesChatMethod)
    && (frame.params === undefined || (typeof frame.params === "object" && frame.params !== null && !Array.isArray(frame.params)));
}

function chatOperation(method: HermesChatMethod): Operation {
  if (method === "session.create" || method === "session.resume") return "chat.session.create";
  if (method === "session.close") return "chat.session.archive";
  if (method === "session.interrupt") return "chat.run.cancel";
  if (method === "complete.slash") return "state.read";
  return "chat.message.send";
}

function chatTargetId(method: HermesChatMethod, params: Record<string, unknown> | undefined): string | undefined {
  if (method === "session.create") return undefined;
  return typeof params?.session_id === "string" ? params.session_id : undefined;
}

function clarificationKey(sessionId: string, requestId: string): string {
  return `${sessionId}\0${requestId}`;
}

function sendRpcError(send: (value: unknown) => void, id: string | number, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function sendCommitUnconfirmed(send: (value: unknown) => void, id: string | number): void {
  send({
    jsonrpc: "2.0", id,
    error: {
      code: -32008,
      message: "Hermes may have committed this request; reload history before retrying.",
      data: { reason: "commit_unconfirmed" },
    },
  });
}

function sendSessionInUse(send: (value: unknown) => void, id: string | number): void {
  send({
    jsonrpc: "2.0", id,
    error: { code: -32006, message: "Session is already in use by another Office client.", data: { reason: "session_in_use" } },
  });
}

function sendSessionLimit(send: (value: unknown) => void, id: string | number): void {
  send({
    jsonrpc: "2.0", id,
    error: { code: -32007, message: "This Office connection has reached its live session limit.", data: { reason: "session_limit" } },
  });
}

function interactionResultAccepted(method: HermesChatMethod, value: HermesChatResult["value"]): boolean {
  if (method === "approval.respond") return value.resolved === true;
  if (method === "clarify.respond") return value.status === "ok";
  return true;
}

function sessionIdentities(
  value: Record<string, boolean | number | string | null>,
  method: HermesChatMethod,
): { storedSessionId?: string; liveSessionId?: string } {
  // A create response must prove a newly persisted identity. Never reinterpret
  // a `resumed` alias as success for a new-chat request.
  const storedSessionId = typeof value.storedSessionId === "string" ? value.storedSessionId
    : method === "session.resume" && typeof value.resumedSessionId === "string" ? value.resumedSessionId : undefined;
  const liveSessionId = typeof value.liveSessionId === "string" ? value.liveSessionId : undefined;
  return { ...(storedSessionId ? { storedSessionId } : {}), ...(liveSessionId ? { liveSessionId } : {}) };
}

function consumeClaim(
  claim: PendingClaim | undefined,
  approvals: Map<string, PendingApproval[]>,
  clarifications: Map<string, PendingResponse>,
): PendingApproval | undefined {
  if (claim === undefined) return undefined;
  if (claim.kind === "approval") {
    const queue = approvals.get(claim.key);
    if (queue?.[0] !== claim.entry || claim.entry.state !== "claimed") return undefined;
    claim.entry.state = "consumed";
    queue.shift();
    if (queue.length === 0) { approvals.delete(claim.key); return undefined; }
    return queue[0]!;
  }
  const current = clarifications.get(claim.key);
  if (current === claim.entry && claim.entry.state === "claimed") {
    claim.entry.state = "consumed";
    clarifications.delete(claim.key);
  }
  return undefined;
}

function restoreClaim(
  claim: PendingClaim | undefined,
  approvals: Map<string, PendingApproval[]>,
  clarifications: ReadonlyMap<string, PendingResponse>,
  closed: boolean,
  currentTime: number,
): PendingApproval | undefined {
  if (claim === undefined || closed) return undefined;
  if (claim.kind === "approval") {
    const queue = approvals.get(claim.key);
    if (queue?.[0] !== claim.entry || claim.entry.state !== "claimed") return undefined;
    if (claim.entry.expiresAt !== undefined && claim.entry.expiresAt > currentTime) { claim.entry.state = "pending"; return undefined; }
    return expireApproval(approvals, claim.key, claim.entry);
  }
  const current = clarifications.get(claim.key);
  if (claim.entry.expiresAt > currentTime && current === claim.entry && claim.entry.state === "claimed") claim.entry.state = "pending";
  return undefined;
}

function expireApproval(approvals: Map<string, PendingApproval[]>, key: string, entry: PendingApproval): PendingApproval | undefined {
  const queue = approvals.get(key);
  if (queue?.[0] !== entry) return undefined;
  queue.shift();
  if (queue.length === 0) { approvals.delete(key); return undefined; }
  return queue[0]!;
}

function upstreamRequestParams(
  method: HermesChatMethod,
  params: Record<string, unknown> | undefined,
): { params?: Record<string, unknown> } {
  if (params === undefined) return {};
  if (method === "session.create" || method === "session.resume") return { params: {
    ...params,
    close_on_disconnect: true,
  } };
  if (method === "clarify.respond") return { params: {
    ...(typeof params.request_id === "string" ? { request_id: params.request_id } : {}),
    ...(typeof params.answer === "string" ? { answer: params.answer } : {}),
  } };
  if (method !== "approval.respond") return { params };
  return { params: {
    ...(typeof params.session_id === "string" ? { session_id: params.session_id } : {}),
    ...(typeof params.choice === "string" ? { choice: params.choice } : {}),
  } };
}

async function configuredApprovalTtlMs(runtimeSource: HermesRuntimeSource, profile: string): Promise<number> {
  try {
    const settings = runtimeSource.settings?.();
    if (settings === undefined) return APPROVAL_TTL_MS;
    const config = await settings.getPrivilegedProfileConfig(profile);
    const seconds = config.values["approvals.timeout"];
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return APPROVAL_TTL_MS;
    const upstreamMs = Math.min(2_147_000_000, Math.floor(seconds * 1_000));
    if (upstreamMs <= 0) return 1;
    const leadMs = Math.min(
      INTERACTION_DEADLINE_LEAD_MAX_MS,
      Math.max(25, Math.floor(upstreamMs * 0.02)),
    );
    return Math.max(1, upstreamMs - leadMs);
  } catch {
    // Config discovery is auxiliary. The Hermes default remains fail-safe.
    return APPROVAL_TTL_MS;
  }
}

/** Trusted Office seeds only: shared context + optional per-profile subagent instruction. */
async function resolveSessionCreateSystemSeed(
  runtimeSource: HermesRuntimeSource,
  profile: string,
): Promise<string | undefined> {
  const [globalContext, behaviorInstruction] = await Promise.all([
    optionalSessionSeedPart(runtimeSource.globalInheritance?.().sessionCreateContext(profile)),
    optionalSessionSeedPart(runtimeSource.agentBehavior?.().sessionCreateInstruction(profile)),
  ]);
  // Always include the Studio follow-up footer contract so chips are agent-authored
  // instead of falling back to the local fixed heuristic.
  return composeSessionCreateSystemSeed(
    globalContext,
    profile === "default" ? studioDefaultProfileOrchestrationInstruction() : undefined,
    // The default profile delegates specialist work to durable Profile/Kanban
    // conversations. A later generic "Use subagents proactively" instruction
    // would weaken that contract, so automatic subagent behavior remains a
    // direct-profile setting only.
    studioProfileAgentBehaviorInstruction(profile, behaviorInstruction),
    studioFollowUpSessionInstruction(),
  );
}

/** Optional Studio metadata must never prevent a new Hermes chat from starting. */
async function optionalSessionSeedPart(value: Promise<string | undefined> | undefined): Promise<string | undefined> {
  if (value === undefined) return undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      value.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 1_000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type DelegationProfileCatalog = {
  profile: string;
  root?: LiveModelsCatalog;
  providers: LiveModelsCatalog[];
  expectedProviderIds: string[];
  providerListTruncated: boolean;
};

/**
 * Resolve the same profile-scoped live catalogs used by the Studio model UI.
 * Every dimension is bounded and failures are represented without diagnostics;
 * catalog discovery must never prevent the user's prompt from being sent.
 */
export async function resolveDefaultDelegationModelCatalog(
  runtimeSource: HermesRuntimeSource,
  deadlineMs = DELEGATION_CATALOG_DEADLINE_MS,
): Promise<string | undefined> {
  let adapter: ReturnType<NonNullable<HermesRuntimeSource["models"]>> | undefined;
  try { adapter = runtimeSource.models?.(); }
  catch { adapter = undefined; }
  const catalogAdapter = adapter;
  const deadline = Date.now() + deadlineMs;
  try {
    const snapshot = await withinDelegationCatalogDeadline(() => runtimeSource.snapshot(), deadline);
    const profiles = [...snapshot.profiles]
      .map(({ id }) => id)
      .filter((id) => id !== "default")
      .sort((left, right) => left.localeCompare(right))
      .slice(0, DELEGATION_CATALOG_MAX_PROFILES);
    const roots = catalogAdapter === undefined
      ? profiles.map(() => undefined)
      : await boundedCatalogMap(profiles, async (profile) => {
        try { return await withinDelegationCatalogDeadline(() => catalogAdapter.loadLiveCatalog(profile), deadline); }
        catch { return undefined; }
      });
    const collected: DelegationProfileCatalog[] = profiles.map((profile, index) => {
      const root = roots[index];
      return {
        profile,
        ...(root === undefined ? {} : { root }),
        providers: root === undefined ? [] : [root],
        expectedProviderIds: root?.providers.map(({ id }) => id)
          .sort((left, right) => left.localeCompare(right))
          .slice(0, DELEGATION_CATALOG_MAX_PROVIDERS_PER_PROFILE) ?? [],
        providerListTruncated: (root?.providers.length ?? 0) > DELEGATION_CATALOG_MAX_PROVIDERS_PER_PROFILE,
      };
    });
    const jobs = collected.flatMap((profile) => profile.expectedProviderIds
      .filter((provider) => provider !== profile.root?.provider)
      .map((provider) => ({ profile, provider })))
      .slice(0, Math.max(0, DELEGATION_CATALOG_MAX_REQUESTS - profiles.length));
    await boundedCatalogMap(jobs, async ({ profile, provider }) => {
      try {
        if (catalogAdapter === undefined) return undefined;
        const catalog = await withinDelegationCatalogDeadline(
          () => catalogAdapter.loadLiveCatalog(profile.profile, provider),
          deadline,
        );
        profile.providers.push(catalog);
      } catch { /* The profile is emitted as partial/unavailable without diagnostics. */ }
      return undefined;
    });
    return formatDelegationModelCatalog(
      collected,
      snapshot.profiles.length - (snapshot.profiles.some(({ id }) => id === "default") ? 1 : 0) > profiles.length
        || profileInventoryIncomplete(snapshot.inventory.profiles),
    );
  } catch {
    return unavailableDelegationModelCatalog();
  }
}

function profileInventoryIncomplete(page: {
  returned: number;
  available: number;
  total?: number;
  hasMore: boolean;
  truncated: boolean;
  partialFailures: number;
}): boolean {
  return page.truncated || page.partialFailures > 0 || page.hasMore
    || page.returned < page.available
    || (page.total !== undefined && page.available < page.total);
}

async function boundedCatalogMap<T, R>(items: readonly T[], task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(DELEGATION_CATALOG_CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function withinDelegationCatalogDeadline<T>(operation: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("catalog deadline");
  // Invoke lazily only after the deadline guard. Bounded workers may continue
  // draining their local job indexes after timeout, but no expired job is
  // allowed to start new adapter I/O.
  const value = operation();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("catalog deadline")), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function formatDelegationModelCatalog(profiles: readonly DelegationProfileCatalog[], profilesTruncated: boolean): string {
  let catalogStatus = profiles.length === 0 || profiles.every(({ root }) => root === undefined)
    ? "unavailable"
    : profilesTruncated || profiles.some((profile) => !profileCatalogCoverageComplete(profile))
      ? "partial"
      : "complete";
  const lines = [
    JSON.stringify({ version: 1, catalogStatus, usableFor: ["main", "subagent"], coverage: "profile-scoped live provider catalogs" }),
  ];
  let bytes = Buffer.byteLength(`${lines[0]}\n`);
  let truncated = profilesTruncated;
  const append = (record: Record<string, unknown>, reserveTruncationMarker = true): boolean => {
    const line = JSON.stringify(record);
    const added = Buffer.byteLength(`${line}\n`);
    const limit = DELEGATION_CATALOG_MAX_UTF8_BYTES - (reserveTruncationMarker ? 32 : 0);
    if (bytes + added > limit) { truncated = true; return false; }
    lines.push(line);
    bytes += added;
    return true;
  };
  for (const profile of profiles) {
    const loadedProviderIds = new Set(profile.providers.map(({ provider }) => provider));
    const coverageComplete = profileCatalogCoverageComplete(profile);
    if (!append({
      profile: profile.profile,
      status: profile.root === undefined ? "unavailable" : coverageComplete ? "complete" : "partial",
      defaultProvider: profile.root?.defaultProvider ?? null,
      defaultModel: profile.root?.defaultModel ?? null,
      expectedProviderIds: profile.expectedProviderIds,
      loadedProviderIds: [...loadedProviderIds].sort((left, right) => left.localeCompare(right)),
    })) break;
    for (const catalog of [...profile.providers].sort((left, right) => left.provider.localeCompare(right.provider))) {
      for (const model of catalog.models.slice(0, DELEGATION_CATALOG_MAX_MODELS_PER_PROVIDER)) {
        if (!append({
          profile: profile.profile,
          provider: catalog.provider,
          model: model.id,
          reasoningEfforts: model.reasoningEfforts ?? null,
        })) break;
      }
      if (catalog.models.length > DELEGATION_CATALOG_MAX_MODELS_PER_PROVIDER) truncated = true;
    }
  }
  if (truncated) append({ truncated: true }, false);
  if (truncated && catalogStatus === "complete") {
    catalogStatus = "partial";
    lines[0] = JSON.stringify({ version: 1, catalogStatus, usableFor: ["main", "subagent"], coverage: "profile-scoped live provider catalogs" });
  }
  return lines.join("\n");
}

function profileCatalogCoverageComplete(profile: DelegationProfileCatalog): boolean {
  const loadedProviderIds = new Set(profile.providers.map(({ provider }) => provider));
  return profile.root !== undefined
    && !profile.providerListTruncated
    && profile.expectedProviderIds.every((provider) => loadedProviderIds.has(provider))
    && profile.providers.every(({ models }) => models.length <= DELEGATION_CATALOG_MAX_MODELS_PER_PROVIDER);
}

function unavailableDelegationModelCatalog(): string {
  return formatDelegationModelCatalog([], false);
}

function officeApprovalEvent(approval: PendingApproval): HermesChatEvent {
  return { ...approval.event, payload: { ...approval.event.payload, approvalId: approval.id } };
}

function activateApproval(approval: PendingApproval, createdAt: number, createdOrder: number, ttlMs: number): HermesChatEvent {
  approval.createdAt = createdAt;
  approval.createdOrder = createdOrder;
  approval.expiresAt = createdAt + ttlMs;
  approval.state = "pending";
  return officeApprovalEvent(approval);
}

function normalizeApprovalEvent(event: HermesChatEvent, canApprovePermanently: boolean): HermesChatEvent {
  const upstreamAllowsPermanent = event.payload.allowPermanent === true || event.payload.allow_permanent === true;
  const allowPermanent = canApprovePermanently && upstreamAllowsPermanent;
  const choices = Array.isArray(event.payload.choices)
    ? event.payload.choices.filter((choice): choice is string => typeof choice === "string" && (choice !== "always" || allowPermanent))
    : [];
  return { ...event, payload: { ...event.payload, choices, allowPermanent, allow_permanent: allowPermanent } };
}

/** Serializes one upstream event within the exact Office wire budget. */
export function serializeOfficeChatEvent(event: HermesChatEvent, maxBytes: number): string {
  const envelope = (params: HermesChatEvent): unknown => ({ jsonrpc: "2.0", method: "event", params });
  const exact = JSON.stringify(envelope(event));
  if (Buffer.byteLength(exact) <= maxBytes) return exact;

  const payload: HermesChatEvent["payload"] = { ...event.payload, truncated: true };
  const truncated: HermesChatEvent = { ...event, payload };
  const fields = (["text", "summary", "description", "command", "question", "message"] as const)
    .filter((field) => typeof payload[field] === "string")
    .sort((left, right) => Buffer.byteLength(payload[right] as string) - Buffer.byteLength(payload[left] as string));
  for (const field of fields) {
    const original = payload[field];
    if (typeof original !== "string") continue;
    const points = Array.from(original);
    payload[field] = "";
    let candidate = JSON.stringify(envelope(truncated));
    if (Buffer.byteLength(candidate) > maxBytes) continue;
    let low = 0;
    let high = points.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      payload[field] = points.slice(0, middle).join("");
      candidate = JSON.stringify(envelope(truncated));
      if (Buffer.byteLength(candidate) <= maxBytes) low = middle;
      else high = middle - 1;
    }
    payload[field] = points.slice(0, low).join("");
    return JSON.stringify(envelope(truncated));
  }

  const resync: HermesChatEvent = {
    type: "error",
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    ...(event.profile === undefined ? {} : { profile: event.profile }),
    payload: {
      status: "resync_required",
      message: "A Hermes event exceeded the Office wire budget. Reload session history.",
      originalType: event.type,
      truncated: true,
    },
  };
  const fallback = JSON.stringify(envelope(resync));
  if (Buffer.byteLength(fallback) <= maxBytes) return fallback;
  return JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "error", payload: { status: "resync_required", truncated: true } } });
}
