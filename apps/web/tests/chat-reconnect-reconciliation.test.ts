import assert from "node:assert/strict";
import test from "node:test";
import { connectChatApi, type ChatApiCallbacks } from "../src/chat-api.ts";
import { reconcileChatSessionConnecting, reconcileChatSessionReady } from "../src/chat-session-reconciliation.ts";
import type { ChatSession } from "../src/domain.ts";
import { canSubmitChatPrompt, isChatRunActive } from "../src/session-runtime.ts";
import { MAX_STEER_EVIDENCE_COUNT } from "../src/chat-run-actions.ts";
import {
  applyChatHistory,
  applyChatGatewayEvent,
  interruptSession,
  reduceChatGatewayEvent,
  registerChatRuntime,
  sendMessage,
  sessions,
  setChatHistoryLoading,
  setChatHistoryError,
  setChatSessionConnecting,
  setChatSessionDisconnected,
  setChatSessionError,
  setChatSessionReady
} from "../src/store.ts";

const baseSession: ChatSession = {
  id: "client-1",
  storedSessionId: "stored-1",
  profileId: "coder",
  title: "Reconnect",
  status: "ready",
  messages: [],
  remoteKind: "stored",
  connectionState: "ready",
  historyState: "loaded"
};

test("a new live generation terminalizes old rows while authoritative running resumes the new generation", () => {
  const stale: ChatSession = {
    ...baseSession,
    status: "waiting",
    streamingMessageId: "old-agent",
    pendingInteraction: {
      id: "approval:old",
      kind: "approval",
      approvalId: "old",
      choices: ["once"],
      allowPermanent: false,
      submitting: false
    },
    messages: [{ id: "old-agent", from: "agent", body: "partial", at: "00:00", status: "streaming" }]
  };

  const connecting = reconcileChatSessionConnecting(stale);
  assert.equal(isChatRunActive(connecting), false);
  assert.equal(connecting.pendingInteraction, undefined);
  assert.equal(connecting.messages[0]?.status, "cancelled");

  const running = reconcileChatSessionReady(connecting, "live-new", "stored-1", {
    running: true,
    status: "idle",
    model: "model-a",
    provider: "provider-a",
    reasoningEffort: "medium",
  });
  assert.equal(running.status, "streaming");
  assert.equal(isChatRunActive(running), true);
  assert.equal(canSubmitChatPrompt(running), false);
  assert.equal(running.model, "model-a");
  assert.equal(running.provider, "provider-a");
  assert.equal(running.reasoningEffort, "medium");

  const cold = reconcileChatSessionReady(connecting, "live-new", "stored-1", { running: false, status: "running" });
  assert.equal(cold.status, "ready");
  assert.equal(isChatRunActive(cold), false);
  assert.equal(canSubmitChatPrompt(cold), true);

  const infoRunning = reduceChatGatewayEvent(baseSession, {
    type: "session.info", liveSessionId: "live-new", payload: { running: true, status: "idle", model: "model-b", provider: "provider-b", reasoningEffort: "high" }
  });
  assert.equal(infoRunning.status, baseSession.status);
  assert.equal(infoRunning.model, "model-b");
  assert.equal(infoRunning.provider, "provider-b");
  assert.equal(infoRunning.reasoningEffort, "high");
  const delayedIdle = reduceChatGatewayEvent(infoRunning, {
    type: "session.info", liveSessionId: "live-new", payload: { running: false, status: "idle" }
  });
  assert.equal(delayedIdle, infoRunning);

  const completed = reduceChatGatewayEvent({ ...baseSession, status: "streaming" }, {
    type: "message.complete", liveSessionId: "live-new", payload: { messageId: "done", text: "done" }
  });
  const lateRunning = reduceChatGatewayEvent(completed, {
    type: "session.info", liveSessionId: "live-new", payload: { running: true, status: "running" }
  });
  const finallyIdle = reduceChatGatewayEvent(lateRunning, {
    type: "session.info", liveSessionId: "live-new", payload: { running: false, status: "idle" }
  });
  assert.equal(finallyIdle.status, "ready");
  assert.equal(isChatRunActive(finallyIdle), false);

  const nextRun = reduceChatGatewayEvent(finallyIdle, {
    type: "message.start", liveSessionId: "live-new", payload: { messageId: "next" }
  });
  const oldIdle = reduceChatGatewayEvent(nextRun, {
    type: "session.info", liveSessionId: "live-new", payload: { running: false, status: "idle" }
  });
  assert.equal(oldIdle, nextRun);
  assert.equal(isChatRunActive(oldIdle), true);
});

