import { signal } from "@preact/signals";
import type {
  ChatModelPreferencePreset,
  ChatModelPreferenceSlot,
  ChatModelPreferencesDocument as SharedChatModelPreferencesDocument,
  ChatModelPreferencesSnapshot,
} from "@hermes-studio/protocol";
import { OfficeHttpError, officeFetchJson } from "./office-api";

const STORAGE_KEY = "hermes-studio:chat-model-prefs:v3";
/** Pre-preset store: top-level main selection only. */
const LEGACY_V2_STORAGE_KEY = "hermes-studio:chat-model-prefs:v2";
/** Pre-`__manual__` key: provider `"custom"` was the UI manual-entry sentinel. */
const LEGACY_V1_STORAGE_KEY = "hermes-studio:chat-model-prefs:v1";
/** Pre-rebrand product prefix (Hermes Studio). Dual-read only. */
const LEGACY_OFFICE_KEYS = [
  "hermes-office:chat-model-prefs:v3",
  "hermes-office:chat-model-prefs:v2",
  "hermes-office:chat-model-prefs:v1",
] as const;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Matches Studio Server provider id sanitizer. */
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,127}$/;
/** Matches Studio Server model id sanitizer. */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./:+@-]{0,255}$/;
const PRESET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PRESET_NAME_MAX = 64;
const PRESET_MAX = 32;
const FETCH_TIMEOUT_MS = 30_000;

/** UI-only sentinel for free-form model entry. Never sent to Hermes as a provider. */
export const CHAT_MODEL_MANUAL_PROVIDER = "__manual__";

/** Allowed reasoning_effort wire values (Hermes). Empty pref means model default. */
export const REASONING_EFFORT_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type ReasoningEffortValue = (typeof REASONING_EFFORT_VALUES)[number];
const REASONING_EFFORT_SET: ReadonlySet<string> = new Set(REASONING_EFFORT_VALUES);

export type ChatModelPrefs = ChatModelPreferenceSlot;

/** Named main+sub pairing shared by authenticated clients through Studio Server. */
export type ChatModelPreset = ChatModelPreferencePreset;

/** Parsed main/sub selection and named presets, with a local fallback cache. */
export type ChatModelPrefsDocument = SharedChatModelPreferencesDocument;

export type LiveChatProviderOption = {
  id: string;
  label: string;
  active: boolean;
};

export type LiveChatModelOption = {
  id: string;
  label: string;
  /** Explicit levels from Hermes; omit when unknown. */
  reasoningEfforts?: ReasoningEffortValue[];
};

export type LiveChatModelsCatalog = {
  profile: string;
  providers: LiveChatProviderOption[];
  provider: string;
  /** Profile-configured target for resetting an already-open session. */
  defaultProvider: string;
  defaultModel: string;
  models: LiveChatModelOption[];
  refreshedAt: string;
};

/** Fixed composer rows that are not sourced from Hermes. */
export const CHAT_MODEL_FIXED_OPTIONS = [
  { provider: "", model: "", labelKey: "chat.model.default" as const },
  { provider: CHAT_MODEL_MANUAL_PROVIDER, model: "", labelKey: "chat.model.custom" as const },
] as const;

const initial = readPrefsDocument();
export const chatModelProvider = signal(initial.main.provider);
export const chatModelName = signal(initial.main.model);
export const chatModelReasoningEffort = signal(initial.main.reasoningEffort);
export const chatModelSubProvider = signal(initial.sub.provider);
export const chatModelSubName = signal(initial.sub.model);
export const chatModelSubReasoningEffort = signal(initial.sub.reasoningEffort);
export const chatModelPresets = signal<ChatModelPreset[]>(initial.presets);
export const chatModelActivePresetId = signal<string | undefined>(initial.activePresetId);

let sharedRevision: number | undefined;
let sharedInitialized = false;
let sharedSyncFlight: Promise<void> | undefined;
let sharedWriteTail: Promise<void> = Promise.resolve();
let localDocumentVersion = 0;
let lastSyncedDocument: string | undefined;
let initialLocalMigrationEnabled = false;

export function isManualChatModelProvider(provider: string): boolean {
  return provider.trim() === CHAT_MODEL_MANUAL_PROVIDER;
}

export function isAllowedReasoningEffort(value: string): value is ReasoningEffortValue {
  return REASONING_EFFORT_SET.has(value.trim().toLowerCase());
}

/**
 * Normalize a stored or session effort value.
 * - `allowed` undefined: keep only the 8 general Hermes levels (prefs / validated session).
 * - `allowed` provided (including empty): keep only if listed (empty array clears).
 */
