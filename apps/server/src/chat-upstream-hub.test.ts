import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import {
  HermesChatTransportError,
  type HermesChatEvent,
  type HermesChatRequest,
  type HermesChatResult,
} from "./hermes-chat.js";
import { ChatDeviceRateLimiter, handleOfficeChatConnection } from "./chat-gateway.js";
import { ChatSessionCoordinator, type ChatSessionLeaseSnapshot, type ChatSessionOwner } from "./chat-session-coordinator.js";
import { ChatUpstreamHub } from "./chat-upstream-hub.js";
import { OfficeAuth, type OfficeAuthSession } from "./office-auth.js";

const SESSION: OfficeAuthSession = {
  principal: { id: "hub-test", tier: "operator", local: false, deviceName: "Hub test" },
  csrfToken: "c".repeat(32), expiresAt: "2099-01-01T00:00:00.000Z",
};

test("shared hub preserves native targets, merges unseen aliases, and routes only to the live owner", async () => {
  const hermes = new NativeFakeHermes();
  const coordinator = new ChatSessionCoordinator();
  const hub = new ChatUpstreamHub(hermes.runtime(), coordinator, 64 * 1024);
  const dependencies = {
    auth: new OfficeAuth(), officeSession: SESSION, runtimeSource: hermes.runtime(),
    maxJsonBytes: 64 * 1024, deviceLimiter: new ChatDeviceRateLimiter({ capacity: 200, ratePerSecond: 0 }),
    sessionCoordinator: coordinator, chatHub: hub, limits: { socketRateCapacity: 100 },
  };
  const a = new FakeWebSocket();
  const b = new FakeWebSocket();
  handleOfficeChatConnection(a as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(b as unknown as WebSocket, dependencies);
  await settle();
  assert.equal(hermes.connectCount, 1, "all Browser sockets must share one Hermes connection");

  a.rpc(1, "session.resume", { session_id: "parent", profile: "coder" });
  b.rpc(20, "session.resume", { session_id: "unrelated-b", profile: "reviewer" });
  await settle();
  assert.equal(a.errorCode(1), undefined);
  assert.equal(hermes.resumeRequests[0]?.sessionId, "parent", "Office must not rewrite native resume to a generic descendant");
  assert.equal(hermes.resumeRequests[0]?.closeOnDisconnect, true);
  assert.equal(a.events("live-main").some(({ type }) => type === "message.delta"), true);
  assert.equal(b.events("live-main").length, 0);
  assert.ok(a.frameIndex(1) < a.eventFrameIndex("live-main"), "pre-bind events must flush only after the resume result");
  assert.equal(b.errorCode(20), undefined, "an unrelated remote resume must remain available concurrently");
  assert.ok(b.frameIndex(20) < b.eventFrameIndex("live-b"), "a pre-bind approval must follow the owning resume result");

  hermes.steerStatus = "turn_ended";
  a.rpc(91, "session.steer", { session_id: "live-main", text: "ambiguous upstream result" });
  await settle();
  assert.equal(a.errorCode(91), -32008, "upstream turn_ended after steer send is commit-ambiguous, not safe promotion evidence");
  assert.equal(a.frames().find((frame) => frame.id === 91)?.result, undefined);
  hermes.steerStatus = "ok";

  for (const nativeTarget of ["branch-child", "delegate-child", "tool-child"]) {
    a.rpc(10 + hermes.resumeRequests.length, "session.resume", { session_id: nativeTarget, profile: "coder" });
    await settle();
    assert.equal(hermes.resumeRequests.at(-1)?.sessionId, nativeTarget);
  }
  a.rpc(29, "session.close", { session_id: "live-branch-child" });
  await settle();
  assert.equal(a.events("live-b").length, 0);
  hermes.emit({ type: "status.update", sessionId: "live-b", payload: { status: "running" } });
  assert.equal(b.events("live-b").filter(({ type }) => type === "status.update").length, 1);
  assert.equal(a.events("live-b").length, 0);
  b.rpc(18, "session.create", { profile: "reviewer", title: "Unrelated new chat" });
  await settle();
  assert.equal(b.errorCode(18), undefined, "unrelated create stays available while another owner is live");
  assert.equal(hermes.createRequests[0]?.closeOnDisconnect, true);
  a.rpc(19, "session.resume", { session_id: "overflow", profile: "coder" });
  await settle();
  assert.equal(a.events("live-overflow").at(-1)?.payload?.status, "resync_required");
  a.rpc(30, "session.close", { session_id: "live-overflow" });
  await settle();
  hermes.rotateMainWithoutEvent();
  const resumeCount = hermes.resumeRequests.length;
  a.rpc(21, "session.resume", { session_id: "rotated-tip", profile: "coder" });
  await settle();
  assert.equal(a.errorCode(21), -32006, "a duplicate rotated pane must converge without replacing the original pane route");
  assert.equal(a.closed, undefined);
  assert.equal(hermes.resumeRequests.length, resumeCount + 1, "the unseen alias is learned from the native response");
  assert.equal(hermes.sessionCloseRequests.includes("live-main"), false, "a known live id must never be closed as a duplicate");
  a.rpc(26, "session.resume", { session_id: "rotated-live-tip", profile: "coder" });
  await settle();
  assert.equal(a.errorCode(26), -32006);
  assert.equal(a.events("live-main-rotated").length, 0, "a duplicate live session must never feed the established pane");
  assert.equal(hermes.sessionCloseRequests.includes("live-main-rotated"), true);
  assert.equal(hermes.isLive("live-main-rotated"), false);
  assert.equal(hermes.isLive("live-main"), true, "closing the duplicate must preserve the established live session");
  b.rpc(22, "session.resume", { session_id: "rotated-tip", profile: "coder" });
  await settle();
  assert.equal(b.errorCode(22), -32006);
  assert.equal(hermes.resumeRequests.length, resumeCount + 2, "the merged alias must reject later owners before upstream I/O");
  hermes.emit({ type: "message.delta", sessionId: "live-main", payload: { text: "still A" } });
  assert.equal(a.events("live-main").at(-1)?.payload?.text, "still A");

  hermes.emit({
    type: "message.start",
    sessionId: "live-main",
    payload: { eventId: "upstream-event", messageId: "correlated-reply" },
  });
  hermes.emit({ type: "tool.start", sessionId: "live-main", payload: { name: "First" } });
  hermes.emit({ type: "tool.start", sessionId: "live-main", payload: { name: "Second" } });
  hermes.emit({ type: "tool.complete", sessionId: "live-main", payload: { name: "First", summary: "first done" } });
  hermes.emit({ type: "tool.complete", sessionId: "live-main", payload: { name: "Second", summary: "second done" } });
  hermes.emit({ type: "message.complete", sessionId: "live-main", payload: { messageId: "correlated-reply", text: "done" } });
  const correlated = a.events("live-main").slice(-6);
  assert.equal(typeof correlated[0]?.payload?.eventId, "string");
  assert.notEqual(correlated[0]?.payload?.eventId, "upstream-event", "upstream ids cannot bypass Office correlation");
  assert.equal(correlated[0]?.payload?.upstreamEventId, "upstream-event");
  assert.equal(typeof correlated[0]?.payload?.eventSequence, "number");
  assert.equal(typeof correlated[0]?.payload?.correlationEpoch, "string");
  assert.equal(correlated[0]?.payload?.runId, correlated[5]?.payload?.runId);
  assert.equal(correlated[0]?.payload?.runSequence, correlated[5]?.payload?.runSequence);
  assert.notEqual(correlated[1]?.payload?.toolOccurrenceId, correlated[2]?.payload?.toolOccurrenceId);
  assert.equal(correlated[1]?.payload?.toolOccurrenceId, correlated[3]?.payload?.toolOccurrenceId);
  assert.equal(correlated[2]?.payload?.toolOccurrenceId, correlated[4]?.payload?.toolOccurrenceId);
  const completedRunId = correlated[5]?.payload?.runId;
  a.rpc(90, "session.steer", { session_id: "live-main", text: "too late" });
  await settle();
  assert.equal(
    (a.frames().find((frame) => frame.id === 90)?.result as { status?: string } | undefined)?.status,
    "turn_ended",
    "a steer after Office observed the terminal fence is safely promoted by the Browser instead of orphaned upstream",
  );
  hermes.emit({
    type: "message.delta",
    sessionId: "live-main",
    payload: { messageId: "correlated-reply", text: "unknown completed-source frame" },
  });
  assert.equal(
    a.events("live-main").at(-1)?.payload?.status,
    "resync_required",
    "an unseen frame cannot reuse the source id of a completed run",
  );
  hermes.emit({ type: "message.start", sessionId: "live-main", payload: {} });
  hermes.emit({ type: "message.complete", sessionId: "live-main", payload: { text: "anonymous history" } });
  hermes.emit({ type: "message.delta", sessionId: "live-main", payload: { text: "unknown anonymous idle frame" } });
  assert.equal(
    a.events("live-main").at(-1)?.payload?.status,
    "resync_required",
    "an unseen id-less frame cannot be assigned to the most recent anonymous completed run",
  );
  hermes.emit({ type: "message.start", sessionId: "live-main", payload: { messageId: "correlated-reply" } });
  assert.equal(a.events("live-main").at(-1)?.payload?.runId, completedRunId, "a delayed start reuses its terminal run id");
  a.rpc(31, "prompt.submit", { session_id: "live-main", text: "new run" });
  await settle();
  hermes.emit({ type: "message.delta", sessionId: "live-main", payload: { messageId: "correlated-reply", text: "delayed old delta" } });
  assert.equal(a.events("live-main").at(-1)?.payload?.status, "resync_required", "a delayed delta cannot claim a prepared run");
  hermes.emit({ type: "message.start", sessionId: "live-main", payload: { messageId: "correlated-reply-new" } });
  assert.notEqual(a.events("live-main").at(-1)?.payload?.runId, completedRunId, "an accepted prompt reserves a fresh run id");
  hermes.emit({ type: "message.delta", sessionId: "live-main", payload: { text: "delayed anonymous delta" } });
  assert.equal(
    a.events("live-main").at(-1)?.payload?.status,
    "resync_required",
    "an id-less frame cannot join an observed run after anonymous completed history exists",
  );
  hermes.emit({ type: "tool.start", sessionId: "live-main", payload: { name: "First" } });
  assert.equal(
    a.events("live-main").at(-1)?.payload?.status,
    "resync_required",
    "a completed anonymous tool start cannot be replayed into an observed run",
  );
  hermes.emit({
    type: "tool.progress",
    sessionId: "live-main",
    payload: { name: "DelayedAnonymous", status: "late progress" },
  });
  assert.equal(
    a.events("live-main").at(-1)?.payload?.status,
    "resync_required",
    "an unmatched anonymous frame cannot establish a new occurrence after anonymous history exists",
  );
  hermes.emit({ type: "tool.start", sessionId: "live-main", payload: { toolId: "explicit-tool", name: "Shell" } });
  hermes.emit({ type: "tool.complete", sessionId: "live-main", payload: { toolId: "explicit-tool", name: "Shell", summary: "done" } });
  const completedToolEvent = a.events("live-main").at(-1)!;
  hermes.emit({ type: "tool.progress", sessionId: "live-main", payload: { toolId: "explicit-tool", name: "Shell", status: "unexpected new frame" } });
  assert.equal(
    a.events("live-main").at(-1)?.payload?.status,
    "resync_required",
    "an unseen frame cannot reuse the id of a completed occurrence",
  );
  hermes.emit({ type: "tool.start", sessionId: "live-main", payload: { toolId: "repeat-1", name: "Repeat" } });
  const firstRepeatedToolStart = a.events("live-main").at(-1)!;
  hermes.emit({ type: "tool.complete", sessionId: "live-main", payload: { toolId: "repeat-1", name: "Repeat", summary: "first repeat done" } });
  hermes.emit({ type: "tool.start", sessionId: "live-main", payload: { toolId: "repeat-2", name: "Repeat" } });
  const secondRepeatedToolStart = a.events("live-main").at(-1)!;
  assert.notEqual(
    firstRepeatedToolStart.payload?.toolOccurrenceId,
    secondRepeatedToolStart.payload?.toolOccurrenceId,
    "sequential same-name tools with stable call ids remain distinct valid occurrences",
  );
  assert.notEqual(secondRepeatedToolStart.payload?.status, "resync_required");
  hermes.emit({ type: "tool.complete", sessionId: "live-main", payload: { toolId: "repeat-2", name: "Repeat", summary: "second repeat done" } });
  hermes.emit({
    type: "tool.start",
    sessionId: "live-main",
    payload: { toolId: "phase-call-1", toolIds: ["phase-call-1", "phase-shared"], name: "Phased" },
  });
  const firstPhaseStart = a.events("live-main").at(-1)!;
  hermes.emit({
    type: "tool.progress",
    sessionId: "live-main",
    payload: { toolId: "phase-shared", toolIds: ["phase-shared"], name: "Phased", status: "working" },
  });
  assert.equal(
    a.events("live-main").at(-1)?.payload?.toolOccurrenceId,
    firstPhaseStart.payload?.toolOccurrenceId,
    "a later phase may identify the same tool through a secondary alias",
  );
  hermes.emit({
    type: "tool.complete",
    sessionId: "live-main",
    payload: { toolId: "phase-shared", toolIds: ["phase-shared"], name: "Phased", summary: "phase one done" },
  });
  assert.equal(a.events("live-main").at(-1)?.payload?.toolOccurrenceId, firstPhaseStart.payload?.toolOccurrenceId);
  hermes.emit({
    type: "tool.start",
    sessionId: "live-main",
    payload: { toolId: "phase-call-2", toolIds: ["phase-call-2", "phase-shared"], name: "Phased" },
  });
  const secondPhaseStart = a.events("live-main").at(-1)!;
  assert.notEqual(secondPhaseStart.payload?.toolOccurrenceId, firstPhaseStart.payload?.toolOccurrenceId);
  hermes.emit({
    type: "tool.complete",
    sessionId: "live-main",
    payload: { toolId: "phase-shared", toolIds: ["phase-shared"], name: "Phased", summary: "phase two done" },
  });
  assert.equal(
    a.events("live-main").at(-1)?.payload?.toolOccurrenceId,
    secondPhaseStart.payload?.toolOccurrenceId,
    "an open occurrence wins over a completed call that shares only a secondary alias",
  );
  hermes.emit({ type: "tool.start", sessionId: "live-main", payload: { toolId: "unlinked-open", name: "Unlinked" } });
  hermes.emit({
    type: "tool.progress",
    sessionId: "live-main",
    payload: { toolId: "unlinked-new", name: "Unlinked", status: "working" },
  });
  assert.equal(
    a.events("live-main").at(-1)?.payload?.status,
    "resync_required",
    "a new stable id cannot be joined to an open occurrence by name alone",
  );
  hermes.emit({
    type: "tool.start",
    sessionId: "live-main",
    payload: { toolId: "collision-old", toolIds: ["collision-old", "collision-shared"], name: "Collision" },
  });
  hermes.emit({
    type: "tool.complete",
    sessionId: "live-main",
    payload: { toolId: "collision-shared", toolIds: ["collision-shared"], name: "Collision", summary: "old done" },
  });
  hermes.emit({ type: "tool.start", sessionId: "live-main", payload: { toolId: "collision-new" } });
  hermes.emit({
    type: "tool.complete",
    sessionId: "live-main",
    payload: { toolId: "collision-shared", toolIds: ["collision-shared"], name: "Collision", summary: "ambiguous done" },
  });
  assert.equal(
    a.events("live-main").at(-1)?.payload?.status,
    "resync_required",
    "a completed alias cannot claim an active occurrence whose start omitted its name",
  );
  hermes.emit({ type: "tool.start", sessionId: "live-main", payload: { toolId: "duplicate-start", name: "Duplicate" } });
  hermes.emit({ type: "tool.start", sessionId: "live-main", payload: { toolId: "duplicate-start", name: "Duplicate" } });
  assert.equal(
    a.events("live-main").at(-1)?.payload?.status,
    "resync_required",
    "a repeated stable-id start fails closed because a concurrent reused id is indistinguishable from replay",
  );
  hermes.emit({ type: "tool.start", sessionId: "live-main", payload: { name: "AnonymousAlpha" } });
  hermes.emit({ type: "tool.start", sessionId: "live-main", payload: { name: "AnonymousBeta" } });
  hermes.emit({ type: "tool.progress", sessionId: "live-main", payload: { status: "unknown anonymous target" } });
  assert.equal(
    a.events("live-main").at(-1)?.payload?.status,
    "resync_required",
    "a nameless anonymous frame cannot select among multiple open occurrences",
  );
  hermes.emit({ type: "tool.start", sessionId: "live-main", payload: { name: "TrulyAnonymous" } });
  hermes.emit({ type: "tool.complete", sessionId: "live-main", payload: { name: "TrulyAnonymous", summary: "anonymous done" } });
  hermes.emit({ type: "tool.start", sessionId: "live-main", payload: { name: "TrulyAnonymous" } });
  assert.equal(
    a.events("live-main").at(-1)?.payload?.status,
    "resync_required",
    "an identical anonymous start fails closed when no stable call id can disambiguate it",
  );
  hermes.emit({ type: "message.complete", sessionId: "live-main", payload: { messageId: "correlated-reply-new", text: "new done" } });
  a.rpc(32, "prompt.submit", { session_id: "live-main", text: "another run" });
  await settle();
  hermes.emit({ type: "tool.complete", sessionId: "live-main", payload: { toolId: "explicit-tool", name: "Shell", summary: "done" } });
  const delayedToolEvent = a.events("live-main").at(-1)!;
  assert.equal(delayedToolEvent.payload?.toolOccurrenceId, completedToolEvent.payload?.toolOccurrenceId);
  assert.equal(delayedToolEvent.payload?.runId, completedToolEvent.payload?.runId);
  hermes.emit({ type: "tool.start", sessionId: "live-main", payload: { toolId: "explicit-tool", name: "Shell" } });
  assert.equal(a.events("live-main").at(-1)?.payload?.status, "resync_required", "a reused tool id with old and new candidates fails closed");

  b.rpc(23, "session.resume", { session_id: "profile-collision", profile: "reviewer" });
  await settle();
  assert.equal(b.errorCode(23), -32006, "cross-profile native live collisions stay with the existing owner");
  assert.equal(a.closed, undefined);
  assert.equal(b.closed, undefined);

  hermes.emit({ type: "message.start", sessionId: "live-b", payload: { messageId: "message-shared" } });
  hermes.emit({ type: "message.complete", sessionId: "live-b", payload: { messageId: "message-shared", text: "old alias run" } });
  b.rpc(41, "prompt.submit", { session_id: "live-b", text: "message alias run" });
  await settle();
  assert.equal(b.errorCode(41), undefined);
  hermes.emit({
    type: "message.start",
    sessionId: "live-b",
    payload: { messageId: "message-call-2", messageIds: ["message-call-2", "message-shared"] },
  });
  const aliasedMessageStart = b.events("live-b").at(-1)!;
  hermes.emit({ type: "message.delta", sessionId: "live-b", payload: { messageId: "message-shared", text: "aliased delta" } });
  assert.equal(b.events("live-b").at(-1)?.payload?.runId, aliasedMessageStart.payload?.runId);
  assert.equal(
    b.events("live-b").at(-1)?.payload?.messageOccurrenceId,
    aliasedMessageStart.payload?.messageOccurrenceId,
  );
  assert.notEqual(b.events("live-b").at(-1)?.payload?.status, "resync_required");
  hermes.emit({
    type: "message.complete",
    sessionId: "live-b",
    payload: { messageId: "message-call-2", messageIds: ["message-call-2", "message-shared"], text: "alias run done" },
  });

  b.rpc(42, "prompt.submit", { session_id: "live-b", text: "disjoint start run" });
  await settle();
  assert.equal(b.errorCode(42), undefined);
  hermes.emit({ type: "message.start", sessionId: "live-b", payload: { messageId: "message-start-a" } });
  hermes.emit({ type: "message.start", sessionId: "live-b", payload: { messageId: "message-start-b" } });
  assert.equal(
    b.events("live-b").at(-1)?.payload?.status,
    "resync_required",
    "a disjoint second message start cannot join the active run",
  );
  hermes.emit({ type: "message.complete", sessionId: "live-b", payload: { messageId: "message-start-a", text: "first start done" } });

  hermes.emit({ type: "message.start", sessionId: "live-b", payload: {} });
  b.rpc(40, "prompt.submit", { session_id: "live-b", text: "replace anonymous run" });
  await settle();
  assert.equal(b.errorCode(40), undefined);
  hermes.emit({ type: "message.start", sessionId: "live-b", payload: { messageId: "live-b-next" } });
  hermes.emit({ type: "message.delta", sessionId: "live-b", payload: { text: "delayed abandoned anonymous delta" } });
  assert.equal(
    b.events("live-b").at(-1)?.payload?.status,
    "resync_required",
    "replacing an unfinished anonymous run preserves its history fence",
  );

  hermes.emit({
    type: "approval.request", sessionId: "live-b",
    payload: { command: "safe", choices: ["once"], allowPermanent: false },
  });
  a.rpc(24, "approval.respond", { session_id: "live-b", choice: "once" });
  b.rpc(25, "approval.respond", { session_id: "live-b", choice: "once" });
  await settle();
  assert.equal(a.errorCode(24), -32004, "approval queues remain downstream-socket-local");
  assert.equal(b.errorCode(25), undefined);

  b.close(1000, "phone closed");
  await settle(6);
  assert.equal(hermes.connectionCloseCount, 0, "one Browser close must not close the shared Hermes transport");
  assert.ok(hermes.sessionCloseRequests.includes("live-b"));
  assert.ok(hermes.sessionCloseRequests.includes("live-created-1"));
  assert.equal(hermes.isLive("live-b"), false);
  assert.equal(hermes.isLive("live-main"), true);
  hermes.emit({ type: "message.start", sessionId: "live-main", payload: { messageId: "third-source" } });
  hermes.emit({ type: "message.delta", sessionId: "live-main", payload: { messageId: "third-source", text: "A survives B" } });
  assert.equal(a.events("live-main").at(-1)?.payload?.text, "A survives B");
  hermes.emit({ type: "message.start", sessionId: "live-main", payload: {} });
  hermes.emit({ type: "message.complete", sessionId: "live-main", payload: { messageId: "third-source", text: "third done" } });
  hermes.emit({ type: "message.complete", sessionId: "live-main", payload: { messageId: "correlated-reply", text: "done" } });
  assert.equal(
    a.events("live-main").at(-1)?.payload?.runId,
    completedRunId,
    "a terminal replay remains correlated after multiple later runs",
  );
  a.rpc(33, "prompt.submit", { session_id: "live-main", text: "ambiguous reused source" });
  await settle();
  hermes.emit({ type: "message.start", sessionId: "live-main", payload: {} });
  const anonymousPromptStart = a.events("live-main").at(-1)!;
  assert.notEqual(
    anonymousPromptStart.payload?.status,
    "resync_required",
    "a prompt acknowledgement establishes a safe boundary for Hermes' id-less message start",
  );
  hermes.emit({ type: "message.delta", sessionId: "live-main", payload: { text: "fresh anonymous reply" } });
  assert.equal(
    a.events("live-main").at(-1)?.payload?.runId,
    anonymousPromptStart.payload?.runId,
    "id-less deltas stay attached to the anonymous run established by its start",
  );
  hermes.emit({ type: "message.start", sessionId: "live-main", payload: { messageId: "third-source" } });
  assert.equal(a.events("live-main").at(-1)?.payload?.status, "resync_required", "a reused source during an unobserved prompt run fails closed");
  hermes.emit({ type: "tool.start", sessionId: "live-main", payload: { name: "Same" } });
  hermes.emit({ type: "tool.start", sessionId: "live-main", payload: { name: "Same" } });
  assert.equal(a.events("live-main").at(-1)?.payload?.status, "resync_required");
  hermes.emit({ type: "message.start", sessionId: "live-main", payload: { messageId: "retention-bootstrap" } });
  hermes.emit({ type: "message.complete", sessionId: "live-main", payload: { messageId: "retention-bootstrap", text: "bootstrap done" } });
  for (let index = 0; index < 70; index += 1) {
    const messageId = `retention-${index}`;
    hermes.emit({ type: "message.start", sessionId: "live-main", payload: { messageId } });
    hermes.emit({ type: "message.complete", sessionId: "live-main", payload: { messageId, text: `done-${index}` } });
  }
  hermes.emit({ type: "message.start", sessionId: "live-main", payload: { messageId: "retention-0" } });
  assert.equal(
    a.events("live-main").at(-1)?.payload?.status,
    "resync_required",
    "the replay fence remains fail-closed after the recent completed-run window evicts an occurrence",
  );
});

test("late errors retain their completed run identity instead of terminalizing a newer run", async () => {
  const hermes = new NativeFakeHermes();
  const coordinator = new ChatSessionCoordinator();
  const runtime = hermes.runtime();
  const hub = new ChatUpstreamHub(runtime, coordinator, 64 * 1024);
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, {
    auth: new OfficeAuth(), officeSession: SESSION, runtimeSource: runtime,
    maxJsonBytes: 64 * 1024, deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
    sessionCoordinator: coordinator, chatHub: hub,
  });
  await settle();
  client.rpc(1, "session.resume", { session_id: "branch-child", profile: "coder" });
  await settle();
  client.rpc(2, "prompt.submit", { session_id: "live-branch-child", text: "old" });
  await settle();
  hermes.emit({ type: "message.start", sessionId: "live-branch-child", payload: { messageId: "old-message" } });
  hermes.emit({ type: "message.complete", sessionId: "live-branch-child", payload: { messageId: "old-message", text: "old done" } });
  const oldRunId = client.events("live-branch-child").at(-1)?.payload?.runId;
  client.rpc(3, "prompt.submit", { session_id: "live-branch-child", text: "next" });
  await settle();
  hermes.emit({ type: "message.start", sessionId: "live-branch-child", payload: { messageId: "new-message" } });
  const newRunId = client.events("live-branch-child").at(-1)?.payload?.runId;
  hermes.emit({ type: "error", sessionId: "live-branch-child", payload: { messageId: "old-message", message: "late old error" } });
  const lateError = client.events("live-branch-child").at(-1)!;
  assert.equal(lateError.payload?.runId, oldRunId);
  assert.notEqual(lateError.payload?.runId, newRunId);
  hermes.emit({
    type: "error", sessionId: "live-branch-child",
    payload: { taskId: "task-1", messageId: "new-message", message: "conflicting origins" },
  });
  assert.equal(client.events("live-branch-child").at(-1)?.payload?.status, "resync_required");
  hermes.emit({ type: "message.delta", sessionId: "live-branch-child", payload: { messageId: "new-message", text: "still current" } });
  assert.equal(client.events("live-branch-child").at(-1)?.payload?.runId, newRunId);
});

