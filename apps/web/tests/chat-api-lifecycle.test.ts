import assert from "node:assert/strict";
import test from "node:test";
import type { ChatApiCallbacks, ChatHistoryResult, ChatTarget } from "../src/chat-api";
import { chatSlashRpcTimeoutMs, connectChatApi } from "../src/chat-api";
import { storedSessionClientId } from "../src/session-identity.ts";
import { isCommitUnconfirmedRpcError } from "../src/chat-rpc-results.ts";

test("session-mutating slash commands use the Hermes long-running RPC budget", () => {
  assert.equal(chatSlashRpcTimeoutMs("/model model --session"), 185_000);
  assert.equal(chatSlashRpcTimeoutMs("/reasoning high"), 185_000);
  assert.equal(chatSlashRpcTimeoutMs("/undo"), 185_000);
  assert.equal(chatSlashRpcTimeoutMs("/compact"), 185_000);
  assert.equal(chatSlashRpcTimeoutMs("/status"), 15_000);
});

test("delayed create from a four-pane eviction is closed and cannot resurrect the target", async () => {
  const harness = await createHarness();
  const targets = Array.from({ length: 5 }, (_, index): ChatTarget => ({
    clientSessionId: `client-${index + 1}`,
    profileId: `profile-${index + 1}`,
  }));
  for (const target of targets) harness.api.ensureSession(target);
  await flush();
  const staleCreate = harness.socket.frame("session.create", "profile-1");
  assert.ok(staleCreate);

  // The store evicts the oldest pane when the fifth target is opened.
  harness.api.releaseSession("client-1");
  harness.socket.respond(staleCreate.id, { session_id: "live-stale" });
  await flush();
  assert.equal(harness.ready.some((item) => item.clientSessionId === "client-1"), false);
  const staleClose = harness.socket.frame("session.close", "live-stale");
  assert.ok(staleClose);
  harness.socket.respond(staleClose.id, undefined, { code: -32000, message: "close failed" });
  await flush();
  assert.deepEqual(harness.socket.closes.at(-1), { code: 4002, reason: "Session close unconfirmed; reload history" });
  assert.equal(harness.ready.some((item) => item.clientSessionId === "client-1"), false);
  harness.api.stop();
});

test("a fifth pane waits for the evicted live session close acknowledgement", async () => {
  const harness = await createHarness();
  for (let index = 1; index <= 4; index += 1) {
    harness.api.ensureSession({ clientSessionId: `client-${index}`, profileId: `profile-${index}` });
    await flush();
    const create = harness.socket.frame("session.create", `profile-${index}`)!;
    harness.socket.respond(create.id, { session_id: `live-${index}` });
    await flush();
  }

  harness.api.releaseSession("client-1");
  harness.api.ensureSession({ clientSessionId: "client-5", profileId: "profile-5" });
  await flush();
  const close = harness.socket.frame("session.close", "live-1");
  assert.ok(close);
  assert.equal(harness.socket.frame("session.create", "profile-5"), undefined, "create must not race the four-lease close");

  harness.socket.respond(close.id, { closed: true });
  await flush();
  assert.ok(harness.socket.frame("session.create", "profile-5"), "the replacement starts after its lease slot is released");
  harness.api.stop();
});

test("a session-limit rejection waits in FIFO and submits its prompt after a slot closes", async () => {
  const harness = await createHarness();
  harness.api.ensureSession({ clientSessionId: "blocker", profileId: "default" });
  await flush();
  const blockerCreate = harness.socket.frame("session.create", "default")!;
  harness.socket.respond(blockerCreate.id, { session_id: "live-blocker" });
  await flush();

  harness.api.ensureSession({ clientSessionId: "queued-client", profileId: "queued-profile" });
  await flush();
  const limitedCreate = harness.socket.frame("session.create", "queued-profile")!;
  harness.socket.respond(limitedCreate.id, undefined, {
    code: -32007,
    message: "live session limit",
    data: { reason: "session_limit" },
  });
  await flush();
  assert.deepEqual(harness.queued, ["queued-client"]);

  const submission = harness.api.submitPrompt("queued-client", "start after capacity is free", "queued-operation");
  harness.api.releaseSession("blocker");
  const close = harness.socket.frame("session.close", "live-blocker")!;
  harness.socket.respond(close.id, { closed: true });
  await flush();
  await flush();

  const retriedCreate = harness.socket.frames("session.create", "queued-profile").at(-1)!;
  assert.notEqual(retriedCreate.id, limitedCreate.id);
  harness.socket.respond(retriedCreate.id, { session_id: "live-queued" });
  await flush();
  const prompt = harness.socket.frame("prompt.submit", "start after capacity is free")!;
  harness.socket.respond(prompt.id, { status: "streaming" });
  assert.deepEqual(await submission, { status: "accepted" });
  harness.api.stop();
});

