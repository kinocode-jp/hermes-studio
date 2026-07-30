import assert from "node:assert/strict";
import test from "node:test";
import type { ChatPromptResult, ChatSteerResult } from "../src/chat-api.ts";
import type { ChatSession } from "../src/domain.ts";
import { chatMessageBody, chatSessionTitle, locale, localizeRuntimeMessage, officeMessage, officeRuntimeMessage, setLocale, t } from "../src/i18n.ts";
import { buildChatTimeline, chatComposerState, formatChatMessageTime, nextOperationAnnouncement, operationAnnouncementText, presentedOperationEvidence, shouldSubmitComposerKey } from "../src/components/chat-pane.tsx";
import { canSteerChatSession, canSubmitChatPrompt, isChatRunActive, mergeGatewayStatusUpdate, mergeServerSessionStatus } from "../src/session-runtime.ts";
import { boundedSteerEvidence, MAX_STEER_EVIDENCE_BYTES, MAX_STEER_EVIDENCE_COUNT } from "../src/chat-run-actions.ts";
import { commitUnconfirmedRpcError, explicitRpcRejection } from "../src/chat-rpc-results.ts";
import {
  applyChatHistory,
  cancelSessionModelChange,
  closeSession,
  interruptSession,
  openSessionIds,
  reduceChatGatewayEvent,
  registerChatRuntime,
  reconcilePromptOperationsWithHistory,
  sendMessage,
  sessions,
  setChatHistoryLoading,
  setChatSessionDisconnected,
  setChatSessionReady,
  stageSessionModelChange,
  steerSession,
} from "../src/store.ts";

const ready: ChatSession = {
  id: "client", storedSessionId: "stored", liveSessionId: "live", profileId: "profile", title: "Session",
  status: "ready", messages: [], remoteKind: "stored", connectionState: "ready", historyState: "loaded"
};

test("server status merge advances fresh work but never regresses authoritative local work", () => {
  assert.equal(mergeServerSessionStatus(ready, "thinking"), "streaming");
  assert.equal(mergeServerSessionStatus({ ...ready, status: "streaming" }, "idle"), "streaming");
  assert.equal(mergeServerSessionStatus({ ...ready, status: "waiting" }, "using-tool"), "waiting");
  assert.equal(mergeServerSessionStatus({ ...ready, status: "ready", streamingMessageId: "live" }, "idle"), "streaming");
  assert.equal(mergeServerSessionStatus({ ...ready, connectionState: "error" }, "thinking"), "ready");
});

test("approval and clarification interactions remain waiting across stale inventory observations", () => {
  const approval: ChatSession = {
    ...ready, status: "waiting",
    pendingInteraction: { id: "approval:a", kind: "approval", approvalId: "a", choices: ["once"], allowPermanent: false, submitting: false }
  };
  const clarification: ChatSession = {
    ...ready, status: "waiting",
    pendingInteraction: { id: "clarify:c", kind: "clarify", requestId: "c", question: "Which?", choices: [], submitting: false }
  };
  assert.equal(mergeServerSessionStatus(approval, "idle"), "waiting");
  assert.equal(mergeServerSessionStatus(approval, "thinking"), "waiting");
  assert.equal(mergeServerSessionStatus(clarification, "idle"), "waiting");
  assert.equal(canSubmitChatPrompt(approval), false);
  assert.equal(canSubmitChatPrompt(clarification), false);
});

test("sendMessage rejects every in-flight shape and atomically blocks a second prompt", () => {
  const submitted: string[] = [];
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, async steer() { return { status: "queued" }; }, interrupt() {},
    submitPrompt(_sessionId, text) { submitted.push(text); },
    async respondClarify() {}, async respondApproval() {}
  });

  sessions.value = [{ ...ready }];
  sendMessage(ready.id, "first");
  sendMessage(ready.id, "second");
  assert.deepEqual(submitted, ["first"]);
  assert.equal(sessions.value[0]?.messages.filter((message) => message.from === "user").length, 0);
  assert.equal(sessions.value[0]?.operationEvidence?.length, 1);
  assert.equal(Number.isNaN(Date.parse(sessions.value[0]!.operationEvidence![0]!.at)), false);

  sessions.value = [{ ...ready, streamingMessageId: "hidden-live" }];
  sendMessage(ready.id, "marker");
  sessions.value = [{ ...ready, messages: [{ id: "hidden", from: "agent", body: "", at: "00:00", status: "streaming" }] }];
  sendMessage(ready.id, "message");
  sessions.value = [{ ...ready, status: "waiting" }];
  sendMessage(ready.id, "waiting");
  assert.deepEqual(submitted, ["first"]);
});

test("only allowlisted slash names use slash.exec and a slash command is single-flight", async () => {
  const slash = deferred<import("../src/chat-api.ts").ChatSlashResult>();
  const slashCommands: string[] = [];
  const prompts: string[] = [];
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, async steer() { return { status: "queued" }; }, interrupt() {},
    submitPrompt(_sessionId, text) { prompts.push(text); },
    execSlash(_sessionId, command) { slashCommands.push(command); return slash.promise; },
    async respondClarify() {}, async respondApproval() {},
  });
  sessions.value = [{ ...ready }];
  const first = sendMessage(ready.id, "/undo");
  assert.equal(sendMessage(ready.id, "/undo"), false);
  assert.deepEqual(slashCommands, ["/undo"]);
  slash.resolve({ status: "ok", output: "undone", warning: "", action: "prefill", message: "edit me" });
  assert.equal(await first, true);
  assert.equal(sessions.value[0]?.composerPrefill?.text, "edit me");

  sessions.value = [{ ...ready }];
  assert.equal(sendMessage(ready.id, "/tmp/output"), true);
  assert.deepEqual(prompts, ["/tmp/output"]);
});

test("a commit-unconfirmed slash mutation is recorded as ambiguous rather than rejected", async () => {
  let calls = 0;
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, async steer() { return { status: "queued" }; }, interrupt() {},
    submitPrompt() {},
    async execSlash() {
      calls += 1;
      throw commitUnconfirmedRpcError("slash acknowledgement lost");
    },
    async respondClarify() {}, async respondApproval() {},
  });
  sessions.value = [{ ...ready }];

  assert.equal(await sendMessage(ready.id, "/undo"), false);
  assert.equal(calls, 1);
  assert.deepEqual(
    sessions.value[0]?.operationEvidence?.map(({ body, state, message }) => ({ body, state, message })),
    [{ body: "/undo", state: "unconfirmed", message: "slash acknowledgement lost" }],
  );
});

test("an expensive model confirmation is reissued only after operator approval", async () => {
  const calls: Array<{ command: string; confirmed: boolean | undefined }> = [];
  const originalConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  try {
    registerChatRuntime({
      ensureSession() {}, releaseSession() {}, async steer() { return { status: "queued" }; }, interrupt() {},
      submitPrompt() {},
      async execSlash(_sessionId, command, confirmed) {
        calls.push({ command, confirmed });
        return confirmed
          ? { status: "ok", output: "switched", warning: "", key: "model", value: "costly-model" }
          : { status: "confirm-required", output: "", warning: "High known pricing", confirmMessage: "Continue with costly-model?" };
      },
      async respondClarify() {}, async respondApproval() {},
    });
    sessions.value = [{ ...ready, provider: "old-provider", model: "old-model" }];

    assert.equal(await sendMessage(ready.id, "/model costly-model --provider costly --session"), true);
    assert.deepEqual(calls, [
      { command: "/model costly-model --provider costly --session", confirmed: undefined },
      { command: "/model costly-model --provider costly --session", confirmed: true },
    ]);
    assert.equal(sessions.value[0]?.model, "costly-model");
    assert.equal(sessions.value[0]?.provider, "costly");
  } finally {
    globalThis.confirm = originalConfirm;
  }
});

test("message.complete strips streamed follow-up envelopes when the terminal event omits text", () => {
  const streamed = {
    ...ready,
    status: "streaming" as const,
    streamingMessageId: "reply",
    messages: [{
      id: "reply", from: "agent" as const,
      body: "Visible answer\n<studio-followups>\n- Next question?\n</studio-followups>",
      at: "00:00", status: "streaming" as const,
    }],
  };
  const completed = reduceChatGatewayEvent(streamed, {
    type: "message.complete", liveSessionId: "live", payload: { messageId: "reply" },
  });
  assert.equal(completed.messages[0]?.body, "Visible answer");
  assert.deepEqual(completed.followUpSuggestions, ["Next question?"]);
});

