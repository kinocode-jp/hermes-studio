import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateHermesConfigFieldPolicy,
  evaluatePrivilegedHermesConfigFieldPolicy,
  HERMES_0182_DANGEROUS_CONFIG_FIELDS,
  HERMES_0182_NULL_INFERRED_STRING_FIELDS,
  isHermesConfigSecretField,
  pathHasDeniedToken,
  pathLooksLikeLocalOrExecutionBinding,
  pathMatchesDeniedPrefix,
  privilegedConfigRequiresConfirmation,
  SAFE_CONFIG_CATEGORIES,
} from "./hermes-config-policy.js";
import { resolveHermesConfigEditableType } from "./hermes-config.js";

test("safe categories allow ordinary agent and display fields", () => {
  assert.equal(evaluateHermesConfigFieldPolicy("agent.max_turns", "agent", "number").allowed, true);
  assert.equal(evaluateHermesConfigFieldPolicy("agent.api_max_retries", "agent", "number").allowed, true);
  assert.equal(evaluateHermesConfigFieldPolicy("agent.gateway_timeout", "agent", "number").allowed, true);
  assert.equal(evaluateHermesConfigFieldPolicy("agent.task_completion_guidance", "agent", "boolean").allowed, true);
  assert.equal(evaluateHermesConfigFieldPolicy("display.compact", "display", "boolean").allowed, true);
  assert.equal(evaluateHermesConfigFieldPolicy("logging.level", "logging", "select").allowed, true);
  assert.equal(evaluateHermesConfigFieldPolicy("compression.enabled", "compression", "bool").allowed, true);
  assert.equal(evaluateHermesConfigFieldPolicy("memory.memory_enabled", "memory", "boolean").allowed, true);
  assert.equal(evaluateHermesConfigFieldPolicy("memory.memory_char_limit", "memory", "number").allowed, true);
  assert.equal(evaluateHermesConfigFieldPolicy("tool_output.max_bytes", "tool_output", "number").allowed, true);
  assert.equal(evaluateHermesConfigFieldPolicy("tool_loop_guardrails.warnings_enabled", "tool_loop_guardrails", "boolean").allowed, true);
  assert.equal(evaluateHermesConfigFieldPolicy("human_delay.mode", "display", "select").allowed, true);
  assert.equal(evaluateHermesConfigFieldPolicy("voice.auto_tts", "voice", "boolean").allowed, true);
  assert.equal(evaluateHermesConfigFieldPolicy("web.extract_char_limit", "web", "number").allowed, true);
  assert.equal(evaluateHermesConfigFieldPolicy("streaming.edit_interval", "streaming", "number").allowed, true);
  assert.equal(evaluateHermesConfigFieldPolicy("goals.max_turns", "agent", "number").allowed, true);
  // Ordinary budgets that contain "file" as a word but are not path bindings.
  assert.equal(evaluateHermesConfigFieldPolicy("context_file_max_chars", "general", "string").allowed, true);
  assert.equal(evaluateHermesConfigFieldPolicy("file_read_max_chars", "general", "number").allowed, true);
});

test("stage-1 whole trees are absent from safe categories and denied by field id", () => {
  for (const category of [
    "terminal",
    "auxiliary",
    "delegation",
    "moa",
    "curator",
    "kanban",
    "sessions",
    "bedrock",
    "security",
    "secrets",
    "gateway",
    "desktop",
    "discord",
    "vertex",
  ]) {
    assert.equal(SAFE_CONFIG_CATEGORIES.has(category), false, category);
  }
  assert.equal(pathMatchesDeniedPrefix("terminal.timeout"), true);
  assert.equal(pathMatchesDeniedPrefix("auxiliary.vision.timeout"), true);
  assert.equal(pathMatchesDeniedPrefix("delegation.max_iterations"), true);
  assert.equal(pathMatchesDeniedPrefix("moa.save_traces"), true);
  assert.equal(pathMatchesDeniedPrefix("curator.enabled"), true);
  assert.equal(pathMatchesDeniedPrefix("kanban.auto_decompose"), true);
  assert.equal(pathMatchesDeniedPrefix("sessions.retention_days"), true);
  assert.equal(pathMatchesDeniedPrefix("bedrock.region"), true);
});