test("a malformed interrupt acknowledgement preserves the active store run and reports failure", async () => {
  const socket = new FakeWebSocket();
  const api = connectChatApi({
    onSocketState() {}, onHistoryLoading: setChatHistoryLoading, onHistory: applyChatHistory,
    onHistoryError: setChatHistoryError, onSessionConnecting: setChatSessionConnecting,
    onSessionReady: setChatSessionReady, onSessionDisconnected: setChatSessionDisconnected,
    onSessionError: setChatSessionError, onEvent: applyChatGatewayEvent,
  }, {
    serverUrl: "http://127.0.0.1:4317",
    createWebSocket: async () => socket as unknown as WebSocket,
    fetchJson: async <T>() => savedHistory() as T,
  });
  registerChatRuntime(api);
  sessions.value = [{ ...baseSession }];
  api.ensureSession({ clientSessionId: baseSession.id, profileId: baseSession.profileId, storedSessionId: baseSession.storedSessionId });
  await flush();
  socket.open();
  await waitFor(() => socket.frame("session.resume") !== undefined);
  socket.respond(socket.frame("session.resume")!.id, { liveSessionId: "live-stop", storedSessionId: "stored-1", running: true });
  await flush();
  sessions.value = sessions.value.map((session) => ({
    ...session,
    status: "streaming",
    streamingMessageId: "active-agent",
    messages: [...session.messages, { id: "active-agent", from: "agent", body: "working", at: "12:00", status: "streaming" }],
  }));

  const stopping = interruptSession(baseSession.id);
  const interrupt = socket.frame("session.interrupt")!;
  socket.respond(interrupt.id, { status: "accepted" });
  assert.equal(await stopping, false);
  assert.equal(sessions.value[0]?.status, "streaming");
  assert.equal(sessions.value[0]?.streamingMessageId, "active-agent");
  assert.equal(sessions.value[0]?.messages.find(({ id }) => id === "active-agent")?.status, "streaming");
  assert.ok(sessions.value[0]?.errorMessage);
  api.stop();
});

