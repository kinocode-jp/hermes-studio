import assert from "node:assert/strict";
import test from "node:test";
import type { ChatSession } from "../src/domain.ts";
import { sessionMatchesDeleteScope } from "../src/session-delete-scope.ts";

function session(id: string, profileId: string, projectGroupId?: string): ChatSession {
  return {
    id,
    profileId,
    projectGroupId,
    projectGroupName: projectGroupId ? `Project ${projectGroupId}` : undefined,
    title: id,
    status: "ready",
    messages: [],
  };
}

test("session deletion scopes distinguish profiles, one project, and all projects", () => {
  const inProjectA = session("a", "profile-a", "project-a");
  const inProjectB = session("b", "profile-a", "project-b");
  const sameProjectOtherProfile = session("same-project-other-profile", "profile-b", "project-a");
  const unassigned = session("c", "profile-b");

  assert.equal(sessionMatchesDeleteScope(inProjectA, { kind: "profile", profileId: "profile-a" }), true);
  assert.equal(sessionMatchesDeleteScope(unassigned, { kind: "profile", profileId: "profile-a" }), false);
  const projectScope = { kind: "project", profileId: "profile-a", projectGroupIds: ["project-a"] } as const;
  assert.equal(sessionMatchesDeleteScope(inProjectA, projectScope), true);
  assert.equal(sessionMatchesDeleteScope(inProjectB, projectScope), false);
  assert.equal(sessionMatchesDeleteScope(sameProjectOtherProfile, projectScope), false);
  assert.equal(sessionMatchesDeleteScope(inProjectA, { kind: "all-projects", projectGroupIds: ["project-a", "project-b"] }), true);
  assert.equal(sessionMatchesDeleteScope(unassigned, { kind: "all-projects", projectGroupIds: ["project-a", "project-b"] }), false);
});