test("message.interim seals streamed commentary so message.complete cannot wipe it", () => {
  let session = {
    ...ready,
    status: "streaming" as const,
    streamingMessageId: "stream-1",
    messages: [{
      id: "stream-1", from: "agent" as const,
      body: "Let me start by planning the approach.",
      at: "00:00", status: "streaming" as const,
    }],
  };
  session = reduceChatGatewayEvent(session, {
    type: "message.interim", liveSessionId: "live",
    payload: { messageId: "stream-1", text: "Let me start by planning the approach." },
  });
  assert.equal(session.messages[0]?.status, "complete");
  assert.equal(session.streamingMessageId, undefined);
  assert.equal(session.status, "streaming");

  session = reduceChatGatewayEvent(session, {
    type: "message.delta", liveSessionId: "live",
    payload: { text: "All done! Here is the complete summary." },
  });
  assert.equal(session.messages.length, 2);
  assert.equal(session.messages[0]?.body, "Let me start by planning the approach.");
  assert.equal(session.messages[1]?.status, "streaming");

  const completed = reduceChatGatewayEvent(session, {
    type: "message.complete", liveSessionId: "live",
    payload: { messageId: session.streamingMessageId, text: "All done! Here is the complete summary." },
  });
  assert.deepEqual(completed.messages.map((message) => message.body), [
    "Let me start by planning the approach.",
    "All done! Here is the complete summary.",
  ]);
  assert.equal(completed.status, "ready");
});

test("message.complete without text keeps sealed interim replies", () => {
  const sealed = {
    ...ready,
    status: "streaming" as const,
    messages: [{
      id: "interim-1", from: "agent" as const,
      body: "Progress update while tools run.",
      at: "00:00", status: "complete" as const,
    }],
  };
  const completed = reduceChatGatewayEvent(sealed, {
    type: "message.complete", liveSessionId: "live", payload: {},
  });
  assert.equal(completed.messages[0]?.body, "Progress update while tools run.");
  assert.equal(completed.status, "ready");
});

test("reused upstream message ids append later turns without rewriting chronology", () => {
  let session: ChatSession = {
    ...ready,
    messages: [{ id: "user-1", from: "user", body: "first prompt", at: "23:26", status: "complete" }],
  };

  session = reduceChatGatewayEvent(session, {
    type: "message.start", liveSessionId: "live", payload: { messageId: "assistant" },
  });
  session = reduceChatGatewayEvent(session, {
    type: "message.interim", liveSessionId: "live", payload: { messageId: "assistant", text: "first progress" },
  });
  session = reduceChatGatewayEvent(session, {
    type: "message.delta", liveSessionId: "live", payload: { text: "first answer" },
  });
  session = reduceChatGatewayEvent(session, {
    type: "message.complete", liveSessionId: "live", payload: { text: "first answer" },
  });
  session = {
    ...session,
    messages: [...session.messages, { id: "user-2", from: "user", body: "second prompt", at: "01:12", status: "complete" }],
  };

  session = reduceChatGatewayEvent(session, {
    type: "message.start", liveSessionId: "live", payload: { messageId: "assistant" },
  });
  session = reduceChatGatewayEvent(session, {
    type: "message.interim", liveSessionId: "live", payload: { messageId: "assistant", text: "second progress" },
  });
  session = reduceChatGatewayEvent(session, {
    type: "message.delta", liveSessionId: "live", payload: { text: "second answer" },
  });
  session = reduceChatGatewayEvent(session, {
    type: "message.complete", liveSessionId: "live", payload: { text: "second answer" },
  });

  assert.deepEqual(session.messages.map(({ body }) => body), [
    "first prompt",
    "first progress",
    "first answer",
    "second prompt",
    "second progress",
    "second answer",
  ]);
  assert.equal(new Set(session.messages.map(({ id }) => id)).size, session.messages.length);
});

test("an explicit source id cannot redirect a delayed event into the current stream", () => {
  const active: ChatSession = {
    ...ready,
    status: "streaming",
    streamingMessageId: "current#2",
    streamingSourceMessageId: "current",
    messages: [{ id: "current#2", from: "agent", body: "current text", at: "01:12", status: "streaming" }],
  };
  const afterDelayedDelta = reduceChatGatewayEvent(active, {
    type: "message.delta", liveSessionId: "live", payload: { messageId: "previous", text: "delayed text" },
  });

  assert.equal(afterDelayedDelta, active);
  assert.deepEqual(afterDelayedDelta.messages.map(({ body }) => body), ["current text"]);
  assert.equal(afterDelayedDelta.streamingMessageId, "current#2");
  assert.equal(afterDelayedDelta.streamingSourceMessageId, "current");
  const afterDelayedComplete = reduceChatGatewayEvent(active, {
    type: "message.complete", liveSessionId: "live", payload: { messageId: "previous", text: "old answer" },
  });
  assert.equal(afterDelayedComplete, active);
  assert.equal(afterDelayedComplete.status, "streaming");

  const unclaimed: ChatSession = {
    ...active,
    streamingMessageId: "stream-live",
    streamingSourceMessageId: undefined,
    messages: [{ id: "stream-live", from: "agent", body: "current text", at: "01:12", status: "streaming" }],
  };
  const afterExplicitAgainstUnclaimed = reduceChatGatewayEvent(unclaimed, {
    type: "message.complete", liveSessionId: "live", payload: { messageId: "current-late-id", text: "current answer" },
  });
  assert.equal(afterExplicitAgainstUnclaimed.status, "ready");
  assert.equal(afterExplicitAgainstUnclaimed.messages[0]?.body, "current answer");
});

test("a server message occurrence keeps upstream aliases on one assistant row", () => {
  let session = reduceChatGatewayEvent(ready, {
    type: "message.start", liveSessionId: "live",
    payload: { messageOccurrenceId: "message-occurrence-1", messageId: "alias-start", runId: "run-alias", runSequence: 1 },
  });
  session = reduceChatGatewayEvent(session, {
    type: "message.delta", liveSessionId: "live",
    payload: { messageOccurrenceId: "message-occurrence-1", messageId: "alias-delta", text: "aliased answer", runId: "run-alias", runSequence: 1 },
  });
  session = reduceChatGatewayEvent(session, {
    type: "message.complete", liveSessionId: "live",
    payload: { messageOccurrenceId: "message-occurrence-1", messageId: "alias-complete", text: "aliased answer", runId: "run-alias", runSequence: 1 },
  });

  assert.equal(session.status, "ready");
  assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0]?.id, "message-occurrence-1");
  assert.equal(session.messages[0]?.body, "aliased answer");
  assert.equal(session.messages[0]?.status, "complete");
});

test("a repeated terminal message is idempotent after the run completes", () => {
  let session = reduceChatGatewayEvent(ready, {
    type: "message.start", liveSessionId: "live", payload: { messageId: "reply", runId: "run-1" },
  });
  session = reduceChatGatewayEvent(session, {
    type: "message.complete", liveSessionId: "live", payload: { messageId: "reply", text: "done", runId: "run-1" },
  });
  const replayed = reduceChatGatewayEvent(session, {
    type: "message.complete", liveSessionId: "live", payload: { messageId: "reply", text: "done", runId: "run-1" },
  });

  assert.equal(replayed, session);
  assert.deepEqual(replayed.messages.map(({ body }) => body), ["done"]);
});

test("a replay from more than one completed run ago remains stale", () => {
  let session = ready;
  for (const [runId, body] of [["run-1", "first"], ["run-2", "second"], ["run-3", "third"]] as const) {
    session = reduceChatGatewayEvent(session, {
      type: "message.start", liveSessionId: "live", payload: { messageId: `reply-${runId}`, runId },
    });
    session = reduceChatGatewayEvent(session, {
      type: "message.complete", liveSessionId: "live", payload: { messageId: `reply-${runId}`, text: body, runId },
    });
  }
  const replayed = reduceChatGatewayEvent(session, {
    type: "message.start", liveSessionId: "live", payload: { messageId: "reply-run-1", runId: "run-1" },
  });

  assert.equal(replayed, session);
  assert.deepEqual(replayed.messages.map(({ body }) => body), ["first", "second", "third"]);
});

test("a completed run below the high-water mark stays stale without an id retention window", () => {
  const session: ChatSession = {
    ...ready,
    chatCorrelationEpoch: "epoch",
    completedChatRunServerSequence: 10_000,
    processedChatEventSequence: 20_000,
  };
  const replayed = reduceChatGatewayEvent(session, {
    type: "message.start",
    liveSessionId: "live",
    payload: {
      correlationEpoch: "epoch",
      eventId: "event-epoch-20001",
      eventSequence: 20_001,
      messageId: "ancient-reply",
      runId: "run-epoch-1",
      runSequence: 1,
    },
  });

  assert.equal(replayed.messages, session.messages);
  assert.equal(replayed.completedChatRunServerSequence, 10_000);
  assert.equal(replayed.processedChatEventSequence, 20_001);
});

