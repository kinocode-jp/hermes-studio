import type { HermesProfileBackendAccess, HermesProfileBackendResolveOptions } from "./hermes-settings.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_MODELS = 500;
const DEFAULT_MAX_PROVIDERS = 200;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,127}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./:+@-]{0,255}$/;
const HERMES_PICKER_OPTIONS_PATH = "/api/model/options?include_unconfigured=1";

/** Canonical Hermes reasoning_effort values Office may surface (never invent). */
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
const MAX_REASONING_EFFORTS = REASONING_EFFORT_VALUES.length;

export interface LiveModelOption {
  id: string;
  label: string;
  /**
   * Explicit effort levels published by Hermes for this model.
   * Omitted when Hermes did not enumerate levels (do not invent defaults).
   */
  reasoningEfforts?: ReasoningEffortValue[];
}

export interface LiveProviderOption {
  id: string;
  label: string;
  active: boolean;
}

/** Public Office DTO — never includes credentials, config values, or diagnostics. */
export interface LiveModelsCatalog {
  profile: string;
  providers: LiveProviderOption[];
  /** Selected provider used for the models list (active or requested). */
  provider: string;
  /** Profile-configured model target used when Studio resets an open chat to Default. */
  defaultProvider: string;
  defaultModel: string;
  models: LiveModelOption[];
  refreshedAt: string;
}

export interface HermesModelsAdapterOptions {
  resolveProfileBackend(profile: string, options?: HermesProfileBackendResolveOptions): Promise<HermesProfileBackendAccess>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxModels?: number;
  maxProviders?: number;
}

export interface HermesModelsAdapter {
  loadLiveCatalog(
    profile: string,
    provider?: string,
    loadOptions?: { forceRefresh?: boolean; allowRefresh?: boolean },
  ): Promise<LiveModelsCatalog>;
  /**
   * Import providers exposed by supported local CLI proxies/runtimes into this
   * Hermes profile as secret-free, fixed-loopback custom endpoints.
   */
  syncLocalCliProviders(profile: string): Promise<{ registered: number }>;
}

export class HermesModelsError extends Error {
  readonly code: "invalid_request" | "not_found" | "rejected" | "response_too_large" | "timed_out";

  constructor(code: HermesModelsError["code"], message: string) {
    super(message);
    this.name = "HermesModelsError";
    this.code = code;
  }
}

/** Soft cache for repeated panel opens (provider switch still goes live when provider changes). */
const CATALOG_CACHE_TTL_MS = 45_000;

type CatalogCacheEntry = { expiresAt: number; catalog: LiveModelsCatalog };

/**
 * Loads a profile-scoped live model catalog from Hermes via loopback sidecar.
 * Concurrent loads for the same profile+provider coalesce onto one flight.
 * Successful catalogs are retained briefly so reopening the model panel is cheap.
 */
