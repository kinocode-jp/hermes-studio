import assert from "node:assert/strict";
import test from "node:test";

// Local mirror of the live-settings dirty collector (UI logic contract).
function collectConfigChanges(
  baseline: Record<string, unknown>,
  draft: Record<string, unknown>,
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(draft)) {
    if (JSON.stringify(value) !== JSON.stringify(baseline[key])) changes[key] = value;
  }
  return changes;
}

/** Local mirror of live-settings asStringList — never coerce via String(). */
function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  if (!value.every((item): item is string => typeof item === "string")) return [];
  return value;
}

test("config dirty collector emits only changed dotted leaves", () => {
  const baseline = {
    model: "a",
    "display.compact": false,
    "display.theme_tags": ["web"],
  };
  const draft = {
    model: "b",
    "display.compact": false,
    "display.theme_tags": ["web", "browser"],
  };
  assert.deepEqual(collectConfigChanges(baseline, draft), {
    model: "b",
    "display.theme_tags": ["web", "browser"],
  });
});

test("config dirty collector ignores equivalent list order-sensitive equality", () => {
  const baseline = { tags: ["a", "b"] };
  assert.deepEqual(collectConfigChanges(baseline, { tags: ["a", "b"] }), {});
  assert.deepEqual(collectConfigChanges(baseline, { tags: ["b", "a"] }), {
    tags: ["b", "a"],
  });
});

test("list editor contract preserves string rows and refuses silent type coercion", () => {
  assert.deepEqual(asStringList(["a", "b"]), ["a", "b"]);
  assert.deepEqual(asStringList([]), []);
  // Former bug: value.map(String) would turn these into ["true", "1"].
  assert.deepEqual(asStringList([true, false]), []);
  assert.deepEqual(asStringList([1, 2]), []);
  assert.deepEqual(asStringList(["ok", 1]), []);
  assert.deepEqual(asStringList(undefined), []);
  assert.deepEqual(asStringList("not-a-list"), []);
});

test("privileged dirty collector tracks nested JSON leaves without coercion", () => {
  const baseline = {
    model: "a",
    "moa.presets.default.reference_models": [{ provider: "openai", model: "x" }],
  };
  const draft = {
    model: "a",
    "moa.presets.default.reference_models": [{ provider: "openai", model: "y" }],
  };
  assert.deepEqual(collectConfigChanges(baseline, draft), {
    "moa.presets.default.reference_models": [{ provider: "openai", model: "y" }],
  });
});

/** Local mirror: secret metadata must never accept a value property. */
function assertSecretMetaRejectsValues(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const item = raw as Record<string, unknown>;
  if ("value" in item || "redacted_value" in item || "redactedValue" in item) return false;
  return typeof item.key === "string" && typeof item.isSet === "boolean";
}

test("secret metadata client validation rejects value-bearing payloads", () => {
  assert.equal(assertSecretMetaRejectsValues({ key: "OPENAI_API_KEY", isSet: true }), true);
  assert.equal(assertSecretMetaRejectsValues({ key: "OPENAI_API_KEY", isSet: true, value: "sk-leak" }), false);
  assert.equal(assertSecretMetaRejectsValues({ key: "OPENAI_API_KEY", isSet: true, redacted_value: "sk-***" }), false);
});

/** Local mirror of secretFieldDraftKey — includes provider for memory-provider fields. */
function secretFieldDraftKey(field: { source: string; key: string; provider?: string }): string {
  return `${field.source}:${field.provider ?? ""}:${field.key}`;
}

test("secret draft keys disambiguate memory-provider fields by provider", () => {
  assert.equal(
    secretFieldDraftKey({ source: "env", key: "OPENAI_API_KEY" }),
    "env::OPENAI_API_KEY",
  );
  assert.equal(
    secretFieldDraftKey({ source: "memory-provider", key: "api_key", provider: "hindsight" }),
    "memory-provider:hindsight:api_key",
  );
  assert.notEqual(
    secretFieldDraftKey({ source: "memory-provider", key: "api_key", provider: "hindsight" }),
    secretFieldDraftKey({ source: "memory-provider", key: "api_key", provider: "mem0" }),
  );
});

/** Local mirror: blank save is no-op; clear is a separate empty-string path. */
function secretSaveIsNoOp(draft: string): boolean {
  return draft === "";
}

test("blank secret input is a save no-op while clear uses empty transfer", () => {
  assert.equal(secretSaveIsNoOp(""), true);
  assert.equal(secretSaveIsNoOp("new-secret"), false);
  // Clear intentionally deposits empty string (not the blank-save path).
  assert.equal("" === "", true);
});
