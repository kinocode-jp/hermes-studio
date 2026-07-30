import type { ApprovalChoice, ChatMessage } from "./domain";
import {
  officeFetchJson,
  officeServerUrl,
  OfficeDeviceAuthRequiredError,
  OfficeSessionUnavailableError,
  openOfficeWebSocket,
  recoverOfficeWebSocketAuthentication,
  shouldRecoverOfficeWebSocket,
  subscribeOfficeSessionSynchronizations,
  type OfficeWebSocketLease,
} from "./office-api";
import { DEFAULT_CLIENT_HISTORY_LIMITS, HistoryAccumulator, historyCanSatisfyReconnectBarrier, type ChatHistoryResult } from "./history-loader";
import { normalizeHistoryPage } from "./chat-history-page";
import {
  commitUnconfirmedRpcError,
  explicitRpcRejection,
  interruptResultWasAccepted,
  interactionResultWasAccepted,
  isCommitUnconfirmedRpcError,
  isCommitUnconfirmedRpcFrame,
  isExplicitRpcRejection,
  isSessionInUseRpcError,
  isSessionLimitRpcError,
  normalizePromptResult,
  normalizeSteerResult,
  sessionInUseRpcError,
  sessionLimitRpcError,
} from "./chat-rpc-results";

export type { ChatHistoryResult } from "./history-loader";
export { normalizeHistoryPage } from "./chat-history-page";

export type ChatTarget = {
  clientSessionId: string;
  profileId: string;
  storedSessionId?: string;
  model?: string;
  provider?: string;
  /** Hermes session.create reasoning_effort when set. */
  reasoningEffort?: string;
};

export type ChatGatewayEvent = {
  type: string;
  liveSessionId: string;
  payload?: Record<string, unknown>;
};

export type ChatApiCallbacks = {
  onSocketState(state: "disconnected" | "connecting" | "ready" | "error", message?: string): void;
  onHistoryLoading(clientSessionId: string, resetTranscript?: boolean): void;
  onHistory(clientSessionId: string, messages: ChatMessage[], resolvedStoredSessionId?: string, result?: ChatHistoryResult): void;
  onHistoryError(clientSessionId: string, message: string): void;
  onSessionConnecting(clientSessionId: string): void;
  onSessionQueued?(clientSessionId: string): void;
  onSessionReady(clientSessionId: string, liveSessionId: string, storedSessionId?: string, runtime?: ChatSessionRuntime): void;
  onSessionDisconnected(clientSessionId: string): void;
  onSessionError(clientSessionId: string, message: string): void;
  onEvent(clientSessionId: string, event: ChatGatewayEvent): "resync-required" | void;
};

export type ChatSessionRuntime = {
  running?: boolean;
  status?: string;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
};

export type ChatSteerResult =
  | { status: "queued" }
  | { status: "rejected" }
  | { status: "invalid" };

export type ChatPromptResult =
  | { status: "accepted" }
  | { status: "rejected"; message: string }
  | { status: "unconfirmed"; message: string };

export type SlashCompletionItem = { text: string; display: string; meta: string };

export type ChatSlashResult = {
  status: "ok" | "confirm-required";
  output: string;
  warning: string;
  confirmMessage?: string;
  action?: "prefill" | "send";
  message?: string;
  notice?: string;
  key?: "model" | "reasoning";
  value?: string;
};

export type ChatApiConnection = {
  ensureSession(target: ChatTarget): void;
  releaseSession(clientSessionId: string): void;
  submitPrompt(clientSessionId: string, text: string, operationId: string): Promise<ChatPromptResult>;
  steer(clientSessionId: string, text: string): Promise<ChatSteerResult>;
  execSlash(clientSessionId: string, command: string, confirmExpensiveModel?: boolean): Promise<ChatSlashResult>;
  completeSlash(text: string): Promise<SlashCompletionItem[]>;
  interrupt(clientSessionId: string): Promise<void>;
  respondClarify(clientSessionId: string, requestId: string, answer: string): Promise<void>;
  respondApproval(clientSessionId: string, approvalId: string, choice: ApprovalChoice): Promise<void>;
  retry(): void;
  stop(): void;
};

export type ChatApiDependencies = {
  serverUrl?: string;
  createWebSocket?: (url: string) => Promise<WebSocket>;
  openWebSocket?: (url: string, serverUrl: string, signal?: AbortSignal) => Promise<OfficeWebSocketLease>;
  recoverAuthentication?: (serverUrl: string, rejectedAuthRevision: number) => Promise<void>;
  reconnectDelay?: (attempt: number, minimumDelayMs: number) => number;
  fetchJson?: typeof officeFetchJson;
  randomId?: () => string;
  subscribeSessionSynchronizations?: (observer: (serverUrl: string, authRevision: number) => void) => () => void;
};

type JsonRpcResult = {
  session_id?: unknown;
  stored_session_id?: unknown;
  resumed?: unknown;
  liveSessionId?: unknown;
  storedSessionId?: unknown;
  resumedSessionId?: unknown;
  running?: unknown;
  status?: unknown;
  model?: unknown;
  provider?: unknown;
  reasoningEffort?: unknown;
  reasoning_effort?: unknown;
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timeout: ReturnType<typeof setTimeout>;
};

type ActiveTarget = { generation: number; target: ChatTarget };
type LiveTarget = { clientSessionId: string; generation: number };
type QueuedPromptSubmission = {
  text: string;
  operationId: string;
  resolve(result: ChatPromptResult): void;
};

const RPC_TIMEOUT_MS = 15_000;
const SLASH_RPC_TIMEOUT_MS = 185_000;
const HISTORY_TIMEOUT_MS = 10_000;
const RECONNECT_MAX_MS = 8_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const MAX_PREOPEN_WEBSOCKET_FAILURES = 3;
const HISTORY_PAGE_LIMIT = 25;
const MAX_HISTORY_PAGES = DEFAULT_CLIENT_HISTORY_LIMITS.maxPages;
const SESSION_SLOT_RETRY_MS = 750;