export function createHermesModelsAdapter(options: HermesModelsAdapterOptions): HermesModelsAdapter {
  const timeoutMs = bounded(options.timeoutMs, DEFAULT_TIMEOUT_MS, 250, 60_000);
  const maxResponseBytes = bounded(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 4_096, 8 * 1024 * 1024);
  const maxModels = bounded(options.maxModels, DEFAULT_MAX_MODELS, 1, 2_000);
  const maxProviders = bounded(options.maxProviders, DEFAULT_MAX_PROVIDERS, 1, 500);
  const flights = new Map<string, Promise<LiveModelsCatalog>>();
  const cache = new Map<string, CatalogCacheEntry>();
  const refreshGenerations = new Map<string, number>();
  const activeRefreshes = new Map<string, number>();

  return {
    loadLiveCatalog(
      profile: string,
      provider?: string,
      loadOptions?: { forceRefresh?: boolean; allowRefresh?: boolean },
    ): Promise<LiveModelsCatalog> {
      const validProfile = requiredProfile(profile);
      const requested = provider === undefined || provider.trim() === ""
        ? ""
        : requiredProvider(provider);
      const forceRefresh = loadOptions?.forceRefresh === true;
      // `forceRefresh` is an explicit mutating intent for existing adapter
      // callers. HTTP viewers never set it; the POST refresh route sets both.
      const allowRefresh = forceRefresh || loadOptions?.allowRefresh === true;
      // A read-only viewer must never join a flight whose cache miss can POST
      // provider refreshes. Likewise, an explicit refresh must not coalesce
      // onto an older non-refresh flight and silently lose the user action.
      const flightKey = `${validProfile}\0${requested}\0${allowRefresh ? "refreshable" : "read-only"}\0${forceRefresh ? "fresh" : "cached"}`;
      const cacheKey = `${validProfile}\0${requested}`;

      if (!forceRefresh) {
        const hit = cache.get(cacheKey);
        if (hit !== undefined && hit.expiresAt > Date.now()) {
          return Promise.resolve(hit.catalog);
        }
      }

      const existing = flights.get(flightKey);
      if (existing !== undefined) return existing;

      const refreshIntent = allowRefresh;
      const startedDuringRefresh = (activeRefreshes.get(cacheKey) ?? 0) > 0;
      const refreshGeneration = refreshIntent
        ? (refreshGenerations.get(cacheKey) ?? 0) + 1
        : (refreshGenerations.get(cacheKey) ?? 0);
      if (refreshIntent) {
        refreshGenerations.set(cacheKey, refreshGeneration);
        activeRefreshes.set(cacheKey, (activeRefreshes.get(cacheKey) ?? 0) + 1);
      }

      const flight = loadCatalog(
        validProfile,
        requested,
        options.resolveProfileBackend,
        timeoutMs,
        maxResponseBytes,
        maxModels,
        maxProviders,
        forceRefresh,
        allowRefresh,
      ).then((catalog) => {
        // A read-only flight that overlaps a refresh may have observed the old
        // catalog. Never let it overwrite the explicit refresh result merely
        // because its GET completed later.
        const generationIsCurrent = (refreshGenerations.get(cacheKey) ?? 0) === refreshGeneration;
        const noRefreshInFlight = (activeRefreshes.get(cacheKey) ?? 0) === 0;
        if (generationIsCurrent && (refreshIntent || (!startedDuringRefresh && noRefreshInFlight))) {
          cache.set(cacheKey, {
            expiresAt: Date.now() + CATALOG_CACHE_TTL_MS,
            catalog,
          });
        }
        return catalog;
      }).finally(() => {
        if (flights.get(flightKey) === flight) flights.delete(flightKey);
        if (refreshIntent) {
          const remaining = (activeRefreshes.get(cacheKey) ?? 1) - 1;
          if (remaining <= 0) activeRefreshes.delete(cacheKey);
          else activeRefreshes.set(cacheKey, remaining);
        }
      });
      flights.set(flightKey, flight);
      return flight;
    },
    async syncLocalCliProviders(profile: string): Promise<{ registered: number }> {
      const validProfile = requiredProfile(profile);
      const deadlineMs = Date.now() + timeoutMs;
      const discovered = await discoverLocalModelProviders(
        deadlineMs,
        maxResponseBytes,
        maxModels,
        maxProviders,
      );
      if (discovered.length === 0) return { registered: 0 };

      const lease = await resolveProfileBackendBeforeDeadline(
        validProfile,
        options.resolveProfileBackend,
        deadlineMs,
      );
      try {
        const client = new ProfileModelsClient(
          normalizeBackend(lease),
          deadlineMs,
          maxResponseBytes,
        );
        const current = await client.requestOptional("/api/providers/custom-endpoints", "GET");
        const existing = extractCustomEndpointSignatures(current);
        const obsolete = new Set<string>();
        for (const [id, signature] of existing) {
          if (isLegacyOpenCodexEndpoint(id) && signature.baseUrl === OPENCODEX_BASE_URL) {
            obsolete.add(id);
          }
        }
        let registered = 0;
        for (const provider of discovered) {
          const nativeEndpoint = [...existing.entries()].find(([id, signature]) => (
            id !== provider.endpointId
            && !isStudioLocalEndpoint(id)
            && signature.baseUrl === provider.baseUrl
          ));
          // Reuse a user/Hermes-owned endpoint for the same local runtime.
          // Creating a second row makes Hermes intentionally collapse the two.
          if (nativeEndpoint !== undefined) {
            const own = existing.get(provider.endpointId);
            if (own?.baseUrl === provider.baseUrl) obsolete.add(provider.endpointId);
            continue;
          }
          const signature = existing.get(provider.endpointId);
          // The stable prefix is ours, but never overwrite a hand-written
          // endpoint that happens to use the same id for another host.
          if (signature !== undefined && signature.baseUrl !== provider.baseUrl) continue;
          if (
            signature !== undefined
            && provider.models.every((model) => signature.models.includes(model))
          ) continue;
          await client.request("/api/providers/custom-endpoints", "POST", {
            id: provider.endpointId,
            name: provider.name,
            base_url: provider.baseUrl,
            model: provider.models[0],
            models: provider.models,
            discover_models: false,
            make_default: false,
          });
          registered += 1;
        }
        for (const id of obsolete) {
          await client.requestOptional(
            `/api/providers/custom-endpoints/${encodeURIComponent(id)}`,
            "DELETE",
          );
        }
        for (const key of cache.keys()) {
          if (key.startsWith(`${validProfile}\0`)) cache.delete(key);
        }
        return { registered };
      } finally {
        lease.release();
      }
    },
  };
}

const OPENCODEX_ORIGIN = "http://127.0.0.1:10100";
const OPENCODEX_BASE_URL = `${OPENCODEX_ORIGIN}/v1`;
const OPENCODEX_ENDPOINT_ID = "local-cli-opencodex";