export function sanitizeReasoningEffort(
  effort: string,
  allowed?: readonly string[],
): string {
  const value = effort.trim().toLowerCase();
  if (!value) return "";
  if (allowed !== undefined) {
    return allowed.includes(value) ? value : "";
  }
  return isAllowedReasoningEffort(value) ? value : "";
}

export function setChatModelSelection(provider: string, model: string, reasoningEffort?: string): void {
  chatModelProvider.value = provider.trim();
  chatModelName.value = model.trim();
  if (reasoningEffort !== undefined) {
    // General wire-shape only; send path uses resolvedReasoningEffortForCreate + live allowlist.
    chatModelReasoningEffort.value = sanitizeReasoningEffort(reasoningEffort);
  }
  clearActivePresetIfDiverged();
  persist();
}

export function setChatModelName(model: string): void {
  chatModelName.value = model.trim();
  clearActivePresetIfDiverged();
  persist();
}

export function setChatModelReasoningEffort(effort: string, allowed?: readonly string[]): void {
  chatModelReasoningEffort.value = sanitizeReasoningEffort(effort, allowed);
  clearActivePresetIfDiverged();
  persist();
}

export function setChatModelSubSelection(provider: string, model: string, reasoningEffort?: string): void {
  chatModelSubProvider.value = provider.trim();
  chatModelSubName.value = model.trim();
  if (reasoningEffort !== undefined) {
    chatModelSubReasoningEffort.value = sanitizeReasoningEffort(reasoningEffort);
  }
  clearActivePresetIfDiverged();
  persist();
}

export function setChatModelSubReasoningEffort(effort: string, allowed?: readonly string[]): void {
  chatModelSubReasoningEffort.value = sanitizeReasoningEffort(effort, allowed);
  clearActivePresetIfDiverged();
  persist();
}

export function currentChatModelPrefs(): ChatModelPrefs {
  return {
    provider: chatModelProvider.value,
    model: chatModelName.value,
    reasoningEffort: chatModelReasoningEffort.value,
  };
}

export function currentChatModelSubPrefs(): ChatModelPrefs {
  return {
    provider: chatModelSubProvider.value,
    model: chatModelSubName.value,
    reasoningEffort: chatModelSubReasoningEffort.value,
  };
}

export function activeChatModelPreset(): ChatModelPreset | undefined {
  const id = chatModelActivePresetId.value;
  if (!id) return undefined;
  return chatModelPresets.value.find((preset) => preset.id === id);
}

/** A preset label is session-local only when exactly one preset matches its main slot. */
export function matchingChatModelPresetName(
  presets: readonly ChatModelPreset[],
  session: ChatModelPrefs,
): string | undefined {
  const target = resolvedCreateModelPrefs(session);
  const matches = presets.filter((preset) => slotsEqual(resolvedCreateModelPrefs(preset.main), target));
  return matches.length === 1 ? matches[0]!.name : undefined;
}

/**
 * Prefs safe for Hermes `session.create` / slash `/model`.
 * Strips the UI-only manual sentinel and splits free-form `provider:model`.
 * A real Hermes provider named `custom` is left unchanged.
 * reasoningEffort is shape-sanitized (or allowlist-checked when `allowed` is passed).
 * The fail-closed create wire gate is `resolvedReasoningEffortForCreate`.
 */
export function resolvedCreateModelPrefs(
  prefs: ChatModelPrefs = currentChatModelPrefs(),
  allowed?: readonly string[],
): ChatModelPrefs {
  let provider = prefs.provider.trim();
  let model = prefs.model.trim();
  if (isManualChatModelProvider(provider)) {
    provider = "";
    if (model.includes(":")) {
      const index = model.indexOf(":");
      provider = model.slice(0, index).trim();
      model = model.slice(index + 1).trim();
    }
  }
  return {
    provider,
    model,
    reasoningEffort: sanitizeReasoningEffort(prefs.reasoningEffort, allowed),
  };
}

/**
 * Value for session.create — only when Hermes published a non-empty allowlist
 * and the stored effort is still in that list. Undefined otherwise (fail-closed).
 * Custom / empty models / live fetch failure must pass no allowlist → never send.
 */
export function resolvedReasoningEffortForCreate(
  prefs: ChatModelPrefs = currentChatModelPrefs(),
  allowed?: readonly string[],
): string | undefined {
  if (allowed === undefined || allowed.length === 0) {
    return undefined;
  }
  const effort = sanitizeReasoningEffort(prefs.reasoningEffort, allowed);
  return effort || undefined;
}

/**
 * Pure reconcile matching the panel: missing enumeration → empty allowlist (clear).
 */
export function reconcileReasoningEffortValue(
  effort: string,
  allowed?: readonly string[],
): string {
  return sanitizeReasoningEffort(effort, allowed ?? []);
}