export function connectChatApi(callbacks: ChatApiCallbacks, dependencies: ChatApiDependencies = {}): ChatApiConnection {
  const serverUrl = dependencies.serverUrl ?? officeServerUrl();
  const openWebSocket = dependencies.openWebSocket ?? (dependencies.createWebSocket
    ? async (url: string) => ({ socket: await dependencies.createWebSocket!(url), authRevision: 0 })
    : openOfficeWebSocket);
  const recoverAuthentication = dependencies.recoverAuthentication ?? recoverOfficeWebSocketAuthentication;
  const reconnectDelay = dependencies.reconnectDelay ?? ((attempt: number, minimumDelayMs: number) => Math.max(minimumDelayMs, Math.min(RECONNECT_MAX_MS, 800 * (2 ** attempt))));
  const fetchJson = dependencies.fetchJson ?? officeFetchJson;
  const randomId = dependencies.randomId ?? (() => crypto.randomUUID());
  const subscribeSessionSynchronizations = dependencies.subscribeSessionSynchronizations ?? subscribeOfficeSessionSynchronizations;
  const targets = new Map<string, ActiveTarget>();
  const liveToClient = new Map<string, LiveTarget>();
  const pending = new Map<string, PendingRequest>();
  const opening = new Map<string, symbol>();
  const openingSettlements = new Map<string, { operation: symbol; promise: Promise<void>; resolve(): void }>();
  const historyLoads = new Map<string, symbol>();
  const loadedHistories = new Map<string, ActiveTarget>();
  const historiesAwaitingReset = new Set<string>();
  const targetStartOperations = new Map<string, symbol>();
  let nextGeneration = 0;
  let socket: WebSocket | undefined;
  let socketOpening = false;
  let socketOpenAttempt: symbol | undefined;
  let socketOpenAbort: AbortController | undefined;
  let stopped = false;
  let lifecycleGeneration = 0;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let socketAuthRevision: number | undefined;
  let socketOpened = false;
  let gatewayReady = false;
  let socketFailedBeforeOpen = false;
  let attemptedRecoveryRevision: number | undefined;
  let preOpenFailureCount = 0;
  let transportHalted = false;
  let latestSynchronizedAuthRevision = -1;
  let unsubscribeSessionSynchronizations = () => {};
  let closeHandoffTail: Promise<void> = Promise.resolve();
  const pendingTargetStartRetries = new Map<string, ReturnType<typeof setTimeout>>();
  const queuedSessionStarts: string[] = [];
  const pendingQueuedPrompts = new Map<string, QueuedPromptSubmission>();
  let queuedSessionStartTimer: ReturnType<typeof setTimeout> | undefined;

  const rejectPending = (message: string) => {
    for (const request of pending.values()) {
      globalThis.clearTimeout(request.timeout);
      request.reject(new Error(message));
    }
    pending.clear();
  };

  const scheduleReconnect = (minimumDelayMs = 0): boolean => {
    if (stopped || reconnectTimer !== undefined) return true;
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) return false;
    const delay = reconnectDelay(reconnectAttempt, minimumDelayMs);
    reconnectAttempt += 1;
    reconnectTimer = globalThis.setTimeout(() => {
      reconnectTimer = undefined;
      void openSocket();
    }, delay);
    return true;
  };

  const haltTransport = (message: string) => {
    transportHalted = true;
    for (const timer of pendingTargetStartRetries.values()) globalThis.clearTimeout(timer);
    pendingTargetStartRetries.clear();
    callbacks.onSocketState("error", message);
    for (const clientSessionId of targets.keys()) callbacks.onSessionError(clientSessionId, message);
  };

  const handleClose = (event: CloseEvent) => {
    const rejectedRevision = socketAuthRevision;
    const ambiguousPreOpenFailure = !socketOpened && (event.code === 1006 || socketFailedBeforeOpen);
    if (ambiguousPreOpenFailure) preOpenFailureCount += 1;
    const needsAuthentication = shouldRecoverOfficeWebSocket(event, socketOpened, socketFailedBeforeOpen)
      && (!ambiguousPreOpenFailure || preOpenFailureCount === 1);
    const historyResyncRequired = event.reason.includes("reload history");
    socket = undefined;
    socketAuthRevision = undefined;
    socketOpened = false;
    gatewayReady = false;
    socketFailedBeforeOpen = false;
    opening.clear();
    historyLoads.clear();
    targetStartOperations.clear();
    liveToClient.clear();
    // Any unplanned transport loss can happen after Hermes committed work but
    // before the client observed it. Re-establish durable history before resume
    // so an apparently idle replacement socket cannot unlock stale UI state.
    loadedHistories.clear();
    for (const [clientSessionId, active] of targets) {
      if (active.target.storedSessionId) historiesAwaitingReset.add(clientSessionId);
    }
    rejectPending("Chat接続が切断されました。");
    for (const clientSessionId of targets.keys()) callbacks.onSessionDisconnected(clientSessionId);
    callbacks.onSocketState(
      "disconnected",
      stopped ? undefined : historyResyncRequired ? "接続復旧後に履歴を再同期します" : "再接続を待っています",
    );
    if (stopped) return;
    if (ambiguousPreOpenFailure && preOpenFailureCount >= MAX_PREOPEN_WEBSOCKET_FAILURES) {
      haltTransport("Chat WebSocketへ接続できませんでした。手動で再接続してください。");
      return;
    }
    if (!needsAuthentication || rejectedRevision === undefined) {
      if (!scheduleReconnect()) haltTransport("Chat WebSocketへ再接続できませんでした。手動で再接続してください。");
      return;
    }
    if (attemptedRecoveryRevision === rejectedRevision) {
      haltTransport("端末の再認証が必要です。");
      return;
    }
    attemptedRecoveryRevision = rejectedRevision;
    const recoveryGeneration = lifecycleGeneration;
    void recoverAuthentication(serverUrl, rejectedRevision).then(
      () => {
        if (!stopped && lifecycleGeneration === recoveryGeneration && !scheduleReconnect()) {
          haltTransport("Chat Serverへ再接続できませんでした。手動で再接続してください。");
        }
      },
      (error) => {
        if (stopped || lifecycleGeneration !== recoveryGeneration) return;
        if (error instanceof OfficeDeviceAuthRequiredError) { haltTransport("端末の再認証が必要です。"); return; }
        if (error instanceof OfficeSessionUnavailableError && !error.retryAutomatically) { haltTransport(errorText(error)); return; }
        const retryAfterMs = error instanceof OfficeSessionUnavailableError ? error.retryAfterMs : 0;
        if (!scheduleReconnect(retryAfterMs)) haltTransport("Chat Serverへ再接続できませんでした。手動で再接続してください。");
      },
    );
  };

  const handleMessage = (data: unknown, sourceSocket: WebSocket) => {
    if (socket !== sourceSocket) return;
    if (typeof data !== "string") return;
    let frame: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      frame = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    if (frame.method === "office.ready") {
      markGatewayReady();
      return;
    }

    if (frame.method === "event") {
      const params = asRecord(frame.params);
      const liveSessionId = typeof params?.session_id === "string"
        ? params.session_id
        : typeof params?.sessionId === "string" ? params.sessionId : "";
      const type = typeof params?.type === "string" ? params.type : "";
      const liveTarget = liveToClient.get(liveSessionId);
      const active = liveTarget === undefined ? undefined : targets.get(liveTarget.clientSessionId);
      if (!liveTarget || active?.generation !== liveTarget.generation || !type) return;
      const clientSessionId = liveTarget.clientSessionId;
      const payload = asRecord(params?.payload);
      if (type === "error" && payload?.status === "resync_required") {
        if (!historiesAwaitingReset.has(clientSessionId)) {
          beginHistoryBarrier(active, "Hermes event history is incomplete; reload history");
        }
        return;
      }
      const storedSessionId = typeof payload?.stored_session_id === "string"
        ? payload.stored_session_id
        : typeof payload?.storedSessionId === "string" ? payload.storedSessionId : undefined;
      if (storedSessionId) {
        active.target = { ...active.target, storedSessionId };
        if (!historiesAwaitingReset.has(clientSessionId)) callbacks.onSessionReady(clientSessionId, liveSessionId, storedSessionId);
      }
      if (historiesAwaitingReset.has(clientSessionId)) return;
      const result = callbacks.onEvent(clientSessionId, {
        type,
        liveSessionId,
        ...(payload ? { payload } : {})
      });
      if (result === "resync-required" && isCurrentTarget(active)) {
        beginHistoryBarrier(active, "Live transcript safety limit exceeded; reload history");
      }
      return;
    }

    const id = typeof frame.id === "string" || typeof frame.id === "number" ? String(frame.id) : "";
    const request = pending.get(id);
    if (!request) return;
    globalThis.clearTimeout(request.timeout);
    pending.delete(id);
    const error = asRecord(frame.error);
    if (error) {
      const message = error.code === -32006
        ? "このセッションは別の端末で使用中です。別の端末で閉じてから再接続してください。"
        : error.code === -32007
          ? "Live Sessionの実行枠が埋まっています。空き次第、自動で開始します。"
          : typeof error.message === "string" ? error.message : "Chat RPCに失敗しました。";
      request.reject(isCommitUnconfirmedRpcFrame(error)
        ? commitUnconfirmedRpcError(message)
        : error.code === -32006
          ? sessionInUseRpcError(message)
          : error.code === -32007 ? sessionLimitRpcError(message) : explicitRpcRejection(message));
      return;
    }
    request.resolve(frame.result);
  };

  const markGatewayReady = () => {
    if (gatewayReady) return;
    gatewayReady = true;
    callbacks.onSocketState("ready");
    for (const target of targets.values()) startTarget(target);
  };

  const openSocket = async () => {
    if (stopped || socket || socketOpening) return;
    const attempt = Symbol("chat-socket-open");
    const abort = new AbortController();
    socketOpening = true;
    socketOpenAttempt = attempt;
    socketOpenAbort = abort;
    callbacks.onSocketState("connecting");
    let lease: OfficeWebSocketLease;
    try {
      lease = await openWebSocket(chatWebSocketUrl(serverUrl), serverUrl, abort.signal);
    } catch (error) {
      if (socketOpenAttempt !== attempt) return;
      socketOpening = false;
      socketOpenAttempt = undefined;
      socketOpenAbort = undefined;
      if (error instanceof OfficeDeviceAuthRequiredError) haltTransport("端末の再認証が必要です。");
      else {
        callbacks.onSocketState("disconnected", errorText(error));
        if (error instanceof OfficeSessionUnavailableError && !error.retryAutomatically) { haltTransport(errorText(error)); return; }
        const retryAfterMs = error instanceof OfficeSessionUnavailableError ? error.retryAfterMs : 0;
        if (!scheduleReconnect(retryAfterMs)) haltTransport("Chat Serverへ再接続できませんでした。手動で再接続してください。");
      }
      return;
    }
    if (socketOpenAttempt !== attempt) { lease.socket.close(1000, "Superseded connection"); return; }
    socketOpening = false;
    socketOpenAttempt = undefined;
    socketOpenAbort = undefined;
    const nextSocket = lease.socket;
    if (stopped || socket) { nextSocket.close(1000, "Client stopped"); return; }
    socket = nextSocket;
    socketAuthRevision = lease.authRevision;
    socketOpened = false;
    socketFailedBeforeOpen = false;
    const announceReadyForGateway = () => {
      if (socket !== nextSocket || stopped || nextSocket.readyState !== WebSocket.OPEN) return;
      nextSocket.send(JSON.stringify({ jsonrpc: "2.0", method: "office.hello", params: {} }));
    };
    nextSocket.addEventListener("open", () => {
      if (socket !== nextSocket || stopped) return;
      socketOpened = true;
      transportHalted = false;
      preOpenFailureCount = 0;
      reconnectAttempt = 0;
      attemptedRecoveryRevision = undefined;
      announceReadyForGateway();
    });
    nextSocket.addEventListener("message", (event) => handleMessage(event.data, nextSocket));
    nextSocket.addEventListener("close", (event) => {
      if (socket === nextSocket) handleClose(event);
    });
    nextSocket.addEventListener("error", () => {
      if (socket !== nextSocket) return;
      socketFailedBeforeOpen = !socketOpened;
      callbacks.onSocketState("error", "Chat WebSocketへ接続できませんでした。");
      for (const clientSessionId of targets.keys()) callbacks.onSessionError(clientSessionId, "Chat WebSocketへ接続できませんでした。");
      nextSocket.close();
    });
    // On a fast loopback upgrade, `open` can have fired before the listeners
    // above were attached. Announce after installing the message handler so
    // the gateway can resend its readiness signal deterministically.
    if (nextSocket.readyState === WebSocket.OPEN) {
      socketOpened = true;
      transportHalted = false;
      preOpenFailureCount = 0;
      reconnectAttempt = 0;
      attemptedRecoveryRevision = undefined;
      announceReadyForGateway();
    }
  };

  const rpc = (
    method: string,
    params: Record<string, boolean | string>,
    requestId?: string,
    timeoutMs = RPC_TIMEOUT_MS,
  ): Promise<unknown> => {
    const requestSocket = socket;
    if (!requestSocket || requestSocket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Chat接続は準備中です。"));
    const id = requestId ?? randomId();
    return new Promise((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}がタイムアウトしました。`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      try {
        requestSocket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        globalThis.clearTimeout(timeout);
        pending.delete(id);
        reject(error);
      }
    });
  };

  const isSessionStartQueued = (clientSessionId: string): boolean => queuedSessionStarts.includes(clientSessionId);

  const removeQueuedSessionStart = (clientSessionId: string): void => {
    const index = queuedSessionStarts.indexOf(clientSessionId);
    if (index >= 0) queuedSessionStarts.splice(index, 1);
    if (queuedSessionStarts.length === 0 && queuedSessionStartTimer !== undefined) {
      globalThis.clearTimeout(queuedSessionStartTimer);
      queuedSessionStartTimer = undefined;
    }
  };

  const settleQueuedPrompt = (clientSessionId: string, result: ChatPromptResult): void => {
    const submission = pendingQueuedPrompts.get(clientSessionId);
    if (!submission) return;
    pendingQueuedPrompts.delete(clientSessionId);
    submission.resolve(result);
  };

  const scheduleQueuedSessionStart = (delayMs = SESSION_SLOT_RETRY_MS): void => {
    if (stopped || queuedSessionStarts.length === 0) return;
    if (queuedSessionStartTimer !== undefined) {
      if (delayMs > 0) return;
      globalThis.clearTimeout(queuedSessionStartTimer);
      queuedSessionStartTimer = undefined;
    }
    queuedSessionStartTimer = globalThis.setTimeout(() => {
      queuedSessionStartTimer = undefined;
      pumpQueuedSessionStarts();
    }, delayMs);
  };

  const enqueueSessionStart = (active: ActiveTarget): void => {
    const clientSessionId = active.target.clientSessionId;
    if (!isCurrentTarget(active)) return;
    if (!isSessionStartQueued(clientSessionId)) queuedSessionStarts.push(clientSessionId);
    callbacks.onSessionQueued?.(clientSessionId);
    scheduleQueuedSessionStart();
  };

  function pumpQueuedSessionStarts(): void {
    if (stopped || queuedSessionStarts.length === 0) return;
    const clientSessionId = queuedSessionStarts[0]!;
    const active = targets.get(clientSessionId);
    if (!active || liveSessionIdFor(active, liveToClient) !== undefined) {
      removeQueuedSessionStart(clientSessionId);
      scheduleQueuedSessionStart(0);
      return;
    }
    if (transportHalted || !gatewayReady || opening.has(clientSessionId) || targetStartOperations.has(clientSessionId)) {
      scheduleQueuedSessionStart();
      return;
    }
    retryTargetStartWhenReady(active);
    scheduleQueuedSessionStart();
  }

  const openRemoteSession = async (active: ActiveTarget) => {
    await waitForCloseHandoffs();
    const target = active.target;
    const operation = Symbol("open");
    const requestSocket = socket;
    if (!requestSocket || requestSocket.readyState !== WebSocket.OPEN || !isCurrentTarget(active) || opening.has(target.clientSessionId)) return;
    const existingLiveSessionId = liveSessionIdFor(active, liveToClient);
    if (existingLiveSessionId) {
      if (historiesAwaitingReset.has(target.clientSessionId)) return;
      // Live session is already mapped; avoid re-emitting ready which causes UI flicker.
      return;
    }
    opening.set(target.clientSessionId, operation);
    let resolveOpening!: () => void;
    const openingPromise = new Promise<void>((resolve) => { resolveOpening = resolve; });
    const openingSettlement = { operation, promise: openingPromise, resolve: resolveOpening };
    openingSettlements.set(target.clientSessionId, openingSettlement);
    if (!isSessionStartQueued(target.clientSessionId)) callbacks.onSessionConnecting(target.clientSessionId);
    try {
      const raw = target.storedSessionId
        ? await rpc("session.resume", { session_id: target.storedSessionId, profile: target.profileId })
        : await rpc("session.create", {
          profile: target.profileId,
          ...(target.model ? { model: target.model } : {}),
          ...(target.provider ? { provider: target.provider } : {}),
          ...(target.reasoningEffort ? { reasoning_effort: target.reasoningEffort } : {}),
        });
      const envelope = asRecord(raw);
      const result = (asRecord(envelope?.value) ?? envelope) as JsonRpcResult | undefined;
      const liveSessionId = typeof result?.session_id === "string"
        ? result.session_id
        : typeof result?.liveSessionId === "string" ? result.liveSessionId : undefined;
      if (!liveSessionId) throw new Error("HermesがLive Session IDを返しませんでした。");
      if (!isCurrentTarget(active) || socket !== requestSocket) {
        scheduleBestEffortClose(liveSessionId);
        return;
      }
      const storedSessionId = typeof result?.stored_session_id === "string"
        ? result.stored_session_id
        : typeof result?.storedSessionId === "string" ? result.storedSessionId
          : typeof result?.resumed === "string" ? result.resumed
            : typeof result?.resumedSessionId === "string" ? result.resumedSessionId : target.storedSessionId;
      // Preserve the per-session model preferences while attaching the durable
      // Hermes identity. Dropping them makes a later render look like a new
      // target and immediately replaces this live session with another
      // connecting attempt.
      active.target = {
        ...target,
        ...(storedSessionId ? { storedSessionId } : {}),
      };
      liveToClient.set(liveSessionId, { clientSessionId: target.clientSessionId, generation: active.generation });
      const runtime: ChatSessionRuntime = {
        ...(typeof result?.running === "boolean" ? { running: result.running } : {}),
        ...(typeof result?.status === "string" ? { status: result.status } : {}),
        ...(typeof result?.model === "string" ? { model: result.model } : {}),
        ...(typeof result?.provider === "string" ? { provider: result.provider } : {}),
        ...(typeof result?.reasoningEffort === "string"
          ? { reasoningEffort: result.reasoningEffort }
          : typeof result?.reasoning_effort === "string" ? { reasoningEffort: result.reasoning_effort } : {}),
      };
      active.target = {
        ...active.target,
        ...(runtime.model ? { model: runtime.model } : {}),
        ...(runtime.provider ? { provider: runtime.provider } : {}),
        ...(runtime.reasoningEffort ? { reasoningEffort: runtime.reasoningEffort } : {}),
      };
      historiesAwaitingReset.delete(target.clientSessionId);
      const queuedPromptWillStart = pendingQueuedPrompts.has(target.clientSessionId);
      removeQueuedSessionStart(target.clientSessionId);
      callbacks.onSessionReady(
        target.clientSessionId,
        liveSessionId,
        storedSessionId,
        queuedPromptWillStart ? { ...runtime, running: true } : runtime,
      );
      void flushQueuedPrompt(active, liveSessionId);
      scheduleQueuedSessionStart();
    } catch (error) {
      if (isCurrentTarget(active) && socket === requestSocket) {
        if (isSessionLimitRpcError(error)) {
          enqueueSessionStart(active);
          return;
        }
        removeQueuedSessionStart(target.clientSessionId);
        settleQueuedPrompt(target.clientSessionId, { status: "rejected", message: errorText(error) });
        if (historiesAwaitingReset.has(target.clientSessionId) || isSessionInUseRpcError(error)) {
          loadedHistories.delete(target.clientSessionId);
        }
        if (isSessionInUseRpcError(error) && active.target.storedSessionId) {
          historiesAwaitingReset.add(target.clientSessionId);
        }
        callbacks.onSessionError(target.clientSessionId, errorText(error));
      } else if (!stopped && socket === requestSocket && requestSocket.readyState === WebSocket.OPEN
        && !isExplicitRpcRejection(error)) {
        // An evicted start without an authoritative result may still consume a
        // server lease. Fence the transport so reconnect cleanup releases it.
        requestSocket.close(4002, "Session start unconfirmed; reload history");
      }
    } finally {
      if (opening.get(target.clientSessionId) === operation) opening.delete(target.clientSessionId);
      if (openingSettlements.get(target.clientSessionId) === openingSettlement) {
        openingSettlements.delete(target.clientSessionId);
      }
      openingSettlement.resolve();
    }
  };

  const loadHistory = async (active: ActiveTarget) => {
    const target = active.target;
    const operation = Symbol("history");
    if (!isCurrentTarget(active) || loadedHistories.get(target.clientSessionId) === active || historyLoads.has(target.clientSessionId)) return;
    const resetTranscript = historiesAwaitingReset.has(target.clientSessionId);
    if (!target.storedSessionId) {
      if (!isCurrentTarget(active)) return;
      if (resetTranscript) {
        callbacks.onHistoryLoading(target.clientSessionId, true);
        callbacks.onHistoryError(target.clientSessionId, "送信結果を確認するための保存済み履歴IDを取得できませんでした。明示的に再接続してください。");
        return;
      }
      loadedHistories.set(target.clientSessionId, active);
      callbacks.onHistory(target.clientSessionId, []);
      return;
    }
    historyLoads.set(target.clientSessionId, operation);
    callbacks.onHistoryLoading(target.clientSessionId, resetTranscript);
    const history = new HistoryAccumulator();
    let resolvedStoredSessionId: string | undefined;
    try {
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < MAX_HISTORY_PAGES; pageNumber += 1) {
        const query = new URLSearchParams({ profile: target.profileId, limit: String(HISTORY_PAGE_LIMIT) });
        if (cursor !== undefined) query.set("cursor", cursor);
        const body = await fetchJson<unknown>(
          `/api/v1/sessions/${encodeURIComponent(target.storedSessionId)}/messages?${query.toString()}`,
          { timeoutMs: HISTORY_TIMEOUT_MS },
          serverUrl
        );
        if (!isCurrentHistoryLoad(active, operation)) return;
        const page = normalizeHistoryPage(body, target.storedSessionId, pageNumber);
        resolvedStoredSessionId = page.resolvedStoredSessionId ?? resolvedStoredSessionId;
        const shouldContinue = history.append(page);
        if (!shouldContinue) break;
        if (page.nextCursor === undefined || page.messages.length === 0 || pageNumber === MAX_HISTORY_PAGES - 1) throw new Error("保存済み履歴の継続情報が安全上限と一致しません。");
        cursor = page.nextCursor;
      }
      if (!isCurrentHistoryLoad(active, operation)) return;
      if (resolvedStoredSessionId) active.target = { ...active.target, storedSessionId: resolvedStoredSessionId };
      const result = history.result();
      callbacks.onHistory(target.clientSessionId, history.messages, resolvedStoredSessionId, result);
      if (resetTranscript && !historyCanSatisfyReconnectBarrier(result)) {
        callbacks.onHistoryError(target.clientSessionId, "保存済み履歴の完全性を確認できませんでした。明示的に再試行してください。");
        return;
      }
      loadedHistories.set(target.clientSessionId, active);
    } catch (error) {
      if (isCurrentHistoryLoad(active, operation) && history.messages.length > 0) {
        history.fail(errorText(error));
        if (resolvedStoredSessionId) active.target = { ...active.target, storedSessionId: resolvedStoredSessionId };
        callbacks.onHistory(target.clientSessionId, history.messages, resolvedStoredSessionId, history.result());
        if (resetTranscript) {
          // A reconnect barrier cannot be satisfied by a prefix of the durable
          // transcript: the missing suffix may contain the commit whose result
          // became ambiguous when the socket was lost. Preserve the safe prefix
          // for inspection, but require an explicit retry before resume.
          callbacks.onHistoryError(target.clientSessionId, errorText(error));
        } else {
          loadedHistories.set(target.clientSessionId, active);
        }
      } else if (isCurrentHistoryLoad(active, operation)) callbacks.onHistoryError(target.clientSessionId, errorText(error));
    } finally {
      if (historyLoads.get(target.clientSessionId) === operation) historyLoads.delete(target.clientSessionId);
    }
  };

  const isCurrentTarget = (active: ActiveTarget): boolean => targets.get(active.target.clientSessionId) === active;
  const isCurrentHistoryLoad = (active: ActiveTarget, operation: symbol): boolean => (
    isCurrentTarget(active) && historyLoads.get(active.target.clientSessionId) === operation
  );

  const startTarget = (active: ActiveTarget): void => {
    const clientSessionId = active.target.clientSessionId;
    if (targetStartOperations.has(clientSessionId)) return;
    const recovery = Symbol("history-before-live");
    targetStartOperations.set(clientSessionId, recovery);
    void loadHistory(active).then(() => {
      if (!isCurrentTarget(active) || targetStartOperations.get(clientSessionId) !== recovery) return;
      if (loadedHistories.get(clientSessionId) !== active) return;
      void openRemoteSession(active);
    }).finally(() => {
      if (targetStartOperations.get(clientSessionId) === recovery) targetStartOperations.delete(clientSessionId);
    });
  };

  // A fast loopback upgrade can complete before the browser observes the
  // readiness notification. Keep a newly opened chat eligible for one later
  // start attempt instead of leaving it in "connecting" indefinitely.
  const retryTargetStartWhenReady = (active: ActiveTarget): void => {
    const clientSessionId = active.target.clientSessionId;
    if (transportHalted || !isCurrentTarget(active) || liveSessionIdFor(active, liveToClient) !== undefined) return;
    if (gatewayReady) {
      const pendingRetry = pendingTargetStartRetries.get(clientSessionId);
      if (pendingRetry !== undefined) {
        globalThis.clearTimeout(pendingRetry);
        pendingTargetStartRetries.delete(clientSessionId);
      }
      startTarget(active);
      return;
    }
    if (pendingTargetStartRetries.has(clientSessionId)) return;
    const timer = globalThis.setTimeout(() => {
      pendingTargetStartRetries.delete(clientSessionId);
      retryTargetStartWhenReady(active);
    }, 250);
    pendingTargetStartRetries.set(clientSessionId, timer);
  };

  const beginHistoryBarrier = (active: ActiveTarget, closeReason = "Prompt commit unconfirmed; reload history"): void => {
    if (!isCurrentTarget(active)) return;
    const clientSessionId = active.target.clientSessionId;
    loadedHistories.delete(clientSessionId);
    historyLoads.delete(clientSessionId);
    targetStartOperations.delete(clientSessionId);
    historiesAwaitingReset.add(clientSessionId);
    callbacks.onSessionDisconnected(clientSessionId);
    // Browsers reserve the server's 1013 for servers; 4001 is the defensive client close.
    if (socket?.readyState === WebSocket.OPEN) socket.close(4001, closeReason);
  };

  const reloadHistoryAfterSlash = async (active: ActiveTarget): Promise<void> => {
    if (!isCurrentTarget(active) || !active.target.storedSessionId) {
      throw new Error("保存済み履歴を再同期できませんでした。再接続してください。");
    }
    const clientSessionId = active.target.clientSessionId;
    loadedHistories.delete(clientSessionId);
    historiesAwaitingReset.add(clientSessionId);
    await loadHistory(active);
    if (!isCurrentTarget(active) || loadedHistories.get(clientSessionId) !== active) {
      throw new Error("保存済み履歴を再同期できませんでした。再接続してください。");
    }
    historiesAwaitingReset.delete(clientSessionId);
    const liveSessionId = liveSessionIdFor(active, liveToClient);
    if (liveSessionId) callbacks.onSessionReady(clientSessionId, liveSessionId, active.target.storedSessionId);
  };

  const waitForCloseHandoffs = async (): Promise<void> => {
    while (true) {
      const observed = closeHandoffTail;
      await observed;
      if (observed === closeHandoffTail) return;
    }
  };

  const scheduleBestEffortClose = (liveSessionId: string): void => {
    const closeSocket = socket;
    closeHandoffTail = closeHandoffTail.then(async () => {
      if (socket !== closeSocket || closeSocket?.readyState !== WebSocket.OPEN) return;
      try {
        const result = asRecord(await rpc("session.close", { session_id: liveSessionId }));
        if (typeof result?.closed !== "boolean") throw new Error("Hermes returned an invalid close acknowledgement.");
      } catch {
        // A failed close may still own a server lease. Never race a replacement
        // create on this socket; disconnect cleanup is the authoritative fence
        // before the next office.ready.
        if (socket === closeSocket && closeSocket.readyState === WebSocket.OPEN) {
          closeSocket.close(4002, "Session close unconfirmed; reload history");
        }
      } finally {
        scheduleQueuedSessionStart(0);
      }
    });
  };

  const deactivateTarget = (active: ActiveTarget): void => {
    const clientSessionId = active.target.clientSessionId;
    if (!isCurrentTarget(active)) return;
    const openingSettlement = openingSettlements.get(clientSessionId);
    if (openingSettlement !== undefined) {
      closeHandoffTail = closeHandoffTail.then(async () => await openingSettlement.promise);
    }
    targets.delete(clientSessionId);
    removeQueuedSessionStart(clientSessionId);
    settleQueuedPrompt(clientSessionId, { status: "rejected", message: "セッションが閉じられたため、待機中の指示を取り消しました。" });
    const pendingRetry = pendingTargetStartRetries.get(clientSessionId);
    if (pendingRetry !== undefined) globalThis.clearTimeout(pendingRetry);
    pendingTargetStartRetries.delete(clientSessionId);
    opening.delete(clientSessionId);
    historyLoads.delete(clientSessionId);
    loadedHistories.delete(clientSessionId);
    historiesAwaitingReset.delete(clientSessionId);
    targetStartOperations.delete(clientSessionId);
    for (const [liveSessionId, mapped] of liveToClient) {
      if (mapped.clientSessionId !== clientSessionId || mapped.generation !== active.generation) continue;
      liveToClient.delete(liveSessionId);
      scheduleBestEffortClose(liveSessionId);
    }
  };

  const restartTransport = (force: boolean): void => {
    if (!force && !transportHalted) return;
    stopped = false;
    transportHalted = false;
    lifecycleGeneration += 1;
    socketOpenAbort?.abort();
    socketOpenAbort = undefined;
    socketOpenAttempt = undefined;
    socketOpening = false;
    if (reconnectTimer !== undefined) globalThis.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    reconnectAttempt = 0;
    attemptedRecoveryRevision = undefined;
    preOpenFailureCount = 0;
    rejectPending("Chat接続を再試行します。");
    opening.clear();
    for (const timer of pendingTargetStartRetries.values()) globalThis.clearTimeout(timer);
    pendingTargetStartRetries.clear();
    if (force) {
      historyLoads.clear();
      targetStartOperations.clear();
      loadedHistories.clear();
      for (const [clientSessionId, active] of targets) {
        if (active.target.storedSessionId) historiesAwaitingReset.add(clientSessionId);
      }
    }
    liveToClient.clear();
    const closingSocket = socket;
    socket = undefined;
    socketAuthRevision = undefined;
    socketOpened = false;
    gatewayReady = false;
    socketFailedBeforeOpen = false;
    closingSocket?.close();
    void openSocket();
  };

  const submitPromptToLive = async (
    active: ActiveTarget,
    liveSessionId: string,
    text: string,
    operationId: string,
  ): Promise<ChatPromptResult> => {
    const requestSocket = socket;
    const clientSessionId = active.target.clientSessionId;
    if (!isCurrentTarget(active) || historiesAwaitingReset.has(clientSessionId)
      || liveSessionIdFor(active, liveToClient) !== liveSessionId
      || !requestSocket || requestSocket.readyState !== WebSocket.OPEN) {
      return { status: "rejected", message: "Live Sessionが未接続です。" };
    }
    try {
      const raw = await rpc("prompt.submit", { session_id: liveSessionId, text }, operationId);
      const result = normalizePromptResult(raw);
      if (result !== undefined) return result;
      beginHistoryBarrier(active);
      return { status: "unconfirmed", message: "Hermesが不正な送信確認を返しました。保存済み履歴を再確認します。" };
    } catch (error) {
      const message = errorText(error);
      if (!isExplicitRpcRejection(error) && isCurrentTarget(active) && socket === requestSocket) beginHistoryBarrier(active);
      return isExplicitRpcRejection(error)
        ? { status: "rejected", message }
        : { status: "unconfirmed", message };
    }
  };

  const flushQueuedPrompt = async (active: ActiveTarget, liveSessionId: string): Promise<void> => {
    const clientSessionId = active.target.clientSessionId;
    const submission = pendingQueuedPrompts.get(clientSessionId);
    if (!submission) return;
    pendingQueuedPrompts.delete(clientSessionId);
    submission.resolve(await submitPromptToLive(active, liveSessionId, submission.text, submission.operationId));
  };

  unsubscribeSessionSynchronizations = subscribeSessionSynchronizations((recoveredServerUrl, authRevision) => {
    if (stopped || recoveredServerUrl !== serverUrl || authRevision <= latestSynchronizedAuthRevision) return;
    latestSynchronizedAuthRevision = authRevision;
    if (!transportHalted || targets.size === 0
      || (attemptedRecoveryRevision !== undefined && authRevision <= attemptedRecoveryRevision)) return;
    restartTransport(false);
  });

  void openSocket();

  return {
    ensureSession(target) {
      const existing = targets.get(target.clientSessionId);
      if (existing !== undefined && targetsMatch(existing.target, target)) {
        // Already tracking this session. Only revive a halted transport or finish a
        // not-yet-live start. Do not re-enter startTarget when a live session exists,
        // or the UI flaps through connecting/ready on every ensure call.
        restartTransport(false);
        if (liveSessionIdFor(existing, liveToClient) !== undefined) return;
        if (isSessionStartQueued(target.clientSessionId)) {
          scheduleQueuedSessionStart(0);
          return;
        }
        if (
          targetStartOperations.has(target.clientSessionId)
          || opening.has(target.clientSessionId)
          || historyLoads.has(target.clientSessionId)
        ) return;
        retryTargetStartWhenReady(existing);
        return;
      }
      if (existing !== undefined) deactivateTarget(existing);
      const active: ActiveTarget = { generation: ++nextGeneration, target: { ...target } };
      targets.set(target.clientSessionId, active);
      restartTransport(false);
      retryTargetStartWhenReady(active);
    },
    releaseSession(clientSessionId) {
      const active = targets.get(clientSessionId);
      if (active !== undefined) deactivateTarget(active);
    },
    async submitPrompt(clientSessionId, text, operationId) {
      const active = targets.get(clientSessionId);
      const liveSessionId = active === undefined ? undefined : liveSessionIdFor(active, liveToClient);
      if (!active || historiesAwaitingReset.has(clientSessionId)) {
        return { status: "rejected", message: "Live Sessionが未接続です。" };
      }
      if (!liveSessionId) {
        if (!isSessionStartQueued(clientSessionId)) {
          return { status: "rejected", message: "Live Sessionが未接続です。" };
        }
        if (pendingQueuedPrompts.has(clientSessionId)) {
          return { status: "rejected", message: "このセッションには既に待機中の指示があります。" };
        }
        return await new Promise<ChatPromptResult>((resolve) => {
          pendingQueuedPrompts.set(clientSessionId, { text, operationId, resolve });
          enqueueSessionStart(active);
        });
      }
      return await submitPromptToLive(active, liveSessionId, text, operationId);
    },
    async steer(clientSessionId, text) {
      const trimmed = text.trim();
      if (!trimmed) throw new Error("追加指示を入力してください。");
      const active = targets.get(clientSessionId);
      const requestSocket = socket;
      const liveSessionId = active === undefined ? undefined : liveSessionIdFor(active, liveToClient);
      if (!active || historiesAwaitingReset.has(clientSessionId) || !liveSessionId || !requestSocket || requestSocket.readyState !== WebSocket.OPEN) {
        throw new Error("Live Sessionが未接続です。");
      }
      try {
        const raw = await rpc("session.steer", { session_id: liveSessionId, text: trimmed });
        if (!isCurrentTarget(active) || socket !== requestSocket || liveSessionIdFor(active, liveToClient) !== liveSessionId) {
          throw new Error("追加指示の送信先が変更されました。現在のセッションで再試行しないでください。");
        }
        const result = normalizeSteerResult(raw);
        if (result.status === "invalid") {
          throw commitUnconfirmedRpcError("Hermesが不正な追加指示確認を返しました。自動では再送しません。");
        }
        return result;
      } catch (error) {
        // The request has already been handed to the WebSocket here. Only an
        // explicit upstream rejection proves it is safe to retry; timeout,
        // disconnect, target replacement, and malformed success are ambiguous.
        if (isExplicitRpcRejection(error) || isCommitUnconfirmedRpcError(error)) throw error;
        throw commitUnconfirmedRpcError(errorText(error));
      }
    },
    async execSlash(clientSessionId, command, confirmExpensiveModel = false) {
      const trimmed = command.trim();
      if (!trimmed.startsWith("/")) throw new Error("スラッシュコマンドを指定してください。");
      const active = targets.get(clientSessionId);
      const requestSocket = socket;
      const liveSessionId = active === undefined ? undefined : liveSessionIdFor(active, liveToClient);
      if (!active || historiesAwaitingReset.has(clientSessionId) || !liveSessionId || !requestSocket || requestSocket.readyState !== WebSocket.OPEN) {
        throw new Error("Live Sessionが未接続です。");
      }
      try {
        const raw = await rpc("slash.exec", {
          session_id: liveSessionId,
          command: trimmed,
          ...(confirmExpensiveModel ? { confirm_expensive_model: true } : {}),
        }, undefined, chatSlashRpcTimeoutMs(trimmed));
        if (!isCurrentTarget(active) || socket !== requestSocket || liveSessionIdFor(active, liveToClient) !== liveSessionId) {
          throw new Error("スラッシュコマンドの送信先が変更されました。保存済み履歴を再確認します。");
        }
        const record = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
        if (!record || (record.status !== "ok" && record.status !== "confirm_required")) {
          throw new Error("Hermesが不正なスラッシュコマンド結果を返しました。");
        }
        const result: ChatSlashResult = {
          status: record.status === "confirm_required" ? "confirm-required" : "ok",
          output: typeof record.output === "string" ? record.output : "",
          warning: typeof record.warning === "string" ? record.warning : "",
          ...(typeof record.confirmMessage === "string" ? { confirmMessage: record.confirmMessage } : {}),
          ...(record.type === "prefill" || record.type === "send" ? { action: record.type } : {}),
          ...(typeof record.message === "string" ? { message: record.message } : {}),
          ...(typeof record.notice === "string" ? { notice: record.notice } : {}),
          ...(record.key === "model" || record.key === "reasoning" ? { key: record.key } : {}),
          ...(typeof record.value === "string" ? { value: record.value } : {}),
        };
        if (result.status === "ok" && slashMutatesHistory(trimmed)) await reloadHistoryAfterSlash(active);
        return result;
      } catch (error) {
        if (isExplicitRpcRejection(error) || isCommitUnconfirmedRpcError(error) || !slashMutatesSession(trimmed)) {
          throw error;
        }
        if (isCurrentTarget(active) && socket === requestSocket) beginHistoryBarrier(active);
        // The command was already handed to Hermes. Timeout, disconnect,
        // target replacement, malformed success, and history reload failure do
        // not prove that a session mutation was rejected, so never present
        // these outcomes as safe to retry.
        throw commitUnconfirmedRpcError(errorText(error));
      }
    },
    async completeSlash(text) {
      const trimmed = text.trim();
      if (!trimmed.startsWith("/")) return [];
      const requestSocket = socket;
      if (!requestSocket || requestSocket.readyState !== WebSocket.OPEN) return [];
      const raw = await rpc("complete.slash", { text: trimmed });
      const record = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
      if (typeof record.itemsJson !== "string") return [];
      try {
        const parsed = JSON.parse(record.itemsJson) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.flatMap((item) => {
          if (item === null || typeof item !== "object") return [];
          const entry = item as Record<string, unknown>;
          if (typeof entry.text !== "string" || !entry.text.startsWith("/")) return [];
          return [{
            text: entry.text,
            display: typeof entry.display === "string" ? entry.display : entry.text,
            meta: typeof entry.meta === "string" ? entry.meta : "",
          }];
        });
      } catch {
        return [];
      }
    },
    async interrupt(clientSessionId) {
      const active = targets.get(clientSessionId);
      const requestSocket = socket;
      const liveSessionId = active === undefined ? undefined : liveSessionIdFor(active, liveToClient);
      if (!active || historiesAwaitingReset.has(clientSessionId) || !liveSessionId || !requestSocket || requestSocket.readyState !== WebSocket.OPEN) throw new Error("Live Sessionが未接続です。");
      const raw = await rpc("session.interrupt", { session_id: liveSessionId });
      if (!interruptResultWasAccepted(raw)) throw new Error("Hermesが不正な停止確認を返しました。");
      if (!isCurrentTarget(active) || socket !== requestSocket || liveSessionIdFor(active, liveToClient) !== liveSessionId) {
        throw new Error("停止対象のセッションが変更されました。現在の状態を確認してください。");
      }
    },
    async respondClarify(clientSessionId, requestId, answer) {
      const active = targets.get(clientSessionId);
      const requestSocket = socket;
      const liveSessionId = active === undefined ? undefined : liveSessionIdFor(active, liveToClient);
      if (!active || historiesAwaitingReset.has(clientSessionId) || !liveSessionId || !requestSocket || requestSocket.readyState !== WebSocket.OPEN) throw new Error("Live Sessionが未接続です。");
      try {
        const raw = await rpc("clarify.respond", { request_id: requestId, answer });
        if (!interactionResultWasAccepted("clarify.respond", raw)) throw commitUnconfirmedRpcError("Hermesが不正な回答確認を返しました。");
      } catch (error) {
        if (!isExplicitRpcRejection(error) && isCurrentTarget(active) && socket === requestSocket) {
          beginHistoryBarrier(active, "Clarification commit unconfirmed; reload history");
        }
        throw error;
      }
    },
    async respondApproval(clientSessionId, approvalId, choice) {
      const active = targets.get(clientSessionId);
      const requestSocket = socket;
      const liveSessionId = active === undefined ? undefined : liveSessionIdFor(active, liveToClient);
      if (!active || historiesAwaitingReset.has(clientSessionId) || !liveSessionId || !requestSocket || requestSocket.readyState !== WebSocket.OPEN) throw new Error("Live Sessionが未接続です。");
      try {
        const raw = await rpc("approval.respond", { session_id: liveSessionId, approval_id: approvalId, choice });
        if (!interactionResultWasAccepted("approval.respond", raw)) throw commitUnconfirmedRpcError("Hermesが不正な承認確認を返しました。");
      } catch (error) {
        if (!isExplicitRpcRejection(error) && isCurrentTarget(active) && socket === requestSocket) {
          beginHistoryBarrier(active, "Approval commit unconfirmed; reload history");
        }
        throw error;
      }
    },
    retry() {
      restartTransport(true);
    },
    stop() {
      stopped = true;
      unsubscribeSessionSynchronizations();
      unsubscribeSessionSynchronizations = () => {};
      lifecycleGeneration += 1;
      socketOpenAbort?.abort();
      socketOpenAbort = undefined;
      socketOpenAttempt = undefined;
      socketOpening = false;
      if (reconnectTimer !== undefined) globalThis.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      if (queuedSessionStartTimer !== undefined) globalThis.clearTimeout(queuedSessionStartTimer);
      queuedSessionStartTimer = undefined;
      for (const timer of pendingTargetStartRetries.values()) globalThis.clearTimeout(timer);
      pendingTargetStartRetries.clear();
      for (const active of [...targets.values()]) deactivateTarget(active);
      for (const clientSessionId of [...pendingQueuedPrompts.keys()]) {
        settleQueuedPrompt(clientSessionId, { status: "rejected", message: "Chat clientが停止したため、待機中の指示を取り消しました。" });
      }
      rejectPending("Chat client stopped.");
      const closingSocket = socket;
      socket = undefined;
      socketAuthRevision = undefined;
      socketOpened = false;
      gatewayReady = false;
      socketFailedBeforeOpen = false;
      closingSocket?.close(1000, "Client stopped");
      callbacks.onSocketState("disconnected");
    }
  };
}

function chatWebSocketUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/v1/chat";
  url.search = "";
  return url.toString();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function liveSessionIdFor(active: ActiveTarget, liveToClient: Map<string, LiveTarget>): string | undefined {
  return [...liveToClient.entries()].find(([, target]) => (
    target.clientSessionId === active.target.clientSessionId && target.generation === active.generation
  ))?.[0];
}

function targetsMatch(current: ChatTarget, incoming: ChatTarget): boolean {
  return current.clientSessionId === incoming.clientSessionId
    && current.profileId === incoming.profileId
    && (incoming.storedSessionId === undefined || current.storedSessionId === incoming.storedSessionId);
}

function slashMutatesHistory(command: string): boolean {
  return /^\/(?:undo|compact)(?:\s|$)/i.test(command);
}

function slashMutatesSession(command: string): boolean {
  return /^\/(?:undo|compact|model|reasoning)(?:\s|$)/i.test(command);
}

/** Session-mutating slash RPCs share Hermes' 180-second server budget. */
export function chatSlashRpcTimeoutMs(command: string): number {
  return slashMutatesSession(command) ? SLASH_RPC_TIMEOUT_MS : RPC_TIMEOUT_MS;
}

function errorText(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Chat APIがタイムアウトしました。";
  return error instanceof Error ? error.message : "Chat APIに接続できませんでした。";
}
