import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GlobalInheritanceCoordinator } from "./global-inheritance.js";
import type { HermesSettingsAdapter } from "./hermes-settings.js";
import { HermesSettingsError, OfficeGlobalSettingsStore } from "./hermes-settings.js";
import { routeSettingsHttp } from "./settings-http.js";
import { SecretTransferStore } from "./secret-transfer.js";

const REVISION = "a".repeat(43);

test("settings HTTP routes reads and revisioned mutations without exposing backend details", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-http-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const adapter = makeAdapter(calls);
  const globalSettings = new OfficeGlobalSettingsStore(join(directory, "global.json"));
  const server = createServer(async (request, response) => {
    const result = await routeSettingsHttp(request, new URL(request.url ?? "/", "http://office.local"), { settings: adapter, globalSettings }, 4_096);
    response.writeHead(result.status, { "Content-Type": "application/json", ...(result.headers ?? {}) });
    response.end(JSON.stringify(result.body));
  });
  const origin = await listen(server);
  t.after(() => server.close());

  const global = await fetch(`${origin}/api/v1/settings/global`);
  assert.equal(global.status, 200);
  assert.equal((await global.json() as { revision: number }).revision, 0);

  const saved = await jsonFetch(`${origin}/api/v1/settings/global`, "PATCH", {
    expectedRevision: 0,
    skills: ["browser"],
    context: "Shared context",
  });
  assert.equal(saved.status, 200);
  assert.equal((saved.body as { revision: number }).revision, 1);

  const stale = await jsonFetch(`${origin}/api/v1/settings/global`, "PATCH", { expectedRevision: 0, context: "stale" });
  assert.equal(stale.status, 409);
  assert.equal((stale.body as { error: { code: string } }).error.code, "conflict");

  assert.equal((await fetch(`${origin}/api/v1/profiles/coder/settings`)).status, 200);
  assert.equal((await fetch(`${origin}/api/v1/profiles/coder/skills`)).status, 200);
  assert.equal((await fetch(`${origin}/api/v1/profiles/coder/skills/local/content`)).status, 200);
  assert.equal((await fetch(`${origin}/api/v1/profiles/coder/soul`)).status, 200);
  assert.equal((await fetch(`${origin}/api/v1/profiles/coder/memory`)).status, 200);
  assert.equal((await fetch(`${origin}/api/v1/profiles/coder/memory/providers/honcho`)).status, 200);

  assert.equal((await jsonFetch(`${origin}/api/v1/profiles/coder/skills/local`, "PATCH", { enabled: false, expectedEnabled: true })).status, 200);
  assert.equal((await jsonFetch(`${origin}/api/v1/profiles/coder/skills/local/content`, "PUT", { content: "safe", expectedRevision: REVISION })).status, 200);
  assert.equal((await jsonFetch(`${origin}/api/v1/profiles/coder/soul`, "PUT", { content: "identity", expectedRevision: REVISION })).status, 200);
  assert.equal((await jsonFetch(`${origin}/api/v1/profiles/coder/memory/provider`, "PUT", { provider: "honcho", expectedProvider: "builtin" })).status, 200);
  assert.equal((await jsonFetch(`${origin}/api/v1/profiles/coder/memory/providers/honcho`, "PATCH", { values: { mode: "local" }, expectedRevision: REVISION })).status, 200);
  assert.equal((await fetch(`${origin}/api/v1/profiles/coder/memory/files`)).status, 200);
  assert.equal((await jsonFetch(`${origin}/api/v1/profiles/coder/memory/files/memory`, "PUT", { content: "note", expectedRevision: REVISION })).status, 200);
  assert.equal((await jsonFetch(`${origin}/api/v1/profiles/coder/memory/reset`, "POST", { target: "user" })).status, 200);

  assert.equal((await fetch(`${origin}/api/v1/profiles/coder/config/schema`)).status, 200);
  assert.equal((await fetch(`${origin}/api/v1/profiles/coder/config`)).status, 200);
  const configPatch = await jsonFetch(`${origin}/api/v1/profiles/coder/config`, "PATCH", {
    expectedRevision: REVISION,
    changes: { model: "anthropic/claude-opus-4" },
  });
  assert.equal(configPatch.status, 200);
  assert.equal((configPatch.body as { values: { model: string } }).values.model, "anthropic/claude-opus-4");

  const configRootRejected = await jsonFetch(`${origin}/api/v1/profiles/coder/config`, "PATCH", {
    expectedRevision: REVISION,
    config: { model: "x" },
  });
  assert.equal(configRootRejected.status, 400);

  assert.deepEqual(calls.filter((call) => call.method.startsWith("set") || call.method.startsWith("update") || call.method.startsWith("reset")), [
    { method: "setSkillEnabled", args: ["coder", "local", false, true] },
    { method: "updateSkillContent", args: ["coder", "local", "safe", REVISION] },
    { method: "updateProfileSoul", args: ["coder", "identity", REVISION] },
    { method: "setMemoryProvider", args: ["coder", "honcho", "builtin"] },
    { method: "updateMemoryProviderConfig", args: ["coder", "honcho", { mode: "local" }, REVISION] },
    { method: "updateBuiltinMemoryFile", args: ["coder", "memory", "note", REVISION] },
    { method: "resetBuiltinMemory", args: ["coder", "user"] },
    { method: "updateProfileConfig", args: ["coder", { expectedRevision: REVISION, changes: { model: "anthropic/claude-opus-4" } }] },
  ]);
});