/**
 * Session-scoped `/model` for the open chat. Uses explicit flags so provider
 * IDs may contain `:` and Hermes does not persist the change globally.
 */
export function modelSlashCommand(prefs: ChatModelPrefs = currentChatModelPrefs()): string | undefined {
  const resolved = resolvedCreateModelPrefs(prefs);
  const provider = resolved.provider;
  const model = resolved.model;
  if (!model) return undefined;
  if (provider) return `/model ${model} --provider ${provider} --session`;
  return `/model ${model} --session`;
}

/**
 * Provider select value: default | live/retained id | manual sentinel.
 * Real Hermes provider ids (including those with `:`) stay as-is even when
 * absent from the current live list — never fold them into the free-form sentinel.
 */
export function providerSelectValue(provider: string, providers: readonly LiveChatProviderOption[]): string {
  if (!provider) return "default";
  if (isManualChatModelProvider(provider)) return CHAT_MODEL_MANUAL_PROVIDER;
  return provider;
}

/** Model select value when a live provider is selected. */
export function modelSelectValue(model: string, models: readonly LiveChatModelOption[]): string {
  if (!model) return "";
  if (models.some((item) => item.id === model)) return model;
  return "";
}

/** True when the stored pair is not a pure live list pick (needs free-form field). */
export function needsManualModelEntry(
  provider: string,
  model: string,
  providers: readonly LiveChatProviderOption[],
  models: readonly LiveChatModelOption[],
): boolean {
  if (isManualChatModelProvider(provider)) return true;
  if (!provider && !model) return false;
  if (!provider) return Boolean(model);
  if (!providers.some((item) => item.id === provider)) return true;
  if (!model) return false;
  return !models.some((item) => item.id === model);
}

/** Apply a named preset to main+sub device prefs. Returns false when id is unknown. */
export function selectChatModelPreset(id: string): boolean {
  const preset = chatModelPresets.value.find((item) => item.id === id);
  if (!preset) return false;
  chatModelProvider.value = preset.main.provider;
  chatModelName.value = preset.main.model;
  chatModelReasoningEffort.value = sanitizeReasoningEffort(preset.main.reasoningEffort);
  chatModelSubProvider.value = preset.sub.provider;
  chatModelSubName.value = preset.sub.model;
  chatModelSubReasoningEffort.value = sanitizeReasoningEffort(preset.sub.reasoningEffort);
  chatModelActivePresetId.value = preset.id;
  persist();
  return true;
}

/** Snapshot current main+sub into a new named preset and activate it. */
export function createChatModelPreset(name: string): ChatModelPreset | undefined {
  if (chatModelPresets.value.length >= PRESET_MAX) return undefined;
  const cleaned = sanitizePresetName(name);
  if (!cleaned) return undefined;
  const preset: ChatModelPreset = {
    id: newPresetId(),
    name: cleaned,
    main: currentChatModelPrefs(),
    sub: currentChatModelSubPrefs(),
  };
  chatModelPresets.value = [...chatModelPresets.value, preset];
  chatModelActivePresetId.value = preset.id;
  persist();
  return preset;
}

export function renameChatModelPreset(id: string, name: string): boolean {
  const cleaned = sanitizePresetName(name);
  if (!cleaned) return false;
  const index = chatModelPresets.value.findIndex((item) => item.id === id);
  if (index < 0) return false;
  const next = chatModelPresets.value.slice();
  next[index] = { ...next[index]!, name: cleaned };
  chatModelPresets.value = next;
  persist();
  return true;
}

export function deleteChatModelPreset(id: string): boolean {
  const next = chatModelPresets.value.filter((item) => item.id !== id);
  if (next.length === chatModelPresets.value.length) return false;
  chatModelPresets.value = next;
  if (chatModelActivePresetId.value === id) chatModelActivePresetId.value = undefined;
  persist();
  return true;
}

export function clearActiveChatModelPreset(): void {
  if (chatModelActivePresetId.value === undefined) return;
  chatModelActivePresetId.value = undefined;
  persist();
}

/**
 * Pure parse of a stored document (v3 or legacy v2/v1 shape).
 * Fail-closed: unknown fields ignored; invalid presets dropped; effort shape-sanitized.
 */