test("credential tokens are denied without treating max_tokens as a secret", () => {
  assert.equal(pathHasDeniedToken("auxiliary.vision.api_key"), true);
  assert.equal(pathHasDeniedToken("delegation.api_key"), true);
  assert.equal(pathHasDeniedToken("dashboard.basic_auth.password"), true);
  assert.equal(pathHasDeniedToken("show_token_analytics"), true);
  assert.equal(pathHasDeniedToken("agent.max_turns"), false);
  // max_tokens is not a secret token field; the moa tree is denied by prefix instead.
  assert.equal(pathHasDeniedToken("presets.default.max_tokens"), false);
  assert.equal(evaluateHermesConfigFieldPolicy("moa.presets.default.max_tokens", "moa", "number").allowed, false);
});

test("approval and write_approval markers fail closed on field id", () => {
  assert.equal(evaluateHermesConfigFieldPolicy("memory.write_approval", "memory", "boolean").allowed, false);
  assert.equal(evaluateHermesConfigFieldPolicy("skills.write_approval", "agent", "boolean").allowed, false);
  assert.equal(evaluateHermesConfigFieldPolicy("delegation.subagent_auto_approve", "delegation", "boolean").allowed, false);
  assert.equal(evaluateHermesConfigFieldPolicy("approvals.mode", "security", "select").allowed, false);
  assert.equal(pathHasDeniedToken("memory.write_approval"), true);
  assert.equal(pathHasDeniedToken("skills.write_approval"), true);
  assert.equal(pathHasDeniedToken("foo.auto_approve"), true);
});

test("Hermes category merge cannot bypass field-id denials", () => {
  // These roots are merged into agent/general in Hermes schema, but Office
  // must still refuse them by field-id prefix / exact id.
  const merged = [
    ["cron.provider", "agent", "string"],
    ["cron.wrap_response", "agent", "boolean"],
    ["checkpoints.auto_prune", "agent", "boolean"],
    ["checkpoints.enabled", "agent", "boolean"],
    ["skills.write_approval", "agent", "boolean"],
    ["skills.guard_agent_created", "agent", "boolean"],
    ["skills.external_dirs", "agent", "list"],
    ["skills.inline_shell", "agent", "boolean"],
    ["updates.pre_update_backup", "general", "boolean"],
    ["computer_use.cua_telemetry", "agent", "boolean"],
  ] as const;

  for (const [id, category, type] of merged) {
    assert.equal(
      evaluateHermesConfigFieldPolicy(id, category, type).allowed,
      false,
      id,
    );
  }
});

test("model assignment, toolsets, and listed stage-1 denials are excluded", () => {
  const denied = [
    ["model", "general", "string"],
    ["model_context_length", "general", "number"],
    ["fallback_providers", "general", "list"],
    ["toolsets", "general", "list"],
    ["agent.disabled_toolsets", "agent", "list"],
    ["browser.record_sessions", "browser", "boolean"],
    ["browser.camofox.user_id", "browser", "string"],
    ["browser.allow_private_urls", "browser", "boolean"],
    ["browser.cdp_url", "browser", "string"],
    ["browser.allow_unsafe_evaluate", "browser", "boolean"],
    ["tts.gemini.persona_prompt_file", "tts", "string"],
    ["tts.neutts.ref_audio", "tts", "string"],
    ["tts.neutts.ref_text", "tts", "string"],
    ["tts.neutts.device", "tts", "string"],
    ["lsp.install_strategy", "lsp", "string"],
    ["model_catalog.url", "model_catalog", "string"],
    ["prefill_messages_file", "general", "string"],
    ["web.backend", "web", "string"],
  ] as const;

  for (const [id, category, type] of denied) {
    assert.equal(
      evaluateHermesConfigFieldPolicy(id, category, type).allowed,
      false,
      id,
    );
  }
});