test("a processed gateway event cannot reopen the transcript after its run completes", () => {
  let session = reduceChatGatewayEvent(ready, {
    type: "message.start", liveSessionId: "live",
    payload: { correlationEpoch: "epoch", eventId: "event-epoch-1", eventSequence: 1, runId: "run-epoch-1", runSequence: 1 },
  });
  session = reduceChatGatewayEvent(session, {
    type: "message.complete", liveSessionId: "live",
    payload: { correlationEpoch: "epoch", eventId: "event-epoch-2", eventSequence: 2, runId: "run-epoch-1", runSequence: 1, text: "done" },
  });
  const replayed = reduceChatGatewayEvent(session, {
    type: "message.start", liveSessionId: "live",
    payload: { correlationEpoch: "epoch", eventId: "event-epoch-1", eventSequence: 1, runId: "run-epoch-1", runSequence: 1 },
  });

  assert.equal(replayed, session);
  assert.deepEqual(replayed.messages.map(({ body }) => body), ["done"]);
});

test("a terminal event from the previous run cannot finish a newly submitted prompt", () => {
  let session = reduceChatGatewayEvent(ready, {
    type: "message.start", liveSessionId: "live", payload: { messageId: "reply", runId: "run-epoch-1", runSequence: 1 },
  });
  session = reduceChatGatewayEvent(session, {
    type: "message.complete", liveSessionId: "live", payload: { messageId: "reply", text: "old answer", runId: "run-epoch-1", runSequence: 1 },
  });
  const awaitingNewRun = { ...session, status: "streaming" as const };
  const delayed = reduceChatGatewayEvent(awaitingNewRun, {
    type: "message.complete", liveSessionId: "live", payload: { messageId: "reply", text: "old answer", runId: "run-epoch-1", runSequence: 1 },
  });
  assert.equal(delayed, awaitingNewRun);
  const delayedStart = reduceChatGatewayEvent(awaitingNewRun, {
    type: "message.start", liveSessionId: "live", payload: { messageId: "reply", runId: "run-epoch-1", runSequence: 1 },
  });
  assert.equal(delayedStart, awaitingNewRun);
  const delayedTool = reduceChatGatewayEvent(awaitingNewRun, {
    type: "tool.complete", liveSessionId: "live",
    payload: { toolOccurrenceId: "old-tool", runId: "run-epoch-1", runSequence: 1, name: "Shell", summary: "old done" },
  });
  assert.equal(delayedTool, awaitingNewRun);

  const next = reduceChatGatewayEvent(delayedTool, {
    type: "message.start", liveSessionId: "live", payload: { messageId: "reply", runId: "run-epoch-2", runSequence: 2 },
  });
  assert.equal(next.status, "streaming");
  assert.equal(next.chatRunId, "run-epoch-2");
  assert.equal(next.messages.length, 2);
});

test("a repeated message.start reuses the active assistant row", () => {
  const started = reduceChatGatewayEvent(ready, {
    type: "message.start", liveSessionId: "live", payload: {},
  });
  const replayed = reduceChatGatewayEvent(started, {
    type: "message.start", liveSessionId: "live", payload: { messageId: "reply-late-id" },
  });

  assert.equal(replayed.messages.length, 1);
  assert.equal(replayed.streamingMessageId, started.streamingMessageId);
  assert.equal(replayed.streamingSourceMessageId, "reply-late-id");
  assert.equal(replayed.chatRunSequence, started.chatRunSequence);
});

test("a repeated message.start after an interim seal cannot create another run", () => {
  let session = reduceChatGatewayEvent(ready, {
    type: "message.start", liveSessionId: "live", payload: { messageId: "reply" },
  });
  session = reduceChatGatewayEvent(session, {
    type: "message.interim", liveSessionId: "live", payload: { messageId: "reply", text: "progress" },
  });
  const replayed = reduceChatGatewayEvent(session, {
    type: "message.start", liveSessionId: "live", payload: { messageId: "reply" },
  });

  assert.equal(replayed.messages.length, 1);
  assert.equal(replayed.messages[0]?.body, "progress");
  assert.equal(replayed.streamingMessageId, undefined);
  assert.equal(replayed.chatRunSequence, session.chatRunSequence);
  assert.deepEqual(replayed.interimMessageIds, session.interimMessageIds);
});

test("a repeated completed tool id creates a later row instead of rewriting the old event", () => {
  let session = reduceChatGatewayEvent(ready, {
    type: "message.start", liveSessionId: "live", payload: { messageId: "reply-1" },
  });
  session = reduceChatGatewayEvent(session, {
    type: "tool.start", liveSessionId: "live", payload: { toolId: "tool-1", summary: "first run" },
  });
  session = reduceChatGatewayEvent(session, {
    type: "tool.complete", liveSessionId: "live", payload: { toolId: "tool-1", summary: "first complete" },
  });
  const replayed = reduceChatGatewayEvent(session, {
    type: "tool.complete", liveSessionId: "live", payload: { toolId: "tool-1", summary: "first complete" },
  });
  assert.equal(replayed, session);
  session = reduceChatGatewayEvent(session, {
    type: "message.complete", liveSessionId: "live", payload: { messageId: "reply-1", text: "first answer" },
  });
  session = reduceChatGatewayEvent(session, {
    type: "message.start", liveSessionId: "live", payload: { messageId: "reply-2" },
  });
  session = reduceChatGatewayEvent(session, {
    type: "tool.start", liveSessionId: "live", payload: { toolId: "tool-1", summary: "second run" },
  });
  session = reduceChatGatewayEvent(session, {
    type: "tool.complete", liveSessionId: "live", payload: { toolId: "tool-1", summary: "first complete" },
  });

  const toolMessages = session.messages.filter(({ from }) => from === "tool");
  assert.deepEqual(toolMessages.map(({ body }) => body), ["Tool: first complete", "Tool: first complete"]);
  assert.deepEqual(toolMessages.map(({ status }) => status), ["complete", "complete"]);
  assert.notEqual(toolMessages[0]?.id, toolMessages[1]?.id);
});

test("sequential tools without upstream ids remain separate within one run", () => {
  let session = reduceChatGatewayEvent(ready, {
    type: "message.start", liveSessionId: "live", payload: { messageId: "reply" },
  });
  session = reduceChatGatewayEvent(session, {
    type: "tool.start", liveSessionId: "live", payload: { name: "First", summary: "running" },
  });
  session = reduceChatGatewayEvent(session, {
    type: "tool.complete", liveSessionId: "live", payload: { name: "First", summary: "done" },
  });
  session = reduceChatGatewayEvent(session, {
    type: "tool.start", liveSessionId: "live", payload: { name: "Second", summary: "running" },
  });
  session = reduceChatGatewayEvent(session, {
    type: "tool.complete", liveSessionId: "live", payload: { name: "Second", summary: "done" },
  });

  const tools = session.messages.filter(({ from }) => from === "tool");
  assert.deepEqual(tools.map(({ body }) => body), ["First: done", "Second: done"]);
  assert.equal(new Set(tools.map(({ id }) => id)).size, 2);
});

test("overlapping tool starts without upstream ids never overwrite one another", () => {
  let session = reduceChatGatewayEvent(ready, {
    type: "message.start", liveSessionId: "live", payload: { messageId: "reply", runId: "run-tools" },
  });
  session = reduceChatGatewayEvent(session, {
    type: "tool.start", liveSessionId: "live", payload: { toolOccurrenceId: "occ-first", runId: "run-tools", name: "First", summary: "first running" },
  });
  session = reduceChatGatewayEvent(session, {
    type: "tool.start", liveSessionId: "live", payload: { toolOccurrenceId: "occ-second", runId: "run-tools", name: "Second", summary: "second running" },
  });
  const replayedStart = reduceChatGatewayEvent(session, {
    type: "tool.start", liveSessionId: "live", payload: { toolOccurrenceId: "occ-second", runId: "run-tools", name: "Second", summary: "second running" },
  });
  assert.equal(replayedStart.messages.length, session.messages.length);
  session = reduceChatGatewayEvent(replayedStart, {
    type: "tool.complete", liveSessionId: "live", payload: { toolOccurrenceId: "occ-first", runId: "run-tools", name: "First", summary: "first done" },
  });
  session = reduceChatGatewayEvent(session, {
    type: "tool.complete", liveSessionId: "live", payload: { toolOccurrenceId: "occ-second", runId: "run-tools", name: "Second", summary: "second done" },
  });

  const tools = session.messages.filter(({ from }) => from === "tool");
  assert.deepEqual(tools.map(({ body }) => body), ["First: first done", "Second: second done"]);
  assert.equal(new Set(tools.map(({ id }) => id)).size, 2);
  assert.deepEqual(tools.map(({ status }) => status), ["complete", "complete"]);
});

test("a tool event can claim a run before message.start without splitting its run sequence", () => {
  let session = reduceChatGatewayEvent({ ...ready, status: "streaming" }, {
    type: "tool.start", liveSessionId: "live",
    payload: { toolOccurrenceId: "early-tool", runId: "run-early", name: "Shell", summary: "running" },
  });
  const claimedSequence = session.chatRunSequence;
  session = reduceChatGatewayEvent(session, {
    type: "tool.progress", liveSessionId: "live",
    payload: { toolOccurrenceId: "early-tool", runId: "run-early", name: "Shell", summary: "working" },
  });
  session = reduceChatGatewayEvent(session, {
    type: "message.start", liveSessionId: "live", payload: { messageId: "reply", runId: "run-early" },
  });

  assert.equal(session.chatRunSequence, claimedSequence);
  assert.equal(session.messages.filter(({ from }) => from === "tool").length, 1);
  assert.equal(session.messages.filter(({ from }) => from === "agent").length, 1);
});