export function parseChatModelPrefsDocument(value: unknown): ChatModelPrefsDocument {
  if (!isRecord(value)) {
    return emptyDocument();
  }

  // v3 nested shape: { main, sub, presets, activePresetId }
  if (isRecord(value.main) || Array.isArray(value.presets) || isRecord(value.sub)) {
    const main = sanitizeModelSlot(value.main ?? {
      provider: value.provider,
      model: value.model,
      reasoningEffort: value.reasoningEffort,
    });
    const sub = sanitizeModelSlot(value.sub);
    const presets = sanitizePresetList(value.presets);
    const activePresetId = sanitizeActivePresetId(value.activePresetId, presets);
    return { main, sub, presets, ...(activePresetId ? { activePresetId } : {}) };
  }

  // v2 / flat main-only shape: { provider, model, reasoningEffort? }
  return {
    main: sanitizeModelSlot(value),
    sub: emptyPrefs(),
    presets: [],
  };
}

/** Shape-sanitize one main/sub slot (provider/model free-form; effort general-8 only). */
export function sanitizeModelSlot(value: unknown): ChatModelPrefs {
  if (!isRecord(value)) return emptyPrefs();
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const model = typeof value.model === "string" ? value.model.trim() : "";
  const reasoningEffort = typeof value.reasoningEffort === "string"
    ? sanitizeReasoningEffort(value.reasoningEffort)
    : "";
  // Fail closed on secret-looking values; keep empty rather than pass through.
  if (containsSuspicious(provider) || containsSuspicious(model)) {
    return emptyPrefs();
  }
  return { provider, model, reasoningEffort };
}

export function sanitizePresetList(value: unknown): ChatModelPreset[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: ChatModelPreset[] = [];
  for (const row of value.slice(0, PRESET_MAX * 2)) {
    const preset = sanitizeChatModelPreset(row);
    if (!preset || seen.has(preset.id)) continue;
    seen.add(preset.id);
    out.push(preset);
    if (out.length >= PRESET_MAX) break;
  }
  return out;
}

export function sanitizeChatModelPreset(value: unknown): ChatModelPreset | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!PRESET_ID_PATTERN.test(id) || containsSuspicious(id)) return undefined;
  const name = sanitizePresetName(typeof value.name === "string" ? value.name : "");
  if (!name) return undefined;
  return {
    id,
    name,
    main: sanitizeModelSlot(value.main),
    sub: sanitizeModelSlot(value.sub),
  };
}

export function sanitizePresetName(value: string): string | undefined {
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, PRESET_NAME_MAX);
  if (cleaned === "" || containsSuspicious(cleaned)) return undefined;
  return cleaned;
}

/** Short client cache so reopening the model panel does not wait on Hermes every time. */
const CLIENT_CATALOG_TTL_MS = 30_000;
const LOCAL_MODEL_SYNC_TTL_MS = 30_000;
const clientCatalogCache = new Map<string, {
  expiresAt: number;
  generation: number;
  catalog: LiveChatModelsCatalog;
}>();
const clientCatalogGenerations = new Map<string, number>();
const clientCatalogRefreshes = new Map<string, Promise<LiveChatModelsCatalog>>();
const localModelSyncs = new Map<string, { expiresAt: number; promise: Promise<void> }>();

async function syncLocalModelProviders(profile: string, force = false): Promise<void> {
  const existing = localModelSyncs.get(profile);
  if (!force && existing !== undefined && existing.expiresAt > Date.now()) return await existing.promise;
  const sync = officeFetchJson<unknown>(
    `/api/v1/models/local-cli/sync?${new URLSearchParams({ profile }).toString()}`,
    { timeoutMs: FETCH_TIMEOUT_MS, method: "POST" },
  ).then(() => undefined).catch(() => undefined);
  localModelSyncs.set(profile, { expiresAt: Date.now() + LOCAL_MODEL_SYNC_TTL_MS, promise: sync });
  await sync;
}

/**
 * Same-origin Studio live catalog for one Hermes profile.
 * Optional provider scopes the models list to that provider only.
 * Pass `forceRefresh` to bypass client + server soft caches (reaches Hermes refresh when needed).
 */