test("prompt start, socket close, and cold resume unlock the composer without replaying the prompt", async () => {
  const sockets: FakeWebSocket[] = [];
  const recoveredHistory = deferred<unknown>();
  let historyRequest = 0;
  let rpcSequence = 0;
  const callbacks: ChatApiCallbacks = {
    onSocketState() {},
    onHistoryLoading: setChatHistoryLoading,
    onHistory: applyChatHistory,
    onHistoryError: setChatHistoryError,
    onSessionConnecting: setChatSessionConnecting,
    onSessionReady: setChatSessionReady,
    onSessionDisconnected: setChatSessionDisconnected,
    onSessionError: setChatSessionError,
    onEvent: applyChatGatewayEvent
  };
  const api = connectChatApi(callbacks, {
    serverUrl: "http://127.0.0.1:4317",
    createWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    fetchJson: async <T>() => {
      historyRequest += 1;
      if (historyRequest === 1) return {
        sessionId: "stored-1", messages: [],
        pagination: { direction: "older", hasMore: false, returned: 0 }
      } as T;
      return await recoveredHistory.promise as T;
    },
    reconnectDelay: () => 0,
    randomId: () => `rpc-${++rpcSequence}`
  });
  registerChatRuntime(api);
  sessions.value = [{ ...baseSession }];
  api.ensureSession({ clientSessionId: baseSession.id, profileId: baseSession.profileId, storedSessionId: baseSession.storedSessionId });

  await waitFor(() => sockets.length === 1);
  const oldSocket = sockets[0]!;
  await flush();
  oldSocket.open();
  await waitFor(() => oldSocket.frame("session.resume") !== undefined);
  const firstResume = oldSocket.frame("session.resume")!;
  oldSocket.respond(firstResume.id, { liveSessionId: "live-old", storedSessionId: "stored-1", running: false, status: "idle" });
  await flush();

  sendMessage(baseSession.id, "first prompt");
  const firstPrompt = oldSocket.frame("prompt.submit")!;
  oldSocket.event("live-old", "message.start", { messageId: "old-agent" });
  oldSocket.event("live-old", "approval.request", { approvalId: "old-approval", choices: ["once"], allowPermanent: false });
  assert.equal(isChatRunActive(sessions.value[0]!), true);
  assert.equal(sessions.value[0]?.pendingInteraction?.id, "approval:old-approval");

  oldSocket.close(1006, "network lost");
  await waitFor(() => sockets.length === 2);
  assert.equal(isChatRunActive(sessions.value[0]!), false);
  assert.equal(sessions.value[0]?.pendingInteraction, undefined);
  assert.equal(sessions.value[0]?.messages.find(({ id }) => id === "old-agent")?.status, "cancelled");
  assert.equal(sessions.value[0]?.operationEvidence?.find(({ body }) => body === "first prompt")?.state, "unconfirmed");

  const newSocket = sockets[1]!;
  await flush();
  newSocket.open();
  await waitFor(() => historyRequest === 2);
  assert.equal(sessions.value[0]?.historyState, "loading");
  assert.equal(canSubmitChatPrompt(sessions.value[0]!), false);
  assert.equal(newSocket.frame("session.resume"), undefined, "resume must wait for authoritative history after any unexpected close");
  recoveredHistory.resolve({
    sessionId: "stored-1",
    messages: [
      { index: 0, role: "user", text: "first prompt", timestamp: "2026-01-01T00:00:00.000Z" },
      { index: 1, role: "assistant", text: "durable response after reconnect", timestamp: "2026-01-01T00:00:01.000Z" },
    ],
    pagination: { direction: "older", hasMore: false, returned: 2 },
  });
  await waitFor(() => newSocket.frame("session.resume") !== undefined);
  assert.equal(sessions.value[0]?.messages.some(({ body }) => body === "durable response after reconnect"), true);
  const coldResume = newSocket.frame("session.resume")!;
  newSocket.respond(coldResume.id, { liveSessionId: "live-new", storedSessionId: "stored-1", running: false, status: "idle" });
  await flush();
  assert.equal(sessions.value[0]?.connectionState, "ready");
  assert.equal(canSubmitChatPrompt(sessions.value[0]!), true);

  sendMessage(baseSession.id, "second prompt");
  const secondPrompt = newSocket.frame("prompt.submit")!;
  newSocket.event("live-new", "message.start", { messageId: "new-agent" });
  assert.equal(isChatRunActive(sessions.value[0]!), true);

  oldSocket.respond(firstPrompt.id, { status: "streaming" });
  oldSocket.event("live-old", "message.complete", { messageId: "old-agent", text: "stale completion" });
  oldSocket.event("live-old", "session.info", { running: false, status: "idle" });
  assert.equal(sessions.value[0]?.streamingMessageId, "new-agent");
  assert.equal(isChatRunActive(sessions.value[0]!), true);
  assert.equal(canSubmitChatPrompt(sessions.value[0]!), false);
  assert.equal(sessions.value[0]?.operationEvidence?.find(({ body }) => body === "first prompt")?.state, "unconfirmed", "a stale response must not promote commit-unknown evidence");
  assert.deepEqual([...oldSocket.frames("prompt.submit"), ...newSocket.frames("prompt.submit")].map(({ params }) => params.text), ["first prompt", "second prompt"]);

  newSocket.respond(secondPrompt.id, { status: "streaming" });
  await flush();
  assert.equal(sessions.value[0]?.operationEvidence?.find(({ body }) => body === "second prompt")?.state, "accepted");
  newSocket.close(1006, "auth synchronized reconnect");
  await waitFor(() => sockets.length === 3);
  const runningSocket = sockets[2]!;
  await flush();
  runningSocket.open();
  await waitFor(() => runningSocket.frame("session.resume") !== undefined);
  const runningResume = runningSocket.frame("session.resume")!;
  runningSocket.respond(runningResume.id, { liveSessionId: "live-running", storedSessionId: "stored-1", running: true, status: "idle" });
  await flush();
  assert.equal(sessions.value[0]?.status, "streaming");
  assert.equal(isChatRunActive(sessions.value[0]!), true);
  assert.equal(canSubmitChatPrompt(sessions.value[0]!), false);
  newSocket.event("live-new", "message.complete", { messageId: "new-agent", text: "stale completion" });
  assert.equal(isChatRunActive(sessions.value[0]!), true);
  assert.equal([...oldSocket.frames("prompt.submit"), ...newSocket.frames("prompt.submit"), ...runningSocket.frames("prompt.submit")].length, 2);
  api.stop();
});

