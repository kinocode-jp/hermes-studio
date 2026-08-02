import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ChatSession } from "../src/domain.ts";
import {
  isScheduledSession,
  isScheduledSessionHidden,
  scheduledSessionKey,
  scheduledSessionsToPrune,
} from "../src/scheduled-sessions.ts";

function scheduledSession(id: string, updatedAt: string): ChatSession {
  return {
    id,
    storedSessionId: id,
    profileId: "default",
    title: `Scheduled task | Jul 26 ${id === "new" ? "11:00" : "10:00"}`,
    updatedAt,
    status: "ready",
    messages: [],
    connectionState: "disconnected",
    historyState: "unloaded",
    remoteKind: "stored",
    readOnly: true,
  };
}

test("zero keep count selects every scheduled session for pruning", () => {
  const newest = scheduledSession("new", "2026-07-26T11:00:00.000Z");
  const older = scheduledSession("old", "2026-07-26T10:00:00.000Z");
  const sessions = [older, newest];

  assert.deepEqual(scheduledSessionsToPrune(sessions, 0).map((session) => session.id), ["new", "old"]);
  assert.deepEqual(
    scheduledSessionsToPrune(sessions, 0, scheduledSessionKey("default", newest.title)).map((session) => session.id),
    ["new", "old"],
  );
});

test("Kanban worker terminal markers are excluded from conversation sessions", () => {
  const terminalMarker: ChatSession = {
    id: "kanban-terminal-marker",
    storedSessionId: "kanban-terminal-marker",
    profileId: "default",
    title: "Kanban terminal transition recorded; this worker run is finished.",
    status: "ready",
    messages: [],
    connectionState: "disconnected",
    historyState: "unloaded",
    remoteKind: "stored",
    readOnly: true,
  };

  assert.equal(isScheduledSession(terminalMarker), false);
  assert.equal(isScheduledSessionHidden(terminalMarker), true);
  assert.equal(isScheduledSessionHidden({ ...terminalMarker, title: "Kanban Task Completion Recorded" }), true);
  assert.equal(isScheduledSessionHidden({ ...terminalMarker, title: "Kanban Task Transition Recorded" }), true);
  assert.equal(isScheduledSessionHidden({ ...terminalMarker, title: "Kanban terminal transition recorded" }), true);
  assert.equal(isScheduledSessionHidden({ ...terminalMarker, title: "Worker log", lastMessagePreview: "Kanban terminal transition recorded" }), true);
  assert.equal(isScheduledSessionHidden({ ...terminalMarker, title: "Untitled session", conversationKind: "delegated" }), false);
  assert.equal(isScheduledSessionHidden({ ...terminalMarker, title: "Discussion: Kanban terminal transition recorded later" }), false);
  assert.equal(isScheduledSessionHidden({ ...terminalMarker, title: "Untitled session", lastMessagePreview: "The Kanban terminal transition recorded a useful result" }), false);
  assert.equal(isScheduledSessionHidden({ ...terminalMarker, conversationKind: "delegated" }), false);
});

test("scheduled session deletion uses an in-app confirmation dialog in desktop WebViews", async () => {
  const source = await readFile(
    new URL("../src/components/scheduled-sessions-panel.tsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /window\.(?:confirm|alert)/);
  assert.match(source, /role="alertdialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /data-mobile-overlay-initial-focus/);
  assert.match(source, /requestDelete\(\s*"all"/);
  assert.match(source, /onConfirm=\{confirmDelete\}/);
  assert.match(source, /role="progressbar"/);
  assert.match(source, /scheduled\.deletingProgress/);
  assert.match(source, /onProgress: setDeleteProgress/);
  assert.match(source, /void loadMoreSessions\(\)/);
  assert.match(source, /loadingAllSessions/);
  assert.match(source, /!sessionInventoryComplete\.value/);
});