export async function fetchLiveChatModels(
  profile: string,
  provider?: string,
  options?: { forceRefresh?: boolean },
): Promise<LiveChatModelsCatalog> {
  const valid = profile.trim();
  if (!PROFILE_PATTERN.test(valid)) throw new ChatModelCatalogError("invalid");
  const providerKey = provider !== undefined && provider.trim() !== "" && !isManualChatModelProvider(provider)
    ? provider.trim()
    : "";
  const cacheKey = `${valid}\0${providerKey}`;
  const forceRefresh = options?.forceRefresh === true;
  // The sync is local, bounded, secret-free, and idempotent. Unsupported or
  // unavailable CLI proxies/runtimes simply leave the native Hermes catalog unchanged.
  await syncLocalModelProviders(valid, forceRefresh);
  if (!forceRefresh) {
    const refreshing = clientCatalogRefreshes.get(cacheKey);
    if (refreshing !== undefined) {
      try { return await refreshing; } catch { /* Fall through to a read-only retry. */ }
    }
    const hit = clientCatalogCache.get(cacheKey);
    if (hit !== undefined && hit.expiresAt > Date.now()) return hit.catalog;
  }

  const query = new URLSearchParams({ profile: valid });
  if (providerKey !== "") query.set("provider", providerKey);
  const load = async (): Promise<LiveChatModelsCatalog> => {
    try {
      const raw = await officeFetchJson<unknown>(
        `/api/v1/models${forceRefresh ? "/refresh" : ""}?${query.toString()}`,
        { timeoutMs: FETCH_TIMEOUT_MS, ...(forceRefresh ? { method: "POST" as const } : {}) },
      );
      return parseLiveCatalog(raw, valid);
    } catch (error) {
      if (error instanceof ChatModelCatalogError) throw error;
      if (error instanceof OfficeHttpError) {
        if (error.status === 400) throw new ChatModelCatalogError("invalid");
        if (error.status === 404) throw new ChatModelCatalogError("not-found");
        if (error.status === 401 || error.status === 403) throw new ChatModelCatalogError("unauthorized");
        throw new ChatModelCatalogError("unavailable");
      }
      throw new ChatModelCatalogError("unavailable");
    }
  };

  if (forceRefresh) {
    const generation = (clientCatalogGenerations.get(cacheKey) ?? 0) + 1;
    clientCatalogGenerations.set(cacheKey, generation);
    let refresh!: Promise<LiveChatModelsCatalog>;
    refresh = load().then(async (catalog) => {
      if ((clientCatalogGenerations.get(cacheKey) ?? 0) !== generation) {
        const newer = clientCatalogRefreshes.get(cacheKey);
        if (newer !== undefined && newer !== refresh) {
          try { return await newer; } catch { return catalog; }
        }
        const latest = clientCatalogCache.get(cacheKey);
        return latest !== undefined && latest.generation > generation ? latest.catalog : catalog;
      }
      clientCatalogCache.set(cacheKey, {
        expiresAt: Date.now() + CLIENT_CATALOG_TTL_MS,
        generation,
        catalog,
      });
      return catalog;
    }).finally(() => {
      if (clientCatalogRefreshes.get(cacheKey) === refresh) clientCatalogRefreshes.delete(cacheKey);
    });
    clientCatalogRefreshes.set(cacheKey, refresh);
    return await refresh;
  }

  // Every network request owns a generation. This prevents an older ordinary
  // GET from overwriting a newer GET as well as a forced refresh.
  const generation = (clientCatalogGenerations.get(cacheKey) ?? 0) + 1;
  clientCatalogGenerations.set(cacheKey, generation);
  const catalog = await load();
  if ((clientCatalogGenerations.get(cacheKey) ?? 0) !== generation) {
    const refreshing = clientCatalogRefreshes.get(cacheKey);
    if (refreshing !== undefined) {
      try { return await refreshing; } catch { return catalog; }
    }
    const latest = clientCatalogCache.get(cacheKey);
    return latest !== undefined && latest.generation > generation ? latest.catalog : catalog;
  }
  clientCatalogCache.set(cacheKey, {
    expiresAt: Date.now() + CLIENT_CATALOG_TTL_MS,
    generation,
    catalog,
  });
  return catalog;
}

export class ChatModelCatalogError extends Error {
  readonly code: "invalid" | "not-found" | "unauthorized" | "unavailable" | "incompatible";

  constructor(code: ChatModelCatalogError["code"]) {
    super(`chat-model-catalog:${code}`);
    this.name = "ChatModelCatalogError";
    this.code = code;
  }
}