export type LocalModelProvider = {
  endpointId: string;
  name: string;
  baseUrl: string;
  models: string[];
};

const LOCAL_OPENAI_RUNTIMES = [
  { id: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1" },
  { id: "lm-studio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
  { id: "vllm", label: "vLLM", baseUrl: "http://127.0.0.1:8000/v1" },
] as const;

async function discoverLocalModelProviders(
  deadlineMs: number,
  maxResponseBytes: number,
  maxModels: number,
  maxProviders: number,
): Promise<LocalModelProvider[]> {
  const discovered = await Promise.all([
    discoverOpenCodexProviders(deadlineMs, maxResponseBytes, maxModels, maxProviders),
    ...LOCAL_OPENAI_RUNTIMES.map(async (runtime) => {
      const payload = await fetchLocalJson(`${runtime.baseUrl}/models`, deadlineMs, maxResponseBytes, 1_500);
      const models = extractOpenAiCompatibleModelIds(payload, maxModels);
      if (models.length === 0) return [];
      return [{
        endpointId: `local-runtime-${runtime.id}`,
        name: `${runtime.label} · Local runtime`,
        baseUrl: runtime.baseUrl,
        models,
      } satisfies LocalModelProvider];
    }),
  ]);
  const unique = new Map<string, LocalModelProvider>();
  for (const group of discovered) {
    for (const provider of group) {
      if (!unique.has(provider.endpointId)) unique.set(provider.endpointId, provider);
    }
  }
  return [...unique.values()].slice(0, maxProviders);
}

async function discoverOpenCodexProviders(
  deadlineMs: number,
  maxResponseBytes: number,
  maxModels: number,
  maxProviders: number,
): Promise<LocalModelProvider[]> {
  const [modelsPayload, configuredPayload] = await Promise.all([
    fetchLocalJson(`${OPENCODEX_BASE_URL}/models`, deadlineMs, maxResponseBytes, 3_000),
    fetchLocalJson(`${OPENCODEX_ORIGIN}/api/providers`, deadlineMs, maxResponseBytes, 3_000),
  ]);
  return extractOpenCodexProviders(modelsPayload, configuredPayload, maxModels, maxProviders);
}

/** Pure, secret-free extraction of the local OpenCodex routing gateway. */
export function extractOpenCodexProviders(
  modelsPayload: unknown,
  configuredPayload: unknown,
  maxModels: number,
  maxProviders: number,
): LocalModelProvider[] {
  if (!isRecord(modelsPayload) || !Array.isArray(modelsPayload.data)) return [];
  const configured = extractEnabledOpenCodexProviders(configuredPayload, maxProviders);
  const models: string[] = [];
  const rowLimit = Math.max(maxModels, maxModels * maxProviders);
  for (const row of modelsPayload.data.slice(0, rowLimit)) {
    if (!isRecord(row)) continue;
    const model = sanitizeModelId(row.id);
    if (model === undefined) continue;
    const slash = model.indexOf("/");
    const provider = sanitizeProvider(row.owned_by)
      ?? (slash > 0 ? sanitizeProvider(model.slice(0, slash)) : "openai");
    if (provider === undefined || (configured !== undefined && !configured.has(provider.toLowerCase()))) continue;
    if (models.length >= maxModels || models.includes(model)) continue;
    models.push(model);
  }
  if (models.length === 0) return [];
  return [{
    endpointId: OPENCODEX_ENDPOINT_ID,
    name: "OpenCodex · Local gateway",
    baseUrl: OPENCODEX_BASE_URL,
    models,
  }];
}

function extractEnabledOpenCodexProviders(value: unknown, maxProviders: number): Set<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const providers = new Set<string>();
  for (const row of value.slice(0, maxProviders * 2)) {
    if (!isRecord(row) || row.disabled === true) continue;
    const id = sanitizeProvider(row.name ?? row.id);
    if (id === undefined) continue;
    providers.add(id.toLowerCase());
    if (providers.size >= maxProviders) break;
  }
  return providers;
}

function extractOpenAiCompatibleModelIds(value: unknown, maxModels: number): string[] {
  if (!isRecord(value)) return [];
  const rows = Array.isArray(value.data)
    ? value.data
    : Array.isArray(value.models) ? value.models : [];
  const models: string[] = [];
  for (const row of rows.slice(0, maxModels * 2)) {
    const id = sanitizeModelId(isRecord(row) ? row.id ?? row.model ?? row.name : row);
    if (id === undefined || models.includes(id)) continue;
    models.push(id);
    if (models.length >= maxModels) break;
  }
  return models;
}

async function fetchLocalJson(
  url: string,
  deadlineMs: number,
  maxResponseBytes: number,
  timeoutCapMs: number,
): Promise<unknown | undefined> {
  const target = new URL(url);
  if (target.protocol !== "http:" || !isLoopback(target.hostname) || target.username !== "" || target.password !== "") {
    return undefined;
  }
  const remainingMs = Math.min(timeoutCapMs, deadlineMs - Date.now());
  if (remainingMs <= 0) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingMs);
  timer.unref();
  try {
    const response = await fetch(target, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const text = await readBoundedText(response, maxResponseBytes);
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function extractCustomEndpointSignatures(
  value: unknown,
): Map<string, { baseUrl: string; models: string[] }> {
  const result = new Map<string, { baseUrl: string; models: string[] }>();
  if (!isRecord(value) || !Array.isArray(value.endpoints)) return result;
  for (const row of value.endpoints) {
    if (!isRecord(row) || typeof row.id !== "string" || typeof row.base_url !== "string") continue;
    const models = Array.isArray(row.models)
      ? row.models.flatMap((model) => {
        const safe = sanitizeModelId(model);
        return safe === undefined ? [] : [safe];
      })
      : [];
    result.set(row.id, { baseUrl: row.base_url.replace(/\/$/, ""), models });
  }
  return result;
}

function isStudioLocalEndpoint(id: string): boolean {
  return id.startsWith("local-cli-") || id.startsWith("local-runtime-");
}

function isLegacyOpenCodexEndpoint(id: string): boolean {
  return id.startsWith("local-cli-") && id !== OPENCODEX_ENDPOINT_ID;
}

async function loadCatalog(
  profile: string,
  requestedProvider: string,
  resolveProfileBackend: HermesModelsAdapterOptions["resolveProfileBackend"],
  timeoutMs: number,
  maxResponseBytes: number,
  maxModels: number,
  maxProviders: number,
  forceRefresh: boolean,
  allowRefresh: boolean,
): Promise<LiveModelsCatalog> {
  // Include cold profile-process startup and pool-capacity waits in the same
  // deadline as the catalog probes. This must stay below the Web client's
  // outer request timeout.
  const deadlineMs = Date.now() + timeoutMs;
  const lease = await resolveProfileBackendBeforeDeadline(
    profile,
    resolveProfileBackend,
    deadlineMs,
  );
  try {
    const client = new ProfileModelsClient(
      normalizeBackend(lease),
      deadlineMs,
      maxResponseBytes,
    );
    const modelInfo = await client.requestOptional("/api/model/info", "GET");
    const { providers, activeProvider } = await loadProviderList(client, maxProviders, modelInfo);
    const selected = resolveSelectedProvider(requestedProvider, providers, activeProvider);
    const defaultModel = extractConfiguredModel(modelInfo) ?? "";
    const defaultProvider = extractActiveProvider(modelInfo) ?? activeProvider;

    let models: LiveModelOption[] = [];
    if (selected !== "") {
      models = await loadModelsForProvider(client, selected, maxModels, forceRefresh, allowRefresh);
    }

    return {
      profile,
      providers: providers.map((item) => ({
        id: item.id,
        label: item.label,
        active: item.id === activeProvider || item.active,
      })),
      provider: selected,
      defaultProvider,
      defaultModel,
      models,
      refreshedAt: new Date().toISOString(),
    };
  } finally {
    lease.release();
  }
}

async function resolveProfileBackendBeforeDeadline(
  profile: string,
  resolveProfileBackend: HermesModelsAdapterOptions["resolveProfileBackend"],
  deadlineMs: number,
): Promise<HermesProfileBackendAccess> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw new HermesModelsError("timed_out", "Hermes model catalog request timed out.");
  }
  const timeoutError = new HermesModelsError("timed_out", "Hermes model catalog request timed out.");
  let timedOut = false;
  const acquisition = resolveProfileBackend(profile, { deadlineMs }).then((lease) => {
    if (!timedOut) return lease;
    // A timed-out pool acquisition cannot be cancelled. Release a lease that
    // arrives late so it does not pin the profile backend indefinitely.
    lease.release();
    throw timeoutError;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(timeoutError);
    }, remainingMs);
    timer.unref();
  });
  try {
    return await Promise.race([acquisition, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function loadProviderList(
  client: ProfileModelsClient,
  maxProviders: number,
  modelInfo: unknown,
): Promise<{ providers: LiveProviderOption[]; activeProvider: string }> {
  // Prefer the local/session catalog first (usually cached in Hermes).
  // Only fall through when the response has no real provider rows.
  const primary = await client.requestOptional("/api/models", "GET");
  let acc = extractProviders(primary, maxProviders);

  // The configured options surface is the authoritative place for named
  // custom endpoints, including providers imported from local CLI proxies.
  // Merge it even when the fast session catalog already listed providers.
  const configured = await client.requestOptional(HERMES_PICKER_OPTIONS_PATH, "GET");
  acc = mergeProviderCatalogs(acc, extractProviders(configured, maxProviders), maxProviders);

  const fallbacks = [
    "/api/models?freshness=session_visit",
    "/api/providers",
  ] as const;
  for (const path of fallbacks) {
    if (acc.hasListedProviders) break;
    const raw = await client.requestOptional(path, "GET");
    acc = mergeProviderExtracts(acc, extractProviders(raw, maxProviders), maxProviders);
  }

  if (acc.activeProvider === "") {
    const fromInfo = extractActiveProvider(modelInfo);
    if (fromInfo !== undefined) {
      acc = mergeProviderExtracts(
        acc,
        { providers: [], activeProvider: fromInfo, hasListedProviders: false },
        maxProviders,
      );
    }
  }

  return { providers: acc.providers, activeProvider: acc.activeProvider };
}

function mergeProviderCatalogs(
  base: ProviderListExtract,
  next: ProviderListExtract,
  maxProviders: number,
): ProviderListExtract {
  const activeProvider = next.activeProvider || base.activeProvider;
  const merged = new Map<string, LiveProviderOption>();
  for (const item of [...base.providers, ...next.providers]) {
    const existing = merged.get(item.id);
    merged.set(item.id, existing === undefined
      ? { ...item }
      : {
        id: item.id,
        label: item.label === item.id ? existing.label : item.label,
        active: existing.active || item.active,
      });
    if (merged.size >= maxProviders) break;
  }
  const providers = [...merged.values()];
  ensureActiveProviderRow(providers, activeProvider, maxProviders);
  return {
    providers,
    activeProvider,
    hasListedProviders: base.hasListedProviders || next.hasListedProviders,
  };
}

async function loadModelsForProvider(
  client: ProfileModelsClient,
  provider: string,
  maxModels: number,
  forceRefresh: boolean,
  allowRefresh: boolean,
): Promise<LiveModelOption[]> {
  // Fast path: serve whatever Hermes already has in its live list.
  // POST /api/models/refresh often hits remote provider APIs and dominates latency.
  const fromLive = filterLocalCliModels(
    provider,
    await tryLoadLiveModels(client, provider, maxModels),
  );
  if (fromLive.length > 0 && !forceRefresh) return fromLive;

  if (allowRefresh && (forceRefresh || fromLive.length === 0)) {
    // Compatibility gaps are optional, but auth, transport, 5xx and malformed
    // success responses must fail an explicit refresh instead of presenting a
    // stale list as freshly updated.
    await client.requestRefreshOptional("/api/models/refresh", { provider });
    const afterRefresh = filterLocalCliModels(
      provider,
      await tryLoadLiveModels(client, provider, maxModels),
    );
    if (afterRefresh.length > 0) return afterRefresh;
  }

  // Fallback: curated models from options for this provider only (no extra parallel fan-out).
  try {
    const optionsPayload = await client.requestOptional(
      HERMES_PICKER_OPTIONS_PATH,
      "GET",
    );
    return extractModelsForProvider(optionsPayload, provider, maxModels);
  } catch (error) {
    if (error instanceof HermesModelsError && error.code === "timed_out") throw error;
    return fromLive;
  }
}

function filterLocalCliModels(provider: string, models: LiveModelOption[]): LiveModelOption[] {
  if (provider.startsWith("local-runtime-")) return models;
  if (provider === OPENCODEX_ENDPOINT_ID) return models;
  const marker = "local-cli-";
  if (!provider.startsWith(marker)) return models;
  const sourceProvider = provider.slice(marker.length);
  // Compatibility for profiles that still contain a legacy per-provider
  // OpenCodex endpoint during migration. The canonical gateway keeps all rows.
  if (sourceProvider === "openai") return models.filter((model) => !model.id.includes("/"));
  return models.filter((model) => model.id.startsWith(`${sourceProvider}/`));
}

async function tryLoadLiveModels(
  client: ProfileModelsClient,
  provider: string,
  maxModels: number,
): Promise<LiveModelOption[]> {
  try {
    const live = await client.request(
      `/api/models/live?provider=${encodeURIComponent(provider)}`,
      "GET",
    );
    return extractLiveModels(live, maxModels);
  } catch (error) {
    if (error instanceof HermesModelsError && error.code === "timed_out") throw error;
    return [];
  }
}

function resolveSelectedProvider(
  requested: string,
  providers: readonly LiveProviderOption[],
  activeProvider: string,
): string {
  if (requested !== "") {
    if (providers.some((item) => item.id === requested)) return requested;
    // Allow explicit request even if Hermes list is empty/stale (user may still switch).
    return requested;
  }
  if (activeProvider !== "" && (providers.length === 0 || providers.some((item) => item.id === activeProvider))) {
    return activeProvider;
  }
  const marked = providers.find((item) => item.active);
  if (marked !== undefined) return marked.id;
  return providers[0]?.id ?? "";
}

/** Result of parsing a single Hermes provider-list surface. */
export type ProviderListExtract = {
  providers: LiveProviderOption[];
  activeProvider: string;
  /**
   * True when the payload included a provider array/list (even if every row
   * was filtered). False for active-only or empty/null payloads so discovery
   * can continue to the next Hermes endpoint.
   */
  hasListedProviders: boolean;
};

/** Exported for focused pure tests (safe public fields only). */
export function extractProviders(value: unknown, maxProviders: number): ProviderListExtract {
  if (value === undefined || value === null) {
    return { providers: [], activeProvider: "", hasListedProviders: false };
  }
  const activeFromRoot = extractActiveProvider(value) ?? "";
  const rows = collectProviderRows(value);
  const hasListedProviders = rows.length > 0;
  const providers: LiveProviderOption[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, maxProviders * 2)) {
    if (providers.length >= maxProviders) break;
    const option = normalizeProviderOption(row, activeFromRoot);
    if (option === undefined || seen.has(option.id)) continue;
    seen.add(option.id);
    providers.push(option);
  }
  let activeProvider = activeFromRoot;
  if (activeProvider === "") {
    activeProvider = providers.find((item) => item.active)?.id ?? "";
  }
  ensureActiveProviderRow(providers, activeProvider, maxProviders);
  return { providers, activeProvider, hasListedProviders };
}

/**
 * Merge two discovery results. Prefer a real listed catalog from `next` when
 * present; keep known active provider identity; dedupe by id.
 */
export function mergeProviderExtracts(
  base: ProviderListExtract,
  next: ProviderListExtract,
  maxProviders: number,
): ProviderListExtract {
  const activeProvider = next.activeProvider || base.activeProvider;
  let providers: LiveProviderOption[];
  let hasListedProviders: boolean;

  if (next.hasListedProviders) {
    // Fallback catalog wins as the primary list.
    const map = new Map<string, LiveProviderOption>();
    for (const item of next.providers) map.set(item.id, { ...item });
    providers = [...map.values()];
    hasListedProviders = true;
  } else if (base.hasListedProviders) {
    providers = base.providers.map((item) => ({ ...item }));
    hasListedProviders = true;
  } else {
    // Neither side listed real rows — merge injected/partial seeds (active-only).
    const map = new Map<string, LiveProviderOption>();
    for (const item of base.providers) map.set(item.id, { ...item });
    for (const item of next.providers) map.set(item.id, { ...item });
    providers = [...map.values()];
    hasListedProviders = false;
  }

  ensureActiveProviderRow(providers, activeProvider, maxProviders);
  if (providers.length > maxProviders) providers = providers.slice(0, maxProviders);
  return { providers, activeProvider, hasListedProviders };
}

function ensureActiveProviderRow(
  providers: LiveProviderOption[],
  activeProvider: string,
  maxProviders: number,
): void {
  if (activeProvider === "") return;
  const existing = providers.find((item) => item.id === activeProvider);
  if (existing !== undefined) {
    existing.active = true;
    return;
  }
  if (providers.length >= maxProviders) providers.pop();
  providers.unshift({
    id: activeProvider,
    label: activeProvider,
    active: true,
  });
}

/** Exported for focused pure tests. */
export function extractLiveModels(value: unknown, maxModels: number): LiveModelOption[] {
  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.models)
      ? value.models
      : isRecord(value) && Array.isArray(value.items)
        ? value.items
        : isRecord(value) && Array.isArray(value.data)
          ? value.data
          : [];
  const capabilityMap = isRecord(value) && isRecord(value.capabilities) ? value.capabilities : undefined;

  const models: LiveModelOption[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, maxModels * 2)) {
    if (models.length >= maxModels) break;
    let option = normalizeModelOption(row);
    if (option === undefined || seen.has(option.id)) continue;
    if (option.reasoningEfforts === undefined && capabilityMap !== undefined) {
      const fromCaps = extractReasoningEfforts(capabilityMap[option.id]);
      if (fromCaps !== undefined) option = { ...option, reasoningEfforts: fromCaps };
    }
    seen.add(option.id);
    models.push(option);
  }
  return models;
}