test("history reload restores authored follow-ups and clears suggestions when the reply is undone", () => {
  sessions.value = [{ ...ready, followUpSuggestions: ["stale suggestion"] }];
  applyChatHistory(ready.id, [{
    id: "saved-reply",
    from: "agent",
    body: "Saved answer\n<studio-followups>\n- Continue from history?\n</studio-followups>",
    at: "00:00",
    status: "complete",
  }]);
  assert.equal(sessions.value[0]?.messages[0]?.body, "Saved answer");
  assert.deepEqual(sessions.value[0]?.followUpSuggestions, ["Continue from history?"]);

  setChatHistoryLoading(ready.id, true);
  applyChatHistory(ready.id, []);
  assert.equal(sessions.value[0]?.followUpSuggestions, undefined);
});

test("a model switch stays cancellable until send and remains retryable after failure", async () => {
  const slashCommands: string[] = [];
  const submitted: string[] = [];
  let rejectSlash = true;
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, async steer() { return { status: "queued" }; }, interrupt() {},
    submitPrompt(_sessionId, text) { submitted.push(text); },
    async execSlash(_sessionId, command) {
      slashCommands.push(command);
      if (rejectSlash) throw new Error("model unavailable");
      return { status: "ok", output: "switched", warning: "" };
    },
    async respondClarify() {}, async respondApproval() {},
  });

  sessions.value = [{ ...ready, provider: "old-provider", model: "old-model" }];
  stageSessionModelChange(ready.id, "new-provider", "new-model");
  assert.equal(sessions.value[0]?.pendingModelChange?.applying, undefined);
  assert.deepEqual(slashCommands, []);

  assert.equal(await sendMessage(ready.id, "keep this prompt"), false);
  assert.equal(sessions.value[0]?.pendingModelChange?.applying, false);
  assert.equal(sessions.value[0]?.model, "new-model");
  assert.deepEqual(submitted, []);

  rejectSlash = false;
  assert.equal(await sendMessage(ready.id, "keep this prompt"), true);
  assert.equal(sessions.value[0]?.pendingModelChange, undefined);
  assert.deepEqual(slashCommands, [
    "/model new-model --provider new-provider --session",
    "/model new-model --provider new-provider --session",
  ]);
  assert.equal(submitted.length, 1);
  assert.match(submitted[0]!, /^keep this prompt/);
});

test("a rejected manual model command rolls back an unsent staged picker change", async () => {
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, async steer() { return { status: "queued" }; }, interrupt() {},
    submitPrompt() {},
    async execSlash() { throw new Error("model unavailable"); },
    async respondClarify() {}, async respondApproval() {},
  });
  sessions.value = [{ ...ready, provider: "old-provider", model: "old-model", reasoningEffort: "low" }];

  stageSessionModelChange(ready.id, "staged-provider", "staged-model", "high");
  assert.equal(sessions.value[0]?.model, "staged-model");
  assert.equal(await sendMessage(ready.id, "/model invalid-model --provider invalid --session"), false);
  assert.equal(sessions.value[0]?.pendingModelChange, undefined);
  assert.equal(sessions.value[0]?.provider, "old-provider");
  assert.equal(sessions.value[0]?.model, "old-model");
  assert.equal(sessions.value[0]?.reasoningEffort, "low");
});

test("a reasoning failure never rolls back an already applied model in local state", async () => {
  const slashCommands: string[] = [];
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, async steer() { return { status: "queued" }; }, interrupt() {},
    submitPrompt() {},
    async execSlash(_sessionId, command) {
      slashCommands.push(command);
      if (command.startsWith("/reasoning")) throw new Error("reasoning unavailable");
      return { status: "ok", output: "switched", warning: "", key: "model", value: "new-model" };
    },
    async respondClarify() {}, async respondApproval() {},
  });
  sessions.value = [{ ...ready, provider: "old-provider", model: "old-model", reasoningEffort: "low" }];

  stageSessionModelChange(ready.id, "new-provider", "new-model", "high");
  assert.equal(await sendMessage(ready.id, "after switch"), false);
  assert.equal(sessions.value[0]?.pendingModelChange?.applying, false);
  assert.equal(sessions.value[0]?.pendingModelChange?.modelApplied, true);

  cancelSessionModelChange(ready.id);
  assert.equal(sessions.value[0]?.pendingModelChange, undefined);
  assert.equal(sessions.value[0]?.model, "new-model");
  assert.equal(sessions.value[0]?.provider, "new-provider");
  assert.equal(sessions.value[0]?.reasoningEffort, "low");
  assert.deepEqual(slashCommands, [
    "/model new-model --provider new-provider --session",
    "/reasoning high",
  ]);
});

test("selecting model-default reasoning clears the live session override before the prompt", async () => {
  const slashCommands: string[] = [];
  const submitted: string[] = [];
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, async steer() { return { status: "queued" }; }, interrupt() {},
    submitPrompt(_sessionId, text) { submitted.push(text); },
    async execSlash(_sessionId, command) {
      slashCommands.push(command);
      return command.startsWith("/reasoning")
        ? { status: "ok", output: "", warning: "", key: "reasoning", value: "" }
        : { status: "ok", output: "", warning: "", key: "model", value: "same-model" };
    },
    async respondClarify() {}, async respondApproval() {},
  });
  sessions.value = [{ ...ready, provider: "same-provider", model: "same-model", reasoningEffort: "high" }];

  stageSessionModelChange(ready.id, "same-provider", "same-model", "");
  assert.equal(sessions.value[0]?.pendingModelChange?.reasoningCommand, "/reasoning default");
  assert.equal(await sendMessage(ready.id, "use the default"), true);
  assert.deepEqual(slashCommands, [
    "/model same-model --provider same-provider --session",
    "/reasoning default",
  ]);
  assert.equal(sessions.value[0]?.reasoningEffort, undefined);
  assert.deepEqual(submitted, ["use the default"]);
});

test("re-picking after partial model success promotes the applied model to the rollback baseline", async () => {
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, async steer() { return { status: "queued" }; }, interrupt() {},
    submitPrompt() {},
    async execSlash(_sessionId, command) {
      if (command.startsWith("/reasoning") || command.includes("next-model")) {
        throw new Error("switch unavailable");
      }
      return { status: "ok", output: "switched", warning: "", key: "model", value: "new-model" };
    },
    async respondClarify() {}, async respondApproval() {},
  });
  sessions.value = [{ ...ready, provider: "old-provider", model: "old-model", reasoningEffort: "low" }];

  stageSessionModelChange(ready.id, "new-provider", "new-model", "high");
  assert.equal(await sendMessage(ready.id, "first attempt"), false);
  assert.equal(sessions.value[0]?.pendingModelChange?.modelApplied, true);

  stageSessionModelChange(ready.id, "next-provider", "next-model", "medium");
  assert.equal(await sendMessage(ready.id, "second attempt"), false);
  assert.deepEqual(sessions.value[0]?.pendingModelChange?.baseline, {
    provider: "new-provider",
    model: "new-model",
    reasoningEffort: "low",
  });
  assert.equal(sessions.value[0]?.pendingModelChange?.modelApplied, undefined);

  cancelSessionModelChange(ready.id);
  assert.equal(sessions.value[0]?.model, "new-model");
  assert.equal(sessions.value[0]?.provider, "new-provider");
  assert.equal(sessions.value[0]?.reasoningEffort, "low");
});

test("prompt submissions expose pending, accepted, rejected, and commit-unknown states without automatic replay", async () => {
  const submission = deferred<ChatPromptResult>();
  const calls: Array<{ text: string; operationId: string }> = [];
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, interrupt() {}, async steer() { return { status: "queued" }; },
    submitPrompt(_sessionId, text, operationId) { calls.push({ text, operationId }); return submission.promise; },
    async respondClarify() {}, async respondApproval() {},
  });
  sessions.value = [{ ...ready }];
  sendMessage(ready.id, "deploy once");
  const pending = sessions.value[0]!.operationEvidence![0]!;
  assert.equal(pending.state, "pending");
  assert.equal(pending.kind, "prompt");
  assert.equal(sessions.value[0]!.messages.length, 0, "local RPC evidence must not corrupt the durable transcript");
  assert.equal(calls.length, 1);

  submission.resolve({ status: "unconfirmed", message: "socket closed after send" });
  await Promise.resolve();
  assert.equal(sessions.value[0]!.operationEvidence![0]!.state, "unconfirmed");
  assert.equal(canSubmitChatPrompt(sessions.value[0]!), true, "the operator may decide what to do after reviewing commit-unknown evidence");
  assert.equal(calls.length, 1, "commit-unknown prompts must never be replayed automatically");

  for (const result of [
    { status: "accepted" } as const,
    { status: "rejected", message: "policy denied" } as const,
  ]) {
    sessions.value = [{ ...ready }];
    registerChatRuntime({
      ensureSession() {}, releaseSession() {}, interrupt() {}, async steer() { return { status: "queued" }; },
      async submitPrompt() { return result; }, async respondClarify() {}, async respondApproval() {},
    });
    const sent = await sendMessage(ready.id, result.status);
    assert.equal(sent, result.status !== "rejected");
    assert.equal(sessions.value[0]!.operationEvidence![0]!.state, result.status);
    assert.equal(sessions.value[0]!.messages.length, 0);
  }
});