/** Exported for focused pure tests. */
export function parseLiveCatalog(value: unknown, expectedProfile: string): LiveChatModelsCatalog {
  if (
    !isRecord(value)
    || typeof value.profile !== "string"
    || typeof value.provider !== "string"
    || typeof value.refreshedAt !== "string"
    || !Array.isArray(value.models)
  ) {
    throw new ChatModelCatalogError("incompatible");
  }
  if (value.profile !== expectedProfile || !PROFILE_PATTERN.test(value.profile)) {
    throw new ChatModelCatalogError("incompatible");
  }
  if (Number.isNaN(Date.parse(value.refreshedAt))) {
    throw new ChatModelCatalogError("incompatible");
  }

  const selectedProvider = value.provider.trim() === ""
    ? ""
    : sanitizeProviderId(value.provider);
  if (value.provider.trim() !== "" && selectedProvider === undefined) {
    throw new ChatModelCatalogError("incompatible");
  }
  const defaultProviderValue = typeof value.defaultProvider === "string" ? value.defaultProvider.trim() : "";
  const defaultModelValue = typeof value.defaultModel === "string" ? value.defaultModel.trim() : "";
  const defaultProvider = defaultProviderValue === "" ? "" : sanitizeProviderId(defaultProviderValue);
  const defaultModel = defaultModelValue === "" ? "" : sanitizeModelId(defaultModelValue);
  if ((defaultProviderValue !== "" && defaultProvider === undefined)
    || (defaultModelValue !== "" && defaultModel === undefined)) {
    throw new ChatModelCatalogError("incompatible");
  }

  const providers: LiveChatProviderOption[] = [];
  const seenProviders = new Set<string>();
  const providerRows = Array.isArray(value.providers) ? value.providers : [];
  for (const row of providerRows.slice(0, 200)) {
    if (!isRecord(row) || typeof row.id !== "string" || typeof row.label !== "string") continue;
    const id = sanitizeProviderId(row.id);
    const label = sanitizePublicLabel(row.label);
    if (id === undefined || label === undefined || seenProviders.has(id)) continue;
    seenProviders.add(id);
    providers.push({ id, label, active: row.active === true });
  }

  const models: LiveChatModelOption[] = [];
  const seenModels = new Set<string>();
  for (const row of value.models.slice(0, 500)) {
    if (!isRecord(row) || typeof row.id !== "string" || typeof row.label !== "string") continue;
    const id = sanitizeModelId(row.id);
    const label = sanitizePublicLabel(row.label);
    if (id === undefined || label === undefined || seenModels.has(id)) continue;
    seenModels.add(id);
    const reasoningEfforts = parseReasoningEffortsField(row.reasoningEfforts ?? row.reasoning_efforts);
    models.push({
      id,
      label,
      ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
    });
  }

  return {
    profile: value.profile,
    providers,
    provider: selectedProvider ?? "",
    defaultProvider: defaultProvider ?? "",
    defaultModel: defaultModel ?? "",
    models,
    refreshedAt: value.refreshedAt,
  };
}

/** Accept only the 8 Hermes levels, ordered, de-duplicated. */
export function parseReasoningEffortsField(value: unknown): ReasoningEffortValue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const item of value.slice(0, 16)) {
    if (typeof item !== "string") continue;
    const effort = item.trim().toLowerCase();
    if (!REASONING_EFFORT_SET.has(effort) || seen.has(effort)) continue;
    seen.add(effort);
  }
  const ordered = REASONING_EFFORT_VALUES.filter((effort) => seen.has(effort));
  return ordered.length > 0 ? ordered : undefined;
}

function sanitizeProviderId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!PROVIDER_PATTERN.test(trimmed) || containsSuspicious(trimmed)) return undefined;
  return trimmed;
}

function sanitizeModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!MODEL_ID_PATTERN.test(trimmed) || containsSuspicious(trimmed)) return undefined;
  return trimmed;
}

function sanitizePublicLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
  if (cleaned === "" || containsSuspicious(cleaned)) return undefined;
  return cleaned;
}

function containsSuspicious(value: string): boolean {
  return /api[_-]?key|secret|token|password|credential|authorization|bearer/i.test(value)
    || value.includes("\0");
}

function sanitizeActivePresetId(
  value: unknown,
  presets: readonly ChatModelPreset[],
): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (!PRESET_ID_PATTERN.test(id)) return undefined;
  return presets.some((preset) => preset.id === id) ? id : undefined;
}

function clearActivePresetIfDiverged(): void {
  const activeId = chatModelActivePresetId.value;
  if (!activeId) return;
  const preset = chatModelPresets.value.find((item) => item.id === activeId);
  if (!preset) {
    chatModelActivePresetId.value = undefined;
    return;
  }
  if (!slotsEqual(preset.main, currentChatModelPrefs()) || !slotsEqual(preset.sub, currentChatModelSubPrefs())) {
    chatModelActivePresetId.value = undefined;
  }
}

function slotsEqual(left: ChatModelPrefs, right: ChatModelPrefs): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort;
}

/**
 * Reconcile the local fallback cache with the Studio-owned shared document.
 * The first authenticated local desktop claims an empty server document with
 * its existing v3 preferences; remote clients always adopt the host copy.
 */
export function synchronizeChatModelPreferences(options?: { migrateLocal?: boolean }): Promise<void> {
  if (options?.migrateLocal === true) initialLocalMigrationEnabled = true;
  if (sharedSyncFlight !== undefined) return sharedSyncFlight;
  const flight = (sharedInitialized ? refreshSharedPreferences() : initializeSharedPreferences())
    .finally(() => {
      if (sharedSyncFlight === flight) sharedSyncFlight = undefined;
    });
  sharedSyncFlight = flight;
  return flight;
}