test("commit-unconfirmed on an open socket blocks the composer until an explicit integrity retry succeeds", async () => {
  const sockets: FakeWebSocket[] = [];
  let historyRequest = 0;
  let rpcSequence = 0;
  const callbacks: ChatApiCallbacks = {
    onSocketState() {},
    onHistoryLoading: setChatHistoryLoading,
    onHistory: applyChatHistory,
    onHistoryError: setChatHistoryError,
    onSessionConnecting: setChatSessionConnecting,
    onSessionReady: setChatSessionReady,
    onSessionDisconnected: setChatSessionDisconnected,
    onSessionError: setChatSessionError,
    onEvent: applyChatGatewayEvent,
  };
  const api = connectChatApi(callbacks, {
    serverUrl: "http://127.0.0.1:4317",
    createWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    fetchJson: async <T>() => {
      historyRequest += 1;
      if (historyRequest === 1) return {
        sessionId: "stored-1", messages: [],
        pagination: { direction: "older", hasMore: false, returned: 0 },
      } as T;
      if (historyRequest === 2) return {
        sessionId: "stored-1",
        messages: [{ index: 0, role: "user", text: "maybe once" }],
        pagination: {
          direction: "older", hasMore: false, returned: 2,
          truncated: true, partial: true, truncationReason: "upstream_invalid_rows",
        },
      } as T;
      return {
        sessionId: "stored-1",
        messages: [{ index: 0, role: "user", text: "maybe once" }],
        pagination: { direction: "older", hasMore: false, returned: 1, truncated: false, partial: false },
      } as T;
    },
    reconnectDelay: () => 0,
    randomId: () => `commit-rpc-${++rpcSequence}`,
  });
  registerChatRuntime(api);
  sessions.value = [{ ...baseSession }];
  const target = { clientSessionId: baseSession.id, profileId: baseSession.profileId, storedSessionId: baseSession.storedSessionId };
  api.ensureSession(target);
  await waitFor(() => sockets.length === 1);
  const oldSocket = sockets[0]!;
  await flush();
  oldSocket.open();
  await waitFor(() => oldSocket.frame("session.resume") !== undefined);
  oldSocket.respond(oldSocket.frame("session.resume")!.id, { liveSessionId: "live-open", storedSessionId: "stored-1", running: false });
  await flush();

  sendMessage(baseSession.id, "maybe once");
  const prompt = oldSocket.frame("prompt.submit")!;
  oldSocket.respond(prompt.id, undefined, { code: -32008, message: "commit outcome unknown", data: { reason: "commit_unconfirmed" } });
  await waitFor(() => sockets.length === 2);
  assert.equal(oldSocket.readyState, WebSocket.CLOSED, "an ambiguous live generation is never reused");
  oldSocket.event("live-open", "message.complete", { messageId: "lost-old-event", text: "must stay stale" });
  const recoverySocket = sockets[1]!;
  recoverySocket.open(false);
  await flush();
  assert.equal(historyRequest, 1, "history cannot race ahead of office.ready and Hub cleanup");
  assert.equal(recoverySocket.frame("session.resume"), undefined);
  recoverySocket.officeReady();
  await waitFor(() => sessions.value[0]?.historyState === "error");
  assert.equal(sessions.value[0]?.connectionState, "disconnected", "the API enters the barrier before its result unlocks the store");
  assert.equal(historyRequest, 2);
  assert.equal(canSubmitChatPrompt(sessions.value[0]!), false, "an integrity-partial snapshot cannot unlock the composer");
  assert.equal(sessions.value[0]?.messages.some(({ id }) => id === "lost-old-event"), false);
  assert.equal([...oldSocket.frames("prompt.submit"), ...recoverySocket.frames("prompt.submit")].length, 1, "the ambiguous prompt is never replayed");
  await assert.rejects(api.steer(baseSession.id, "must wait"), /未接続/);
  await assert.rejects(api.interrupt(baseSession.id), /未接続/);
  await assert.rejects(api.respondClarify(baseSession.id, "clarify-1", "must wait"), /未接続/);
  await assert.rejects(api.respondApproval(baseSession.id, "approval-1", "once"), /未接続/);
  assert.equal(recoverySocket.frames("session.steer").length, 0);
  assert.equal(recoverySocket.frames("session.interrupt").length, 0);
  assert.equal(recoverySocket.frames("clarify.respond").length, 0);
  assert.equal(recoverySocket.frames("approval.respond").length, 0);

  api.ensureSession(target);
  await waitFor(() => historyRequest === 3 && recoverySocket.frame("session.resume") !== undefined);
  assert.notEqual(sessions.value[0]?.connectionState, "ready", "durable history alone cannot unlock before authoritative resume runtime");
  assert.equal(canSubmitChatPrompt(sessions.value[0]!), false);
  recoverySocket.respond(recoverySocket.frame("session.resume")!.id, {
    liveSessionId: "live-recovered", storedSessionId: "stored-1", running: false, status: "idle",
  });
  await waitFor(() => sessions.value[0]?.connectionState === "ready");
  assert.equal(canSubmitChatPrompt(sessions.value[0]!), true);
  assert.equal(sessions.value[0]?.operationEvidence?.find(({ body }) => body === "maybe once")?.state, "unconfirmed");
  assert.equal([...oldSocket.frames("prompt.submit"), ...recoverySocket.frames("prompt.submit")].length, 1);
  api.stop();
});

