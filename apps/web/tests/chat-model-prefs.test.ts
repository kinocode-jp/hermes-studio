import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHAT_MODEL_MANUAL_PROVIDER,
  modelSelectValue,
  modelSlashCommand,
  matchingChatModelPresetName,
  needsManualModelEntry,
  parseChatModelPrefsDocument,
  parseLiveCatalog,
  parseReasoningEffortsField,
  providerSelectValue,
  reconcileReasoningEffortValue,
  resolvedCreateModelPrefs,
  resolvedReasoningEffortForCreate,
  sanitizeChatModelPreset,
  sanitizeModelSlot,
  sanitizePresetList,
  sanitizePresetName,
  sanitizeReasoningEffort,
} from "../src/chat-model-prefs";

test("resolvedCreateModelPrefs strips manual sentinel and splits provider:model", () => {
  assert.deepEqual(resolvedCreateModelPrefs({
    provider: CHAT_MODEL_MANUAL_PROVIDER,
    model: "openrouter:claude-sonnet-4",
    reasoningEffort: "",
  }), {
    provider: "openrouter",
    model: "claude-sonnet-4",
    reasoningEffort: "",
  });
  // Shape-sanitize keeps a general wire value (session/prefs already validated at apply).
  assert.deepEqual(resolvedCreateModelPrefs({
    provider: CHAT_MODEL_MANUAL_PROVIDER,
    model: "llama3.2",
    reasoningEffort: "high",
  }), {
    provider: "",
    model: "llama3.2",
    reasoningEffort: "high",
  });
  assert.deepEqual(resolvedCreateModelPrefs({
    provider: "openai",
    model: "gpt-4.1",
    reasoningEffort: "bogus",
  }), {
    provider: "openai",
    model: "gpt-4.1",
    reasoningEffort: "",
  });
  assert.deepEqual(resolvedCreateModelPrefs({
    provider: "openai",
    model: "gpt-4.1",
    reasoningEffort: "high",
  }, ["low", "high"]), {
    provider: "openai",
    model: "gpt-4.1",
    reasoningEffort: "high",
  });
  // Empty live allowlist clears even a previously valid level.
  assert.deepEqual(resolvedCreateModelPrefs({
    provider: "openai",
    model: "gpt-4.1",
    reasoningEffort: "high",
  }, []), {
    provider: "openai",
    model: "gpt-4.1",
    reasoningEffort: "",
  });
});

test("resolvedCreateModelPrefs leaves a real Hermes provider named custom unchanged", () => {
  assert.deepEqual(resolvedCreateModelPrefs({
    provider: "custom",
    model: "local-model",
    reasoningEffort: "",
  }), {
    provider: "custom",
    model: "local-model",
    reasoningEffort: "",
  });
  assert.equal(
    modelSlashCommand({ provider: "custom", model: "local-model", reasoningEffort: "" }),
    "/model local-model --provider custom --session",
  );
});

test("modelSlashCommand uses --provider/--session and never emits the manual sentinel", () => {
  assert.equal(
    modelSlashCommand({ provider: CHAT_MODEL_MANUAL_PROVIDER, model: "openrouter:x", reasoningEffort: "" }),
    "/model x --provider openrouter --session",
  );
  assert.equal(
    modelSlashCommand({ provider: "custom:team", model: "local-model", reasoningEffort: "high" }),
    "/model local-model --provider custom:team --session",
  );
  assert.equal(
    modelSlashCommand({ provider: CHAT_MODEL_MANUAL_PROVIDER, model: "llama3.2", reasoningEffort: "" }),
    "/model llama3.2 --session",
  );
  assert.equal(modelSlashCommand({ provider: "", model: "", reasoningEffort: "" }), undefined);
  assert.equal(modelSlashCommand({ provider: CHAT_MODEL_MANUAL_PROVIDER, model: "", reasoningEffort: "" }), undefined);
});

test("provider/model select helpers fall back to manual when live options miss the selection", () => {
  const providers = [
    { id: "openrouter", label: "OpenRouter", active: true },
    { id: "custom:team", label: "Custom team", active: false },
  ];
  const models = [
    { id: "org::model", label: "Org Model" },
    { id: "plain", label: "Plain" },
  ];
  assert.equal(providerSelectValue("", providers), "default");
  assert.equal(providerSelectValue("openrouter", providers), "openrouter");
  assert.equal(providerSelectValue("custom:team", providers), "custom:team");
  assert.equal(providerSelectValue("missing", providers), "missing");
  assert.equal(providerSelectValue(CHAT_MODEL_MANUAL_PROVIDER, providers), CHAT_MODEL_MANUAL_PROVIDER);
  assert.equal(modelSelectValue("org::model", models), "org::model");
  assert.equal(modelSelectValue("gone", models), "");
  assert.equal(needsManualModelEntry("missing", "x", providers, models), true);
  assert.equal(needsManualModelEntry("openrouter", "gone", providers, models), true);
  assert.equal(needsManualModelEntry("openrouter", "plain", providers, models), false);
  assert.equal(needsManualModelEntry("", "", providers, models), false);
});

