/**
 * Schema-driven privileged Hermes profile config (owner + desktop-capability).
 * Complements stage-1 safe Advanced config with previously excluded non-secret
 * leaves. Secrets are never projected here.
 */

import { createHash } from "node:crypto";
import {
  PRIVILEGED_CONFIG_MAX_CHANGES,
  PRIVILEGED_CONFIG_MAX_FIELDS,
  PRIVILEGED_CONFIG_MAX_JSON_UTF8_BYTES,
  PROFILE_CONFIG_MAX_LIST_ITEM_UTF8_BYTES,
  PROFILE_CONFIG_MAX_LIST_ITEMS,
  PROFILE_CONFIG_MAX_NEST_DEPTH,
  PROFILE_CONFIG_MAX_OPTIONS,
  PROFILE_CONFIG_MAX_STRING_UTF8_BYTES,
} from "@hermes-studio/protocol";
import {
  clampHermesSchemaFieldCount,
  clampHermesSchemaOptions,
  evaluatePrivilegedHermesConfigFieldPolicy,
  isHermesConfigSecretField,
  isPublicConfigDescription,
  isSafeConfigFieldId,
  normalizeHermesConfigFieldType,
  privilegedConfigFieldImpact,
  privilegedConfigRequiresConfirmation,
  type HermesConfigFieldType,
  type HermesPrivilegedFieldType,
  type PrivilegedConfigImpact,
} from "./hermes-config-policy.js";
import {
  getDottedPath,
  resolveHermesConfigEditableType,
  type HermesConfigValue,
} from "./hermes-config.js";
import { containsLikelySecret, redactSecrets } from "./secret-scrubber.js";

export type HermesPrivilegedConfigValue = HermesConfigValue | unknown;

export interface HermesPrivilegedFieldOptionDto {
  value: string;
  label: string;
}

export interface HermesPrivilegedFieldDto {
  id: string;
  category: string;
  type: HermesPrivilegedFieldType;
  description: string;
  options: HermesPrivilegedFieldOptionDto[];
  impact: PrivilegedConfigImpact;
  requiresConfirmation: boolean;
}

export interface HermesPrivilegedConfigDto {
  profile: string;
  revision: string;
  categories: string[];
  fields: HermesPrivilegedFieldDto[];
  values: Record<string, HermesPrivilegedConfigValue>;
  /** Leaves not projectable on this surface (shape/type ambiguity). */
  unsupportedCount: number;
  /** Secret-bearing leaves withheld (metadata-only on secrets surface). */
  secretFieldCount: number;
}

export interface HermesPrivilegedConfigPatch {
  expectedRevision: string;
  changes: Record<string, HermesPrivilegedConfigValue>;
  /** Required when any changed field has requiresConfirmation. */
  confirmed?: boolean;
}

export class HermesPrivilegedConfigError extends Error {
  readonly code: "conflict" | "invalid_request" | "not_found" | "rejected" | "response_too_large" | "timed_out";
  constructor(code: HermesPrivilegedConfigError["code"], message: string) {
    super(message);
    this.name = "HermesPrivilegedConfigError";
    this.code = code;
  }
}

/**
 * Project privileged non-secret leaves from live Hermes schema + config.
 * Does not include stage-1 safe leaves or secret-bearing fields.
 */