test("settings HTTP rejects unbounded/unknown input and secret routes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-http-settings-safe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const adapter = makeAdapter([]);
  let persistenceWrites = 0;
  const globalSettings = new OfficeGlobalSettingsStore(join(directory, "global.json"), {
    beforeWrite: async () => { persistenceWrites += 1; },
  });
  const server = createServer(async (request, response) => {
    const result = await routeSettingsHttp(request, new URL(request.url ?? "/", "http://office.local"), { settings: adapter, globalSettings }, 128);
    response.writeHead(result.status, { "Content-Type": "application/json", ...(result.headers ?? {}) });
    response.end(JSON.stringify(result.body));
  });
  const origin = await listen(server);
  t.after(() => server.close());

  const badReset = await jsonFetch(`${origin}/api/v1/profiles/coder/memory/reset`, "POST", { target: "bogus" });
  assert.equal(badReset.status, 400);
  const secret = await jsonFetch(`${origin}/api/v1/profiles/coder/memory/providers/honcho/secret`, "PUT", { apiKey: "hidden" });
  assert.equal(secret.status, 404);
  const extra = await jsonFetch(`${origin}/api/v1/profiles/coder/skills/local`, "PATCH", { enabled: true, expectedEnabled: false, token: "hidden" });
  assert.equal(extra.status, 400);
  const invalidType = await fetch(`${origin}/api/v1/settings/global`, { method: "PATCH", headers: { "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(invalidType.status, 415);
  const oversized = await fetch(`${origin}/api/v1/settings/global`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: 0, context: "x".repeat(500) }) });
  assert.equal(oversized.status, 413);

  const hiddenCredentials = [
    "\u001b]0;API_KEY=title-secret\u0007",
    "\u001b]8;;https://example.test/?token=uri-secret\u001b\\label",
    "\u009d0;Authorization: Bearer c1-secret-value\u009c",
    "API_KEY=\u001b[12345678m",
    "API\u001b]0;ignored\u0018_KEY=cancelled-secret\u0007",
  ];
  for (const context of hiddenCredentials) {
    const rejected = await jsonFetch(`${origin}/api/v1/settings/global`, "PATCH", { expectedRevision: 0, context });
    assert.equal(rejected.status, 400, context);
    assert.equal(JSON.stringify(rejected.body).includes(context), false, context);
  }
  assert.equal(persistenceWrites, 0, "rejected control sequences never reach the persistence boundary");
  const after = await fetch(`${origin}/api/v1/settings/global`);
  const serialized = await after.text();
  assert.equal(after.status, 200);
  assert.equal((JSON.parse(serialized) as { revision: number }).revision, 0);
  for (const secretValue of ["title-secret", "uri-secret", "c1-secret-value", "12345678", "cancelled-secret"]) {
    assert.equal(serialized.includes(secretValue), false);
  }
});