test("parseLiveCatalog accepts multi-provider Office payloads with reasoning efforts", () => {
  const catalog = parseLiveCatalog({
    profile: "coder",
    providers: [
      { id: "openrouter", label: "OpenRouter", active: true },
      { id: "ollama", label: "Ollama", active: false },
      { id: "token", label: "Secret-ish id dropped" },
      { id: "ok", label: "api_key_label" },
    ],
    provider: "openrouter",
    defaultProvider: "openrouter",
    defaultModel: "anthropic/claude",
    models: [
      { id: "anthropic/claude", label: "Claude", reasoningEfforts: ["low", "high", "bogus"] },
      { id: "bad", label: 1 },
      { id: "password-model", label: "No" },
      { id: "org::model", label: "Org" },
    ],
    refreshedAt: "2026-07-20T00:00:00.000Z",
  }, "coder");
  assert.equal(catalog.provider, "openrouter");
  assert.equal(catalog.defaultProvider, "openrouter");
  assert.equal(catalog.defaultModel, "anthropic/claude");
  assert.deepEqual(catalog.providers.map((item) => item.id), ["openrouter", "ollama"]);
  assert.equal(catalog.providers[0]!.active, true);
  assert.deepEqual(catalog.models, [
    { id: "anthropic/claude", label: "Claude", reasoningEfforts: ["low", "high"] },
    { id: "org::model", label: "Org" },
  ]);
});

test("parseLiveCatalog rejects unsafe selected provider ids", () => {
  assert.throws(
    () => parseLiveCatalog({
      profile: "coder",
      providers: [],
      provider: "api_key",
      models: [],
      refreshedAt: "2026-07-20T00:00:00.000Z",
    }, "coder"),
    (error: unknown) => error instanceof Error && error.message.includes("incompatible"),
  );
});

test("sanitize keeps general levels; create wire is fail-closed without live allowlist", () => {
  // sanitize: no allowlist → normalize general 8; empty allowlist clears; non-empty filters.
  assert.equal(sanitizeReasoningEffort("HIGH"), "high");
  assert.equal(sanitizeReasoningEffort("high", []), "");
  assert.equal(sanitizeReasoningEffort("nope"), "");
  assert.equal(sanitizeReasoningEffort("high", ["low", "medium"]), "");
  assert.equal(sanitizeReasoningEffort("low", ["low", "medium"]), "low");
  // resolvedReasoningEffortForCreate: no / empty allowlist → never send, even if valid.
  assert.equal(resolvedReasoningEffortForCreate({
    provider: "x",
    model: "y",
    reasoningEffort: "high",
  }), undefined);
  assert.equal(resolvedReasoningEffortForCreate({
    provider: "x",
    model: "y",
    reasoningEffort: "high",
  }, []), undefined);
  assert.equal(resolvedReasoningEffortForCreate({
    provider: "x",
    model: "y",
    reasoningEffort: "xhigh",
  }, ["low", "high"]), undefined);
  assert.equal(resolvedReasoningEffortForCreate({
    provider: "x",
    model: "y",
    reasoningEffort: "high",
  }, ["low", "high"]), "high");
  // Panel reconcile: missing/empty enum clears; listed value kept.
  assert.equal(reconcileReasoningEffortValue("high", undefined), "");
  assert.equal(reconcileReasoningEffortValue("high", []), "");
  assert.equal(reconcileReasoningEffortValue("high", ["low", "medium"]), "");
  assert.equal(reconcileReasoningEffortValue("high", ["low", "high"]), "high");
  assert.deepEqual(parseReasoningEffortsField(["ultra", "none", "ultra", "nope"]), ["none", "ultra"]);
  assert.equal(parseReasoningEffortsField(["nope"]), undefined);
});

test("parseChatModelPrefsDocument migrates flat v2 main-only shape", () => {
  const doc = parseChatModelPrefsDocument({
    provider: "openrouter",
    model: "claude-sonnet",
    reasoningEffort: "HIGH",
  });
  assert.deepEqual(doc.main, {
    provider: "openrouter",
    model: "claude-sonnet",
    reasoningEffort: "high",
  });
  assert.deepEqual(doc.sub, { provider: "", model: "", reasoningEffort: "" });
  assert.deepEqual(doc.presets, []);
  assert.equal(doc.activePresetId, undefined);
});