test("an oldest-tail message-limit partial safely satisfies a reconnect barrier", async () => {
  const sockets: FakeWebSocket[] = [];
  let historyRequest = 0;
  const api = connectChatApi(noopCallbacks(), {
    serverUrl: "http://127.0.0.1:4317",
    createWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    fetchJson: async <T>() => {
      historyRequest += 1;
      return {
        sessionId: "stored-limited",
        messages: historyRequest === 1 ? [] : [{ index: 500, role: "assistant", text: "newest retained" }],
        pagination: historyRequest === 1
          ? { direction: "older", hasMore: false, returned: 0 }
          : { direction: "older", hasMore: false, returned: 1, truncated: true, partial: true, truncationReason: "message_limit" },
      } as T;
    },
    reconnectDelay: () => 0,
  });
  const target = { clientSessionId: "limited-client", profileId: "coder", storedSessionId: "stored-limited" };
  api.ensureSession(target);
  await waitFor(() => sockets.length === 1);
  await flush();
  sockets[0]!.open();
  await waitFor(() => sockets[0]!.frame("session.resume") !== undefined);
  sockets[0]!.respond(sockets[0]!.frame("session.resume")!.id, { liveSessionId: "live-limited-old", storedSessionId: "stored-limited" });
  sockets[0]!.close(1006, "reconnect");
  await waitFor(() => sockets.length === 2);
  sockets[1]!.open();
  await waitFor(() => sockets[1]!.frame("session.resume") !== undefined);
  assert.equal(historyRequest, 2);
  api.stop();
});