test("path/file/dir/url/cwd/volumes/env/image/shell bindings are denied", () => {
  assert.equal(pathLooksLikeLocalOrExecutionBinding("terminal.cwd"), true);
  assert.equal(pathLooksLikeLocalOrExecutionBinding("moa.trace_dir"), true);
  assert.equal(pathLooksLikeLocalOrExecutionBinding("tts.gemini.persona_prompt_file"), true);
  assert.equal(pathLooksLikeLocalOrExecutionBinding("model_catalog.url"), true);
  assert.equal(pathLooksLikeLocalOrExecutionBinding("terminal.docker_image"), true);
  assert.equal(pathLooksLikeLocalOrExecutionBinding("terminal.docker_volumes"), true);
  assert.equal(pathLooksLikeLocalOrExecutionBinding("terminal.env_passthrough"), true);
  assert.equal(pathLooksLikeLocalOrExecutionBinding("skills.inline_shell"), true);
  // Ordinary numeric budgets are not treated as path bindings.
  assert.equal(pathLooksLikeLocalOrExecutionBinding("context_file_max_chars"), false);
  assert.equal(pathLooksLikeLocalOrExecutionBinding("file_read_max_chars"), false);
  assert.equal(pathLooksLikeLocalOrExecutionBinding("agent.environment_hint"), false);
});

test("Hermes 0.18.2 dangerous field fixture is entirely fail-closed", () => {
  for (const id of HERMES_0182_DANGEROUS_CONFIG_FIELDS) {
    // Category is intentionally the optimistic/merged value Hermes may report.
    const category = id.includes(".") ? id.split(".")[0]! : "general";
    const decision = evaluateHermesConfigFieldPolicy(id, category, "string");
    assert.equal(decision.allowed, false, id);
  }
});

test("unknown field types and bad identifiers are rejected", () => {
  assert.equal(evaluateHermesConfigFieldPolicy("agent.max_turns", "agent", "object").allowed, false);
  assert.equal(evaluateHermesConfigFieldPolicy("../etc/passwd", "agent", "string").allowed, false);
  assert.equal(evaluateHermesConfigFieldPolicy("agent..max", "agent", "number").allowed, false);
});

test("privileged policy allows stage-1 denied non-secrets and blocks secret leaves", () => {
  assert.equal(evaluatePrivilegedHermesConfigFieldPolicy("terminal.timeout", "terminal", "number").allowed, true);
  assert.equal(evaluatePrivilegedHermesConfigFieldPolicy("model", "general", "string").allowed, true);
  assert.equal(evaluatePrivilegedHermesConfigFieldPolicy("approvals.mode", "approvals", "select").allowed, true);
  assert.equal(evaluatePrivilegedHermesConfigFieldPolicy("agent.max_turns", "agent", "number").allowed, false);
  assert.equal(evaluatePrivilegedHermesConfigFieldPolicy("auxiliary.vision.api_key", "auxiliary", "string").allowed, false);
  assert.equal(isHermesConfigSecretField("auxiliary.vision.api_key", "string"), true);
  assert.equal(isHermesConfigSecretField("security.redact_secrets", "boolean"), false);
  assert.equal(privilegedConfigRequiresConfirmation("terminal.backend", "terminal"), true);
  assert.equal(privilegedConfigRequiresConfirmation("display.compact", "display"), false);
});

test("Hermes 0.18.2 null-default fixture matches _infer_type(None)→string failure mode", () => {
  // Source: hermes_cli/config.py DEFAULT_CONFIG + web_server._infer_type.
  for (const fixture of HERMES_0182_NULL_INFERRED_STRING_FIELDS) {
    // Schema alone still labels them string (Hermes bug). Policy may allow the
    // general ones; value-aware resolution must deny null and retype live numbers.
    assert.equal(resolveHermesConfigEditableType("string", null), undefined, fixture.id);
    assert.equal(resolveHermesConfigEditableType("string", 4), "number", fixture.id);
    if (fixture.category === "kanban" || fixture.category === "cron") {
      assert.equal(
        evaluateHermesConfigFieldPolicy(fixture.id, fixture.category, "string").allowed,
        false,
        fixture.id,
      );
    } else {
      // Ordinary general leaves pass path policy; type gate handles ambiguity.
      assert.equal(
        evaluateHermesConfigFieldPolicy(fixture.id, fixture.category, "string").allowed,
        true,
        fixture.id,
      );
    }
  }
});
