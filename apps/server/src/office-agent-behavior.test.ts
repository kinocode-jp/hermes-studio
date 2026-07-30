import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HermesSettingsError } from "./hermes-settings.js";
import {
  OfficeAgentBehaviorStore,
  appendStudioFollowUpTurnInstruction,
  buildSubagentSessionInstruction,
  composeSessionCreateSystemSeed,
  stripStudioFollowUpTurnInstruction,
  studioDefaultProfileOrchestrationInstruction,
  studioProfileAgentBehaviorInstruction,
  studioFollowUpSessionInstruction,
  studioFollowUpTurnInstruction,
} from "./office-agent-behavior.js";

test("agent behavior store defaults, round-trips, and rejects stale revisions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-agent-behavior-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "agent-behavior.json");
  const store = new OfficeAgentBehaviorStore(file);

  const initial = await store.read("coder");
  assert.deepEqual(initial, {
    sharedRevision: 0,
    sharedCandidates: [],
    profile: {
      profile: "coder",
      revision: 0,
      subagentMode: "manual",
      preferredSubagent: "",
      preferredCandidateIds: [],
      updatedAt: "1970-01-01T00:00:00.000Z",
    },
  });
  assert.equal(await store.sessionCreateInstruction("coder"), undefined);

  const saved = await store.update("coder", {
    expectedRevision: 0,
    subagentMode: "auto",
    preferredSubagent: "research",
  });
  assert.equal(saved.profile.revision, 1);
  assert.equal(saved.profile.subagentMode, "auto");
  assert.equal(saved.profile.preferredSubagent, "research");
  assert.deepEqual(await store.read("coder"), saved);
  assert.equal(
    await store.sessionCreateInstruction("coder"),
    "Use subagents proactively. Preferred subagent: research.",
  );

  const disk = JSON.parse(await readFile(file, "utf8")) as {
    profiles: Record<string, unknown>;
  };
  assert.equal((disk.profiles.coder as { revision: number }).revision, 1);

  await assert.rejects(
    store.update("coder", { expectedRevision: 0, subagentMode: "manual" }),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "conflict",
  );
  assert.equal((await store.read("coder")).profile.revision, 1);

  const cleared = await store.update("coder", {
    expectedRevision: 1,
    subagentMode: "auto",
    preferredSubagent: "",
  });
  assert.equal(await store.sessionCreateInstruction("coder"), "Use subagents proactively.");
  assert.equal(cleared.profile.preferredSubagent, "");
});

test("agent behavior store serializes concurrent updates for one revision", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-agent-behavior-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OfficeAgentBehaviorStore(join(directory, "agent-behavior.json"));
  const results = await Promise.allSettled([
    store.update("coder", { expectedRevision: 0, subagentMode: "auto", preferredSubagent: "a" }),
    store.update("coder", { expectedRevision: 0, subagentMode: "auto", preferredSubagent: "b" }),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  assert.equal((await store.read("coder")).profile.revision, 1);
});

test("shared candidates use an independent revision across profiles", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-agent-behavior-shared-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OfficeAgentBehaviorStore(join(directory, "agent-behavior.json"));
  const candidate = {
    id: "fast",
    label: "Fast",
    provider: "openai",
    model: "gpt-fast",
    reasoningEffort: "low",
    enabled: true,
  };

  const saved = await store.update("coder", {
    expectedRevision: 0,
    expectedSharedRevision: 0,
    sharedCandidates: [candidate],
  });
  assert.equal(saved.sharedRevision, 1);

  await assert.rejects(
    store.update("reviewer", {
      expectedRevision: 0,
      expectedSharedRevision: 0,
      sharedCandidates: [],
    }),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "conflict",
  );
  assert.deepEqual((await store.read("reviewer")).sharedCandidates, [candidate]);
});