test("a fifth pane waits for an evicted pending create to settle and close", async () => {
  const harness = await createHarness();
  for (let index = 1; index <= 4; index += 1) {
    harness.api.ensureSession({ clientSessionId: `pending-client-${index}`, profileId: `pending-profile-${index}` });
  }
  await flush();
  const evictedCreate = harness.socket.frame("session.create", "pending-profile-1");
  assert.ok(evictedCreate);

  harness.api.releaseSession("pending-client-1");
  harness.api.ensureSession({ clientSessionId: "pending-client-5", profileId: "pending-profile-5" });
  await flush();
  assert.equal(harness.socket.frame("session.create", "pending-profile-5"), undefined);

  harness.socket.respond(evictedCreate.id, { session_id: "pending-live-1" });
  await flush();
  const close = harness.socket.frame("session.close", "pending-live-1");
  assert.ok(close);
  assert.equal(harness.socket.frame("session.create", "pending-profile-5"), undefined);

  harness.socket.respond(close.id, { closed: true });
  await flush();
  const replacement = harness.socket.frame("session.create", "pending-profile-5");
  assert.ok(replacement, "the pending eviction releases its slot without a manual retry");
  harness.socket.respond(replacement.id, { session_id: "pending-live-5" });
  await flush();
  assert.ok(harness.ready.some(({ clientSessionId }) => clientSessionId === "pending-client-5"));
  harness.api.stop();
});

test("a same-id replacement cannot overwrite its pending-start handoff", async () => {
  const harness = await createHarness();
  harness.api.ensureSession({ clientSessionId: "reused-client", profileId: "old-profile" });
  await flush();
  const oldCreate = harness.socket.frame("session.create", "old-profile");
  assert.ok(oldCreate);

  harness.api.ensureSession({ clientSessionId: "reused-client", profileId: "new-profile" });
  await flush();
  assert.equal(harness.socket.frame("session.create", "new-profile"), undefined);

  harness.socket.respond(oldCreate.id, { session_id: "old-pending-live" });
  await flush();
  const oldClose = harness.socket.frame("session.close", "old-pending-live");
  assert.ok(oldClose);
  harness.socket.respond(oldClose.id, { closed: true });
  await flush();

  const newCreate = harness.socket.frame("session.create", "new-profile");
  assert.ok(newCreate);
  harness.socket.respond(newCreate.id, { session_id: "new-live" });
  await flush();
  assert.deepEqual(harness.ready.at(-1), { clientSessionId: "reused-client", liveSessionId: "new-live" });
  harness.api.stop();
});

test("a failed eviction close resets transport instead of racing the fifth pane", async () => {
  const harness = await createHarness();
  for (let index = 1; index <= 4; index += 1) {
    harness.api.ensureSession({ clientSessionId: `failure-client-${index}`, profileId: `failure-profile-${index}` });
    await flush();
    const create = harness.socket.frame("session.create", `failure-profile-${index}`)!;
    harness.socket.respond(create.id, { session_id: `failure-live-${index}` });
    await flush();
  }

  harness.api.releaseSession("failure-client-1");
  harness.api.ensureSession({ clientSessionId: "failure-client-5", profileId: "failure-profile-5" });
  await flush();
  const close = harness.socket.frame("session.close", "failure-live-1")!;
  harness.socket.respond(close.id, undefined, { code: -32000, message: "close failed" });
  await flush();

  assert.equal(harness.socket.frame("session.create", "failure-profile-5"), undefined);
  assert.deepEqual(harness.socket.closes.at(-1), { code: 4002, reason: "Session close unconfirmed; reload history" });
  harness.api.stop();
});

test("delayed history is discarded after release without starting resume", async () => {
  const history = deferred<unknown>();
  const harness = await createHarness(async <T>() => await history.promise as T);
  harness.api.ensureSession({ clientSessionId: "stored-client", profileId: "coder", storedSessionId: "stored-1" });
  assert.equal(harness.socket.frame("session.resume", "stored-1"), undefined);
  harness.api.releaseSession("stored-client");

  history.resolve({
    sessionId: "stored-1",
    messages: [{ index: 0, role: "assistant", text: "must be discarded" }],
    pagination: { direction: "older", hasMore: false, returned: 1 },
  });
  await flush();
  await flush();
  assert.equal(harness.ready.length, 0);
  assert.equal(harness.histories.length, 0);
  assert.equal(harness.socket.frame("session.resume", "stored-1"), undefined);
  harness.api.stop();
});

