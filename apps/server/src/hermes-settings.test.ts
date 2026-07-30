import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createHermesSettingsAdapter,
  HermesSettingsError,
  OfficeGlobalSettingsStore,
} from "./hermes-settings.js";

const TOKEN = "0123456789abcdef0123456789abcdef"; // gitleaks:allow -- synthetic test credential
const DASHBOARD_SECRET = "dashboard-example-value-123456"; // gitleaks:allow -- synthetic test credential
const OPENAI_SECRET = "openai-example-value-123456"; // gitleaks:allow -- synthetic test credential
const AWS_SECRET = "aws-example-value-123456"; // gitleaks:allow -- synthetic test credential
const PASSWORD_SECRET = "password-example-value-123456"; // gitleaks:allow -- synthetic test credential
const ANTHROPIC_SECRET = "sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"; // gitleaks:allow -- synthetic test credential
const AUTH_HEADER_SECRET = "opaque-settings-credential"; // gitleaks:allow -- synthetic test credential
const DATABASE_SECRET = "database-password-example-value"; // gitleaks:allow -- synthetic test credential

test("profile settings use a profile-pinned backend and expose secret-safe DTOs", async (t) => {
  const requests: Array<{ method: string; token: string; url: string }> = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? "", token: String(request.headers["x-hermes-session-token"] ?? ""), url: request.url ?? "" });
    if (request.url === "/api/skills") {
      writeJson(response, [
        { name: "browser", category: "tools", description: "Browse safely", enabled: true, provenance: "bundled", usage: 3, path: "/Users/private/skills" },
        { name: "local", category: `CATEGORY_TOKEN=${OPENAI_SECRET}`, description: `HERMES_DASHBOARD_SESSION_TOKEN=${DASHBOARD_SECRET}`, enabled: false, provenance: "agent", api_key: "hidden" },
      ]);
      return;
    }
    if (request.url === "/api/memory") {
      writeJson(response, {
        active: "builtin",
        providers: [{ name: "builtin", description: `Built in; ${ANTHROPIC_SECRET}; AWS_SECRET_ACCESS_KEY = \"${AWS_SECRET}\"\nAuthorization: Token ${AUTH_HEADER_SECRET}\npostgresql://alice:${DATABASE_SECRET}@example.test/app`, configured: true, config_path: "/private/config" }],
        builtin_files: { memory: 40, user: 12, path: "/private/memories" },
        credential: "hidden",
      });
      return;
    }
    if (request.url === "/api/profiles/coder/soul") {
      writeJson(response, { content: `Helpful agent\nOPENAI_API_KEY = '${OPENAI_SECRET}'`, exists: true, path: "/private/SOUL.md" });
      return;
    }
    response.writeHead(404).end();
  });
  const origin = await listen(server);
  t.after(() => server.close());
  const resolved: string[] = [];
  let releases = 0;
  const adapter = createHermesSettingsAdapter({
    resolveProfileBackend: async (profile) => {
      resolved.push(profile);
      return { baseUrl: origin, sessionToken: TOKEN, release: () => { releases += 1; } };
    },
  });

  const settings = await adapter.getProfileSettings("coder");

  assert.deepEqual(resolved, ["coder"]);
  assert.deepEqual(requests.map((item) => item.url).sort(), ["/api/memory", "/api/profiles/coder/soul", "/api/skills"]);
  assert.equal(requests.every((item) => item.token === TOKEN), true);
  assert.equal(settings.skills[0]?.name, "browser");
  assert.equal(settings.skills[1]?.category, "CATEGORY_TOKEN=[REDACTED]");
  assert.equal(settings.skills[1]?.description, "HERMES_DASHBOARD_SESSION_TOKEN=[REDACTED]");
  assert.deepEqual(settings.memory.builtin, { memoryBytes: 40, userBytes: 12, hasMemory: true, hasUser: true });
  assert.equal(settings.memory.providers[0]?.description, 'Built in; [REDACTED]; AWS_SECRET_ACCESS_KEY = "[REDACTED]"\nAuthorization: [REDACTED]\npostgresql://[REDACTED]:[REDACTED]@example.test/app');
  assert.equal(settings.soul.content, "Helpful agent\nOPENAI_API_KEY = '[REDACTED]'");
  assert.equal(settings.soul.redacted, true);
  const serialized = JSON.stringify(settings);
  assert.equal(serialized.includes("/private"), false);
  assert.equal(serialized.includes("supersecretvalue"), false);
  assert.equal(serialized.includes("hidden"), false);
  for (const secret of [DASHBOARD_SECRET, OPENAI_SECRET, AWS_SECRET, ANTHROPIC_SECRET, AUTH_HEADER_SECRET, DATABASE_SECRET]) assert.equal(serialized.includes(secret), false);
  assert.equal(releases, 1, "one multi-request operation holds exactly one lease");

  await assert.rejects(adapter.getProfileSoul("other"), (error: unknown) => error instanceof HermesSettingsError);
  assert.equal(releases, 2, "failed operations release their lease in finally");
});