test("authoritative history preserves prompt operation evidence without a durable operation id", () => {
  const at = "2026-07-17T01:00:00.000Z";
  const operation = (id: string, body: string, state: "accepted" | "rejected" | "unconfirmed") => ({
    id, kind: "prompt" as const, body, at, state,
  });
  const local = [operation("accepted", "same", "accepted"), operation("rejected", "same", "rejected"), operation("unknown", "other", "unconfirmed")];
  const history = [{ id: "remote", from: "user" as const, body: "same", at, status: "complete" as const }];
  assert.deepEqual(reconcilePromptOperationsWithHistory(local, history).map(({ id }) => id), ["accepted", "rejected", "unknown"]);
});

test("old or timestamp-free same-text history never erases newer accepted operation evidence", () => {
  const local = [{
    id: "accepted-new", kind: "prompt" as const, body: "repeatable command", at: "2026-07-17T10:00:00.000Z",
    state: "accepted" as const,
  }];
  for (const at of ["", "12:00", "2025-07-17T10:00:00.000Z"]) {
    const history = [{ id: `old-${at}`, from: "user" as const, body: "repeatable command", at, status: "complete" as const }];
    assert.deepEqual(reconcilePromptOperationsWithHistory(local, history).map(({ id }) => id), ["accepted-new"]);
  }
  const closeInTime = [{ id: "close-in-time", from: "user" as const, body: "repeatable command", at: "2026-07-17T10:00:01.000Z", status: "complete" as const }];
  assert.deepEqual(reconcilePromptOperationsWithHistory(local, closeInTime).map(({ id }) => id), ["accepted-new"]);
});

test("legacy local operations migrate into a bounded ledger without duplicating or reordering the durable transcript", () => {
  const legacy: ChatSession = {
    ...ready,
    messages: [
      { id: "durable-old", from: "agent", body: "old durable", at: "10:00", status: "complete" },
      { id: "local-op", from: "user", body: "repeat", at: "10:01", promptOperation: { id: "op-1", state: "accepted" } },
    ],
    operationEvidence: [{ id: "op-0", kind: "prompt", body: "uncertain", at: "09:59", state: "unconfirmed" }],
  };
  assert.deepEqual(presentedOperationEvidence(legacy).map(({ id }) => id), ["op-0", "op-1"]);
  sessions.value = [legacy];
  setChatHistoryLoading(ready.id, true);
  applyChatHistory(ready.id, [
    { id: "history-1", from: "user", body: "repeat", at: "10:02", status: "complete" },
    { id: "history-2", from: "agent", body: "done", at: "10:03", status: "complete" },
  ]);
  assert.deepEqual(sessions.value[0]?.messages.map(({ id }) => id), ["history-1", "history-2"]);
  assert.deepEqual(sessions.value[0]?.operationEvidence?.map(({ id }) => id), ["op-0", "op-1"]);
});

test("separate operation evidence is presented in conversation chronology without same-body deduplication", () => {
  const messages = [
    { id: "durable-1", from: "user" as const, body: "repeat", at: "2026-07-17T10:00:00.000Z" },
    { id: "durable-2", from: "agent" as const, body: "done", at: "2026-07-17T10:02:00.000Z" },
  ];
  const evidence = [
    { id: "operation-1", kind: "prompt" as const, body: "repeat", at: "2026-07-17T10:01:00.000Z", state: "accepted" as const },
    { id: "operation-2", kind: "prompt" as const, body: "later", at: "2026-07-17T10:03:00.000Z", state: "unconfirmed" as const },
  ];
  const timeline = buildChatTimeline(messages, evidence);
  assert.deepEqual(timeline.map((item) => item.kind === "message" ? item.message.id : item.operation.id), [
    "durable-1", "operation-1", "durable-2", "operation-2",
  ]);
  assert.equal(timeline.filter((item) => (item.kind === "message" ? item.message.body : item.operation.body) === "repeat").length, 2);

  const mixedClock = buildChatTimeline(messages, [{ ...evidence[0]!, at: "10:01" }]);
  assert.deepEqual(mixedClock.map((item) => item.kind), ["message", "message", "operation"], "incomparable timestamp families preserve source order instead of guessing causality");
});

test("shared timeline sequence preserves order across midnight", () => {
  const messages = [
    { id: "before-midnight", timelineSequence: 0, from: "agent" as const, body: "before", at: "23:26" },
    { id: "after-prompt", timelineSequence: 2, from: "agent" as const, body: "after", at: "00:45" },
    { id: "later", timelineSequence: 3, from: "agent" as const, body: "later", at: "01:12" },
  ];
  const evidence = [
    { id: "operation-after-midnight", timelineSequence: 1, kind: "prompt" as const, body: "prompt", at: "00:31", state: "accepted" as const },
  ];
  assert.deepEqual(
    buildChatTimeline(messages, evidence).map((item) => item.kind === "message" ? item.message.id : item.operation.id),
    ["before-midnight", "operation-after-midnight", "after-prompt", "later"],
  );
});

test("shared timeline sequence wins over sparse clock values", () => {
  const messages = [
    { id: "morning", timelineSequence: 10, from: "agent" as const, body: "morning", at: "08:00" },
    { id: "night", timelineSequence: 12, from: "agent" as const, body: "night", at: "21:00" },
  ];
  const evidence = [
    { id: "evening", timelineSequence: 11, kind: "prompt" as const, body: "evening", at: "20:00", state: "accepted" as const },
  ];
  assert.deepEqual(
    buildChatTimeline(messages, evidence).map((item) => item.kind === "message" ? item.message.id : item.operation.id),
    ["morning", "evening", "night"],
  );
});

test("one legacy row without a sequence cannot disable shared chronology", () => {
  const messages = [
    { id: "before-midnight", timelineSequence: 10, from: "agent" as const, body: "before", at: "23:26" },
    { id: "after-prompt", timelineSequence: 12, from: "agent" as const, body: "after", at: "00:45" },
    { id: "new-format", timelineSequence: 13, from: "agent" as const, body: "new", at: "2026-07-30T01:00:00.000Z" },
  ];
  const evidence = [
    { id: "legacy-operation", kind: "prompt" as const, body: "prompt", at: "00:31", state: "accepted" as const },
  ];

  assert.deepEqual(
    buildChatTimeline(messages, evidence).map((item) => item.kind === "message" ? item.message.id : item.operation.id),
    ["before-midnight", "legacy-operation", "after-prompt", "new-format"],
  );
});

test("operation live announcements emit only the latest changed id/state", () => {
  const previousLocale = locale.value;
  const operation = { id: "operation", kind: "prompt" as const, body: "deploy", at: "12:00", state: "pending" as const };
  try {
    setLocale("ja");
    const pending = nextOperationAnnouncement([operation], "")!;
    assert.equal(nextOperationAnnouncement([operation], pending.key), undefined);
    const accepted = nextOperationAnnouncement([{ ...operation, state: "accepted" }], pending.key)!;
    assert.notEqual(accepted.key, pending.key);
    assert.match(operationAnnouncementText(accepted.operation), /指示.*Hermes受理済み.*deploy/);
  } finally {
    setLocale(previousLocale);
  }
});

test("chat timestamps render by selected locale without rewriting legacy clock text", () => {
  const timestamp = "2026-07-16T01:02:03.000Z";
  const date = new Date(timestamp);
  const japanese = formatChatMessageTime(timestamp, "ja", "Asia/Tokyo");
  const english = formatChatMessageTime(timestamp, "en", "Asia/Tokyo");
  assert.equal(japanese, new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }).format(date));
  assert.equal(english, new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }).format(date));
  assert.notEqual(japanese, english);
  assert.equal(formatChatMessageTime("12:00", "ja", "Asia/Tokyo"), "12:00");
  assert.equal(formatChatMessageTime("12:00", "en", "Asia/Tokyo"), "12:00");
  assert.equal(formatChatMessageTime("legacy timestamp", "en", "Asia/Tokyo"), "legacy timestamp");
});