export function projectPrivilegedHermesConfig(
  schemaRaw: unknown,
  configRaw: unknown,
  categoryOrderFallback: readonly string[] = [],
): Omit<HermesPrivilegedConfigDto, "profile"> {
  if (!isRecord(schemaRaw) || !isRecord(configRaw)) throw invalidBackend();
  const fieldsRaw = schemaRaw.fields;
  if (!isRecord(fieldsRaw)) throw invalidBackend();
  const orderRaw = Array.isArray(schemaRaw.category_order)
    ? schemaRaw.category_order
    : categoryOrderFallback;

  const entries = Object.entries(fieldsRaw).slice(0, PRIVILEGED_CONFIG_MAX_FIELDS * 2);
  const fields: HermesPrivilegedFieldDto[] = [];
  const values: Record<string, HermesPrivilegedConfigValue> = {};
  let unsupportedCount = 0;
  let secretFieldCount = 0;
  let overflow = Math.max(0, Object.keys(fieldsRaw).length - entries.length);

  for (const [id, meta] of entries) {
    if (fields.length >= PRIVILEGED_CONFIG_MAX_FIELDS) {
      overflow += 1;
      continue;
    }
    if (!isRecord(meta)) {
      unsupportedCount += 1;
      continue;
    }
    const category = typeof meta.category === "string" ? meta.category : "";
    if (isHermesConfigSecretField(id, meta.type)) {
      secretFieldCount += 1;
      continue;
    }

    const decision = evaluatePrivilegedHermesConfigFieldPolicy(id, category, meta.type);
    const rawValue = getDottedPath(configRaw, id);
    const description = sanitizePublicText(meta.description, 2_000) ?? id;
    if (!isPublicConfigDescription(description)) {
      unsupportedCount += 1;
      continue;
    }

    if (decision.allowed) {
      const resolved = resolvePrivilegedEditableType(decision.type, rawValue);
      if (resolved === undefined) {
        // Explicit null + ambiguous schema (Hermes None→string): JSON null editor.
        if (tryProjectExplicitNullJson(id, category, description, rawValue, fields, values)) {
          continue;
        }
        unsupportedCount += 1;
        continue;
      }
      const options = resolved === "select" ? normalizeOptions(meta.options) : [];
      const projected: HermesPrivilegedFieldDto = {
        id,
        category,
        type: resolved,
        description,
        options,
        impact: privilegedConfigFieldImpact(id, category),
        requiresConfirmation: privilegedConfigRequiresConfirmation(id, category),
      };
      if (resolved === "list" && (rawValue === null || rawValue === undefined)) {
        fields.push(projected);
        values[id] = [];
        continue;
      }
      const normalized = normalizeOutboundValue(rawValue, projected);
      if (normalized === undefined && rawValue !== undefined && rawValue !== null) {
        unsupportedCount += 1;
        continue;
      }
      fields.push(projected);
      if (normalized !== undefined) values[id] = normalized;
      continue;
    }

    // Safe-owned leaves that Advanced cannot type (explicit null + Hermes
    // null→string inference) are not "skipped because safe" — promote to JSON.
    if (decision.reason === "safe") {
      const schemaType = normalizeHermesConfigFieldType(meta.type);
      if (
        schemaType !== undefined
        && rawValue === null
        && resolveHermesConfigEditableType(schemaType, rawValue) === undefined
      ) {
        if (tryProjectExplicitNullJson(id, category, description, rawValue, fields, values)) {
          continue;
        }
      }
      // Truly owned by Advanced (typed live value or missing path) — omit.
      continue;
    }
    if (decision.reason === "secret") {
      secretFieldCount += 1;
      continue;
    }
    if (decision.reason === "identifier") {
      unsupportedCount += 1;
      continue;
    }

    // Schema type denied (e.g. object) or other non-safe shapes: bounded JSON
    // when live value validates (including explicit null).
    const jsonValue = projectJsonLeaf(rawValue, { allowNull: true });
    if (jsonValue === undefined && rawValue !== null) {
      unsupportedCount += 1;
      continue;
    }
    if (rawValue === null) {
      if (!tryProjectExplicitNullJson(id, category, description, rawValue, fields, values)) {
        unsupportedCount += 1;
      }
      continue;
    }
    if (jsonValue === undefined) {
      unsupportedCount += 1;
      continue;
    }
    fields.push({
      id,
      category,
      type: "json",
      description,
      options: [],
      impact: privilegedConfigFieldImpact(id, category),
      requiresConfirmation: true,
    });
    values[id] = jsonValue;
  }

  const presentCategories = new Set(fields.map((field) => field.category));
  const ordered = orderRaw
    .filter((item): item is string => typeof item === "string" && presentCategories.has(item));
  for (const category of presentCategories) {
    if (!ordered.includes(category)) ordered.push(category);
  }

  return {
    revision: revisionOfPrivilegedValues(values),
    categories: ordered,
    fields,
    values,
    unsupportedCount: clampHermesSchemaFieldCount(unsupportedCount + overflow),
    secretFieldCount: clampHermesSchemaFieldCount(secretFieldCount),
  };
}