test("prompt-acknowledged anonymous message streams remain correlated across turns", async () => {
  const hermes = new NativeFakeHermes();
  const coordinator = new ChatSessionCoordinator();
  const runtime = hermes.runtime();
  const hub = new ChatUpstreamHub(runtime, coordinator, 64 * 1024);
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, {
    auth: new OfficeAuth(), officeSession: SESSION, runtimeSource: runtime,
    maxJsonBytes: 64 * 1024, deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
    sessionCoordinator: coordinator, chatHub: hub,
  });
  await settle();
  client.rpc(1, "session.create", { profile: "default", title: "Anonymous stream regression" });
  await settle();
  const liveSessionId = "live-created-1";
  const runIds: unknown[] = [];

  for (const [rpcId, suffix] of [[2, "first"], [3, "second"]] as const) {
    const before = client.events(liveSessionId).length;
    client.rpc(rpcId, "prompt.submit", { session_id: liveSessionId, text: `${suffix} prompt` });
    await settle();
    hermes.emit({ type: "message.start", sessionId: liveSessionId, payload: {} });
    hermes.emit({ type: "message.delta", sessionId: liveSessionId, payload: { text: `${suffix} delta 1` } });
    hermes.emit({ type: "message.delta", sessionId: liveSessionId, payload: { text: `${suffix} delta 2` } });
    hermes.emit({ type: "message.interim", sessionId: liveSessionId, payload: { text: `${suffix} interim` } });
    hermes.emit({ type: "message.complete", sessionId: liveSessionId, payload: { text: `${suffix} complete` } });
    const turnEvents = client.events(liveSessionId).slice(before);
    assert.equal(turnEvents.some(({ payload }) => payload?.status === "resync_required"), false);
    assert.equal(new Set(turnEvents.map(({ payload }) => payload?.runId)).size, 1);
    runIds.push(turnEvents[0]?.payload?.runId);
  }
  assert.notEqual(runIds[0], runIds[1], "each accepted prompt reserves a distinct anonymous run");

  client.rpc(4, "prompt.submit", { session_id: liveSessionId, text: "delta before start" });
  await settle();
  hermes.emit({ type: "message.delta", sessionId: liveSessionId, payload: { text: "out of order" } });
  assert.equal(client.events(liveSessionId).at(-1)?.payload?.status, "resync_required");

  client.rpc(5, "prompt.submit", { session_id: liveSessionId, text: "duplicate start" });
  await settle();
  hermes.emit({ type: "message.start", sessionId: liveSessionId, payload: {} });
  hermes.emit({ type: "message.start", sessionId: liveSessionId, payload: {} });
  assert.equal(client.events(liveSessionId).at(-1)?.payload?.status, "resync_required");
});

