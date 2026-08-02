import assert from "node:assert/strict";
import test from "node:test";
import type { ChatSession, WorkTask } from "../src/domain.ts";
import {
  buildCardAskSeedPrompt,
  buildCardSeededUserPrompt,
  CARD_SEED_MAX_CHARS,
  cardAskSeedInputFromTask,
  findCardAskSession,
  sessionNeedsCardSeed,
} from "../src/kanban-ask.ts";
import { CHAT_PROMPT_MAX_UTF8_BYTES } from "@hermes-studio/protocol";
import { chatSessionTitle, setLocale } from "../src/i18n.ts";

test("buildCardAskSeedPrompt includes card identity and truncates huge bodies", () => {
  setLocale("en");
  const huge = "x".repeat(20_000);
  const prompt = buildCardAskSeedPrompt({
    id: "t_abc",
    title: "Fix auth",
    status: "blocked",
    assigneeId: "coder",
    body: huge,
  });
  assert.match(prompt, /\[Kanban card t_abc\] Fix auth/);
  assert.match(prompt, /Status: blocked/);
  assert.match(prompt, /Assignee: coder/);
  assert.match(prompt, /confirmation questions/i);
  assert.ok(prompt.length <= CARD_SEED_MAX_CHARS);
  assert.match(prompt, /xxx…/);
});

test("buildCardAskSeedPrompt falls back to summary then empty body label", () => {
  setLocale("ja");
  const withSummary = buildCardAskSeedPrompt({
    id: "t_1",
    title: "調査",
    status: "todo",
    assigneeId: "researcher",
    latestSummary: "前回の要約",
  });
  assert.match(withSummary, /前回の要約/);

  const empty = buildCardAskSeedPrompt({
    id: "t_2",
    title: "空",
    status: "triage",
    assigneeId: "default",
  });
  assert.match(empty, /本文なし/);
});

test("card context validates the exact final chat prompt", () => {
  setLocale("en");
  assert.equal(buildCardSeededUserPrompt("card", "question"), "card\n\n--- Question ---\nquestion");
  assert.deepEqual(
    buildCardSeededUserPrompt("card context", "x".repeat(CHAT_PROMPT_MAX_UTF8_BYTES)),
    { error: "payload-too-large" },
  );
});

test("findCardAskSession reuses only matching card and assignee", () => {
  const sessions: ChatSession[] = [
    baseSession({ id: "s1", profileId: "coder", sourceCardId: "t_1" }),
    baseSession({ id: "s2", profileId: "writer", sourceCardId: "t_1" }),
    baseSession({ id: "s3", profileId: "coder", sourceCardId: "t_2" }),
  ];
  assert.equal(findCardAskSession(sessions, "t_1", "coder")?.id, "s1");
  assert.equal(findCardAskSession(sessions, "t_1", "writer")?.id, "s2");
  assert.equal(findCardAskSession(sessions, "t_1", "researcher"), undefined);
});

test("sessionNeedsCardSeed is one-shot and empty-transcript only", () => {
  const pending = baseSession({
    id: "s",
    profileId: "coder",
    sourceCardId: "t_1",
    sourceCardSeeded: false,
    pendingCardSeed: "hello",
  });
  assert.equal(sessionNeedsCardSeed(pending), true);
  assert.equal(sessionNeedsCardSeed({ ...pending, sourceCardSeeded: true }), false);
  assert.equal(sessionNeedsCardSeed({
    ...pending,
    messages: [{ id: "m1", from: "user", body: "hi", at: "12:00" }],
  }), false);
  assert.equal(sessionNeedsCardSeed({
    ...pending,
    operationEvidence: [{ id: "o1", kind: "prompt", body: "hi", at: "12:00", state: "pending" }],
  }), true, "RPC evidence does not consume card context before a prompt is accepted");
  assert.equal(sessionNeedsCardSeed({
    ...pending,
    operationEvidence: [{ id: "o2", kind: "prompt", body: "hi", at: "12:00", state: "rejected" }],
  }), true, "an explicitly rejected first attempt keeps card context retryable");
  assert.equal(sessionNeedsCardSeed({
    ...pending,
    messages: [{ id: "slash", from: "tool", body: "model unavailable", at: "12:00", status: "complete" }],
    operationEvidence: [{ id: "slash-op", kind: "prompt", body: "/model unavailable", at: "12:00", state: "rejected" }],
  }), true, "slash evidence and local tool output do not consume the first card question context");
  assert.equal(sessionNeedsCardSeed(baseSession({ id: "plain", profileId: "coder" })), false);
});

test("cardAskSeedInputFromTask preserves optional fields", () => {
  const task: WorkTask & { assigneeId: string } = {
    id: "t_9",
    title: "Ship",
    status: "ready",
    assigneeId: "ops",
    priority: "high",
    comments: 0,
    body: "details",
    latestSummary: "done-ish",
  };
  assert.deepEqual(cardAskSeedInputFromTask(task), {
    id: "t_9",
    title: "Ship",
    status: "ready",
    assigneeId: "ops",
    body: "details",
    latestSummary: "done-ish",
  });
});

