import assert from "node:assert/strict";
import test from "node:test";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import { HermesChatTransportError, type HermesChatConnection, type HermesChatRequest } from "./hermes-chat.js";
import { ChatSessionCoordinator } from "./chat-session-coordinator.js";
import { ChatCommitUnconfirmedError, ChatUpstreamHub } from "./chat-upstream-hub.js";

test("a detach while connect is pending prevents normal and owned upstream requests", async () => {
  let resolveConnection!: (connection: HermesChatConnection) => void;
  const connectionReady = new Promise<HermesChatConnection>((resolve) => { resolveConnection = resolve; });
  let upstreamRequests = 0;
  const connection: HermesChatConnection = {
    closed: false,
    request: async (request) => {
      upstreamRequests += 1;
      return { method: request.method, value: { status: "ok" } };
    },
    close: async () => undefined,
  };
  const runtime = runtimeWithConnect(async () => await connectionReady);
  const coordinator = new ChatSessionCoordinator();
  const normalOwner = {};
  const liveOwner = {};
  const liveClaim = coordinator.claimCreate(liveOwner, "coder");
  assert.equal(coordinator.bind(liveClaim, { storedSessionId: "stored-owned", liveSessionId: "live-owned" }, true), "bound");
  const liveToken = coordinator.liveLeaseToken(liveOwner, "live-owned");
  assert.ok(liveToken);
  const hub = new ChatUpstreamHub(runtime, coordinator, 64 * 1024);
  const subscriber = { onEvent: () => undefined, onUnavailable: () => undefined };
  const normalAttach = hub.attach(normalOwner, subscriber);
  const liveAttach = hub.attach(liveOwner, subscriber);
  const normalRejected = assert.rejects(hub.request(normalOwner, { method: "session.create", params: { profile: "coder" } }));
  const ownedRejected = assert.rejects(hub.requestOwnedSession(
    liveOwner, "live-owned", liveToken,
    { method: "prompt.submit", params: { session_id: "live-owned", text: "late" } },
  ));

  hub.detach(normalOwner);
  hub.detach(liveOwner);
  resolveConnection(connection);
  await Promise.all([normalAttach, liveAttach, normalRejected, ownedRejected]);
  assert.equal(upstreamRequests, 0);
  await hub.close();
});

test("the owned-session request path rejects methods and wire targets outside its capability", async () => {
  let upstreamRequests = 0;
  const runtime = runtimeWithConnect(async () => ({
    closed: false,
    request: async (request: HermesChatRequest) => {
      upstreamRequests += 1;
      return { method: request.method, value: { status: "ok" } };
    },
    close: async () => undefined,
  }));
  const coordinator = new ChatSessionCoordinator();
  const owner = {};
  const claim = coordinator.claimCreate(owner, "coder");
  assert.equal(coordinator.bind(claim, { storedSessionId: "stored-owned", liveSessionId: "live-owned" }, true), "bound");
  const leaseToken = coordinator.liveLeaseToken(owner, "live-owned");
  assert.ok(leaseToken);
  const hub = new ChatUpstreamHub(runtime, coordinator, 64 * 1024);
  await hub.attach(owner, { onEvent: () => undefined, onUnavailable: () => undefined });

  const invalidRequests: HermesChatRequest[] = [
    { method: "session.create", params: { profile: "coder" } },
    { method: "session.resume", params: { session_id: "stored-owned", profile: "coder" } },
    { method: "session.close", params: { session_id: "live-owned" } },
    { method: "prompt.submit", params: { session_id: "live-other", text: "wrong target" } },
    { method: "approval.respond", params: { session_id: "live-other", approval_id: "approval", choice: "once" } },
  ];
  for (const request of invalidRequests) {
    await assert.rejects(hub.requestOwnedSession(owner, "live-owned", leaseToken, request));
  }
  assert.equal(upstreamRequests, 0);
  await hub.close();
});

test("connect-wait commands cannot cross same-owner same-live lease reuse", async () => {
  let resolveConnection!: (connection: HermesChatConnection) => void;
  const connectionReady = new Promise<HermesChatConnection>((resolve) => { resolveConnection = resolve; });
  let upstreamRequests = 0;
  const connection: HermesChatConnection = {
    closed: false,
    request: async (request) => {
      upstreamRequests += 1;
      return { method: request.method, value: { status: "ok" } };
    },
    close: async () => undefined,
  };
  const coordinator = new ChatSessionCoordinator();
  const owner = {};
  const oldClaim = coordinator.claimResume(owner, "coder", "stored");
  assert.ok(oldClaim);
  assert.equal(coordinator.bind(oldClaim, { storedSessionId: "stored", liveSessionId: "live-reused" }, false), "bound");
  const oldToken = coordinator.liveLeaseToken(owner, "live-reused");
  assert.ok(oldToken);
  const hub = new ChatUpstreamHub(runtimeWithConnect(async () => await connectionReady), coordinator, 64 * 1024);
  const attaching = hub.attach(owner, { onEvent: () => undefined, onUnavailable: () => undefined });
  const methods = ["prompt.submit", "session.steer", "session.interrupt"] as const;
  const rejected = methods.map((method) => assert.rejects(hub.requestOwnedSession(
    owner, "live-reused", oldToken,
    method === "session.interrupt"
      ? { method, params: { session_id: "live-reused" } }
      : { method, params: { session_id: "live-reused", text: "stale" } },
  )));

  assert.equal(coordinator.releaseLease(owner, oldToken), true);
  const newClaim = coordinator.claimResume(owner, "coder", "stored");
  assert.ok(newClaim);
  assert.equal(coordinator.bind(newClaim, { storedSessionId: "stored", liveSessionId: "live-reused" }, false), "bound");
  assert.notEqual(coordinator.liveLeaseToken(owner, "live-reused"), oldToken);
  resolveConnection(connection);
  await Promise.all([attaching, ...rejected]);
  assert.equal(upstreamRequests, 0);
  await hub.close();
});

