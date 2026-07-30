import assert from "node:assert/strict";
import test from "node:test";
import type { OfficeSnapshot, OfficeSnapshotRequestIdentity } from "../src/domain.ts";
import { initializeInventory, loadMoreSessions, registerInventorySnapshotRefresh, sessionInventoryState } from "../src/inventory.ts";
import { storedSessionClientId } from "../src/session-identity.ts";
import { applyOfficeSnapshot, profileList, sessions } from "../src/store.ts";
import { officeSnapshotInventoryReliable } from "../src/office-api-connection.ts";

test("partial snapshot inventory remains retryable until both inventories are reliable", () => {
  const reliable = snapshot("cursor");
  assert.equal(officeSnapshotInventoryReliable(reliable), true);
  assert.equal(officeSnapshotInventoryReliable({
    inventory: {
      ...reliable.inventory,
      profiles: { returned: 0, available: 0, hasMore: false, truncated: true, partialFailures: 1 },
    },
  }), false);
  assert.equal(officeSnapshotInventoryReliable({
    inventory: {
      ...reliable.inventory,
      sessions: { returned: 0, available: 0, hasMore: false, truncated: true, partialFailures: 1 },
    },
  }), false);
});

test("a stale continuation refreshes the snapshot once and resumes pagination", async () => {
  const serverUrl = "http://127.0.0.1:54321";
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalLocation = globalThis.location;
  const calls: string[] = [];
  const staleIdentity: OfficeSnapshotRequestIdentity = { serverUrl, connectionGeneration: 1, requestGeneration: 1 };
  const freshIdentity: OfficeSnapshotRequestIdentity = { serverUrl, connectionGeneration: 1, requestGeneration: 2 };
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { protocol: "http:", hostname: "127.0.0.1" } });
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(new URL(url).pathname);
    if (url.endsWith("/api/v1/auth/local")) return json({ csrfToken: "0123456789abcdef" });
    if (url.includes("/api/v1/inventory") && calls.filter((path) => path === "/api/v1/inventory").length === 1) return json({}, 409);
    if (url.includes("/api/v1/inventory")) {
      return json({ kind: "sessions", profiles: [], sessions: [{ id: "session-100", profileId: "p1", title: "Recovered", activity: "idle" }], pagination: { returned: 1, available: 101, total: 101, hasMore: false, truncated: false, partialFailures: 0 } });
    }
    return json({}, 404);
  };
  try {
    applyOfficeSnapshot(snapshot("stale-cursor"), staleIdentity);
    initializeInventory(snapshot("stale-cursor"), staleIdentity);
    registerInventorySnapshotRefresh(async (expected) => {
      assert.deepEqual(expected, { serverUrl, connectionGeneration: staleIdentity.connectionGeneration });
      const fresh = snapshot("fresh-cursor");
      assert.equal(applyOfficeSnapshot(fresh, freshIdentity), true);
      initializeInventory(fresh, freshIdentity);
      return freshIdentity;
    });
    await loadMoreSessions();
    assert.deepEqual(calls, ["/api/v1/auth/local", "/api/v1/inventory", "/api/v1/inventory"]);
    assert.equal(sessionInventoryState.value.hasMore, false);
    assert.equal(sessionInventoryState.value.error, undefined);
    assert.equal(profileList.value[0]?.id, "p1");
    assert.equal(sessions.value.at(-1)?.id, storedSessionClientId("p1", "session-100"));
  } finally {
    registerInventorySnapshotRefresh(undefined);
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, "location", { configurable: true, value: originalLocation });
  }
});

function snapshot(cursor: string): OfficeSnapshot {
  const sessions = Array.from({ length: 100 }, (_, index) => ({ id: `session-${index}`, profileId: "p1", title: `Session ${index}`, activity: "idle" as const }));
  return {
    generatedAt: new Date(0).toISOString(), sequence: 1,
    capabilities: { protocolVersion: 1, serverVersion: "test", runtime: { state: "ready", adapterVersion: "test" }, access: { deviceId: "local", tier: "owner", exposure: "loopback", authentication: "local-cookie", allowedOperations: ["state.read"] }, features: ["chat", "profiles"] },
    profiles: [{ id: "p1", name: "p1", activity: "idle", activeSessionCount: 0 }], sessions,
    inventory: { profiles: { returned: 1, available: 1, total: 1, hasMore: false, truncated: false, partialFailures: 0 }, sessions: { returned: 100, available: 101, total: 101, hasMore: true, truncated: false, partialFailures: 0, nextCursor: cursor } }, boards: [],
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