test("failed close keeps the tombstone and terminalizes the current transport", async () => {
  const harness = await createHarness();
  const target = { clientSessionId: "same-id", profileId: "builder" };
  harness.api.ensureSession(target);
  await flush();
  const create = harness.socket.frame("session.create", "builder")!;
  harness.socket.respond(create.id, { session_id: "live-old" });
  await flush();

  harness.api.releaseSession("same-id");
  await flush();
  const close = harness.socket.frame("session.close", "live-old")!;
  harness.socket.respond(close.id, undefined, { code: -32000, message: "temporary close failure" });
  await flush();
  harness.socket.event("live-old", "message.complete");
  harness.api.ensureSession(target);
  await flush();

  assert.deepEqual(harness.ready.map((item) => item.liveSessionId), ["live-old"]);
  assert.equal(harness.socket.frames("session.create", "builder").length, 1);
  assert.deepEqual(harness.socket.closes.at(-1), { code: 4002, reason: "Session close unconfirmed; reload history" });
  assert.equal(harness.events.length, 0);
  harness.api.stop();
});

test("profile-scoped client IDs isolate resume, history, and events for equal stored IDs", async () => {
  const historyPaths: string[] = [];
  const harness = await createHarness(async <T>(path: string) => {
    historyPaths.push(path);
    return { sessionId: "shared-id", messages: [], pagination: { direction: "older", hasMore: false, returned: 0 } } as T;
  });
  const firstId = storedSessionClientId("p1", "shared-id");
  const secondId = storedSessionClientId("p2", "shared-id");
  harness.api.ensureSession({ clientSessionId: firstId, profileId: "p1", storedSessionId: "shared-id" });
  harness.api.ensureSession({ clientSessionId: secondId, profileId: "p2", storedSessionId: "shared-id" });
  await flush();

  const resumes = harness.socket.sent.filter((frame) => frame.method === "session.resume");
  assert.deepEqual(resumes.map((frame) => frame.params), [
    { session_id: "shared-id", profile: "p1" },
    { session_id: "shared-id", profile: "p2" },
  ]);
  assert.ok(historyPaths.some((path) => path.includes("profile=p1")));
  assert.ok(historyPaths.some((path) => path.includes("profile=p2")));
  harness.socket.respond(resumes[0]!.id, { session_id: "live-p1", stored_session_id: "shared-id" });
  harness.socket.respond(resumes[1]!.id, { session_id: "live-p2", stored_session_id: "shared-id" });
  await flush();
  harness.socket.event("live-p1", "message.complete");
  harness.socket.event("live-p2", "message.complete");
  assert.deepEqual(harness.events, [firstId, secondId]);
  harness.api.stop();
});

test("session-in-use errors are localized and the same target can retry resume", async () => {
  let historyLoads = 0;
  const harness = await createHarness(async <T>() => {
    historyLoads += 1;
    return {
      sessionId: "stored-busy", messages: [],
      pagination: { direction: "older", hasMore: false, returned: 0 },
    } as T;
  });
  const target = { clientSessionId: "busy-client", profileId: "coder", storedSessionId: "stored-busy" };
  harness.api.ensureSession(target);
  await flush();
  const first = harness.socket.frames("session.resume", "stored-busy")[0]!;
  harness.socket.respond(first.id, undefined, {
    code: -32006,
    message: "Session is already in use by another Office client.",
    data: { reason: "session_in_use" },
  });
  await flush();
  assert.deepEqual(harness.errors, [{
    clientSessionId: "busy-client",
    message: "このセッションは別の端末で使用中です。別の端末で閉じてから再接続してください。",
  }]);

  harness.api.ensureSession(target);
  await flush();
  assert.equal(historyLoads, 2, "retry re-fetches history after the prior owner's cleanup race");
  assert.equal(harness.socket.frames("session.resume", "stored-busy").length, 2);
  harness.api.stop();
});