test("chatSessionTitle shows Kanban badge for card-linked chats", () => {
  setLocale("en");
  const title = chatSessionTitle({
    title: "Ship",
    titlePresentation: "new-chat",
    sourceCardId: "t_9",
    sourceCardTitle: "Ship it",
  });
  assert.equal(title, "Kanban · Ship it");
});

test("kanban board exposes ask-assignee control", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/components/kanban-board.tsx", import.meta.url), "utf8"),
  );
  assert.match(source, /askAssigneeAboutTask/);
  assert.match(source, /kanban\.askAssignee/);
  assert.match(source, /task-ask-assignee/);
});

test("only workspace-owned chat panes activate the dashboard on pointer down", async () => {
  const fs = await import("node:fs/promises");
  const [pane, workspace, dashboard, kanban, profileModal] = await Promise.all([
    fs.readFile(new URL("../src/components/chat-pane.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/components/chat-workspace.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/components/dashboard-view.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/components/kanban-board.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/components/profile-chat-modal.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(pane, /activateWorkspaceOnPointerDown = false/);
  assert.match(pane, /if \(activateWorkspaceOnPointerDown && activeSessionId\.value !== session\.id\) openSession\(session\.id\)/);
  assert.match(workspace, /<ChatPane[^>]*activateWorkspaceOnPointerDown/);
  assert.match(dashboard, /<ChatPane[^>]*activateWorkspaceOnPointerDown/);
  assert.doesNotMatch(kanban, /<ChatPane[^>]*activateWorkspaceOnPointerDown/);
  assert.doesNotMatch(profileModal, /<ChatPane[^>]*activateWorkspaceOnPointerDown/);
});

test("kanban empty columns collapse by default and manual override wins", async () => {
  const { isKanbanColumnCollapsed } = await import("../src/kanban-board-logic.ts");
  assert.equal(isKanbanColumnCollapsed("todo", 0, {}), true);
  assert.equal(isKanbanColumnCollapsed("todo", 2, {}), false);
  assert.equal(isKanbanColumnCollapsed("todo", 0, { todo: false }), false);
  assert.equal(isKanbanColumnCollapsed("todo", 3, { todo: true }), true);
});

test("kanban column visibility filters selected statuses in board order", async () => {
  const {
    DEFAULT_KANBAN_FOCUS_STATUSES,
    paintKanbanColumns,
    parseKanbanColumnVisibility,
    sanitizeKanbanSelectedStatuses,
    toggleKanbanSelectedStatus,
    visibleKanbanStatuses,
  } = await import("../src/kanban-board-logic.ts");

  assert.deepEqual(
    visibleKanbanStatuses({ mode: "all", selected: ["done"], hideEmpty: false, layout: "columns" }),
    ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done"],
  );
  assert.deepEqual(
    visibleKanbanStatuses({ mode: "selected", selected: ["done", "ready", "todo"], hideEmpty: false, layout: "columns" }),
    ["todo", "ready", "done"],
  );
  // Empty selection falls back to the default focus set.
  assert.deepEqual(
    visibleKanbanStatuses({ mode: "selected", selected: [], hideEmpty: false, layout: "columns" }),
    [...DEFAULT_KANBAN_FOCUS_STATUSES],
  );
  assert.deepEqual(
    sanitizeKanbanSelectedStatuses(["done", "nope", "todo", "todo"]),
    ["todo", "done"],
  );
  assert.deepEqual(
    toggleKanbanSelectedStatus(["todo", "ready"], "ready"),
    ["todo"],
  );
  assert.deepEqual(
    toggleKanbanSelectedStatus(["todo"], "running"),
    ["todo", "running"],
  );
  const parsed = parseKanbanColumnVisibility({ mode: "selected", selected: ["ready", "x"], hideEmpty: true });
  assert.equal(parsed.mode, "selected");
  assert.deepEqual(parsed.selected, ["ready"]);
  assert.equal(parsed.hideEmpty, true);
  assert.equal(parseKanbanColumnVisibility({ mode: "all", selected: [] }).hideEmpty, false);
  assert.equal(parseKanbanColumnVisibility({ mode: "all", selected: [], layout: "stream" }).layout, "stream");
  assert.equal(parseKanbanColumnVisibility({ mode: "all", selected: [] }).layout, "columns");

  const columns = [
    { id: "todo" as const },
    { id: "ready" as const },
    { id: "done" as const },
  ];
  const counts: Record<string, number> = { todo: 2, ready: 0, done: 1 };
  assert.deepEqual(
    paintKanbanColumns(
      columns,
      { mode: "selected", selected: ["done", "ready", "todo"], hideEmpty: true, layout: "columns" },
      (id) => counts[id] ?? 0,
    ).map((column) => column.id),
    ["todo", "done"],
  );
});

function baseSession(partial: Partial<ChatSession> & Pick<ChatSession, "id" | "profileId">): ChatSession {
  return {
    title: "",
    titlePresentation: "new-chat",
    status: "ready",
    messages: [],
    connectionState: "ready",
    historyState: "loaded",
    remoteKind: "demo",
    ...partial,
  };
}
