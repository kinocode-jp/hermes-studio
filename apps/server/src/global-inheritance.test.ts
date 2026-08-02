import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { desiredSkillsForProfile, GlobalInheritanceCoordinator } from "./global-inheritance.js";
import type { HermesSettingsAdapter, SkillSettingsDto } from "./hermes-settings.js";
import { HermesSettingsError, OfficeGlobalSettingsStore } from "./hermes-settings.js";
import type { OfficeTeamSkillLayer } from "./office-teams.js";

test("global skills claim only Office-enabled pairs and persist provenance across restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-global-inheritance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "global.json");
  const skills = new Map([
    ["coder", new Map([["browser", false]])],
    ["reviewer", new Map([["browser", true]])],
  ]);
  const mutations: Array<[string, string, boolean, boolean | undefined]> = [];
  const adapter = fakeSettings(skills, mutations);
  const first = new GlobalInheritanceCoordinator({
    store: new OfficeGlobalSettingsStore(file),
    settings: adapter,
    listProfiles: async () => ["coder", "reviewer"],
  });

  const enabled = await first.update({ expectedRevision: 0, skills: ["browser"] });
  assert.equal(enabled.skillSync.state, "ready");
  assert.equal(skills.get("coder")?.get("browser"), true);
  assert.equal(skills.get("reviewer")?.get("browser"), true);
  assert.deepEqual(mutations, [["coder", "browser", true, false]]);

  // A fresh coordinator reads durable provenance and disables only the pair it
  // originally enabled. reviewer's pre-enabled skill remains untouched.
  const restarted = new GlobalInheritanceCoordinator({
    store: new OfficeGlobalSettingsStore(file),
    settings: adapter,
    listProfiles: async () => ["coder", "reviewer"],
  });
  const removed = await restarted.update({ expectedRevision: 1, skills: [] });
  assert.equal(removed.skillSync.state, "ready");
  assert.equal(skills.get("coder")?.get("browser"), false);
  assert.equal(skills.get("reviewer")?.get("browser"), true);
  assert.deepEqual(mutations.at(-1), ["coder", "browser", false, true]);
});

test("profile override relinquishes ownership and global removal never overwrites it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-global-override-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OfficeGlobalSettingsStore(join(directory, "global.json"));
  const skills = new Map([["coder", new Map([["browser", false]])]]);
  const mutations: Array<[string, string, boolean, boolean | undefined]> = [];
  const coordinator = new GlobalInheritanceCoordinator({ store, settings: fakeSettings(skills, mutations), listProfiles: async () => ["coder"] });
  await coordinator.update({ expectedRevision: 0, skills: ["browser"] });

  await coordinator.noteProfileSkillOverride("coder", "browser");
  skills.get("coder")!.set("browser", false);
  await coordinator.update({ expectedRevision: 1, skills: [] });
  await coordinator.update({ expectedRevision: 2, skills: ["browser"] });

  assert.equal(skills.get("coder")?.get("browser"), false);
  assert.equal(mutations.length, 1, "global remove/re-add must not issue a second toggle after a Profile override");
});

test("failed materialization is explicit pending state and the next revision retries safely", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-global-pending-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OfficeGlobalSettingsStore(join(directory, "global.json"));
  const skills = new Map([
    ["coder", new Map([["research", false]])],
    ["reviewer", new Map<string, boolean>()],
  ]);
  const coordinator = new GlobalInheritanceCoordinator({ store, settings: fakeSettings(skills, []), listProfiles: async () => ["coder", "reviewer"] });

  const pending = await coordinator.update({
    expectedRevision: 0,
    skills: ["research"],
    context: "Use verified sources.",
    sharedContextEnabled: true,
  });
  assert.equal(pending.revision, 1);
  assert.equal(pending.skillSync.state, "pending");
  assert.deepEqual(pending.skillSync.failures, [{ profile: "reviewer", skill: "research", operation: "enable" }]);
  assert.equal(await coordinator.sessionCreateContext(), "Use verified sources.");

  skills.get("reviewer")!.set("research", false);
  const retried = await coordinator.update({ expectedRevision: 1, skills: ["research"] });
  assert.equal(retried.revision, 2);
  assert.equal(retried.skillSync.state, "ready");
  assert.equal(skills.get("coder")?.get("research"), true);
  assert.equal(skills.get("reviewer")?.get("research"), true);

  const disabled = await coordinator.update({ expectedRevision: 2, sharedContextEnabled: false });
  assert.equal(disabled.sharedContextEnabled, false);
  assert.equal(await coordinator.sessionCreateContext(), undefined);
});