export function validatePrivilegedConfigPatchChanges(
  changes: unknown,
  fields: readonly HermesPrivilegedFieldDto[],
): Record<string, HermesPrivilegedConfigValue> {
  if (!isRecord(changes)) throw invalid("Privileged config changes must be an object of dotted field updates.");
  const keys = Object.keys(changes);
  if (keys.length === 0) throw invalid("Privileged config changes must include at least one field.");
  if (keys.length > PRIVILEGED_CONFIG_MAX_CHANGES) throw invalid("Too many privileged config field changes in one request.");

  const byId = new Map(fields.map((field) => [field.id, field]));
  const clean: Record<string, HermesPrivilegedConfigValue> = {};
  for (const key of keys) {
    if (!isSafeConfigFieldId(key)) throw invalid(`Unknown or unsafe privileged config field: ${key}`);
    const field = byId.get(key);
    if (field === undefined) throw invalid(`Privileged config field is not editable: ${key}`);
    clean[key] = normalizeInboundValue(changes[key], field);
  }
  return clean;
}

export function buildPrivilegedHermesConfigPutBody(
  changes: Record<string, HermesPrivilegedConfigValue>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(changes)) {
    setPrivilegedDottedPath(body, path, value);
  }
  return body;
}

function setPrivilegedDottedPath(
  root: Record<string, unknown>,
  path: string,
  value: HermesPrivilegedConfigValue,
): void {
  if (!isSafeConfigFieldId(path)) throw invalid("Config field path is invalid.");
  const parts = path.split(".");
  if (parts.length > PROFILE_CONFIG_MAX_NEST_DEPTH) throw invalid("Config field path is too deep.");
  let current: Record<string, unknown> = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]!;
    const next = current[part];
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      current[part] = created;
      current = created;
      continue;
    }
    if (!isRecord(next)) throw invalid("Config field path collides with a non-object value.");
    current = next;
  }
  current[parts[parts.length - 1]!] = value;
}

export function revisionOfPrivilegedValues(values: Record<string, HermesPrivilegedConfigValue>): string {
  const keys = Object.keys(values).sort();
  const stable = keys.map((key) => [key, values[key]]);
  return createHash("sha256").update(stableStringify(stable)).digest("base64url");
}

/**
 * List secret-bearing config field metadata (no values).
 */
export function projectConfigSecretFieldMeta(
  schemaRaw: unknown,
  configRaw: unknown,
): Array<{
  key: string;
  source: "config";
  label: string;
  description: string;
  category: string;
  isSet: boolean;
  isPassword: true;
}> {
  if (!isRecord(schemaRaw) || !isRecord(configRaw)) throw invalidBackend();
  const fieldsRaw = schemaRaw.fields;
  if (!isRecord(fieldsRaw)) throw invalidBackend();
  const result: Array<{
    key: string;
    source: "config";
    label: string;
    description: string;
    category: string;
    isSet: boolean;
    isPassword: true;
  }> = [];
  for (const [id, meta] of Object.entries(fieldsRaw).slice(0, PRIVILEGED_CONFIG_MAX_FIELDS * 2)) {
    if (!isRecord(meta) || !isSafeConfigFieldId(id)) continue;
    if (!isHermesConfigSecretField(id, meta.type)) continue;
    const category = typeof meta.category === "string" ? meta.category : "secrets";
    const description = sanitizePublicText(meta.description, 2_000) ?? id;
    if (!isPublicConfigDescription(description)) continue;
    const rawValue = getDottedPath(configRaw, id);
    const isSet = rawValue !== undefined && rawValue !== null && rawValue !== "";
    result.push({
      key: id,
      source: "config",
      label: id,
      description,
      category,
      isSet: Boolean(isSet),
      isPassword: true,
    });
    if (result.length >= PRIVILEGED_CONFIG_MAX_FIELDS) break;
  }
  return result;
}