test("skill and memory mutations are validated and use official Hermes routes", async (t) => {
  const memoryRoot = await mkdtemp(join(tmpdir(), "hermes-studio-settings-mutation-memory-"));
  t.after(() => rm(memoryRoot, { recursive: true, force: true }));
  const mutations: Array<{ body: unknown; method: string; url: string }> = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/api/memory/providers/honcho/config?surface=declared") {
      writeJson(response, {
        name: "honcho",
        label: `PROVIDER_TOKEN=${DASHBOARD_SECRET}`,
        fields: [
          {
            key: "mode",
            label: `FIELD_TOKEN=${OPENAI_SECRET}`,
            kind: "select",
            description: `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`,
            value: "local",
            is_set: true,
            options: [
              { value: "local", label: `LABEL_TOKEN=${PASSWORD_SECRET}`, description: `OPTION_TOKEN=${OPENAI_SECRET}` },
              { value: `VALUE_TOKEN=${DASHBOARD_SECRET}`, label: "Must be removed", description: "Unsafe value" },
            ],
          },
          { key: "endpoint", label: "Endpoint", kind: "text", description: "Non-secret field", value: "password=short7", is_set: true, options: [] },
          { key: "api_key", label: `SECRET_LABEL_TOKEN=${DASHBOARD_SECRET}`, kind: "text", description: "Misclassified credential", value: "sk-exampleopaquevalue", is_set: true, options: [{ value: "opaque-option", label: "Must not be writable" }] },
          { key: "future", label: "Unknown field", kind: "password", description: "Must fail closed", value: "opaquecredentialvalue", is_set: true, options: [] },
        ],
      });
      return;
    }
    if (request.method === "GET" && request.url === "/api/skills/content?name=local") {
      writeJson(response, { name: "local", content: `# Skill\ndatabase_password: >-\n  ${PASSWORD_SECRET}\n  second secret line\nsafe: visible`, path: "/private/SKILL.md" });
      return;
    }
    if (request.method === "GET" && request.url === "/api/memory") {
      writeJson(response, {
        active_provider: "honcho",
        providers: [{ name: "honcho", description: "Configured", configured: true }],
        builtin: { memory_bytes: 0, user_bytes: 0, has_memory: false, has_user: false },
      });
      return;
    }
    if (request.method === "GET" && request.url === "/api/profiles/coder/soul") {
      writeJson(response, { content: "You are a careful coding agent.", exists: true });
      return;
    }
    mutations.push({ method: request.method ?? "", url: request.url ?? "", body: await readJson(request) });
    writeJson(response, { ok: true, path: "/private/result", secret: "hidden" });
  });
  const origin = await listen(server);
  t.after(() => server.close());
  const adapter = createHermesSettingsAdapter({
    resolveProfileBackend: async () => ({ baseUrl: origin, sessionToken: TOKEN, release: () => undefined }),
    builtinMemoryFiles: { hermesRoot: memoryRoot, resolveProfileHome: () => memoryRoot },
  });

  const content = await adapter.getSkillContent("coder", "local");
  assert.equal(content.name, "local");
  assert.equal(content.content, "# Skill\ndatabase_password: [REDACTED]\nsafe: visible");
  assert.equal(content.redacted, true);
  assert.match(content.revision, /^[A-Za-z0-9_-]{43}$/);
  const config = await adapter.getMemoryProviderConfig("coder", "honcho");
  assert.equal(config.label, "PROVIDER_TOKEN=[REDACTED]");
  assert.equal(config.fields[0]?.value, "local");
  assert.equal(config.fields[0]?.label, "FIELD_TOKEN=[REDACTED]");
  assert.equal(config.fields[0]?.description, "AWS_SECRET_ACCESS_KEY=[REDACTED]");
  assert.deepEqual(config.fields[0]?.options, [{ value: "local", label: "LABEL_TOKEN=[REDACTED]", description: "OPTION_TOKEN=[REDACTED]" }]);
  const endpoint = config.fields.find((field) => field.key === "endpoint");
  assert.equal(endpoint?.kind, "text");
  assert.equal("value" in (endpoint ?? {}), false, "redacted values must not become writable placeholders");
  const secretField = config.fields.find((field) => field.key === "api_key");
  assert.equal(secretField?.label, "SECRET_LABEL_TOKEN=[REDACTED]");
  assert.equal(secretField?.kind, "secret", "sensitive keys fail closed even when Hermes misclassifies the kind");
  assert.equal("value" in (secretField ?? {}), false);
  assert.deepEqual(secretField?.options, []);
  assert.equal(config.fields.some((field) => field.key === "future"), false, "unknown field kinds are dropped");
  const serializedConfig = JSON.stringify(config);
  for (const secret of [DASHBOARD_SECRET, OPENAI_SECRET, AWS_SECRET, PASSWORD_SECRET]) assert.equal(serializedConfig.includes(secret), false);

  await adapter.setSkillEnabled("coder", "local", false);
  await adapter.updateSkillContent("coder", "local", "---\nname: local\n---\nSafe instructions");
  await adapter.setMemoryProvider("coder", "honcho");
  await adapter.updateMemoryProviderConfig("coder", "honcho", { mode: "local" });
  await adapter.resetBuiltinMemory("coder", "user");
  await adapter.updateProfileSoul("coder", "You are a careful coding agent.");

  assert.deepEqual(mutations, [
    { method: "PUT", url: "/api/skills/toggle", body: { name: "local", enabled: false } },
    { method: "PUT", url: "/api/skills/content", body: { name: "local", content: "---\nname: local\n---\nSafe instructions" } },
    { method: "PUT", url: "/api/memory/provider", body: { provider: "honcho" } },
    { method: "PUT", url: "/api/memory/providers/honcho/config?surface=declared", body: { values: { mode: "local" } } },
    { method: "POST", url: "/api/memory/reset", body: { target: "user" } },
    { method: "PUT", url: "/api/profiles/coder/soul", body: { content: "You are a careful coding agent." } },
  ]);

  await assert.rejects(
    adapter.updateMemoryProviderConfig("coder", "honcho", { api_key: "supersecretvalue" }),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "invalid_request",
  );
  await assert.rejects(
    adapter.updateSkillContent("coder", "local", `HERMES_DASHBOARD_SESSION_TOKEN = \"${DASHBOARD_SECRET}\"`),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "invalid_request",
  );
  await assert.rejects(
    adapter.updateSkillContent("coder", "local", "note: password=x"),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "invalid_request",
  );
  await assert.rejects(
    adapter.updateProfileSoul("coder", "Authorization: Basic dXNlcjpwYXNz"),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "invalid_request",
  );
  await assert.rejects(
    adapter.updateProfileSoul("coder", "See https://operator:tiny@example.test/private"),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "invalid_request",
  );
  await assert.rejects(
    adapter.updateProfileSoul("coder", "Standalone ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "invalid_request",
  );
  await assert.rejects(
    adapter.updateProfileSoul("coder", "password: >\n  correct horse battery staple\nsafe: visible"),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "invalid_request",
  );
  await assert.rejects(
    adapter.updateProfileSoul("coder", "Cookie: hermes_office_session=office-cookie-value"),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "invalid_request",
  );
  await assert.rejects(
    adapter.updateMemoryProviderConfig("coder", "honcho", { mode: `aws_secret_access_key = '${AWS_SECRET}'` }),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "invalid_request",
  );
  await assert.rejects(
    adapter.updateProfileSoul("coder", `profile_password = ${PASSWORD_SECRET}`),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "invalid_request",
  );
  await assert.rejects(
    adapter.updateProfileSoul("../escape", "safe"),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "invalid_request",
  );
});

