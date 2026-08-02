/**
 * Schema-driven safe Hermes profile config: normalize Hermes
 * GET /api/config/schema + GET /api/config into Office DTOs and apply
 * dotted-leaf PATCH changes via PUT /api/config.
 */

import { createHash } from "node:crypto";
import {
  PROFILE_CONFIG_MAX_CHANGES,
  PROFILE_CONFIG_MAX_FIELDS,
  PROFILE_CONFIG_MAX_LIST_ITEM_UTF8_BYTES,
  PROFILE_CONFIG_MAX_LIST_ITEMS,
  PROFILE_CONFIG_MAX_NEST_DEPTH,
  PROFILE_CONFIG_MAX_OPTIONS,
  PROFILE_CONFIG_MAX_STRING_UTF8_BYTES,
} from "@hermes-studio/protocol";
import {
  clampHermesSchemaFieldCount,
  clampHermesSchemaOptions,
  evaluateHermesConfigFieldPolicy,
  isPublicConfigDescription,
  isSafeConfigFieldId,
  type HermesConfigFieldType,
} from "./hermes-config-policy.js";
import { containsLikelySecret, redactSecrets } from "./secret-scrubber.js";

export type HermesConfigScalar = boolean | number | string;
export type HermesConfigValue = HermesConfigScalar | HermesConfigScalar[];

export interface HermesConfigFieldOptionDto {
  value: string;
  label: string;
}

export interface HermesConfigFieldDto {
  id: string;
  category: string;
  type: HermesConfigFieldType;
  description: string;
  options: HermesConfigFieldOptionDto[];
}

export interface HermesConfigSchemaDto {
  profile: string;
  categories: string[];
  fields: HermesConfigFieldDto[];
  /** Schema fields rejected by the fail-closed policy (names never exposed). */
  excludedCount: number;
}

export interface HermesConfigDto {
  profile: string;
  revision: string;
  categories: string[];
  fields: HermesConfigFieldDto[];
  values: Record<string, HermesConfigValue>;
  excludedCount: number;
}

export interface HermesConfigPatch {
  expectedRevision: string;
  changes: Record<string, HermesConfigValue>;
}

export class HermesConfigError extends Error {
  readonly code: "conflict" | "invalid_request" | "not_found" | "rejected" | "response_too_large" | "timed_out";
  constructor(code: HermesConfigError["code"], message: string) {
    super(message);
    this.name = "HermesConfigError";
    this.code = code;
  }
}

export function normalizeHermesConfigSchema(
  raw: unknown,
  categoryOrderFallback: readonly string[] = [],
): { fields: HermesConfigFieldDto[]; categories: string[]; excludedCount: number } {
  if (!isRecord(raw)) throw invalidBackend();
  const fieldsRaw = raw.fields;
  const orderRaw = Array.isArray(raw.category_order) ? raw.category_order : categoryOrderFallback;
  if (!isRecord(fieldsRaw)) throw invalidBackend();

  const entries = Object.entries(fieldsRaw).slice(0, PROFILE_CONFIG_MAX_FIELDS * 2);
  const fields: HermesConfigFieldDto[] = [];
  let excludedCount = 0;

  for (const [id, meta] of entries) {
    if (fields.length >= PROFILE_CONFIG_MAX_FIELDS) {
      excludedCount += 1;
      continue;
    }
    if (!isRecord(meta)) {
      excludedCount += 1;
      continue;
    }
    const category = typeof meta.category === "string" ? meta.category : "";
    const decision = evaluateHermesConfigFieldPolicy(id, category, meta.type);
    if (!decision.allowed) {
      excludedCount += 1;
      continue;
    }
    const description = sanitizePublicText(meta.description, 2_000) ?? id;
    if (!isPublicConfigDescription(description)) {
      excludedCount += 1;
      continue;
    }
    const options = decision.type === "select"
      ? normalizeOptions(meta.options)
      : [];
    fields.push({
      id,
      category,
      type: decision.type,
      description,
      options,
    });
  }

  return finalizeSchemaFields(fields, orderRaw, excludedCount, Object.keys(fieldsRaw).length - entries.length);
}

/**
 * Hermes 0.18.2 dashboard schema builder (`_infer_type`) maps Python `None` to
 * `"string"`. Optional numeric leaves such as `max_concurrent_sessions` and
 * `context_file_max_chars` are therefore mislabeled until a live value proves
 * an unambiguous type. Fail closed: expose a field only when schema type +
 * current value resolve to one supported editor type. Lists are string-only.
 */
