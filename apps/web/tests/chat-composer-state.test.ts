import assert from "node:assert/strict";
import test from "node:test";
import {
  chatComposerState,
  clearAcknowledgedChatComposer,
  clearChatComposerState,
  coalesceChatComposerState,
  hasPendingChatComposerContent,
  setChatComposerAttachments,
  setChatComposerDraft,
} from "../src/chat-composer-state";

const attachment = (id: string) => ({
  id,
  name: `${id}.txt`,
  mime: "text/plain",
  size: id.length,
  kind: "file" as const,
  textContent: id,
});

test("composer content inspection preserves text and attachments without treating an empty composer as pending", () => {
  const sessionId = "composer-content";
  clearChatComposerState(sessionId);
  assert.equal(hasPendingChatComposerContent(sessionId), false);

  setChatComposerDraft(sessionId, "   ");
  assert.equal(hasPendingChatComposerContent(sessionId), true, "even whitespace is unsent user input");
  setChatComposerDraft(sessionId, "");
  assert.equal(hasPendingChatComposerContent(sessionId), false);

  setChatComposerAttachments(sessionId, [{
    id: "attachment-only",
    name: "note.txt",
    mime: "text/plain",
    size: 4,
    kind: "file",
    textContent: "note",
  }]);
  assert.equal(hasPendingChatComposerContent(sessionId), true);
  clearChatComposerState(sessionId);
});

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

test("composer coalescing moves provisional-only content without orphaning its old map entry", () => {
  clearChatComposerState("retained-only-target");
  clearChatComposerState("provisional-source");
  setChatComposerDraft("provisional-source", "provisional text");
  setChatComposerAttachments("provisional-source", [attachment("provisional-attachment")]);
  const oldProvisionalSignal = chatComposerState("provisional-source");

  coalesceChatComposerState("retained-only-target", "provisional-source");

  assert.deepEqual(chatComposerState("retained-only-target").value, {
    draft: "provisional text",
    attachments: [attachment("provisional-attachment")],
  });
  const freshProvisionalSignal = chatComposerState("provisional-source");
  assert.deepEqual(oldProvisionalSignal.value, { draft: "", attachments: [] });
  assert.deepEqual(freshProvisionalSignal.value, { draft: "", attachments: [] });
  assert.notEqual(freshProvisionalSignal, oldProvisionalSignal);
});

test("composer coalescing leaves retained-only content intact", () => {
  clearChatComposerState("retained-source");
  clearChatComposerState("missing-provisional");
  setChatComposerDraft("retained-source", "retained text");
  setChatComposerAttachments("retained-source", [attachment("retained-attachment")]);
  const submitted = chatComposerState("retained-source").value;

  coalesceChatComposerState("retained-source", "missing-provisional");

  assert.equal(chatComposerState("retained-source").value, submitted);
  assert.deepEqual(chatComposerState("retained-source").value, {
    draft: "retained text",
    attachments: [attachment("retained-attachment")],
  });
  assert.deepEqual(chatComposerState("missing-provisional").value, { draft: "", attachments: [] });
  assert.equal(clearAcknowledgedChatComposer("retained-source", submitted), true);
  assert.deepEqual(chatComposerState("retained-source").value, { draft: "", attachments: [] });
});

test("composer coalescing preserves a retained reference when both identities are semantically equal", () => {
  clearChatComposerState("retained-equal");
  clearChatComposerState("provisional-equal");
  const shared = attachment("shared-equal");
  setChatComposerDraft("retained-equal", "same text");
  setChatComposerAttachments("retained-equal", [shared]);
  const submitted = chatComposerState("retained-equal").value;
  setChatComposerDraft("provisional-equal", "same text");
  setChatComposerAttachments("provisional-equal", [{ ...shared }]);

  coalesceChatComposerState("retained-equal", "provisional-equal");

  assert.equal(chatComposerState("retained-equal").value, submitted);
  assert.equal(clearAcknowledgedChatComposer("retained-equal", submitted), true);
  assert.deepEqual(chatComposerState("retained-equal").value, { draft: "", attachments: [] });
});

test("composer coalescing clears only acknowledged retained content from both identities", () => {
  clearChatComposerState("retained-both");
  clearChatComposerState("provisional-both");
  setChatComposerDraft("retained-both", "retained text");
  setChatComposerAttachments("retained-both", [attachment("retained"), attachment("shared")]);
  const submitted = chatComposerState("retained-both").value;
  setChatComposerDraft("provisional-both", "provisional text");
  setChatComposerAttachments("provisional-both", [attachment("provisional"), attachment("shared")]);

  coalesceChatComposerState("retained-both", "provisional-both");

  assert.deepEqual(chatComposerState("retained-both").value, {
    draft: "retained text\n\nprovisional text",
    attachments: [attachment("retained"), attachment("shared"), attachment("provisional")],
  });
  assert.deepEqual(chatComposerState("provisional-both").value, { draft: "", attachments: [] });
  assert.equal(clearAcknowledgedChatComposer("retained-both", submitted), true);
  assert.deepEqual(chatComposerState("retained-both").value, {
    draft: "provisional text",
    attachments: [attachment("shared"), attachment("provisional")],
  });
});

test("acknowledgement after coalescing preserves later draft edits and attachments", () => {
  clearChatComposerState("retained-edited");
  clearChatComposerState("provisional-edited");
  setChatComposerDraft("retained-edited", "submitted text");
  setChatComposerAttachments("retained-edited", [attachment("submitted")]);
  const submitted = chatComposerState("retained-edited").value;
  setChatComposerDraft("provisional-edited", "provisional text");
  setChatComposerAttachments("provisional-edited", [attachment("provisional")]);
  coalesceChatComposerState("retained-edited", "provisional-edited");
  setChatComposerDraft("retained-edited", (current) => `${current}\nadditional edit`);
  setChatComposerAttachments("retained-edited", (current) => [...current, attachment("additional")]);

  assert.equal(clearAcknowledgedChatComposer("retained-edited", submitted), true);
  assert.deepEqual(chatComposerState("retained-edited").value, {
    draft: "provisional text\nadditional edit",
    attachments: [attachment("provisional"), attachment("additional")],
  });
});
