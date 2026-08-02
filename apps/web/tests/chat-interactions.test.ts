import assert from "node:assert/strict";
import test from "node:test";
import type { ChatSession, OfficeSnapshot } from "../src/domain.ts";
import { approvalChoicesForAccess } from "../src/components/chat-pane.tsx";
import { applyChatGatewayEvent, applyChatHistory, officeSnapshot, reduceChatGatewayEvent, registerChatRuntime, respondToApproval, sendMessage, sessions } from "../src/store.ts";
import { localizeRuntimeMessage } from "../src/i18n.ts";
import { commitUnconfirmedRpcError } from "../src/chat-rpc-results.ts";

const session: ChatSession = {
  id: "client-1",
  profileId: "builder",
  title: "Build",
  status: "streaming",
  messages: [],
  connectionState: "ready",
  remoteKind: "stored"
};

test("resumed history keeps its ordered latest window before a legitimate same-text live message", () => {
  sessions.value = [{ ...session, messages: [{ id: "live-501", from: "agent", body: "saved agent", at: "12:03", status: "complete" }] }];
  applyChatHistory(session.id, [
    { id: "saved-499", from: "user", body: "saved user", at: "12:01", status: "complete" },
    { id: "saved-500", from: "agent", body: "saved agent", at: "12:02", status: "complete" },
  ], "resolved-session", { truncated: true, partial: true, loadedPages: 20, loadedMessages: 500, loadedBytes: 4_000, reason: "message_limit" });
  assert.deepEqual(sessions.value[0]?.messages.map(({ id }) => id), ["saved-499", "saved-500", "live-501"]);
  assert.equal(sessions.value[0]?.storedSessionId, "resolved-session");
  assert.equal(sessions.value[0]?.historyPartial, true);
});

test("a full history plus a later live row remains bounded and explicitly partial", () => {
  sessions.value = [{ ...session, messages: [{ id: "live-500", from: "agent", body: "latest live", at: "12:03", status: "complete" }] }];
  const history = Array.from({ length: 500 }, (_, index) => ({
    id: `saved-${index}`,
    from: "agent" as const,
    body: `saved ${index}`,
    at: "12:02",
    status: "complete" as const,
  }));
  applyChatHistory(session.id, history, "resolved-session", {
    truncated: false, partial: false, loadedPages: 20, loadedMessages: 500, loadedBytes: 8_000,
  });
  assert.equal(sessions.value[0]?.messages.length, 500);
  assert.equal(sessions.value[0]?.messages[0]?.id, "saved-1");
  assert.equal(sessions.value[0]?.messages.at(-1)?.id, "live-500");
  assert.equal(sessions.value[0]?.historyPartial, true, "the omitted oldest row is never silent");
});

test("malformed saved history exposes its safe notice in chat state", () => {
  sessions.value = [{ ...session }];
  applyChatHistory(session.id, [
    { id: "saved-safe", from: "agent", body: "safe row", at: "12:01", status: "complete" },
  ], "resolved-session", {
    truncated: true,
    partial: true,
    loadedPages: 1,
    loadedMessages: 1,
    loadedBytes: 100,
    reason: "upstream_invalid_rows",
    error: "Hermesの履歴に読み取れない項目があり、その項目を除外して表示しています。",
  });
  assert.equal(sessions.value[0]?.historyPartial, true);
  assert.equal(localizeRuntimeMessage(sessions.value[0]!.historyNotice!), "Hermesの履歴に読み取れない項目があり、その項目を除外して表示しています。");
});

test("clarification requests become durable waiting interactions", () => {
  const next = reduceChatGatewayEvent(session, {
    type: "clarify.request",
    liveSessionId: "live-1",
    payload: { requestId: "request-1", question: "対象はどれですか？", choices: ["A", "B"] }
  });

  assert.equal(next.status, "waiting");
  assert.deepEqual(next.pendingInteraction, {
    id: "clarify:request-1",
    kind: "clarify",
    requestId: "request-1",
    question: "対象はどれですか？",
    choices: ["A", "B"],
    submitting: false
  });
});

test("permanent approval is removed unless the gateway explicitly permits it", () => {
  const next = reduceChatGatewayEvent(session, {
    type: "approval.request",
    liveSessionId: "live-1",
    payload: { approvalId: "approval-one", command: "rm temp.txt", choices: ["once", "always", "deny"], allowPermanent: false }
  });

  assert.equal(next.pendingInteraction?.kind, "approval");
  assert.deepEqual(next.pendingInteraction?.choices, ["once", "deny"]);
  assert.equal(next.pendingInteraction?.kind === "approval" && next.pendingInteraction.allowPermanent, false);
});

test("local owner capability preserves an explicitly allowed permanent approval", () => {
  officeSnapshot.value = snapshotWithOperations(["state.read", "chat.approval.permanent"]);
  try {
    const next = reduceChatGatewayEvent(session, {
      type: "approval.request", liveSessionId: "live-1",
      payload: { approvalId: "approval-owner", choices: ["once", "always"], allowPermanent: true },
    });
    assert.equal(next.pendingInteraction?.kind, "approval");
    assert.deepEqual(next.pendingInteraction?.choices, ["once", "always"]);
    assert.equal(next.pendingInteraction?.kind === "approval" && next.pendingInteraction.allowPermanent, true);
  } finally { officeSnapshot.value = undefined; }
});