export function resolveHermesConfigEditableType(
  schemaType: HermesConfigFieldType,
  rawValue: unknown,
): HermesConfigFieldType | undefined {
  if (rawValue === null || rawValue === undefined) {
    // No live scalar: Hermes null→string inference is ambiguous for optional
    // numbers. Non-string schema types cannot be produced from None.
    if (schemaType === "string") return undefined;
    if (schemaType === "boolean" || schemaType === "number" || schemaType === "select" || schemaType === "list") {
      return schemaType;
    }
    return undefined;
  }

  switch (schemaType) {
    case "boolean":
      return typeof rawValue === "boolean" ? "boolean" : undefined;
    case "number":
      return typeof rawValue === "number" && Number.isFinite(rawValue) ? "number" : undefined;
    case "string":
      // Matching string is unambiguous. A live number/boolean with a string
      // schema label is the Hermes null-default mislabel case — use the live
      // scalar type rather than forcing a string editor over a number.
      if (typeof rawValue === "string") return "string";
      if (typeof rawValue === "number" && Number.isFinite(rawValue)) return "number";
      if (typeof rawValue === "boolean") return "boolean";
      return undefined;
    case "select":
      return typeof rawValue === "string" ? "select" : undefined;
    case "list":
      // Stage-1 generic list editor is string rows only — never coerce.
      if (!Array.isArray(rawValue)) return undefined;
      if (!rawValue.every((item) => typeof item === "string")) return undefined;
      return "list";
    default:
      return undefined;
  }
}

/**
 * Policy-filter schema, then re-type/deny leaves using live config values so
 * null-inferred strings and non-string lists never reach the UI/PATCH surface.
 */
export function projectSafeHermesConfig(
  schemaRaw: unknown,
  configRaw: unknown,
  categoryOrderFallback: readonly string[] = [],
): Omit<HermesConfigDto, "profile"> {
  const base = normalizeHermesConfigSchema(schemaRaw, categoryOrderFallback);
  if (!isRecord(configRaw)) throw invalidBackend();

  const fields: HermesConfigFieldDto[] = [];
  let excludedCount = base.excludedCount;
  const values: Record<string, HermesConfigValue> = {};

  for (const field of base.fields) {
    if (fields.length >= PROFILE_CONFIG_MAX_FIELDS) {
      excludedCount += 1;
      continue;
    }
    const rawValue = getDottedPath(configRaw, field.id);
    // Treat explicit JSON null like missing for type resolution (Hermes None).
    const resolvedType = resolveHermesConfigEditableType(field.type, rawValue);
    if (resolvedType === undefined) {
      excludedCount += 1;
      continue;
    }
    const projected: HermesConfigFieldDto = {
      ...field,
      type: resolvedType,
      options: resolvedType === "select" ? field.options : [],
    };
    // List fields with no live value are still editable as empty string lists.
    if (resolvedType === "list" && (rawValue === null || rawValue === undefined)) {
      fields.push(projected);
      values[field.id] = [];
      continue;
    }
    const normalized = normalizeOutboundValue(rawValue, projected);
    if (normalized === undefined && rawValue !== undefined && rawValue !== null) {
      // Live value present but not safely projectable (secret-shaped string, …).
      excludedCount += 1;
      continue;
    }
    fields.push(projected);
    if (normalized !== undefined) values[field.id] = normalized;
  }

  const finalized = finalizeSchemaFields(
    fields,
    base.categories,
    excludedCount,
    0,
  );
  return {
    revision: revisionOfConfigValues(values),
    categories: finalized.categories,
    fields: finalized.fields,
    values,
    excludedCount: finalized.excludedCount,
  };
}

export function pickSafeConfigValues(
  rawConfig: unknown,
  fields: readonly HermesConfigFieldDto[],
): Record<string, HermesConfigValue> {
  if (!isRecord(rawConfig)) throw invalidBackend();
  const values: Record<string, HermesConfigValue> = {};
  for (const field of fields.slice(0, PROFILE_CONFIG_MAX_FIELDS)) {
    const rawValue = getDottedPath(rawConfig, field.id);
    if (rawValue === undefined) continue;
    if (rawValue === null) {
      // Explicit JSON null: only empty string-lists are projectable.
      if (field.type === "list") values[field.id] = [];
      continue;
    }
    const resolvedType = resolveHermesConfigEditableType(field.type, rawValue);
    if (resolvedType === undefined) continue;
    const projected = resolvedType === field.type ? field : { ...field, type: resolvedType };
    const normalized = normalizeOutboundValue(rawValue, projected);
    if (normalized === undefined) continue;
    values[field.id] = normalized;
  }
  return values;
}

function finalizeSchemaFields(
  fields: HermesConfigFieldDto[],
  orderRaw: readonly unknown[],
  excludedCount: number,
  overflowExcluded: number,
): { fields: HermesConfigFieldDto[]; categories: string[]; excludedCount: number } {
  const presentCategories = new Set(fields.map((field) => field.category));
  const ordered = orderRaw
    .filter((item): item is string => typeof item === "string" && presentCategories.has(item));
  for (const category of presentCategories) {
    if (!ordered.includes(category)) ordered.push(category);
  }
  return {
    fields,
    categories: ordered,
    excludedCount: clampHermesSchemaFieldCount(excludedCount + Math.max(0, overflowExcluded)),
  };
}

export function revisionOfConfigValues(values: Record<string, HermesConfigValue>): string {
  const keys = Object.keys(values).sort();
  const stable = keys.map((key) => [key, values[key]]);
  return createHash("sha256").update(JSON.stringify(stable)).digest("base64url");
}