test("committed global settings return pending when profile discovery is unavailable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-global-discovery-pending-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OfficeGlobalSettingsStore(join(directory, "global.json"));
  const coordinator = new GlobalInheritanceCoordinator({
    store,
    settings: fakeSettings(new Map(), []),
    listProfiles: async () => { throw new Error("profile discovery unavailable"); },
  });

  const result = await coordinator.update({ expectedRevision: 0, context: "Committed context" });
  assert.equal(result.revision, 1);
  assert.equal(result.context, "Committed context");
  assert.deepEqual(result.skillSync, {
    state: "pending",
    failures: [{ profile: "default", skill: "profile-discovery", operation: "enable" }],
  });
});

test("durable override intent survives commit I/O failure and restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-override-outbox-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "global.json");
  let failCommit = false;
  const store = new OfficeGlobalSettingsStore(file, {
    beforeWrite: async (state) => {
      if (failCommit && state.pendingSkillOverrides.length === 0 && state.skillOverrides.length > 0) {
        throw new Error("injected commit failure");
      }
    },
  });
  await seedManagedSkill(store, "coder", "browser");
  const skills = new Map([["coder", new Map([["browser", true]])]]);
  const settings = fakeSettings(skills, []);
  const coordinator = new GlobalInheritanceCoordinator({ store, settings, listProfiles: async () => ["coder"] });

  failCommit = true;
  await assert.rejects(
    coordinator.applyProfileSkillOverride("coder", "browser", false, true, async () => {
      skills.get("coder")!.set("browser", false);
    }),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "rejected" && error.message.includes("reconciliation"),
  );
  assert.equal(skills.get("coder")?.get("browser"), false, "Hermes mutation did succeed");
  const pending = await store.readMaterialization();
  assert.equal(pending.pendingSkillOverrides.length, 1);
  assert.deepEqual(pending.managedSkills, [{ profile: "coder", skill: "browser" }]);
  assert.deepEqual(pending.skillOverrides, []);

  failCommit = false;
  let duplicateMutationCalls = 0;
  const restartedStore = new OfficeGlobalSettingsStore(file);
  const restarted = new GlobalInheritanceCoordinator({ store: restartedStore, settings, listProfiles: async () => ["coder"] });
  await restarted.applyProfileSkillOverride("coder", "browser", false, true, async () => {
    duplicateMutationCalls += 1;
  });
  assert.equal(duplicateMutationCalls, 0, "desired Hermes state commits without a duplicate mutation");
  const committed = await restartedStore.readMaterialization();
  assert.deepEqual(committed.pendingSkillOverrides, []);
  assert.deepEqual(committed.managedSkills, []);
  assert.deepEqual(committed.skillOverrides, [{ profile: "coder", skill: "browser" }]);
  await restarted.applyProfileSkillOverride("coder", "browser", false, true, async () => {
    duplicateMutationCalls += 1;
  });
  assert.equal(duplicateMutationCalls, 0, "a committed duplicate is idempotent");
  await restarted.update({ expectedRevision: 1, skills: ["browser"] });
  assert.equal(skills.get("coder")?.get("browser"), false, "later global sync must respect recovered ownership");
});

test("Hermes failure remains recoverable and conflicting duplicates are rejected", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-override-hermes-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "global.json");
  const store = new OfficeGlobalSettingsStore(file);
  await seedManagedSkill(store, "coder", "browser");
  const skills = new Map([["coder", new Map([["browser", true]])]]);
  const mutations: Array<[string, string, boolean, boolean | undefined]> = [];
  const settings = fakeSettings(skills, mutations);
  const coordinator = new GlobalInheritanceCoordinator({ store, settings, listProfiles: async () => ["coder"] });

  await assert.rejects(
    coordinator.applyProfileSkillOverride("coder", "browser", false, true, async () => {
      throw new HermesSettingsError("timed_out", "ambiguous upstream timeout");
    }),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "rejected" && error.message.includes("reconciliation"),
  );
  assert.equal((await store.readMaterialization()).pendingSkillOverrides.length, 1);
  assert.deepEqual((await coordinator.read()).skillSync, {
    state: "pending",
    failures: [{ profile: "coder", skill: "browser", operation: "disable" }],
  });

  let conflictingMutationCalls = 0;
  await assert.rejects(
    coordinator.applyProfileSkillOverride("coder", "browser", true, false, async () => {
      conflictingMutationCalls += 1;
    }),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "conflict",
  );
  assert.equal(conflictingMutationCalls, 0);

  const restarted = new GlobalInheritanceCoordinator({
    store: new OfficeGlobalSettingsStore(file),
    settings,
    listProfiles: async () => ["coder"],
  });
  await restarted.applyProfileSkillOverride("coder", "browser", false, true, async () => {
    throw new Error("existing intent must reconcile instead");
  });
  assert.equal(skills.get("coder")?.get("browser"), false);
  assert.deepEqual(mutations, [["coder", "browser", false, true]]);
});

