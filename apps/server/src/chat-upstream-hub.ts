import { createHash, randomUUID } from "node:crypto";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import { HermesChatTransportError } from "./hermes-chat.js";
import type {
  HermesChatConnection,
  HermesChatEvent,
  HermesChatInternalRequestOptions,
  HermesChatRequest,
  HermesChatResult,
} from "./hermes-chat.js";
import {
  ChatSessionCoordinator,
  type ChatSessionLeaseSnapshot,
  type ChatSessionOwner,
} from "./chat-session-coordinator.js";
import {
  estimateTokensFromText,
  type TokenUsageStore,
} from "./usage-stats.js";

const MAX_UNBOUND_SESSIONS = 64;
const MAX_UNBOUND_EVENTS = 128;
const MAX_EVENTS_PER_SESSION = 32;
const MAX_UNBOUND_BYTES = 256 * 1024;
const MAX_PENDING_SESSION_SETTLEMENT_MS = 16_000;
const MAX_CORRELATED_SESSIONS = 256;
const MAX_RECENT_COMPLETED_RUNS = 64;
const MAX_RECENT_TOOL_OCCURRENCES = 128;
const MESSAGE_EVENT_TYPES = new Set(["message.start", "message.delta", "message.interim", "message.complete"]);
const TOOL_EVENT_TYPES = new Set(["tool.start", "tool.generating", "tool.progress", "tool.complete"]);
const OWNED_LIVE_METHODS = new Set<HermesChatRequest["method"]>(["prompt.submit", "session.steer", "session.interrupt", "slash.exec"]);
const OWNED_SESSION_REQUEST_METHODS = new Set<HermesChatRequest["method"]>([
  ...OWNED_LIVE_METHODS, "approval.respond", "clarify.respond",
]);

export interface ChatHubSubscriber {
  onEvent(event: HermesChatEvent): void;
  onUnavailable(liveSessionIds: readonly string[]): void;
}

export interface ChatSessionStartSettlement {
  settle(): void;
}

type PendingSessionStart = { promise: Promise<void>; settle(): void };

type LeaseCloseOperationResult = {
  completed: boolean;
  results: ReadonlyMap<string, HermesChatResult>;
};

type LeaseCloseResult = LeaseCloseOperationResult & {
  joined: boolean;
  targetResult?: HermesChatResult;
};

type BufferedEvents = {
  events: HermesChatEvent[];
  bytes: number;
  dropped: boolean;
};

type ToolOccurrence = {
  id: string;
  runId?: string;
  runSequence?: number;
  upstreamIds: Set<string>;
  name?: string;
  fingerprints: Set<string>;
  sawStart: boolean;
  open: boolean;
  completionFingerprint?: string;
};

type CompletedRun = {
  id: string;
  sequence: number;
  fingerprints: Set<string>;
  sources: Set<string>;
  taskId?: string;
  usedAnonymousMessageIdentity: boolean;
};

type SessionEventCorrelation = {
  activeRunId?: string;
  activeRunSequence?: number;
  activeRunObserved?: boolean;
  activeRunSources: Set<string>;
  activeRunTaskId?: string;
  activeRunFingerprints: Set<string>;
  activeRunUsedAnonymousMessageIdentity?: boolean;
  activeRunPreparedByPrompt?: boolean;
  activeRunAnonymousStream?: boolean;
  terminalFenceObserved: boolean;
  completedAnonymousMessageHistory: boolean;
  messageReplayFence: ReplayFence;
  toolReplayFence: ReplayFence;
  completedRuns: CompletedRun[];
  tools: ToolOccurrence[];
};

/** A mutation may have reached Hermes, but Office could not observe its authoritative result. */
export class ChatCommitUnconfirmedError extends Error {
  constructor() {
    super("Hermes mutation commit could not be confirmed.");
    this.name = "ChatCommitUnconfirmedError";
  }
}

/** One process-wide Hermes transport shared by every downstream Chat socket. */
export class ChatUpstreamHub {
  readonly #runtimeSource: HermesRuntimeSource;
  readonly #coordinator: ChatSessionCoordinator;
  readonly #maxEventBytes: number;
  readonly #pendingSessionSettlementMs: number;
  readonly #usage: TokenUsageStore | undefined;
  readonly #subscribers = new Map<ChatSessionOwner, ChatHubSubscriber>();
  readonly #unbound = new Map<string, BufferedEvents>();
  readonly #droppedUnbound = new Set<string>();
  readonly #ownerCleanup = new Map<ChatSessionOwner, Promise<boolean>>();
  readonly #cleanupOperations = new Set<Promise<boolean>>();
  readonly #pendingSessionStarts = new Map<ChatSessionOwner, Set<PendingSessionStart>>();
  readonly #leaseCloseOperations = new Map<symbol, Promise<LeaseCloseOperationResult>>();
  #unboundEventCount = 0;
  #unboundBytes = 0;
  #connection: HermesChatConnection | undefined;
  #connecting: Promise<HermesChatConnection> | undefined;
  #resetting: Promise<void> | undefined;
  #generation = 0;
  readonly #correlationEpoch = randomUUID();
  #eventSequence = 0;
  #runSequence = 0;
  #toolSequence = 0;
  readonly #eventCorrelations = new Map<string, SessionEventCorrelation>();
  #cleanupEpoch = 0;
  #stopping = false;

  constructor(
    runtimeSource: HermesRuntimeSource,
    coordinator: ChatSessionCoordinator,
    maxEventBytes: number,
    options: { pendingSessionSettlementMs?: number; usage?: TokenUsageStore } = {},
  ) {
    this.#runtimeSource = runtimeSource;
    this.#coordinator = coordinator;
    this.#maxEventBytes = Math.max(4_096, maxEventBytes);
    this.#usage = options.usage;
    const settlementMs = options.pendingSessionSettlementMs ?? MAX_PENDING_SESSION_SETTLEMENT_MS;
    this.#pendingSessionSettlementMs = Number.isFinite(settlementMs)
      ? Math.max(1, Math.min(60_000, Math.trunc(settlementMs)))
      : MAX_PENDING_SESSION_SETTLEMENT_MS;
  }