function resolvePrivilegedEditableType(
  schemaType: HermesConfigFieldType,
  rawValue: unknown,
): HermesConfigFieldType | "json" | undefined {
  const scalar = resolveHermesConfigEditableType(schemaType, rawValue);
  if (scalar !== undefined) return scalar;
  // Live non-string list → bounded JSON editor when shape is projectable.
  if (schemaType === "list" && Array.isArray(rawValue)) {
    return projectJsonLeaf(rawValue) === undefined ? undefined : "json";
  }
  return undefined;
}

/**
 * Explicit JSON null for Hermes None leaves that Advanced cannot type.
 * Never exposes missing/undefined paths. Requires confirmation on save.
 */
function tryProjectExplicitNullJson(
  id: string,
  category: string,
  description: string,
  rawValue: unknown,
  fields: HermesPrivilegedFieldDto[],
  values: Record<string, HermesPrivilegedConfigValue>,
): boolean {
  if (rawValue !== null) return false;
  if (fields.length >= PRIVILEGED_CONFIG_MAX_FIELDS) return false;
  fields.push({
    id,
    category,
    type: "json",
    description,
    options: [],
    impact: privilegedConfigFieldImpact(id, category),
    // Null→typed replacement can change agent behavior; always confirm.
    requiresConfirmation: true,
  });
  values[id] = null;
  return true;
}

function projectJsonLeaf(
  rawValue: unknown,
  options: { allowNull?: boolean } = {},
): unknown | undefined {
  if (rawValue === undefined) return undefined;
  if (rawValue === null) return options.allowNull === true ? null : undefined;
  if (!isJsonLeafShape(rawValue, 0)) return undefined;
  const encoded = stableStringify(rawValue);
  if (Buffer.byteLength(encoded) > PRIVILEGED_CONFIG_MAX_JSON_UTF8_BYTES) return undefined;
  // Reject secret-shaped material inside JSON leaves.
  if (containsLikelySecret(encoded)) return undefined;
  try {
    return JSON.parse(encoded) as unknown;
  } catch {
    return undefined;
  }
}

function isJsonLeafShape(value: unknown, depth: number): boolean {
  if (depth > PROFILE_CONFIG_MAX_NEST_DEPTH) return false;
  if (value === null) return true;
  if (typeof value === "boolean" || typeof value === "number") {
    return typeof value === "number" ? Number.isFinite(value) : true;
  }
  if (typeof value === "string") {
    return !value.includes("\0")
      && Buffer.byteLength(value) <= PROFILE_CONFIG_MAX_STRING_UTF8_BYTES
      && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
  }
  if (Array.isArray(value)) {
    if (value.length > PROFILE_CONFIG_MAX_LIST_ITEMS) return false;
    return value.every((item) => isJsonLeafShape(item, depth + 1));
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length > 64) return false;
    return keys.every((key) =>
      typeof key === "string"
      && key.length > 0
      && key.length <= 128
      && !key.includes("\0")
      && isJsonLeafShape(value[key], depth + 1));
  }
  return false;
}

function normalizeOptions(raw: unknown): HermesPrivilegedFieldOptionDto[] {
  if (!Array.isArray(raw)) return [];
  const options: HermesPrivilegedFieldOptionDto[] = [];
  for (const item of raw.slice(0, clampHermesSchemaOptions(PROFILE_CONFIG_MAX_OPTIONS))) {
    if (typeof item === "string") {
      const value = sanitizeOptionValue(item);
      if (value === undefined) continue;
      options.push({ value, label: value });
      continue;
    }
    if (!isRecord(item)) continue;
    const valueRaw = typeof item.value === "string" ? item.value : undefined;
    if (typeof valueRaw !== "string") continue;
    const value = sanitizeOptionValue(valueRaw);
    if (value === undefined) continue;
    const label = sanitizePublicText(item.label, 200) ?? value;
    options.push({ value, label });
  }
  return options;
}

function normalizeOutboundValue(
  value: unknown,
  field: HermesPrivilegedFieldDto,
): HermesPrivilegedConfigValue | undefined {
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    case "string":
    case "select": {
      if (typeof value !== "string") return undefined;
      return sanitizeOutboundString(value, PROFILE_CONFIG_MAX_STRING_UTF8_BYTES);
    }
    case "list": {
      if (!Array.isArray(value)) return undefined;
      if (value.length > PROFILE_CONFIG_MAX_LIST_ITEMS) return undefined;
      const items: string[] = [];
      for (const item of value) {
        if (typeof item !== "string") return undefined;
        const safe = sanitizeOutboundString(item, PROFILE_CONFIG_MAX_LIST_ITEM_UTF8_BYTES);
        if (safe === undefined) return undefined;
        items.push(safe);
      }
      return items;
    }
    case "json":
      // Outbound: allow explicit null for Hermes None leaves.
      return projectJsonLeaf(value, { allowNull: true });
    default:
      return undefined;
  }
}

