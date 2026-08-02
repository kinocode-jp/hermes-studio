import assert from "node:assert/strict";
import test from "node:test";
import { groupSessionsByConfiguredProjects } from "../src/configured-project-groups.ts";
import type { ChatSession } from "../src/domain.ts";
import type { ProfileProject } from "../src/settings-api.ts";

function project(id: string, name: string): ProfileProject {
  return {
    id,
    slug: id,
    name,
    description: null,
    icon: null,
    color: null,
    boardSlug: null,
    primaryPath: null,
    archived: false,
    createdAt: 0,
    folders: [],
  };
}

function session(id: string, profileId: string, projectGroupId?: string): ChatSession {
  return { id, profileId, projectGroupId, title: id, status: "ready", messages: [] };
}

test("configured projects stay visible without a folder and exclude unrelated session directories", () => {
  const groups = groupSessionsByConfiguredProjects([
    session("bound", "coder", "folder-key"),
    session("kanban-cwd", "coder", "kanban-key"),
  ], [{
    profileId: "coder",
    profileName: "Coder",
    projects: [
      { project: project("bound-project", "Bound project"), folderGroupIds: ["folder-key"] },
      { project: project("empty-project", "Empty project"), folderGroupIds: [] },
    ],
  }]);

  assert.deepEqual(groups.map((group) => [group.name, group.sessions.map((item) => item.id)]), [
    ["Bound project", ["bound"]],
    ["Empty project", []],
  ]);
});
