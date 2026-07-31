import { officeInventoryReliability } from "@hermes-studio/protocol";
import type { OfficeSnapshot, OfficeSnapshotRequestIdentity } from "./domain";
import {
  resolveOfficeSynchronization,
  subscribeOfficeSynchronizationRequests,
} from "./office-synchronization";
import {
  MAX_PREOPEN_WEBSOCKET_FAILURES,
  MAX_RECONNECT_ATTEMPTS,
  MAX_SNAPSHOT_RETRIES,
  RECONNECT_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  SNAPSHOT_RETRY_DELAY_MS,
  SNAPSHOT_RETRY_MAX_DELAY_MS,
  errorMessage,
  isHealthResponse,
  isOfficeSnapshot,
  parseEvent,
  shouldRecoverOfficeWebSocket,
  shouldRetrySnapshotFailure,
  toWebSocketUrl,
  type HealthResponse,
  type OfficeApiCallbacks,
  type OfficeApiConnection,
  type OfficeWebSocketLease,
  OfficeDeviceAuthRequiredError,
  OfficeSessionUnavailableError,
} from "./office-api-types";
import {
  beginOfficeSynchronization,
  ensureOfficeSession,
  allocateOfficeConnectionGeneration,
  officeFetchJson,
  studioServerUrl,
  officeSessionRecoveryObservers,
  openOfficeWebSocket,
  recoverOfficeWebSocketAuthentication,
  rejectOfficeSynchronization,
  setAuthRequiredObserver,
} from "./office-api-session";

