import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHermesConfigPutBody,
  normalizeHermesConfigSchema,
  pickSafeConfigValues,
  projectSafeHermesConfig,
  resolveHermesConfigEditableType,
  revisionOfConfigValues,
  validateConfigPatchChanges,
} from "./hermes-config.js";
import { HERMES_0182_NULL_INFERRED_STRING_FIELDS } from "./hermes-config-policy.js";

const sampleSchema = {
  category_order: ["general", "agent", "security", "display"],
  fields: {
    model: { type: "string", description: "Default model", category: "general" },
    "agent.max_turns": { type: "number", description: "Max turns", category: "agent" },
    "display.compact": { type: "boolean", description: "Compact UI", category: "display" },
    "logging.level": {
      type: "select",
      description: "Log level",
      category: "logging",
      options: ["INFO", "DEBUG"],
    },
    "agent.disabled_toolsets": { type: "list", description: "Disabled toolsets", category: "agent" },
    "memory.memory_char_limit": { type: "number", description: "Memory char limit", category: "memory" },
    "memory.write_approval": { type: "boolean", description: "Write approval", category: "memory" },
    "skills.write_approval": { type: "boolean", description: "Skill write approval", category: "agent" },
    "cron.provider": { type: "string", description: "Cron provider", category: "agent" },
    "checkpoints.auto_prune": { type: "boolean", description: "Checkpoint prune", category: "agent" },
    "updates.pre_update_backup": { type: "boolean", description: "Backup", category: "general" },
    "security.allow_private_urls": { type: "boolean", description: "Danger", category: "security" },
    "auxiliary.vision.api_key": { type: "string", description: "Secret", category: "auxiliary" },
    "terminal.backend": { type: "select", description: "Backend", category: "terminal", options: ["local", "docker"] },
    "unknown.blob": { type: "object", description: "No", category: "agent" },
    // Hermes 0.18.2 null→string mislabels (optional numbers)
    max_concurrent_sessions: { type: "string", description: "Max sessions", category: "general" },
    context_file_max_chars: { type: "string", description: "Context file chars", category: "general" },
    // Ordinary string with empty default (unambiguous when live value is "")
    timezone: { type: "string", description: "Timezone", category: "general" },
    // Safe-looking list of strings (tools category)
    "display.theme_tags": { type: "list", description: "Theme tags", category: "display" },
  },
};

test("normalizeHermesConfigSchema keeps only ordinary safe leaves and counts exclusions", () => {
  const result = normalizeHermesConfigSchema(sampleSchema);
  const ids = result.fields.map((field) => field.id).sort();
  assert.deepEqual(ids, [
    "agent.max_turns",
    "context_file_max_chars",
    "display.compact",
    "display.theme_tags",
    "logging.level",
    "max_concurrent_sessions",
    "memory.memory_char_limit",
    "timezone",
  ]);
  assert.ok(result.excludedCount >= 10);
  assert.ok(!result.categories.includes("security"));
  assert.ok(!ids.includes("model"));
  assert.ok(!ids.includes("agent.disabled_toolsets"));
  assert.ok(!ids.includes("cron.provider"));
  assert.ok(!ids.includes("checkpoints.auto_prune"));
  assert.ok(!ids.includes("skills.write_approval"));
  assert.ok(!ids.includes("memory.write_approval"));
  assert.ok(!ids.includes("updates.pre_update_backup"));
  const logging = result.fields.find((field) => field.id === "logging.level");
  assert.equal(logging?.type, "select");
  assert.deepEqual(logging?.options.map((option) => option.value), ["INFO", "DEBUG"]);
});