/**
 * Pull explicit reasoning-effort enumerations from Hermes-shaped payloads.
 * Returns undefined when no safe enumeration is present (boolean flags alone are ignored).
 */
export function extractReasoningEfforts(source: unknown): ReasoningEffortValue[] | undefined {
  if (source === undefined || source === null) return undefined;
  if (typeof source === "string" || Array.isArray(source)) return normalizeEffortList(source);
  if (!isRecord(source)) return undefined;

  for (const key of [
    "reasoning_efforts",
    "reasoningEfforts",
    "supported_reasoning_efforts",
    "supportedReasoningEfforts",
    "reasoning_effort_options",
    "allowed_reasoning_efforts",
    "allowedReasoningEfforts",
  ] as const) {
    const list = normalizeEffortList(source[key]);
    if (list !== undefined) return list;
  }

  if (isRecord(source.reasoning)) {
    for (const key of ["levels", "allowed_options", "options", "efforts", "effort_levels", "values"] as const) {
      const list = normalizeEffortList(source.reasoning[key]);
      if (list !== undefined) return list;
    }
  }

  if (isRecord(source.supports)) {
    const list = normalizeEffortList(
      source.supports.reasoning_effort ?? source.supports.reasoning_efforts ?? source.supports.reasoningEfforts,
    );
    if (list !== undefined) return list;
  }

  if (isRecord(source.capabilities)) {
    const nested = extractReasoningEfforts(source.capabilities);
    if (nested !== undefined) return nested;
  }

  return undefined;
}

