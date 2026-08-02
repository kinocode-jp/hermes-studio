import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import type { HermesSettingsAdapter } from "./hermes-settings.js";
import { OfficeGlobalSettingsStore } from "./hermes-settings.js";
import { createStudioServer } from "./server.js";
import { createDemoSnapshot, createDemoRuntimeStatus } from "./demo-state.js";
import { settingsOperation } from "./server-http.js";
import { OPERATION_POLICIES } from "@hermes-studio/protocol";

const REVISION = "a".repeat(43);

test("Studio Server settings API requires authentication and CSRF on writes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-settings-server-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const global = new OfficeGlobalSettingsStore(join(directory, "global.json"));
  let selectedProvider = "builtin";
  const resetCalls: Array<{ profile: string; target: "all" | "memory" | "user" }> = [];
  const settings = makeSettingsAdapter(
    () => selectedProvider,
    (provider) => { selectedProvider = provider; },
    resetCalls,
  );
  const runtime: HermesRuntimeSource = {
    status: createDemoRuntimeStatus,
    snapshot: async () => createDemoSnapshot(),
    close: async () => undefined,
    chat: () => { throw new Error("unused"); },
    kanban: () => { throw new Error("unused"); },
    settings: () => settings,
    globalSettings: () => global,
  };
  const server = createStudioServer({
    port: 0,
    runtimeSource: runtime,
    allowedOrigins: ["http://localhost:4173"],
    chatModelPreferencesPath: join(directory, "chat-model-preferences.json"),
  });
  const address = await server.listen();
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${address.port}`;
  const browserOrigin = "http://localhost:4173";

  const unauthenticated = await fetch(`${origin}/api/v1/settings/global`, { headers: { Origin: browserOrigin } });
  assert.equal(unauthenticated.status, 401);

  const bootstrap = await fetch(`${origin}/api/v1/auth/local`, { method: "POST", headers: { Origin: browserOrigin } });
  assert.equal(bootstrap.status, 200);
  const session = await bootstrap.json() as { csrfToken: string };
  const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";")[0]!;

  const emptyModelPreferences = await fetch(`${origin}/api/v1/settings/chat-model-preferences`, {
    headers: { Origin: browserOrigin, Cookie: cookie },
  });
  assert.equal(emptyModelPreferences.status, 200);
  assert.equal((await emptyModelPreferences.json() as { revision: number }).revision, 0);

  const modelDocument = {
    main: { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "high" },
    sub: { provider: "", model: "", reasoningEffort: "" },
    presets: [],
  };
  const modelPreferencesWithoutCsrf = await fetch(`${origin}/api/v1/settings/chat-model-preferences`, {
    method: "PUT",
    headers: { Origin: browserOrigin, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: 0, document: modelDocument }),
  });
  assert.equal(modelPreferencesWithoutCsrf.status, 403);

  const savedModelPreferences = await fetch(`${origin}/api/v1/settings/chat-model-preferences`, {
    method: "PUT",
    headers: { Origin: browserOrigin, Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
    body: JSON.stringify({ expectedRevision: 0, document: modelDocument }),
  });
  assert.equal(savedModelPreferences.status, 200);
  assert.equal((await savedModelPreferences.json() as { revision: number }).revision, 1);

  const staleModelPreferences = await fetch(`${origin}/api/v1/settings/chat-model-preferences`, {
    method: "PUT",
    headers: { Origin: browserOrigin, Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
    body: JSON.stringify({ expectedRevision: 0, document: modelDocument }),
  });
  assert.equal(staleModelPreferences.status, 409);

  const readable = await fetch(`${origin}/api/v1/profiles/coder/memory`, {
    headers: { Origin: browserOrigin, Cookie: cookie },
  });
  assert.equal(readable.status, 200);
  assert.equal((await readable.json() as { activeProvider: string }).activeProvider, "builtin");

  const skillsResponse = await fetch(`${origin}/api/v1/profiles/coder/skills`, {
    headers: { Origin: browserOrigin, Cookie: cookie },
  });
  const skillsText = await skillsResponse.text();
  assert.equal(skillsResponse.status, 200);
  assert.ok(Buffer.byteLength(skillsText) > 64 * 1024);
  assert.equal((JSON.parse(skillsText) as unknown[]).length, 1_000);

  const denied = await fetch(`${origin}/api/v1/profiles/coder/memory/provider`, {
    method: "PUT",
    headers: { Origin: browserOrigin, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "honcho", expectedProvider: "builtin" }),
  });
  assert.equal(denied.status, 403);
  assert.equal(selectedProvider, "builtin");

  const allowed = await fetch(`${origin}/api/v1/profiles/coder/memory/provider`, {
    method: "PUT",
    headers: { Origin: browserOrigin, Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
    body: JSON.stringify({ provider: "honcho", expectedProvider: "builtin" }),
  });
  assert.equal(allowed.status, 200);
  assert.equal(selectedProvider, "honcho");

  const resetWithoutCsrf = await fetch(`${origin}/api/v1/profiles/coder/memory/reset`, {
    method: "POST",
    headers: { Origin: browserOrigin, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ target: "all" }),
  });
  assert.equal(resetWithoutCsrf.status, 403);
  assert.deepEqual(resetCalls, []);

  const reset = await fetch(`${origin}/api/v1/profiles/coder/memory/reset`, {
    method: "POST",
    headers: { Origin: browserOrigin, Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
    body: JSON.stringify({ target: "all" }),
  });
  assert.equal(reset.status, 200);
  assert.deepEqual(resetCalls, [{ profile: "coder", target: "all" }]);
  const resetBody = await reset.json() as {
    ok: true;
    target: string;
    files: {
      profile: string;
      memory: { key: string; content: string; exists: boolean; bytes: number; revision: string };
      user: { key: string; content: string; exists: boolean; bytes: number; revision: string };
    };
    status: {
      activeProvider: string;
      builtin: { memoryBytes: number; userBytes: number; hasMemory: boolean; hasUser: boolean };
    };
  };
  assert.equal(resetBody.ok, true);
  assert.equal(resetBody.target, "all");
  assert.equal(resetBody.files.profile, "coder");
  assert.equal(resetBody.files.memory.key, "memory");
  assert.equal(resetBody.files.user.key, "user");
  assert.equal(typeof resetBody.files.memory.revision, "string");
  assert.equal(resetBody.files.memory.revision.length, 43);
  assert.equal(resetBody.status.activeProvider, "honcho");
  assert.equal(resetBody.status.builtin.hasMemory, false);
  assert.equal(resetBody.status.builtin.hasUser, false);
});

test("raw memory file GETs map to memory.update and are denied without that authorization", async (t) => {
  // Authorization mapping: bodies are not ordinary state.read.
  assert.equal(settingsOperation("GET", "/api/v1/profiles/coder/memory"), "state.read");
  assert.equal(settingsOperation("GET", "/api/v1/profiles/coder/memory/providers/honcho"), "state.read");
  assert.equal(settingsOperation("GET", "/api/v1/profiles/coder/memory/files"), "memory.update");
  assert.equal(settingsOperation("GET", "/api/v1/profiles/coder/memory/files/memory"), "memory.update");
  assert.equal(settingsOperation("GET", "/api/v1/profiles/coder/memory/files/user"), "memory.update");
  assert.equal(settingsOperation("PUT", "/api/v1/profiles/coder/memory/files/memory"), "memory.update");
  assert.equal(settingsOperation("GET", "/api/v1/profiles/coder/config"), "state.read");
  assert.equal(settingsOperation("GET", "/api/v1/profiles/coder/config/schema"), "state.read");
  assert.equal(settingsOperation("PATCH", "/api/v1/profiles/coder/config"), "profile-config.update");
  assert.equal(settingsOperation("GET", "/api/v1/profiles/coder/privileged-config"), "privileged-config.read");
  assert.equal(settingsOperation("PATCH", "/api/v1/profiles/coder/privileged-config"), "privileged-config.update");
  assert.equal(settingsOperation("GET", "/api/v1/profiles/coder/secrets"), "privileged-config.read");
  assert.equal(settingsOperation("POST", "/api/v1/profiles/coder/secrets"), "secret.write");
  assert.equal(settingsOperation("POST", "/api/v1/secret-transfers"), "secret.write");
  assert.equal(settingsOperation("GET", "/api/v1/settings/chat-model-preferences"), "state.read");
  assert.equal(settingsOperation("PUT", "/api/v1/settings/chat-model-preferences"), "chat-model-preferences.update");
  // Official Hermes Projects: reads stay on state.read; bindings change the
  // profile workspace and share the profile.update manager/step-up boundary.
  assert.equal(settingsOperation("GET", "/api/v1/profiles/coder/projects"), "state.read");
  assert.equal(settingsOperation("POST", "/api/v1/profiles/coder/projects"), "profile.update");
  assert.equal(settingsOperation("PATCH", "/api/v1/profiles/coder/projects/abc123"), "profile.update");
  assert.equal(settingsOperation("DELETE", "/api/v1/profiles/coder/projects/abc123"), "profile.update");
  assert.equal(settingsOperation("POST", "/api/v1/profiles/coder/projects/abc123/folders"), "profile.update");
  assert.equal(settingsOperation("DELETE", "/api/v1/profiles/coder/projects/abc123/folders"), "profile.update");
  assert.equal(OPERATION_POLICIES["memory.update"].minimumTier, "manager");
  assert.equal(OPERATION_POLICIES["memory.update"].boundary, "step-up-required");
  assert.equal(OPERATION_POLICIES["profile-config.update"].minimumTier, "manager");
  assert.equal(OPERATION_POLICIES["profile-config.update"].boundary, "step-up-required");
  assert.equal(OPERATION_POLICIES["chat-model-preferences.update"].minimumTier, "operator");
  assert.equal(OPERATION_POLICIES["chat-model-preferences.update"].boundary, "remote-safe");
  assert.equal(OPERATION_POLICIES["local-model-providers.sync"].minimumTier, "operator");
  assert.equal(OPERATION_POLICIES["local-model-providers.sync"].boundary, "remote-safe");
  for (const operation of ["team.create", "team.update", "team.delete"] as const) {
    assert.equal(OPERATION_POLICIES[operation].minimumTier, "manager");
    assert.equal(OPERATION_POLICIES[operation].boundary, "step-up-required");
  }
  assert.equal(OPERATION_POLICIES["profile-config.update"].auditable, true);
  assert.equal(OPERATION_POLICIES["privileged-config.read"].minimumTier, "owner");
  assert.equal(OPERATION_POLICIES["privileged-config.read"].boundary, "read-only");
  assert.equal(OPERATION_POLICIES["privileged-config.update"].minimumTier, "owner");
  assert.equal(OPERATION_POLICIES["privileged-config.update"].boundary, "remote-safe");
  assert.equal(OPERATION_POLICIES["secret.write"].minimumTier, "owner");
  assert.equal(OPERATION_POLICIES["secret.write"].boundary, "remote-safe");

  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-settings-memory-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const global = new OfficeGlobalSettingsStore(join(directory, "global.json"));
  const deviceRegistryPath = join(directory, "devices.json");
  let filesReads = 0;
  const settings = makeSettingsAdapter(
    () => "builtin",
    () => undefined,
    [],
    () => { filesReads += 1; },
  );
  const runtime: HermesRuntimeSource = {
    status: createDemoRuntimeStatus,
    snapshot: async () => createDemoSnapshot(),
    close: async () => undefined,
    chat: () => { throw new Error("unused"); },
    kanban: () => { throw new Error("unused"); },
    settings: () => settings,
    globalSettings: () => global,
  };
  const remoteToken = "settings-memory-auth-token-with-32chars!"; // gitleaks:allow -- synthetic auth fixture
  const remoteOrigin = "https://office.tailnet.example";
  const localOrigin = "http://localhost:4173";
  const server = createStudioServer({
    port: 0,
    runtimeSource: runtime,
    allowedOrigins: [localOrigin, remoteOrigin],
    remoteToken,
    trustedProxyHops: 1,
    deviceRegistryPath,
  });
  const address = await server.listen();
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${address.port}`;

  // Remote operator has state.read but not memory.update (tier + step-up).
  const remoteLogin = await fetch(`${origin}/api/v1/auth/device`, {
    method: "POST",
    headers: {
      Origin: remoteOrigin,
      "Content-Type": "application/json",
      "X-Forwarded-Proto": "https",
      "X-Forwarded-For": "100.64.0.10",
    },
    body: JSON.stringify({ token: remoteToken, deviceName: "Travel phone" }),
  });
  assert.equal(remoteLogin.status, 200);
  const remoteSession = await remoteLogin.json() as {
    csrfToken: string;
    principal: { local: boolean; tier: string };
  };
  assert.equal(remoteSession.principal.local, false);
  assert.equal(remoteSession.principal.tier, "operator");
  const remoteCookie = responseCookies(remoteLogin);
  const remoteHeaders = {
    Origin: remoteOrigin,
    Cookie: remoteCookie,
    "X-Forwarded-Proto": "https",
    "X-Forwarded-For": "100.64.0.10",
  };

  const remoteStatus = await fetch(`${origin}/api/v1/profiles/coder/memory`, { headers: remoteHeaders });
  assert.equal(remoteStatus.status, 200, "memory status remains state.read for remote operators");

  const remoteFiles = await fetch(`${origin}/api/v1/profiles/coder/memory/files`, { headers: remoteHeaders });
  assert.equal(remoteFiles.status, 403);
  const remoteFilesBody = await remoteFiles.json() as { code: string; message: string };
  assert.equal(remoteFilesBody.code, "forbidden");
  assert.equal(filesReads, 0, "adapter must not be reached without memory.update authorization");

  const remoteFileKey = await fetch(`${origin}/api/v1/profiles/coder/memory/files/memory`, { headers: remoteHeaders });
  assert.equal(remoteFileKey.status, 403);
  assert.equal(filesReads, 0);

  // Local owner may read raw bodies under memory.update.
  const bootstrap = await fetch(`${origin}/api/v1/auth/local`, { method: "POST", headers: { Origin: localOrigin } });
  assert.equal(bootstrap.status, 200);
  const localCookie = responseCookies(bootstrap);
  const localFiles = await fetch(`${origin}/api/v1/profiles/coder/memory/files`, {
    headers: { Origin: localOrigin, Cookie: localCookie },
  });
  assert.equal(localFiles.status, 200);
  assert.equal(filesReads, 1);
  const body = await localFiles.json() as { profile: string; memory: { key: string }; user: { key: string } };
  assert.equal(body.profile, "coder");
  assert.equal(body.memory.key, "memory");
  assert.equal(body.user.key, "user");
});