async function initializeSharedPreferences(): Promise<void> {
  const startingVersion = localDocumentVersion;
  const localDocument = currentPrefsDocument();
  const remote = await fetchSharedPreferences();
  sharedRevision = remote.revision;
  lastSyncedDocument = serializePrefsDocument(remote.document);

  if (startingVersion !== localDocumentVersion) {
    sharedInitialized = true;
    enqueueSharedWrite(currentPrefsDocument(), localDocumentVersion);
    return;
  }

  if (remote.revision === 0 && initialLocalMigrationEnabled) {
    try {
      const claimed = await putSharedPreferences(0, localDocument);
      sharedRevision = claimed.revision;
      lastSyncedDocument = serializePrefsDocument(claimed.document);
      sharedInitialized = true;
      if (startingVersion !== localDocumentVersion) {
        enqueueSharedWrite(currentPrefsDocument(), localDocumentVersion);
      }
      return;
    } catch (error) {
      if (!(error instanceof OfficeHttpError) || error.status !== 409) throw error;
      const winner = await fetchSharedPreferences();
      sharedRevision = winner.revision;
      lastSyncedDocument = serializePrefsDocument(winner.document);
      sharedInitialized = true;
      if (startingVersion === localDocumentVersion) applySharedPreferences(winner.document);
      else enqueueSharedWrite(currentPrefsDocument(), localDocumentVersion);
      return;
    }
  }

  applySharedPreferences(remote.document);
  sharedInitialized = true;
}

async function refreshSharedPreferences(): Promise<void> {
  await sharedWriteTail;
  const startingVersion = localDocumentVersion;
  const localDocument = currentPrefsDocument();
  const localSerialized = serializePrefsDocument(localDocument);
  const remote = await fetchSharedPreferences();
  sharedRevision = remote.revision;

  if (startingVersion !== localDocumentVersion) {
    enqueueSharedWrite(currentPrefsDocument(), localDocumentVersion);
    return;
  }
  if (lastSyncedDocument === localSerialized) {
    applySharedPreferences(remote.document);
    return;
  }
  enqueueSharedWrite(localDocument, startingVersion);
}

function persist(): void {
  const document = currentPrefsDocument();
  writeLocalPrefsDocument(document);
  localDocumentVersion += 1;
  if (sharedInitialized) enqueueSharedWrite(document, localDocumentVersion);
}

function enqueueSharedWrite(document: ChatModelPrefsDocument, version: number): void {
  const serialized = serializePrefsDocument(document);
  const pending = sharedWriteTail.then(async () => {
    if (!sharedInitialized || sharedRevision === undefined) return;
    if (version < localDocumentVersion && serialized !== serializePrefsDocument(currentPrefsDocument())) return;
    await saveSharedPreferences(document, serialized, version);
  });
  sharedWriteTail = pending.catch(() => undefined);
}

async function saveSharedPreferences(
  document: ChatModelPrefsDocument,
  serialized: string,
  version: number,
): Promise<void> {
  if (sharedRevision === undefined) return;
  let saved: ChatModelPreferencesSnapshot;
  try {
    saved = await putSharedPreferences(sharedRevision, document);
  } catch (error) {
    if (!(error instanceof OfficeHttpError) || error.status !== 409) throw error;
    const latest = await fetchSharedPreferences();
    sharedRevision = latest.revision;
    lastSyncedDocument = serializePrefsDocument(latest.document);
    if (version !== localDocumentVersion || serialized !== serializePrefsDocument(currentPrefsDocument())) return;
    saved = await putSharedPreferences(latest.revision, document);
  }
  sharedRevision = saved.revision;
  lastSyncedDocument = serialized;
}

async function fetchSharedPreferences(): Promise<ChatModelPreferencesSnapshot> {
  return parseSharedPreferencesSnapshot(await officeFetchJson<unknown>(
    "/api/v1/settings/chat-model-preferences",
    { timeoutMs: FETCH_TIMEOUT_MS },
  ));
}

async function putSharedPreferences(
  expectedRevision: number,
  document: ChatModelPrefsDocument,
): Promise<ChatModelPreferencesSnapshot> {
  return parseSharedPreferencesSnapshot(await officeFetchJson<unknown>(
    "/api/v1/settings/chat-model-preferences",
    {
      timeoutMs: FETCH_TIMEOUT_MS,
      method: "PUT",
      body: { expectedRevision, document },
    },
  ));
}