test("settings HTTP maps adapter conflict and failure to stable public errors", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-http-settings-errors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const adapter = makeAdapter([]);
  adapter.setSkillEnabled = async () => { throw new HermesSettingsError("conflict", "Hermes setting changed; refresh before saving."); };
  adapter.getMemoryStatus = async () => { throw new Error("/Users/private api_key=secret"); };
  const server = createServer(async (request, response) => {
    const result = await routeSettingsHttp(request, new URL(request.url ?? "/", "http://office.local"), { settings: adapter, globalSettings: new OfficeGlobalSettingsStore(join(directory, "global.json")) }, 4_096);
    response.writeHead(result.status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  const origin = await listen(server);
  t.after(() => server.close());

  const conflict = await jsonFetch(`${origin}/api/v1/profiles/coder/skills/local`, "PATCH", { enabled: false, expectedEnabled: true });
  assert.equal(conflict.status, 409);
  const failed = await fetch(`${origin}/api/v1/profiles/coder/memory`);
  assert.equal(failed.status, 502);
  const text = await failed.text();
  assert.equal(text.includes("/Users/private"), false);
  assert.equal(text.includes("api_key"), false);
});

test("profile skill override is persisted only after the Hermes mutation succeeds", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-http-skill-override-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OfficeGlobalSettingsStore(join(directory, "global.json"));
  const staged = await store.beginMaterialization({ expectedRevision: 0, skills: ["local"] });
  await store.finishMaterialization(staged.settings.revision, [{ profile: "coder", skill: "local" }], [], []);
  const adapter = makeAdapter([]);
  let failure: HermesSettingsError | undefined = new HermesSettingsError("conflict", "Hermes setting changed; refresh before saving.");
  adapter.setSkillEnabled = async () => {
    if (failure !== undefined) throw failure;
  };
  const inheritance = new GlobalInheritanceCoordinator({ store, settings: adapter, listProfiles: async () => ["coder"] });
  const server = createServer(async (request, response) => {
    const result = await routeSettingsHttp(
      request,
      new URL(request.url ?? "/", "http://office.local"),
      { settings: adapter, globalSettings: store, globalInheritance: inheritance },
      4_096,
    );
    response.writeHead(result.status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  const origin = await listen(server);
  t.after(() => server.close());

  const failed = await jsonFetch(`${origin}/api/v1/profiles/coder/skills/local`, "PATCH", { enabled: false, expectedEnabled: true });
  assert.equal(failed.status, 409);
  assert.deepEqual((await store.readMaterialization()).managedSkills, [{ profile: "coder", skill: "local" }]);
  assert.deepEqual((await store.readMaterialization()).skillOverrides, []);
  assert.equal((await store.readMaterialization()).pendingSkillOverrides.length, 0, "definite conflicts abort the intent");

  failure = undefined;
  const succeeded = await jsonFetch(`${origin}/api/v1/profiles/coder/skills/local`, "PATCH", { enabled: false, expectedEnabled: true });
  assert.equal(succeeded.status, 200);
  assert.deepEqual((await store.readMaterialization()).managedSkills, []);
  assert.deepEqual((await store.readMaterialization()).skillOverrides, [{ profile: "coder", skill: "local" }]);
  assert.deepEqual((await store.readMaterialization()).pendingSkillOverrides, []);
});

function makeAdapter(calls: Array<{ method: string; args: unknown[] }>): HermesSettingsAdapter {
  const record = <T>(method: string, value: T) => async (...args: unknown[]): Promise<T> => { calls.push({ method, args }); return value; };
  const skill = { name: "local", category: "custom", description: "Safe", enabled: true, provenance: "agent" as const, usage: 1 };
  const memory = { activeProvider: "builtin", providers: [{ name: "builtin", description: "Built-in", configured: true }], builtin: { memoryBytes: 1, userBytes: 0, hasMemory: true, hasUser: false } };
  const soul = { profile: "coder", content: "identity", exists: true, redacted: false, revision: REVISION };
  const config = { name: "honcho", label: "Honcho", fields: [], revision: REVISION };
  const memoryFile = { key: "memory" as const, content: "note", exists: true, bytes: 4, revision: REVISION };
  const userFile = { key: "user" as const, content: "", exists: false, bytes: 0, revision: REVISION };
  const files = { profile: "coder", memory: memoryFile, user: userFile };
  return {
    getProfileSettings: record("getProfileSettings", { profile: "coder", skills: [skill], memory, soul }),
    listSkills: record("listSkills", [skill]),
    setSkillEnabled: record("setSkillEnabled", undefined),
    getSkillContent: record("getSkillContent", { name: "local", content: "safe", redacted: false, revision: REVISION }),
    updateSkillContent: record("updateSkillContent", { name: "local", content: "safe", redacted: false, revision: REVISION }),
    getMemoryStatus: record("getMemoryStatus", memory),
    setMemoryProvider: record("setMemoryProvider", { ...memory, activeProvider: "honcho" }),
    getMemoryProviderConfig: record("getMemoryProviderConfig", config),
    updateMemoryProviderConfig: record("updateMemoryProviderConfig", config),
    getBuiltinMemoryFiles: record("getBuiltinMemoryFiles", files),
    updateBuiltinMemoryFile: record("updateBuiltinMemoryFile", memoryFile),
    resetBuiltinMemory: record("resetBuiltinMemory", { files, status: memory }),
    getProfileSoul: record("getProfileSoul", soul),
    updateProfileSoul: record("updateProfileSoul", soul),
    getProfileConfigSchema: record("getProfileConfigSchema", {
      profile: "coder",
      categories: ["general"],
      fields: [{ id: "model", category: "general", type: "string", description: "Default model", options: [] }],
      excludedCount: 2,
    }),
    getProfileConfig: record("getProfileConfig", {
      profile: "coder",
      revision: REVISION,
      categories: ["general"],
      fields: [{ id: "model", category: "general", type: "string", description: "Default model", options: [] }],
      values: { model: "anthropic/claude-sonnet-4" },
      excludedCount: 2,
    }),
    updateProfileConfig: record("updateProfileConfig", {
      profile: "coder",
      revision: "b".repeat(43),
      categories: ["general"],
      fields: [{ id: "model", category: "general", type: "string", description: "Default model", options: [] }],
      values: { model: "anthropic/claude-opus-4" },
      excludedCount: 2,
    }),
    getPrivilegedProfileConfig: record("getPrivilegedProfileConfig", {
      profile: "coder",
      revision: REVISION,
      categories: ["terminal"],
      fields: [{
        id: "terminal.timeout",
        category: "terminal",
        type: "number",
        description: "Terminal timeout",
        options: [],
        impact: "restart",
        requiresConfirmation: true,
      }],
      values: { "terminal.timeout": 30 },
      unsupportedCount: 0,
      secretFieldCount: 1,
    }),
    updatePrivilegedProfileConfig: record("updatePrivilegedProfileConfig", {
      profile: "coder",
      revision: "b".repeat(43),
      categories: ["terminal"],
      fields: [{
        id: "terminal.timeout",
        category: "terminal",
        type: "number",
        description: "Terminal timeout",
        options: [],
        impact: "restart",
        requiresConfirmation: true,
      }],
      values: { "terminal.timeout": 60 },
      unsupportedCount: 0,
      secretFieldCount: 1,
    }),
    listProfileSecrets: record("listProfileSecrets", {
      profile: "coder",
      revision: REVISION,
      fields: [
        {
          key: "OPENAI_API_KEY",
          source: "env",
          label: "OpenAI",
          description: "API key",
          category: "provider",
          isSet: true,
          isPassword: true,
          canClear: true,
        },
        {
          key: "api_key",
          source: "memory-provider",
          label: "API key",
          description: "Hindsight key",
          category: "memory-provider",
          isSet: false,
          isPassword: true,
          canClear: false,
          provider: "hindsight",
          providerLabel: "Hindsight",
        },
      ],
    }),
    writeProfileSecret: record("writeProfileSecret", {
      profile: "coder",
      revision: "b".repeat(43),
      fields: [{
        key: "api_key",
        source: "memory-provider",
        label: "API key",
        description: "Hindsight key",
        category: "memory-provider",
        isSet: true,
        isPassword: true,
        canClear: true,
        provider: "hindsight",
        providerLabel: "Hindsight",
      }],
    }),
  } as HermesSettingsAdapter;
}

test("profile projects routes proxy the official Hermes projects adapter", async (t) => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = <T>(method: string, value: T) => async (...args: unknown[]): Promise<T> => { calls.push({ method, args }); return value; };
  const project = {
    id: "p1",
    slug: "web",
    name: "Web",
    description: null,
    icon: null,
    color: null,
    boardSlug: null,
    primaryPath: "/repo",
    archived: false,
    createdAt: 1,
    folders: [{ path: "/repo", label: null, isPrimary: true, addedAt: 1 }],
  };
  const projects = {
    listProjects: record("listProjects", { projects: [project], activeId: null }),
    createProject: record("createProject", { project }),
    updateProject: record("updateProject", { project }),
    deleteProject: record("deleteProject", { projects: [], activeId: null }),
    addFolder: record("addFolder", { project }),
    removeFolder: record("removeFolder", { project }),
  };
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-http-projects-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createServer(async (request, response) => {
    const result = await routeSettingsHttp(
      request,
      new URL(request.url ?? "/", "http://office.local"),
      {
        settings: makeAdapter([]),
        globalSettings: new OfficeGlobalSettingsStore(join(directory, "global.json")),
        projects,
      },
      4_096,
    );
    response.writeHead(result.status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  const origin = await listen(server);
  t.after(() => server.close());

  const listed = await jsonFetch(`${origin}/api/v1/profiles/coder/projects`, "GET", undefined);
  assert.equal(listed.status, 200);
  assert.equal((listed.body as { projects: unknown[] }).projects.length, 1);

  const created = await jsonFetch(`${origin}/api/v1/profiles/coder/projects`, "POST", { name: "Web", path: "/repo", isPrimary: true });
  assert.equal(created.status, 200);
  assert.deepEqual(calls.at(-1), { method: "createProject", args: ["coder", { name: "Web", path: "/repo", isPrimary: true }] });

  const renamed = await jsonFetch(`${origin}/api/v1/profiles/coder/projects/p1`, "PATCH", { name: "Web 2" });
  assert.equal(renamed.status, 200);
  assert.deepEqual(calls.at(-1), { method: "updateProject", args: ["coder", "p1", { name: "Web 2" }] });

  const added = await jsonFetch(`${origin}/api/v1/profiles/coder/projects/p1/folders`, "POST", { path: "/repo2" });
  assert.equal(added.status, 200);
  assert.deepEqual(calls.at(-1), { method: "addFolder", args: ["coder", "p1", { path: "/repo2" }] });

  const unbound = await jsonFetch(`${origin}/api/v1/profiles/coder/projects/p1/folders`, "DELETE", { path: "/repo2" });
  assert.equal(unbound.status, 200);
  assert.deepEqual(calls.at(-1), { method: "removeFolder", args: ["coder", "p1", "/repo2"] });

  const deleted = await jsonFetch(`${origin}/api/v1/profiles/coder/projects/p1`, "DELETE", undefined);
  assert.equal(deleted.status, 200);
  assert.deepEqual(calls.at(-1), { method: "deleteProject", args: ["coder", "p1"] });

  const invalid = await jsonFetch(`${origin}/api/v1/profiles/coder/projects`, "POST", { name: "Web", bogus: true });
  assert.equal(invalid.status, 400);

  const missingName = await jsonFetch(`${origin}/api/v1/profiles/coder/projects`, "POST", { path: "/repo" });
  assert.equal(missingName.status, 400);
});

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function jsonFetch(url: string, method: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as unknown };
}

test("privileged config and secrets require desktop capability and never leak secret bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-http-privileged-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const adapter = makeAdapter(calls);
  const globalSettings = new OfficeGlobalSettingsStore(join(directory, "global.json"));
  const secretTransfers = new SecretTransferStore({ ttlMs: 30_000, maxPending: 4 });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://office.local");
    // Ordinary browser session (no desktop capability) unless path sets the flag.
    const desktop = url.searchParams.get("desktop") === "1";
    const result = await routeSettingsHttp(
      request,
      url,
      {
        settings: adapter,
        globalSettings,
        secretTransfers,
        privilegedOwnerSession: desktop,
      },
      16 * 1024,
    );
    response.writeHead(result.status, { "Content-Type": "application/json", ...(result.headers ?? {}) });
    response.end(JSON.stringify(result.body));
  });
  const origin = await listen(server);
  t.after(() => server.close());

  assert.equal((await fetch(`${origin}/api/v1/profiles/coder/privileged-config`)).status, 403);
  assert.equal((await fetch(`${origin}/api/v1/profiles/coder/secrets`)).status, 403);
  assert.equal((await jsonFetch(`${origin}/api/v1/secret-transfers`, "POST", { value: "x" })).status, 403);

  const privileged = await fetch(`${origin}/api/v1/profiles/coder/privileged-config?desktop=1`);
  assert.equal(privileged.status, 200);
  const privilegedBody = await privileged.json() as { values: Record<string, unknown>; secretFieldCount: number };
  assert.equal(privilegedBody.values["terminal.timeout"], 30);
  assert.equal(JSON.stringify(privilegedBody).includes("sk-"), false);

  const secrets = await fetch(`${origin}/api/v1/profiles/coder/secrets?desktop=1`);
  assert.equal(secrets.status, 200);
  const secretsBody = await secrets.json() as { fields: Array<Record<string, unknown>> };
  assert.equal(secretsBody.fields[0]?.isSet, true);
  assert.equal("value" in (secretsBody.fields[0] ?? {}), false);
  assert.equal(JSON.stringify(secretsBody).includes("sk-"), false);

  const deposit = await jsonFetch(`${origin}/api/v1/secret-transfers?desktop=1`, "POST", { value: "native-only-secret" });
  assert.equal(deposit.status, 200);
  const transferId = (deposit.body as { transferId: string }).transferId;
  assert.equal(typeof transferId, "string");
  assert.equal(JSON.stringify(deposit.body).includes("native-only-secret"), false);

  const consume = await jsonFetch(`${origin}/api/v1/profiles/coder/secrets?desktop=1`, "POST", {
    transferId,
    key: "OPENAI_API_KEY",
    source: "env",
    expectedRevision: REVISION,
  });
  assert.equal(consume.status, 200);
  assert.equal(JSON.stringify(consume.body).includes("native-only-secret"), false);

  const replay = await jsonFetch(`${origin}/api/v1/profiles/coder/secrets?desktop=1`, "POST", {
    transferId,
    key: "OPENAI_API_KEY",
    source: "env",
  });
  assert.equal(replay.status, 404);

  const writeCall = calls.find((call) => call.method === "writeProfileSecret");
  assert.ok(writeCall);
  // Adapter receives secret only after one-shot consume — never from browser JSON value field.
  assert.equal((writeCall!.args[1] as { value: string }).value, "native-only-secret");
  assert.equal((writeCall!.args[1] as { key: string }).key, "OPENAI_API_KEY");

  // Memory-provider secret: transferId + provider + key only on the browser wire.
  const memDeposit = await jsonFetch(`${origin}/api/v1/secret-transfers?desktop=1`, "POST", { value: "hindsight-secret" });
  assert.equal(memDeposit.status, 200);
  const memTransferId = (memDeposit.body as { transferId: string }).transferId;
  const memConsume = await jsonFetch(`${origin}/api/v1/profiles/coder/secrets?desktop=1`, "POST", {
    transferId: memTransferId,
    key: "api_key",
    source: "memory-provider",
    provider: "hindsight",
    expectedRevision: REVISION,
  });
  assert.equal(memConsume.status, 200);
  const memBody = JSON.stringify(memConsume.body);
  assert.equal(memBody.includes("hindsight-secret"), false);
  // Response DTO may include field metadata for UI reload; never secret values.
  assert.equal(memBody.includes("value"), false);
  const memWrite = calls.filter((call) => call.method === "writeProfileSecret").at(-1);
  assert.ok(memWrite);
  assert.deepEqual(memWrite!.args[1], {
    key: "api_key",
    source: "memory-provider",
    value: "hindsight-secret",
    provider: "hindsight",
    expectedRevision: REVISION,
  });

  // Reject memory-provider writes without a validated provider id.
  const badDeposit = await jsonFetch(`${origin}/api/v1/secret-transfers?desktop=1`, "POST", { value: "x" });
  const badTransfer = (badDeposit.body as { transferId: string }).transferId;
  const missingProvider = await jsonFetch(`${origin}/api/v1/profiles/coder/secrets?desktop=1`, "POST", {
    transferId: badTransfer,
    key: "api_key",
    source: "memory-provider",
  });
  assert.equal(missingProvider.status, 400);

  // Clear/unset: empty-string deposit + consume still never returns secret material.
  const clearDeposit = await jsonFetch(`${origin}/api/v1/secret-transfers?desktop=1`, "POST", { value: "" });
  assert.equal(clearDeposit.status, 200);
  const clearId = (clearDeposit.body as { transferId: string }).transferId;
  const clearConsume = await jsonFetch(`${origin}/api/v1/profiles/coder/secrets?desktop=1`, "POST", {
    transferId: clearId,
    key: "OPENAI_API_KEY",
    source: "env",
    expectedRevision: REVISION,
  });
  assert.equal(clearConsume.status, 200);
  assert.equal(JSON.stringify(clearConsume.body).includes("value"), false);
  const clearWrite = calls.filter((call) => call.method === "writeProfileSecret").at(-1);
  assert.ok(clearWrite);
  assert.equal((clearWrite!.args[1] as { value: string }).value, "");
  assert.equal((clearWrite!.args[1] as { key: string }).key, "OPENAI_API_KEY");
});