test("intent write failure prevents Hermes mutation from starting", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-override-prepare-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "global.json");
  let failPrepare = false;
  const store = new OfficeGlobalSettingsStore(file, {
    beforeWrite: async (state) => {
      if (failPrepare && state.pendingSkillOverrides.length > 0) throw new Error("injected prepare failure");
    },
  });
  await seedManagedSkill(store, "coder", "browser");
  failPrepare = true;
  const skills = new Map([["coder", new Map([["browser", true]])]]);
  const coordinator = new GlobalInheritanceCoordinator({ store, settings: fakeSettings(skills, []), listProfiles: async () => ["coder"] });
  let mutationCalls = 0;
  await assert.rejects(coordinator.applyProfileSkillOverride("coder", "browser", false, true, async () => {
    mutationCalls += 1;
  }));
  assert.equal(mutationCalls, 0);
  assert.equal(skills.get("coder")?.get("browser"), true);
  assert.deepEqual((await store.readMaterialization()).pendingSkillOverrides, []);
});

test("Hermes precondition failure plus abort I/O failure remains durable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-override-abort-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "global.json");
  let failAbort = false;
  const store = new OfficeGlobalSettingsStore(file, {
    beforeWrite: async (state) => {
      if (failAbort && state.pendingSkillOverrides.length === 0 && state.skillOverrides.length === 0) {
        throw new Error("injected abort failure");
      }
    },
  });
  await seedManagedSkill(store, "coder", "browser");
  failAbort = true;
  const skills = new Map([["coder", new Map([["browser", true]])]]);
  const settings = fakeSettings(skills, []);
  const coordinator = new GlobalInheritanceCoordinator({ store, settings, listProfiles: async () => ["coder"] });
  await assert.rejects(
    coordinator.applyProfileSkillOverride("coder", "browser", false, true, async () => {
      throw new HermesSettingsError("conflict", "changed");
    }),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "rejected" && error.message.includes("reconciliation"),
  );
  assert.equal((await store.readMaterialization()).pendingSkillOverrides.length, 1);

  failAbort = false;
  const restarted = new GlobalInheritanceCoordinator({
    store: new OfficeGlobalSettingsStore(file),
    settings,
    listProfiles: async () => ["coder"],
  });
  await restarted.applyProfileSkillOverride("coder", "browser", false, true, async () => {
    throw new Error("durable intent must reconcile after restart");
  });
  assert.equal(skills.get("coder")?.get("browser"), false);
  assert.deepEqual((await new OfficeGlobalSettingsStore(file).readMaterialization()).pendingSkillOverrides, []);
});

