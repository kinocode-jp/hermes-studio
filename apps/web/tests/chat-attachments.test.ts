import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT_PROMPT_MAX_UTF8_BYTES } from "@hermes-studio/protocol";
import {
  appendAttachments,
  buildPromptWithAttachments,
  imageMimeForFile,
  isImageMime,
  normalizeImageDataUrl,
  summarizePromptForEvidence,
  type ChatAttachment,
} from "../src/chat-attachments";

test("image mime falls back to extension when type is empty or generic", () => {
  assert.equal(isImageMime("", "photo.PNG"), true);
  assert.equal(isImageMime("application/octet-stream", "shot.webp"), true);
  assert.equal(isImageMime("application/pdf", "doc.pdf"), false);
  assert.equal(imageMimeForFile("", "photo.PNG"), "image/png");
  assert.equal(imageMimeForFile("application/octet-stream", "shot.webp"), "image/webp");
  assert.equal(normalizeImageDataUrl("data:application/octet-stream;base64,AAAA", "image/png"), "data:image/png;base64,AAAA");
});

test("appendAttachments reports truncation", () => {
  const current = Array.from({ length: 3 }, (_, index) => ({
    id: `a${index}`, name: `a${index}.txt`, mime: "text/plain", size: 1, kind: "file" as const, textContent: "x",
  }));
  const next = Array.from({ length: 3 }, (_, index) => ({
    id: `b${index}`, name: `b${index}.txt`, mime: "text/plain", size: 1, kind: "file" as const, textContent: "y",
  }));
  const result = appendAttachments(current, next);
  assert.equal(result.attachments.length, 4);
  assert.equal(result.truncated, 2);
});

test("buildPromptWithAttachments uses a unique fence for nested backticks", () => {
  const attachment: ChatAttachment = {
    id: "1",
    name: "note.md",
    mime: "text/markdown",
    size: 10,
    kind: "file",
    textContent: "code:\n```\nhello\n```",
  };
  const prompt = buildPromptWithAttachments("see file", [attachment]);
  assert.equal(typeof prompt, "string");
  if (typeof prompt === "string") {
    assert.match(prompt, /````markdown/);
    assert.ok(prompt.includes("hello"));
  }
});

test("buildPromptWithAttachments handles a long backtick run in one bounded scan", () => {
  const backticks = "`".repeat(60_000);
  const attachment: ChatAttachment = {
    id: "long-fence",
    name: "fence.md",
    mime: "text/markdown",
    size: backticks.length,
    kind: "file",
    textContent: backticks,
  };
  const prompt = buildPromptWithAttachments("", [attachment]);
  assert.equal(typeof prompt, "string");
  if (typeof prompt === "string") {
    const lines = prompt.split("\n");
    const fence = "`".repeat(backticks.length + 1);
    assert.equal(lines[1], `${fence}markdown`);
    assert.equal(lines.at(-1), fence);
  }
});

test("summarizePromptForEvidence redacts data URLs", () => {
  const raw = "hi\n![x](data:application/octet-stream;base64,AAAA)\nend";
  const summary = summarizePromptForEvidence(raw);
  assert.ok(!summary.includes("AAAA"));
  assert.ok(summary.includes("data:…"));
});

test("attachment payload limit is measured in UTF-8 bytes", () => {
  const attachment: ChatAttachment = {
    id: "utf8",
    name: "large.txt",
    mime: "text/plain",
    size: 240_000,
    kind: "file",
    textContent: "界".repeat(240_000),
  };
  assert.deepEqual(buildPromptWithAttachments("", [attachment]), { error: "payload-too-large" });
});

test("text-only prompts use the same 512 KiB budget as the Hermes boundary", () => {
  assert.equal(
    buildPromptWithAttachments("x".repeat(CHAT_PROMPT_MAX_UTF8_BYTES), []),
    "x".repeat(CHAT_PROMPT_MAX_UTF8_BYTES),
  );
  assert.deepEqual(
    buildPromptWithAttachments("x".repeat(CHAT_PROMPT_MAX_UTF8_BYTES + 1), []),
    { error: "payload-too-large" },
  );
  assert.deepEqual(
    buildPromptWithAttachments("\\".repeat(CHAT_PROMPT_MAX_UTF8_BYTES), []),
    { error: "payload-too-large" },
    "JSON escaping must leave room for the RPC envelope",
  );
});

test("base64 image prompts over the Hermes text budget are rejected before RPC", () => {
  const attachment: ChatAttachment = {
    id: "oversized-image",
    name: "large.png",
    mime: "image/png",
    size: 450_000,
    kind: "image",
    dataUrl: `data:image/png;base64,${"A".repeat(600_000)}`,
  };
  assert.deepEqual(buildPromptWithAttachments("", [attachment]), { error: "payload-too-large" });
});
