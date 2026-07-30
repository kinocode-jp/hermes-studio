import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import { HermesChatTransportError, type HermesChatEvent, type HermesChatRequest, type HermesChatResult } from "./hermes-chat.js";
import { ChatDeviceRateLimiter, handleOfficeChatConnection } from "./chat-gateway.js";
import { ChatSessionCoordinator, MAX_CHAT_SESSION_LEASES_PER_OWNER, MAX_CHAT_SESSION_LEASES_PER_PROFILE, MAX_CHAT_SESSION_LEASES_TOTAL } from "./chat-session-coordinator.js";
import { ChatUpstreamHub } from "./chat-upstream-hub.js";
import { OfficeAuth, type OfficeAuthSession } from "./office-auth.js";

const SESSION: OfficeAuthSession = {
  principal: { id: "race-test", tier: "operator", local: false, deviceName: "Race test" },
  csrfToken: "c".repeat(32), expiresAt: "2099-01-01T00:00:00.000Z",
};

test("a durable pending resume cannot be closed before its live identity binds", async () => {
  const { hermes, coordinator, dependencies } = setup();
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, dependencies);
  await settle();

  client.rpc(1, "session.resume", { session_id: "pending-only", profile: "coder" });
  await settle();
  client.rpc(2, "session.close", { session_id: "pending-only" });
  await settle();
  assert.equal(client.errorCode(2), -32000);
  assert.deepEqual(hermes.sessionCloseRequests, [], "closing an empty pending lease must not fabricate upstream work");

  hermes.resolvePendingOnly();
  await settle(4);
  assert.equal(client.errorCode(1), undefined);
  assert.ok(coordinator.ownerForLive("live-pending"));
  assert.equal(hermes.isLive("live-pending"), true);
});

test("disconnect fences a pending resume before replacement readiness and history", async () => {
  const { hermes, coordinator, dependencies } = setup();
  const hub = dependencies.chatHub as ChatUpstreamHub;
  const closeGate = deferred<void>();
  hermes.delayNextConnectionClose(closeGate.promise);
  const oldClient = new FakeWebSocket();
  handleOfficeChatConnection(oldClient as unknown as WebSocket, dependencies);
  await settle();
  oldClient.rpc(201, "session.resume", { session_id: "pending-only", profile: "coder" });
  await settle();
  oldClient.close(1006, "network lost during resume");

  let historyStarted = false;
  const history = hub.readStableHistory(async () => { historyStarted = true; return "fresh"; });
  const replacement = new FakeWebSocket();
  handleOfficeChatConnection(replacement as unknown as WebSocket, dependencies);
  await settle(4);
  assert.equal(historyStarted, false);
  assert.equal(replacement.frames().some(({ method }) => method === "office.ready"), false);

  hermes.resolvePendingOnly();
  await settle();
  closeGate.resolve();
  assert.equal(await history, "fresh");
  await settle(6);
  assert.equal(replacement.frames().some(({ method }) => method === "office.ready"), true);
  assert.equal(coordinator.ownerForLive("live-pending"), undefined, "the late result cannot bind after generation reset");
  assert.equal(hermes.isLive("live-pending"), false, "connection teardown reaps the late native session");

  replacement.rpc(202, "session.resume", { session_id: "parent", profile: "coder" });
  await settle(4);
  assert.equal(replacement.errorCode(202), undefined);
});

