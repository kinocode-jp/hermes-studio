import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticateRemoteDevice,
  connectOfficeApi,
} from "../src/office-api.ts";
import { connectChatApi } from "../src/chat-api.ts";
import { initializeInventory, loadMoreSessions, sessionInventoryState } from "../src/inventory.ts";
import { applyOfficeSnapshot, officeConnection, officeSnapshot, openSessionIds, reconnectChatSession, registerChatRuntime, sessions, setOfficeAuthenticated, setOfficeError, setOfficeEventStream } from "../src/store.ts";
import {
  BareWebSocket,
  deferred,
  jsonResponse,
  requestUrl,
  snapshot,
  waitFor,
  withBrowserEnvironment,
} from "./office-websocket-auth-helpers.ts";

test("simultaneous live event and chat expiry renew once and reconnect both transports", async () => {
  await withBrowserEnvironment({ protocol: "https:", hostname: "office.example", origin: "https://office.example", fastTimers: true }, async () => {
    const serverUrl = "https://office.example";
    let localBootstraps = 0;
    let renewals = 0;
    let snapshotCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/v1/auth/device")) return jsonResponse({ csrfToken: "e".repeat(32) });
      if (url.endsWith("/api/v1/auth/local")) { localBootstraps += 1; return new Response(null, { status: 403 }); }
      if (url.endsWith("/api/v1/auth/device/renew")) { renewals += 1; return jsonResponse({ csrfToken: "f".repeat(32) }); }
      if (url.endsWith("/api/v1/health")) return jsonResponse({ ok: true, protocolVersion: 1, runtime: "ready" });
      if (url.endsWith("/api/v1/snapshot")) { snapshotCalls += 1; return jsonResponse(snapshot(snapshotCalls, 100, true)); }
      if (url.includes("/api/v1/inventory?")) return jsonResponse({ kind: "sessions", profiles: [], sessions: [{ id: "session-101", profileId: "profile", title: "Session 101", activity: "idle" }], pagination: { returned: 1, available: 101, total: 101, hasMore: false, truncated: false, partialFailures: 0 } });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const eventStates: string[] = [];
    const chatStates: string[] = [];
    try {
      assert.deepEqual(await authenticateRemoteDevice("phone", "one-shot-secret", serverUrl), { ok: true });
      const office = connectOfficeApi({
        onConnecting() {}, onSnapshot(value, identity) { if (applyOfficeSnapshot(value, identity)) initializeInventory(value, identity); }, onError(message) { throw new Error(message); },
        onEventStream(state) { eventStates.push(state); }, onAuthRequired() { throw new Error("unexpected auth failure"); },
      }, serverUrl);
      const chat = connectChatApi({
        onSocketState(state) { chatStates.push(state); },
        onHistoryLoading() {}, onHistory() {}, onHistoryError() {}, onSessionConnecting() {},
        onSessionReady() {}, onSessionDisconnected() {}, onSessionError() {}, onEvent() {},
      }, { serverUrl, reconnectDelay: () => 0 });

      await waitFor(() => BareWebSocket.byPath("/api/v1/events").length === 1 && BareWebSocket.byPath("/api/v1/chat").length === 1);
      const firstEvent = BareWebSocket.byPath("/api/v1/events")[0]!;
      const firstChat = BareWebSocket.byPath("/api/v1/chat")[0]!;
      firstEvent.open();
      firstChat.open();
      firstEvent.serverClose(1008, "Session expired");
      firstChat.serverClose(1008, "Session expired");

      await waitFor(() => BareWebSocket.byPath("/api/v1/events").length === 2);
      assert.equal(BareWebSocket.byPath("/api/v1/chat").length, 1);
      BareWebSocket.byPath("/api/v1/events")[1]!.open();
      await waitFor(() => BareWebSocket.byPath("/api/v1/chat").length === 2);
      BareWebSocket.byPath("/api/v1/chat")[1]!.open();
      assert.equal(localBootstraps, 1);
      assert.equal(renewals, 1);
      await waitFor(() => snapshotCalls === 2 && sessionInventoryState.value.hasMore);
      assert.equal(officeSnapshot.value?.sequence, 2);
      await loadMoreSessions();
      assert.equal(sessions.value.some((session) => session.storedSessionId === "session-101"), true);
      assert.equal(eventStates.filter((state) => state === "open").length, 2);
      assert.equal(chatStates.filter((state) => state === "ready").length, 2);
      chat.stop();
      office.stop();
      sessions.value = [];
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("chat-pane retry waits through snapshot and event-open barriers before creating Chat WebSocket", async () => {
  await withBrowserEnvironment({ protocol: "https:", hostname: "office.example", origin: "https://office.example" }, async () => {
    const serverUrl = "https://office.example/chat-coordinated-recovery";
    const recoverySnapshot = deferred<Response>();
    const eventStates: string[] = [];
    const chatStates: string[] = [];
    let proxyHealthy = false;
    let renewals = 0;
    let snapshots = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/v1/auth/device")) return jsonResponse({ csrfToken: "1".repeat(32) });
      if (url.endsWith("/api/v1/auth/local")) return new Response(null, { status: 403 });
      if (url.endsWith("/api/v1/auth/device/renew")) {
        renewals += 1;
        return proxyHealthy ? jsonResponse({ csrfToken: "2".repeat(32) }) : new Response(null, { status: 403 });
      }
      if (url.endsWith("/api/v1/health")) return jsonResponse({ ok: true, protocolVersion: 1, runtime: "ready" });
      if (url.endsWith("/api/v1/snapshot")) {
        snapshots += 1;
        if (snapshots === 1) return jsonResponse(snapshot(1));
        return snapshots === 2 ? await recoverySnapshot.promise : jsonResponse(snapshot(snapshots));
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    let office: ReturnType<typeof connectOfficeApi> | undefined;
    let chat: ReturnType<typeof connectChatApi> | undefined;
    try {
      assert.deepEqual(await authenticateRemoteDevice("phone", "one-shot-secret", serverUrl), { ok: true });
      office = connectOfficeApi({
        onConnecting() {},
        onSnapshot(value, identity) {
          if (!applyOfficeSnapshot(value, identity)) return;
          initializeInventory(value, identity);
          setOfficeAuthenticated(identity.serverUrl);
        },
        onEventStream(state) { eventStates.push(state); setOfficeEventStream(state); },
        onError(message) { throw new Error(message); },
        onRecoveryUnavailable(message, url) { setOfficeError(message, url, true); },
        onAuthRequired() { throw new Error("unexpected auth failure"); },
      }, serverUrl);
      chat = connectChatApi({
        onSocketState(state) { chatStates.push(state); },
        onHistoryLoading() {}, onHistory() {}, onHistoryError() {}, onSessionConnecting() {},
        onSessionReady() {}, onSessionDisconnected() {}, onSessionError() {}, onEvent() {},
      }, { serverUrl, reconnectDelay: () => 0 });
      sessions.value = [{ id: "chat-retry", profileId: "profile", title: "Retry", status: "ready", messages: [], remoteKind: "draft", connectionState: "connecting", historyState: "unloaded" }];
      openSessionIds.value = ["chat-retry"];
      registerChatRuntime(chat);

      await waitFor(() => BareWebSocket.byPath("/api/v1/events").length === 1 && BareWebSocket.byPath("/api/v1/chat").length === 1);
      BareWebSocket.byPath("/api/v1/events")[0]!.open();
      BareWebSocket.byPath("/api/v1/chat")[0]!.open();
      BareWebSocket.byPath("/api/v1/events")[0]!.serverClose(1008, "Session expired");
      BareWebSocket.byPath("/api/v1/chat")[0]!.serverClose(1008, "Session expired");
      await waitFor(() => renewals === 1 && officeConnection.value.state === "error" && chatStates.at(-1) === "error");

      proxyHealthy = true;
      reconnectChatSession("chat-retry");
      await waitFor(() => renewals === 2 && snapshots === 2);
      assert.equal(BareWebSocket.byPath("/api/v1/chat").length, 1);
      assert.equal(BareWebSocket.byPath("/api/v1/events").length, 1);
      assert.equal(officeConnection.value.state, "error");
      assert.equal(officeConnection.value.eventStream, "connecting");

      recoverySnapshot.resolve(jsonResponse(snapshot(2)));
      await waitFor(() => officeSnapshot.value?.sequence === 2 && BareWebSocket.byPath("/api/v1/events").length === 2);
      assert.equal(BareWebSocket.byPath("/api/v1/chat").length, 1);
      BareWebSocket.byPath("/api/v1/events")[1]!.serverClose(1006, "event handshake failed");
      await waitFor(() => chatStates.filter((state) => state === "error").length === 2);
      assert.equal(BareWebSocket.byPath("/api/v1/chat").length, 1);

      office.retry();
      await waitFor(() => snapshots === 3 && BareWebSocket.byPath("/api/v1/events").length === 3);
      assert.equal(BareWebSocket.byPath("/api/v1/chat").length, 1);
      BareWebSocket.byPath("/api/v1/events")[2]!.open();
      await waitFor(() => BareWebSocket.byPath("/api/v1/chat").length === 2);
      BareWebSocket.byPath("/api/v1/chat")[1]!.open();
      assert.equal(officeConnection.value.state, "connected");
      assert.equal(officeConnection.value.eventStream, "open");
      assert.equal(eventStates.filter((state) => state === "open").length, 2);
      assert.equal(chatStates.filter((state) => state === "ready").length, 2);
      assert.equal(renewals, 2);
      assert.equal(snapshots, 3);
    } finally {
      chat?.stop();
      office?.stop();
      sessions.value = [];
      openSessionIds.value = [];
      globalThis.fetch = originalFetch;
    }
  });
});

test("event-side retry keeps halted chat stopped until a failed recovery snapshot later succeeds", async () => {
  await withBrowserEnvironment({ protocol: "https:", hostname: "office.example", origin: "https://office.example" }, async () => {
    const serverUrl = "https://office.example/event-coordinated-recovery";
    const chatStates: string[] = [];
    let proxyHealthy = false;
    let failSnapshot = true;
    let renewals = 0;
    let snapshots = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/v1/auth/device")) return jsonResponse({ csrfToken: "3".repeat(32) });
      if (url.endsWith("/api/v1/auth/local")) return new Response(null, { status: 403 });
      if (url.endsWith("/api/v1/auth/device/renew")) { renewals += 1; return proxyHealthy ? jsonResponse({ csrfToken: "4".repeat(32) }) : new Response(null, { status: 403 }); }
      if (url.endsWith("/api/v1/health")) return jsonResponse({ ok: true, protocolVersion: 1, runtime: "ready" });
      if (url.endsWith("/api/v1/snapshot")) { snapshots += 1; return snapshots > 1 && failSnapshot ? new Response(null, { status: 503 }) : jsonResponse(snapshot(snapshots)); }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    let office: ReturnType<typeof connectOfficeApi> | undefined;
    let chat: ReturnType<typeof connectChatApi> | undefined;
    try {
      assert.deepEqual(await authenticateRemoteDevice("phone", "one-shot-secret", serverUrl), { ok: true });
      office = connectOfficeApi({
        onConnecting() {}, onSnapshot(value, identity) { if (applyOfficeSnapshot(value, identity)) setOfficeAuthenticated(identity.serverUrl); },
        onEventStream: setOfficeEventStream, onError(message) { throw new Error(message); },
        onRecoveryUnavailable(message, url) { setOfficeError(message, url, true); }, onAuthRequired() { throw new Error("unexpected auth failure"); },
      }, serverUrl);
      chat = connectChatApi({
        onSocketState(state) { chatStates.push(state); }, onHistoryLoading() {}, onHistory() {}, onHistoryError() {},
        onSessionConnecting() {}, onSessionReady() {}, onSessionDisconnected() {}, onSessionError() {}, onEvent() {},
      }, { serverUrl, reconnectDelay: () => 0 });
      chat.ensureSession({ clientSessionId: "halted-target", profileId: "profile" });
      await waitFor(() => BareWebSocket.byPath("/api/v1/events").length === 1 && BareWebSocket.byPath("/api/v1/chat").length === 1);
      BareWebSocket.byPath("/api/v1/events")[0]!.open();
      BareWebSocket.byPath("/api/v1/chat")[0]!.open();
      BareWebSocket.byPath("/api/v1/events")[0]!.serverClose(1008, "Session expired");
      BareWebSocket.byPath("/api/v1/chat")[0]!.serverClose(1008, "Session expired");
      await waitFor(() => renewals === 1 && chatStates.at(-1) === "error");

      proxyHealthy = true;
      office.retry();
      await waitFor(() => renewals === 2 && snapshots === 2 && officeConnection.value.state === "error");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(BareWebSocket.byPath("/api/v1/events").length, 1);
      assert.equal(BareWebSocket.byPath("/api/v1/chat").length, 1);
      assert.equal(officeSnapshot.value?.sequence, 1);

      failSnapshot = false;
      office.retry();
      await waitFor(() => snapshots === 3 && BareWebSocket.byPath("/api/v1/events").length === 2);
      assert.equal(BareWebSocket.byPath("/api/v1/chat").length, 1);
      BareWebSocket.byPath("/api/v1/events")[1]!.open();
      await waitFor(() => BareWebSocket.byPath("/api/v1/chat").length === 2);
      assert.equal(renewals, 2);
    } finally {
      chat?.stop();
      office?.stop();
      globalThis.fetch = originalFetch;
    }
  });
});
