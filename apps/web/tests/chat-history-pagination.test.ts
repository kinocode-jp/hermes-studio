import assert from "node:assert/strict";
import test from "node:test";
import { normalizeHistoryPage } from "../src/chat-api";
import { nextChatTimelineSequence } from "../src/chat-store-utils";

test("history page metadata and stable cross-page message indexes are normalized", () => {
  const page = normalizeHistoryPage({
    sessionId: "stored-resolved",
    messages: [
      { index: 25, role: "user", text: "next user message" },
      { index: 26, role: "assistant", text: "next assistant message" },
    ],
    pagination: { direction: "older", hasMore: true, nextCursor: "djE6Mjc", returned: 2 },
  }, "stored-requested");

  assert.equal(page.resolvedStoredSessionId, "stored-resolved");
  assert.deepEqual(page.messages.map((message) => message.id), [
    "history-stored-requested-25",
    "history-stored-requested-26",
  ]);
  assert.deepEqual(page.messages.map((message) => message.timelineSequence), [25_000_000, 26_000_000]);
  const localSequence = nextChatTimelineSequence({ messages: page.messages, operationEvidence: [] });
  assert.equal(localSequence, 26_000_001);
  assert.ok(localSequence < 27_000_000, "local events stay before the next durable history anchor");
  assert.equal(page.hasMore, true);
  assert.equal(page.nextCursor, "djE6Mjc");
  assert.equal(page.truncated, false);
  assert.equal(page.partial, false);
});

test("server truncation metadata is preserved without requesting another page", () => {
  const page = normalizeHistoryPage({
    messages: [{ index: 499, role: "assistant", text: "bounded result" }],
    pagination: { direction: "older", hasMore: false, returned: 1, truncated: true, partial: true, truncationReason: "message_limit" },
  }, "stored-1");
  assert.deepEqual({ truncated: page.truncated, partial: page.partial, reason: page.truncationReason }, { truncated: true, partial: true, reason: "message_limit" });
});

test("a continuation flag without a cursor is rejected", () => {
  assert.throws(
    () => normalizeHistoryPage({ messages: [], pagination: { direction: "older", hasMore: true } }, "stored-1"),
    /履歴ページ情報/,
  );
});

test("history timestamps stay locale-neutral while legacy clock text is preserved", () => {
  const page = normalizeHistoryPage({
    messages: [
      { index: 1, role: "assistant", text: "ISO", timestamp: "2026-07-16T01:02:03.000Z" },
      { index: 2, role: "assistant", text: "Epoch", timestamp: 1_700_000_000 },
      { index: 3, role: "assistant", text: "Legacy", at: "12:00" },
      { index: 4, role: "assistant", text: "Arbitrary legacy", at: "around noon" },
    ],
    pagination: { direction: "older", hasMore: false },
  }, "stored-1");

  assert.deepEqual(page.messages.map(({ at }) => at), [
    "2026-07-16T01:02:03.000Z",
    "2023-11-14T22:13:20.000Z",
    "12:00",
    "around noon",
  ]);
});

test("history rows without a stable upstream index do not receive page-local sequence numbers", () => {
  const body = {
    messages: [
      { role: "user", text: "first page-local row" },
      { role: "assistant", text: "second page-local row" },
    ],
    pagination: { direction: "older", hasMore: false },
  };
  const firstPage = normalizeHistoryPage(body, "stored-1", 0);
  const secondPage = normalizeHistoryPage(body, "stored-1", 1);

  assert.deepEqual(firstPage.messages.map(({ timelineSequence }) => timelineSequence), [undefined, undefined]);
  assert.deepEqual(firstPage.messages.map(({ id }) => id), [
    "history-stored-1-page-0-row-0",
    "history-stored-1-page-0-row-1",
  ]);
  assert.equal(new Set([...firstPage.messages, ...secondPage.messages].map(({ id }) => id)).size, 4);
});