test("active runs steer once without changing authoritative run state", async () => {
  const requests: Array<{ sessionId: string; text: string }> = [];
  const operation = deferred<void>();
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, submitPrompt() {}, interrupt() {},
    async steer(sessionId, text) { requests.push({ sessionId, text }); await operation.promise; return { status: "queued" }; },
    async respondClarify() {}, async respondApproval() {}
  });
  sessions.value = [{ ...ready, status: "streaming", liveSessionId: "live" }];
  const first = steerSession(ready.id, "  add mobile coverage  ");
  const duplicate = await steerSession(ready.id, "duplicate");
  assert.equal(duplicate, false);
  assert.deepEqual(requests, [{ sessionId: ready.id, text: "add mobile coverage" }]);
  assert.equal(sessions.value[0]?.steerPending, true);
  assert.equal(sessions.value[0]?.status, "streaming");
  assert.equal(sessions.value[0]?.messages.length, 0);
  operation.resolve();
  assert.equal(await first, true);
  assert.equal(sessions.value[0]?.status, "streaming");
  assert.equal(sessions.value[0]?.steerPending, false);
  assert.deepEqual(sessions.value[0]?.operationEvidence?.map(({ kind, body, state }) => ({ kind, body, state })), [
    { kind: "steer", body: "add mobile coverage", state: "accepted" },
  ]);
  sessions.value = [reduceChatGatewayEvent(sessions.value[0]!, {
    type: "message.complete", liveSessionId: "live", payload: { messageId: "agent-done", text: "done" }
  })];
  assert.equal(sessions.value[0]?.operationEvidence?.filter(({ kind }) => kind === "steer").length, 1);
});

test("accepted Steer evidence is deterministically bounded by count and UTF-8 bytes without body dedupe", () => {
  const countBound = Array.from({ length: MAX_STEER_EVIDENCE_COUNT + 1 }, (_, index) => ({
    id: `steer-${index}`, from: "user" as const, kind: "steer" as const, body: "same body", at: "12:00",
  }));
  assert.deepEqual(boundedSteerEvidence(countBound).map(({ id }) => id), countBound.slice(1).map(({ id }) => id));

  const largeBody = "界".repeat(Math.ceil(MAX_STEER_EVIDENCE_BYTES / 6));
  const byteBound = [
    { id: "old", from: "user" as const, kind: "steer" as const, body: largeBody, at: "12:00" },
    { id: "new", from: "user" as const, kind: "steer" as const, body: largeBody, at: "12:01" },
  ];
  assert.deepEqual(boundedSteerEvidence(byteBound).map(({ id }) => id), ["new"]);
});

test("steer eligibility fails closed while idle, disconnected, empty, or awaiting interaction", async () => {
  const requests: string[] = [];
  const prompts: string[] = [];
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, interrupt() {},
    submitPrompt(_sessionId, text) { prompts.push(text); },
    async steer(_sessionId, text) { requests.push(text); return { status: "queued" }; },
    async respondClarify() {}, async respondApproval() {}
  });
  sessions.value = [{ ...ready }];
  assert.equal(await steerSession(ready.id, "idle steer"), false);
  assert.equal(await steerSession(ready.id, " "), false);
  sendMessage(ready.id, "ordinary prompt");
  assert.deepEqual(prompts, ["ordinary prompt"]);

  const active = { ...ready, status: "streaming" as const };
  sessions.value = [{ ...active, connectionState: "disconnected" }];
  assert.equal(await steerSession(ready.id, "offline"), false);
  sessions.value = [{ ...active, pendingInteraction: { id: "clarify:1", kind: "clarify", requestId: "1", question: "Which?", choices: [], submitting: false } }];
  assert.equal(await steerSession(ready.id, "during clarification"), false);
  assert.deepEqual(requests, []);
});

test("running composer exposes Steer and Stop together but interactions take input priority", () => {
  const active = { ...ready, status: "streaming" as const };
  assert.deepEqual(chatComposerState(active), { runActive: true, canSteer: true, canCompose: true, showStop: true });
  assert.equal(canSteerChatSession(active), true);
  const waiting: ChatSession = {
    ...active, status: "waiting",
    pendingInteraction: { id: "approval:1", kind: "approval", approvalId: "1", choices: ["once"], allowPermanent: false, submitting: false },
  };
  assert.deepEqual(chatComposerState(waiting), { runActive: true, canSteer: false, canCompose: false, showStop: true });
  assert.deepEqual(chatComposerState(ready), { runActive: false, canSteer: false, canCompose: true, showStop: false });
});

test("steering labels, placeholders, and failures are localized without overstating queue acceptance", () => {
  const previous = locale.value;
  try {
    setLocale("ja");
    assert.deepEqual([t("chat.steer"), t("chat.steerPlaceholder"), t("chat.steerMessage")], ["追加指示", "実行中のHermesに追加指示…", "Hermesキュー受理"]);
    setLocale("en");
    assert.deepEqual([t("chat.steer"), t("chat.steerPlaceholder"), t("chat.steerMessage")], ["Steer", "Add guidance for the running Hermes session…", "Accepted by Hermes queue"]);
    assert.match(localizeRuntimeMessage(officeRuntimeMessage("追加指示を送信できませんでした。接続を確認して再試行してください。")), /Unable to send steering guidance/);
  } finally { setLocale(previous); }
});

test("Office-owned chat titles, tool fallbacks, and transport copy switch locale without translating Hermes text", () => {
  const previous = locale.value;
  const draft = { title: "", titlePresentation: "new-chat" as const };
  const HermesTitle = { title: "ユーザーがHermesに付けた題名" };
  const tool = reduceChatGatewayEvent(ready, {
    type: "tool.start", liveSessionId: "live", payload: { toolId: "tool-1", name: "Shell" },
  }).messages[0]!;
  const genericTool = reduceChatGatewayEvent(ready, {
    type: "tool.complete", liveSessionId: "live", payload: { toolId: "tool-2" },
  }).messages[0]!;
  const HermesDetail = reduceChatGatewayEvent(ready, {
    type: "tool.start", liveSessionId: "live", payload: { toolId: "tool-3", name: "Shell", summary: "利用者由来の要約" },
  }).messages[0]!;
  try {
    setLocale("ja");
    assert.equal(chatSessionTitle(draft), "新しい会話");
    assert.equal(chatMessageBody(tool), "Shellを実行中…");
    assert.equal(chatMessageBody(genericTool), "ツール 完了");
    setLocale("en");
    assert.equal(chatSessionTitle(draft), "New chat");
    assert.equal(chatSessionTitle(HermesTitle), HermesTitle.title);
    assert.equal(chatMessageBody(tool), "Running Shell…");
    assert.equal(chatMessageBody(genericTool), "Tool complete");
    assert.equal(chatMessageBody(HermesDetail), "Shell: 利用者由来の要約");
    for (const [message, expected] of [
      [officeRuntimeMessage("端末の再認証が必要です。"), "This device must be authenticated again."],
      [officeRuntimeMessage("接続復旧後に履歴を再同期します"), "History will be resynchronized after the connection recovers."],
      [officeRuntimeMessage("session.resumeがタイムアウトしました。"), "session.resume timed out."],
      [officeRuntimeMessage("送信結果を確認するための保存済み履歴IDを取得できませんでした。明示的に再接続してください。"), "The saved history ID needed to confirm the submission was not returned. Reconnect explicitly."],
      [officeRuntimeMessage("保存済み履歴の完全性を確認できませんでした。明示的に再試行してください。"), "Saved-history integrity could not be confirmed. Retry explicitly."],
      [officeRuntimeMessage("Hermesが不正な送信確認を返しました。保存済み履歴を再確認します。"), "Hermes returned an invalid submission acknowledgement. Reloading saved history."],
      [officeMessage("runtime.office.demo"), "Showing explicit demo mode"],
      [officeMessage("runtime.kanban.waiting"), "Waiting for the Hermes runtime"],
      [officeMessage("runtime.kanban.commenting"), "Sending comment"],
    ] as const) assert.equal(localizeRuntimeMessage(message), expected);
    assert.equal(localizeRuntimeMessage("Hermesが生成した日本語の自由文"), "Hermesが生成した日本語の自由文");
    const collision = reduceChatGatewayEvent(ready, {
      type: "error", liveSessionId: "live", payload: { message: "端末の再認証が必要です。" },
    });
    assert.equal(localizeRuntimeMessage(collision.errorMessage!), "端末の再認証が必要です。");
    assert.equal(localizeRuntimeMessage(officeRuntimeMessage("Studio WebSocketへ再接続できませんでした。手動で再試行してください。")), "Unable to reconnect to the Studio WebSocket. Retry manually.");
  } finally { setLocale(previous); }
});

test("composer Enter ignores IME composition in prompt and steer modes", () => {
  const ordinaryEnter = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 };
  for (const current of [ready, { ...ready, status: "streaming" as const }]) {
    assert.equal(chatComposerState(current).canCompose, true);
    assert.equal(shouldSubmitComposerKey({ ...ordinaryEnter, isComposing: true }), false);
    assert.equal(shouldSubmitComposerKey({ ...ordinaryEnter, keyCode: 229 }), false);
    assert.equal(shouldSubmitComposerKey({ ...ordinaryEnter, shiftKey: true }), false);
    assert.equal(shouldSubmitComposerKey(ordinaryEnter), true);
  }
});