test("resolveHermesConfigEditableType denies Hermes null→string inference without a live value", () => {
  // Mirrors hermes_cli/web_server._infer_type(None) → "string".
  assert.equal(resolveHermesConfigEditableType("string", null), undefined);
  assert.equal(resolveHermesConfigEditableType("string", undefined), undefined);
  assert.equal(resolveHermesConfigEditableType("string", ""), "string");
  assert.equal(resolveHermesConfigEditableType("string", "UTC"), "string");
  // Live number under a string schema label → edit as number (type-preserving).
  assert.equal(resolveHermesConfigEditableType("string", 8), "number");
  assert.equal(resolveHermesConfigEditableType("number", null), "number");
  assert.equal(resolveHermesConfigEditableType("number", 40), "number");
  assert.equal(resolveHermesConfigEditableType("boolean", true), "boolean");
  assert.equal(resolveHermesConfigEditableType("list", []), "list");
  assert.equal(resolveHermesConfigEditableType("list", ["a", "b"]), "list");
  // Non-string list items fail closed (no silent coercion).
  assert.equal(resolveHermesConfigEditableType("list", [1, 2]), undefined);
  assert.equal(resolveHermesConfigEditableType("list", [true]), undefined);
  assert.equal(resolveHermesConfigEditableType("list", ["a", 1]), undefined);
});

test("Hermes 0.18.2 null-inferred optional numbers are denied until a live number exists", () => {
  for (const fixture of HERMES_0182_NULL_INFERRED_STRING_FIELDS) {
    if (fixture.category === "kanban" || fixture.category === "cron") {
      // Whole trees already fail closed by field-id policy.
      continue;
    }
    const schema = {
      category_order: ["general"],
      fields: {
        [fixture.id]: { type: "string", description: fixture.id, category: fixture.category },
        timezone: { type: "string", description: "Timezone", category: "general" },
      },
    };
    const denied = projectSafeHermesConfig(schema, { [fixture.id]: null, timezone: "UTC" });
    assert.equal(
      denied.fields.some((field) => field.id === fixture.id),
      false,
      `${fixture.id} with null must be denied`,
    );
    assert.equal(Object.hasOwn(denied.values, fixture.id), false);

    const resolved = projectSafeHermesConfig(schema, { [fixture.id]: 12, timezone: "UTC" });
    const field = resolved.fields.find((item) => item.id === fixture.id);
    assert.equal(field?.type, "number", `${fixture.id} with live number must retype to number`);
    assert.equal(resolved.values[fixture.id], 12);
  }
});

test("projectSafeHermesConfig exposes only string-list fields and never coerces item types", () => {
  const projected = projectSafeHermesConfig(sampleSchema, {
    agent: { max_turns: 40 },
    display: { compact: true, theme_tags: ["dark", "dense"] },
    logging: { level: "INFO" },
    memory: { memory_char_limit: 8_000 },
    timezone: "UTC",
    max_concurrent_sessions: null,
    context_file_max_chars: null,
  });
  assert.equal(projected.fields.some((field) => field.id === "max_concurrent_sessions"), false);
  assert.equal(projected.fields.some((field) => field.id === "context_file_max_chars"), false);
  assert.equal(projected.values.timezone, "UTC");
  assert.deepEqual(projected.values["display.theme_tags"], ["dark", "dense"]);

  const mixedListDenied = projectSafeHermesConfig(sampleSchema, {
    agent: { max_turns: 1 },
    display: { compact: false, theme_tags: [1, 2] },
    logging: { level: "INFO" },
    memory: { memory_char_limit: 1 },
    timezone: "UTC",
  });
  assert.equal(mixedListDenied.fields.some((field) => field.id === "display.theme_tags"), false);
  assert.equal(Object.hasOwn(mixedListDenied.values, "display.theme_tags"), false);
});