test("interaction methods reject malformed success acknowledgements", async () => {
  const approvalHarness = await createHarness();
  approvalHarness.api.ensureSession({ clientSessionId: "interaction-client", profileId: "coder" });
  await flush();
  const create = approvalHarness.socket.frame("session.create", "coder")!;
  approvalHarness.socket.respond(create.id, { session_id: "live-interaction", stored_session_id: "stored-interaction" });
  await flush();

  const approval = approvalHarness.api.respondApproval("interaction-client", "approval-1", "once");
  const approvalFrame = approvalHarness.socket.frames("approval.respond", "approval-1").at(-1)!;
  approvalHarness.socket.respond(approvalFrame.id, { resolved: false });
  await assert.rejects(approval, /不正な承認確認/);
  assert.deepEqual(approvalHarness.socket.closes.at(-1), { code: 4001, reason: "Approval commit unconfirmed; reload history" });
  approvalHarness.api.stop();

  const clarificationHarness = await createHarness();
  clarificationHarness.api.ensureSession({ clientSessionId: "clarification-client", profileId: "coder" });
  await flush();
  const clarificationCreate = clarificationHarness.socket.frame("session.create", "coder")!;
  clarificationHarness.socket.respond(clarificationCreate.id, { session_id: "live-clarification", stored_session_id: "stored-clarification" });
  await flush();
  const clarification = clarificationHarness.api.respondClarify("clarification-client", "clarify-1", "answer");
  const clarifyFrame = clarificationHarness.socket.frames("clarify.respond", "clarify-1").at(-1)!;
  clarificationHarness.socket.respond(clarifyFrame.id, { status: "rejected" });
  await assert.rejects(clarification, /不正な回答確認/);
  assert.deepEqual(clarificationHarness.socket.closes.at(-1), { code: 4001, reason: "Clarification commit unconfirmed; reload history" });
  clarificationHarness.api.stop();
});

test("a server resync_required event enters the durable history barrier", async () => {
  const harness = await createHarness();
  harness.api.ensureSession({ clientSessionId: "resync-client", profileId: "coder" });
  await flush();
  const create = harness.socket.frame("session.create", "coder")!;
  harness.socket.respond(create.id, { session_id: "live-resync", stored_session_id: "stored-resync" });
  await flush();

  harness.socket.event("live-resync", "error", { status: "resync_required" });
  assert.ok(harness.disconnections.length >= 1);
  assert.equal(harness.disconnections.every((id) => id === "resync-client"), true);
  assert.deepEqual(harness.socket.closes.at(-1), {
    code: 4001, reason: "Hermes event history is incomplete; reload history",
  });
  assert.deepEqual(harness.events, [], "the incomplete-prefix signal is protocol control, not a normal transcript event");
  harness.api.stop();
});

test("steer sends one exact live session.steer request and rejects empty or unready input", async () => {
  const harness = await createHarness();
  await assert.rejects(harness.api.steer("missing", "guidance"), /未接続/);
  harness.api.ensureSession({ clientSessionId: "client-steer", profileId: "coder" });
  await assert.rejects(harness.api.steer("client-steer", "too early"), /未接続/);
  await flush();
  const create = harness.socket.frame("session.create", "coder")!;
  harness.socket.respond(create.id, { session_id: "live-steer" });
  harness.api.ensureSession({ clientSessionId: "other-pane", profileId: "reviewer" });
  await flush();
  const otherCreate = harness.socket.frame("session.create", "reviewer")!;
  harness.socket.respond(otherCreate.id, { session_id: "live-other" });
  await flush();
  await assert.rejects(harness.api.steer("client-steer", "   "), /入力/);

  const request = harness.api.steer("client-steer", "  focus on tests  ");
  const frame = harness.socket.frame("session.steer", "live-steer")!;
  assert.deepEqual(frame.params, { session_id: "live-steer", text: "focus on tests" });
  assert.equal(harness.socket.frames("session.steer", "live-steer").length, 1);
  assert.equal(harness.socket.frames("session.steer", "live-other").length, 0);
  harness.socket.respond(frame.id, { status: "queued" });
  assert.deepEqual(await request, { status: "queued" });

  const enveloped = harness.api.steer("client-steer", "enveloped response");
  const envelopedFrame = harness.socket.frames("session.steer", "live-steer").at(-1)!;
  harness.socket.respond(envelopedFrame.id, { method: "session.steer", value: { status: "queued" } });
  assert.deepEqual(await enveloped, { status: "queued" });

  const rejected = harness.api.steer("client-steer", "reject this");
  const rejectedFrame = harness.socket.frames("session.steer", "live-steer").at(-1)!;
  harness.socket.respond(rejectedFrame.id, { status: "rejected" });
  assert.deepEqual(await rejected, { status: "rejected" });

  const malformed = harness.api.steer("client-steer", "invalid ack");
  const malformedFrame = harness.socket.frames("session.steer", "live-steer").at(-1)!;
  harness.socket.respond(malformedFrame.id, { status: "accepted" });
  await assert.rejects(malformed, (error: unknown) => isCommitUnconfirmedRpcError(error));
  harness.api.stop();
});