export function validateConfigPatchChanges(
  changes: unknown,
  fields: readonly HermesConfigFieldDto[],
): Record<string, HermesConfigValue> {
  if (!isRecord(changes)) throw invalid("Config changes must be an object of dotted field updates.");
  const keys = Object.keys(changes);
  if (keys.length === 0) throw invalid("Config changes must include at least one field.");
  if (keys.length > PROFILE_CONFIG_MAX_CHANGES) throw invalid("Too many config field changes in one request.");

  const byId = new Map(fields.map((field) => [field.id, field]));
  const clean: Record<string, HermesConfigValue> = {};
  for (const key of keys) {
    if (!isSafeConfigFieldId(key)) throw invalid(`Unknown or unsafe config field: ${key}`);
    const field = byId.get(key);
    if (field === undefined) throw invalid(`Config field is not editable: ${key}`);
    clean[key] = normalizeInboundValue(changes[key], field);
  }
  return clean;
}

/**
 * Build a nested partial object for Hermes PUT /api/config deep-merge.
 * Only applies validated leaf changes; never accepts a client root object.
 */
export function buildHermesConfigPutBody(changes: Record<string, HermesConfigValue>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(changes)) {
    setDottedPath(body, path, value);
  }
  return body;
}

export function getDottedPath(root: unknown, path: string): unknown {
  if (!isSafeConfigFieldId(path)) return undefined;
  const parts = path.split(".");
  if (parts.length > PROFILE_CONFIG_MAX_NEST_DEPTH) return undefined;
  let current: unknown = root;
  for (const part of parts) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

export function setDottedPath(root: Record<string, unknown>, path: string, value: HermesConfigValue): void {
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

function normalizeOptions(raw: unknown): HermesConfigFieldOptionDto[] {
  if (!Array.isArray(raw)) return [];
  const options: HermesConfigFieldOptionDto[] = [];
  for (const item of raw.slice(0, clampHermesSchemaOptions(PROFILE_CONFIG_MAX_OPTIONS))) {
    if (typeof item === "string") {
      const value = sanitizeOptionValue(item);
      if (value === undefined) continue;
      options.push({ value, label: value });
      continue;
    }
    if (!isRecord(item)) continue;
    const valueRaw = typeof item.value === "string" ? item.value : typeof item === "string" ? item : undefined;
    if (typeof valueRaw !== "string") continue;
    const value = sanitizeOptionValue(valueRaw);
    if (value === undefined) continue;
    const label = sanitizePublicText(item.label, 200) ?? value;
    options.push({ value, label });
  }
  return options;
}

function normalizeOutboundValue(value: unknown, field: HermesConfigFieldDto): HermesConfigValue | undefined {
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    case "string":
    case "select": {
      if (typeof value !== "string") return undefined;
      return sanitizeOutboundString(value, field);
    }
    case "list": {
      if (!Array.isArray(value)) return undefined;
      if (value.length > PROFILE_CONFIG_MAX_LIST_ITEMS) return undefined;
      // Fail closed: only string rows. Never coerce boolean/number items.
      const items: string[] = [];
      for (const item of value) {
        if (typeof item !== "string") return undefined;
        const safe = sanitizeOutboundString(item, field, PROFILE_CONFIG_MAX_LIST_ITEM_UTF8_BYTES);
        if (safe === undefined) return undefined;
        items.push(safe);
      }
      return items;
    }
    default:
      return undefined;
  }
}

function normalizeInboundValue(value: unknown, field: HermesConfigFieldDto): HermesConfigValue {
  switch (field.type) {
    case "boolean":
      if (typeof value !== "boolean") throw invalid(`Invalid boolean for ${field.id}`);
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || Number.isNaN(value)) {
        throw invalid(`Invalid number for ${field.id}`);
      }
      if (!Number.isSafeInteger(value) && !Number.isFinite(value)) throw invalid(`Invalid number for ${field.id}`);
      // Reject non-finite already; also bound magnitude for JSON safety.
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
      // String-list contract only — reject boolean/number items instead of coercing.
      return value.map((item, index) => {
        if (typeof item !== "string") throw invalid(`Invalid list item for ${field.id}[${index}]`);
        return requireInboundString(item, `${field.id}[${index}]`, PROFILE_CONFIG_MAX_LIST_ITEM_UTF8_BYTES);
      });
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

function sanitizeOutboundString(
  value: string,
  field: HermesConfigFieldDto,
  maxBytes = PROFILE_CONFIG_MAX_STRING_UTF8_BYTES,
): string | undefined {
  if (value.includes("\0") || Buffer.byteLength(value) > maxBytes) return undefined;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return undefined;
  const redacted = redactSecrets(value);
  if (redacted.redacted || containsLikelySecret(value)) return undefined;
  if (field.type === "select" && field.options.length > 0 && !field.options.some((option) => option.value === value)) {
    // Still surface the current value when it is a clean string outside options
    // so the UI can show reality without inventing options.
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): HermesConfigError {
  return new HermesConfigError("invalid_request", message);
}

function invalidBackend(): HermesConfigError {
  return new HermesConfigError("rejected", "Hermes returned an invalid config response.");
}