test("global enable survives commit and finish I/O failure, restart, retry, and removal", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-global-outbox-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "global.json");
  let failWrites = false;
  const store = new OfficeGlobalSettingsStore(file, {
    beforeWrite: async () => { if (failWrites) throw new Error("injected post-Hermes storage failure"); },
  });
  const skills = new Map([["coder", new Map([["browser", false]])]]);
  const mutations: Array<[string, string, boolean, boolean | undefined]> = [];
  const settings = fakeSettings(skills, mutations);
  const originalSet = settings.setSkillEnabled;
  settings.setSkillEnabled = async (profile, skill, enabled, expected) => {
    await originalSet(profile, skill, enabled, expected);
    failWrites = true;
  };
  const coordinator = new GlobalInheritanceCoordinator({ store, settings, listProfiles: async () => ["coder"] });

  await assert.rejects(coordinator.update({ expectedRevision: 0, skills: ["browser"] }));
  assert.equal(skills.get("coder")?.get("browser"), true);
  const stranded = await store.readMaterialization();
  assert.equal(stranded.settings.revision, 1);
  assert.equal(stranded.settings.skillSync.state, "pending");
  assert.deepEqual(stranded.managedSkills, []);
  assert.equal(stranded.pendingGlobalSkillMutations.length, 1);

  failWrites = false;
  const restartedStore = new OfficeGlobalSettingsStore(file);
  const restarted = new GlobalInheritanceCoordinator({ store: restartedStore, settings, listProfiles: async () => ["coder"] });
  const retried = await restarted.update({ expectedRevision: 1, skills: ["browser"] });
  assert.equal(retried.skillSync.state, "ready");
  assert.deepEqual((await restartedStore.readMaterialization()).managedSkills, [{ profile: "coder", skill: "browser" }]);
  assert.deepEqual(mutations, [["coder", "browser", true, false]], "retry must not mistake or re-enable an Office-applied skill");

  const removed = await restarted.update({ expectedRevision: 2, skills: [] });
  assert.equal(removed.skillSync.state, "ready");
  assert.equal(skills.get("coder")?.get("browser"), false);
  assert.deepEqual(mutations.at(-1), ["coder", "browser", false, true]);
  assert.deepEqual((await restartedStore.readMaterialization()).managedSkills, []);
  assert.deepEqual((await restartedStore.readMaterialization()).pendingGlobalSkillMutations, []);
});

test("global intent save failure prevents Hermes mutation and ambiguous success reconciles", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-global-outbox-boundaries-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prepareFile = join(directory, "prepare.json");
  let failPrepare = true;
  const prepareStore = new OfficeGlobalSettingsStore(prepareFile, {
    beforeWrite: async (state) => {
      if (failPrepare && state.pendingGlobalSkillMutations.length > 0) throw new Error("injected intent failure");
    },
  });
  const prepareSkills = new Map([["coder", new Map([["browser", false]])]]);
  const prepareMutations: Array<[string, string, boolean, boolean | undefined]> = [];
  const prepareCoordinator = new GlobalInheritanceCoordinator({
    store: prepareStore,
    settings: fakeSettings(prepareSkills, prepareMutations),
    listProfiles: async () => ["coder"],
  });
  await assert.rejects(prepareCoordinator.update({ expectedRevision: 0, skills: ["browser"] }));
  assert.deepEqual(prepareMutations, []);
  assert.equal(prepareSkills.get("coder")?.get("browser"), false);

  failPrepare = false;
  const ambiguousFile = join(directory, "ambiguous.json");
  const ambiguousStore = new OfficeGlobalSettingsStore(ambiguousFile);
  const ambiguousSkills = new Map([["coder", new Map([["browser", false]])]]);
  const base = fakeSettings(ambiguousSkills, []);
  base.setSkillEnabled = async (profile, skill, enabled) => {
    ambiguousSkills.get(profile)!.set(skill, enabled);
    throw new HermesSettingsError("timed_out", "applied before timeout");
  };
  const ambiguous = new GlobalInheritanceCoordinator({ store: ambiguousStore, settings: base, listProfiles: async () => ["coder"] });
  const ambiguousResult = await ambiguous.update({ expectedRevision: 0, skills: ["browser"] });
  assert.equal(ambiguousResult.skillSync.state, "pending");
  assert.equal(ambiguousSkills.get("coder")?.get("browser"), true);
  assert.equal((await ambiguousStore.readMaterialization()).pendingGlobalSkillMutations.length, 1);

  const recoveredSettings = fakeSettings(ambiguousSkills, []);
  const recovered = new GlobalInheritanceCoordinator({
    store: new OfficeGlobalSettingsStore(ambiguousFile), settings: recoveredSettings, listProfiles: async () => ["coder"],
  });
  await recovered.update({ expectedRevision: 1, skills: ["browser"] });
  assert.deepEqual((await new OfficeGlobalSettingsStore(ambiguousFile).readMaterialization()).managedSkills, [{ profile: "coder", skill: "browser" }]);
});