test("a partial reconnect history cannot satisfy the resume barrier", async () => {
  const sockets: FakeWebSocket[] = [];
  const historyErrors: string[] = [];
  const partialHistories: number[] = [];
  let initialHistory = true;
  let reconnectPage = 0;
  let retryAvailable = false;
  let rpcSequence = 0;
  const callbacks: ChatApiCallbacks = {
    ...noopCallbacks(),
    onHistory(_clientSessionId, messages) { partialHistories.push(messages.length); },
    onHistoryError(_clientSessionId, message) { historyErrors.push(message); },
  };
  const api = connectChatApi(callbacks, {
    serverUrl: "http://127.0.0.1:4317",
    createWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    fetchJson: async <T>() => {
      if (initialHistory) {
        initialHistory = false;
        return { sessionId: "stored-partial", messages: [], pagination: { direction: "older", hasMore: false, returned: 0 } } as T;
      }
      if (!retryAvailable) {
        reconnectPage += 1;
        if (reconnectPage === 1) return {
          sessionId: "stored-partial",
          messages: [{ index: 1, role: "assistant", text: "safe prefix" }],
          pagination: { direction: "older", hasMore: true, nextCursor: "older", returned: 1 },
        } as T;
        throw new Error("older page unavailable");
      }
      return {
        sessionId: "stored-partial",
        messages: [{ index: 2, role: "assistant", text: "authoritative retry" }],
        pagination: { direction: "older", hasMore: false, returned: 1 },
      } as T;
    },
    reconnectDelay: () => 0,
    randomId: () => `partial-rpc-${++rpcSequence}`,
  });
  const target = { clientSessionId: "partial-client", profileId: "coder", storedSessionId: "stored-partial" };
  api.ensureSession(target);
  await waitFor(() => sockets.length === 1);
  await flush();
  sockets[0]!.open();
  await waitFor(() => sockets[0]!.frame("session.resume") !== undefined);
  const initialResume = sockets[0]!.frame("session.resume")!;
  sockets[0]!.respond(initialResume.id, { liveSessionId: "live-partial-old", storedSessionId: "stored-partial", running: false });
  await flush();

  sockets[0]!.close(1006, "network lost");
  await waitFor(() => sockets.length === 2);
  sockets[1]!.open();
  await waitFor(() => historyErrors.length === 1);
  assert.equal(partialHistories.at(-1), 1, "the safe prefix remains inspectable");
  assert.equal(sockets[1]!.frame("session.resume"), undefined, "partial durable history must not unlock resume");

  retryAvailable = true;
  api.ensureSession(target);
  await waitFor(() => sockets[1]!.frame("session.resume") !== undefined);
  assert.equal(partialHistories.at(-1), 1);
  api.stop();
});

test("manual retry with an unresolved prompt reloads history before resume", async () => {
  const sockets: FakeWebSocket[] = [];
  let historyRequests = 0;
  const api = connectChatApi(noopCallbacks(), {
    serverUrl: "http://127.0.0.1:4317",
    createWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    fetchJson: async <T>() => {
      historyRequests += 1;
      return savedHistory() as T;
    },
    reconnectDelay: () => 0,
  });
  const target = { clientSessionId: "manual-retry", profileId: "coder", storedSessionId: "stored-1" };
  api.ensureSession(target);
  await waitFor(() => sockets.length === 1);
  await flush();
  sockets[0]!.open();
  await waitFor(() => sockets[0]!.frame("session.resume") !== undefined);
  sockets[0]!.respond(sockets[0]!.frame("session.resume")!.id, {
    liveSessionId: "live-before-retry", storedSessionId: "stored-1", running: false,
  });
  await flush();

  const prompt = api.submitPrompt(target.clientSessionId, "may commit", "manual-retry-prompt");
  await waitFor(() => sockets[0]!.frame("prompt.submit") !== undefined);
  api.retry();
  assert.equal((await prompt).status, "unconfirmed");
  await waitFor(() => sockets.length === 2);
  await flush();
  sockets[1]!.open();
  await waitFor(() => sockets[1]!.frame("session.resume") !== undefined);
  assert.equal(historyRequests, 2, "manual transport replacement cannot reuse the pre-prompt history cache");
  api.stop();
});

test("initial stored connect coalesces callers and waits for production-shaped history before one resume", async () => {
  const sockets: FakeWebSocket[] = [];
  const initialHistory = deferred<unknown>();
  let rpcSequence = 0;
  const api = connectChatApi(noopCallbacks(), {
    serverUrl: "http://127.0.0.1:4317",
    createWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    fetchJson: async <T>() => await initialHistory.promise as T,
    randomId: () => `initial-rpc-${++rpcSequence}`,
  });
  const target = { clientSessionId: "client-1", profileId: "coder", storedSessionId: "stored-1" };
  api.ensureSession(target);
  api.ensureSession(target);
  api.ensureSession(target);
  await waitFor(() => sockets.length === 1);
  const socket = sockets[0]!;
  await flush();
  socket.open();
  await flush();
  api.ensureSession(target);
  assert.equal(socket.frames("session.resume").length, 0);

  initialHistory.resolve(savedHistory());
  await waitFor(() => socket.frames("session.resume").length === 1);
  assert.equal(socket.frames("session.resume").length, 1);
  api.stop();
});

