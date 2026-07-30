import assert from "node:assert/strict";
import test from "node:test";
import {
  chatComposerState,
  clearAcknowledgedChatComposer,
  clearChatComposerState,
  setChatComposerAttachments,
  setChatComposerDraft,
} from "../src/chat-composer-state";

test("an acknowledged submit cannot clear composer edits made while the request was in flight", () => {
  const sessionId = "composer-cas";
  clearChatComposerState(sessionId);
  setChatComposerDraft(sessionId, "submitted");
  setChatComposerAttachments(sessionId, [{
    id: "attachment-1",
    name: "note.txt",
    mime: "text/plain",
    size: 4,
    kind: "file",
    textContent: "note",
  }]);
  const submitted = chatComposerState(sessionId).value;

  setChatComposerDraft(sessionId, "typed while sending");

  assert.equal(clearAcknowledgedChatComposer(sessionId, submitted), false);
  assert.equal(chatComposerState(sessionId).value.draft, "typed while sending");
  assert.equal(chatComposerState(sessionId).value.attachments.length, 1);
});

test("the exact acknowledged composer clears and removed sessions get fresh state", () => {
  const sessionId = "composer-clear";
  clearChatComposerState(sessionId);
  setChatComposerDraft(sessionId, "submitted");
  const submitted = chatComposerState(sessionId).value;

  assert.equal(clearAcknowledgedChatComposer(sessionId, submitted), true);
  assert.deepEqual(chatComposerState(sessionId).value, { draft: "", attachments: [] });

  const clearedSignal = chatComposerState(sessionId);
  setChatComposerDraft(sessionId, "discarded with session");
  clearChatComposerState(sessionId);
  const replacement = chatComposerState(sessionId);
  assert.deepEqual(clearedSignal.value, { draft: "", attachments: [] });
  assert.notEqual(replacement, clearedSignal);
  assert.deepEqual(replacement.value, { draft: "", attachments: [] });
});