test("prompt submit accepts only streaming and treats malformed success as unconfirmed", async () => {
  const harness = await createHarness();
  harness.api.ensureSession({ clientSessionId: "client-prompt", profileId: "coder" });
  await flush();
  const create = harness.socket.frame("session.create", "coder")!;
  harness.socket.respond(create.id, { session_id: "live-prompt" });
  await flush();

  const rejected = harness.api.submitPrompt("client-prompt", "deny", "operation-rejected");
  const rejectedFrame = harness.socket.frame("prompt.submit", "live-prompt")!;
  harness.socket.respond(rejectedFrame.id, undefined, { code: -32000, message: "policy denied" });
  assert.deepEqual(await rejected, { status: "rejected", message: "policy denied" });

  const accepted = harness.api.submitPrompt("client-prompt", "valid", "operation-valid");
  const acceptedFrame = harness.socket.frames("prompt.submit", "live-prompt").at(-1)!;
  harness.socket.respond(acceptedFrame.id, { status: "streaming" });
  assert.deepEqual(await accepted, { status: "accepted" });

  const malformed = harness.api.submitPrompt("client-prompt", "maybe committed", "operation-malformed");
  const malformedFrame = harness.socket.frames("prompt.submit", "live-prompt").at(-1)!;
  harness.socket.respond(malformedFrame.id, undefined);
  assert.deepEqual(await malformed, {
    status: "unconfirmed",
    message: "Hermesが不正な送信確認を返しました。保存済み履歴を再確認します。",
  });
  assert.equal(harness.socket.frames("prompt.submit", "live-prompt").length, 3, "a malformed success must never be replayed");
  harness.api.stop();
});

test("a malformed read-only slash result does not disconnect unrelated live panes", async () => {
  const harness = await createHarness();
  for (const [clientSessionId, profileId, liveSessionId] of [
    ["slash-reader", "coder", "live-reader"],
    ["slash-neighbor", "reviewer", "live-neighbor"],
  ] as const) {
    harness.api.ensureSession({ clientSessionId, profileId });
    await flush();
    const create = harness.socket.frame("session.create", profileId)!;
    harness.socket.respond(create.id, { session_id: liveSessionId });
    await flush();
  }

  const reading = harness.api.execSlash("slash-reader", "/help");
  const frame = harness.socket.frame("slash.exec", "/help")!;
  harness.socket.respond(frame.id, { status: "malformed" });
  await assert.rejects(reading, /不正なスラッシュコマンド結果/);
  assert.equal(harness.socket.closes.some(({ code }) => code === 4001), false);
  assert.deepEqual(harness.disconnections, []);
  assert.equal(harness.ready.some(({ clientSessionId }) => clientSessionId === "slash-neighbor"), true);
  harness.api.stop();
});

test("an ambiguous session-mutating slash result is never presented as safe to retry", async () => {
  const harness = await createHarness();
  harness.api.ensureSession({ clientSessionId: "slash-writer", profileId: "coder" });
  await flush();
  const create = harness.socket.frame("session.create", "coder")!;
  harness.socket.respond(create.id, { session_id: "live-writer", stored_session_id: "stored-writer" });
  await flush();

  const command = harness.api.execSlash("slash-writer", "/undo");
  const frame = harness.socket.frame("slash.exec", "/undo")!;
  harness.socket.respond(frame.id, { status: "malformed" });
  await assert.rejects(command, (error: unknown) => isCommitUnconfirmedRpcError(error));
  assert.deepEqual(harness.socket.closes.at(-1), { code: 4001, reason: "Prompt commit unconfirmed; reload history" });
  assert.equal(harness.socket.frames("slash.exec", "/undo").length, 1);
  harness.api.stop();
});

test("commit_unconfirmed data is ambiguous even when the generic RPC code is used", async () => {
  const harness = await createHarness();
  harness.api.ensureSession({ clientSessionId: "client-reason", profileId: "reviewer" });
  await flush();
  const create = harness.socket.frame("session.create", "reviewer")!;
  harness.socket.respond(create.id, { session_id: "live-reason" });
  await flush();
  const submission = harness.api.submitPrompt("client-reason", "maybe committed", "operation-reason");
  const frame = harness.socket.frame("prompt.submit", "live-reason")!;
  harness.socket.respond(frame.id, undefined, {
    code: -32000, message: "write acknowledgement lost", data: { reason: "commit_unconfirmed" },
  });
  assert.deepEqual(await submission, { status: "unconfirmed", message: "write acknowledgement lost" });
  assert.equal(harness.socket.frames("prompt.submit", "live-reason").length, 1);
  harness.api.stop();
});