export function connectOfficeApi(callbacks: OfficeApiCallbacks, configuredServerUrl = studioServerUrl()): OfficeApiConnection {

  const serverUrl = configuredServerUrl.replace(/\/$/, "");
  setAuthRequiredObserver(callbacks.onAuthRequired);
  let stopped = false;
  let connectionGeneration = 0;
  let latestSnapshotRequestGeneration = 0;
  const snapshotRequestsAwaitingSession = new Set<number>();
  let socket: WebSocket | undefined;
  let eventStreamOpening = false;
  let eventStreamAttempt: symbol | undefined;
  let eventStreamAbort: AbortController | undefined;
  let reconnectTimer: number | undefined;
  let refreshTimer: number | undefined;
  let snapshotRetryTimer: number | undefined;
  let snapshotRetryAttempt = 0;
  let reconnectAttempt = 0;
  let socketAuthRevision: number | undefined;
  let socketOpened = false;
  let socketFailedBeforeOpen = false;
  let attemptedRecoveryRevision: number | undefined;
  let preOpenFailureCount = 0;
  let recoverySynchronizationGeneration: number | undefined;
  let recoverySynchronizationRevision: number | undefined;
  let rearmEventsAfterRecovery = false;
  let recoveryEventOpenRevision: number | undefined;
  let recoveryEventOpenGeneration: number | undefined;
  let reportedEventStreamState: "closed" | "connecting" | "open" | undefined;
  const reportRecoveryUnavailable = (message: string) => (callbacks.onRecoveryUnavailable ?? callbacks.onError)(message, serverUrl);
  const reportEventStream = (state: "closed" | "connecting" | "open") => {
    if (reportedEventStreamState === state) return;
    reportedEventStreamState = state;
    callbacks.onEventStream(state);
  };

  const clearSnapshotRetry = () => {
    if (snapshotRetryTimer !== undefined) window.clearTimeout(snapshotRetryTimer);
    snapshotRetryTimer = undefined;
  };

  const scheduleEventReconnect = (minimumDelayMs = 0): boolean => {
    if (stopped || reconnectTimer !== undefined) return true;
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) return false;
    const delay = Math.max(minimumDelayMs, Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_DELAY_MS * (2 ** reconnectAttempt)));
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      void openEvents();
    }, delay);
    return true;
  };

  const stopSocket = () => {
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    reconnectTimer = undefined;
    refreshTimer = undefined;
    const closingSocket = socket;
    socket = undefined;
    eventStreamAbort?.abort();
    eventStreamAbort = undefined;
    eventStreamOpening = false;
    eventStreamAttempt = undefined;
    socketAuthRevision = undefined;
    socketOpened = false;
    socketFailedBeforeOpen = false;
    closingSocket?.close(1000, "Client stopped");
    reportEventStream("closed");
  };

  const isCurrentSnapshotRequest = (identity: OfficeSnapshotRequestIdentity) => !stopped
    && identity.serverUrl === serverUrl
    && identity.connectionGeneration === connectionGeneration
    && identity.requestGeneration === latestSnapshotRequestGeneration;

  const loadSnapshot = async (showConnecting: boolean, expectedConnectionGeneration: number, preserveRuntime = false): Promise<OfficeSnapshotRequestIdentity | undefined> => {
    if (stopped || expectedConnectionGeneration !== connectionGeneration) return undefined;
    const identity: OfficeSnapshotRequestIdentity = {
      serverUrl,
      connectionGeneration: expectedConnectionGeneration,
      requestGeneration: ++latestSnapshotRequestGeneration
    };
    if (showConnecting) callbacks.onConnecting(serverUrl);
    try {
      snapshotRequestsAwaitingSession.add(identity.requestGeneration);
      try { await ensureOfficeSession(serverUrl); } finally { snapshotRequestsAwaitingSession.delete(identity.requestGeneration); }
      const health = await officeFetchJson<HealthResponse>("/api/v1/health", {}, serverUrl);
      if (!isHealthResponse(health)) throw new Error("Studio Server health response is incompatible.");
      const snapshot = await officeFetchJson<OfficeSnapshot>("/api/v1/snapshot", {}, serverUrl);
      if (!isOfficeSnapshot(snapshot)) throw new Error("Studio Server snapshot is incompatible.");
      if (snapshot.capabilities.protocolVersion !== health.protocolVersion) {
        throw new Error("Studio Server protocol versions do not match.");
      }
      if (!isCurrentSnapshotRequest(identity)) return undefined;
      clearSnapshotRetry();
      const inventoryReliable = officeSnapshotInventoryReliable(snapshot);
      if (inventoryReliable) snapshotRetryAttempt = 0;
      callbacks.onSnapshot(snapshot, identity);
      // The server deliberately returns an unavailable/truncated inventory as
      // a valid snapshot so last-known-good UI state is preserved. Treat that
      // as retryable transport state; otherwise a cold-start timeout leaves
      // the desktop app degraded until it is restarted manually.
      if (!inventoryReliable) scheduleSnapshotRetry(identity.connectionGeneration);
      if (recoverySynchronizationGeneration === identity.connectionGeneration) {
        const synchronizedRevision = recoverySynchronizationRevision;
        const shouldRearmEvents = rearmEventsAfterRecovery;
        recoverySynchronizationGeneration = undefined;
        rearmEventsAfterRecovery = false;
        if (shouldRearmEvents && synchronizedRevision !== undefined) {
          recoveryEventOpenRevision = synchronizedRevision;
          recoveryEventOpenGeneration = identity.connectionGeneration;
          void openEvents();
        }
      }
      return identity;
    } catch (error) {
      if (!isCurrentSnapshotRequest(identity)) return undefined;
      const recoverySnapshotFailed = recoverySynchronizationGeneration === identity.connectionGeneration;
      if (recoverySnapshotFailed) {
        recoverySynchronizationGeneration = undefined;
        if (rearmEventsAfterRecovery) reportEventStream("closed");
        rearmEventsAfterRecovery = false;
        if (recoverySynchronizationRevision !== undefined) rejectOfficeSynchronization(serverUrl, recoverySynchronizationRevision, errorMessage(error));
      }
      if (error instanceof OfficeDeviceAuthRequiredError) {
        callbacks.onAuthRequired?.(serverUrl);
        return undefined;
      }
      const report = preserveRuntime || recoverySnapshotFailed ? callbacks.onRecoveryUnavailable ?? callbacks.onError : callbacks.onError;
      report(errorMessage(error), serverUrl);
      // A post-auth recovery snapshot is the synchronization barrier. Keep its
      // failure visible for an explicit operator retry instead of immediately
      // replacing the LKG state behind an automatic retry.
      if (!recoverySnapshotFailed && shouldRetrySnapshotFailure(error)) {
        scheduleSnapshotRetry(identity.connectionGeneration);
      }
      return undefined;
    }
  };

  const refreshAfterSessionRecovery = (recoveredServerUrl: string, authRevision: number) => {
    if (stopped || recoveredServerUrl !== serverUrl) return;
    const expectedConnectionGeneration = connectionGeneration;
    recoverySynchronizationGeneration = expectedConnectionGeneration;
    recoverySynchronizationRevision = authRevision;
    rearmEventsAfterRecovery = true;
    stopSocket();
    reportEventStream("connecting");
    if (snapshotRequestsAwaitingSession.has(latestSnapshotRequestGeneration)) return;
    void loadSnapshot(false, expectedConnectionGeneration, true);
  };
  officeSessionRecoveryObservers.add(refreshAfterSessionRecovery);
  let unsubscribeSynchronizationRequests = subscribeOfficeSynchronizationRequests(refreshAfterSessionRecovery);

  const scheduleSnapshotRefresh = () => {
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    clearSnapshotRetry();
    const expectedConnectionGeneration = connectionGeneration;
    refreshTimer = window.setTimeout(() => void loadSnapshot(false, expectedConnectionGeneration), 120);
  };

  function scheduleSnapshotRetry(expectedConnectionGeneration: number): void {
    if (stopped || expectedConnectionGeneration !== connectionGeneration || snapshotRetryTimer !== undefined) return;
    if (snapshotRetryAttempt >= MAX_SNAPSHOT_RETRIES) return;
    if (refreshTimer !== undefined) {
      window.clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
    const delay = Math.min(SNAPSHOT_RETRY_MAX_DELAY_MS, SNAPSHOT_RETRY_DELAY_MS * (2 ** snapshotRetryAttempt));
    snapshotRetryAttempt += 1;
    snapshotRetryTimer = window.setTimeout(() => {
      snapshotRetryTimer = undefined;
      void loadSnapshot(false, expectedConnectionGeneration).then((identity) => {
        if (identity && isCurrentSnapshotRequest(identity)) void openEvents();
      });
    }, delay);
  }

  const openEvents = async () => {
    if (stopped || socket || eventStreamOpening) return;
    const attempt = Symbol("event-stream-open");
    const abort = new AbortController();
    eventStreamOpening = true;
    eventStreamAttempt = attempt;
    eventStreamAbort = abort;
    reportEventStream("connecting");
    let lease: OfficeWebSocketLease;
    try {
      lease = await openOfficeWebSocket(toWebSocketUrl(serverUrl), serverUrl, abort.signal);
    } catch (error) {
      if (eventStreamAttempt !== attempt) return;
      eventStreamOpening = false;
      eventStreamAttempt = undefined;
      eventStreamAbort = undefined;
      reportEventStream("closed");
      if (recoveryEventOpenRevision !== undefined) {
        rejectOfficeSynchronization(serverUrl, recoveryEventOpenRevision, errorMessage(error));
        recoveryEventOpenRevision = undefined;
        recoveryEventOpenGeneration = undefined;
        reportRecoveryUnavailable(errorMessage(error));
        return;
      }
      if (error instanceof OfficeDeviceAuthRequiredError) callbacks.onAuthRequired?.(serverUrl);
      else {
        reportRecoveryUnavailable(errorMessage(error));
        if (error instanceof OfficeSessionUnavailableError && !error.retryAutomatically) return;
        const retryAfterMs = error instanceof OfficeSessionUnavailableError ? error.retryAfterMs : 0;
        if (!scheduleEventReconnect(retryAfterMs)) reportRecoveryUnavailable("Studio Serverへ再接続できませんでした。手動で再試行してください。");
      }
      return;
    }
    if (eventStreamAttempt !== attempt) { lease.socket.close(1000, "Superseded connection"); return; }
    eventStreamOpening = false;
    eventStreamAttempt = undefined;
    eventStreamAbort = undefined;
    const nextSocket = lease.socket;
    if (stopped || socket) { nextSocket.close(1000, "Client stopped"); return; }
    socket = nextSocket;
    socketAuthRevision = lease.authRevision;
    socketOpened = false;
    socketFailedBeforeOpen = false;
    const markEventStreamOpen = () => {
      if (socket !== nextSocket || stopped || nextSocket.readyState !== WebSocket.OPEN || socketOpened) return;
      socketOpened = true;
      preOpenFailureCount = 0;
      reconnectAttempt = 0;
      attemptedRecoveryRevision = undefined;
      reportEventStream("open");
      if (recoveryEventOpenRevision !== undefined && recoveryEventOpenGeneration === connectionGeneration) {
        const synchronizedRevision = recoveryEventOpenRevision;
        recoveryEventOpenRevision = undefined;
        recoveryEventOpenGeneration = undefined;
        recoverySynchronizationRevision = undefined;
        resolveOfficeSynchronization(serverUrl, synchronizedRevision);
      }
    };
    nextSocket.addEventListener("open", markEventStreamOpen);
    nextSocket.addEventListener("message", (event) => {
      const message = parseEvent(event.data);
      if (!message) return;
      callbacks.onEvent?.(message);
      if (message.topic === "resync.required" || message.topic.endsWith(".changed") || message.topic === "runtime.status") {
        scheduleSnapshotRefresh();
      }
    });
    nextSocket.addEventListener("close", (event) => {
      if (socket !== nextSocket) return;
      const rejectedRevision = socketAuthRevision;
      const ambiguousPreOpenFailure = !socketOpened && (event.code === 1006 || socketFailedBeforeOpen);
      if (ambiguousPreOpenFailure) preOpenFailureCount += 1;
      const needsAuthentication = shouldRecoverOfficeWebSocket(event, socketOpened, socketFailedBeforeOpen)
        && (!ambiguousPreOpenFailure || preOpenFailureCount === 1);
      socket = undefined;
      socketAuthRevision = undefined;
      socketOpened = false;
      socketFailedBeforeOpen = false;
      reportEventStream("closed");
      if (stopped) return;
      if (!socketOpened && recoveryEventOpenRevision !== undefined) {
        rejectOfficeSynchronization(serverUrl, recoveryEventOpenRevision, "Studio event stream did not open.");
        recoveryEventOpenRevision = undefined;
        recoveryEventOpenGeneration = undefined;
        reportRecoveryUnavailable("Studio event stream did not open.");
        return;
      }
      if (ambiguousPreOpenFailure && preOpenFailureCount >= MAX_PREOPEN_WEBSOCKET_FAILURES) {
        reportRecoveryUnavailable("Studio WebSocketへ接続できませんでした。再接続をお試しください。");
        return;
      }
      if (!needsAuthentication || rejectedRevision === undefined) {
        if (!scheduleEventReconnect()) reportRecoveryUnavailable("Studio WebSocketへ再接続できませんでした。手動で再試行してください。");
        return;
      }
      if (attemptedRecoveryRevision === rejectedRevision) {
        callbacks.onAuthRequired?.(serverUrl);
        return;
      }
      attemptedRecoveryRevision = rejectedRevision;
      const recoveryConnectionGeneration = connectionGeneration;
      void recoverOfficeWebSocketAuthentication(serverUrl, rejectedRevision).then(
        () => {
          if (!stopped && connectionGeneration === recoveryConnectionGeneration
            && recoverySynchronizationGeneration !== recoveryConnectionGeneration
            && !scheduleEventReconnect()) {
            reportRecoveryUnavailable("Studio WebSocketへ再接続できませんでした。手動で再試行してください。");
          }
        },
        (error) => {
          if (stopped || connectionGeneration !== recoveryConnectionGeneration || error instanceof OfficeDeviceAuthRequiredError) return;
          reportRecoveryUnavailable(errorMessage(error));
          if (error instanceof OfficeSessionUnavailableError && !error.retryAutomatically) return;
          const retryAfterMs = error instanceof OfficeSessionUnavailableError ? error.retryAfterMs : 0;
          if (!scheduleEventReconnect(retryAfterMs)) reportRecoveryUnavailable("Studio Serverへ再接続できませんでした。手動で再試行してください。");
        },
      );
    });
    nextSocket.addEventListener("error", () => {
      if (socket !== nextSocket) return;
      socketFailedBeforeOpen = !socketOpened;
      nextSocket.close();
    });
    // Match the chat transport's fast-loopback handling: the upgrade may have
    // completed before listeners were attached.
    if (nextSocket.readyState === WebSocket.OPEN) markEventStreamOpen();
  };

  const start = async () => {
    connectionGeneration = allocateOfficeConnectionGeneration();
    latestSnapshotRequestGeneration = 0;
    clearSnapshotRetry();
    snapshotRetryAttempt = 0;
    reconnectAttempt = 0;
    attemptedRecoveryRevision = undefined;
    preOpenFailureCount = 0;
    stopSocket();
    const synchronizingRecovery = recoverySynchronizationRevision !== undefined;
    if (synchronizingRecovery) {
      beginOfficeSynchronization(serverUrl, recoverySynchronizationRevision!);
      recoverySynchronizationGeneration = connectionGeneration;
      rearmEventsAfterRecovery = true;
      reportEventStream("connecting");
    }
    const identity = await loadSnapshot(true, connectionGeneration, synchronizingRecovery);
    if (identity && isCurrentSnapshotRequest(identity)) void openEvents();
  };

  void start();
  return {
    stop() {
      stopped = true;
      officeSessionRecoveryObservers.delete(refreshAfterSessionRecovery);
      unsubscribeSynchronizationRequests();
      unsubscribeSynchronizationRequests = () => {};
      connectionGeneration = allocateOfficeConnectionGeneration();
      latestSnapshotRequestGeneration = 0;
      recoverySynchronizationGeneration = undefined;
      if (recoverySynchronizationRevision !== undefined) rejectOfficeSynchronization(serverUrl, recoverySynchronizationRevision, "Studio recovery was stopped.");
      recoverySynchronizationRevision = undefined;
      rearmEventsAfterRecovery = false;
      recoveryEventOpenRevision = undefined;
      recoveryEventOpenGeneration = undefined;
      clearSnapshotRetry();
      stopSocket();
    },
    retry() {
      stopped = false;
      officeSessionRecoveryObservers.add(refreshAfterSessionRecovery);
      unsubscribeSynchronizationRequests();
      unsubscribeSynchronizationRequests = subscribeOfficeSynchronizationRequests(refreshAfterSessionRecovery);
      void start();
    },
    async refresh(expected) {
      if (stopped || (expected && (expected.serverUrl !== serverUrl || expected.connectionGeneration !== connectionGeneration))) return undefined;
      return await loadSnapshot(false, connectionGeneration);
    }
  };

}

export function officeSnapshotInventoryReliable(snapshot: Pick<OfficeSnapshot, "inventory">): boolean {
  return officeInventoryReliability(snapshot.inventory.profiles) === "complete"
    && officeInventoryReliability(snapshot.inventory.sessions) === "complete";
}