test("a duplicate live close failure resets the shared generation and terminalizes existing owners", async () => {
  const hermes = new NativeFakeHermes();
  const coordinator = new ChatSessionCoordinator();
  const runtime = hermes.runtime();
  const hub = new ChatUpstreamHub(runtime, coordinator, 64 * 1024);
  const dependencies = {
    auth: new OfficeAuth(), officeSession: SESSION, runtimeSource: runtime,
    maxJsonBytes: 64 * 1024, deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
    sessionCoordinator: coordinator, chatHub: hub,
  };
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, dependencies);
  await settle();
  client.rpc(27, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();
  hermes.makeParentReturnDuplicateLive();
  hermes.failCloseFor.add("live-main-rotated");
  client.rpc(28, "session.resume", { session_id: "parent", profile: "coder" });
  await settle(6);

  assert.equal(hermes.sessionCloseRequests.includes("live-main-rotated"), true);
  assert.equal(client.events("live-main-rotated").length, 0);
  assert.equal(client.events("live-main").at(-1)?.payload?.status, "resync_required");
  assert.equal(client.closed?.code, 1013);
  assert.equal(hermes.connectionCloseCount, 1);
  assert.equal(hermes.isLive("live-main"), false, "generation reset must reap every close-on-disconnect live session");
});