test("only the matching expired interaction is cleared", () => {
  const approval = reduceChatGatewayEvent(session, {
    type: "approval.request", liveSessionId: "live-1",
    payload: { approvalId: "approval-old", choices: ["once"], allowPermanent: false },
  });
  const staleExpiry = reduceChatGatewayEvent(approval, {
    type: "approval.expired", liveSessionId: "live-1", payload: { approvalId: "approval-other" },
  });
  assert.equal(staleExpiry, approval);
  const clearedApproval = reduceChatGatewayEvent(approval, {
    type: "approval.expired", liveSessionId: "live-1", payload: { approvalId: "approval-old" },
  });
  assert.equal(clearedApproval.pendingInteraction, undefined);
  assert.equal(clearedApproval.status, "streaming");

  const clarification = reduceChatGatewayEvent(session, {
    type: "clarify.request", liveSessionId: "live-1",
    payload: { requestId: "question-old", question: "Continue?" },
  });
  const clearedClarification = reduceChatGatewayEvent(clarification, {
    type: "clarify.expired", liveSessionId: "live-1", payload: { requestId: "question-old" },
  });
  assert.equal(clearedClarification.pendingInteraction, undefined);
  assert.equal(clearedClarification.status, "streaming");
});

test("approval UI hides permanent choice without current capability", () => {
  const interaction = {
    id: "approval:ui", kind: "approval" as const, approvalId: "ui", choices: ["once", "always", "deny"] as const,
    allowPermanent: true, submitting: false,
  };
  assert.deepEqual(approvalChoicesForAccess({ ...interaction, choices: [...interaction.choices] }, false), ["once", "deny"]);
  assert.deepEqual(approvalChoicesForAccess({ ...interaction, choices: [...interaction.choices] }, true), ["once", "always", "deny"]);
});

test("an older approval completion cannot clear a newly promoted approval", async () => {
  let resolve!: () => void;
  const submitted: string[] = [];
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, submitPrompt() {}, async steer() { return { status: "queued" }; }, interrupt() {},
    async respondClarify() {},
    respondApproval: async (_sessionId, approvalId) => {
      submitted.push(approvalId);
      await new Promise<void>((done) => { resolve = done; });
    },
  });
  sessions.value = [reduceChatGatewayEvent(session, {
    type: "approval.request", liveSessionId: "live-1",
    payload: { approvalId: "approval-A", choices: ["once"], allowPermanent: false },
  })];
  const submission = respondToApproval(session.id, "once");
  applyChatGatewayEvent(session.id, {
    type: "approval.request", liveSessionId: "live-1",
    payload: { approvalId: "approval-B", choices: ["deny"], allowPermanent: false },
  });
  resolve();
  await submission;
  assert.deepEqual(submitted, ["approval-A"]);
  assert.equal(sessions.value[0]!.pendingInteraction?.id, "approval:approval-B");
  const submissionB = respondToApproval(session.id, "deny");
  applyChatGatewayEvent(session.id, {
    type: "approval.request", liveSessionId: "live-1",
    payload: { approvalId: "approval-C", choices: ["once"], allowPermanent: false },
  });
  resolve();
  await submissionB;
  assert.deepEqual(submitted, ["approval-A", "approval-B"]);
  assert.equal(sessions.value[0]!.pendingInteraction?.id, "approval:approval-C");
});

test("a commit-unconfirmed slash command is treated as submitted and cannot invite replay", async () => {
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, submitPrompt() {}, async steer() { return { status: "queued" }; }, interrupt() {},
    async execSlash() { throw commitUnconfirmedRpcError("unknown commit"); },
    async respondClarify() {}, async respondApproval() {},
  });
  sessions.value = [{ ...session, status: "ready", liveSessionId: "live-1" }];

  assert.equal(await sendMessage(session.id, "/undo"), true);
  assert.equal(sessions.value[0]?.operationEvidence?.at(-1)?.state, "unconfirmed");
});

test("duplicate events retain submit lock and completion clears the interaction", () => {
  const waiting: ChatSession = {
    ...session,
    status: "waiting",
    pendingInteraction: {
      id: "clarify:request-1",
      kind: "clarify",
      requestId: "request-1",
      question: "古い質問",
      choices: [],
      submitting: true
    }
  };
  const duplicate = reduceChatGatewayEvent(waiting, {
    type: "clarify.request",
    liveSessionId: "live-1",
    payload: { requestId: "request-1", question: "更新された質問", choices: [] }
  });
  assert.equal(duplicate.pendingInteraction?.submitting, true);

  const complete = reduceChatGatewayEvent(duplicate, {
    type: "message.complete",
    liveSessionId: "live-1",
    payload: { messageId: "message-1", text: "完了" }
  });
  assert.equal(complete.pendingInteraction, undefined);
});

test("private sudo and secret events are never promoted to public interactions", () => {
  assert.equal(reduceChatGatewayEvent(session, { type: "sudo.request", liveSessionId: "live-1" }), session);
  assert.equal(reduceChatGatewayEvent(session, { type: "secret.request", liveSessionId: "live-1" }), session);
});

function snapshotWithOperations(allowedOperations: OfficeSnapshot["capabilities"]["access"]["allowedOperations"]): OfficeSnapshot {
  return {
    generatedAt: "2026-07-16T00:00:00.000Z", sequence: 1,
    capabilities: {
      protocolVersion: 1, serverVersion: "0.1.0", runtime: { state: "ready" }, features: ["chat"],
      access: { deviceId: "local-browser", tier: "owner", exposure: "loopback", authentication: "local-cookie", allowedOperations },
    },
    profiles: [], sessions: [], inventory: { profiles: emptyPage(), sessions: emptyPage() }, boards: [],
  };
}

function emptyPage() { return { returned: 0, available: 0, total: 0, hasMore: false, truncated: false, partialFailures: 0 }; }
