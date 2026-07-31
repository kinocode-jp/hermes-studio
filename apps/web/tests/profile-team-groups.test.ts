import assert from "node:assert/strict";
import { test } from "node:test";
import {
  groupProfilesByTeams,
  profileGroupItemKey,
  type TeamGroupInput,
} from "../src/profile-team-groups";
import { parseGroupDisplayMode } from "../src/group-display-prefs";

type P = { id: string; name: string };

const profiles: P[] = [
  { id: "a", name: "A" },
  { id: "b", name: "B" },
  { id: "c", name: "C" },
  { id: "d", name: "D" },
];

function team(partial: Partial<TeamGroupInput> & Pick<TeamGroupInput, "id" | "memberProfileIds">): TeamGroupInput {
  return {
    name: partial.name ?? partial.id,
    color: partial.color ?? "#abcdef",
    ...partial,
  };
}

test("groupProfilesByTeams returns flat list when no teams exist", () => {
  const result = groupProfilesByTeams(profiles, []);
  assert.equal(result.mode, "flat");
  if (result.mode !== "flat") return;
  assert.deepEqual(result.profiles.map((p) => p.id), ["a", "b", "c", "d"]);
});

test("groupProfilesByTeams places many-to-many members under every matching team", () => {
  const teams = [
    team({ id: "t1", name: "Alpha", memberProfileIds: ["a", "b"] }),
    team({ id: "t2", name: "Beta", memberProfileIds: ["b", "c"] }),
  ];
  const result = groupProfilesByTeams(profiles, teams);
  assert.equal(result.mode, "grouped");
  if (result.mode !== "grouped") return;

  const first = result.groups[0];
  assert.ok(first && first.kind === "team");
  assert.deepEqual(first, {
    kind: "team",
    key: "team:t1",
    teamId: "t1",
    name: "Alpha",
    color: "#abcdef",
    profiles: [profiles[0], profiles[1]],
  });

  const second = result.groups[1];
  assert.ok(second && second.kind === "team");
  assert.deepEqual(second.profiles.map((p) => p.id), ["b", "c"]);

  const unassigned = result.groups.find((group) => group.kind === "unassigned");
  assert.ok(unassigned && unassigned.kind === "unassigned");
  assert.deepEqual(unassigned.profiles.map((p) => p.id), ["d"]);

  assert.equal(profileGroupItemKey("team:t1", "b"), "team:t1\0b");
  assert.equal(profileGroupItemKey("team:t2", "b"), "team:t2\0b");
  assert.notEqual(profileGroupItemKey("team:t1", "b"), profileGroupItemKey("team:t2", "b"));
});

test("groupProfilesByTeams ignores stale IDs, in-team duplicates, and empty teams", () => {
  const teams = [
    team({ id: "empty", memberProfileIds: ["ghost", "missing"] }),
    team({ id: "live", name: "Live", memberProfileIds: ["a", "a", "ghost", "c"] }),
  ];
  const result = groupProfilesByTeams(profiles, teams);
  assert.equal(result.mode, "grouped");
  if (result.mode !== "grouped") return;

  const live = result.groups[0];
  assert.ok(live && live.kind === "team");
  assert.equal(live.teamId, "live");
  assert.deepEqual(live.profiles.map((p) => p.id), ["a", "c"]);

  const unassigned = result.groups.find((group) => group.kind === "unassigned");
  assert.ok(unassigned && unassigned.kind === "unassigned");
  assert.deepEqual(unassigned.profiles.map((p) => p.id), ["b", "d"]);

  const seen = new Set(result.groups.flatMap((group) => group.profiles.map((p) => p.id)));
  assert.deepEqual([...seen].sort(), ["a", "b", "c", "d"]);
});

test("groupProfilesByTeams omits unassigned when every profile belongs to a team", () => {
  const teams = [
    team({ id: "t1", name: "Alpha", memberProfileIds: ["a", "b"] }),
    team({ id: "t2", name: "Beta", memberProfileIds: ["c", "d", "b"] }),
  ];
  const result = groupProfilesByTeams(profiles, teams);
  assert.equal(result.mode, "grouped");
  if (result.mode !== "grouped") return;

  assert.equal(result.groups.length, 2);
  assert.equal(result.groups.some((group) => group.kind === "unassigned"), false);

  const first = result.groups[0];
  assert.ok(first && first.kind === "team");
  assert.equal(first.teamId, "t1");
  assert.deepEqual(first.profiles.map((p) => p.id), ["a", "b"]);

  const second = result.groups[1];
  assert.ok(second && second.kind === "team");
  assert.equal(second.teamId, "t2");
  assert.deepEqual(second.profiles.map((p) => p.id), ["c", "d", "b"]);

  const seen = new Set(result.groups.flatMap((group) => group.profiles.map((p) => p.id)));
  assert.deepEqual([...seen].sort(), ["a", "b", "c", "d"]);
});

test("parseGroupDisplayMode defaults unknown values to profiles", () => {
  assert.equal(parseGroupDisplayMode("teams"), "teams");
  assert.equal(parseGroupDisplayMode("projects"), "profiles");
  assert.equal(parseGroupDisplayMode("profiles"), "profiles");
  assert.equal(parseGroupDisplayMode(null), "profiles");
  assert.equal(parseGroupDisplayMode("legacy"), "profiles");
  assert.equal(parseGroupDisplayMode(undefined), "profiles");
});