test("an ambiguous prompt resets leases before a replacement resume and waits for upstream cleanup", async () => {
  const hermes = new NativeFakeHermes();
  const closeGate = deferred<void>();
  hermes.failPromptAmbiguously = true;
  hermes.delayNextConnectionClose(closeGate.promise);
  const coordinator = new ChatSessionCoordinator();
  const runtime = hermes.runtime();
  const hub = new ChatUpstreamHub(runtime, coordinator, 64 * 1024);
  const dependencies = {
    auth: new OfficeAuth(), officeSession: SESSION, runtimeSource: runtime,
    maxJsonBytes: 64 * 1024, deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
    sessionCoordinator: coordinator, chatHub: hub,
  };
  const oldClient = new FakeWebSocket();
  handleOfficeChatConnection(oldClient as unknown as WebSocket, dependencies);
  await settle();
  oldClient.rpc(70, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();
  oldClient.rpc(71, "prompt.submit", { session_id: "live-main", text: "run once" });
  await settle(4);
  assert.equal(oldClient.errorCode(71), -32008);
  assert.deepEqual(oldClient.closed, { code: 1013, reason: "Hermes chat restarted; reload history" });
  assert.equal(coordinator.ownerForLive("live-main"), undefined, "ambiguous generation leases release before async close completes");
  assert.equal(hermes.connectionCloseCount, 1);
  const replacement = new FakeWebSocket();
  handleOfficeChatConnection(replacement as unknown as WebSocket, dependencies);
  replacement.rpc(72, "session.resume", { session_id: "parent", profile: "coder" });
  await settle(4);
  assert.equal(hermes.resumeRequests.length, 1, "replacement resume waits for close-on-disconnect cleanup");
  hermes.failPromptAmbiguously = false;
  closeGate.resolve();
  await settle(8);
  assert.equal(hermes.resumeRequests.length, 2);
  assert.equal(replacement.errorCode(72), undefined, "replacement does not lose a cleanup race to session_in_use");
});

test("ordinary disconnect cleanup gates replacement readiness and history", async () => {
  const hermes = new NativeFakeHermes();
  const closeGate = deferred<void>();
  const coordinator = new ChatSessionCoordinator();
  const runtime = hermes.runtime();
  const hub = new ChatUpstreamHub(runtime, coordinator, 64 * 1024);
  const dependencies = {
    auth: new OfficeAuth(), officeSession: SESSION, runtimeSource: runtime,
    maxJsonBytes: 64 * 1024, deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
    sessionCoordinator: coordinator, chatHub: hub, readinessHeartbeatMs: 1,
  };
  const oldClient = new FakeWebSocket();
  handleOfficeChatConnection(oldClient as unknown as WebSocket, dependencies);
  await settle();
  oldClient.rpc(73, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();
  hermes.delaySessionClose("live-main", closeGate.promise);
  oldClient.close(1006, "network lost");
  await settle();
  let historyStarted = false;
  const history = hub.readStableHistory(async () => { historyStarted = true; return "fresh"; });
  const replacement = new FakeWebSocket();
  handleOfficeChatConnection(replacement as unknown as WebSocket, dependencies);
  replacement.hello();
  replacement.rpc(74, "session.resume", { session_id: "parent", profile: "coder" });
  await settle(4);
  assert.equal(historyStarted, false, "history waits for the previous owner's close-on-disconnect cleanup");
  assert.equal(replacement.frames().some(({ method }) => method === "office.ready"), false);
  assert.equal(replacement.frames().some(({ method }) => method === "office.waiting"), true, "an authenticated replacement receives cleanup progress without becoming ready");
  assert.equal(hermes.resumeRequests.length, 1, "replacement resume remains queued before office.ready");
  closeGate.resolve();
  assert.equal(await history, "fresh");
  await settle(6);
  assert.equal(replacement.frames().some(({ method }) => method === "office.ready"), true);
  const waitingAfterReady = replacement.frames().filter(({ method }) => method === "office.waiting").length;
  await new Promise<void>((resolve) => setTimeout(resolve, 4));
  assert.equal(replacement.frames().filter(({ method }) => method === "office.waiting").length, waitingAfterReady, "readiness heartbeat stops once attach completes");
  assert.equal(hermes.resumeRequests.length, 2);
  assert.equal(replacement.errorCode(74), undefined);
});

test("history fails closed when owner cleanup starts during the read", async () => {
  const hermes = new NativeFakeHermes();
  const coordinator = new ChatSessionCoordinator();
  const owner = {};
  const claim = coordinator.claimResume(owner, "coder", "parent");
  assert.ok(claim);
  assert.equal(coordinator.bind(claim, { storedSessionId: "parent", liveSessionId: "live-main" }, false), "bound");
  hermes.seedLive("live-main", "parent");
  const hub = new ChatUpstreamHub(hermes.runtime(), coordinator, 64 * 1024);
  await hub.attach(owner, { onEvent: () => undefined, onUnavailable: () => undefined });
  const readGate = deferred<void>();
  const history = hub.readStableHistory(async () => { await readGate.promise; return "stale"; });
  await settle();
  assert.equal(await hub.closeOwnerSessions(owner), true);
  readGate.resolve();
  await assert.rejects(history, /state changed during history read/);
});

test("coordinator converges durable aliases without ever adding a second live id", () => {
  const owner = {};
  const coordinator = new ChatSessionCoordinator();
  const initial = coordinator.claimCreate(owner, "coder");
  assert.equal(coordinator.bind(initial, { storedSessionId: "stored-old", liveSessionId: "live-old" }, true), "bound");
  const sameLease = coordinator.claimResume(owner, "coder", "stored-old");
  assert.ok(sameLease);
  assert.equal(coordinator.bind(sameLease, { storedSessionId: "stored-new", liveSessionId: "live-new" }, false), "conflict");
  assert.deepEqual(coordinator.ownedLiveSessionIds(owner), ["live-old"]);
  assert.equal(coordinator.ownerForLive("live-new"), undefined);
  assert.equal(coordinator.claimResume({}, "coder", "stored-new"), undefined, "the safe durable alias still converges");

  const provisional = coordinator.claimResume(owner, "coder", "unseen-rotation");
  assert.ok(provisional);
  assert.equal(coordinator.bind(provisional, { storedSessionId: "stored-old", liveSessionId: "live-another" }, false), "conflict");
  assert.deepEqual(coordinator.ownedLiveSessionIds(owner), ["live-old"]);
  assert.equal(coordinator.ownerForLive("live-another"), undefined);
  assert.equal(coordinator.claimResume({}, "coder", "unseen-rotation"), undefined);
});

test("lease-level close completes every legacy live id before releasing ownership", async () => {
  const owner = {};
  const coordinator = new LegacyMultiLiveCoordinator(owner, ["legacy-old", "legacy-new"]);
  const hermes = new NativeFakeHermes();
  hermes.seedLive("legacy-old");
  const hub = new ChatUpstreamHub(hermes.runtime(), coordinator, 64 * 1024);
  await hub.attach(owner, { onEvent: () => undefined, onUnavailable: () => undefined });
  hub.detach(owner);
  const result = await hub.closeOwnedSession(owner, "legacy-old");
  assert.equal(result.value.closed, true);
  assert.deepEqual(hermes.sessionCloseRequests, ["legacy-old", "legacy-new"]);
  assert.equal(coordinator.released, true, "true and already-absent false must both complete before lease release");
  assert.equal(hermes.isLive("legacy-old"), false);
});

test("one failed legacy live close resets the generation after bounded retries", async () => {
  const owner = {};
  const coordinator = new LegacyMultiLiveCoordinator(owner, ["legacy-old", "legacy-new"]);
  const hermes = new NativeFakeHermes();
  hermes.seedLive("legacy-old");
  hermes.seedLive("legacy-new");
  hermes.failCloseFor.add("legacy-new");
  const hub = new ChatUpstreamHub(hermes.runtime(), coordinator, 64 * 1024);
  await hub.attach(owner, { onEvent: () => undefined, onUnavailable: () => undefined });
  hub.detach(owner);
  assert.equal(await hub.closeOwnerSessions(owner), true);
  assert.deepEqual(hermes.sessionCloseRequests, ["legacy-old", "legacy-new", "legacy-new"]);
  assert.equal(coordinator.released, true);
  assert.deepEqual(coordinator.ownedLiveSessionIds(owner), []);
  assert.equal(hermes.connectionCloseCount, 1);
  assert.equal(hermes.isLive("legacy-new"), false);
});

test("disconnect cleanup releases absent sessions and resets transport-failed close leases", async () => {
  const hermes = new NativeFakeHermes();
  const coordinator = new ChatSessionCoordinator();
  const runtime = hermes.runtime();
  const hub = new ChatUpstreamHub(runtime, coordinator, 64 * 1024);
  const dependencies = {
    auth: new OfficeAuth(), officeSession: SESSION, runtimeSource: runtime,
    maxJsonBytes: 64 * 1024, deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
    sessionCoordinator: coordinator, chatHub: hub,
  };
  const pending = new FakeWebSocket();
  const observer = new FakeWebSocket();
  handleOfficeChatConnection(pending as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(observer as unknown as WebSocket, dependencies);
  await settle();
  pending.rpc(30, "session.resume", { session_id: "pending-result", profile: "coder" });
  await settle();
  pending.close(1000, "closed while resume pending");
  hermes.emit({ type: "message.delta", sessionId: "live-pending", payload: { text: "detached" } });
  hermes.resolvePending();
  await settle(6);
  assert.equal(hermes.sessionCloseRequests.includes("live-pending"), true, "a settled pending identity is closed without resetting its peers");
  assert.equal(hermes.isLive("live-pending"), false);
  assert.equal(observer.events("live-pending").length, 0, "events for a detached owner must never spill to another Browser");
  const reused = new FakeWebSocket();
  handleOfficeChatConnection(reused as unknown as WebSocket, dependencies);
  await settle();
  reused.rpc(33, "session.resume", { session_id: "pending-reuse", profile: "coder" });
  await settle();
  assert.equal(reused.errorCode(33), undefined);
  assert.equal(
    reused.events("live-pending").some(({ payload }) => payload?.text === "detached"),
    false,
    "cleanup must discard pre-bind events before a live ID can be reused",
  );
  const invalid = new FakeWebSocket();
  handleOfficeChatConnection(invalid as unknown as WebSocket, dependencies);
  await settle();
  invalid.rpc(34, "session.create", { profile: "coder", title: "Invalid identity" });
  await settle();
  assert.equal(invalid.errorCode(34), -32000);
  assert.equal(hermes.sessionCloseRequests.includes("live-invalid"), true);
  assert.equal(hermes.isLive("live-invalid"), false, "invalid create identities must not leave an unowned Hermes live session");
  invalid.rpc(35, "session.resume", { session_id: "invalid-reuse", profile: "coder" });
  await settle();
  assert.equal(invalid.errorCode(35), undefined);
  assert.equal(
    invalid.events("live-invalid").some(({ payload }) => payload?.text === "stale invalid identity"),
    false,
    "an invalid binding must discard its unowned early events",
  );
  const absent = new FakeWebSocket();
  handleOfficeChatConnection(absent as unknown as WebSocket, dependencies);
  await settle();
  absent.rpc(36, "session.resume", { session_id: "close-absent", profile: "coder" });
  await settle();
  hermes.markAlreadyAbsent("live-close-absent");
  absent.close(1000, "already absent upstream");
  await settle(6);
  assert.equal(
    hermes.sessionCloseRequests.filter((liveId) => liveId === "live-close-absent").length,
    1,
    "a normal closed:false response completes idempotent cleanup without retry",
  );
  const absentRetry = new FakeWebSocket();
  handleOfficeChatConnection(absentRetry as unknown as WebSocket, dependencies);
  await settle();
  absentRetry.rpc(37, "session.resume", { session_id: "close-absent", profile: "coder" });
  await settle();
  assert.equal(absentRetry.errorCode(37), undefined, "closed:false must release the durable lease for a new owner");
  const failed = new FakeWebSocket();
  handleOfficeChatConnection(failed as unknown as WebSocket, dependencies);
  await settle();
  failed.rpc(31, "session.resume", { session_id: "close-fails", profile: "coder" });
  await settle();
  hermes.failCloseFor.add("live-close-fails");
  const resetGate = deferred<void>();
  hermes.delayNextConnectionClose(resetGate.promise);
  failed.close(1000, "close fails");
  await settle(6);
  assert.equal(
    hermes.sessionCloseRequests.filter((liveId) => liveId === "live-close-fails").length,
    2,
    "failed explicit closes must receive one bounded retry",
  );
  assert.equal(observer.closed?.code, 1013, "cleanup failure terminalizes every subscriber on the stale generation");
  let historyRead = false;
  const history = hub.readStableHistory(async () => { historyRead = true; return undefined; });
  const retry = new FakeWebSocket();
  handleOfficeChatConnection(retry as unknown as WebSocket, dependencies);
  await settle(4);
  assert.equal(historyRead, false);
  assert.equal(retry.frames().some(({ method }) => method === "office.ready"), false);
  resetGate.resolve();
  await history;
  assert.equal(historyRead, true, "history cannot pass until close-on-disconnect generation reset completes");
  hermes.failCloseFor.delete("live-close-fails");
  await settle();
  retry.rpc(32, "session.resume", { session_id: "close-fails", profile: "coder" });
  await settle();
  assert.equal(retry.errorCode(32), undefined, "replacement resumes after authoritative history and generation cleanup");
});

test("an evicted pre-bind ID remains tombstoned and never delivers a partial suffix", async () => {
  const hermes = new NativeFakeHermes();
  const coordinator = new ChatSessionCoordinator();
  const runtime = hermes.runtime();
  const hub = new ChatUpstreamHub(runtime, coordinator, 64 * 1024);
  const dependencies = {
    auth: new OfficeAuth(), officeSession: SESSION, runtimeSource: runtime,
    maxJsonBytes: 64 * 1024, deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
    sessionCoordinator: coordinator, chatHub: hub,
  };
  const client = new FakeWebSocket();
  handleOfficeChatConnection(client as unknown as WebSocket, dependencies);
  await settle();
  client.rpc(38, "session.resume", { session_id: "tombstone-revisit", profile: "coder" });
  await settle();

  assert.equal(client.errorCode(38), undefined);
  assert.deepEqual(
    client.events("live-tombstone-revisit").map(({ type }) => type),
    ["error"],
    "lost-prefix streams must expose only one resync signal, never later delta or approval fragments",
  );
  assert.equal(client.events("live-tombstone-revisit")[0]?.payload?.status, "resync_required");
});

test("upstream generation failure terminalizes every owner and reconnect ignores stale events", async () => {
  const hermes = new NativeFakeHermes();
  const coordinator = new ChatSessionCoordinator();
  const runtime = hermes.runtime();
  const hub = new ChatUpstreamHub(runtime, coordinator, 64 * 1024);
  const dependencies = {
    auth: new OfficeAuth(), officeSession: SESSION, runtimeSource: runtime,
    maxJsonBytes: 64 * 1024, deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
    sessionCoordinator: coordinator, chatHub: hub,
  };
  const a = new FakeWebSocket();
  const b = new FakeWebSocket();
  handleOfficeChatConnection(a as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(b as unknown as WebSocket, dependencies);
  await settle();
  a.rpc(40, "session.resume", { session_id: "parent", profile: "coder" });
  b.rpc(41, "session.resume", { session_id: "unrelated-b", profile: "reviewer" });
  await settle();

  const staleEmitter = hermes.eventEmitter(0);
  hermes.failGeneration(0);
  await settle();
  assert.equal(a.closed?.code, 1013);
  assert.equal(b.closed?.code, 1013);
  assert.equal(a.events("live-main").at(-1)?.payload?.status, "resync_required");
  assert.equal(b.events("live-b").at(-1)?.payload?.status, "resync_required");

  const reconnected = new FakeWebSocket();
  handleOfficeChatConnection(reconnected as unknown as WebSocket, dependencies);
  await settle();
  assert.equal(hermes.connectCount, 2);
  reconnected.rpc(42, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();
  assert.equal(reconnected.errorCode(42), undefined);
  const before = reconnected.events("live-main").length;
  staleEmitter({ type: "message.delta", sessionId: "live-main", payload: { text: "stale generation" } });
  assert.equal(reconnected.events("live-main").length, before);
});

test("an ambiguous create or resume timeout resets the shared generation instead of leaking an unowned live", async () => {
  const hermes = new NativeFakeHermes();
  const coordinator = new ChatSessionCoordinator();
  const runtime = hermes.runtime();
  const hub = new ChatUpstreamHub(runtime, coordinator, 64 * 1024);
  const dependencies = {
    auth: new OfficeAuth(), officeSession: SESSION, runtimeSource: runtime,
    maxJsonBytes: 64 * 1024, deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
    sessionCoordinator: coordinator, chatHub: hub,
  };
  const a = new FakeWebSocket();
  const b = new FakeWebSocket();
  handleOfficeChatConnection(a as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(b as unknown as WebSocket, dependencies);
  await settle();
  a.rpc(50, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();
  b.rpc(51, "session.resume", { session_id: "timeout", profile: "reviewer" });
  await settle(4);
  assert.equal(hermes.connectionCloseCount, 1);
  assert.equal(a.closed?.code, 1013);
  assert.equal(b.closed?.code, 1013);
  assert.equal(hermes.isLive("live-main"), false, "shared transport reset must model close_on_disconnect reap");
  assert.equal(hermes.isLive("live-timeout"), false, "a committed start with a lost acknowledgement must also be reaped");
});

test("unbound tombstone exhaustion resets once and the next generation recovers cleanly", async () => {
  const hermes = new NativeFakeHermes();
  const coordinator = new ChatSessionCoordinator();
  const runtime = hermes.runtime();
  const hub = new ChatUpstreamHub(runtime, coordinator, 64 * 1024);
  const dependencies = {
    auth: new OfficeAuth(), officeSession: SESSION, runtimeSource: runtime,
    maxJsonBytes: 64 * 1024, deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
    sessionCoordinator: coordinator, chatHub: hub,
  };
  const exhausted = new FakeWebSocket();
  handleOfficeChatConnection(exhausted as unknown as WebSocket, dependencies);
  await settle();
  exhausted.rpc(60, "session.resume", { session_id: "tombstone-overflow", profile: "coder" });
  await settle(6);
  assert.equal(exhausted.closed?.code, 1013);
  assert.equal(hermes.connectionCloseCount, 1);

  const recovered = new FakeWebSocket();
  handleOfficeChatConnection(recovered as unknown as WebSocket, dependencies);
  await settle(6);
  recovered.rpc(61, "session.resume", { session_id: "parent", profile: "coder" });
  await settle();
  assert.equal(recovered.errorCode(61), undefined);
  assert.equal(recovered.events("live-main").some(({ payload }) => payload?.status === "resync_required"), false);
  assert.equal(recovered.events("live-main").some(({ payload }) => payload?.text === "early native event"), true);
});

type FakeLive = { liveSessionId: string; storedSessionId: string };

class NativeFakeHermes {
  readonly resumeRequests: Array<{ sessionId: string; profile: string; closeOnDisconnect: boolean }> = [];
  readonly createRequests: Array<{ profile: string; closeOnDisconnect: boolean }> = [];
  readonly sessionCloseRequests: string[] = [];
  readonly failCloseFor = new Set<string>();
  failPromptAmbiguously = false;
  steerStatus = "ok";
  connectCount = 0;
  connectionCloseCount = 0;
  readonly #events: Array<(event: HermesChatEvent) => void> = [];
  readonly #closedCallbacks: Array<() => void> = [];
  readonly #generationClosed: boolean[] = [];
  readonly #live = new Map<string, FakeLive>();
  #pending: { resolve(result: HermesChatResult): void } | undefined;
  #mainStored = "compression-tip";
  #parentReturnsDuplicate = false;
  #createSequence = 0;
  #promptSequence = 0;
  #connectionCloseGate: Promise<void> | undefined;
  readonly #sessionCloseGates = new Map<string, Promise<void>>();

  runtime(): HermesRuntimeSource {
    return {
      chat: () => ({
        connect: async (onEvent: (event: HermesChatEvent) => void, onClosed?: () => void) => {
          const generation = this.connectCount++;
          this.#events[generation] = onEvent;
          this.#closedCallbacks[generation] = onClosed ?? (() => undefined);
          this.#generationClosed[generation] = false;
          return {
            get closed() { return false; },
            request: async (request: HermesChatRequest) => await this.#request(generation, request),
            close: async () => {
              this.connectionCloseCount += 1;
              const gate = this.#connectionCloseGate;
              this.#connectionCloseGate = undefined;
              await gate;
              this.#generationClosed[generation] = true;
              this.#live.clear();
            },
          };
        },
        inspectHistory: async ({ sessionId }: { sessionId: string }) => ({ sessionId, total: 0 }),
        fetchHistory: async () => { throw new Error("unused"); },
      }),
    } as unknown as HermesRuntimeSource;
  }

  emit(event: HermesChatEvent): void { this.#events.at(-1)?.(event); }
  delayNextConnectionClose(gate: Promise<void>): void { this.#connectionCloseGate = gate; }
  delaySessionClose(liveSessionId: string, gate: Promise<void>): void { this.#sessionCloseGates.set(liveSessionId, gate); }
  eventEmitter(generation: number): (event: HermesChatEvent) => void { return this.#events[generation]!; }
  isLive(liveId: string): boolean { return this.#live.has(liveId); }
  markAlreadyAbsent(liveId: string): void { this.#live.delete(liveId); }
  seedLive(liveSessionId: string, storedSessionId = liveSessionId): void {
    this.#live.set(liveSessionId, { liveSessionId, storedSessionId });
  }
  rotateMainWithoutEvent(): void { this.#mainStored = "rotated-tip"; }
  makeParentReturnDuplicateLive(): void { this.#parentReturnsDuplicate = true; }
  failGeneration(generation: number): void {
    this.#generationClosed[generation] = true;
    this.#live.clear();
    this.#closedCallbacks[generation]?.();
  }
  resolvePending(): void {
    this.#pending?.resolve({
      method: "session.resume",
      value: { liveSessionId: "live-pending", storedSessionId: "pending-result", running: false, status: "idle" },
    });
    this.#pending = undefined;
  }

  async #request(generation: number, request: HermesChatRequest): Promise<HermesChatResult> {
    if (this.#generationClosed[generation]) throw new Error("generation closed");
    if (request.method === "session.close") {
      const liveId = String(request.params?.session_id);
      this.sessionCloseRequests.push(liveId);
      if (this.failCloseFor.has(liveId)) throw new HermesChatTransportError("timed_out", "fake close timeout");
      const closeGate = this.#sessionCloseGates.get(liveId);
      this.#sessionCloseGates.delete(liveId);
      await closeGate;
      const closed = this.#live.delete(liveId);
      return { method: request.method, value: { closed } };
    }
    if (request.method === "session.create") {
      const profile = String(request.params?.profile ?? "default");
      this.createRequests.push({ profile, closeOnDisconnect: request.params?.close_on_disconnect === true });
      if (request.params?.title === "Invalid identity") {
        const identity = { liveSessionId: "live-invalid", storedSessionId: "" };
        this.#live.set(identity.liveSessionId, identity);
        this.#events[generation]?.({
          type: "message.delta", sessionId: identity.liveSessionId,
          payload: { text: "stale invalid identity" },
        });
        return { method: request.method, value: { liveSessionId: identity.liveSessionId, running: false, status: "idle" } };
      }
      const index = ++this.#createSequence;
      const identity = { liveSessionId: `live-created-${index}`, storedSessionId: `stored-created-${index}` };
      this.#live.set(identity.liveSessionId, identity);
      return { method: request.method, value: { ...identity, running: false, status: "idle" } };
    }
    if (request.method === "prompt.submit" && this.failPromptAmbiguously) {
      throw new HermesChatTransportError("backend_rejected", "malformed prompt acknowledgement");
    }
    if (request.method === "prompt.submit") {
      return { method: request.method, value: { status: "streaming", taskId: `task-${++this.#promptSequence}` } };
    }
    if (request.method === "session.steer") {
      return { method: request.method, value: { status: this.steerStatus } };
    }
    if (request.method !== "session.resume") return request.method === "approval.respond"
      ? { method: request.method, value: { resolved: true } }
      : { method: request.method, value: { status: "ok" } };
    const sessionId = String(request.params?.session_id);
    const profile = String(request.params?.profile ?? "default");
    this.resumeRequests.push({ sessionId, profile, closeOnDisconnect: request.params?.close_on_disconnect === true });
    if (sessionId === "timeout") {
      this.#live.set("live-timeout", { liveSessionId: "live-timeout", storedSessionId: "timeout" });
      throw new HermesChatTransportError("timed_out", "fake ambiguous timeout");
    }
    if (sessionId === "pending-result") {
      return await new Promise<HermesChatResult>((resolve) => { this.#pending = { resolve }; });
    }
    const identity = this.#nativeIdentity(sessionId);
    this.#live.set(identity.liveSessionId, identity);
    if (sessionId === "parent") {
      this.#events[generation]?.({ type: "message.delta", sessionId: identity.liveSessionId, payload: { text: "early native event" } });
    }
    if (sessionId === "unrelated-b") {
      this.#events[generation]?.({
        type: "approval.request", sessionId: identity.liveSessionId,
        payload: { command: "early", choices: ["once"], allowPermanent: false },
      });
    }
    if (sessionId === "overflow") {
      for (let index = 0; index < 33; index += 1) {
        this.#events[generation]?.({ type: "message.delta", sessionId: identity.liveSessionId, payload: { text: `early-${index}` } });
      }
    }
    if (sessionId === "tombstone-overflow") {
      for (let index = 0; index < 193; index += 1) {
        this.#events[generation]?.({
          type: "message.delta", sessionId: `unknown-live-${index}`,
          payload: { text: `unknown-${index}` },
        });
      }
    }
    if (sessionId === "tombstone-revisit") {
      this.#events[generation]?.({
        type: "message.delta", sessionId: identity.liveSessionId,
        payload: { text: "first fragment is evicted" },
      });
      for (let index = 0; index < 64; index += 1) {
        this.#events[generation]?.({
          type: "message.delta", sessionId: `tombstone-peer-${index}`,
          payload: { text: `peer-${index}` },
        });
      }
      this.#events[generation]?.({
        type: "message.delta", sessionId: identity.liveSessionId,
        payload: { text: "forbidden partial suffix" },
      });
      this.#events[generation]?.({
        type: "approval.request", sessionId: identity.liveSessionId,
        payload: { command: "must not surface", choices: ["once"] },
      });
    }
    if (sessionId === "rotated-live-tip") {
      this.#events[generation]?.({
        type: "message.delta", sessionId: identity.liveSessionId,
        payload: { text: "early rotated live event" },
      });
    }
    return {
      method: request.method,
      value: { liveSessionId: identity.liveSessionId, storedSessionId: identity.storedSessionId, running: false, status: "idle" },
    };
  }

  #nativeIdentity(requested: string): FakeLive {
    if (requested === "parent" && this.#parentReturnsDuplicate) {
      return { liveSessionId: "live-main-rotated", storedSessionId: this.#mainStored };
    }
    if (["parent", "compression-tip", "rotated-tip", "profile-collision"].includes(requested)) {
      return { liveSessionId: "live-main", storedSessionId: this.#mainStored };
    }
    if (requested === "rotated-live-tip") {
      return { liveSessionId: "live-main-rotated", storedSessionId: this.#mainStored };
    }
    if (requested === "unrelated-b") return { liveSessionId: "live-b", storedSessionId: requested };
    if (requested === "pending-result") return { liveSessionId: "live-pending", storedSessionId: requested };
    if (requested === "pending-reuse") return { liveSessionId: "live-pending", storedSessionId: requested };
    if (requested === "invalid-reuse") return { liveSessionId: "live-invalid", storedSessionId: requested };
    if (requested === "close-fails") return { liveSessionId: "live-close-fails", storedSessionId: requested };
    if (requested === "close-absent") return { liveSessionId: "live-close-absent", storedSessionId: requested };
    if (requested === "overflow") return { liveSessionId: "live-overflow", storedSessionId: requested };
    if (requested === "tombstone-revisit") return { liveSessionId: "live-tombstone-revisit", storedSessionId: requested };
    return { liveSessionId: `live-${requested}`, storedSessionId: requested };
  }
}

class LegacyMultiLiveCoordinator extends ChatSessionCoordinator {
  readonly #owner: ChatSessionOwner;
  readonly #token = Symbol("legacy-multi-live");
  readonly #liveIds: string[];
  #closeToken: symbol | undefined;
  released = false;

  constructor(owner: ChatSessionOwner, liveIds: string[]) {
    super();
    this.#owner = owner;
    this.#liveIds = liveIds;
  }

  override ownedLiveSessionIds(owner: ChatSessionOwner): string[] {
    return owner === this.#owner && !this.released ? [...this.#liveIds] : [];
  }

  override ownedSessionLeases(owner: ChatSessionOwner): ChatSessionLeaseSnapshot[] {
    return owner === this.#owner && !this.released ? [this.#snapshot()] : [];
  }

  override leaseForSession(owner: ChatSessionOwner, sessionId: string): ChatSessionLeaseSnapshot | undefined {
    return owner === this.#owner && !this.released && this.#liveIds.includes(sessionId) ? this.#snapshot() : undefined;
  }

  override releaseLease(owner: ChatSessionOwner, token: symbol): boolean {
    if (owner !== this.#owner || token !== this.#token || this.released) return false;
    this.released = true;
    return true;
  }

  override releaseAll(): void { this.released = true; }

  override claimOwnedLeaseClose(owner: ChatSessionOwner, snapshot: ChatSessionLeaseSnapshot): symbol | undefined {
    if (owner !== this.#owner || snapshot.token !== this.#token || this.released || this.#closeToken !== undefined) return undefined;
    this.#closeToken = Symbol("legacy-close");
    return this.#closeToken;
  }

  override finishOwnedLeaseClose(_snapshot: ChatSessionLeaseSnapshot, token: symbol): void {
    if (this.#closeToken === token) this.#closeToken = undefined;
  }

  #snapshot(): ChatSessionLeaseSnapshot {
    return { token: this.#token, owner: this.#owner, liveSessionIds: [...this.#liveIds], pending: false };
  }
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
    const approvalId = method === "approval.respond" ? this.approvalId(String(params.session_id)) : undefined;
    this.emit("message", Buffer.from(JSON.stringify({
      jsonrpc: "2.0", id, method,
      params: approvalId === undefined ? params : { ...params, approval_id: approvalId },
    })), false);
  }
  hello(): void {
    this.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "office.hello", params: {} })), false);
  }
  errorCode(id: number): number | undefined {
    return (this.frames().find((frame) => frame.id === id)?.error as { code?: number } | undefined)?.code;
  }
  frameIndex(id: number): number { return this.frames().findIndex((frame) => frame.id === id); }
  eventFrameIndex(liveId: string): number {
    return this.frames().findIndex((frame) => (frame.params as { sessionId?: string } | undefined)?.sessionId === liveId);
  }
  events(liveId: string): Array<{ type?: string; payload?: Record<string, unknown> }> {
    return this.frames().flatMap((frame) => {
      const params = frame.params as { sessionId?: string; type?: string; payload?: Record<string, unknown> } | undefined;
      return frame.method === "event" && params?.sessionId === liveId ? [{
        ...(params.type === undefined ? {} : { type: params.type }),
        ...(params.payload === undefined ? {} : { payload: params.payload }),
      }] : [];
    });
  }
  approvalId(liveId: string): string {
    const event = [...this.events(liveId)].reverse().find(({ type }) => type === "approval.request");
    return typeof event?.payload?.approvalId === "string" ? event.payload.approvalId : "";
  }
  frames(): Array<Record<string, unknown>> { return this.sent.map((body) => JSON.parse(body) as Record<string, unknown>); }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle(turns = 2): Promise<void> {
  for (let index = 0; index < turns; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