test("partial multi-profile global application reconciles each durable pair", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-global-outbox-partial-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "global.json");
  let failReviewerCommit = false;
  const store = new OfficeGlobalSettingsStore(file, {
    beforeWrite: async (state) => {
      if (failReviewerCommit && state.pendingGlobalSkillMutations.every((item) => item.profile !== "reviewer")) {
        throw new Error("injected reviewer commit failure");
      }
    },
  });
  const skills = new Map([
    ["coder", new Map([["browser", false]])],
    ["reviewer", new Map([["browser", false]])],
  ]);
  const mutations: Array<[string, string, boolean, boolean | undefined]> = [];
  const settings = fakeSettings(skills, mutations);
  const originalSet = settings.setSkillEnabled;
  settings.setSkillEnabled = async (profile, skill, enabled, expected) => {
    await originalSet(profile, skill, enabled, expected);
    if (profile === "reviewer") failReviewerCommit = true;
  };
  const coordinator = new GlobalInheritanceCoordinator({ store, settings, listProfiles: async () => ["coder", "reviewer"] });
  const partialResult = await coordinator.update({ expectedRevision: 0, skills: ["browser"] });
  assert.equal(partialResult.skillSync.state, "pending");
  const partial = await store.readMaterialization();
  assert.deepEqual(partial.managedSkills, [{ profile: "coder", skill: "browser" }]);
  assert.deepEqual(partial.pendingGlobalSkillMutations.map((item) => item.profile), ["reviewer"]);

  failReviewerCommit = false;
  const restartedStore = new OfficeGlobalSettingsStore(file);
  const restarted = new GlobalInheritanceCoordinator({ store: restartedStore, settings, listProfiles: async () => ["coder", "reviewer"] });
  await restarted.update({ expectedRevision: 1, skills: ["browser"] });
  assert.deepEqual((await restartedStore.readMaterialization()).managedSkills, [
    { profile: "coder", skill: "browser" },
    { profile: "reviewer", skill: "browser" },
  ]);
  assert.equal(mutations.filter((item) => item[2] === true).length, 2, "reconcile must not duplicate successful enables");
});

test("global pair intents deduplicate identical work and reject conflicting work", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-global-outbox-deduplicate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OfficeGlobalSettingsStore(join(directory, "global.json"));
  const staged = await store.beginMaterialization({ expectedRevision: 0, skills: ["browser"] });
  const first = await store.prepareGlobalSkillMutation(staged.settings.revision, "coder", "browser", true, false);
  const duplicate = await store.prepareGlobalSkillMutation(staged.settings.revision, "coder", "browser", true, false);
  assert.equal(duplicate.existing, true);
  assert.equal(duplicate.transaction.id, first.transaction.id);
  await assert.rejects(
    store.prepareGlobalSkillMutation(staged.settings.revision, "coder", "browser", false, true),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "conflict",
  );
  assert.equal((await store.readMaterialization()).pendingGlobalSkillMutations.length, 1);
});

test("desiredSkillsForProfile unions global and membership team skills with toggles", () => {
  const layers: OfficeTeamSkillLayer[] = [
    {
      teamId: "team-aaaaaaaaaaaaaaaaaaaaaaaa",
      memberProfileIds: ["coder", "reviewer"],
      skillsEnabled: true,
      skills: ["browser", "research"],
      contextEnabled: true,
      context: "alpha",
    },
    {
      teamId: "team-bbbbbbbbbbbbbbbbbbbbbbbb",
      memberProfileIds: ["coder"],
      skillsEnabled: false,
      skills: ["deploy"],
      contextEnabled: true,
      context: "beta-off",
    },
    {
      teamId: "team-cccccccccccccccccccccccc",
      memberProfileIds: ["reviewer"],
      skillsEnabled: true,
      skills: ["lint"],
      contextEnabled: true,
      context: "gamma",
    },
  ];
  const coder = desiredSkillsForProfile(
    "coder",
    { sharedSkillsEnabled: true, skills: ["browser", "global-only"] },
    layers,
  );
  assert.deepEqual([...coder].sort(), ["browser", "global-only", "research"]);

  const reviewerNoGlobal = desiredSkillsForProfile(
    "reviewer",
    { sharedSkillsEnabled: false, skills: ["browser", "global-only"] },
    layers,
  );
  assert.deepEqual([...reviewerNoGlobal].sort(), ["browser", "lint", "research"]);
});