test("removing a shared candidate clears every profile that selected it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-agent-behavior-shared-remove-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OfficeAgentBehaviorStore(join(directory, "agent-behavior.json"));
  const candidate = {
    id: "fast",
    label: "Fast",
    provider: "openai",
    model: "gpt-fast",
    reasoningEffort: "low",
    enabled: true,
  };
  await store.update("legacy", {
    expectedRevision: 0,
    subagentMode: "auto",
    preferredSubagent: "research",
  });

  const coder = await store.update("coder", {
    expectedRevision: 0,
    expectedSharedRevision: 0,
    sharedCandidates: [candidate],
    preferredCandidateIds: [candidate.id],
  });
  await store.update("reviewer", {
    expectedRevision: 0,
    subagentMode: "auto",
    preferredCandidateIds: [candidate.id],
  });

  await store.update("coder", {
    expectedRevision: coder.profile.revision,
    expectedSharedRevision: coder.sharedRevision,
    sharedCandidates: [],
    preferredCandidateIds: [],
  });

  const reviewer = await store.read("reviewer");
  assert.equal(reviewer.profile.revision, 2);
  assert.deepEqual(reviewer.profile.preferredCandidateIds, []);
  assert.equal(reviewer.profile.preferredSubagent, "");
  assert.equal(await store.sessionCreateInstruction("reviewer"), "Use subagents proactively.");
  const legacy = await store.read("legacy");
  assert.equal(legacy.profile.revision, 1);
  assert.equal(legacy.profile.preferredSubagent, "research");
});

test("buildSubagentSessionInstruction and composeSessionCreateSystemSeed are pure", () => {
  const orchestration = studioDefaultProfileOrchestrationInstruction();
  assert.match(orchestration, /front desk and coordinator/);
  assert.match(orchestration, /kanban_create/);
  assert.match(orchestration, /new Studio chat is isolated/);
  assert.equal(studioProfileAgentBehaviorInstruction("default", "Use subagents proactively."), undefined);
  assert.equal(studioProfileAgentBehaviorInstruction("coder", "Use subagents proactively."), "Use subagents proactively.");
  assert.equal(buildSubagentSessionInstruction({ subagentMode: "manual", preferredSubagent: "x", preferredCandidateIds: [] }), undefined);
  assert.equal(
    buildSubagentSessionInstruction({ subagentMode: "auto", preferredSubagent: "", preferredCandidateIds: [] }),
    "Use subagents proactively.",
  );
  assert.equal(
    buildSubagentSessionInstruction({ subagentMode: "auto", preferredSubagent: "  coder  ", preferredCandidateIds: [] }),
    "Use subagents proactively. Preferred subagent: coder.",
  );
  assert.equal(composeSessionCreateSystemSeed(undefined, undefined), undefined);
  assert.equal(composeSessionCreateSystemSeed("global", undefined), "global");
  assert.equal(
    composeSessionCreateSystemSeed("shared context", "Use subagents proactively."),
    "shared context\n\nUse subagents proactively.",
  );

  const followUp = studioFollowUpSessionInstruction();
  assert.match(followUp, /<studio-followups>/);
  assert.match(followUp, /<\/studio-followups>/);
  assert.equal(
    composeSessionCreateSystemSeed("shared context", "Use subagents proactively.", followUp),
    `shared context\n\nUse subagents proactively.\n\n${followUp}`,
  );

  const reinforced = appendStudioFollowUpTurnInstruction("ユーザー本文");
  assert.match(studioFollowUpTurnInstruction(), /<studio-followups>/);
  assert.equal(stripStudioFollowUpTurnInstruction(reinforced), "ユーザー本文");
  assert.equal(stripStudioFollowUpTurnInstruction("通常の本文"), "通常の本文");
});


test("buildSubagentSessionInstruction prefers ordered shared candidates with fallback", () => {
  const instruction = buildSubagentSessionInstruction(
    {
      subagentMode: "auto",
      preferredSubagent: "legacy",
      preferredCandidateIds: ["c2", "missing", "c1"],
    },
    [
      { id: "c1", label: "Fast", provider: "openai", model: "gpt-fast", reasoningEffort: "low", enabled: true },
      { id: "c2", label: "Strong", provider: "openai", model: "gpt-strong", reasoningEffort: "high", enabled: true },
      { id: "c3", label: "Off", provider: "openai", model: "gpt-off", reasoningEffort: "", enabled: false },
    ],
  );
  assert.match(String(instruction), /Preferred subagent model candidates/);
  assert.match(String(instruction), /1\. Strong/);
  assert.match(String(instruction), /2\. Fast/);
  assert.doesNotMatch(String(instruction), /gpt-off/);
});
