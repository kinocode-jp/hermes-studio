import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ChatSession } from "../src/domain.ts";
import {
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
