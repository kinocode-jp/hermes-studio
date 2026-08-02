/**
 * Fail-closed policy for Hermes dashboard CONFIG_SCHEMA fields.
 *
 * Stage-1 generic Advanced Config only exposes ordinary, non-secret,
 * non-execution-adjacent leaves. Decisions are based primarily on field id
 * prefixes/tokens so Hermes category merges (checkpoints/cron/skills → agent)
 * cannot bypass denials.
 */

import {
  PROFILE_CONFIG_MAX_FIELDS,
  PROFILE_CONFIG_MAX_OPTIONS,
  PROFILE_CONFIG_MAX_STRING_UTF8_BYTES,
} from "@hermes-studio/protocol";
import { isLikelySecretIdentifier } from "./secret-scrubber.js";

/** Field types Hermes 0.18.2 schema may emit; bool is normalized to boolean. */
export type HermesConfigFieldType = "boolean" | "number" | "string" | "select" | "list";

/**
 * Privileged surface may additionally project a bounded JSON leaf when the live
 * value is an object/nested-list that cannot use the string-list editor.
 */
export type HermesPrivilegedFieldType = HermesConfigFieldType | "json";

export type HermesConfigFieldPolicyDecision =
  | { allowed: true; type: HermesConfigFieldType }
  | { allowed: false; reason: "category" | "path" | "type" | "identifier" | "budget" | "secret" };

export type HermesPrivilegedFieldPolicyDecision =
  | { allowed: true; type: HermesConfigFieldType }
  | { allowed: false; reason: "type" | "identifier" | "secret" | "safe" };

/**
 * Categories that may host ordinary settings after field-id denials.
 * Trees such as terminal/auxiliary/delegation/moa/curator/kanban/sessions/
 * bedrock are intentionally absent even when Hermes merges other roots into
 * `agent`/`general` — those merged ids are still denied by field-id prefix.
 */
export const SAFE_CONFIG_CATEGORIES: ReadonlySet<string> = new Set([
  "general",
  "agent",
  "display",
  "memory",
  "compression",
  "browser",
  "voice",
  "tts",
  "stt",
  "logging",
  "tool_output",
  "tool_loop_guardrails",
  "streaming",
  "model_catalog",
  "openrouter",
  "tools",
  "web",
  "lsp",
  "x_search",
]);

/**
 * Exact field ids that must never appear on the generic surface.
 * Includes Hermes 0.18.2 ordinary-looking but unsafe assignments.
 */
const DENIED_EXACT_FIELDS: ReadonlySet<string> = new Set([
  // Root execution / model / toolset assignment surfaces
  "model",
  "model_context_length",
  "fallback_providers",
  "toolsets",
  "agent.disabled_toolsets",
  "command_allowlist",
  "hooks_auto_accept",
  "prefill_messages_file",
  "code_execution.mode",
  "network.force_ipv4",
  // Approvals / skill guardrails
  "memory.write_approval",
  "skills.write_approval",
  "skills.guard_agent_created",
  "skills.external_dirs",
  "skills.inline_shell",
  "skills.inline_shell_timeout",
  // Browser execution-adjacent
  "browser.allow_private_urls",
  "browser.cdp_url",
  "browser.allow_unsafe_evaluate",
  "browser.record_sessions",
  "browser.auto_local_for_private_urls",
  // TTS local path / device binding
  "tts.gemini.persona_prompt_file",
  "tts.neutts.ref_audio",
  "tts.neutts.ref_text",
  "tts.neutts.device",
  // Install / catalog host pointers
  "lsp.install_strategy",
  "model_catalog.url",
  // Web backend routing (execution-adjacent provider selection)
  "web.backend",
  "web.search_backend",
  "web.extract_backend",
]);

/**
 * Field-id prefixes (exact or `prefix.`). Prefer id-prefix over schema category
 * so merged categories cannot reintroduce denied trees.
 */
const DENIED_PATH_PREFIXES: readonly string[] = [
  // Stage-1 whole-tree exclusions
  "terminal",
  "auxiliary",
  "delegation",
  "moa",
  "curator",
  "kanban",
  "cron",
  "checkpoints",
  "sessions",
  "bedrock",
  "computer_use",
  // Secrets / auth / host / messaging / destructive
  "providers",
  "custom_providers",
  "secrets",
  "security",
  "approvals",
  "gateway",
  "network",
  "desktop",
  "vertex",
  "dashboard.basic_auth",
  "dashboard.oauth",
  "dashboard.drain_auth",
  "hooks",
  "code_execution",
  "discord",
  "slack",
  "telegram",
  "mattermost",
  "matrix",
  "updates",
  // Explicit nested denials
  "browser.camofox",
  "skills.external_dirs",
  "skills.inline_shell",
  "skills.guard_agent_created",
  "skills.write_approval",
  "memory.write_approval",
  "tts.neutts.ref_audio",
  "tts.neutts.ref_text",
  "tts.neutts.device",
  "tts.gemini.persona_prompt_file",
  "command_allowlist",
  "hooks_auto_accept",
  "fallback_providers",
  "toolsets",
  "agent.disabled_toolsets",
  "prefill_messages_file",
  "model_catalog.url",
  "lsp.install_strategy",
];