test("1013 history barrier replaces durable rows, preserves one local steer, and keeps later same-text live messages", async () => {
  const sockets: FakeWebSocket[] = [];
  const resyncHistory = deferred<unknown>();
  const resetSignals: boolean[] = [];
  let historyRequest = 0;
  let rpcSequence = 0;
  const api = connectChatApi({
    onSocketState() {},
    onHistoryLoading(sessionId, resetTranscript) {
      resetSignals.push(resetTranscript === true);
      setChatHistoryLoading(sessionId, resetTranscript);
    },
    onHistory: applyChatHistory,
    onHistoryError() {},
    onSessionConnecting: setChatSessionConnecting,
    onSessionReady: setChatSessionReady,
    onSessionDisconnected: setChatSessionDisconnected,
    onSessionError: setChatSessionError,
    onEvent: applyChatGatewayEvent,
  }, {
    serverUrl: "http://127.0.0.1:4317",
    createWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    fetchJson: async <T>() => {
      historyRequest += 1;
      if (historyRequest === 1) return savedHistory() as T;
      return await resyncHistory.promise as T;
    },
    reconnectDelay: () => 0,
    randomId: () => `resync-rpc-${++rpcSequence}`,
  });
  registerChatRuntime(api);
  sessions.value = [{ ...baseSession, messages: [] }];
  api.ensureSession({ clientSessionId: baseSession.id, profileId: baseSession.profileId, storedSessionId: baseSession.storedSessionId });

  await waitFor(() => sockets.length === 1);
  const oldSocket = sockets[0]!;
  await flush();
  oldSocket.open();
  await waitFor(() => oldSocket.frame("session.resume") !== undefined && sessions.value[0]?.historyState === "loaded");
  oldSocket.respond(oldSocket.frame("session.resume")!.id, { liveSessionId: "live-old", storedSessionId: "stored-1", running: false });
  await flush();
  oldSocket.event("live-old", "message.complete", { messageId: "old-live-copy", text: "persisted during reset" });
  sessions.value = sessions.value.map((session) => session.id === baseSession.id ? {
    ...session,
    messages: [...session.messages, { id: "steer-accepted", from: "user", kind: "steer", body: "use terse output", at: "12:00" }],
  } : session);
  assert.deepEqual(sessions.value[0]?.messages.map(({ id }) => id), ["history-stored-1-0", "history-stored-1-1", "old-live-copy", "steer-accepted"]);

  oldSocket.close(1013, "Hermes chat restarted; reload history");
  await waitFor(() => sockets.length === 2);
  const newSocket = sockets[1]!;
  await flush();
  newSocket.open();
  await waitFor(() => historyRequest === 2);
  assert.deepEqual(resetSignals, [false, true]);
  assert.equal(sessions.value[0]?.historyState, "loading");
  assert.deepEqual(sessions.value[0]?.messages.map(({ id }) => id), []);
  assert.deepEqual(sessions.value[0]?.operationEvidence?.map(({ id }) => id), ["steer-accepted"]);
  assert.equal(newSocket.frame("session.resume"), undefined);

  resyncHistory.resolve(savedHistory({ includePersistedDuringReset: true }));
  await waitFor(() => newSocket.frame("session.resume") !== undefined);
  assert.deepEqual(sessions.value[0]?.messages.map(({ id }) => id), ["history-stored-1-0", "history-stored-1-1", "history-stored-1-2"]);
  assert.equal(sessions.value[0]?.operationEvidence?.filter(({ id }) => id === "steer-accepted").length, 1);

  newSocket.respond(newSocket.frame("session.resume")!.id, { liveSessionId: "live-new", storedSessionId: "stored-1", running: true });
  await flush();
  newSocket.event("live-new", "message.start", { messageId: "fresh-tail" });
  newSocket.event("live-new", "message.delta", { messageId: "fresh-tail", text: "saved answer" });

  assert.equal(sessions.value[0]?.messages.filter(({ body }) => body === "saved answer").length, 2);
  assert.deepEqual(sessions.value[0]?.messages.map(({ id }) => id), ["history-stored-1-0", "history-stored-1-1", "history-stored-1-2", "fresh-tail"]);
  api.stop();
});

