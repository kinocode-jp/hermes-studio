import assert from "node:assert/strict";
import test from "node:test";
import {
  OfficeDeviceAuthRequiredError,
  OfficeSessionUnavailableError,
  REMOTE_PROXY_CONFIGURATION_MESSAGE,
  authenticateRemoteDevice,
  connectOfficeApi,
  openOfficeWebSocket,
  recoverOfficeWebSocketAuthentication,
  shouldRecoverOfficeWebSocket,
} from "../src/office-api.ts";
import { initializeInventory, sessionInventoryState } from "../src/inventory.ts";
import { applyOfficeSnapshot, officeAccess, officeConnection, officeSnapshot, registerOfficeRetry, requireDeviceLogin, retryStudioServer, sessions, setOfficeAuthenticated, setOfficeError } from "../src/store.ts";
import { localizeRuntimeMessage } from "../src/i18n.ts";
import {
  BareWebSocket,
  jsonResponse,
  requestUrl,
  snapshot,
  waitFor,
  withBrowserEnvironment,
} from "./office-websocket-auth-helpers.ts";

test("event and chat expiry share one bounded remote device renewal", async () => {
  await withBrowserEnvironment({ protocol: "https:", hostname: "office.example", origin: "https://office.example" }, async () => {
    const serverUrl = "https://office.example/shared-renew";
    let localBootstraps = 0;
    let renewals = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/v1/auth/device")) return jsonResponse({ csrfToken: "a".repeat(32) });
      if (url.endsWith("/api/v1/auth/local")) { localBootstraps += 1; return new Response(null, { status: 403 }); }
      if (url.endsWith("/api/v1/auth/device/renew")) { renewals += 1; return jsonResponse({ csrfToken: "b".repeat(32) }); }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    try {
      assert.deepEqual(await authenticateRemoteDevice("phone", "one-shot-secret", serverUrl), { ok: true });
      const eventLease = await openOfficeWebSocket("wss://office.example/api/v1/events", serverUrl);
      const chatLease = await openOfficeWebSocket("wss://office.example/api/v1/chat", serverUrl);
      assert.equal(eventLease.authRevision, chatLease.authRevision);

      await Promise.all([
        recoverOfficeWebSocketAuthentication(serverUrl, eventLease.authRevision),
        recoverOfficeWebSocketAuthentication(serverUrl, chatLease.authRevision),
      ]);

      assert.equal(localBootstraps, 1);
      assert.equal(renewals, 1);
      const recovered = await openOfficeWebSocket("wss://office.example/api/v1/events", serverUrl);
      assert.notEqual(recovered.authRevision, eventLease.authRevision);
      assert.deepEqual(Object.keys(recovered).sort(), ["authRevision", "socket"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a failed post-renew snapshot preserves LKG and explicit retry restores pagination", async () => {
  await withBrowserEnvironment({ protocol: "https:", hostname: "office.example", origin: "https://office.example", fastTimers: true }, async () => {
    const serverUrl = "https://office.example/recovery-snapshot";
    let snapshotCalls = 0;
    let failRecoverySnapshot = true;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/v1/auth/device")) return jsonResponse({ csrfToken: "7".repeat(32) });
      if (url.endsWith("/api/v1/auth/local")) return new Response(null, { status: 403 });
      if (url.endsWith("/api/v1/auth/device/renew")) return jsonResponse({ csrfToken: "8".repeat(32) });
      if (url.endsWith("/api/v1/health")) return jsonResponse({ ok: true, protocolVersion: 1, runtime: "ready" });
      if (url.endsWith("/api/v1/snapshot")) {
        snapshotCalls += 1;
        if (snapshotCalls === 2 && failRecoverySnapshot) return new Response(null, { status: 503 });
        return jsonResponse(snapshot(snapshotCalls, 100, true));
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    try {
      assert.deepEqual(await authenticateRemoteDevice("phone", "one-shot-secret", serverUrl), { ok: true });
      const office = connectOfficeApi({
        onConnecting() {},
        onSnapshot(value, identity) { if (applyOfficeSnapshot(value, identity)) initializeInventory(value, identity); },
        onEventStream() {}, onError(message) { throw new Error(message); },
        onRecoveryUnavailable(message, url) { setOfficeError(message, url, true); },
        onAuthRequired() { throw new Error("unexpected auth failure"); },
      }, serverUrl);
      await waitFor(() => BareWebSocket.byPath("/api/v1/events").length === 1 && officeSnapshot.value?.sequence === 1);
      const firstEvent = BareWebSocket.byPath("/api/v1/events")[0]!;
      firstEvent.open();
      firstEvent.serverClose(1008, "Session expired");
      await waitFor(() => snapshotCalls === 2 && officeConnection.value.state === "error");
      assert.equal(officeSnapshot.value?.sequence, 1);
      assert.equal(sessions.value.length, 100);
      assert.equal(sessionInventoryState.value.hasMore, false);

      failRecoverySnapshot = false;
      office.retry();
      await waitFor(() => officeSnapshot.value?.sequence === 3 && sessionInventoryState.value.hasMore);
      assert.equal(sessions.value.length, 100);
      office.stop();
      sessions.value = [];
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("event recovery honors Retry-After, stays out of login, and snapshots after retry succeeds", async () => {
  const timerDelays: number[] = [];
  await withBrowserEnvironment({ protocol: "https:", hostname: "office.example", origin: "https://office.example", fastTimers: true, timerDelays }, async () => {
    const serverUrl = "https://office.example/rate-limited-recovery";
    let renewals = 0;
    let snapshots = 0;
    let authRequired = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/v1/auth/device")) return jsonResponse({ csrfToken: "4".repeat(32) });
      if (url.endsWith("/api/v1/auth/local")) return new Response(null, { status: 403 });
      if (url.endsWith("/api/v1/auth/device/renew")) {
        renewals += 1;
        return renewals === 1
          ? new Response(null, { status: 429, headers: { "Retry-After": "60" } })
          : jsonResponse({ csrfToken: "5".repeat(32) });
      }
      if (url.endsWith("/api/v1/health")) return jsonResponse({ ok: true, protocolVersion: 1, runtime: "ready" });
      if (url.endsWith("/api/v1/snapshot")) { snapshots += 1; return jsonResponse(snapshot(snapshots)); }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    try {
      assert.deepEqual(await authenticateRemoteDevice("phone", "one-shot-secret", serverUrl), { ok: true });
      const office = connectOfficeApi({
        onConnecting() {}, onSnapshot() {}, onEventStream() {}, onError() {}, onRecoveryUnavailable() {},
        onAuthRequired() { authRequired += 1; },
      }, serverUrl);
      await waitFor(() => BareWebSocket.byPath("/api/v1/events").length === 1);
      BareWebSocket.byPath("/api/v1/events")[0]!.open();
      BareWebSocket.byPath("/api/v1/events")[0]!.serverClose(1008, "Session expired");
      await waitFor(() => renewals === 2 && snapshots === 2 && BareWebSocket.byPath("/api/v1/events").length === 2);
      assert.equal(timerDelays.includes(60_000), true);
      assert.equal(authRequired, 0);
      office.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("401 renewal requires login through one shared attempt", async () => {
  await withBrowserEnvironment({ protocol: "https:", hostname: "office.example", origin: "https://office.example" }, async () => {
    const serverUrl = "https://office.example/revoked-renew";
    let renewals = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/v1/auth/device")) return jsonResponse({ csrfToken: "c".repeat(32) });
      if (url.endsWith("/api/v1/auth/local")) return new Response(null, { status: 403 });
      if (url.endsWith("/api/v1/auth/device/renew")) { renewals += 1; return new Response(null, { status: 401 }); }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    try {
      assert.deepEqual(await authenticateRemoteDevice("phone", "one-shot-secret", serverUrl), { ok: true });
      const lease = await openOfficeWebSocket("wss://office.example/api/v1/events", serverUrl);
      const results = await Promise.allSettled([
        recoverOfficeWebSocketAuthentication(serverUrl, lease.authRevision),
        recoverOfficeWebSocketAuthentication(serverUrl, lease.authRevision),
      ]);
      assert.equal(renewals, 1);
      assert.ok(results.every((result) => result.status === "rejected" && result.reason instanceof OfficeDeviceAuthRequiredError));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("renew 403 preserves LKG and waits for trusted proxy repair without device re-enrollment", async () => {
  const timerDelays: number[] = [];
  await withBrowserEnvironment({ protocol: "https:", hostname: "office.example", origin: "https://office.example", fastTimers: true, timerDelays }, async () => {
    const serverUrl = "https://office.example/proxy-repair";
    let enrollments = 0;
    let renewals = 0;
    let snapshots = 0;
    let proxyHealthy = false;
    let authRequired = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/v1/auth/device")) { enrollments += 1; return jsonResponse({ csrfToken: "d".repeat(32) }); }
      if (url.endsWith("/api/v1/auth/local")) return new Response(null, { status: 403 });
      if (url.endsWith("/api/v1/auth/device/renew")) {
        renewals += 1;
        return proxyHealthy ? jsonResponse({ csrfToken: "e".repeat(32) }) : new Response(null, { status: 403 });
      }
      if (url.endsWith("/api/v1/health")) return jsonResponse({ ok: true, protocolVersion: 1, runtime: "ready" });
      if (url.endsWith("/api/v1/snapshot")) { snapshots += 1; return jsonResponse(snapshot(snapshots, 1)); }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    let office: ReturnType<typeof connectOfficeApi> | undefined;
    try {
      assert.deepEqual(await authenticateRemoteDevice("phone", "one-shot-secret", serverUrl), { ok: true });
      office = connectOfficeApi({
        onConnecting() {},
        onSnapshot(value, identity) {
          if (!applyOfficeSnapshot(value, identity)) return;
          initializeInventory(value, identity);
          setOfficeAuthenticated(identity.serverUrl);
        },
        onEventStream() {},
        onError(message) { throw new Error(message); },
        onRecoveryUnavailable(message, url) { setOfficeError(message, url, true); },
        onAuthRequired(url) { authRequired += 1; requireDeviceLogin(url); },
      }, serverUrl);
      registerOfficeRetry(() => office.retry());
      await waitFor(() => BareWebSocket.byPath("/api/v1/events").length === 1 && officeSnapshot.value?.sequence === 1);
      const reconnectTimersBeforeFailure = timerDelays.filter((delay) => delay >= 3_000).length;
      BareWebSocket.byPath("/api/v1/events")[0]!.open();
      BareWebSocket.byPath("/api/v1/events")[0]!.serverClose(1008, "Session expired");
      await waitFor(() => renewals === 1 && officeConnection.value.state === "error");
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(localizeRuntimeMessage(officeConnection.value.message), REMOTE_PROXY_CONFIGURATION_MESSAGE);
      assert.equal(officeAccess.value.state, "authenticated");
      assert.equal(officeSnapshot.value?.sequence, 1);
      assert.equal(sessions.value.length, 1);
      assert.equal(authRequired, 0);
      assert.equal(enrollments, 1);
      assert.equal(BareWebSocket.byPath("/api/v1/events").length, 1);
      assert.equal(timerDelays.filter((delay) => delay >= 3_000).length, reconnectTimersBeforeFailure);

      proxyHealthy = true;
      retryStudioServer();
      await waitFor(() => renewals === 2 && officeSnapshot.value?.sequence === 2 && BareWebSocket.byPath("/api/v1/events").length === 2);
      assert.equal(officeAccess.value.state, "authenticated");
      assert.equal(enrollments, 1);
      assert.equal(authRequired, 0);
      sessions.value = [];
    } finally {
      office?.stop();
      registerOfficeRetry(() => {});
      globalThis.fetch = originalFetch;
    }
  });
});

test("network, timeout, 429, and 5xx renewal failures remain retryable", async () => {
  const cases: Array<{ name: string; response?: Response; failure?: Error; retryAfterMs: number }> = [
    { name: "network", failure: new TypeError("offline"), retryAfterMs: 0 },
    { name: "timeout", failure: new DOMException("timed out", "AbortError"), retryAfterMs: 0 },
    { name: "rate", response: new Response(null, { status: 429, headers: { "Retry-After": "60" } }), retryAfterMs: 60_000 },
    { name: "server", response: new Response(null, { status: 503 }), retryAfterMs: 0 },
  ];
  for (const item of cases) {
    await withBrowserEnvironment({ protocol: "https:", hostname: "office.example", origin: "https://office.example" }, async () => {
      const serverUrl = `https://office.example/retryable-${item.name}`;
      let renewals = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input) => {
        const url = requestUrl(input);
        if (url.endsWith("/api/v1/auth/device")) return jsonResponse({ csrfToken: "9".repeat(32) });
        if (url.endsWith("/api/v1/auth/local")) return new Response(null, { status: 403 });
        if (url.endsWith("/api/v1/auth/device/renew")) {
          renewals += 1;
          if (item.failure) throw item.failure;
          return item.response!;
        }
        throw new Error(`Unexpected request: ${url}`);
      }) as typeof fetch;
      try {
        assert.deepEqual(await authenticateRemoteDevice("phone", "one-shot-secret", serverUrl), { ok: true });
        const lease = await openOfficeWebSocket("wss://office.example/api/v1/events", serverUrl);
        const results = await Promise.allSettled([
          recoverOfficeWebSocketAuthentication(serverUrl, lease.authRevision),
          recoverOfficeWebSocketAuthentication(serverUrl, lease.authRevision),
        ]);
        assert.equal(renewals, 1);
        assert.ok(results.every((result) => result.status === "rejected" && result.reason instanceof OfficeSessionUnavailableError && result.reason.retryAfterMs === item.retryAfterMs));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});

test("local cookie recovery rotates locally without using the device endpoint", async () => {
  await withBrowserEnvironment({ protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:4317" }, async () => {
    const serverUrl = "http://127.0.0.1:4317/local-recovery";
    let localBootstraps = 0;
    let renewals = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/v1/auth/local")) {
        localBootstraps += 1;
        return jsonResponse({ csrfToken: String(localBootstraps).repeat(32) });
      }
      if (url.endsWith("/api/v1/auth/device/renew")) { renewals += 1; return new Response(null, { status: 500 }); }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    try {
      const lease = await openOfficeWebSocket("ws://127.0.0.1:4317/api/v1/events", serverUrl);
      await recoverOfficeWebSocketAuthentication(serverUrl, lease.authRevision);
      const recovered = await openOfficeWebSocket("ws://127.0.0.1:4317/api/v1/events", serverUrl);
      assert.notEqual(recovered.authRevision, lease.authRevision);
      assert.equal(localBootstraps, 2);
      assert.equal(renewals, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("local bootstrap 5xx remains unavailable instead of requesting device login", async () => {
  await withBrowserEnvironment({ protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:4317" }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
    try {
      const result = await Promise.allSettled([openOfficeWebSocket("ws://127.0.0.1:4317/api/v1/events", "http://127.0.0.1:4317/local-503")]);
      assert.equal(result[0]?.status, "rejected");
      if (result[0]?.status === "rejected") {
        assert.equal(result[0].reason instanceof OfficeSessionUnavailableError, true);
        assert.equal(result[0].reason instanceof OfficeDeviceAuthRequiredError, false);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("WebSocket auth-close classification excludes ordinary open transport loss", () => {
  assert.equal(shouldRecoverOfficeWebSocket({ code: 1008, reason: "Session expired" }, true), true);
  assert.equal(shouldRecoverOfficeWebSocket({ code: 1008, reason: "Device revoked" }, true), true);
  assert.equal(shouldRecoverOfficeWebSocket({ code: 1006, reason: "" }, false), true);
  assert.equal(shouldRecoverOfficeWebSocket({ code: 1000, reason: "" }, false, true), true);
  assert.equal(shouldRecoverOfficeWebSocket({ code: 1006, reason: "network lost" }, true), false);
  assert.equal(shouldRecoverOfficeWebSocket({ code: 1013, reason: "Hermes runtime unavailable" }, true), false);
});

test("authenticated WebSocket leases reject cross-origin and non-Office targets before auth", async () => {
  await assert.rejects(openOfficeWebSocket("wss://attacker.example/api/v1/chat", "https://office.example"), /target is invalid/);
  await assert.rejects(openOfficeWebSocket("wss://office.example/private", "https://office.example"), /target is invalid/);
  await assert.rejects(openOfficeWebSocket("wss://office.example/api/v1/chat?leak=1", "https://office.example"), /target is invalid/);
});