function parseSharedPreferencesSnapshot(value: unknown): ChatModelPreferencesSnapshot {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
    || typeof value.updatedAt !== "string"
    || Number.isNaN(Date.parse(value.updatedAt))
    || !isRecord(value.document)
    || !isRecord(value.document.main)
    || !isRecord(value.document.sub)
    || !Array.isArray(value.document.presets)) {
    throw new Error("Studio Server returned incompatible chat model preferences.");
  }
  return {
    revision: value.revision as number,
    document: parseChatModelPrefsDocument(value.document),
    updatedAt: value.updatedAt,
  };
}

function applySharedPreferences(document: ChatModelPrefsDocument): void {
  const parsed = parseChatModelPrefsDocument(document);
  chatModelProvider.value = parsed.main.provider;
  chatModelName.value = parsed.main.model;
  chatModelReasoningEffort.value = parsed.main.reasoningEffort;
  chatModelSubProvider.value = parsed.sub.provider;
  chatModelSubName.value = parsed.sub.model;
  chatModelSubReasoningEffort.value = parsed.sub.reasoningEffort;
  chatModelPresets.value = parsed.presets;
  chatModelActivePresetId.value = parsed.activePresetId;
  lastSyncedDocument = serializePrefsDocument(parsed);
  writeLocalPrefsDocument(parsed);
}

function currentPrefsDocument(): ChatModelPrefsDocument {
  return {
    main: currentChatModelPrefs(),
    sub: currentChatModelSubPrefs(),
    presets: chatModelPresets.value,
    ...(chatModelActivePresetId.value ? { activePresetId: chatModelActivePresetId.value } : {}),
  };
}

function serializePrefsDocument(document: ChatModelPrefsDocument): string {
  return JSON.stringify(document);
}

function writeLocalPrefsDocument(document: ChatModelPrefsDocument): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, serializePrefsDocument(document));
  } catch {
    // Local cache is best-effort; the authenticated server copy is authoritative.
  }
}

function emptyPrefs(): ChatModelPrefs {
  return { provider: "", model: "", reasoningEffort: "" };
}

function emptyDocument(): ChatModelPrefsDocument {
  return { main: emptyPrefs(), sub: emptyPrefs(), presets: [] };
}

function readPrefsDocument(): ChatModelPrefsDocument {
  if (typeof localStorage === "undefined") return emptyDocument();
  try {
    const current = localStorage.getItem(STORAGE_KEY);
    if (current !== null) {
      return parseChatModelPrefsDocument(JSON.parse(current) as unknown);
    }

    const officeV3 = localStorage.getItem(LEGACY_OFFICE_KEYS[0]);
    if (officeV3 !== null) {
      const migrated = parseChatModelPrefsDocument(JSON.parse(officeV3) as unknown);
      writeMigrated(migrated, LEGACY_OFFICE_KEYS[0]);
      return migrated;
    }

    const v2 = localStorage.getItem(LEGACY_V2_STORAGE_KEY) ?? localStorage.getItem(LEGACY_OFFICE_KEYS[1]);
    if (v2 !== null) {
      const migrated = migrateLegacyV2(JSON.parse(v2) as unknown);
      writeMigrated(migrated, LEGACY_V2_STORAGE_KEY);
      return migrated;
    }

    const v1 = localStorage.getItem(LEGACY_V1_STORAGE_KEY) ?? localStorage.getItem(LEGACY_OFFICE_KEYS[2]);
    if (v1 === null) return emptyDocument();
    const migrated = migrateLegacyV1(JSON.parse(v1) as unknown);
    writeMigrated(migrated, LEGACY_V1_STORAGE_KEY);
    return migrated;
  } catch {
    return emptyDocument();
  }
}

function migrateLegacyV2(value: unknown): ChatModelPrefsDocument {
  if (!isRecord(value)) return emptyDocument();
  return {
    main: {
      provider: typeof value.provider === "string" ? value.provider : "",
      model: typeof value.model === "string" ? value.model : "",
      reasoningEffort: typeof value.reasoningEffort === "string"
        ? sanitizeReasoningEffort(value.reasoningEffort)
        : "",
    },
    sub: emptyPrefs(),
    presets: [],
  };
}

function migrateLegacyV1(value: unknown): ChatModelPrefsDocument {
  if (!isRecord(value)) return emptyDocument();
  return {
    main: {
      provider: typeof value.provider === "string"
        ? (value.provider === "custom" ? CHAT_MODEL_MANUAL_PROVIDER : value.provider)
        : "",
      model: typeof value.model === "string" ? value.model : "",
      reasoningEffort: "",
    },
    sub: emptyPrefs(),
    presets: [],
  };
}

function writeMigrated(document: ChatModelPrefsDocument, legacyKey: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(document));
    localStorage.removeItem(legacyKey);
  } catch {
    // Migration write is best-effort.
  }
}

function newPresetId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
