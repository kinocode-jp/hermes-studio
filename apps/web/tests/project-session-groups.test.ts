import assert from "node:assert/strict";
import test from "node:test";
import type { ChatSession } from "../src/domain";
import { groupSessionsByProject } from "../src/project-session-groups";

function session(id: string, projectGroupId?: string, projectGroupName?: string, updatedAt = "2026-01-01T00:00:00.000Z"): ChatSession {
  return {
    id,
    profileId: "default",
    title: id,
    status: "ready",
    messages: [],
    updatedAt,
    ...(projectGroupId === undefined ? {} : { projectGroupId }),
    ...(projectGroupName === undefined ? {} : { projectGroupName }),
  };
}

test("groupSessionsByProject merges profiles by opaque project id and keeps unassigned last", () => {
  const first = session("first", "project-a", "Alpha", "2026-01-01T00:00:00.000Z");
  const recent = { ...session("recent", "project-b", "Beta", "2026-01-03T00:00:00.000Z"), profileId: "builder" };
  const same = { ...session("same", "project-a", "Alpha", "2026-01-02T00:00:00.000Z"), profileId: "researcher" };
  const unassigned = session("draft");

  const groups = groupSessionsByProject([first, recent, same, unassigned]);

  assert.deepEqual(groups.map((group) => group.key), ["project-b", "project-a", "unassigned"]);
  assert.deepEqual(groups[1]?.sessions.map((item) => item.id), ["first", "same"]);
  assert.equal(groups[2]?.kind, "unassigned");
});
