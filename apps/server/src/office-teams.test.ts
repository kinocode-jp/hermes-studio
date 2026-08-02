import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OfficeTeamsError, OfficeTeamsStore } from "./office-teams.js";

test("team settings default on create and revision-check independently of membership", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-team-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OfficeTeamsStore(join(directory, "teams.json"));

  const team = await store.create({
    name: "Alpha",
    color: "#64b7a7",
    memberProfileIds: ["coder"],
  });
  assert.equal(team.settings.revision, 0);
  assert.equal(team.settings.skillsEnabled, true);
  assert.equal(team.settings.contextEnabled, true);
  assert.deepEqual(team.settings.skills, []);
  assert.equal(team.settings.context, "");

  const settings = await store.updateSettings(team.id, {
    expectedRevision: 0,
    skills: ["browser", "research"],
    context: "Ship carefully.",
  });
  assert.equal(settings.revision, 1);
  assert.deepEqual(settings.skills, ["browser", "research"]);
  assert.equal(settings.context, "Ship carefully.");

  // Membership revision is unchanged by settings updates.
  const afterSettings = await store.get(team.id);
  assert.equal(afterSettings?.revision, 1);
  assert.equal(afterSettings?.settings.revision, 1);

  const renamed = await store.update(team.id, {
    expectedRevision: 1,
    name: "Alpha Core",
  });
  assert.equal(renamed.revision, 2);
  assert.equal(renamed.settings.revision, 1);
  assert.deepEqual(renamed.settings.skills, ["browser", "research"]);

  await assert.rejects(
    store.updateSettings(team.id, { expectedRevision: 0, skillsEnabled: false }),
    (error: unknown) => error instanceof OfficeTeamsError && error.code === "conflict" && error.currentRevision === 1,
  );

  const disabled = await store.updateSettings(team.id, {
    expectedRevision: 1,
    skillsEnabled: false,
    contextEnabled: false,
  });
  assert.equal(disabled.skillsEnabled, false);
  assert.equal(disabled.contextEnabled, false);
  assert.equal(disabled.revision, 2);
});

test("team settings reject invalid skills and secret-like context", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-team-settings-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OfficeTeamsStore(join(directory, "teams.json"));
  const team = await store.create({ name: "Beta", color: "#e07a55" });

  await assert.rejects(
    store.updateSettings(team.id, { expectedRevision: 0, skills: ["bad skill"] }),
    (error: unknown) => error instanceof OfficeTeamsError && error.code === "bad_request",
  );
  await assert.rejects(
    store.updateSettings(team.id, {
      expectedRevision: 0,
      context: "Use key sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 carefully",
    }),
    (error: unknown) => error instanceof OfficeTeamsError && error.code === "bad_request",
  );
});

test("listSkillLayers exposes enabled skills and membership for inheritance", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-team-layers-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OfficeTeamsStore(join(directory, "teams.json"));
  const team = await store.create({
    name: "Gamma",
    color: "#8499c8",
    memberProfileIds: ["coder", "reviewer"],
  });
  await store.updateSettings(team.id, {
    expectedRevision: 0,
    skills: ["browser"],
    context: "Team layer",
  });

  const layers = await store.listSkillLayers();
  assert.equal(layers.length, 1);
  assert.equal(layers[0]!.teamId, team.id);
  assert.deepEqual(layers[0]!.memberProfileIds, ["coder", "reviewer"]);
  assert.deepEqual(layers[0]!.skills, ["browser"]);
  assert.equal(layers[0]!.context, "Team layer");
});

test("missing settings on older durable documents materialize to defaults", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-team-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "teams.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, `${JSON.stringify({
    version: 1,
    teams: [{
      id: "team-aaaaaaaaaaaaaaaaaaaaaaaa",
      name: "Legacy",
      color: "#55d6be",
      memberProfileIds: ["coder"],
      revision: 1,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    }],
  })}\n`, "utf8");

  const store = new OfficeTeamsStore(file);
  const teams = await store.list();
  assert.equal(teams.length, 1);
  assert.equal(teams[0]!.settings.revision, 0);
  assert.equal(teams[0]!.settings.skillsEnabled, true);
  assert.deepEqual(teams[0]!.settings.skills, []);
});