test("failed steering keeps the run active and reports failure without a local message", async () => {
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, submitPrompt() {}, interrupt() {},
    async steer() { throw new Error("upstream unavailable"); },
    async respondClarify() {}, async respondApproval() {}
  });
  sessions.value = [{ ...ready, status: "streaming" }];
  assert.equal(await steerSession(ready.id, "keep going"), false);
  assert.equal(isChatRunActive(sessions.value[0]!), true);
  assert.equal(sessions.value[0]?.messages.length, 0);
  assert.match(localizeRuntimeMessage(sessions.value[0]!.errorMessage!), /追加指示/);
});

test("commit-unconfirmed steering clears the composer once and records ambiguity without replay", async () => {
  let calls = 0;
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, submitPrompt() {}, interrupt() {},
    async steer() {
      calls += 1;
      throw commitUnconfirmedRpcError("steer acknowledgement lost");
    },
    async respondClarify() {}, async respondApproval() {},
  });
  sessions.value = [{ ...ready, status: "streaming" }];

  assert.equal(await steerSession(ready.id, "keep going once"), true);
  assert.equal(calls, 1);
  assert.equal(sessions.value[0]?.steerPending, false);
  assert.equal(sessions.value[0]?.errorMessage, undefined);
  assert.deepEqual(
    sessions.value[0]?.operationEvidence?.map(({ kind, body, state, message }) => ({ kind, body, state, message })),
    [{ kind: "steer", body: "keep going once", state: "unconfirmed", message: "steer acknowledgement lost" }],
  );
});

test("an explicit steering rejection keeps the composer input retryable", async () => {
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, submitPrompt() {}, interrupt() {},
    async steer() { throw explicitRpcRejection("steer rejected"); },
    async respondClarify() {}, async respondApproval() {},
  });
  sessions.value = [{ ...ready, status: "streaming" }];

  assert.equal(await steerSession(ready.id, "retry me"), false);
  assert.equal(sessions.value[0]?.operationEvidence, undefined);
  assert.match(localizeRuntimeMessage(sessions.value[0]!.errorMessage!), /追加指示/);
});

test("rejected and malformed steering acknowledgements retain input and never add a success message", async (context) => {
  for (const result of [{ status: "rejected" }, { status: "invalid" }] as const) {
    await context.test(result.status, async () => {
      registerChatRuntime({
        ensureSession() {}, releaseSession() {}, submitPrompt() {}, interrupt() {},
        async steer() { return result; },
        async respondClarify() {}, async respondApproval() {}
      });
      sessions.value = [{ ...ready, status: "streaming" }];
      assert.equal(await steerSession(ready.id, `keep ${result.status}`), false);
      assert.equal(sessions.value[0]?.steerPending, false);
      assert.equal(sessions.value[0]?.messages.some(({ kind }) => kind === "steer"), false);
      assert.match(localizeRuntimeMessage(sessions.value[0]!.errorMessage!), result.status === "rejected" ? /拒否/ : /受付結果/);
      sessions.value = [reduceChatGatewayEvent(sessions.value[0]!, {
        type: "message.complete", liveSessionId: "live", payload: { messageId: "agent-done", text: "done" }
      })];
      assert.equal(sessions.value[0]?.messages.some(({ kind }) => kind === "steer"), false);
    });
  }
});

test("a delayed steer acknowledgement cannot overwrite a local stop", async () => {
  const operation = deferred<void>();
  const interrupts: string[] = [];
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, submitPrompt() {},
    async steer() { await operation.promise; return { status: "queued" }; },
    interrupt(sessionId) { interrupts.push(sessionId); },
    async respondClarify() {}, async respondApproval() {}
  });
  sessions.value = [{ ...ready, status: "streaming" }];
  const steering = steerSession(ready.id, "late guidance");
  const stopping = interruptSession(ready.id);
  assert.equal(sessions.value[0]?.interruptPending, true);
  operation.resolve();
  assert.equal(await stopping, true);
  assert.equal(await steering, false);
  assert.deepEqual(interrupts, [ready.id]);
  assert.equal(sessions.value[0]?.status, "ready");
  assert.equal(sessions.value[0]?.messages.length, 0);
});

test("stop blocks duplicate prompts until acknowledgement and restores the active run on failure", async () => {
  const operation = deferred<void>();
  const prompts: string[] = [];
  let interruptCalls = 0;
  registerChatRuntime({
    ensureSession() {}, releaseSession() {},
    submitPrompt(_sessionId, text) { prompts.push(text); },
    async steer() { return { status: "queued" }; },
    interrupt() { interruptCalls += 1; return operation.promise; },
    async respondClarify() {}, async respondApproval() {},
  });
  sessions.value = [{ ...ready, status: "streaming", streamingMessageId: "agent-active", messages: [{ id: "agent-active", from: "agent", body: "working", at: "00:00", status: "streaming" }] }];
  const stopping = interruptSession(ready.id);
  assert.equal(sessions.value[0]?.interruptPending, true);
  assert.equal(sessions.value[0]?.status, "streaming");
  assert.equal(canSubmitChatPrompt(sessions.value[0]!), false);
  sendMessage(ready.id, "must stay blocked");
  assert.deepEqual(prompts, []);
  assert.equal(await interruptSession(ready.id), false);
  assert.equal(interruptCalls, 1);
  operation.reject(new Error("network failure"));
  assert.equal(await stopping, false);
  assert.equal(sessions.value[0]?.interruptPending, false);
  assert.equal(isChatRunActive(sessions.value[0]!), true);
  assert.equal(sessions.value[0]?.messages[0]?.status, "streaming");
  assert.match(localizeRuntimeMessage(sessions.value[0]!.errorMessage!), /停止を確認できません/);

  const uncorrelatedIdle = reduceChatGatewayEvent({ ...sessions.value[0]!, interruptPending: true, interruptOperationId: "stop-2" }, {
    type: "session.info", liveSessionId: "live", payload: { running: false, status: "idle" },
  });
  assert.equal(uncorrelatedIdle.interruptPending, true);
  assert.equal(isChatRunActive(uncorrelatedIdle), true);
  const staleTerminal = reduceChatGatewayEvent(uncorrelatedIdle, {
    type: "message.complete", liveSessionId: "stale-live", payload: { messageId: "agent-active", text: "stale" },
  });
  assert.equal(staleTerminal, uncorrelatedIdle);
  assert.equal(staleTerminal.interruptPending, true);
});

test("same-target terminal events retain steering until queued or rejected acknowledgement", async (context) => {
  for (const terminal of ["message.complete", "error"] as const) {
    for (const outcome of ["queued", "rejected"] as const) {
      await context.test(`${terminal} before ${outcome}`, async () => {
        const operation = deferred<ChatSteerResult>();
        const prompts: string[] = [];
        registerChatRuntime({
          ensureSession() {}, releaseSession() {}, interrupt() {},
          submitPrompt(_sessionId, text) { prompts.push(text); },
          async steer() { return operation.promise; },
          async respondClarify() {}, async respondApproval() {}
        });
        sessions.value = [{
          ...ready,
          status: "streaming",
          streamingMessageId: "old-agent",
          messages: [{ id: "old-agent", from: "agent", body: "old run", at: "00:00", status: "streaming" }],
        }];

        const pendingSteer = steerSession(ready.id, `${terminal} ${outcome}`);
        sessions.value = [reduceChatGatewayEvent(sessions.value[0]!, terminal === "message.complete" ? {
          type: terminal, liveSessionId: "live", payload: { messageId: "old-agent", text: "old done" }
        } : {
          type: terminal, liveSessionId: "live", payload: { message: "old failed" }
        })];
        assert.ok(sessions.value[0]?.steerOperationId);
        assert.equal(sessions.value[0]?.steerPending, true);
        assert.equal(canSubmitChatPrompt(sessions.value[0]!), false);
        sendMessage(ready.id, "new prompt");
        assert.deepEqual(prompts, []);

        operation.resolve({ status: outcome });
        assert.equal(await pendingSteer, outcome === "queued");
        assert.equal(sessions.value[0]?.steerPending, false);
        assert.equal(sessions.value[0]?.operationEvidence?.filter(({ kind }) => kind === "steer").length ?? 0, outcome === "queued" ? 1 : 0);
        assert.equal(canSubmitChatPrompt(sessions.value[0]!), true);
        if (outcome === "rejected") assert.match(localizeRuntimeMessage(sessions.value[0]!.errorMessage!), /拒否/);
      });
    }
  }
});