/**
 * Denied multi-segment substrings and underscore tokens (api_key, basic_auth, …)
 * plus approval-family markers that must fail closed regardless of category.
 */
const DENIED_PATH_SUBSTRINGS: readonly string[] = [
  "api_key",
  "basic_auth",
  "command_allowlist",
  "hooks_auto_accept",
  "write_approval",
  "auto_approve",
  "access_token",
  "base_url",
];

/**
 * Denied path segments (split on `.` and `_`). Short tokens use exact segment
 * match so `max_tokens` and `environment_hint` are not false-positives.
 */
const DENIED_PATH_SEGMENTS: readonly string[] = [
  "token",
  "secret",
  "password",
  "credential",
  "credentials",
  "auth",
  "approval",
  "approvals",
  "cwd",
  "volumes",
  "volume",
  "shell",
  "backend",
  "command",
  "commands",
  "hook",
  "hooks",
];

/** Segment suffix markers for local paths, files, dirs, URLs, images, env lists. */
const DENIED_SEGMENT_SUFFIXES: readonly string[] = [
  "_path",
  "_paths",
  "_file",
  "_files",
  "_dir",
  "_dirs",
  "_url",
  "_urls",
  "_image",
  "_images",
  "_env",
  "_envs",
];

const FIELD_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}(?:\.[A-Za-z][A-Za-z0-9_]{0,63}){0,7}$/;
const CATEGORY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function normalizeHermesConfigFieldType(value: unknown): HermesConfigFieldType | undefined {
  if (value === "boolean" || value === "bool") return "boolean";
  if (value === "number") return "number";
  if (value === "string") return "string";
  if (value === "select") return "select";
  if (value === "list") return "list";
  return undefined;
}

export function isSafeConfigFieldId(fieldId: string): boolean {
  return FIELD_ID_PATTERN.test(fieldId);
}

export function evaluateHermesConfigFieldPolicy(
  fieldId: string,
  category: string,
  type: unknown,
): HermesConfigFieldPolicyDecision {
  if (!isSafeConfigFieldId(fieldId) || fieldId.length > 200) {
    return { allowed: false, reason: "identifier" };
  }
  // Field-id denials first — independent of Hermes category merge.
  if (
    DENIED_EXACT_FIELDS.has(fieldId)
    || pathMatchesDeniedPrefix(fieldId)
    || pathHasDeniedToken(fieldId)
    || pathLooksLikeLocalOrExecutionBinding(fieldId)
  ) {
    return { allowed: false, reason: "path" };
  }
  if (isLikelySecretIdentifier(fieldId) || fieldId.split(".").some((segment) => isLikelySecretIdentifier(segment))) {
    return { allowed: false, reason: "path" };
  }
  if (typeof category !== "string" || !CATEGORY_PATTERN.test(category) || !SAFE_CONFIG_CATEGORIES.has(category)) {
    return { allowed: false, reason: "category" };
  }
  const normalizedType = normalizeHermesConfigFieldType(type);
  if (normalizedType === undefined) return { allowed: false, reason: "type" };
  return { allowed: true, type: normalizedType };
}

/**
 * Secret-bearing config leaves: credential material only. Boolean toggles and
 * env-var *names* (…_env) stay on the privileged non-secret surface.
 */