test("durable alias convergence preserves the live lease token", async () => {
  let upstreamRequests = 0;
  const runtime = runtimeWithConnect(async () => ({
    closed: false,
    request: async (request: HermesChatRequest) => {
      upstreamRequests += 1;
      return { method: request.method, value: { status: "ok" } };
    },
    close: async () => undefined,
  }));
  const coordinator = new ChatSessionCoordinator();
  const owner = {};
  const first = coordinator.claimResume(owner, "coder", "stored-a");
  assert.ok(first);
  assert.equal(coordinator.bind(first, { storedSessionId: "stored-a", liveSessionId: "live" }, false), "bound");
  const token = coordinator.liveLeaseToken(owner, "live");
  assert.ok(token);
  const alias = coordinator.claimResume(owner, "coder", "stored-a");
  assert.ok(alias);
  assert.equal(coordinator.bind(alias, { storedSessionId: "stored-b", liveSessionId: "live" }, false), "bound");
  assert.equal(coordinator.liveLeaseToken(owner, "live"), token);

  const hub = new ChatUpstreamHub(runtime, coordinator, 64 * 1024);
  await hub.attach(owner, { onEvent: () => undefined, onUnavailable: () => undefined });
  await hub.requestOwnedSession(owner, "live", token, {
    method: "prompt.submit", params: { session_id: "live", text: "same lease" },
  });
  assert.equal(upstreamRequests, 1);
  await hub.close();
});

test("owned mutation acknowledgements settle against the routing lease while close fences new commands", async () => {
  const pending = new Map<HermesChatRequest["method"], ReturnType<typeof deferred>>();
  const connection: HermesChatConnection = {
    closed: false,
    request: async (request) => {
      const gate = deferred();
      pending.set(request.method, gate);
      await gate.promise;
      return { method: request.method, value: { status: "ok", resolved: true } };
    },
    close: async () => undefined,
  };
  const coordinator = new ChatSessionCoordinator();
  const owner = {};
  const claim = coordinator.claimResume(owner, "coder", "stored");
  assert.ok(claim);
  assert.equal(coordinator.bind(claim, { storedSessionId: "stored", liveSessionId: "live" }, false), "bound");
  const token = coordinator.liveLeaseToken(owner, "live");
  const lease = coordinator.leaseForSession(owner, "live");
  assert.ok(token);
  assert.ok(lease);
  const hub = new ChatUpstreamHub(runtimeWithConnect(async () => connection), coordinator, 64 * 1024);
  await hub.attach(owner, { onEvent: () => undefined, onUnavailable: () => undefined });

  const requests: HermesChatRequest[] = [
    { method: "prompt.submit", params: { session_id: "live", text: "run" } },
    { method: "session.steer", params: { session_id: "live", text: "adjust" } },
    { method: "session.interrupt", params: { session_id: "live" } },
    { method: "approval.respond", params: { session_id: "live", choice: "once" } },
    { method: "clarify.respond", params: { request_id: "question", answer: "yes" } },
  ];
  const results = requests.map((request) => hub.requestOwnedSession(owner, "live", token, request));
  await waitFor(() => pending.size === requests.length);
  const closeToken = coordinator.claimOwnedLeaseClose(owner, lease);
  assert.ok(closeToken);
  assert.equal(coordinator.liveLeaseToken(owner, "live"), undefined, "close fences fresh commands");
  for (const gate of pending.values()) gate.resolve();

  await Promise.all(results);
  coordinator.finishOwnedLeaseClose(lease, closeToken);
  assert.equal(coordinator.liveLeaseToken(owner, "live"), token);
  await hub.close();
});

