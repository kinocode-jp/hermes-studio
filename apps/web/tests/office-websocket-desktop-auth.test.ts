import assert from "node:assert/strict";
import test from "node:test";
import {
  officeFetchJson,
  openOfficeWebSocket,
  recoverOfficeWebSocketAuthentication,
} from "../src/office-api.ts";
import {
  BareWebSocket,
  jsonResponse,
  withBrowserEnvironment,
} from "./office-websocket-auth-helpers.ts";

test("desktop capability recovery remains cookie-free and does not call HTTP auth", async () => {
  let capabilityProofs = 0;
  await withBrowserEnvironment({
    protocol: "tauri:",
    hostname: "tauri.localhost",
    origin: "tauri://localhost",
    desktopInvoke: async (command) => { capabilityProofs += 1; return command === "desktop_owned" ? true : "d".repeat(48); },
  }, async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => { fetches += 1; throw new Error("Desktop auth must not use fetch"); }) as typeof fetch;
    try {
      const serverUrl = "http://127.0.0.1:4317/desktop-recovery";
      const lease = await openOfficeWebSocket("ws://127.0.0.1:4317/api/v1/events", serverUrl);
      await recoverOfficeWebSocketAuthentication(serverUrl, lease.authRevision);
      const recovered = await openOfficeWebSocket("ws://127.0.0.1:4317/api/v1/events", serverUrl);
      assert.notEqual(recovered.authRevision, lease.authRevision);
      assert.equal(fetches, 0);
      assert.equal(capabilityProofs, 4, "session bootstrap and each WebSocket send require fresh IPC proof");
      const sockets = BareWebSocket.byPath("/api/v1/events");
      assert.ok(sockets.length >= 1);
      const protocols = sockets.at(-1)?.protocols;
      assert.deepEqual(protocols, ["hermes-office.v1", `hermes-office.desktop.${"d".repeat(48)}`]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("desktop HTTP requests reacquire capability through IPC immediately before every send", async () => {
  let capabilityProofs = 0;
  await withBrowserEnvironment({
    protocol: "tauri:",
    hostname: "tauri.localhost",
    origin: "tauri://localhost",
    desktopInvoke: async (command) => { capabilityProofs += 1; return command === "desktop_owned" ? true : "h".repeat(48); },
  }, async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async (_input, init) => {
      fetches += 1;
      assert.equal(new Headers(init?.headers).get("X-Hermes-Office-Desktop-Capability"), "h".repeat(48));
      return jsonResponse({ ok: true });
    }) as typeof fetch;
    try {
      const serverUrl = "http://127.0.0.1:4317/desktop-fresh-proof";
      await officeFetchJson("/api/v1/health", {}, serverUrl);
      await officeFetchJson("/api/v1/health", {}, serverUrl);
      assert.equal(fetches, 2);
      assert.equal(capabilityProofs, 3, "bootstrap probes once and neither HTTP send reuses its result");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("desktop HTTP send fails closed when the fresh IPC proof loses ownership", async () => {
  let capabilityProofs = 0;
  await withBrowserEnvironment({
    protocol: "tauri:",
    hostname: "tauri.localhost",
    origin: "tauri://localhost",
    desktopInvoke: async (command) => {
      capabilityProofs += 1;
      return command === "desktop_owned" ? true : null;
    },
  }, async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => { fetches += 1; return jsonResponse({ ok: true }); }) as typeof fetch;
    try {
      await assert.rejects(
        officeFetchJson("/api/v1/health", {}, "http://127.0.0.1:4317/desktop-lost-owner"),
        /lost its authenticated desktop server/,
      );
      assert.equal(capabilityProofs, 2);
      assert.equal(fetches, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("desktop WebSocket send fails closed when the fresh IPC proof loses ownership", async () => {
  let capabilityProofs = 0;
  await withBrowserEnvironment({
    protocol: "tauri:",
    hostname: "tauri.localhost",
    origin: "tauri://localhost",
    desktopInvoke: async (command) => {
      capabilityProofs += 1;
      return command === "desktop_owned" ? true : null;
    },
  }, async () => {
    await assert.rejects(
      openOfficeWebSocket(
        "ws://127.0.0.1:4317/api/v1/events",
        "http://127.0.0.1:4317/desktop-lost-owner-websocket",
      ),
      /lost its authenticated desktop server/,
    );
    assert.equal(capabilityProofs, 2);
    assert.equal(BareWebSocket.byPath("/api/v1/events").length, 0);
  });
});

test("a browser-like 127.0.0.1 page ignores an injected desktop bridge", async () => {
  // A normal loopback page remains on cookie auth even if a test/browser host
  // happens to expose an object with the same shape as the Tauri bridge.
  await withBrowserEnvironment({
    protocol: "http:",
    hostname: "127.0.0.1",
    origin: "http://127.0.0.1:4317",
    desktopCapability: null,
  }, async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async (input) => {
      fetches += 1;
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      assert.match(url, /\/api\/v1\/auth\/local$/);
      return jsonResponse({
        principal: { id: "local-browser", tier: "owner", local: true, deviceName: "Local browser" },
        csrfToken: "c".repeat(32),
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    }) as typeof fetch;
    try {
      const serverUrl = "http://127.0.0.1:4317/attached-loopback";
      const lease = await openOfficeWebSocket("ws://127.0.0.1:4317/api/v1/events", serverUrl);
      assert.equal(fetches, 1);
      assert.equal(BareWebSocket.byPath("/api/v1/events").length, 1);
      assert.equal(lease.socket.protocols, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("null ownership on packaged Tauri assets fails closed without local auth", async () => {
  await withBrowserEnvironment({
    protocol: "tauri:",
    hostname: "tauri.localhost",
    origin: "tauri://localhost",
    desktopCapability: null,
  }, async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async (input) => {
      fetches += 1;
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      assert.match(url, /\/api\/v1\/auth\/local$/);
      return jsonResponse({ ok: true });
    }) as typeof fetch;
    try {
      const serverUrl = "http://127.0.0.1:4317/attached-assets";
      await assert.rejects(
        openOfficeWebSocket("ws://127.0.0.1:4317/api/v1/events", serverUrl),
        /does not own an authenticated desktop server/,
      );
      assert.equal(fetches, 0);
      assert.equal(BareWebSocket.byPath("/api/v1/events").length, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("rejected desktop IPC outside the attach origin fails closed", async () => {
  await withBrowserEnvironment({
    protocol: "tauri:",
    hostname: "tauri.localhost",
    origin: "tauri://localhost",
    desktopInvoke: async () => { throw new Error("IPC rejected"); },
  }, async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("Desktop auth must not fall back to HTTP auth.");
    }) as typeof fetch;
    try {
      await assert.rejects(
        openOfficeWebSocket("ws://127.0.0.1:4317/api/v1/events", "http://127.0.0.1:4317/rejected-ipc"),
        /IPC rejected/,
      );
      assert.equal(fetches, 0);
      assert.equal(BareWebSocket.byPath("/api/v1/events").length, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
