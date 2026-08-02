import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePrivilegedHermesConfigFieldPolicy,
  isHermesConfigSecretField,
  privilegedConfigFieldImpact,
  privilegedConfigRequiresConfirmation,
} from "./hermes-config-policy.js";
import {
  projectConfigSecretFieldMeta,
  projectPrivilegedHermesConfig,
  validatePrivilegedConfigPatchChanges,
} from "./hermes-privileged-config.js";

const schema = {
  category_order: ["terminal", "agent", "general", "auxiliary"],
  fields: {
    "terminal.timeout": { type: "number", category: "terminal", description: "Timeout seconds" },
    "terminal.backend": { type: "string", category: "terminal", description: "Backend" },
    model: { type: "string", category: "general", description: "Default model" },
    toolsets: { type: "list", category: "general", description: "Toolsets" },
    "display.compact": { type: "boolean", category: "display", description: "Compact" },
    "agent.max_turns": { type: "number", category: "agent", description: "Max turns" },
    "auxiliary.vision.api_key": { type: "string", category: "auxiliary", description: "Vision key" },
    "security.redact_secrets": { type: "boolean", category: "security", description: "Redact" },
    "moa.presets.default.reference_models": { type: "list", category: "moa", description: "Refs" },
    "approvals.mode": { type: "select", category: "approvals", description: "Mode", options: ["manual", "auto"] },
    // Hermes _infer_type(None) → "string" for optional numbers.
    max_concurrent_sessions: { type: "string", category: "general", description: "Max sessions" },
    context_file_max_chars: { type: "string", category: "general", description: "Context file chars" },
    missing_optional: { type: "string", category: "general", description: "Missing path" },
  },
};

const config = {
  terminal: { timeout: 30, backend: "local" },
  model: "openai/gpt-4.1",
  toolsets: ["browser", "coding"],
  display: { compact: true },
  agent: { max_turns: 12 },
  auxiliary: { vision: { api_key: "sk-live-should-not-leak" } }, // gitleaks:allow -- synthetic rejection fixture
  security: { redact_secrets: true },
  moa: {
    presets: {
      default: {
        reference_models: [{ provider: "openai", model: "gpt-4.1" }],
      },
    },
  },
  approvals: { mode: "manual" },
  max_concurrent_sessions: null,
  context_file_max_chars: null,
  // missing_optional deliberately omitted (undefined path — not exposed).
};

test("privileged policy excludes safe leaves and secret leaves", () => {
  assert.equal(evaluatePrivilegedHermesConfigFieldPolicy("agent.max_turns", "agent", "number").allowed, false);
  assert.equal(evaluatePrivilegedHermesConfigFieldPolicy("display.compact", "display", "boolean").allowed, false);
  assert.equal(evaluatePrivilegedHermesConfigFieldPolicy("terminal.timeout", "terminal", "number").allowed, true);
  assert.equal(evaluatePrivilegedHermesConfigFieldPolicy("model", "general", "string").allowed, true);
  assert.equal(evaluatePrivilegedHermesConfigFieldPolicy("auxiliary.vision.api_key", "auxiliary", "string").allowed, false);
  assert.equal(isHermesConfigSecretField("auxiliary.vision.api_key", "string"), true);
  assert.equal(isHermesConfigSecretField("security.redact_secrets", "boolean"), false);
});

test("privileged projection covers previously excluded non-secret leaves and never returns secrets", () => {
  const projected = projectPrivilegedHermesConfig(schema, config);
  const ids = projected.fields.map((field) => field.id).sort();
  assert.ok(ids.includes("terminal.timeout"));
  assert.ok(ids.includes("model"));
  assert.ok(ids.includes("toolsets"));
  assert.ok(ids.includes("approvals.mode"));
  assert.ok(ids.includes("security.redact_secrets"));
  assert.equal(ids.includes("display.compact"), false);
  assert.equal(ids.includes("agent.max_turns"), false);
  assert.equal(ids.includes("auxiliary.vision.api_key"), false);
  assert.ok(projected.secretFieldCount >= 1);
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes("sk-live-should-not-leak"), false);
  assert.equal(projected.values["terminal.timeout"], 30);
  assert.equal(projected.values.model, "openai/gpt-4.1");
  // Nested object list uses bounded JSON editor.
  assert.equal(projected.fields.find((field) => field.id === "moa.presets.default.reference_models")?.type, "json");
});

test("secret config metadata is isSet-only and never includes values", () => {
  const secrets = projectConfigSecretFieldMeta(schema, config);
  assert.ok(secrets.some((item) => item.key === "auxiliary.vision.api_key" && item.isSet === true));
  const serialized = JSON.stringify(secrets);
  assert.equal(serialized.includes("sk-live-should-not-leak"), false);
  assert.equal(serialized.includes("value"), false);
});

test("privileged patch validates types and confirmation impact markers", () => {
  const projected = projectPrivilegedHermesConfig(schema, config);
  const modelField = projected.fields.find((field) => field.id === "model");
  assert.ok(modelField);
  assert.equal(privilegedConfigRequiresConfirmation("model", "general"), true);
  assert.equal(privilegedConfigFieldImpact("terminal.timeout", "terminal"), "restart");
  const clean = validatePrivilegedConfigPatchChanges(
    { model: "openai/gpt-4.1-mini", "terminal.timeout": 45 },
    projected.fields,
  );
  assert.deepEqual(clean, { model: "openai/gpt-4.1-mini", "terminal.timeout": 45 });
  assert.throws(() => validatePrivilegedConfigPatchChanges({ "agent.max_turns": 3 }, projected.fields));
  assert.throws(() => validatePrivilegedConfigPatchChanges({ "terminal.timeout": "nope" }, projected.fields));
});

test("explicit null safe-category leaves become privileged JSON editors", () => {
  const projected = projectPrivilegedHermesConfig(schema, config);
  const maxSessions = projected.fields.find((field) => field.id === "max_concurrent_sessions");
  const contextChars = projected.fields.find((field) => field.id === "context_file_max_chars");
  assert.ok(maxSessions);
  assert.ok(contextChars);
  assert.equal(maxSessions!.type, "json");
  assert.equal(contextChars!.type, "json");
  assert.equal(maxSessions!.requiresConfirmation, true);
  assert.equal(projected.values.max_concurrent_sessions, null);
  assert.equal(projected.values.context_file_max_chars, null);
  // Missing/undefined paths are not invented.
  assert.equal(projected.fields.some((field) => field.id === "missing_optional"), false);
  // Not counted as unsupported when projected as JSON null.
  assert.equal(
    projected.fields.some((field) => field.id === "max_concurrent_sessions"),
    true,
  );
  const typed = validatePrivilegedConfigPatchChanges(
    { max_concurrent_sessions: 4 },
    projected.fields,
  );
  assert.equal(typed.max_concurrent_sessions, 4);
  const keepNull = validatePrivilegedConfigPatchChanges(
    { context_file_max_chars: null },
    projected.fields,
  );
  assert.equal(keepNull.context_file_max_chars, null);
});