test("team layer skills materialize into member profiles and rematerialize on change", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-team-inheritance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OfficeGlobalSettingsStore(join(directory, "global.json"));
  const skills = new Map([
    ["coder", new Map([["browser", false], ["research", false]])],
    ["reviewer", new Map([["browser", false], ["research", false]])],
  ]);
  const mutations: Array<[string, string, boolean, boolean | undefined]> = [];
  let layers: OfficeTeamSkillLayer[] = [
    {
      teamId: "team-aaaaaaaaaaaaaaaaaaaaaaaa",
      memberProfileIds: ["coder"],
      skillsEnabled: true,
      skills: ["research"],
      contextEnabled: true,
      context: "Team shared prompt",
    },
  ];
  const coordinator = new GlobalInheritanceCoordinator({
    store,
    settings: fakeSettings(skills, mutations),
    listProfiles: async () => ["coder", "reviewer"],
    listTeamLayers: async () => layers,
  });

  // Global empty; team skill still enables for the member only.
  await coordinator.rematerializeSkills();
  assert.equal(skills.get("coder")?.get("research"), true);
  assert.equal(skills.get("reviewer")?.get("research"), false);
  assert.deepEqual(mutations, [["coder", "research", true, false]]);

  // Global adds browser for everyone; team skill remains for coder.
  await coordinator.update({ expectedRevision: 0, skills: ["browser"] });
  assert.equal(skills.get("coder")?.get("browser"), true);
  assert.equal(skills.get("reviewer")?.get("browser"), true);
  assert.equal(skills.get("coder")?.get("research"), true);

  // Profile override wins: later rematerialize must not re-enable research for coder.
  await coordinator.noteProfileSkillOverride("coder", "research");
  skills.get("coder")!.set("research", false);
  layers = [{
    ...layers[0]!,
    skills: ["research", "browser"],
  }];
  await coordinator.rematerializeSkills();
  assert.equal(skills.get("coder")?.get("research"), false, "profile override blocks team re-enable");

  // Team context joins global context for the member profile.
  await coordinator.update({
    expectedRevision: 1,
    context: "Global shared prompt",
    sharedContextEnabled: true,
  });
  assert.equal(
    await coordinator.sessionCreateContext("coder"),
    "Global shared prompt\n\nTeam shared prompt",
  );
  assert.equal(await coordinator.sessionCreateContext("reviewer"), "Global shared prompt");
  assert.equal(await coordinator.sessionCreateContext(), "Global shared prompt");
});

test("materialization shares one deadline and drops queued work that has already expired", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-global-deadline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OfficeGlobalSettingsStore(join(directory, "global.json"));
  let listCalls = 0;
  const settings = {
    listSkills: async (_profile: string, options?: { deadlineMs?: number }) => {
      listCalls += 1;
      const remaining = Math.max(1, (options?.deadlineMs ?? Date.now()) - Date.now());
      await new Promise((resolve) => setTimeout(resolve, remaining + 25));
      throw new HermesSettingsError("timed_out", "simulated deadline");
    },
  } as unknown as HermesSettingsAdapter;
  const coordinator = new GlobalInheritanceCoordinator({
    store,
    settings,
    listProfiles: async () => ["coder"],
    materializationTimeoutMs: 100,
  });

  const first = coordinator.update({ expectedRevision: 0, skills: ["browser"] });
  const expiredBehindFirst = coordinator.rematerializeSkills();
  assert.equal((await first).skillSync.state, "pending");
  await assert.rejects(expiredBehindFirst, (error: unknown) => error instanceof HermesSettingsError && error.code === "rejected");
  assert.equal(listCalls, 1);
  assert.equal((await coordinator.read()).skillSync.state, "pending");
});

async function seedManagedSkill(store: OfficeGlobalSettingsStore, profile: string, skill: string): Promise<void> {
  const staged = await store.beginMaterialization({ expectedRevision: 0, skills: [skill] });
  await store.finishMaterialization(staged.settings.revision, [{ profile, skill }], [], []);
}

function fakeSettings(
  state: Map<string, Map<string, boolean>>,
  mutations: Array<[string, string, boolean, boolean | undefined]>,
): HermesSettingsAdapter {
  return {
    listSkills: async (profile) => [...(state.get(profile) ?? new Map())].map(([name, enabled]): SkillSettingsDto => ({ name, enabled, category: "test", description: "", provenance: "agent", usage: 0 })),
    setSkillEnabled: async (profile, name, enabled, expected) => {
      const profileSkills = state.get(profile);
      if (profileSkills === undefined || !profileSkills.has(name)) throw new HermesSettingsError("not_found", "missing");
      if (expected !== undefined && profileSkills.get(name) !== expected) throw new HermesSettingsError("conflict", "changed");
      mutations.push([profile, name, enabled, expected]);
      profileSkills.set(name, enabled);
    },
  } as HermesSettingsAdapter;
}