test("owned mutation settlement fails closed across same-owner live-id lease reuse", async () => {
  const gate = deferred();
  const connection: HermesChatConnection = {
    closed: false,
    request: async (request) => {
      await gate.promise;
      return { method: request.method, value: { resolved: true } };
    },
    close: async () => undefined,
  };
  const coordinator = new ChatSessionCoordinator();
  const owner = {};
  const first = coordinator.claimResume(owner, "coder", "stored-old");
  assert.ok(first);
  assert.equal(coordinator.bind(first, { storedSessionId: "stored-old", liveSessionId: "live" }, false), "bound");
  const oldToken = coordinator.liveLeaseToken(owner, "live");
  assert.ok(oldToken);
  const hub = new ChatUpstreamHub(runtimeWithConnect(async () => connection), coordinator, 64 * 1024);
  await hub.attach(owner, { onEvent: () => undefined, onUnavailable: () => undefined });
  const response = hub.requestOwnedSession(owner, "live", oldToken, {
    method: "approval.respond", params: { session_id: "live", choice: "once" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(coordinator.releaseLease(owner, oldToken), true);
  const replacement = coordinator.claimResume(owner, "coder", "stored-new");
  assert.ok(replacement);
  assert.equal(coordinator.bind(replacement, { storedSessionId: "stored-new", liveSessionId: "live" }, false), "bound");
  assert.notEqual(coordinator.liveLeaseToken(owner, "live"), oldToken);
  gate.resolve();

  await assert.rejects(response, (error: unknown) => error instanceof ChatCommitUnconfirmedError);
  await hub.close();
});

test("a stale slash settlement does not reset unrelated sessions on the shared transport", async () => {
  const gate = deferred();
  let connectionCloseCount = 0;
  const requests: HermesChatRequest[] = [];
  const connection: HermesChatConnection = {
    closed: false,
    request: async (request) => {
      requests.push(request);
      if (request.method === "slash.exec") await gate.promise;
      return { method: request.method, value: { status: "ok" } };
    },
    close: async () => { connectionCloseCount += 1; },
  };
  const coordinator = new ChatSessionCoordinator();
  const staleOwner = {};
  const currentOwner = {};
  const claim = coordinator.claimResume(staleOwner, "coder", "stored-old");
  assert.ok(claim);
  assert.equal(coordinator.bind(claim, { storedSessionId: "stored-old", liveSessionId: "live" }, false), "bound");
  const staleToken = coordinator.liveLeaseToken(staleOwner, "live");
  assert.ok(staleToken);
  const hub = new ChatUpstreamHub(runtimeWithConnect(async () => connection), coordinator, 64 * 1024);
  let unrelatedUnavailable = 0;
  await hub.attach(staleOwner, { onEvent: () => undefined, onUnavailable: () => undefined });
  await hub.attach(currentOwner, { onEvent: () => undefined, onUnavailable: () => { unrelatedUnavailable += 1; } });

  const response = hub.requestOwnedSession(staleOwner, "live", staleToken, {
    method: "slash.exec", params: { session_id: "live", command: "/compact" },
  });
  await waitFor(() => requests.length === 1);
  assert.equal(coordinator.releaseLease(staleOwner, staleToken), true);
  const replacement = coordinator.claimResume(currentOwner, "coder", "stored-new");
  assert.ok(replacement);
  assert.equal(coordinator.bind(replacement, { storedSessionId: "stored-new", liveSessionId: "live" }, false), "bound");
  gate.resolve();

  await assert.rejects(response, (error: unknown) => error instanceof ChatCommitUnconfirmedError);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(connectionCloseCount, 0);
  assert.equal(unrelatedUnavailable, 0);
  await hub.request(currentOwner, { method: "complete.slash", params: { text: "/" } });
  assert.equal(requests.at(-1)?.method, "complete.slash");
  await hub.close();
});

test("a read-only slash timeout is not reported as an unconfirmed mutation", async () => {
  let connectionCloseCount = 0;
  const connection: HermesChatConnection = {
    closed: false,
    request: async (request) => {
      if (request.method === "slash.exec") {
        throw new HermesChatTransportError("timed_out", "read-only timeout");
      }
      return { method: request.method, value: { status: "ok" } };
    },
    close: async () => { connectionCloseCount += 1; },
  };
  const coordinator = new ChatSessionCoordinator();
  const owner = {};
  const claim = coordinator.claimResume(owner, "coder", "stored");
  assert.ok(claim);
  assert.equal(coordinator.bind(claim, { storedSessionId: "stored", liveSessionId: "live" }, false), "bound");
  const token = coordinator.liveLeaseToken(owner, "live");
  assert.ok(token);
  const hub = new ChatUpstreamHub(runtimeWithConnect(async () => connection), coordinator, 64 * 1024);
  await hub.attach(owner, { onEvent: () => undefined, onUnavailable: () => undefined });

  await assert.rejects(
    hub.requestOwnedSession(owner, "live", token, {
      method: "slash.exec", params: { session_id: "live", command: "/help" },
    }),
    (error: unknown) => error instanceof HermesChatTransportError && error.code === "timed_out",
  );
  assert.equal(connectionCloseCount, 0);
  await hub.close();
});

function runtimeWithConnect(connect: () => Promise<HermesChatConnection>): HermesRuntimeSource {
  return {
    chat: () => ({
      connect,
      inspectHistory: async ({ sessionId }: { sessionId: string }) => ({ sessionId, total: 0 }),
      fetchHistory: async () => { throw new Error("unused"); },
    }),
  } as unknown as HermesRuntimeSource;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition was not reached.");
}