  async attach(owner: ChatSessionOwner, subscriber: ChatHubSubscriber): Promise<void> {
    if (this.#stopping) throw new Error("Chat hub is stopping.");
    this.#subscribers.set(owner, subscriber);
    try {
      while (true) {
        await this.#waitForCleanup();
        const cleanupEpoch = this.#cleanupEpoch;
        await this.#ensureConnection();
        if (this.#cleanupOperations.size === 0 && cleanupEpoch === this.#cleanupEpoch) break;
      }
    }
    catch (error) {
      if (this.#subscribers.get(owner) === subscriber) this.#subscribers.delete(owner);
      throw error;
    }
  }

  detach(owner: ChatSessionOwner): void {
    this.#subscribers.delete(owner);
  }

  async request(
    owner: ChatSessionOwner,
    request: HermesChatRequest,
    internal?: HermesChatInternalRequestOptions,
    authorize?: () => boolean,
  ): Promise<HermesChatResult> {
    if (this.#stopping) throw new Error("Chat hub is stopping.");
    if (request.method === "session.close") {
      throw new Error("Explicit session close requires Office ownership.");
    }
    if (!this.#subscribers.has(owner)) throw new Error("Chat owner is detached.");
    if (OWNED_LIVE_METHODS.has(request.method)) {
      const sessionId = typeof request.params?.session_id === "string" ? request.params.session_id : undefined;
      const leaseToken = sessionId === undefined ? undefined : this.#coordinator.liveLeaseToken(owner, sessionId);
      if (sessionId === undefined || leaseToken === undefined) {
        throw new Error("Hermes live session is not owned by this Office connection.");
      }
      return await this.#requestUnchecked(
        request, internal,
        () => this.#subscribers.has(owner) && this.#coordinator.ownsLiveLease(owner, sessionId, leaseToken)
          && (authorize?.() ?? true),
      );
    }
    return await this.#requestUnchecked(
      request, internal,
      () => this.#subscribers.has(owner) && (authorize?.() ?? true),
    );
  }

  beginSessionStart(owner: ChatSessionOwner): ChatSessionStartSettlement {
    if (!this.#subscribers.has(owner)) throw new Error("Chat owner is detached.");
    let resolve!: () => void;
    let settled = false;
    const promise = new Promise<void>((done) => { resolve = done; });
    const starts = this.#pendingSessionStarts.get(owner) ?? new Set<PendingSessionStart>();
    const pending: PendingSessionStart = {
      promise,
      settle: () => {
        if (settled) return;
        settled = true;
        starts.delete(pending);
        if (starts.size === 0) this.#pendingSessionStarts.delete(owner);
        resolve();
      },
    };
    starts.add(pending);
    this.#pendingSessionStarts.set(owner, starts);
    return pending;
  }

  async requestOwnedSession(
    owner: ChatSessionOwner,
    liveSessionId: string,
    expectedLeaseToken: symbol,
    request: HermesChatRequest,
    authorize?: () => boolean,
    internal?: HermesChatInternalRequestOptions,
  ): Promise<HermesChatResult> {
    if (this.#stopping) throw new Error("Chat hub is stopping.");
    if (!OWNED_SESSION_REQUEST_METHODS.has(request.method)) {
      throw new Error("Hermes method is not allowed on the owned-session request path.");
    }
    if (request.method !== "clarify.respond" && request.params?.session_id !== liveSessionId) {
      throw new Error("Hermes request target does not match its owned live session.");
    }
    if (!this.#subscribers.has(owner)) throw new Error("Chat owner is detached.");
    if (!this.#coordinator.ownsLiveLease(owner, liveSessionId, expectedLeaseToken)) {
      throw new Error("Hermes live session is not owned by this Office connection.");
    }
    const authorizeCommand = (): boolean => this.#subscribers.has(owner)
      && this.#coordinator.ownsLiveLease(owner, liveSessionId, expectedLeaseToken)
      && (authorize?.() ?? true);
    // Once Hermes has received a mutation, close may fence new commands without
    // changing its route. Accept that authoritative ACK only for the exact
    // routing lease; release, reuse, or ownership transfer still fails closed.
    const authorizeSettlement = (): boolean => this.#coordinator.routingLeaseToken(owner, liveSessionId)
      === expectedLeaseToken;
    const steerRun = request.method === "session.steer"
      ? this.#steerRunState(liveSessionId)
      : undefined;
    // Hermes accepts non-empty steer text even after its turn has ended, but
    // that queue has no consumer. Once Office has observed the terminal fence,
    // do not hand the text upstream; the Browser can safely promote it to a new
    // prompt without risking a duplicate commit.
    if (steerRun?.state === "idle") {
      return { method: request.method, value: { status: "turn_ended" } };
    }
    const result = await this.#requestUnchecked(
      request, internal,
      authorizeCommand,
      authorizeSettlement,
    );
    if (request.method === "session.steer" && result.value.status === "turn_ended") {
      // Only the synthetic pre-request branch above proves no upstream side
      // effect. The same status returned after Hermes received steer is commit
      // ambiguous and must never unlock Browser auto-promotion.
      throw new ChatCommitUnconfirmedError();
    }
    // Once steer was handed upstream, a terminal arriving before its ACK does
    // not prove whether Hermes consumed the queue. Preserve the authoritative
    // queued ACK; Browser recovery is allowed only for the pre-send idle case.
    return result;
  }

  async #requestUnchecked(
    request: HermesChatRequest,
    internal?: HermesChatInternalRequestOptions,
    authorize?: () => boolean,
    authorizeSettlement: (() => boolean) | undefined = authorize,
  ): Promise<HermesChatResult> {
    const connection = await this.#ensureConnection();
    if (authorize !== undefined && !authorize()) throw new Error("Hermes live session ownership changed.");
    const generation = this.#generation;
    const promptSessionId = request.method === "prompt.submit" && typeof request.params?.session_id === "string"
      ? request.params.session_id
      : undefined;
    const expectedRunId = promptSessionId === undefined ? undefined : this.#expectPromptRun(promptSessionId);
    try {
      const result = await connection.request(request, internal);
      if (generation !== this.#generation || connection !== this.#connection) {
        if (commitSensitiveRequest(request)) throw new ChatCommitUnconfirmedError();
        throw new Error("Hermes chat generation changed.");
      }
      if (authorizeSettlement !== undefined && OWNED_SESSION_REQUEST_METHODS.has(request.method)
        && !authorizeSettlement()) {
        if (commitSensitiveRequest(request)) {
          // Session-local mutations such as steer/slash never start a
          // close-on-disconnect run. Losing the downstream owner must not tear
          // down the process-wide transport used by unrelated conversations.
          if (request.method === "prompt.submit") this.#resetGeneration(generation);
          throw new ChatCommitUnconfirmedError();
        }
        throw new Error("Hermes live session ownership changed.");
      }
      if (promptSessionId !== undefined && expectedRunId !== undefined && typeof result.value.taskId === "string") {
        const state = this.#eventCorrelations.get(promptSessionId);
        if (state?.activeRunId === expectedRunId) state.activeRunTaskId = result.value.taskId;
      }
      this.#observeRequestUsage(request);
      return result;
    } catch (error) {
      if (promptSessionId !== undefined && expectedRunId !== undefined) {
        this.#rollbackExpectedPromptRun(promptSessionId, expectedRunId);
      }
      if ((request.method === "session.create" || request.method === "session.resume")
        && error instanceof HermesChatTransportError && error.code === "timed_out"
        && generation === this.#generation) {
        // A timed-out start is commit-ambiguous: Hermes may have created a
        // close-on-disconnect session whose late live id can no longer be
        // observed. Reset the shared generation so Hermes authoritatively reaps
        // that unknown lease before any client retries.
        try { await connection.close(); } finally { this.#upstreamUnavailable(generation); }
      }
      if (commitSensitiveRequest(request) && commitCouldBeUnconfirmed(request.method, error)) {
        if (request.method === "prompt.submit") {
          // A malformed/ambiguous prompt success can leave a live run active.
          // Reset before reporting ambiguity so all close-on-disconnect runs
          // settle before any replacement resume.
          this.#resetGeneration(generation);
        }
        throw new ChatCommitUnconfirmedError();
      }
      throw error;
    }
  }

  flushLiveSession(liveSessionId: string): void {
    const buffered = this.#takeBuffered(liveSessionId);
    const owner = this.#coordinator.ownerForLive(liveSessionId);
    if (owner === undefined) return;
    const subscriber = this.#subscribers.get(owner);
    if (subscriber === undefined || buffered === undefined) return;
    if (buffered.dropped) {
      try {
        subscriber.onEvent({
          type: "error", sessionId: liveSessionId,
          payload: { status: "resync_required", message: "Early Hermes events exceeded the Office buffer. Reload session history." },
        });
      } catch { /* One Browser listener cannot break shared upstream routing. */ }
      return;
    }
    for (const event of buffered.events) {
      try { subscriber.onEvent(event); }
      catch { /* Continue delivering the remaining bounded batch. */ }
    }
  }

  discardBufferedSession(liveSessionId: string): void {
    this.#discardBuffered(liveSessionId);
    this.#droppedUnbound.delete(liveSessionId);
    if (this.#coordinator.ownerForLive(liveSessionId) === undefined) {
      this.#eventCorrelations.delete(liveSessionId);
    }
  }

  closeOwnerSessions(owner: ChatSessionOwner): Promise<boolean> {
    const previous = this.#ownerCleanup.get(owner);
    this.#cleanupEpoch += 1;
    let operation: Promise<boolean>;
    operation = (async () => {
      if (previous !== undefined) await previous.catch(() => false);
      if (!await this.#waitForSessionStarts(owner)) {
        // A start that outlives the Hermes request bound has an unknowable live
        // identity. Only this ambiguous fallback terminalizes the shared
        // generation; normal late results settle and are closed owner-locally.
        await this.#resetGeneration(this.#generation);
      } else {
        // The gateway settles only after binding or releasing every claim, so
        // live leases can now be targeted and pre-request claims can be dropped.
        this.#coordinator.releaseUnboundOwnerLeases(owner);
      }
      for (const lease of this.#coordinator.ownedSessionLeases(owner)) {
        const outcome = await this.#closeLease(owner, lease, 2);
        if (!outcome.completed && outcome.joined) {
          // A Browser may disconnect while its explicit close owns the live-ID
          // reservation. Join that authoritative operation first; if it failed
          // after detachment, retry owner cleanup without the stale Browser
          // authorization callback before declaring the shared state ambiguous.
          const unresolved = this.#coordinator.ownedSessionLeases(owner)
            .find((candidate) => candidate.token === lease.token);
          if (unresolved !== undefined) await this.#closeLease(owner, unresolved, 2);
        }
      }
      if (this.#coordinator.ownedSessionLeases(owner).length > 0) {
        await this.#resetGeneration(this.#generation);
      }
      return this.#coordinator.ownedSessionLeases(owner).length === 0;
    })().finally(() => {
      this.#cleanupOperations.delete(operation);
      if (this.#ownerCleanup.get(owner) === operation) this.#ownerCleanup.delete(owner);
    });
    this.#ownerCleanup.set(owner, operation);
    this.#cleanupOperations.add(operation);
    return operation;
  }

  async readStableHistory<T>(read: () => Promise<T>): Promise<T> {
    while (true) {
      await this.#waitForCleanup();
      await this.#resetting;
      if (this.#cleanupOperations.size === 0) break;
    }
    const generation = this.#generation;
    const cleanupEpoch = this.#cleanupEpoch;
    const result = await read();
    if (this.#resetting !== undefined || generation !== this.#generation
      || this.#cleanupOperations.size > 0 || cleanupEpoch !== this.#cleanupEpoch) {
      throw new Error("Hermes chat state changed during history read.");
    }
    return result;
  }

  async #waitForCleanup(): Promise<void> {
    while (this.#cleanupOperations.size > 0) {
      await Promise.allSettled([...this.#cleanupOperations]);
    }
  }

  async #waitForSessionStarts(owner: ChatSessionOwner): Promise<boolean> {
    const pending = [...(this.#pendingSessionStarts.get(owner) ?? [])];
    if (pending.length === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), this.#pendingSessionSettlementMs);
      timer.unref();
    });
    const settled = Promise.all(pending.map((start) => start.promise)).then(() => true);
    const completed = await Promise.race([settled, timedOut]);
    if (timer !== undefined) clearTimeout(timer);
    return completed;
  }

  async closeOwnedSession(
    owner: ChatSessionOwner,
    sessionId: string,
    authorize?: () => boolean,
  ): Promise<HermesChatResult> {
    const lease = this.#coordinator.leaseForSession(owner, sessionId);
    if (lease === undefined) {
      throw new Error("Hermes session is not owned by this Office connection.");
    }
    if (lease.liveSessionIds.length === 0) {
      // A durable-only lease represents create/resume I/O that has not yet
      // returned its authoritative live id. Closing nothing must not release
      // that pending claim or report a synthetic success.
      throw new Error(lease.pending ? "Hermes session identity is still pending." : "Hermes live session is unavailable.");
    }
    const outcome = await this.#closeLease(owner, lease, 2, sessionId, authorize);
    if (!outcome.completed) throw new Error("Hermes session close could not be confirmed.");
    return outcome.targetResult ?? { method: "session.close", value: { closed: true } };
  }

  async closeDuplicateSession(liveSessionId: string): Promise<"closed" | "known"> {
    this.discardBufferedSession(liveSessionId);
    const closeToken = this.#coordinator.claimUnownedLiveClose(liveSessionId);
    if (closeToken === undefined) return "known";
    let generation = this.#generation;
    try {
      const connection = await this.#ensureConnection();
      generation = this.#generation;
      const result = await connection.request({ method: "session.close", params: { session_id: liveSessionId } });
      if (generation !== this.#generation || connection !== this.#connection || typeof result.value.closed !== "boolean") {
        throw new Error("Hermes duplicate session close was not authoritative.");
      }
      this.discardBufferedSession(liveSessionId);
      this.#eventCorrelations.delete(liveSessionId);
      return "closed";
    } catch (error) {
      if (generation === this.#generation) this.#resetGeneration(generation);
      throw error;
    } finally {
      this.#coordinator.finishUnownedLiveClose(liveSessionId, closeToken);
    }
  }

  resetAmbiguousSessionResult(): void {
    this.#resetGeneration(this.#generation);
  }

  async #closeLease(
    owner: ChatSessionOwner,
    lease: ChatSessionLeaseSnapshot,
    maxAttempts: number,
    targetSessionId?: string,
    authorize?: () => boolean,
  ): Promise<LeaseCloseResult> {
    const existing = this.#leaseCloseOperations.get(lease.token);
    if (existing !== undefined) {
      return closeResult(await existing, targetSessionId, true);
    }
    const closeToken = this.#coordinator.claimOwnedLeaseClose(owner, lease);
    if (closeToken === undefined) return { completed: false, results: new Map(), joined: false };
    let operation: Promise<LeaseCloseOperationResult>;
    operation = (async () => {
      const remaining = new Set(lease.liveSessionIds);
      const results = new Map<string, HermesChatResult>();
      for (let attempt = 0; attempt < maxAttempts && remaining.size > 0; attempt += 1) {
        for (const liveId of [...remaining]) {
          this.discardBufferedSession(liveId);
          try {
            const result = await this.#requestUnchecked(
              { method: "session.close", params: { session_id: liveId } }, undefined, authorize,
            );
            if (typeof result.value.closed !== "boolean") continue;
            remaining.delete(liveId);
            results.set(liveId, result);
          } catch { /* Keep the whole lease fail-closed and retry unresolved IDs. */ }
        }
      }
      if (remaining.size > 0) return { completed: false, results };
      this.#coordinator.releaseLease(owner, lease.token);
      for (const liveId of lease.liveSessionIds) {
        this.discardBufferedSession(liveId);
        this.#eventCorrelations.delete(liveId);
      }
      return { completed: true, results };
    })().finally(() => {
      if (this.#leaseCloseOperations.get(lease.token) === operation) {
        this.#leaseCloseOperations.delete(lease.token);
      }
      this.#coordinator.finishOwnedLeaseClose(lease, closeToken);
    });
    this.#leaseCloseOperations.set(lease.token, operation);
    return closeResult(await operation, targetSessionId, false);
  }

  async close(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#generation += 1;
    const connection = this.#connection;
    const resetting = this.#resetting;
    this.#connection = undefined;
    this.#connecting = undefined;
    this.#resetting = undefined;
    this.#clearBuffered();
    try {
      await connection?.close();
      await resetting;
    } finally {
      this.#coordinator.releaseAll();
      this.#subscribers.clear();
    }
  }

  async #ensureConnection(): Promise<HermesChatConnection> {
    if (this.#resetting !== undefined) await this.#resetting;
    if (this.#stopping) throw new Error("Chat hub is stopping.");
    if (this.#connection !== undefined && !this.#connection.closed) return this.#connection;
    if (this.#connection?.closed === true) {
      this.#upstreamUnavailable(this.#generation);
      throw new Error("Hermes chat connection closed.");
    }
    if (this.#connecting !== undefined) return await this.#connecting;
    const generation = ++this.#generation;
    const connecting = (async () => {
      const transport = this.#runtimeSource.chat({ maxEventBytes: this.#maxEventBytes });
      const connection = await transport.connect(
        (event) => this.#routeEvent(generation, event),
        () => this.#upstreamUnavailable(generation),
      );
      if (this.#stopping || generation !== this.#generation) {
        await connection.close();
        throw new Error("Hermes chat generation changed.");
      }
      this.#connection = connection;
      return connection;
    })();
    this.#connecting = connecting;
    try { return await connecting; }
    catch (error) {
      if (!this.#stopping && generation === this.#generation) this.#upstreamUnavailable(generation);
      throw error;
    } finally {
      if (this.#connecting === connecting) this.#connecting = undefined;
    }
  }

  #routeEvent(generation: number, event: HermesChatEvent): void {
    if (this.#stopping || generation !== this.#generation || event.sessionId === undefined) return;
    const correlatedEvent = this.#correlateEvent(generation, event);
    // Count once at the shared choke point (before fan-out or unbound buffering).
    this.#observeEventUsage(correlatedEvent);
    const owner = this.#coordinator.ownerForLive(correlatedEvent.sessionId!);
    if (owner !== undefined) {
      try { this.#subscribers.get(owner)?.onEvent(correlatedEvent); }
      catch { /* One Browser listener cannot break shared upstream routing. */ }
      return;
    }
    this.#bufferUnbound(correlatedEvent.sessionId!, correlatedEvent);
  }

  #correlateEvent(generation: number, event: HermesChatEvent): HermesChatEvent {
    if (event.sessionId === undefined) return event;
    const state = this.#correlationState(event.sessionId);
    const eventSequence = ++this.#eventSequence;
    const upstreamEventId = stringPayload(event.payload, "eventId", "event_id");
    const payload: HermesChatEvent["payload"] = {
      ...event.payload,
      ...(upstreamEventId === undefined ? {} : { upstreamEventId }),
      eventId: `event-${this.#correlationEpoch}-${eventSequence}`,
      correlationEpoch: this.#correlationEpoch,
      eventSequence,
    };

    if (event.type === "error" && event.payload.status !== "resync_required") {
      const taskId = stringPayload(event.payload, "taskId", "task_id");
      const sources = messageSourceIds(event.payload);
      const hasOrigin = sources.length > 0 || taskId !== undefined;
      if (!hasOrigin && state.activeRunId !== undefined && state.completedRuns.length > 0) {
        return resyncRequiredEvent(event, payload, "An error could belong to either the active or a completed run. Reload session history.");
      }
      const candidates = new Map<string, { id: string; sequence: number; active: boolean }>();
      const addCandidate = (id: string | undefined, sequence: number | undefined, active: boolean): void => {
        if (id !== undefined && sequence !== undefined) candidates.set(id, { id, sequence, active });
      };
      if (hasOrigin) {
        if (state.activeRunId !== undefined && (
          (taskId !== undefined && state.activeRunTaskId === taskId)
          || sources.some((source) => state.activeRunSources.has(source))
        )) addCandidate(state.activeRunId, state.activeRunSequence, true);
        for (const run of state.completedRuns) {
          if ((taskId !== undefined && run.taskId === taskId)
            || sources.some((source) => run.sources.has(source))) {
            addCandidate(run.id, run.sequence, false);
          }
        }
      } else if (state.activeRunId !== undefined) {
        addCandidate(state.activeRunId, state.activeRunSequence, true);
      } else if (state.completedRuns.length === 1) {
        const only = state.completedRuns[0]!;
        addCandidate(only.id, only.sequence, false);
      }
      if (candidates.size === 0) {
        return resyncRequiredEvent(event, payload, "An error could not be correlated to an assistant run. Reload session history.");
      }
      if (candidates.size !== 1) {
        return resyncRequiredEvent(event, payload, "Error origins identified conflicting assistant runs. Reload session history.");
      }
      const candidate = candidates.values().next().value!;
      const runId = candidate.id;
      const runSequence = candidate.sequence;
      payload.runId = runId;
      payload.runSequence = runSequence;
      if (candidate.active) {
        state.completedRuns = [
          ...state.completedRuns.filter((run) => run.id !== runId),
          {
            id: runId,
            sequence: runSequence,
            fingerprints: new Set(state.activeRunFingerprints),
            sources: new Set(state.activeRunSources),
            ...(state.activeRunTaskId === undefined ? {} : { taskId: state.activeRunTaskId }),
            usedAnonymousMessageIdentity: state.activeRunUsedAnonymousMessageIdentity === true,
          },
        ].slice(-MAX_RECENT_COMPLETED_RUNS);
        delete state.activeRunId;
        delete state.activeRunSequence;
        delete state.activeRunObserved;
        state.activeRunSources = new Set();
        delete state.activeRunTaskId;
        state.activeRunFingerprints = new Set();
        delete state.activeRunUsedAnonymousMessageIdentity;
        delete state.activeRunPreparedByPrompt;
        delete state.activeRunAnonymousStream;
        state.terminalFenceObserved = true;
      }
    }

    if (MESSAGE_EVENT_TYPES.has(event.type)) {
      const fingerprint = eventFingerprint(event);
      const sources = messageSourceIds(event.payload);
      const preferredSource = sources[0];
      const completedByFingerprint = [...state.completedRuns].reverse()
        .find((run) => run.fingerprints.has(fingerprint));
      const completedBySource = sources.length === 0 ? undefined : [...state.completedRuns].reverse()
        .find((run) => sources.some((source) => run.sources.has(source)));
      const recentCompleted = completedByFingerprint;
      const seenFingerprint = state.messageReplayFence.has(`frame:${fingerprint}`);
      const seenSource = sources.some((source) => state.messageReplayFence.has(`source:${source}`));
      const seenPreferredSource = preferredSource !== undefined
        && state.messageReplayFence.has(`source:${preferredSource}`);
      const seenAnonymous = sources.length === 0 && state.messageReplayFence.has("anonymous");
      const replayKeys = [
        `frame:${fingerprint}`,
        ...(sources.length === 0 ? ["anonymous"] : sources.map((source) => `source:${source}`)),
      ];
      if (!state.messageReplayFence.canRecord(replayKeys)) {
        state.messageReplayFence.exhaust();
        return resyncRequiredEvent(
          event,
          payload,
          "The message replay ledger reached its safety limit. Reload session history.",
        );
      }
      const matchesCurrentFingerprint = state.activeRunFingerprints.has(fingerprint);
      const matchesCurrentSource = sources.some((source) => state.activeRunSources.has(source));
      // Hermes 0.19 emits message frames without a message id. A prompt ACK
      // on this same ordered transport is the causal boundary for a fresh
      // anonymous message.start; older anonymous deltas still fail closed.
      const startsExpectedAnonymousRun = event.type === "message.start"
        && sources.length === 0
        && state.activeRunId !== undefined
        && state.activeRunObserved === false
        && state.activeRunPreparedByPrompt === true;
      const continuesExpectedAnonymousRun = event.type !== "message.start"
        && sources.length === 0
        && state.activeRunId !== undefined
        && state.activeRunObserved === true
        && state.activeRunAnonymousStream === true;
      if (state.activeRunId !== undefined
        && state.activeRunObserved === false
        && state.activeRunPreparedByPrompt === true
        && sources.length === 0
        && event.type !== "message.start") {
        return resyncRequiredEvent(
          event,
          payload,
          "An anonymous message frame arrived before the expected run start. Reload session history.",
        );
      }
      if (state.activeRunId !== undefined && state.activeRunObserved !== true
        && !startsExpectedAnonymousRun
        && (recentCompleted !== undefined || seenFingerprint || seenPreferredSource || seenAnonymous)) {
        return resyncRequiredEvent(
          event,
          payload,
          "The first message frame could not be correlated to the new run safely. Reload session history.",
        );
      }
      const startIntroducesUnlinkedIdentity = event.type === "message.start"
        && state.activeRunId !== undefined
        && state.activeRunObserved === true
        && (state.activeRunAnonymousStream === true
          || (sources.length > 0
          ? state.activeRunSources.size > 0 && !matchesCurrentSource
          : (state.activeRunSources.size > 0 || state.activeRunUsedAnonymousMessageIdentity === true)
            && !matchesCurrentFingerprint));
      if (startIntroducesUnlinkedIdentity) {
        return resyncRequiredEvent(
          event,
          payload,
          "A message start introduced an identity unrelated to the active run. Reload session history.",
        );
      }
      if (state.activeRunId !== undefined && state.activeRunObserved === true
        && !continuesExpectedAnonymousRun
        && ((completedByFingerprint !== undefined && !matchesCurrentFingerprint)
          || (completedBySource !== undefined && !matchesCurrentSource)
          || (seenFingerprint && !matchesCurrentFingerprint)
          || (seenSource && !matchesCurrentSource)
          || (sources.length === 0 && state.completedAnonymousMessageHistory && !matchesCurrentFingerprint))) {
        return resyncRequiredEvent(
          event,
          payload,
          "A message frame matched a different completed run. Reload session history.",
        );
      }
      let runId = state.activeRunId;
      let runSequence = state.activeRunSequence;
      let replayedPreviousRun = false;
      if (runId === undefined && recentCompleted !== undefined) {
        runId = recentCompleted.id;
        runSequence = recentCompleted.sequence;
        replayedPreviousRun = true;
      } else if (runId === undefined && (seenFingerprint || seenSource || seenAnonymous)) {
        return resyncRequiredEvent(
          event,
          payload,
          "A message frame matched an older run outside the recent correlation window. Reload session history.",
        );
      }
      if (runId === undefined || runSequence === undefined) {
        const created = this.#newRunIdentity();
        runId = created.id;
        runSequence = created.sequence;
      }
      payload.runId = runId;
      payload.runSequence = runSequence;
      payload.messageOccurrenceId = runId;
      if (replayedPreviousRun) {
        // Preserve an already-prepared prompt run while tagging the delayed
        // frame with the occurrence that originally produced it.
      } else {
        state.activeRunId = runId;
        state.activeRunSequence = runSequence;
        state.activeRunPreparedByPrompt = false;
        // message.start establishes the anonymous stream for the whole run.
        // Do not clear that fact when the first anonymous delta/interim frame
        // arrives, otherwise the next chunk is mistaken for completed
        // anonymous history on every turn after the first.
        state.activeRunAnonymousStream = state.activeRunAnonymousStream === true
          || startsExpectedAnonymousRun;
        state.terminalFenceObserved = false;
        state.activeRunFingerprints.add(fingerprint);
        state.messageReplayFence.record(replayKeys);
        if (sources.length === 0) {
          state.activeRunUsedAnonymousMessageIdentity = true;
        } else {
          for (const source of sources) state.activeRunSources.add(source);
        }
      }
      if (!replayedPreviousRun && event.type === "message.complete") {
        const completedRun: CompletedRun = {
          id: runId,
          sequence: runSequence,
          fingerprints: new Set(state.activeRunFingerprints),
          sources: new Set(state.activeRunSources),
          ...(state.activeRunTaskId === undefined ? {} : { taskId: state.activeRunTaskId }),
          usedAnonymousMessageIdentity: state.activeRunUsedAnonymousMessageIdentity === true,
        };
        state.completedRuns = [
          ...state.completedRuns.filter((run) => run.id !== runId),
          completedRun,
        ].slice(-MAX_RECENT_COMPLETED_RUNS);
        if (completedRun.usedAnonymousMessageIdentity) {
          state.completedAnonymousMessageHistory = true;
        }
        if (state.activeRunId === runId) delete state.activeRunId;
        delete state.activeRunSequence;
        delete state.activeRunObserved;
        state.activeRunSources = new Set();
        delete state.activeRunTaskId;
        state.activeRunFingerprints = new Set();
        delete state.activeRunUsedAnonymousMessageIdentity;
        delete state.activeRunPreparedByPrompt;
        delete state.activeRunAnonymousStream;
        state.terminalFenceObserved = true;
      } else if (!replayedPreviousRun) {
        state.activeRunObserved = true;
      }
    }

    if (TOOL_EVENT_TYPES.has(event.type)) {
      const upstreamIds = toolSourceIds(event.payload);
      const preferredUpstreamId = upstreamIds[0];
      const name = stringPayload(event.payload, "name");
      const fingerprint = eventFingerprint(event);
      const seenFingerprint = state.toolReplayFence.has(`frame:${fingerprint}`);
      const seenUpstreamId = upstreamIds.some((id) => state.toolReplayFence.has(`source:${id}`));
      const seenAnonymous = upstreamIds.length === 0 && state.toolReplayFence.has("anonymous");
      const replayKeys = [
        `frame:${fingerprint}`,
        ...(upstreamIds.length === 0 ? ["anonymous"] : upstreamIds.map((id) => `source:${id}`)),
      ];
      if (!state.toolReplayFence.canRecord(replayKeys)) {
        state.toolReplayFence.exhaust();
        return resyncRequiredEvent(
          event,
          payload,
          "The tool replay ledger reached its safety limit. Reload session history.",
        );
      }
      let occurrence: ToolOccurrence | undefined;
      if (upstreamIds.length > 0) {
        const matching = state.tools.filter((item) => (
          upstreamIds.some((id) => item.upstreamIds.has(id))
        ));
        const preferredMatching = preferredUpstreamId === undefined
          ? []
          : matching.filter((item) => item.upstreamIds.has(preferredUpstreamId));
        // A start's preferred id identifies the occurrence. Secondary aliases
        // may be shared by sequential calls and must not merge a new start into
        // an older call. Later phases may use any known alias.
        const candidates = event.type === "tool.start"
          ? preferredMatching
          : preferredMatching.length > 0 ? preferredMatching : matching;
        const openCandidates = [...candidates].reverse().filter((item) => item.open);
        const completedCandidates = [...candidates].reverse().filter((item) => !item.open);
        if (event.type === "tool.start") {
          const currentOpen = openCandidates.filter((item) => item.runId === state.activeRunId);
          if (currentOpen.length > 1) {
            return resyncRequiredEvent(
              event,
              payload,
              "A tool start matched multiple open occurrences. Reload session history.",
            );
          }
          occurrence = currentOpen[0];
          if (occurrence?.sawStart === true) {
            return resyncRequiredEvent(
              event,
              payload,
              "A repeated tool start could not be distinguished from a concurrent call. Reload session history.",
            );
          }
          const preferredIdSeen = preferredUpstreamId !== undefined
            && state.toolReplayFence.has(`source:${preferredUpstreamId}`);
          if (occurrence === undefined && (seenFingerprint || preferredIdSeen)) {
            return resyncRequiredEvent(
              event,
              payload,
              "A reused tool id could not establish a new occurrence safely. Reload session history.",
            );
          }
        } else {
          if (openCandidates.length > 1) {
            return resyncRequiredEvent(
              event,
              payload,
              "A tool frame matched multiple open occurrences. Reload session history.",
            );
          }
          occurrence = openCandidates[0];
          const openInActiveRun = occurrence === undefined ? state.tools.filter((item) => (
            item.open && item.runId === state.activeRunId
            && toolNamesMayMatch(item.name, name)
          )) : [];
          if (occurrence === undefined && openInActiveRun.length > 1) {
            return resyncRequiredEvent(
              event,
              payload,
              "A tool frame matched multiple open occurrences in the active run. Reload session history.",
            );
          }
          if (occurrence === undefined && completedCandidates.length > 0 && openInActiveRun.length > 0) {
            return resyncRequiredEvent(
              event,
              payload,
              "A tool frame could belong to either the active run or a completed occurrence. Reload session history.",
            );
          }
          if (occurrence === undefined && matching.length === 0 && openInActiveRun.length > 0) {
            return resyncRequiredEvent(
              event,
              payload,
              "A tool frame introduced an unlinked id while a plausible occurrence was open. Reload session history.",
            );
          }
          if (occurrence === undefined && completedCandidates.length === 1) {
            const completed = completedCandidates[0]!;
            if (!completed.fingerprints.has(fingerprint)) {
              return resyncRequiredEvent(
                event,
                payload,
                "A new tool frame reused an id from a completed occurrence. Reload session history.",
              );
            }
            occurrence = completed;
          } else if (occurrence === undefined && completedCandidates.length > 1) {
            const exactReplay = completedCandidates.filter((item) => item.fingerprints.has(fingerprint));
            if (exactReplay.length !== 1) {
              return resyncRequiredEvent(
                event,
                payload,
                "A tool frame matched multiple completed occurrences. Reload session history.",
              );
            }
            occurrence = exactReplay[0];
          }
        }
        if (occurrence === undefined) {
          // A novel preferred id may legitimately reuse a secondary alias
          // (for example a tool definition id shared by sequential calls).
          // Non-start phases cannot establish that distinction on their own.
          if (seenFingerprint || (event.type !== "tool.start" && seenUpstreamId)) {
            return resyncRequiredEvent(
              event,
              payload,
              "A tool frame matched an older occurrence outside the recent correlation window. Reload session history.",
            );
          }
          occurrence = {
            id: `tool-${generation}-${++this.#toolSequence}`,
            ...(state.activeRunId ? { runId: state.activeRunId } : {}),
            ...(state.activeRunSequence === undefined ? {} : { runSequence: state.activeRunSequence }),
            upstreamIds: new Set(upstreamIds),
            ...(name ? { name } : {}),
            fingerprints: new Set([fingerprint]),
            sawStart: event.type === "tool.start",
            open: true,
          };
          state.tools.push(occurrence);
        }
        for (const id of upstreamIds) occurrence.upstreamIds.add(id);
        if (event.type === "tool.start") occurrence.sawStart = true;
      } else if (event.type === "tool.start") {
        const matchingOpen = [...state.tools].reverse().find((item) => (
          item.open && item.upstreamIds.size === 0 && toolNamesMayMatch(item.name, name)
        ));
        const matchingCompleted = [...state.tools].reverse().find((item) => (
          !item.open && item.upstreamIds.size === 0 && toolNamesMayMatch(item.name, name)
        ));
        if (matchingOpen === undefined && seenFingerprint) {
          return resyncRequiredEvent(
            event,
            payload,
            "An anonymous tool start repeated without a stable occurrence id. Reload session history.",
          );
        }
        if (state.activeRunId !== undefined && state.activeRunObserved !== true && matchingCompleted !== undefined) {
          return resyncRequiredEvent(
            event,
            payload,
            "An anonymous tool could not establish a new run safely. Reload session history.",
          );
        }
        if (matchingOpen?.sawStart === true) {
          return {
            type: "error",
            sessionId: event.sessionId,
            ...(event.profile === undefined ? {} : { profile: event.profile }),
            payload: {
              eventId: payload.eventId!,
              status: "resync_required",
              message: "Concurrent anonymous tools cannot be correlated safely. Reload session history.",
              originalType: event.type,
            },
          };
        }
        if (matchingOpen === undefined && matchingCompleted === undefined
          && state.activeRunObserved !== true && seenAnonymous) {
          return resyncRequiredEvent(
            event,
            payload,
            "An anonymous tool frame matched an older occurrence outside the recent correlation window. Reload session history.",
          );
        }
        occurrence = matchingOpen ?? {
          id: `tool-${generation}-${++this.#toolSequence}`,
          ...(state.activeRunId ? { runId: state.activeRunId } : {}),
          ...(state.activeRunSequence === undefined ? {} : { runSequence: state.activeRunSequence }),
          upstreamIds: new Set(),
          ...(name ? { name } : {}),
          fingerprints: new Set([fingerprint]),
          sawStart: true,
          open: true,
        };
        occurrence.sawStart = true;
        if (matchingOpen === undefined) state.tools.push(occurrence);
      } else {
        const open = state.tools.filter((item) => (
          item.open && item.upstreamIds.size === 0 && toolNamesMayMatch(item.name, name)
        ));
        if (open.length > 1) {
          return resyncRequiredEvent(
            event,
            payload,
            "An anonymous tool frame matched multiple open occurrences. Reload session history.",
          );
        }
        occurrence = event.type === "tool.complete" ? open[0] : open.at(-1);
        if (occurrence === undefined && event.type === "tool.complete") {
          occurrence = [...state.tools].reverse().find((item) => item.completionFingerprint === fingerprint);
        }
        if (occurrence === undefined) {
          if (seenFingerprint || seenAnonymous) {
            return resyncRequiredEvent(
              event,
              payload,
              "An anonymous tool frame matched an older occurrence outside the recent correlation window. Reload session history.",
            );
          }
          occurrence = {
            id: `tool-${generation}-${++this.#toolSequence}`,
            ...(state.activeRunId ? { runId: state.activeRunId } : {}),
            ...(state.activeRunSequence === undefined ? {} : { runSequence: state.activeRunSequence }),
            upstreamIds: new Set(),
            ...(name ? { name } : {}),
            fingerprints: new Set([fingerprint]),
            sawStart: false,
            open: true,
          };
          state.tools.push(occurrence);
        }
      }
      if (occurrence.name === undefined && name !== undefined) occurrence.name = name;
      if (occurrence.runId === undefined && occurrence.open) {
        if (state.activeRunId === undefined || state.activeRunSequence === undefined) {
          const created = this.#newRunIdentity();
          state.activeRunId = created.id;
          state.activeRunSequence = created.sequence;
          state.activeRunPreparedByPrompt = false;
          state.activeRunAnonymousStream = false;
          state.terminalFenceObserved = false;
        }
        occurrence.runId = state.activeRunId;
        occurrence.runSequence = state.activeRunSequence;
      }
      if (occurrence.open && occurrence.runId === state.activeRunId
        && seenFingerprint && !occurrence.fingerprints.has(fingerprint)) {
        return resyncRequiredEvent(
          event,
          payload,
          "A tool frame matched a different completed occurrence. Reload session history.",
        );
      }
      if (occurrence.open && occurrence.runId === state.activeRunId) {
        state.activeRunObserved = true;
        state.activeRunPreparedByPrompt = false;
      }
      occurrence.fingerprints.add(fingerprint);
      state.toolReplayFence.record(replayKeys);
      payload.toolOccurrenceId = occurrence.id;
      if (occurrence.runId !== undefined) payload.runId = occurrence.runId;
      if (occurrence.runSequence !== undefined) payload.runSequence = occurrence.runSequence;
      if (event.type === "tool.complete") {
        occurrence.open = false;
        occurrence.completionFingerprint = fingerprint;
      }
      while (state.tools.length > MAX_RECENT_TOOL_OCCURRENCES) {
        const closedIndex = state.tools.findIndex((item) => !item.open);
        if (closedIndex < 0) {
          return {
            type: "error",
            sessionId: event.sessionId,
            ...(event.profile === undefined ? {} : { profile: event.profile }),
            payload: {
              eventId: payload.eventId!,
              status: "resync_required",
              message: "Concurrent tool correlation limit exceeded. Reload session history.",
              originalType: event.type,
            },
          };
        }
        state.tools.splice(closedIndex, 1);
      }
    }
    return { ...event, payload };
  }

  #correlationState(sessionId: string): SessionEventCorrelation {
    const existing = this.#eventCorrelations.get(sessionId);
    if (existing !== undefined) return existing;
    if (this.#eventCorrelations.size >= MAX_CORRELATED_SESSIONS) {
      const evictable = [...this.#eventCorrelations].find(([candidateId, candidate]) => (
        candidate.activeRunId === undefined
        && this.#coordinator.ownerForLive(candidateId) === undefined
        && !this.#unbound.has(candidateId)
      ))?.[0];
      if (evictable !== undefined) this.#eventCorrelations.delete(evictable);
      // If every candidate still owns an undelivered buffer, temporarily grow
      // the map. Forgetting its replay fence would be less safe than exceeding
      // this soft cache target; the unbound buffer limits keep growth bounded.
    }
    const created: SessionEventCorrelation = {
      activeRunSources: new Set(),
      activeRunFingerprints: new Set(),
      activeRunPreparedByPrompt: false,
      activeRunAnonymousStream: false,
      completedAnonymousMessageHistory: false,
      terminalFenceObserved: false,
      messageReplayFence: new ReplayFence(),
      toolReplayFence: new ReplayFence(),
      completedRuns: [],
      tools: [],
    };
    this.#eventCorrelations.set(sessionId, created);
    return created;
  }

  #steerRunState(sessionId: string):
    | { state: "unknown" | "idle" }
    | { state: "active"; runId: string } {
    const correlation = this.#eventCorrelations.get(sessionId);
    if (correlation === undefined) return { state: "unknown" };
    return correlation.activeRunId === undefined
      ? { state: correlation.terminalFenceObserved ? "idle" : "unknown" }
      : { state: "active", runId: correlation.activeRunId };
  }

  #newRunIdentity(): { id: string; sequence: number } {
    const sequence = ++this.#runSequence;
    return { id: `run-${this.#correlationEpoch}-${sequence}`, sequence };
  }

  #expectPromptRun(sessionId: string): string {
    const state = this.#correlationState(sessionId);
    if (state.activeRunUsedAnonymousMessageIdentity === true) {
      state.completedAnonymousMessageHistory = true;
    }
    const run = this.#newRunIdentity();
    state.activeRunId = run.id;
    state.activeRunSequence = run.sequence;
    state.activeRunObserved = false;
    state.activeRunSources = new Set();
    delete state.activeRunTaskId;
    state.activeRunFingerprints = new Set();
    delete state.activeRunUsedAnonymousMessageIdentity;
    state.activeRunPreparedByPrompt = true;
    state.activeRunAnonymousStream = false;
    state.terminalFenceObserved = false;
    return run.id;
  }

  #rollbackExpectedPromptRun(sessionId: string, runId: string): void {
    const state = this.#eventCorrelations.get(sessionId);
    if (state?.activeRunId !== runId || state.activeRunObserved === true) return;
    delete state.activeRunId;
    delete state.activeRunSequence;
    delete state.activeRunObserved;
    state.activeRunSources = new Set();
    delete state.activeRunTaskId;
    state.activeRunFingerprints = new Set();
    delete state.activeRunUsedAnonymousMessageIdentity;
    delete state.activeRunPreparedByPrompt;
    delete state.activeRunAnonymousStream;
  }

  /**
   * Records prompt/steer input size after Hermes acknowledged the request.
   * Never stores message text — only estimated token counts.
   */
  #observeRequestUsage(request: HermesChatRequest): void {
    if (this.#usage === undefined) return;
    try {
      if (request.method !== "prompt.submit" && request.method !== "session.steer") return;
      const text = typeof request.params?.text === "string" ? request.params.text : "";
      if (text.length === 0) return;
      const sessionId = typeof request.params?.session_id === "string" ? request.params.session_id : undefined;
      const profile = (sessionId === undefined ? undefined : this.#coordinator.profileForLive(sessionId)) ?? "default";
      this.#usage.record({
        profile,
        tokensIn: estimateTokensFromText(text),
        estimated: true,
      });
    } catch {
      /* Token stats must never break chat streaming. */
    }
  }

  /**
   * Records assistant output on message.complete. Prefers real token fields
   * from Hermes when present; otherwise estimates from character length.
   */
  #observeEventUsage(event: HermesChatEvent): void {
    if (this.#usage === undefined) return;
    try {
      if (event.type !== "message.complete") return;
      const role = typeof event.payload.role === "string" ? event.payload.role : "assistant";
      if (role === "user" || role === "tool" || role === "system") return;
      const profile = event.profile
        ?? (event.sessionId === undefined ? undefined : this.#coordinator.profileForLive(event.sessionId))
        ?? "default";
      // Prefer real completion/output counts when Hermes supplies them. Input is
      // already approximated on confirmed prompt.submit, so do not also apply
      // real prompt_tokens here (would double-count the same turn).
      const tokensOut = finiteNonNegativeInt(event.payload.tokensOut);
      if (tokensOut !== undefined) {
        this.#usage.record({ profile, tokensOut, estimated: false });
        return;
      }
      const text = typeof event.payload.text === "string" ? event.payload.text : "";
      if (text.length === 0) return;
      this.#usage.record({
        profile,
        tokensOut: estimateTokensFromText(text),
        estimated: true,
      });
    } catch {
      /* Token stats must never break chat streaming. */
    }
  }

  #bufferUnbound(liveSessionId: string, event: HermesChatEvent): void {
    // Once any prefix was evicted, later fragments cannot reconstruct a safe
    // stream. Preserve the tombstone until bind instead of buffering a suffix.
    if (this.#droppedUnbound.has(liveSessionId)) return;
    let buffered = this.#unbound.get(liveSessionId);
    if (buffered === undefined) {
      if (this.#unbound.size >= MAX_UNBOUND_SESSIONS) {
        const oldest = this.#unbound.keys().next().value as string | undefined;
        if (oldest !== undefined) {
          this.#discardBuffered(oldest);
          if (!this.#markDropped(oldest)) return;
        }
      }
      buffered = { events: [], bytes: 0, dropped: false };
      this.#unbound.set(liveSessionId, buffered);
    }
    if (buffered.dropped) return;
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(event)); } catch { bytes = this.#maxEventBytes + 1; }
    if (bytes > this.#maxEventBytes || buffered.events.length >= MAX_EVENTS_PER_SESSION
      || this.#unboundEventCount >= MAX_UNBOUND_EVENTS || this.#unboundBytes + bytes > MAX_UNBOUND_BYTES) {
      this.#unboundEventCount -= buffered.events.length;
      this.#unboundBytes -= buffered.bytes;
      buffered.events = [];
      buffered.bytes = 0;
      buffered.dropped = true;
      return;
    }
    buffered.events.push(event);
    buffered.bytes += bytes;
    this.#unboundEventCount += 1;
    this.#unboundBytes += bytes;
  }

  #takeBuffered(liveSessionId: string): BufferedEvents | undefined {
    const buffered = this.#unbound.get(liveSessionId);
    if (buffered !== undefined) this.#discardBuffered(liveSessionId);
    const wasDropped = this.#droppedUnbound.delete(liveSessionId);
    // Tombstone precedence is defensive: never deliver a partial suffix even
    // if an older process version or race left both representations present.
    return wasDropped ? { events: [], bytes: 0, dropped: true } : buffered;
  }

  #discardBuffered(liveSessionId: string): void {
    const buffered = this.#unbound.get(liveSessionId);
    if (buffered !== undefined) {
      this.#unbound.delete(liveSessionId);
      this.#unboundEventCount -= buffered.events.length;
      this.#unboundBytes -= buffered.bytes;
    }
    if (this.#coordinator.ownerForLive(liveSessionId) === undefined) {
      this.#eventCorrelations.delete(liveSessionId);
    }
  }

  #clearBuffered(): void {
    this.#unbound.clear();
    this.#droppedUnbound.clear();
    this.#unboundEventCount = 0;
    this.#unboundBytes = 0;
  }

  #markDropped(liveSessionId: string): boolean {
    if (this.#droppedUnbound.has(liveSessionId)) return true;
    if (this.#droppedUnbound.size >= MAX_UNBOUND_SESSIONS * 2) {
      this.#resetGeneration(this.#generation);
      return false;
    }
    this.#droppedUnbound.add(liveSessionId);
    return true;
  }

  #resetGeneration(generation: number): Promise<void> {
    if (this.#resetting !== undefined) return this.#resetting;
    if (this.#stopping || generation !== this.#generation) return Promise.resolve();
    const connection = this.#connection;
    const connecting = this.#connecting;
    this.#upstreamUnavailable(generation);
    let resetting: Promise<void> | undefined;
    resetting = (async () => {
      try {
        if (connection !== undefined) await connection.close();
        else if (connecting !== undefined) {
          try { await connecting; } catch { /* A stale connect closes itself. */ }
        }
      } catch { /* The generation is already terminal and fail-closed. */ }
      finally { if (this.#resetting === resetting) this.#resetting = undefined; }
    })();
    this.#resetting = resetting;
    return resetting;
  }

  #upstreamUnavailable(generation: number): void {
    if (this.#stopping || generation !== this.#generation) return;
    this.#generation += 1;
    this.#connection = undefined;
    this.#connecting = undefined;
    this.#clearBuffered();
    this.#eventCorrelations.clear();
    const affected = new Map<ChatSessionOwner, string[]>();
    for (const owner of this.#subscribers.keys()) affected.set(owner, this.#coordinator.ownedLiveSessionIds(owner));
    this.#coordinator.releaseAll();
    for (const [owner, subscriber] of this.#subscribers) {
      try { subscriber.onUnavailable(affected.get(owner) ?? []); }
      catch { /* Every subscriber still receives an independent terminal signal. */ }
    }
  }
}

const MAX_REPLAY_FENCE_ENTRIES = 16_384;

class ReplayFence {
  readonly #hashes = new Set<string>();
  #exhausted = false;

  has(value: string): boolean {
    return this.#hashes.has(replayFenceHash(value));
  }

  canRecord(values: readonly string[]): boolean {
    if (this.#exhausted) return false;
    const additions = new Set(values.map(replayFenceHash));
    let newEntries = 0;
    for (const hash of additions) {
      if (!this.#hashes.has(hash)) newEntries += 1;
    }
    return this.#hashes.size + newEntries <= MAX_REPLAY_FENCE_ENTRIES;
  }

  record(values: readonly string[]): void {
    for (const value of values) this.#hashes.add(replayFenceHash(value));
  }

  exhaust(): void {
    this.#exhausted = true;
  }
}

function replayFenceHash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function resyncRequiredEvent(
  event: HermesChatEvent,
  payload: HermesChatEvent["payload"],
  message: string,
): HermesChatEvent {
  return {
    type: "error",
    sessionId: event.sessionId!,
    ...(event.profile === undefined ? {} : { profile: event.profile }),
    payload: {
      eventId: payload.eventId!,
      correlationEpoch: payload.correlationEpoch!,
      eventSequence: payload.eventSequence!,
      status: "resync_required",
      message,
      originalType: event.type,
    },
  };
}

function stringPayload(payload: HermesChatEvent["payload"], ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function toolNamesMayMatch(stored: string | undefined, incoming: string | undefined): boolean {
  return stored === undefined || incoming === undefined || stored === incoming;
}

function messageSourceIds(payload: HermesChatEvent["payload"]): string[] {
  const ids = new Set<string>();
  const primary = stringPayload(payload, "messageId", "message_id");
  if (primary !== undefined) ids.add(primary);
  for (const key of ["messageIds", "message_ids"]) {
    const aliases = payload[key];
    if (!Array.isArray(aliases)) continue;
    for (const alias of aliases) {
      if (typeof alias === "string" && alias.length > 0) ids.add(alias);
    }
  }
  return [...ids];
}

function toolSourceIds(payload: HermesChatEvent["payload"]): string[] {
  const ids = new Set<string>();
  const primary = stringPayload(payload, "toolId", "tool_id");
  if (primary !== undefined) ids.add(primary);
  for (const key of ["toolIds", "tool_ids"]) {
    const aliases = payload[key];
    if (!Array.isArray(aliases)) continue;
    for (const alias of aliases) {
      if (typeof alias === "string" && alias.length > 0) ids.add(alias);
    }
  }
  return [...ids];
}

function eventFingerprint(event: HermesChatEvent): string {
  return replayFenceHash(JSON.stringify([
    event.type,
    messageSourceIds(event.payload),
    toolSourceIds(event.payload),
    stringPayload(event.payload, "name"),
    stringPayload(event.payload, "text"),
    stringPayload(event.payload, "summary"),
    stringPayload(event.payload, "status"),
  ]));
}

function commitSensitiveRequest(request: HermesChatRequest): boolean {
  if (request.method === "prompt.submit" || request.method === "session.steer"
    || request.method === "session.interrupt" || request.method === "approval.respond"
    || request.method === "clarify.respond") return true;
  if (request.method !== "slash.exec" || typeof request.params?.command !== "string") return false;
  return /^\/(?:compact|undo|model|reasoning)(?:\s|$)/i.test(request.params.command.trim());
}

function commitCouldBeUnconfirmed(method: HermesChatRequest["method"], error: unknown): boolean {
  if (error instanceof ChatCommitUnconfirmedError) return true;
  if (!(error instanceof HermesChatTransportError)) return true;
  if (error.code === "invalid_request" || error.code === "connection_failed") return false;
  if (error.code !== "backend_rejected" || error.rpcCode === undefined) return true;
  if (method !== "slash.exec") return false;
  return !new Set([-32601, 4001, 4002, 4004, 4007, 4009, 4018, 4090]).has(error.rpcCode);
}

function closeResult(
  operation: LeaseCloseOperationResult,
  targetSessionId: string | undefined,
  joined: boolean,
): LeaseCloseResult {
  const targetResult = targetSessionId === undefined ? undefined : operation.results.get(targetSessionId);
  return {
    ...operation,
    joined,
    ...(targetResult === undefined ? {} : { targetResult }),
  };
}

function finiteNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return undefined;
  return Math.floor(value);
}