test("a detached pending resume settles and closes without resetting another owner", async () => {
  const { hermes, coordinator, dependencies } = setup();
  const stable = new FakeWebSocket();
  const pending = new FakeWebSocket();
  handleOfficeChatConnection(stable as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(pending as unknown as WebSocket, dependencies);
  await settle();

  stable.rpc(210, "session.resume", { session_id: "parent", profile: "coder" });
  await settle(4);
  const stableOwner = coordinator.ownerForLive("live-old");
  assert.ok(stableOwner);

  pending.rpc(211, "session.resume", { session_id: "pending-only", profile: "coder" });
  await settle();
  pending.close(1006, "network lost during resume");
  hermes.emit("live-old", "stable while peer settles");
  await settle(4);

  assert.equal(hermes.connectionCloseCount, 0);
  assert.equal(stable.closed, undefined);
  assert.equal(coordinator.ownerForLive("live-old"), stableOwner);
  assert.equal(stable.events("live-old").at(-1)?.payload?.text, "stable while peer settles");

  hermes.resolvePendingOnly();
  await settle(10);
  assert.deepEqual(hermes.sessionCloseRequests, ["live-pending"]);
  assert.equal(hermes.connectionCloseCount, 0, "a settled peer start is closed owner-locally");
  assert.equal(hermes.isLive("live-old"), true);
  assert.equal(coordinator.ownerForLive("live-old"), stableOwner);
  stable.rpc(212, "prompt.submit", { session_id: "live-old", text: "still routed" });
  await settle(4);
  assert.deepEqual(hermes.targetedRequests.at(-1), { method: "prompt.submit", sessionId: "live-old" });
});

test("an unsettled start times out behind cleanup barriers and explicitly resyncs peers", async () => {
  const { hermes, dependencies } = setup(5);
  const hub = dependencies.chatHub as ChatUpstreamHub;
  const stable = new FakeWebSocket(); const pending = new FakeWebSocket();
  handleOfficeChatConnection(stable as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(pending as unknown as WebSocket, dependencies); await settle();
  stable.rpc(220, "session.resume", { session_id: "parent", profile: "coder" }); await settle(4);
  pending.rpc(221, "session.resume", { session_id: "pending-only", profile: "coder" }); await settle();
  pending.close(1006, "unsettled start");
  let historyStarted = false;
  const history = hub.readStableHistory(async () => { historyStarted = true; return "after-fence"; });
  await settle(3); assert.equal(historyStarted, false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await history, "after-fence");
  assert.equal(stable.events("live-old").at(-1)?.payload?.status, "resync_required");
  assert.equal(stable.closed?.code, 1013); assert.equal(hermes.connectionCloseCount, 1);
  hermes.resolvePendingOnly(); await settle(4);
  const replacement = new FakeWebSocket();
  handleOfficeChatConnection(replacement as unknown as WebSocket, dependencies); await settle(4);
  assert.equal(replacement.frames().some(({ method }) => method === "office.ready"), true);
});

test("a guessed live close cannot race ahead of its pending resume on the same socket", async () => {
  const { hermes, coordinator, dependencies } = setup();
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, dependencies);
  await settle();

  client.rpc(3, "session.resume", { session_id: "pending-only", profile: "coder" });
  await settle();
  client.rpc(4, "session.close", { session_id: "live-pending" });
  await settle();
  assert.equal(client.errorCode(4), -32000);
  assert.deepEqual(hermes.sessionCloseRequests, []);

  hermes.resolvePendingOnly();
  await settle(4);
  assert.equal(client.errorCode(3), undefined);
  assert.ok(coordinator.ownerForLive("live-pending"));
  assert.equal(hermes.isLive("live-pending"), true);
});

test("another socket cannot close a guessed live id while resume is pending", async () => {
  const { hermes, coordinator, dependencies } = setup();
  const owner = new FakeWebSocket();
  const other = new FakeWebSocket();
  handleOfficeChatConnection(owner as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(other as unknown as WebSocket, dependencies);
  await settle();

  owner.rpc(5, "session.resume", { session_id: "pending-only", profile: "coder" });
  await settle();
  other.rpc(6, "session.close", { session_id: "live-pending" });
  await settle();
  assert.equal(other.errorCode(6), -32000);
  assert.deepEqual(hermes.sessionCloseRequests, []);

  hermes.resolvePendingOnly();
  await settle(4);
  assert.equal(owner.errorCode(5), undefined);
  assert.ok(coordinator.ownerForLive("live-pending"));
  assert.equal(hermes.isLive("live-pending"), true);
});

test("live-only commands reject unknown, durable, other-owner, and pending guessed targets", async () => {
  const methods = ["prompt.submit", "session.steer", "session.interrupt"] as const;
  const { hermes, dependencies } = setup();
  const owner = new FakeWebSocket();
  const other = new FakeWebSocket();
  handleOfficeChatConnection(owner as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(other as unknown as WebSocket, dependencies);
  await settle();
  owner.rpc(60, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();

  let id = 61;
  for (const target of ["unknown-live", "parent", "live-old"]) {
    for (const method of methods) other.rpc(id++, method, commandParams(method, target));
  }
  await settle(4);
  for (let rejected = 61; rejected < id; rejected += 1) assert.equal(other.errorCode(rejected), -32006);
  assert.deepEqual(hermes.targetedRequests, []);

  for (const method of methods) owner.rpc(id++, method, commandParams(method, "live-old"));
  await settle(4);
  assert.deepEqual(hermes.targetedRequests, methods.map((method) => ({ method, sessionId: "live-old" })));

  const pendingSetup = setup();
  const pendingOwner = new FakeWebSocket();
  const attacker = new FakeWebSocket();
  handleOfficeChatConnection(pendingOwner as unknown as WebSocket, pendingSetup.dependencies);
  handleOfficeChatConnection(attacker as unknown as WebSocket, pendingSetup.dependencies);
  await settle();
  pendingOwner.rpc(80, "session.resume", { session_id: "pending-only", profile: "coder" });
  await settle();
  for (const method of methods) attacker.rpc(id++, method, commandParams(method, "live-pending"));
  await settle();
  assert.deepEqual(pendingSetup.hermes.targetedRequests, []);
  pendingSetup.hermes.resolvePendingOnly();
  await settle(4);
  assert.ok(pendingSetup.coordinator.ownerForLive("live-pending"));
  assert.equal(pendingSetup.hermes.isLive("live-pending"), true);
});

test("unknown live and durable ids never reach explicit upstream close", async () => {
  const { hermes, dependencies } = setup();
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, dependencies);
  await settle();

  client.rpc(7, "session.close", { session_id: "unknown-live" });
  client.rpc(8, "session.close", { session_id: "unknown-durable" });
  await settle(4);
  assert.equal(client.errorCode(7), -32000);
  assert.equal(client.errorCode(8), -32000);
  assert.deepEqual(hermes.sessionCloseRequests, []);
});

test("an owned durable alias is not accepted by the live-only explicit close contract", async () => {
  const { hermes, coordinator, dependencies } = setup();
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, dependencies);
  await settle();
  client.rpc(9, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();
  client.rpc(10, "session.close", { session_id: "parent" });
  await settle(4);

  assert.equal(client.errorCode(10), -32000);
  assert.deepEqual(hermes.sessionCloseRequests, []);
  assert.equal(hermes.isLive("live-old"), true);
  assert.ok(coordinator.ownerForLive("live-old"));
});

test("one socket independently routes equal durable ids from two profiles", async () => {
  const { hermes, coordinator, dependencies } = setup();
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, dependencies);
  await settle();
  client.rpc(50, "session.resume", { session_id: "shared", profile: "alpha" });
  client.rpc(51, "session.resume", { session_id: "shared", profile: "beta" });
  await settle(4);

  assert.equal(client.errorCode(50), undefined);
  assert.equal(client.errorCode(51), undefined);
  assert.equal(coordinator.ownerForLive("live-alpha"), coordinator.ownerForLive("live-beta"));
  assert.ok(coordinator.ownerForLive("live-alpha"));

  hermes.emit("live-alpha", "alpha-event");
  hermes.emit("live-beta", "beta-event");
  await settle();
  assert.equal(client.events("live-alpha").at(-1)?.payload?.text, "alpha-event");
  assert.equal(client.events("live-beta").at(-1)?.payload?.text, "beta-event");

  client.rpc(52, "prompt.submit", { session_id: "live-alpha", text: "alpha-prompt" });
  client.rpc(53, "session.interrupt", { session_id: "live-beta" });
  await settle(4);
  assert.deepEqual(hermes.targetedRequests, [
    { method: "prompt.submit", sessionId: "live-alpha" },
    { method: "session.interrupt", sessionId: "live-beta" },
  ]);

  client.rpc(54, "session.close", { session_id: "live-alpha" });
  await settle(4);
  assert.deepEqual(hermes.sessionCloseRequests, ["live-alpha"]);
  assert.equal(coordinator.ownerForLive("live-alpha"), undefined);
  assert.ok(coordinator.ownerForLive("live-beta"));
  assert.equal(hermes.isLive("live-beta"), true);

  const betaEvents = client.events("live-beta").length;
  hermes.emit("live-alpha", "closed-alpha-event");
  hermes.emit("live-beta", "beta-continues");
  await settle();
  assert.equal(client.events("live-alpha").some((event) => event.payload?.text === "closed-alpha-event"), false);
  assert.equal(client.events("live-beta").length, betaEvents + 1);
  assert.equal(client.events("live-beta").at(-1)?.payload?.text, "beta-continues");
  client.rpc(57, "prompt.submit", { session_id: "live-beta", text: "still-running" });
  await settle();
  assert.deepEqual(hermes.targetedRequests.at(-1), { method: "prompt.submit", sessionId: "live-beta" });
});

test("two sockets independently own equal durable ids from different profiles", async () => {
  const { hermes, coordinator, dependencies } = setup();
  const alpha = new FakeWebSocket();
  const beta = new FakeWebSocket();
  handleOfficeChatConnection(alpha as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(beta as unknown as WebSocket, dependencies);
  await settle();
  alpha.rpc(55, "session.resume", { session_id: "shared", profile: "alpha" });
  beta.rpc(56, "session.resume", { session_id: "shared", profile: "beta" });
  await settle(4);

  assert.equal(alpha.errorCode(55), undefined);
  assert.equal(beta.errorCode(56), undefined);
  const alphaOwner = coordinator.ownerForLive("live-alpha");
  const betaOwner = coordinator.ownerForLive("live-beta");
  assert.ok(alphaOwner);
  assert.ok(betaOwner);
  assert.notEqual(alphaOwner, betaOwner);

  hermes.emit("live-alpha", "only-alpha");
  hermes.emit("live-beta", "only-beta");
  await settle();
  assert.equal(alpha.events("live-alpha").at(-1)?.payload?.text, "only-alpha");
  assert.equal(alpha.events("live-beta").length, 0);
  assert.equal(beta.events("live-beta").at(-1)?.payload?.text, "only-beta");
  assert.equal(beta.events("live-alpha").length, 0);
});

test("approval and clarification tokens do not cross same-owner live-id reuse", async () => {
  const { hermes, dependencies } = setup();
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, dependencies);
  await settle();
  client.rpc(85, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();
  hermes.publish({ type: "approval.request", sessionId: "live-old", payload: { choices: ["deny"], allowPermanent: false } });
  hermes.publish({ type: "clarify.request", sessionId: "live-old", payload: { requestId: "q-closed", question: "Closed?" } });
  await settle();
  const approvalId = client.approvalId("live-old");
  client.rpc(86, "session.close", { session_id: "live-old" });
  await settle(4);
  client.rpc(89, "session.resume", { session_id: "parent", profile: "coder" });
  await settle(4);
  client.rpc(87, "approval.respond", { session_id: "live-old", approval_id: approvalId, choice: "deny" });
  client.rpc(88, "clarify.respond", { request_id: "q-closed", answer: "no" });
  await settle(4);

  assert.equal(client.errorCode(87), -32004);
  assert.equal(client.errorCode(88), -32004);
  assert.deepEqual(hermes.interactionRequests, []);

  hermes.publish({ type: "approval.request", sessionId: "live-old", payload: { choices: ["once"], allowPermanent: false } });
  hermes.publish({ type: "clarify.request", sessionId: "live-old", payload: { requestId: "q-new-lease", question: "New?" } });
  await settle();
  client.rpc(81, "approval.respond", { session_id: "live-old", approval_id: client.approvalId("live-old"), choice: "once" });
  client.rpc(82, "clarify.respond", { request_id: "q-new-lease", answer: "yes" });
  await settle(4);
  assert.deepEqual(hermes.interactionRequests, ["approval.respond", "clarify.respond"]);
});

test("stale approval and clarification cannot cross close and live-id reuse", async () => {
  const { hermes, dependencies } = setup();
  const original = new FakeWebSocket();
  const replacement = new FakeWebSocket();
  handleOfficeChatConnection(original as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(replacement as unknown as WebSocket, dependencies);
  await settle();
  original.rpc(90, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();

  hermes.publish({ type: "approval.request", sessionId: "live-old", payload: { choices: ["once"], allowPermanent: false } });
  hermes.publish({ type: "clarify.request", sessionId: "live-old", payload: { requestId: "q-owned", question: "Continue?" } });
  await settle();
  original.rpc(91, "approval.respond", { session_id: "live-old", approval_id: original.approvalId("live-old"), choice: "once" });
  original.rpc(92, "clarify.respond", { request_id: "q-owned", answer: "yes" });
  await settle(4);
  assert.deepEqual(hermes.interactionRequests, ["approval.respond", "clarify.respond"]);

  hermes.publish({ type: "approval.request", sessionId: "live-old", payload: { choices: ["deny"], allowPermanent: false } });
  hermes.publish({ type: "clarify.request", sessionId: "live-old", payload: { requestId: "q-stale", question: "Stale?" } });
  await settle();
  const staleApprovalId = original.approvalId("live-old");
  original.rpc(93, "session.close", { session_id: "live-old" });
  await settle(4);
  replacement.rpc(94, "session.resume", { session_id: "parent", profile: "coder" });
  await settle(4);

  original.rpc(95, "approval.respond", { session_id: "live-old", approval_id: staleApprovalId, choice: "deny" });
  original.rpc(96, "clarify.respond", { request_id: "q-stale", answer: "no" });
  await settle(4);
  assert.equal(original.errorCode(95), -32004);
  assert.equal(original.errorCode(96), -32004);
  assert.deepEqual(hermes.interactionRequests, ["approval.respond", "clarify.respond"]);

  hermes.publish({ type: "approval.request", sessionId: "live-old", payload: { choices: ["once"], allowPermanent: false } });
  hermes.publish({ type: "clarify.request", sessionId: "live-old", payload: { requestId: "q-reused", question: "New owner?" } });
  await settle();
  replacement.rpc(97, "approval.respond", { session_id: "live-old", approval_id: replacement.approvalId("live-old"), choice: "once" });
  replacement.rpc(98, "clarify.respond", { request_id: "q-reused", answer: "yes" });
  await settle(4);
  assert.deepEqual(hermes.interactionRequests, [
    "approval.respond", "clarify.respond", "approval.respond", "clarify.respond",
  ]);
});

test("failed claimed interactions cannot restore across same-owner lease reuse", async () => {
  const { hermes, dependencies } = setup();
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, dependencies);
  await settle();
  client.rpc(100, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();
  hermes.publish({ type: "approval.request", sessionId: "live-old", payload: { choices: ["once"], allowPermanent: false } });
  hermes.publish({ type: "clarify.request", sessionId: "live-old", payload: { requestId: "q-generation", question: "Old?" } });
  await settle();
  hermes.holdInteractions();
  client.rpc(101, "approval.respond", { session_id: "live-old", approval_id: client.approvalId("live-old"), choice: "once" });
  client.rpc(102, "clarify.respond", { request_id: "q-generation", answer: "old" });
  await settle();

  client.rpc(103, "session.close", { session_id: "live-old" });
  await settle(4);
  client.rpc(104, "session.resume", { session_id: "parent", profile: "coder" });
  await settle(4);
  hermes.publish({ type: "approval.request", sessionId: "live-old", payload: { choices: ["deny"], allowPermanent: false } });
  hermes.publish({ type: "clarify.request", sessionId: "live-old", payload: { requestId: "q-generation", question: "New?" } });
  await settle();
  const newApprovalId = client.approvalId("live-old");
  hermes.rejectHeldInteractions();
  await settle(4);
  assert.equal(client.errorCode(101), -32008);
  assert.equal(client.errorCode(102), -32008);

  client.rpc(105, "approval.respond", { session_id: "live-old", approval_id: newApprovalId, choice: "deny" });
  client.rpc(106, "clarify.respond", { request_id: "q-generation", answer: "new" });
  await settle(4);
  assert.equal(client.errorCode(105), undefined);
  assert.equal(client.errorCode(106), undefined);
  assert.deepEqual(hermes.interactionRequests, [
    "approval.respond", "clarify.respond", "approval.respond", "clarify.respond",
  ]);
});

test("durable aliases stay profile-scoped when a live id collides globally", () => {
  const coordinator = new ChatSessionCoordinator();
  const alphaOwner = {};
  const betaOwner = {};
  const alpha = coordinator.claimResume(alphaOwner, "alpha", "shared");
  const beta = coordinator.claimResume(betaOwner, "beta", "shared");
  assert.ok(alpha);
  assert.ok(beta);
  assert.equal(coordinator.bind(alpha, { storedSessionId: "alpha-tip", liveSessionId: "live-shared" }, false), "bound");
  assert.equal(coordinator.bind(beta, { storedSessionId: "beta-tip", liveSessionId: "live-shared" }, false), "conflict");
  assert.equal(coordinator.ownerForLive("live-shared"), alphaOwner);

  const alphaMustNotLearnBetaAlias = coordinator.claimResume({}, "alpha", "beta-tip");
  assert.ok(alphaMustNotLearnBetaAlias);
  coordinator.releaseFailedClaim(alphaMustNotLearnBetaAlias);
  const betaRetry = coordinator.claimResume(betaOwner, "beta", "shared");
  assert.ok(betaRetry);
  coordinator.releaseFailedClaim(betaRetry);
});

test("session coordinator bounds owner and process-wide pending leases", () => {
  const coordinator = new ChatSessionCoordinator();
  const owners = Array.from({ length: MAX_CHAT_SESSION_LEASES_TOTAL / MAX_CHAT_SESSION_LEASES_PER_OWNER }, () => ({}));
  for (const [ownerIndex, owner] of owners.entries()) {
    for (let leaseIndex = 0; leaseIndex < MAX_CHAT_SESSION_LEASES_PER_OWNER; leaseIndex += 1) {
      assert.ok(coordinator.claimCreate(owner, `profile-${ownerIndex}-${leaseIndex}`));
    }
  }
  assert.equal(coordinator.canCreateLease({}), false);
  assert.throws(() => coordinator.claimCreate({}, "overflow"), /lease limit/);
  coordinator.releaseOwner(owners[0]!);
  assert.equal(coordinator.canCreateLease({}), true);
});

test("session coordinator bounds one profile without blocking another profile for the same owner", () => {
  const coordinator = new ChatSessionCoordinator();
  const owner = {};
  for (let index = 0; index < MAX_CHAT_SESSION_LEASES_PER_PROFILE; index += 1) {
    coordinator.claimCreate(owner, "default");
  }
  assert.equal(coordinator.canCreateLease(owner, "default"), false);
  assert.equal(coordinator.canCreateLease(owner, "dragonite"), true);
});

test("an owned close reservation blocks rebind after a lease release TOCTOU", () => {
  const coordinator = new ChatSessionCoordinator();
  const oldOwner = {};
  const first = coordinator.claimCreate(oldOwner, "coder");
  assert.equal(coordinator.bind(first, { storedSessionId: "stored", liveSessionId: "live" }, true), "bound");
  const snapshot = coordinator.leaseForSession(oldOwner, "live");
  assert.ok(snapshot);
  const closeToken = coordinator.claimOwnedLeaseClose(oldOwner, snapshot);
  assert.ok(closeToken);
  assert.equal(coordinator.releaseLease(oldOwner, snapshot.token), true);

  const racingOwner = {};
  const racing = coordinator.claimResume(racingOwner, "coder", "stored");
  assert.ok(racing);
  assert.equal(coordinator.bind(racing, { storedSessionId: "stored", liveSessionId: "live" }, false), "conflict");
  assert.equal(coordinator.ownerForLive("live"), undefined);

  coordinator.finishOwnedLeaseClose(snapshot, closeToken);
  const retry = coordinator.claimResume(racingOwner, "coder", "stored");
  assert.ok(retry);
  assert.equal(coordinator.bind(retry, { storedSessionId: "stored", liveSessionId: "live" }, false), "bound");
  assert.equal(coordinator.ownerForLive("live"), racingOwner);
});

test("a late duplicate result is closed after its old bound lease was explicitly closed", async () => {
  const { hermes, coordinator, dependencies } = setup();
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, dependencies);
  await settle();
  client.rpc(10, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();
  hermes.holdNextParentResume();
  client.rpc(11, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();
  client.rpc(12, "session.close", { session_id: "live-old" });
  await settle();
  assert.equal(client.errorCode(12), undefined);
  assert.equal(coordinator.ownerForLive("live-old"), undefined);

  hermes.resolveParentDuplicate();
  await settle(4);
  assert.equal(client.errorCode(11), -32000);
  assert.deepEqual(hermes.sessionCloseRequests, ["live-old", "live-new"]);
  assert.deepEqual(hermes.liveIds(), []);
  assert.equal(client.events("live-new").length, 0);
});

test("an invalid create with a live id closes the unowned session", async () => {
  const { hermes, dependencies } = setup();
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, dependencies);
  await settle();
  client.rpc(20, "session.create", { profile: "coder", title: "Invalid identity" });
  await settle();

  assert.equal(client.errorCode(20), -32000);
  assert.deepEqual(hermes.sessionCloseRequests, ["live-invalid"]);
  assert.equal(hermes.isLive("live-invalid"), false);
  assert.equal(client.events("live-invalid").length, 0);
});

test("a new-chat create never accepts a resumed durable identity", async () => {
  const { hermes, dependencies } = setup();
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, dependencies);
  await settle();
  client.rpc(21, "session.create", { profile: "coder", title: "Resumed identity" });
  await settle();

  assert.equal(client.errorCode(21), -32000);
  assert.deepEqual(hermes.sessionCloseRequests, ["live-resumed-create"]);
  assert.equal(hermes.isLive("live-resumed-create"), false);
});

test("an authoritative already-absent close result does not reset existing owners", async () => {
  const { hermes, coordinator, dependencies } = setup();
  const owner = new FakeWebSocket();
  const invalid = new FakeWebSocket();
  handleOfficeChatConnection(owner as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(invalid as unknown as WebSocket, dependencies);
  await settle();
  owner.rpc(25, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();
  invalid.rpc(26, "session.create", { profile: "coder", title: "Invalid absent identity" });
  await settle(4);

  assert.equal(invalid.errorCode(26), -32000);
  assert.deepEqual(hermes.sessionCloseRequests, ["live-invalid-absent"]);
  assert.ok(coordinator.ownerForLive("live-old"));
  assert.equal(owner.closed, undefined);
  assert.equal(hermes.connectionCloseCount, 0);
  assert.equal(invalid.events("live-invalid-absent").length, 0);
});

test("an invalid-result close failure resets the generation and reaps existing owners", async () => {
  const { hermes, dependencies } = setup();
  const owner = new FakeWebSocket();
  const invalid = new FakeWebSocket();
  handleOfficeChatConnection(owner as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(invalid as unknown as WebSocket, dependencies);
  await settle();
  owner.rpc(30, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();
  hermes.failCloseFor.add("live-invalid");
  invalid.rpc(31, "session.create", { profile: "coder", title: "Invalid identity" });
  await settle(6);

  assert.deepEqual(hermes.sessionCloseRequests, ["live-invalid"]);
  assert.equal(owner.events("live-old").at(-1)?.payload?.status, "resync_required");
  assert.equal(owner.closed?.code, 1013);
  assert.equal(invalid.closed?.code, 1013);
  assert.equal(hermes.connectionCloseCount, 1);
  assert.deepEqual(hermes.liveIds(), []);
});

test("a create result without any live id resets the ambiguous shared generation", async () => {
  const { hermes, dependencies } = setup();
  const owner = new FakeWebSocket();
  const ambiguous = new FakeWebSocket();
  handleOfficeChatConnection(owner as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(ambiguous as unknown as WebSocket, dependencies);
  await settle();
  owner.rpc(40, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();
  ambiguous.rpc(41, "session.create", { profile: "coder", title: "Missing live identity" });
  await settle(6);

  assert.deepEqual(hermes.sessionCloseRequests, [], "an unknown live id cannot be guessed for explicit close");
  assert.equal(owner.events("live-old").at(-1)?.payload?.status, "resync_required");
  assert.equal(owner.closed?.code, 1013);
  assert.equal(ambiguous.closed?.code, 1013);
  assert.equal(hermes.connectionCloseCount, 1);
  assert.deepEqual(hermes.liveIds(), []);
});

test("a resume result without any live id also resets the ambiguous shared generation", async () => {
  const { hermes, dependencies } = setup();
  const owner = new FakeWebSocket();
  const ambiguous = new FakeWebSocket();
  handleOfficeChatConnection(owner as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(ambiguous as unknown as WebSocket, dependencies);
  await settle();
  owner.rpc(45, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();
  ambiguous.rpc(46, "session.resume", { session_id: "missing-live", profile: "coder" });
  await settle(6);

  assert.deepEqual(hermes.sessionCloseRequests, [], "an unknown live id cannot be guessed for explicit close");
  assert.equal(owner.events("live-old").at(-1)?.payload?.status, "resync_required");
  assert.equal(owner.closed?.code, 1013);
  assert.equal(ambiguous.closed?.code, 1013);
  assert.equal(hermes.connectionCloseCount, 1);
  assert.deepEqual(hermes.liveIds(), []);
});

function setup(pendingSessionSettlementMs?: number): {
  hermes: RaceFakeHermes;
  coordinator: ChatSessionCoordinator;
  dependencies: Parameters<typeof handleOfficeChatConnection>[1];
} {
  const hermes = new RaceFakeHermes();
  const coordinator = new ChatSessionCoordinator();
  const runtime = hermes.runtime();
  return {
    hermes,
    coordinator,
    dependencies: {
      auth: new OfficeAuth(), officeSession: SESSION, runtimeSource: runtime,
      maxJsonBytes: 64 * 1024, deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
      sessionCoordinator: coordinator, chatHub: new ChatUpstreamHub(runtime, coordinator, 64 * 1024,
        pendingSessionSettlementMs === undefined ? {} : { pendingSessionSettlementMs }),
    },
  };
}

class RaceFakeHermes {
  readonly sessionCloseRequests: string[] = [];
  readonly targetedRequests: Array<{ method: string; sessionId: string }> = [];
  readonly interactionRequests: string[] = [];
  readonly failCloseFor = new Set<string>();
  connectionCloseCount = 0;
  readonly #live = new Set<string>();
  #event: ((event: HermesChatEvent) => void) | undefined;
  #closed = false;
  #pendingOnly: ((result: HermesChatResult) => void) | undefined;
  #pendingParent: ((result: HermesChatResult) => void) | undefined;
  #holdParent = false;
  #nextConnectionClose: Promise<void> | undefined;
  #holdInteractionResponses = false;
  readonly #heldInteractionRejects: Array<(error: Error) => void> = [];

  runtime(): HermesRuntimeSource {
    return {
      chat: () => ({
        connect: async (onEvent: (event: HermesChatEvent) => void) => {
          this.#event = onEvent;
          this.#closed = false;
          return {
            get closed() { return false; },
            request: async (request: HermesChatRequest) => await this.#request(request),
            close: async () => {
              this.connectionCloseCount += 1;
              const gate = this.#nextConnectionClose;
              this.#nextConnectionClose = undefined;
              await gate;
              this.#closed = true;
              this.#live.clear();
            },
          };
        },
        inspectHistory: async ({ sessionId }: { sessionId: string }) => ({ sessionId, total: 0 }),
        fetchHistory: async () => { throw new Error("unused"); },
      }),
    } as unknown as HermesRuntimeSource;
  }

  isLive(liveId: string): boolean { return this.#live.has(liveId); }
  liveIds(): string[] { return [...this.#live]; }
  emit(liveId: string, text: string): void {
    this.#event?.({ type: "message.delta", sessionId: liveId, payload: { text } });
  }
  publish(event: HermesChatEvent): void { this.#event?.(event); }
  holdNextParentResume(): void { this.#holdParent = true; }
  delayNextConnectionClose(gate: Promise<void>): void { this.#nextConnectionClose = gate; }
  holdInteractions(): void { this.#holdInteractionResponses = true; }
  rejectHeldInteractions(): void {
    this.#holdInteractionResponses = false;
    for (const reject of this.#heldInteractionRejects.splice(0)) reject(new Error("held interaction failed"));
  }
  resolvePendingOnly(): void {
    this.#live.add("live-pending");
    this.#pendingOnly?.({ method: "session.resume", value: sessionValue("live-pending", "pending-only") });
    this.#pendingOnly = undefined;
  }
  resolveParentDuplicate(): void {
    this.#live.add("live-new");
    this.#pendingParent?.({ method: "session.resume", value: sessionValue("live-new", "parent") });
    this.#pendingParent = undefined;
  }

  async #request(request: HermesChatRequest): Promise<HermesChatResult> {
    if (this.#closed) throw new Error("generation closed");
    if (request.method === "prompt.submit" || request.method === "session.steer" || request.method === "session.interrupt") {
      this.targetedRequests.push({ method: request.method, sessionId: String(request.params?.session_id) });
      return { method: request.method, value: { status: "ok" } };
    }
    if (request.method === "approval.respond" || request.method === "clarify.respond") {
      this.interactionRequests.push(request.method);
      if (this.#holdInteractionResponses) {
        return await new Promise<HermesChatResult>((_resolve, reject) => { this.#heldInteractionRejects.push(reject); });
      }
      return request.method === "approval.respond"
        ? { method: request.method, value: { resolved: true } }
        : { method: request.method, value: { status: "ok" } };
    }
    if (request.method === "session.close") {
      const liveId = String(request.params?.session_id);
      this.sessionCloseRequests.push(liveId);
      if (this.failCloseFor.has(liveId)) throw new HermesChatTransportError("timed_out", "fake close timeout");
      return { method: request.method, value: { closed: this.#live.delete(liveId) } };
    }
    if (request.method === "session.create") {
      if (request.params?.title === "Resumed identity") {
        this.#live.add("live-resumed-create");
        return { method: request.method, value: { liveSessionId: "live-resumed-create", resumedSessionId: "old-durable", running: false } };
      }
      if (request.params?.title === "Invalid identity") {
        this.#live.add("live-invalid");
        this.#event?.({ type: "message.delta", sessionId: "live-invalid", payload: { text: "must be discarded" } });
        return { method: request.method, value: { liveSessionId: "live-invalid", running: false } };
      }
      if (request.params?.title === "Invalid absent identity") {
        this.#event?.({ type: "message.delta", sessionId: "live-invalid-absent", payload: { text: "must be discarded" } });
        return { method: request.method, value: { liveSessionId: "live-invalid-absent", running: false } };
      }
      if (request.params?.title === "Missing live identity") {
        this.#live.add("live-ambiguous");
        return { method: request.method, value: { storedSessionId: "stored-ambiguous", running: false } };
      }
    }
    if (request.method === "session.resume") {
      const storedId = String(request.params?.session_id);
      if (storedId === "shared") {
        const profile = String(request.params?.profile);
        const liveId = `live-${profile}`;
        this.#live.add(liveId);
        return { method: request.method, value: sessionValue(liveId, storedId) };
      }
      if (storedId === "pending-only") {
        return await new Promise<HermesChatResult>((resolve) => { this.#pendingOnly = resolve; });
      }
      if (storedId === "parent" && this.#holdParent) {
        this.#holdParent = false;
        return await new Promise<HermesChatResult>((resolve) => { this.#pendingParent = resolve; });
      }
      if (storedId === "missing-live") {
        this.#live.add("live-ambiguous-resume");
        return { method: request.method, value: { storedSessionId: storedId, running: false } };
      }
      this.#live.add("live-old");
      return { method: request.method, value: sessionValue("live-old", storedId) };
    }
    return { method: request.method, value: { status: "ok" } };
  }
}

function sessionValue(liveSessionId: string, storedSessionId: string): Record<string, boolean | string> {
  return { liveSessionId, storedSessionId, running: false, status: "idle" };
}

function commandParams(method: "prompt.submit" | "session.steer" | "session.interrupt", sessionId: string): Record<string, unknown> {
  return method === "session.interrupt" ? { session_id: sessionId } : { session_id: sessionId, text: "test" };
}

class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closed?: { code: number; reason: string };
  send(body: string, callback?: (error?: Error) => void): void { this.sent.push(body); callback?.(); }
  close(code: number, reason: string): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.closed = { code, reason };
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
  rpc(id: number, method: string, params: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params })), false);
  }
  errorCode(id: number): number | undefined {
    return (this.frames().find((frame) => frame.id === id)?.error as { code?: number } | undefined)?.code;
  }
  approvalId(liveId: string): string {
    return String([...this.events(liveId)].reverse().find((event) => event.type === "approval.request")?.payload?.approvalId ?? "");
  }
  events(liveId: string): Array<{ type: string | undefined; payload: Record<string, unknown> | undefined }> {
    return this.frames().flatMap((frame) => {
      const params = frame.params as { sessionId?: string; type?: string; payload?: Record<string, unknown> } | undefined;
      return frame.method === "event" && params?.sessionId === liveId ? [{ type: params.type, payload: params.payload }] : [];
    });
  }
  frames(): Array<Record<string, unknown>> { return this.sent.map((body) => JSON.parse(body) as Record<string, unknown>); }
}

async function settle(turns = 2): Promise<void> {
  for (let index = 0; index < turns; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