test("disconnect, live target replacement, and close invalidate pending steer acknowledgements", async (context) => {
  const scenarios = ["disconnect", "target", "close"] as const;
  for (const scenario of scenarios) {
    await context.test(scenario, async () => {
      const operation = deferred<void>();
      const released: string[] = [];
      registerChatRuntime({
        ensureSession() {}, submitPrompt() {}, interrupt() {},
        releaseSession(sessionId) { released.push(sessionId); },
        async steer() { await operation.promise; return { status: "queued" }; },
        async respondClarify() {}, async respondApproval() {}
      });
      sessions.value = [{
        ...ready,
        status: "streaming",
        streamingMessageId: "agent-old",
        messages: [{ id: "agent-old", from: "agent", body: "working", at: "00:00", status: "streaming" }],
      }];
      openSessionIds.value = scenario === "close" ? [ready.id] : [];
      const staleSteer = steerSession(ready.id, `stale ${scenario}`);

      if (scenario === "disconnect") {
        setChatSessionDisconnected(ready.id);
      } else if (scenario === "target") {
        setChatSessionReady(ready.id, "live-replacement", "stored", { running: true });
      } else {
        closeSession(ready.id);
      }
      const invalidated = sessions.value[0]!;
      assert.equal(invalidated.steerOperationId, undefined);
      assert.equal(invalidated.steerPending, false);

      operation.resolve();
      assert.equal(await staleSteer, false);
      assert.deepEqual(sessions.value[0], invalidated);
      assert.equal(sessions.value[0]?.messages.some(({ kind }) => kind === "steer"), false);
      if (scenario === "disconnect") {
        assert.equal(invalidated.connectionState, "disconnected");
        assert.equal(invalidated.liveSessionId, undefined);
      } else if (scenario === "target") {
        assert.equal(invalidated.liveSessionId, "live-replacement");
        assert.equal(invalidated.status, "streaming");
        assert.equal(invalidated.messages[0]?.status, "cancelled");
      } else if (scenario === "close") {
        assert.deepEqual(released, [ready.id]);
        assert.deepEqual(openSessionIds.value, []);
        assert.equal(invalidated.connectionState, "disconnected");
        assert.equal(invalidated.liveSessionId, undefined);
        assert.equal(invalidated.status, "ready");
        assert.equal(invalidated.messages[0]?.status, "cancelled");
      }
    });
  }
});

test("canonical Hermes status notifications cannot create a run and preserve an active run", () => {
  const submitted: string[] = [];
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, async steer() { return { status: "queued" }; }, interrupt() {},
    submitPrompt(_sessionId, text) { submitted.push(text); },
    async respondClarify() {}, async respondApproval() {}
  });
  sessions.value = [{ ...ready }];
  sendMessage(ready.id, "first");
  const afterSubmitNotice = reduceChatGatewayEvent(sessions.value[0]!, {
    type: "status.update", liveSessionId: "live", payload: { kind: "process", message: "Preparing follow-up" }
  });
  assert.equal(afterSubmitNotice.status, "streaming");
  assert.equal(isChatRunActive(afterSubmitNotice), true);
  sessions.value = [afterSubmitNotice];
  sendMessage(ready.id, "duplicate-after-submit");

  const withoutKind = reduceChatGatewayEvent(ready, {
    type: "status.update", liveSessionId: "live", payload: { message: "Preparing follow-up" }
  });
  const beforeStart = reduceChatGatewayEvent(withoutKind, {
    type: "status.update", liveSessionId: "live", payload: { kind: "process", message: "Preparing follow-up" }
  });
  assert.equal(beforeStart, ready);
  assert.equal(isChatRunActive(beforeStart), false);
  sendMessage(ready.id, "duplicate-before-start");

  const started = reduceChatGatewayEvent(beforeStart, {
    type: "message.start", liveSessionId: "live", payload: { messageId: "agent-1" }
  });
  const afterStart = reduceChatGatewayEvent(started, {
    type: "status.update", liveSessionId: "live", payload: { kind: "goal", text: "Goal progress" }
  });
  assert.equal(afterStart.status, "streaming");
  assert.equal(afterStart.streamingMessageId, "agent-1");
  assert.equal(isChatRunActive(afterStart), true);
  sessions.value = [afterStart];
  sendMessage(ready.id, "duplicate-after-start");
  assert.deepEqual(submitted, ["first"]);
});

test("only recognized status values transition and informational or unknown values preserve state", () => {
  assert.equal(mergeGatewayStatusUpdate(ready, { status: "thinking" }).status, "streaming");
  assert.equal(mergeGatewayStatusUpdate(ready, { kind: "using-tool" }).status, "streaming");
  assert.equal(mergeGatewayStatusUpdate(ready, { kind: "status", message: "waiting_for_user" }).status, "waiting");
  assert.equal(mergeGatewayStatusUpdate(ready, { kind: "status", message: "ready" }), ready);

  const active = { ...ready, status: "streaming" as const };
  assert.equal(mergeGatewayStatusUpdate(active, { kind: "status", text: "ready" }), active);
  assert.equal(mergeGatewayStatusUpdate(active, { kind: "compacting", text: "Compacting context" }), active);
  assert.equal(mergeGatewayStatusUpdate(active, { kind: "future-kind", text: "Ready-ish text" }), active);
  assert.equal(mergeGatewayStatusUpdate(active, {}), active);
  assert.equal(mergeGatewayStatusUpdate(active, { status: "future-status", kind: "status", text: "ready" }), active);
});

test("tool progress and approval waits remain active across status notifications", () => {
  const toolProgress = reduceChatGatewayEvent(ready, {
    type: "tool.progress", liveSessionId: "live", payload: { toolId: "tool-1", name: "Shell", summary: "Running" }
  });
  const afterToolNotice = reduceChatGatewayEvent(toolProgress, {
    type: "status.update", liveSessionId: "live", payload: { kind: "process", text: "Still working" }
  });
  assert.equal(isChatRunActive(afterToolNotice), true);
  assert.equal(afterToolNotice.messages[0]?.status, "streaming");

  const waiting = reduceChatGatewayEvent(ready, {
    type: "approval.request", liveSessionId: "live",
    payload: { approvalId: "approval-1", choices: ["once", "deny"], allowPermanent: false }
  });
  const afterWaitingNotice = reduceChatGatewayEvent(waiting, {
    type: "status.update", liveSessionId: "live", payload: { status: "thinking" }
  });
  assert.equal(afterWaitingNotice.status, "waiting");
  assert.equal(afterWaitingNotice.pendingInteraction?.id, "approval:approval-1");
  assert.equal(isChatRunActive(afterWaitingNotice), true);
});

test("completion, interruption, and error are authoritative run terminators", async () => {
  const active: ChatSession = {
    ...ready,
    status: "streaming",
    streamingMessageId: "agent-1",
    messages: [
      { id: "tool-1", from: "tool", body: "running", at: "00:00", status: "streaming" },
      { id: "agent-1", from: "agent", body: "done", at: "00:01", status: "streaming" }
    ]
  };
  const complete = reduceChatGatewayEvent(active, {
    type: "message.complete", liveSessionId: "live", payload: { messageId: "agent-1", text: "done" }
  });
  assert.equal(isChatRunActive(complete), false);
  assert.deepEqual(complete.messages.map(({ status }) => status), ["complete", "complete"]);

  const error = reduceChatGatewayEvent(active, {
    type: "error", liveSessionId: "live", payload: { message: "failed" }
  });
  assert.equal(isChatRunActive(error), false);
  assert.deepEqual(error.messages.map(({ status }) => status), ["failed", "failed"]);

  const pending = reduceChatGatewayEvent(active, {
    type: "approval.request", liveSessionId: "live",
    payload: { approvalId: "approval-1", choices: ["once"], allowPermanent: false }
  });
  const pendingError = reduceChatGatewayEvent(pending, {
    type: "error", liveSessionId: "live", payload: { message: "failed" }
  });
  assert.equal(pendingError.pendingInteraction, undefined);
  assert.equal(isChatRunActive(pendingError), false);

  const interrupts: string[] = [];
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, submitPrompt() {}, async steer() { return { status: "queued" }; },
    interrupt(sessionId) { interrupts.push(sessionId); },
    async respondClarify() {}, async respondApproval() {}
  });
  sessions.value = [active];
  const firstStop = interruptSession(active.id);
  const duplicateStop = interruptSession(active.id);
  assert.deepEqual(interrupts, [active.id]);
  assert.equal(isChatRunActive(sessions.value[0]!), true);
  assert.equal(await duplicateStop, false);
  assert.equal(await firstStop, true);
  assert.equal(isChatRunActive(sessions.value[0]!), false);
  assert.deepEqual(sessions.value[0]?.messages.map(({ status }) => status), ["cancelled", "cancelled"]);

  sessions.value = [pending];
  const pendingStop = interruptSession(active.id);
  const duplicatePendingStop = interruptSession(active.id);
  assert.deepEqual(interrupts, [active.id, active.id]);
  assert.equal(await duplicatePendingStop, false);
  assert.equal(await pendingStop, true);
  assert.equal(sessions.value[0]?.pendingInteraction, undefined);
  assert.equal(isChatRunActive(sessions.value[0]!), false);
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