export function isHermesConfigSecretField(fieldId: string, type?: unknown): boolean {
  if (!isSafeConfigFieldId(fieldId)) return false;
  const normalizedType = type === undefined ? undefined : normalizeHermesConfigFieldType(type);
  if (normalizedType === "boolean" || normalizedType === "number" || normalizedType === "list") {
    return false;
  }
  const lower = fieldId.toLowerCase();
  if (
    lower.includes("redact_secrets")
    || lower.endsWith("_env")
    || lower.endsWith(".enabled")
    || lower.includes("min_secret")
    || lower.includes("cache_ttl")
    || lower.includes("override_existing")
    || lower.includes("auto_install")
    || lower.includes("project_id")
    || lower.includes("token_analytics")
    || lower.includes("max_tokens")
  ) {
    return false;
  }
  const parts = lower.split(/[._]/).filter(Boolean);
  const leaf = parts[parts.length - 1] ?? "";
  if (
    leaf === "api_key"
    || leaf === "password"
    || leaf === "password_hash"
    || leaf === "client_secret"
    || leaf === "access_token"
    || leaf === "session_key"
    || leaf === "secret"
  ) {
    return true;
  }
  // Bare "token" leaf is secret only when not a budget/counter path.
  if (leaf === "token" && !parts.some((part) => part.includes("max") || part.includes("analytics"))) {
    return true;
  }
  if (isLikelySecretIdentifier(fieldId) || parts.some((segment) => isLikelySecretIdentifier(segment))) {
    return true;
  }
  return false;
}

/**
 * Privileged non-secret surface: fields denied by stage-1 safe policy that still
 * have a supported scalar/list schema type and are not secret-bearing.
 * Secret leaves are never allowed here (use the secret metadata + transfer path).
 */
export function evaluatePrivilegedHermesConfigFieldPolicy(
  fieldId: string,
  category: string,
  type: unknown,
): HermesPrivilegedFieldPolicyDecision {
  if (!isSafeConfigFieldId(fieldId) || fieldId.length > 200) {
    return { allowed: false, reason: "identifier" };
  }
  if (typeof category !== "string" || !CATEGORY_PATTERN.test(category)) {
    return { allowed: false, reason: "identifier" };
  }
  if (isHermesConfigSecretField(fieldId, type)) {
    return { allowed: false, reason: "secret" };
  }
  const safe = evaluateHermesConfigFieldPolicy(fieldId, category, type);
  if (safe.allowed) {
    // Safe Advanced already owns these leaves.
    return { allowed: false, reason: "safe" };
  }
  const normalizedType = normalizeHermesConfigFieldType(type);
  if (normalizedType === undefined) {
    // object / unknown schema types may still become json via live-value projection.
    return { allowed: false, reason: "type" };
  }
  return { allowed: true, type: normalizedType };
}

/**
 * Restart / new-session impact hints for destructive UI confirmation.
 * Category-based; never leaks values.
 */
export type PrivilegedConfigImpact = "new-session" | "restart" | "destructive";

export function privilegedConfigFieldImpact(fieldId: string, category: string): PrivilegedConfigImpact {
  const lower = fieldId.toLowerCase();
  const cat = category.toLowerCase();
  if (
    cat === "terminal"
    || cat === "code_execution"
    || cat === "gateway"
    || cat === "network"
    || cat === "bedrock"
    || cat === "desktop"
    || cat === "computer_use"
    || lower.startsWith("terminal.")
    || lower.startsWith("code_execution.")
    || lower.startsWith("gateway.")
    || lower.startsWith("network.")
    || lower.startsWith("bedrock.")
  ) {
    return "restart";
  }
  if (
    cat === "approvals"
    || cat === "security"
    || cat === "secrets"
    || cat === "hooks"
    || lower.includes("write_approval")
    || lower.includes("auto_approve")
    || lower.includes("command_allowlist")
    || lower === "model"
    || lower === "toolsets"
    || lower.startsWith("skills.")
  ) {
    return "destructive";
  }
  return "new-session";
}

/** True when a privileged save should require explicit UI confirmation. */
export function privilegedConfigRequiresConfirmation(fieldId: string, category: string): boolean {
  const impact = privilegedConfigFieldImpact(fieldId, category);
  return impact === "restart" || impact === "destructive";
}

export function pathMatchesDeniedPrefix(fieldId: string): boolean {
  for (const prefix of DENIED_PATH_PREFIXES) {
    if (fieldId === prefix || fieldId.startsWith(`${prefix}.`)) return true;
  }
  return false;
}

export function pathHasDeniedToken(fieldId: string): boolean {
  const lower = fieldId.toLowerCase();
  for (const token of DENIED_PATH_SUBSTRINGS) {
    if (lower.includes(token)) return true;
  }
  const parts = lower.split(/[._]/).filter(Boolean);
  for (const token of DENIED_PATH_SEGMENTS) {
    if (parts.includes(token)) return true;
  }
  // env as a whole segment (env_passthrough) without matching "environment".
  if (parts.includes("env")) return true;
  return false;
}

/**
 * Local path / external connection / execution-shaped field ids.
 * Uses suffix markers rather than bare `file` segments so ordinary counters
 * like `file_read_max_chars` remain available when not on an explicit deny list.
 */