test("steer commit_unconfirmed reaches the store as an ambiguity marker", async () => {
  const harness = await createHarness();
  harness.api.ensureSession({ clientSessionId: "client-steer", profileId: "reviewer" });
  await flush();
  const create = harness.socket.frame("session.create", "reviewer")!;
  harness.socket.respond(create.id, { session_id: "live-steer", running: true });
  await flush();

  const steering = harness.api.steer("client-steer", "keep going once");
  const frame = harness.socket.frame("session.steer", "live-steer")!;
  harness.socket.respond(frame.id, undefined, {
    code: -32008, message: "steer acknowledgement lost", data: { reason: "commit_unconfirmed" },
  });
  await assert.rejects(steering, (error: unknown) => isCommitUnconfirmedRpcError(error));
  assert.equal(harness.socket.frames("session.steer", "live-steer").length, 1);
  harness.api.stop();
});

test("a client transcript overflow enters the durable history barrier instead of trimming a suffix", async () => {
  const harness = await createHarness(async <T>() => ({
    sessionId: "stored-bounded", messages: [],
    pagination: { direction: "older", hasMore: false, returned: 0 },
  }) as T, () => "resync-required");
  harness.api.ensureSession({ clientSessionId: "bounded-client", profileId: "coder", storedSessionId: "stored-bounded" });
  await waitFor(() => harness.socket.frames("session.resume", "stored-bounded").length === 1);
  const resume = harness.socket.frame("session.resume", "stored-bounded")!;
  harness.socket.respond(resume.id, { session_id: "live-bounded", stored_session_id: "stored-bounded" });
  await flush();

  harness.socket.event("live-bounded", "message.delta");
  assert.deepEqual(harness.socket.closes[0], {
    code: 4001,
    reason: "Live transcript safety limit exceeded; reload history",
  });
  assert.ok(harness.disconnections.filter((id) => id === "bounded-client").length >= 1);
  harness.api.stop();
});

test("interrupt resolves only after an authoritative interrupted acknowledgement", async () => {
  const harness = await createHarness();
  harness.api.ensureSession({ clientSessionId: "client-stop", profileId: "coder" });
  await flush();
  const create = harness.socket.frame("session.create", "coder")!;
  harness.socket.respond(create.id, { session_id: "live-stop" });
  await flush();
  let settled = false;
  const stopping = harness.api.interrupt("client-stop").then(() => { settled = true; });
  const frame = harness.socket.frame("session.interrupt", "live-stop")!;
  assert.equal(settled, false);
  harness.socket.respond(frame.id, { status: "interrupted" });
  await stopping;
  assert.equal(settled, true);

  const malformed = harness.api.interrupt("client-stop");
  const malformedFrame = harness.socket.frames("session.interrupt", "live-stop").at(-1)!;
  harness.socket.respond(malformedFrame.id, { status: "accepted" });
  await assert.rejects(malformed, /不正な停止確認/);

  const empty = harness.api.interrupt("client-stop");
  const emptyFrame = harness.socket.frames("session.interrupt", "live-stop").at(-1)!;
  harness.socket.respond(emptyFrame.id, undefined);
  await assert.rejects(empty, /不正な停止確認/);
  harness.api.stop();
});

test("steer never crosses a target generation, release, or transport close", async () => {
  const harness = await createHarness();
  harness.api.ensureSession({ clientSessionId: "client-race", profileId: "old" });
  await flush();
  const createOld = harness.socket.frame("session.create", "old")!;
  harness.socket.respond(createOld.id, { session_id: "live-old" });
  await flush();

  const stale = harness.api.steer("client-race", "old generation only");
  const staleFrame = harness.socket.frame("session.steer", "live-old")!;
  harness.api.ensureSession({ clientSessionId: "client-race", profileId: "new" });
  harness.socket.respond(staleFrame.id, { status: "queued" });
  await assert.rejects(stale, (error: unknown) => (
    isCommitUnconfirmedRpcError(error) && /送信先が変更/.test(error.message)
  ));
  await flush();
  const oldClose = harness.socket.frame("session.close", "live-old")!;
  harness.socket.respond(oldClose.id, { closed: true });
  await flush();
  const createNew = harness.socket.frame("session.create", "new")!;
  harness.socket.respond(createNew.id, { session_id: "live-new" });
  await flush();
  assert.equal(harness.socket.sent.filter(({ method }) => method === "session.steer").length, 1);
  assert.equal(harness.socket.frames("session.steer", "live-new").length, 0);

  const closing = harness.api.steer("client-race", "before disconnect");
  assert.ok(harness.socket.frame("session.steer", "live-new"));
  harness.socket.close(1006, "network lost");
  await assert.rejects(closing, (error: unknown) => (
    isCommitUnconfirmedRpcError(error) && /切断/.test(error.message)
  ));
  assert.equal(harness.socket.sent.filter(({ method }) => method === "session.steer").length, 2);
  harness.api.stop();
});