test("profile compare-and-write mutations serialize by resource and reject one stale concurrent writer", async (t) => {
  let skillContent = "initial skill";
  let soulContent = "initial soul";
  let activeProvider = "builtin";
  let providerMode = "local";
  const writes = new Map<string, number>();
  const server = createServer(async (request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url === "/api/skills/content?name=local") {
      writeJson(response, { content: skillContent });
      return;
    }
    if (request.method === "PUT" && url === "/api/skills/content") {
      const body = await readJson(request) as { content: string };
      await delayedWrite();
      skillContent = body.content;
      countWrite(writes, url);
      writeJson(response, { ok: true });
      return;
    }
    if (request.method === "GET" && url === "/api/profiles/coder/soul") {
      writeJson(response, { content: soulContent, exists: true });
      return;
    }
    if (request.method === "PUT" && url === "/api/profiles/coder/soul") {
      const body = await readJson(request) as { content: string };
      await delayedWrite();
      soulContent = body.content;
      countWrite(writes, url);
      writeJson(response, { ok: true });
      return;
    }
    if (request.method === "GET" && url === "/api/memory") {
      writeJson(response, { active: activeProvider, providers: [], builtin_files: {} });
      return;
    }
    if (request.method === "PUT" && url === "/api/memory/provider") {
      const body = await readJson(request) as { provider: string };
      await delayedWrite();
      activeProvider = body.provider;
      countWrite(writes, url);
      writeJson(response, { ok: true });
      return;
    }
    if (request.method === "GET" && url === "/api/memory/providers/honcho/config?surface=declared") {
      writeJson(response, { name: "honcho", label: "Honcho", fields: [{ key: "mode", kind: "text", value: providerMode, is_set: true }] });
      return;
    }
    if (request.method === "PUT" && url === "/api/memory/providers/honcho/config?surface=declared") {
      const body = await readJson(request) as { values: { mode: string } };
      await delayedWrite();
      providerMode = body.values.mode;
      countWrite(writes, url);
      writeJson(response, { ok: true });
      return;
    }
    response.writeHead(404).end();
  });
  const origin = await listen(server);
  t.after(() => server.close());
  const adapter = createHermesSettingsAdapter({
    resolveProfileBackend: async () => ({ baseUrl: origin, sessionToken: TOKEN, release: () => undefined }),
  });

  const skillRevision = (await adapter.getSkillContent("coder", "local")).revision;
  await assertOneConflict([
    adapter.updateSkillContent("coder", "local", "first skill", skillRevision),
    adapter.updateSkillContent("coder", "local", "second skill", skillRevision),
  ]);
  assert.equal(writes.get("/api/skills/content"), 1);

  const soulRevision = (await adapter.getProfileSoul("coder")).revision;
  await assertOneConflict([
    adapter.updateProfileSoul("coder", "first soul", soulRevision),
    adapter.updateProfileSoul("coder", "second soul", soulRevision),
  ]);
  assert.equal(writes.get("/api/profiles/coder/soul"), 1);

  const configRevision = (await adapter.getMemoryProviderConfig("coder", "honcho")).revision;
  await assertOneConflict([
    adapter.updateMemoryProviderConfig("coder", "honcho", { mode: "first" }, configRevision),
    adapter.updateMemoryProviderConfig("coder", "honcho", { mode: "second" }, configRevision),
  ]);
  assert.equal(writes.get("/api/memory/providers/honcho/config?surface=declared"), 1);

  await assertOneConflict([
    adapter.setMemoryProvider("coder", "honcho", "builtin"),
    adapter.setMemoryProvider("coder", "remote", "builtin"),
  ]);
  assert.equal(writes.get("/api/memory/provider"), 1);
});

