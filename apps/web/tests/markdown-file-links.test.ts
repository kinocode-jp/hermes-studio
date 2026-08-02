import assert from "node:assert/strict";
import test from "node:test";
import { codeBlockPathReference, tokenizeInline } from "../src/components/markdown.tsx";

test("absolute source file paths become local file links", () => {
  assert.deepEqual(tokenizeInline("修正: /Volumes/D/project/tools/dom_audit.py: hunk"), [
    { kind: "text", text: "修正: " },
    {
      kind: "media",
      text: "/Volumes/D/project/tools/dom_audit.py",
      path: "/Volumes/D/project/tools/dom_audit.py",
    },
    { kind: "text", text: ": hunk" },
  ]);
});

test("inline-code file paths preserve code styling and discard line positions for opening", () => {
  assert.deepEqual(tokenizeInline("`/Volumes/D/My Project/app/main.tsx:42:7`"), [
    {
      kind: "media",
      text: "/Volumes/D/My Project/app/main.tsx:42:7",
      path: "/Volumes/D/My Project/app/main.tsx",
      code: true,
    },
  ]);
});

test("inline-code host directories become local links while API routes remain code", () => {
  assert.deepEqual(tokenizeInline("`/Volumes/D/project/course-draft/`"), [
    {
      kind: "media",
      text: "/Volumes/D/project/course-draft/",
      path: "/Volumes/D/project/course-draft/",
      code: true,
    },
  ]);
  assert.deepEqual(tokenizeInline("`/api/v1/health`"), [
    { kind: "code", text: "/api/v1/health" },
  ]);
});

test("bare host directories with a trailing separator become local links", () => {
  assert.deepEqual(tokenizeInline("成果物: /Volumes/D/project/course-draft/"), [
    { kind: "text", text: "成果物: " },
    {
      kind: "media",
      text: "/Volumes/D/project/course-draft/",
      path: "/Volumes/D/project/course-draft/",
    },
  ]);
  assert.deepEqual(tokenizeInline("成果物: /Volumes/D/project/course-draft"), [
    { kind: "text", text: "成果物: " },
    {
      kind: "media",
      text: "/Volumes/D/project/course-draft",
      path: "/Volumes/D/project/course-draft",
    },
  ]);
});

test("path-only code block lines accept files and directories", () => {
  assert.deepEqual(codeBlockPathReference("/Volumes/D/project/course-draft/"), {
    text: "/Volumes/D/project/course-draft/",
    path: "/Volumes/D/project/course-draft/",
  });
  assert.deepEqual(codeBlockPathReference("  /Volumes/D/project/README.md  "), {
    text: "/Volumes/D/project/README.md",
    path: "/Volumes/D/project/README.md",
  });
  assert.equal(codeBlockPathReference("/api/v1/health"), undefined);
  assert.equal(codeBlockPathReference("npm run /Volumes/D/project/script.py"), undefined);
});

test("MEDIA paths render without the protocol prefix", () => {
  assert.deepEqual(tokenizeInline("MEDIA:/Volumes/D/project/contact-sheet.png"), [
    {
      kind: "media",
      text: "/Volumes/D/project/contact-sheet.png",
      path: "/Volumes/D/project/contact-sheet.png",
    },
  ]);
});

test("Markdown local links accept spaced angle-bracket targets", () => {
  assert.deepEqual(tokenizeInline("[dom_audit.py](</Volumes/D/My Project/tools/dom_audit.py:12>)"), [
    {
      kind: "media",
      text: "dom_audit.py",
      path: "/Volumes/D/My Project/tools/dom_audit.py",
    },
  ]);
});

test("Windows source paths become local file links", () => {
  assert.deepEqual(tokenizeInline(String.raw`C:\work\hermes\main.py:8`), [
    {
      kind: "media",
      text: String.raw`C:\work\hermes\main.py:8`,
      path: String.raw`C:\work\hermes\main.py`,
    },
  ]);
});

test("HTTP URLs and absolute API routes are not treated as local files", () => {
  const tokens = tokenizeInline("`/api/v1/health` https://example.com/app.py");
  assert.deepEqual(tokens[0], { kind: "code", text: "/api/v1/health" });
  assert.equal(tokens.some((token) => token.kind === "media"), false);
  assert.equal(tokens.slice(1).map((token) => token.text).join(""), " https://example.com/app.py");
  assert.deepEqual(tokens.at(-1), {
    kind: "link",
    text: "https://example.com/app.py",
    href: "https://example.com/app.py",
  });
});

test("bare Markdown URLs retain balanced path and query parentheses", () => {
  assert.deepEqual(tokenizeInline("https://en.wikipedia.org/wiki/Function_(mathematics)"), [{
    kind: "link",
    text: "https://en.wikipedia.org/wiki/Function_(mathematics)",
    href: "https://en.wikipedia.org/wiki/Function_(mathematics)",
  }]);
  assert.deepEqual(tokenizeInline("https://example.com/search?q=(foo))"), [
    { kind: "link", text: "https://example.com/search?q=(foo)", href: "https://example.com/search?q=(foo)" },
    { kind: "text", text: ")" },
  ]);
});