test("parseChatModelPrefsDocument accepts v3 presets and drops invalid/active orphans", () => {
  const doc = parseChatModelPrefsDocument({
    main: { provider: "openai", model: "gpt-4.1", reasoningEffort: "medium" },
    sub: { provider: "ollama", model: "llama3.2", reasoningEffort: "bogus" },
    presets: [
      {
        id: "fast-pair",
        name: " Fast pair ",
        main: { provider: "openai", model: "gpt-4.1", reasoningEffort: "low" },
        sub: { provider: "ollama", model: "llama3.2", reasoningEffort: "none" },
      },
      { id: "bad id", name: "x", main: {}, sub: {} },
      { id: "token-leak", name: "ok", main: {}, sub: {} },
      {
        id: "dup",
        name: "First",
        main: { provider: "a", model: "b", reasoningEffort: "" },
        sub: { provider: "", model: "", reasoningEffort: "" },
      },
      {
        id: "dup",
        name: "Second",
        main: { provider: "c", model: "d", reasoningEffort: "" },
        sub: { provider: "", model: "", reasoningEffort: "" },
      },
    ],
    activePresetId: "missing-preset",
  });
  assert.deepEqual(doc.main, {
    provider: "openai",
    model: "gpt-4.1",
    reasoningEffort: "medium",
  });
  assert.deepEqual(doc.sub, {
    provider: "ollama",
    model: "llama3.2",
    reasoningEffort: "",
  });
  assert.equal(doc.presets.length, 2);
  assert.equal(doc.presets[0]!.id, "fast-pair");
  assert.equal(doc.presets[0]!.name, "Fast pair");
  assert.equal(doc.presets[1]!.id, "dup");
  assert.equal(doc.presets[1]!.name, "First");
  assert.equal(doc.activePresetId, undefined);
});

test("sanitize helpers fail closed for secret-looking slots and names", () => {
  assert.deepEqual(sanitizeModelSlot({
    provider: "api_key",
    model: "x",
    reasoningEffort: "high",
  }), { provider: "", model: "", reasoningEffort: "" });
  assert.equal(sanitizePresetName(""), undefined);
  assert.equal(sanitizePresetName("  bearer token  "), undefined);
  assert.equal(sanitizePresetName("  Balanced  "), "Balanced");
  assert.equal(sanitizeChatModelPreset({
    id: "ok",
    name: "Ok",
    main: { provider: "openai", model: "gpt", reasoningEffort: "high" },
    sub: { provider: "", model: "", reasoningEffort: "" },
  })?.name, "Ok");
  assert.equal(sanitizeChatModelPreset({ id: "x", name: "", main: {}, sub: {} }), undefined);
  assert.deepEqual(sanitizePresetList("nope"), []);
});

test("selecting a preset main drives resolvedCreateModelPrefs and modelSlashCommand", () => {
  const presetMain = {
    provider: "openrouter",
    model: "anthropic/claude",
    reasoningEffort: "high",
  };
  assert.deepEqual(resolvedCreateModelPrefs(presetMain), presetMain);
  assert.equal(
    modelSlashCommand(presetMain),
    "/model anthropic/claude --provider openrouter --session",
  );
  // Manual main stored on a preset still strips the UI sentinel for wire paths.
  assert.equal(
    modelSlashCommand({
      provider: CHAT_MODEL_MANUAL_PROVIDER,
      model: "openrouter:fast-model",
      reasoningEffort: "",
    }),
    "/model fast-model --provider openrouter --session",
  );
  // Sub slot is client-only metadata: resolving it must not invent wire side effects.
  const sub = resolvedCreateModelPrefs({
    provider: "ollama",
    model: "llama3.2",
    reasoningEffort: "low",
  });
  assert.deepEqual(sub, {
    provider: "ollama",
    model: "llama3.2",
    reasoningEffort: "low",
  });
});

test("preset readout is derived from one unambiguous session-local main slot", () => {
  const session = { provider: "openai", model: "gpt", reasoningEffort: "high" };
  const preset = {
    id: "one", name: "One", main: session,
    sub: { provider: "", model: "", reasoningEffort: "" },
  };
  assert.equal(matchingChatModelPresetName([preset], session), "One");
  assert.equal(matchingChatModelPresetName([preset], { ...session, model: "other" }), undefined);
  assert.equal(matchingChatModelPresetName([
    preset,
    { ...preset, id: "two", name: "Two", sub: { provider: "ollama", model: "sub", reasoningEffort: "low" } },
  ], session), undefined);
});