test("global settings are Office-owned, atomic, revisioned, and reject secret material", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "global.json");
  const store = new OfficeGlobalSettingsStore(file);

  const initial = await store.read();
  assert.deepEqual(initial, {
    revision: 0,
    sharedSkillsEnabled: true,
    sharedContextEnabled: true,
    skills: [],
    context: "",
    updatedAt: "1970-01-01T00:00:00.000Z",
    skillSync: { state: "ready", failures: [] },
  });
  const saved = await store.update({
    expectedRevision: 0,
    skills: ["browser", "coding"],
    context: "Prefer concise status reports.",
  });
  assert.equal(saved.revision, 1);
  assert.deepEqual((await store.read()).skills, ["browser", "coding"]);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), saved);

  await assert.rejects(
    store.update({ expectedRevision: 0, context: "stale" }),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "conflict",
  );
  await assert.rejects(
    store.update({ expectedRevision: 1, context: `openai_api_key = '${OPENAI_SECRET}'` }),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "invalid_request",
  );
  assert.equal((await store.read()).revision, 1);
});

test("global store serializes concurrent updates and admits only one matching revision", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-settings-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OfficeGlobalSettingsStore(join(directory, "global.json"));
  const results = await Promise.allSettled([
    store.update({ expectedRevision: 0, context: "first" }),
    store.update({ expectedRevision: 0, context: "second" }),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  assert.equal((await store.read()).revision, 1);
});

test("profile Hermes config picks safe leaves, denies secrets, and conflicts on stale revision", async (t) => {
  let config: Record<string, unknown> = {
    model: "anthropic/claude-sonnet-4",
    agent: { max_turns: 10 },
    display: { compact: false },
    memory: { memory_char_limit: 4_000, write_approval: true },
    security: { allow_private_urls: true },
    auxiliary: { vision: { api_key: "sk-should-not-leak" } }, // gitleaks:allow -- synthetic rejection fixture
  };
  const schemaPayload = {
    category_order: ["general", "agent", "display", "memory", "security"],
    fields: {
      model: { type: "string", description: "Model", category: "general" },
      "agent.max_turns": { type: "number", description: "Turns", category: "agent" },
      "display.compact": { type: "boolean", description: "Compact", category: "display" },
      "memory.memory_char_limit": { type: "number", description: "Chars", category: "memory" },
      "memory.write_approval": { type: "boolean", description: "Approval", category: "memory" },
      "security.allow_private_urls": { type: "boolean", description: "Danger", category: "security" },
      "auxiliary.vision.api_key": { type: "string", description: "Secret", category: "auxiliary" },
    },
  };
  const puts: unknown[] = [];
  const server = createServer(async (request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url === "/api/config/schema") {
      writeJson(response, schemaPayload);
      return;
    }
    if (request.method === "GET" && url === "/api/config") {
      writeJson(response, config);
      return;
    }
    if (request.method === "PUT" && url === "/api/config") {
      const body = await readJson(request) as { config: Record<string, unknown> };
      puts.push(body.config);
      // Deep-merge like Hermes.
      config = {
        ...config,
        ...body.config,
        agent: { ...(config.agent as object), ...((body.config.agent as object) ?? {}) },
        display: { ...(config.display as object), ...((body.config.display as object) ?? {}) },
      };
      writeJson(response, { ok: true });
      return;
    }
    response.writeHead(404).end();
  });
  const origin = await listen(server);
  t.after(() => server.close());
  const adapter = createHermesSettingsAdapter({
    resolveProfileBackend: async () => ({ baseUrl: origin, sessionToken: TOKEN, release: () => undefined }),
  });

  const schema = await adapter.getProfileConfigSchema("coder");
  assert.equal(schema.profile, "coder");
  assert.ok(schema.fields.some((field) => field.id === "agent.max_turns"));
  assert.ok(!schema.fields.some((field) => field.id === "model"));
  assert.ok(!schema.fields.some((field) => field.id === "memory.write_approval"));
  assert.ok(!schema.fields.some((field) => field.id === "security.allow_private_urls"));
  assert.ok(!schema.fields.some((field) => field.id === "auxiliary.vision.api_key"));
  assert.ok(schema.excludedCount >= 2);

  const current = await adapter.getProfileConfig("coder");
  assert.equal(Object.hasOwn(current.values, "model"), false);
  assert.equal(current.values["agent.max_turns"], 10);
  assert.equal(current.values["memory.memory_char_limit"], 4_000);
  assert.equal(Object.hasOwn(current.values, "memory.write_approval"), false);
  assert.equal(Object.hasOwn(current.values, "security.allow_private_urls"), false);
  assert.equal(Object.hasOwn(current.values, "auxiliary.vision.api_key"), false);
  assert.match(current.revision, /^[A-Za-z0-9_-]{43}$/);

  const updated = await adapter.updateProfileConfig("coder", {
    expectedRevision: current.revision,
    changes: { "display.compact": true, "agent.max_turns": 20 },
  });
  assert.equal(updated.values["display.compact"], true);
  assert.equal(updated.values["agent.max_turns"], 20);
  assert.deepEqual(puts[0], { agent: { max_turns: 20 }, display: { compact: true } });

  await assert.rejects(
    adapter.updateProfileConfig("coder", {
      expectedRevision: current.revision,
      changes: { "display.compact": false },
    }),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "conflict",
  );
  await assert.rejects(
    adapter.updateProfileConfig("coder", {
      expectedRevision: updated.revision,
      changes: { "security.allow_private_urls": true },
    }),
    (error: unknown) => error instanceof HermesSettingsError && error.code === "invalid_request",
  );
});

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response: ServerResponse<IncomingMessage>, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

async function delayedWrite(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

function countWrite(writes: Map<string, number>, path: string): void {
  writes.set(path, (writes.get(path) ?? 0) + 1);
}

async function assertOneConflict<T>(operations: [Promise<T>, Promise<T>]): Promise<void> {
  const results = await Promise.allSettled(operations);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.reason instanceof HermesSettingsError && rejected[0].reason.code === "conflict", true);
}