test("more than 500 saved messages retain the latest ordered window and report older omission", async () => {
  let pages = 0;
  const harness = await createHarness(async <T>() => {
    const page = pages++;
    const start = 501 - ((page + 1) * 25);
    const terminal = page === 19;
    return {
      sessionId: "large-stored",
      messages: Array.from({ length: 25 }, (_, index) => ({ index: start + index, role: "assistant", text: `m-${start + index}` })),
      pagination: { direction: "older", hasMore: !terminal, ...(terminal ? {} : { nextCursor: `cursor-${page + 1}` }), returned: 25, truncated: terminal, partial: terminal, ...(terminal ? { truncationReason: "message_limit" } : {}) },
    } as T;
  });
  harness.api.ensureSession({ clientSessionId: "large-client", profileId: "coder", storedSessionId: "large-stored" });
  await waitFor(() => harness.historyResults.length === 1);
  assert.equal(pages, 20);
  assert.deepEqual(harness.historyResults[0], { clientSessionId: "large-client", messages: 500, result: { truncated: true, partial: true, reason: "message_limit" } });
  assert.equal(harness.historyBodies[0]?.[0], "m-1");
  assert.equal(harness.historyBodies[0]?.at(-1), "m-500");
  harness.api.stop();
});

test("499 and exactly 500 saved messages finish without a false partial result", async () => {
  for (const total of [499, 500]) {
    let offset = total;
    const harness = await createHarness(async <T>() => {
      const start = Math.max(0, offset - 25);
      const messages = Array.from({ length: offset - start }, (_, index) => ({ index: start + index, role: "assistant", text: `m-${start + index}` }));
      offset = start;
      return { sessionId: `stored-${total}`, messages, pagination: { direction: "older", hasMore: offset > 0, ...(offset > 0 ? { nextCursor: `cursor-${offset}` } : {}), returned: messages.length, truncated: false, partial: false } } as T;
    });
    harness.api.ensureSession({ clientSessionId: `client-${total}`, profileId: "coder", storedSessionId: `stored-${total}` });
    await waitFor(() => harness.historyResults.length === 1);
    assert.deepEqual(harness.historyResults[0]?.result, { truncated: false, partial: false });
    assert.equal(harness.historyBodies[0]?.length, total);
    assert.equal(harness.historyBodies[0]?.[0], "m-0");
    assert.equal(harness.historyBodies[0]?.at(-1), `m-${total - 1}`);
    harness.api.stop();
  }
});

test("a later history page failure delivers prior pages as partial history", async () => {
  let pages = 0;
  const harness = await createHarness(async <T>() => {
    pages += 1;
    if (pages === 3) throw new Error("page three unavailable");
    return {
      sessionId: "partial-stored",
      messages: Array.from({ length: 2 }, (_, index) => ({ index: (pages - 1) * 2 + index, role: "assistant", text: `m-${pages}-${index}` })),
      pagination: { direction: "older", hasMore: true, nextCursor: `cursor-${pages}`, returned: 2, truncated: false, partial: false },
    } as T;
  });
  harness.api.ensureSession({ clientSessionId: "partial-client", profileId: "coder", storedSessionId: "partial-stored" });
  await waitFor(() => harness.historyResults.length === 1);
  assert.deepEqual(harness.historyResults[0], { clientSessionId: "partial-client", messages: 4, result: { truncated: true, partial: true, reason: "upstream_error" } });
  assert.deepEqual(harness.historyBodies[0], ["m-2-0", "m-2-1", "m-1-0", "m-1-1"]);
  assert.equal(harness.socket.frames("session.resume", "partial-stored").length, 1);
  harness.api.stop();
});

test("a history error blocks resume until an explicit retry establishes the snapshot", async () => {
  let available = false;
  const harness = await createHarness(async <T>() => {
    if (!available) throw new Error("history unavailable");
    return { sessionId: "retry-stored", messages: [], pagination: { direction: "older", hasMore: false, returned: 0 } } as T;
  });
  const target = { clientSessionId: "retry-client", profileId: "coder", storedSessionId: "retry-stored" };
  harness.api.ensureSession(target);
  await waitFor(() => harness.historyErrors.length === 1);
  assert.equal(harness.socket.frame("session.resume", "retry-stored"), undefined);

  available = true;
  harness.api.ensureSession(target);
  await waitFor(() => harness.socket.frames("session.resume", "retry-stored").length === 1);
  assert.equal(harness.socket.frames("session.resume", "retry-stored").length, 1);
  harness.api.stop();
});