function responseCookies(response: Response): string {
  const raw = response.headers.get("set-cookie") ?? "";
  return [...raw.matchAll(/(?:^|,\s*)(hermes_office_(?:device|session))=([^;,\s]+)/g)]
    .map((match) => `${match[1]}=${match[2]}`)
    .join("; ");
}

function makeSettingsAdapter(
  getProvider: () => string,
  setProvider: (provider: string) => void,
  resetCalls: Array<{ profile: string; target: "all" | "memory" | "user" }>,
  onFilesRead?: () => void,
): HermesSettingsAdapter {
  const memory = () => ({
    activeProvider: getProvider(),
    providers: [],
    builtin: { memoryBytes: 0, userBytes: 0, hasMemory: false, hasUser: false },
  });
  const soul = { profile: "coder", content: "identity", exists: true, redacted: false, revision: REVISION };
  const skills = Array.from({ length: 1_000 }, (_, index) => ({
    name: `skill-${index}`,
    category: "workspace",
    description: `Safe skill ${index} ${"x".repeat(120)}`,
    enabled: index % 2 === 0,
    provenance: "agent" as const,
    usage: index,
  }));
  const emptyFiles = (profile: string) => ({
    profile,
    memory: { key: "memory" as const, content: "", exists: false, bytes: 0, revision: REVISION },
    user: { key: "user" as const, content: "", exists: false, bytes: 0, revision: REVISION },
  });
  return {
    getProfileSettings: async (profile) => ({ profile, skills, memory: memory(), soul: { ...soul, profile } }),
    listSkills: async () => skills,
    setSkillEnabled: async () => undefined,
    getSkillContent: async (_profile, name) => ({ name, content: "", redacted: false, revision: REVISION }),
    updateSkillContent: async (_profile, name, content) => ({ name, content, redacted: false, revision: REVISION }),
    getMemoryStatus: async () => memory(),
    setMemoryProvider: async (_profile, provider, expected) => {
      if (expected !== getProvider()) throw new Error("conflict");
      setProvider(provider);
      return memory();
    },
    getMemoryProviderConfig: async (_profile, name) => ({ name, label: name, fields: [], revision: REVISION }),
    updateMemoryProviderConfig: async (_profile, name) => ({ name, label: name, fields: [], revision: REVISION }),
    getBuiltinMemoryFiles: async (profile) => {
      onFilesRead?.();
      return emptyFiles(profile);
    },
    updateBuiltinMemoryFile: async () => { throw new Error("must not be called"); },
    resetBuiltinMemory: async (profile, target) => {
      resetCalls.push({ profile, target });
      return { files: emptyFiles(profile), status: memory() };
    },
    getProfileSoul: async (profile) => ({ ...soul, profile }),
    updateProfileSoul: async (profile, content) => ({ ...soul, profile, content }),
    getProfileConfigSchema: async (profile) => ({
      profile,
      categories: ["general"],
      fields: [{ id: "display.compact", category: "display", type: "boolean", description: "Compact", options: [] }],
      excludedCount: 1,
    }),
    getProfileConfig: async (profile) => ({
      profile,
      revision: REVISION,
      categories: ["general"],
      fields: [{ id: "display.compact", category: "display", type: "boolean", description: "Compact", options: [] }],
      values: { "display.compact": false },
      excludedCount: 1,
    }),
    updateProfileConfig: async (profile) => ({
      profile,
      revision: "b".repeat(43),
      categories: ["general"],
      fields: [{ id: "display.compact", category: "display", type: "boolean", description: "Compact", options: [] }],
      values: { "display.compact": true },
      excludedCount: 1,
    }),
    getPrivilegedProfileConfig: async (profile) => ({
      profile,
      revision: REVISION,
      categories: ["terminal"],
      fields: [{
        id: "terminal.timeout",
        category: "terminal",
        type: "number" as const,
        description: "Terminal timeout",
        options: [],
        impact: "restart" as const,
        requiresConfirmation: true,
      }],
      values: { "terminal.timeout": 30 },
      unsupportedCount: 0,
      secretFieldCount: 0,
    }),
    updatePrivilegedProfileConfig: async (profile) => ({
      profile,
      revision: "b".repeat(43),
      categories: ["terminal"],
      fields: [{
        id: "terminal.timeout",
        category: "terminal",
        type: "number" as const,
        description: "Terminal timeout",
        options: [],
        impact: "restart" as const,
        requiresConfirmation: true,
      }],
      values: { "terminal.timeout": 60 },
      unsupportedCount: 0,
      secretFieldCount: 0,
    }),
    listProfileSecrets: async (profile) => ({
      profile,
      revision: REVISION,
      fields: [],
    }),
    writeProfileSecret: async (profile) => ({
      profile,
      revision: "b".repeat(43),
      fields: [],
    }),
  } as HermesSettingsAdapter;
}