test("pickSafeConfigValues returns only safe scalar leaves", () => {
  const { fields } = normalizeHermesConfigSchema(sampleSchema);
  const values = pickSafeConfigValues({
    model: "anthropic/claude-sonnet-4",
    agent: { max_turns: 40, disabled_toolsets: ["browser", "web"] },
    display: { compact: true },
    logging: { level: "INFO" },
    memory: { memory_char_limit: 8_000, write_approval: true },
    security: { allow_private_urls: true },
    auxiliary: { vision: { api_key: "sk-secret" } }, // gitleaks:allow -- synthetic rejection fixture
  }, fields);
  assert.deepEqual(values, {
    "agent.max_turns": 40,
    "display.compact": true,
    "logging.level": "INFO",
    "memory.memory_char_limit": 8_000,
  });
  assert.equal(Object.hasOwn(values, "model"), false);
  assert.equal(Object.hasOwn(values, "agent.disabled_toolsets"), false);
  assert.equal(Object.hasOwn(values, "memory.write_approval"), false);
  assert.equal(Object.hasOwn(values, "security.allow_private_urls"), false);
  assert.equal(Object.hasOwn(values, "auxiliary.vision.api_key"), false);
});

test("pickSafeConfigValues drops secret-shaped strings and non-finite numbers", () => {
  const { fields } = normalizeHermesConfigSchema(sampleSchema);
  const values = pickSafeConfigValues({
    agent: { max_turns: Number.NaN },
    display: { compact: true },
    logging: { level: "INFO" },
    memory: { memory_char_limit: 100 },
  }, fields);
  assert.equal(Object.hasOwn(values, "agent.max_turns"), false);
  assert.equal(values["display.compact"], true);
  assert.equal(values["memory.memory_char_limit"], 100);
});

test("validateConfigPatchChanges re-checks schema, types, and bounds", () => {
  const { fields } = normalizeHermesConfigSchema(sampleSchema);
  const clean = validateConfigPatchChanges({
    "display.compact": true,
    "agent.max_turns": 12,
    "logging.level": "DEBUG",
    "memory.memory_char_limit": 4_000,
    "display.theme_tags": ["a", "b"],
  }, fields);
  assert.deepEqual(clean, {
    "display.compact": true,
    "agent.max_turns": 12,
    "logging.level": "DEBUG",
    "memory.memory_char_limit": 4_000,
    "display.theme_tags": ["a", "b"],
  });

  assert.throws(
    () => validateConfigPatchChanges({ "agent.disabled_toolsets": ["web"] }, fields),
    /not editable|unsafe/i,
  );
  assert.throws(
    () => validateConfigPatchChanges({ model: "x" }, fields),
    /not editable|unsafe/i,
  );
  assert.throws(
    () => validateConfigPatchChanges({ "security.allow_private_urls": true }, fields),
    /not editable|unsafe/i,
  );
  assert.throws(
    () => validateConfigPatchChanges({ "agent.max_turns": Number.POSITIVE_INFINITY }, fields),
    /Invalid number/,
  );
  assert.throws(
    () => validateConfigPatchChanges({ "logging.level": "TRACE" }, fields),
    /not allowed/,
  );
  assert.throws(
    () => validateConfigPatchChanges({ "display.compact": "x".repeat(20_000) as unknown as boolean }, fields),
    /Invalid boolean|Invalid string/,
  );
  assert.throws(
    () => validateConfigPatchChanges({ "display.theme_tags": [1, 2] as unknown as string[] }, fields),
    /Invalid list item/,
  );
  assert.throws(
    () => validateConfigPatchChanges({ "display.theme_tags": [true] as unknown as string[] }, fields),
    /Invalid list item/,
  );
});

test("buildHermesConfigPutBody nests dotted leaves for Hermes deep-merge PUT", () => {
  assert.deepEqual(
    buildHermesConfigPutBody({
      "agent.max_turns": 3,
      "display.compact": false,
      "memory.memory_char_limit": 100,
    }),
    {
      agent: { max_turns: 3 },
      display: { compact: false },
      memory: { memory_char_limit: 100 },
    },
  );
});

test("revisionOfConfigValues is stable under key order", () => {
  const a = revisionOfConfigValues({ "agent.max_turns": 1, "display.compact": true });
  const b = revisionOfConfigValues({ "display.compact": true, "agent.max_turns": 1 });
  assert.equal(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, revisionOfConfigValues({ "agent.max_turns": 2, "display.compact": true }));
});