export function pathLooksLikeLocalOrExecutionBinding(fieldId: string): boolean {
  const lower = fieldId.toLowerCase();
  const dotted = lower.split(".");
  for (const segment of dotted) {
    for (const suffix of DENIED_SEGMENT_SUFFIXES) {
      if (segment === suffix.slice(1) || segment.endsWith(suffix)) return true;
    }
    // docker/ssh style image names without _image suffix
    if (segment === "image" || segment.endsWith("_image")) return true;
  }
  // Common non-suffixed execution bindings in Hermes 0.18.2
  if (lower === "terminal.cwd" || lower.endsWith(".cwd")) return true;
  if (lower.includes("docker_volumes") || lower.includes("docker_extra_args") || lower.includes("env_passthrough")) {
    return true;
  }
  if (lower.includes("shell_init") || lower.includes("persistent_shell") || lower.includes("inline_shell")) {
    return true;
  }
  return false;
}

export function clampHermesSchemaFieldCount(count: number): number {
  return Math.min(Math.max(0, Math.trunc(count)), PROFILE_CONFIG_MAX_FIELDS);
}

export function clampHermesSchemaOptions(count: number): number {
  return Math.min(Math.max(0, Math.trunc(count)), PROFILE_CONFIG_MAX_OPTIONS);
}

export function isPublicConfigDescription(value: string): boolean {
  return !value.includes("\0")
    && Buffer.byteLength(value) <= PROFILE_CONFIG_MAX_STRING_UTF8_BYTES
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

/**
 * Hermes 0.18.2 `hermes_cli/web_server._infer_type(None)` returns `"string"`.
 * These DEFAULT_CONFIG null leaves are optional numbers (or other non-strings)
 * in practice. Fixtures for value-aware type resolution tests; path-denied
 * entries (kanban/cron) remain denied by field-id policy regardless.
 */
export const HERMES_0182_NULL_INFERRED_STRING_FIELDS: readonly {
  id: string;
  trueType: "number";
  category: string;
}[] = [
  { id: "max_concurrent_sessions", trueType: "number", category: "general" },
  { id: "context_file_max_chars", trueType: "number", category: "general" },
  { id: "kanban.max_in_progress_per_profile", trueType: "number", category: "kanban" },
  { id: "cron.max_parallel_jobs", trueType: "number", category: "cron" },
];

/**
 * Representative dangerous Hermes 0.18.2 DEFAULT_CONFIG / schema field ids.
 * Used by tests to lock fail-closed coverage independent of category merge.
 */
export const HERMES_0182_DANGEROUS_CONFIG_FIELDS: readonly string[] = [
  "model",
  "model_context_length",
  "fallback_providers",
  "toolsets",
  "agent.disabled_toolsets",
  "command_allowlist",
  "hooks_auto_accept",
  "prefill_messages_file",
  "terminal.backend",
  "terminal.cwd",
  "terminal.env_passthrough",
  "terminal.shell_init_files",
  "terminal.docker_image",
  "terminal.docker_volumes",
  "terminal.docker_extra_args",
  "terminal.docker_forward_env",
  "terminal.persistent_shell",
  "auxiliary.vision.api_key",
  "auxiliary.vision.base_url",
  "auxiliary.compression.api_key",
  "delegation.api_key",
  "delegation.base_url",
  "delegation.subagent_auto_approve",
  "moa.trace_dir",
  "moa.presets.default.aggregator.provider",
  "curator.enabled",
  "kanban.dispatch_in_gateway",
  "cron.provider",
  "cron.chronos.portal_url",
  "checkpoints.enabled",
  "checkpoints.auto_prune",
  "sessions.auto_prune",
  "bedrock.region",
  "skills.external_dirs",
  "skills.inline_shell",
  "skills.write_approval",
  "skills.guard_agent_created",
  "memory.write_approval",
  "browser.allow_private_urls",
  "browser.cdp_url",
  "browser.allow_unsafe_evaluate",
  "browser.record_sessions",
  "browser.camofox.user_id",
  "browser.camofox.session_key",
  "browser.camofox.managed_persistence",
  "tts.gemini.persona_prompt_file",
  "tts.neutts.ref_audio",
  "tts.neutts.ref_text",
  "tts.neutts.device",
  "lsp.install_strategy",
  "model_catalog.url",
  "security.allow_private_urls",
  "approvals.mode",
  "gateway.strict",
  "network.force_ipv4",
  "code_execution.mode",
  "dashboard.basic_auth.password",
  "dashboard.oauth.client_id",
  "updates.pre_update_backup",
  "desktop.disable_gpu",
  "vertex.project_id",
  "providers",
  "custom_providers",
  "web.backend",
  "web.search_backend",
];