async function createHarness(
  fetchJson?: <T>(path: string, options?: unknown, serverUrl?: string) => Promise<T>,
  eventResult?: (clientSessionId: string) => "resync-required" | void,
) {
  const socket = new FakeWebSocket();
  const ready: Array<{ clientSessionId: string; liveSessionId: string }> = [];
  const histories: string[] = [];
  const historyBodies: string[][] = [];
  const historyResults: Array<{ clientSessionId: string; messages: number; result: Pick<ChatHistoryResult, "truncated" | "partial" | "reason"> }> = [];
  const historyErrors: Array<{ clientSessionId: string; message: string }> = [];
  const events: string[] = [];
  const disconnections: string[] = [];
  const errors: Array<{ clientSessionId: string; message: string }> = [];
  const queued: string[] = [];
  let sequence = 0;
  const callbacks: ChatApiCallbacks = {
    onSocketState() {}, onHistoryLoading() {}, onSessionConnecting() {},
    onSessionQueued(clientSessionId) { queued.push(clientSessionId); },
    onSessionDisconnected(clientSessionId) { disconnections.push(clientSessionId); },
    onHistoryError(clientSessionId, message) { historyErrors.push({ clientSessionId, message }); },
    onSessionError(clientSessionId, message) { errors.push({ clientSessionId, message }); },
    onHistory(clientSessionId, messages, _storedSessionId, result) { histories.push(clientSessionId); historyBodies.push(messages.map(({ body }) => body)); if (result) historyResults.push({ clientSessionId, messages: messages.length, result: { truncated: result.truncated, partial: result.partial, ...(result.reason ? { reason: result.reason } : {}) } }); },
    onSessionReady(clientSessionId, liveSessionId) { ready.push({ clientSessionId, liveSessionId }); },
    onEvent(clientSessionId) { events.push(clientSessionId); return eventResult?.(clientSessionId); },
  };
  const api = connectChatApi(callbacks, {
    serverUrl: "http://127.0.0.1:4317",
    createWebSocket: async () => socket as unknown as WebSocket,
    ...(fetchJson === undefined ? {} : { fetchJson }),
    randomId: () => `rpc-${++sequence}`,
  });
  await flush();
  socket.open();
  await flush();
  return { api, socket, ready, queued, histories, historyBodies, historyResults, historyErrors, events, errors, disconnections };
}

type RpcFrame = { id: string; method: string; params: Record<string, boolean | string> };

class FakeWebSocket {
  readyState = WebSocket.CONNECTING;
  readonly sent: RpcFrame[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  readonly #listeners = new Map<string, Set<(event: { data?: string; code?: number; reason?: string }) => void>>();

  addEventListener(type: string, listener: (event: { data?: string; code?: number; reason?: string }) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  send(body: string): void { this.sent.push(JSON.parse(body) as RpcFrame); }
  close(code = 1000, reason = ""): void { this.closes.push({ code, reason }); this.readyState = WebSocket.CLOSED; this.#emit("close", { code, reason }); }
  open(sendOfficeReady = true): void { this.readyState = WebSocket.OPEN; this.#emit("open", {}); if (sendOfficeReady) this.officeReady(); }
  officeReady(): void { this.#emit("message", { data: JSON.stringify({ jsonrpc: "2.0", method: "office.ready", params: {} }) }); }
  respond(id: string, result?: unknown, error?: unknown): void {
    this.#emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id, ...(error === undefined ? { result } : { error }) }) });
  }
  event(liveSessionId: string, type: string, payload: Record<string, unknown> = {}): void {
    this.#emit("message", { data: JSON.stringify({ jsonrpc: "2.0", method: "event", params: { session_id: liveSessionId, type, payload } }) });
  }
  frame(method: string, value: string): RpcFrame | undefined { return this.frames(method, value)[0]; }
  frames(method: string, value: string): RpcFrame[] {
    return this.sent.filter((frame) => frame.method === method && Object.values(frame.params).includes(value));
  }
  #emit(type: string, event: { data?: string; code?: number; reason?: string }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }
async function waitFor(predicate: () => boolean): Promise<void> { for (let attempt = 0; attempt < 100; attempt += 1) { if (predicate()) return; await flush(); } throw new Error("Timed out waiting for chat history"); }