function normalizeInboundValue(
  value: unknown,
  field: HermesPrivilegedFieldDto,
): HermesPrivilegedConfigValue {
  switch (field.type) {
    case "boolean":
      if (typeof value !== "boolean") throw invalid(`Invalid boolean for ${field.id}`);
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || Number.isNaN(value)) {
        throw invalid(`Invalid number for ${field.id}`);
      }
      if (Math.abs(value) > Number.MAX_SAFE_INTEGER) throw invalid(`Invalid number for ${field.id}`);
      return value;
    case "string": {
      if (typeof value !== "string") throw invalid(`Invalid string for ${field.id}`);
      return requireInboundString(value, field.id, PROFILE_CONFIG_MAX_STRING_UTF8_BYTES);
    }
    case "select": {
      if (typeof value !== "string") throw invalid(`Invalid select value for ${field.id}`);
      const clean = requireInboundString(value, field.id, 512);
      if (field.options.length > 0 && !field.options.some((option) => option.value === clean)) {
        throw invalid(`Select value is not allowed for ${field.id}`);
      }
      return clean;
    }
    case "list": {
      if (!Array.isArray(value)) throw invalid(`Invalid list for ${field.id}`);
      if (value.length > PROFILE_CONFIG_MAX_LIST_ITEMS) throw invalid(`List is too large for ${field.id}`);
      return value.map((item, index) => {
        if (typeof item !== "string") throw invalid(`Invalid list item for ${field.id}[${index}]`);
        return requireInboundString(item, `${field.id}[${index}]`, PROFILE_CONFIG_MAX_LIST_ITEM_UTF8_BYTES);
      });
    }
    case "json": {
      if (!isJsonLeafShape(value, 0)) throw invalid(`Invalid JSON value for ${field.id}`);
      const encoded = stableStringify(value);
      if (Buffer.byteLength(encoded) > PRIVILEGED_CONFIG_MAX_JSON_UTF8_BYTES) {
        throw invalid(`JSON value is too large for ${field.id}`);
      }
      if (containsLikelySecret(encoded)) throw invalid(`Value for ${field.id} appears to contain a secret.`);
      return JSON.parse(encoded) as unknown;
    }
    default:
      throw invalid(`Unsupported field type for ${field.id}`);
  }
}

function requireInboundString(value: string, label: string, maxBytes: number): string {
  if (value.includes("\0") || Buffer.byteLength(value) > maxBytes) throw invalid(`Invalid string for ${label}`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw invalid(`Invalid control characters for ${label}`);
  if (containsLikelySecret(value)) throw invalid(`Value for ${label} appears to contain a secret.`);
  return value;
}

function sanitizeOutboundString(value: string, maxBytes: number): string | undefined {
  if (value.includes("\0") || Buffer.byteLength(value) > maxBytes) return undefined;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return undefined;
  const redacted = redactSecrets(value);
  if (redacted.redacted || containsLikelySecret(value)) return undefined;
  return redacted.value;
}

function sanitizeOptionValue(value: string): string | undefined {
  if (value.includes("\0") || Buffer.byteLength(value) > 200) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const redacted = redactSecrets(value);
  return redacted.redacted ? undefined : redacted.value;
}

function sanitizePublicText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const redacted = redactSecrets(value);
  return redacted.value.slice(0, maxChars).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const record = nested as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) sorted[key] = record[key];
      return sorted;
    }
    return nested;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): HermesPrivilegedConfigError {
  return new HermesPrivilegedConfigError("invalid_request", message);
}

function invalidBackend(): HermesPrivilegedConfigError {
  return new HermesPrivilegedConfigError("rejected", "Hermes returned an invalid privileged config response.");
}