test("authoritative reset drops a live row absent from production history but retains local queue evidence once", () => {
  sessions.value = [{
    ...baseSession,
    messages: [
      { id: "old-live", from: "agent", body: "never persisted", at: "11:59", status: "complete" },
      { id: "steer-accepted", from: "user", kind: "steer", body: "keep it short", at: "12:00" },
    ],
  }];
  setChatHistoryLoading(baseSession.id, true);
  applyChatHistory(baseSession.id, [
    { id: "history-stored-1-0", from: "user", body: "saved prompt", at: "11:58", status: "complete" },
  ]);
  assert.deepEqual(sessions.value[0]?.messages.map(({ id }) => id), ["history-stored-1-0"]);
  assert.equal(sessions.value[0]?.operationEvidence?.filter(({ kind }) => kind === "steer").length, 1);
});

test("authoritative reset deterministically evicts only the oldest accepted Steer evidence over the bound", () => {
  const evidence = Array.from({ length: MAX_STEER_EVIDENCE_COUNT + 1 }, (_, index) => ({
    id: `accepted-${index}`, from: "user" as const, kind: "steer" as const, body: "same text", at: "12:00",
  }));
  sessions.value = [{
    ...baseSession,
    messages: [{ id: "durable", from: "agent", body: "drop me", at: "11:59" }, ...evidence],
  }];
  setChatHistoryLoading(baseSession.id, true);
  assert.deepEqual(sessions.value[0]!.messages, []);
  assert.deepEqual(sessions.value[0]!.operationEvidence?.map(({ id }) => id), evidence.slice(1).map(({ id }) => id));
});

function savedHistory(options: { includePersistedDuringReset?: boolean } = {}): unknown {
  return {
    sessionId: "stored-1",
    messages: [
      { index: 0, role: "user", text: "saved prompt" },
      { index: 1, role: "assistant", text: "saved answer" },
      ...(options.includePersistedDuringReset ? [{ index: 2, role: "assistant", text: "persisted during reset" }] : []),
    ],
    pagination: { direction: "older", hasMore: false, returned: options.includePersistedDuringReset ? 3 : 2 },
  };
}

function noopCallbacks(): ChatApiCallbacks {
  return {
    onSocketState() {}, onHistoryLoading() {}, onHistory() {}, onHistoryError() {},
    onSessionConnecting() {}, onSessionReady() {}, onSessionDisconnected() {}, onSessionError() {}, onEvent() {},
  };
}

type RpcFrame = { id: string; method: string; params: Record<string, string> };

class FakeWebSocket {
  readyState = WebSocket.CONNECTING;
  readonly sent: RpcFrame[] = [];
  readonly #listeners = new Map<string, Set<(event: { data?: string; code?: number; reason?: string }) => void>>();

  addEventListener(type: string, listener: (event: { data?: string; code?: number; reason?: string }) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  send(body: string): void { this.sent.push(JSON.parse(body) as RpcFrame); }
  close(code = 1000, reason = ""): void { this.readyState = WebSocket.CLOSED; this.#emit("close", { code, reason }); }
  open(sendOfficeReady = true): void { this.readyState = WebSocket.OPEN; this.#emit("open", {}); if (sendOfficeReady) this.officeReady(); }
  officeReady(): void { this.#emit("message", { data: JSON.stringify({ jsonrpc: "2.0", method: "office.ready", params: {} }) }); }
  respond(id: string, result?: unknown, error?: unknown): void {
    this.#emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id, ...(error === undefined ? { result } : { error }) }) });
  }
  event(liveSessionId: string, type: string, payload: Record<string, unknown>): void {
    this.#emit("message", { data: JSON.stringify({ jsonrpc: "2.0", method: "event", params: { session_id: liveSessionId, type, payload } }) });
  }
  frame(method: string): RpcFrame | undefined { return this.frames(method)[0]; }
  frames(method: string): RpcFrame[] { return this.sent.filter((frame) => frame.method === method); }
  #emit(type: string, event: { data?: string; code?: number; reason?: string }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for chat reconnect");
}