function normalizeEffortList(value: unknown): ReasoningEffortValue[] | undefined {
  const items: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\s|]+/).filter(Boolean)
      : [];
  if (items.length === 0) return undefined;
  const seen = new Set<string>();
  for (const item of items.slice(0, MAX_REASONING_EFFORTS * 2)) {
    if (typeof item !== "string") continue;
    const effort = item.trim().toLowerCase();
    if (!REASONING_EFFORT_SET.has(effort) || seen.has(effort)) continue;
    seen.add(effort);
  }
  const ordered = REASONING_EFFORT_VALUES.filter((effort) => seen.has(effort));
  return ordered.length > 0 ? ordered : undefined;
}

function extractModelsForProvider(value: unknown, provider: string, maxModels: number): LiveModelOption[] {
  if (!isRecord(value) || !Array.isArray(value.providers)) return [];
  for (const row of value.providers) {
    if (!isRecord(row)) continue;
    const id = sanitizeProvider(row.slug ?? row.id ?? row.provider ?? row.name);
    if (id !== provider) continue;
    const models = row.models;
    if (!Array.isArray(models)) return [];
    return extractLiveModels({
      models,
      ...(isRecord(row.capabilities) ? { capabilities: row.capabilities } : {}),
    }, maxModels);
  }
  return [];
}

function collectProviderRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ["providers", "items", "data"] as const) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
  }
  return [];
}

function normalizeProviderOption(value: unknown, activeFromRoot: string): LiveProviderOption | undefined {
  if (typeof value === "string") {
    const id = sanitizeProvider(value);
    return id === undefined ? undefined : { id, label: id, active: id === activeFromRoot };
  }
  if (!isRecord(value)) return undefined;
  const id = sanitizeProvider(value.id ?? value.slug ?? value.provider ?? value.name);
  if (id === undefined) return undefined;
  const label = sanitizeLabel(value.label ?? value.display_name ?? value.displayName ?? value.name ?? id) ?? id;
  const active = value.active === true
    || value.is_current === true
    || value.isCurrent === true
    || value.current === true
    || id === activeFromRoot;
  // Keep canonical/unconfigured Hermes rows so Studio mirrors the full picker,
  // but continue honoring an explicit user/provider disable marker.
  if (!active && (value.enabled === false || value.available === false)) return undefined;
  return { id, label, active };
}

function extractActiveProvider(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["provider", "active_provider", "activeProvider", "current_provider", "currentProvider"] as const) {
    const candidate = sanitizeProvider(value[key]);
    if (candidate !== undefined) return candidate;
  }
  if (isRecord(value.model)) {
    const nested = sanitizeProvider(value.model.provider);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function extractConfiguredModel(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["model", "default_model", "defaultModel", "current_model", "currentModel"] as const) {
    const candidate = sanitizeModelId(value[key]);
    if (candidate !== undefined) return candidate;
  }
  if (isRecord(value.model)) {
    for (const key of ["id", "name", "default"] as const) {
      const nested = sanitizeModelId(value.model[key]);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function normalizeModelOption(value: unknown): LiveModelOption | undefined {
  if (typeof value === "string") {
    const id = sanitizeModelId(value);
    return id === undefined ? undefined : { id, label: id };
  }
  if (!isRecord(value)) return undefined;
  const id = sanitizeModelId(value.id ?? value.model ?? value.name ?? value.slug);
  if (id === undefined) return undefined;
  const label = sanitizeLabel(value.label ?? value.name ?? value.display_name ?? value.displayName ?? id) ?? id;
  const reasoningEfforts = extractReasoningEfforts(value);
  return {
    id,
    label,
    ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
  };
}

interface NormalizedBackend {
  baseUrl: URL;
  sessionToken: string;
}

class ProfileModelsClient {
  constructor(
    private readonly backend: NormalizedBackend,
    private readonly deadlineMs: number,
    private readonly maxResponseBytes: number,
  ) {}

  async request(path: string, method: "GET" | "POST" | "DELETE", body?: Record<string, unknown>): Promise<unknown> {
    return await this.#fetch(path, method, body, false);
  }

  async requestOptional(path: string, method: "GET" | "POST" | "DELETE", body?: Record<string, unknown>): Promise<unknown> {
    return await this.#fetch(path, method, body, true);
  }

  async requestRefreshOptional(path: string, body: Record<string, unknown>): Promise<unknown> {
    return await this.#fetch(path, "POST", body, true, true);
  }

  async #fetch(
    path: string,
    method: "GET" | "POST" | "DELETE",
    body: Record<string, unknown> | undefined,
    optional: boolean,
    strictOptional = false,
  ): Promise<unknown> {
    const target = new URL(path, this.backend.baseUrl);
    if (
      target.origin !== this.backend.baseUrl.origin
      || !target.pathname.startsWith("/api/")
    ) {
      throw invalid("Hermes models path is invalid.");
    }

    const remainingMs = this.deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new HermesModelsError("timed_out", "Hermes model catalog request timed out.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    timer.unref();
    try {
      const response = await fetch(target, {
        method,
        headers: {
          Accept: "application/json",
          "X-Hermes-Session-Token": this.backend.sessionToken,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        // Auth must fail closed even on discovery paths.
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel().catch(() => undefined);
          throw rejected();
        }
        // Compatibility gaps (unknown query, missing route, method, not implemented).
        if (optional && (strictOptional ? isRefreshCompatibilityStatus(response.status) : isCompatibilityStatus(response.status))) {
          await response.body?.cancel().catch(() => undefined);
          return undefined;
        }
        if (response.status === 404) throw new HermesModelsError("not_found", "Hermes model catalog was not found.");
        throw rejected();
      }
      const text = await readBoundedText(response, this.maxResponseBytes);
      if (text === "") return {};
      try {
        return JSON.parse(text) as unknown;
      } catch {
        // Incomplete/non-JSON discovery payloads fall through to the next source.
        if (optional && !strictOptional) return undefined;
        throw rejected();
      }
    } catch (error) {
      if (error instanceof HermesModelsError) throw error;
      if (isAbortError(error)) throw new HermesModelsError("timed_out", "Hermes model catalog request timed out.");
      if (optional && !strictOptional) return undefined;
      throw rejected();
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Only statuses proving that the refresh surface itself is unavailable. */
function isRefreshCompatibilityStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

/** Status codes that mean "try another Hermes models/providers surface" for discovery. */
function isCompatibilityStatus(status: number): boolean {
  return status === 400
    || status === 404
    || status === 405
    || status === 406
    || status === 422
    || status === 501;
}

function sanitizeProvider(value: unknown): string | undefined {
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

function sanitizeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
  if (cleaned === "" || containsSuspicious(cleaned)) return undefined;
  return cleaned;
}

function containsSuspicious(value: string): boolean {
  if (value.includes("\0")) return true;
  const normalized = value.trim();
  // Provider vocabulary legitimately contains words such as "token-plan" and
  // "tokenhub". Reject credential-shaped content, not those public names.
  return /^(?:api[_-]?key|secret|token|password|credential|authorization|bearer)(?:[_-]?value)?$/i.test(normalized)
    || /(?:api[_-]?key|secret|token|password|credential|authorization)\s*[:=]\s*\S+/i.test(normalized)
    || /bearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(normalized)
    || /\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/i.test(normalized);
}

function normalizeBackend(value: HermesProfileBackendAccess): NormalizedBackend {
  const baseUrl = value.baseUrl instanceof URL ? new URL(value.baseUrl) : new URL(value.baseUrl);
  if (
    baseUrl.protocol !== "http:"
    || baseUrl.username !== ""
    || baseUrl.password !== ""
    || baseUrl.pathname !== "/"
    || baseUrl.search !== ""
    || baseUrl.hash !== ""
    || !isLoopback(baseUrl.hostname)
  ) {
    throw invalid("Profile backend must be a credential-free loopback HTTP origin.");
  }
  if (value.sessionToken.length < 16 || value.sessionToken.length > 512 || value.sessionToken.includes("\0")) {
    throw invalid("Profile backend token is invalid.");
  }
  return { baseUrl, sessionToken: value.sessionToken };
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new HermesModelsError("response_too_large", "Hermes model catalog response was too large.");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HermesModelsError("response_too_large", "Hermes model catalog response was too large.");
    }
    text += decoder.decode(value, { stream: true });
  }
}

function requiredProfile(value: unknown): string {
  if (typeof value !== "string" || !PROFILE_PATTERN.test(value)) {
    throw invalid("Profile name is invalid.");
  }
  return value;
}

function requiredProvider(value: string): string {
  const sanitized = sanitizeProvider(value);
  if (sanitized === undefined) throw invalid("Provider name is invalid.");
  return sanitized;
}

function invalid(message: string): HermesModelsError {
  return new HermesModelsError("invalid_request", message);
}

function rejected(): HermesModelsError {
  return new HermesModelsError("rejected", "Hermes model catalog is unavailable.");
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.trunc(value)));
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
