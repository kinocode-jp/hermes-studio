import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  GLOBAL_SETTINGS_MAX_SKILLS,
  isGlobalContextWithinBudget,
  SECRET_ENV_KEY_PATTERN,
} from "@hermes-studio/protocol";
import {
  BuiltinMemoryFilesError,
  BuiltinMemoryFilesStore,
  type BuiltinMemoryFileDto,
  type BuiltinMemoryFileKey,
  type BuiltinMemoryFilesDto,
  type BuiltinMemoryFilesStoreOptions,
} from "./builtin-memory-files.js";
import {
  buildHermesConfigPutBody,
  HermesConfigError,
  normalizeHermesConfigSchema,
  projectSafeHermesConfig,
  validateConfigPatchChanges,
  type HermesConfigDto,
  type HermesConfigPatch,
  type HermesConfigSchemaDto,
} from "./hermes-config.js";
import {
  buildPrivilegedHermesConfigPutBody,
  HermesPrivilegedConfigError,
  projectConfigSecretFieldMeta,
  projectPrivilegedHermesConfig,
  validatePrivilegedConfigPatchChanges,
  type HermesPrivilegedConfigDto,
  type HermesPrivilegedConfigPatch,
} from "./hermes-privileged-config.js";
import { KeyedOperationQueue } from "./keyed-operation-queue.js";
import { containsLikelySecret, isLikelySecretIdentifier, redactSecrets } from "./secret-scrubber.js";

export type { BuiltinMemoryFileDto, BuiltinMemoryFileKey, BuiltinMemoryFilesDto };
export type { HermesConfigDto, HermesConfigPatch, HermesConfigSchemaDto };
export type { HermesPrivilegedConfigDto, HermesPrivilegedConfigPatch };

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface HermesProfileBackendAccess {
  /** Credential-free loopback origin of a backend pinned to `profile`. */
  baseUrl: string | URL;
  sessionToken: string;
  /** Release exactly once after all requests for this operation have settled. */
  release(): void;
}

export interface HermesProfileBackendResolveOptions {
  /** Absolute wall-clock deadline shared by the whole public operation. */
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface HermesSettingsAdapterOptions {
  /**
   * Must resolve a process whose HERMES_HOME is the requested profile.
   * Hermes memory routes are process-scoped and cannot safely use ?profile=.
   * The adapter holds the returned lease until the whole public operation settles.
   */
  resolveProfileBackend(profile: string, options?: HermesProfileBackendResolveOptions): Promise<HermesProfileBackendAccess>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxSkillContentBytes?: number;
  /**
   * Optional filesystem store for raw MEMORY.md / USER.md editing.
   * Defaults to the platform Hermes root (including HERMES_HOME resolution).
   */
  builtinMemoryFiles?: BuiltinMemoryFilesStore | BuiltinMemoryFilesStoreOptions;
}

export interface SkillSettingsDto {
  name: string;
  category: string;
  description: string;
  enabled: boolean;
  provenance: "agent" | "bundled" | "hub" | "unknown";
  usage: number;
}

export interface SkillContentDto {
  name: string;
  content: string;
  redacted: boolean;
  revision: string;
}

export interface MemoryProviderDto {
  name: string;
  description: string;
  configured: boolean;
}

export interface MemoryStatusDto {
  activeProvider: string;
  providers: MemoryProviderDto[];
  builtin: {
    memoryBytes: number;
    userBytes: number;
    hasMemory: boolean;
    hasUser: boolean;
  };
}

export type MemoryFieldKind = "boolean" | "secret" | "select" | "text";

export interface MemoryProviderFieldDto {
  key: string;
  label: string;
  kind: MemoryFieldKind;
  description: string;
  required: boolean;
  isSet: boolean;
  /** Secret values are never returned. */
  value?: boolean | string;
  options: Array<{ value: string; label: string; description: string }>;
}

export interface MemoryProviderConfigDto {
  name: string;
  label: string;
  fields: MemoryProviderFieldDto[];
  revision: string;
}

export interface ProfileSoulDto {
  profile: string;
  content: string;
  exists: boolean;
  redacted: boolean;
  revision: string;
}

export interface ProfileAgentSettingsDto {
  profile: string;
  skills: SkillSettingsDto[];
  memory: MemoryStatusDto;
  soul: ProfileSoulDto;
}

export interface HermesSettingsAdapter {
  getProfileSettings(profile: string): Promise<ProfileAgentSettingsDto>;
  listSkills(profile: string, options?: Pick<HermesProfileBackendResolveOptions, "deadlineMs">): Promise<SkillSettingsDto[]>;
  setSkillEnabled(
    profile: string,
    name: string,
    enabled: boolean,
    expectedEnabled?: boolean,
    options?: Pick<HermesProfileBackendResolveOptions, "deadlineMs">,
  ): Promise<void>;
  getSkillContent(profile: string, name: string): Promise<SkillContentDto>;
  updateSkillContent(profile: string, name: string, content: string, expectedRevision?: string): Promise<SkillContentDto>;
  getMemoryStatus(profile: string): Promise<MemoryStatusDto>;
  setMemoryProvider(profile: string, provider: string, expectedProvider?: string): Promise<MemoryStatusDto>;
  getMemoryProviderConfig(profile: string, provider: string): Promise<MemoryProviderConfigDto>;
  updateMemoryProviderConfig(profile: string, provider: string, values: Record<string, boolean | string>, expectedRevision?: string): Promise<MemoryProviderConfigDto>;
  /** Office-owned raw built-in memory documents (not a Hermes dashboard API). */
  getBuiltinMemoryFiles(profile: string): Promise<BuiltinMemoryFilesDto>;
  updateBuiltinMemoryFile(
    profile: string,
    key: BuiltinMemoryFileKey,
    content: string,
    expectedRevision: string,
  ): Promise<BuiltinMemoryFileDto>;
  resetBuiltinMemory(profile: string, target: "all" | "memory" | "user"): Promise<{ files: BuiltinMemoryFilesDto; status: MemoryStatusDto }>;
  getProfileSoul(profile: string): Promise<ProfileSoulDto>;
  updateProfileSoul(profile: string, content: string, expectedRevision?: string): Promise<ProfileSoulDto>;
  /** Schema-driven safe Hermes config leaves (official dashboard /api/config*). */
  getProfileConfigSchema(profile: string): Promise<HermesConfigSchemaDto>;
  getProfileConfig(profile: string): Promise<HermesConfigDto>;
  updateProfileConfig(profile: string, patch: HermesConfigPatch): Promise<HermesConfigDto>;
  /** Privileged non-secret leaves (owner + desktop-capability only). */
  getPrivilegedProfileConfig(profile: string): Promise<HermesPrivilegedConfigDto>;
  updatePrivilegedProfileConfig(profile: string, patch: HermesPrivilegedConfigPatch): Promise<HermesPrivilegedConfigDto>;
  /** Secret metadata only (env, config leaves, memory-provider declared secrets). Never returns values. */
  listProfileSecrets(profile: string): Promise<HermesSecretsDto>;
  /** Write a secret via official Hermes env/config/provider endpoints after transfer consume. */
  writeProfileSecret(profile: string, request: HermesSecretWriteRequest): Promise<HermesSecretsDto>;
}

export type HermesSecretSource = "env" | "config" | "memory-provider";

export interface HermesSecretFieldMetaDto {
  key: string;
  source: HermesSecretSource;
  label: string;
  description: string;
  category: string;
  isSet: boolean;
  isPassword: boolean;
  /**
   * Whether Clear is provably safe from live metadata alone.
   * For memory-provider: true only when isSet and a unique env key has
   * explicit provider === this field's provider. Never exposes env key names.
   * Server recomputes on clear regardless of this hint.
   */
  canClear: boolean;
  /** Present only for memory-provider secrets; validated Hermes provider id. */
  provider?: string;
  /** Provider display label when source is memory-provider. */
  providerLabel?: string;
}

export interface HermesSecretsDto {
  profile: string;
  revision: string;
  fields: HermesSecretFieldMetaDto[];
}

export interface HermesSecretWriteRequest {
  key: string;
  source: HermesSecretSource;
  value: string;
  /** Required when source is memory-provider. */
  provider?: string;
  expectedRevision?: string;
}

/** Bound discovery of declared memory-provider secret surfaces. */
const MEMORY_PROVIDER_SECRET_MAX_PROVIDERS = 20;
const MEMORY_PROVIDER_SECRET_MAX_FIELDS_PER = 32;
const SECRETS_MAX_FIELDS = 400;

export class HermesSettingsError extends Error {
  readonly code: "commit_unconfirmed" | "conflict" | "invalid_request" | "not_found" | "rejected" | "response_too_large" | "timed_out";
  constructor(code: HermesSettingsError["code"], message: string) {
    super(message);
    this.name = "HermesSettingsError";
    this.code = code;
  }
}

function asSettingsError(error: unknown): never {
  if (error instanceof HermesSettingsError) throw error;
  if (error instanceof HermesConfigError) {
    throw new HermesSettingsError(error.code, error.message);
  }
  if (error instanceof HermesPrivilegedConfigError) {
    throw new HermesSettingsError(error.code, error.message);
  }
  throw error;
}

export function createHermesSettingsAdapter(options: HermesSettingsAdapterOptions): HermesSettingsAdapter {
  const timeoutMs = bounded(options.timeoutMs, DEFAULT_TIMEOUT_MS, 250, 60_000);
  const maxResponseBytes = bounded(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 4_096, 8 * 1024 * 1024);
  const maxSkillContentBytes = bounded(options.maxSkillContentBytes, 256 * 1024, 1_024, 512 * 1024);
  const mutationQueue = new KeyedOperationQueue();
  const builtinMemoryFiles = options.builtinMemoryFiles instanceof BuiltinMemoryFilesStore
    ? options.builtinMemoryFiles
    : new BuiltinMemoryFilesStore(options.builtinMemoryFiles ?? {});

  const deadline = (): number => Date.now() + timeoutMs;
  const withClient = async <T>(
    profile: string,
    operation: (client: ProfileClient) => Promise<T>,
    deadlineMs = deadline(),
  ): Promise<T> => {
    const validProfile = requiredProfile(profile);
    const lease = await resolveProfileBackendBeforeDeadline(validProfile, options.resolveProfileBackend, deadlineMs);
    const client = new ProfileClient(validProfile, normalizeBackend(lease), deadlineMs, maxResponseBytes);
    try {
      return await operation(client);
    } catch (error) {
      if (client.mutationCommitted && !(error instanceof HermesSettingsError && error.code === "commit_unconfirmed")) {
        throw commitUnconfirmed();
      }
      throw error;
    } finally {
      lease.release();
    }
  };

  const runMutation = async <T>(
    key: string,
    operation: (deadlineMs: number) => Promise<T>,
    requestedDeadlineMs?: number,
  ): Promise<T> => {
    const deadlineMs = operationDeadline(deadline(), requestedDeadlineMs);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const queued = mutationQueue.run(key, async () => {
      assertBeforeDeadline(deadlineMs);
      markStarted();
      return await operation(deadlineMs);
    });
    // Bound queue capacity waits without cancelling the queued tail. Once the
    // operation starts, its profile client owns the same absolute deadline.
    await settleBeforeDeadline(Promise.race([started, queued.then(() => undefined)]), deadlineMs, timedOut);
    return await queued;
  };

  const runBuiltinMemoryMutation = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const deadlineMs = deadline();
    let started = false;
    const queued = mutationQueue.run(key, async () => {
      assertBeforeDeadline(deadlineMs);
      started = true;
      return await operation();
    });
    // Filesystem writes cannot be cancelled safely. Return on deadline while
    // leaving the real write as the queue tail; a retry therefore cannot race it.
    return await settleBeforeDeadline(queued, deadlineMs, () => started ? commitUnconfirmed() : timedOut());
  };

  const withBuiltinMemory = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BuiltinMemoryFilesError) {
        throw new HermesSettingsError(error.code, error.message);
      }
      throw error;
    }
  };

  const adapter: HermesSettingsAdapter = {
    getProfileSettings: async (profile) => await withClient(profile, async (client) => {
      const [skills, memory, soul] = await Promise.all([
        listSkillsWith(client),
        memoryStatusWith(client),
        soulWith(client),
      ]);
      return { profile: client.profile, skills, memory, soul };
    }),
    listSkills: async (profile, operationOptions) => await withClient(
      profile,
      listSkillsWith,
      operationDeadline(deadline(), operationOptions?.deadlineMs),
    ),
    setSkillEnabled: async (profile, name, enabled, expectedEnabled, operationOptions) => {
      const validProfile = requiredProfile(profile);
      const skill = requiredName(name, "skill");
      await runMutation(resourceKey(validProfile, "skill-toggle", skill), async (deadlineMs) => await withClient(validProfile, async (client) => {
        if (expectedEnabled !== undefined) {
          const current = (await listSkillsWith(client)).find((item) => item.name === skill);
          if (current === undefined) throw new HermesSettingsError("not_found", "Hermes skill was not found.");
          if (current.enabled !== expectedEnabled) throw conflict();
        }
        await client.request("/api/skills/toggle", "PUT", { name: skill, enabled });
      }, deadlineMs), operationOptions?.deadlineMs);
    },
    getSkillContent: async (profile, name) => await withClient(profile, async (client) =>
      await skillContentWith(client, requiredName(name, "skill"), maxSkillContentBytes)),
    updateSkillContent: async (profile, name, content, expectedRevision) => {
      if (Buffer.byteLength(content) > maxSkillContentBytes || content.includes("\0")) throw invalid("Skill content is invalid or too large.");
      if (containsLikelySecret(content)) throw invalid("Skill content appears to contain a secret. Store credentials through the dedicated secret channel.");
      const validProfile = requiredProfile(profile);
      const skill = requiredName(name, "skill");
      return await runMutation(resourceKey(validProfile, "skill-content", skill), async (deadlineMs) => await withClient(validProfile, async (client) => {
        if (expectedRevision !== undefined) {
          const current = await skillContentWith(client, skill, maxSkillContentBytes);
          if (current.redacted || current.revision !== requiredRevision(expectedRevision)) throw conflict();
        }
        await client.request("/api/skills/content", "PUT", { name: skill, content });
        return await skillContentWith(client, skill, maxSkillContentBytes);
      }, deadlineMs));
    },
    getMemoryStatus: async (profile) => await withClient(profile, memoryStatusWith),
    setMemoryProvider: async (profile, provider, expectedProvider) => {
      const validProfile = requiredProfile(profile);
      const selected = requiredProvider(provider, true);
      const expected = expectedProvider === undefined ? undefined : requiredProvider(expectedProvider, true);
      return await runMutation(resourceKey(validProfile, "memory-provider"), async (deadlineMs) => await withClient(validProfile, async (client) => {
        if (expected !== undefined && (await memoryStatusWith(client)).activeProvider !== expected) throw conflict();
        await client.request("/api/memory/provider", "PUT", { provider: selected });
        return await memoryStatusWith(client);
      }, deadlineMs));
    },
    getMemoryProviderConfig: async (profile, provider) => await withClient(profile, async (client) =>
      await providerConfigWith(client, requiredProvider(provider, false))),
    updateMemoryProviderConfig: async (profile, provider, values, expectedRevision) => {
      const validProfile = requiredProfile(profile);
      const validProvider = requiredProvider(provider, false);
      return await runMutation(resourceKey(validProfile, "memory-config", validProvider), async (deadlineMs) => await withClient(validProfile, async (client) => {
        const schema = await providerConfigWith(client, validProvider);
        if (expectedRevision !== undefined && schema.revision !== requiredRevision(expectedRevision)) throw conflict();
        const fields = new Map(schema.fields.map((field) => [field.key, field]));
        const clean: Record<string, boolean | string> = {};
        for (const [key, value] of Object.entries(values)) {
          const field = fields.get(key);
          if (field === undefined) throw invalid(`Unknown memory setting: ${key}`);
          if (field.kind === "secret") throw invalid("Secret memory fields require the dedicated secret channel.");
          if (typeof value !== "string" && typeof value !== "boolean") throw invalid(`Invalid memory setting: ${key}`);
          if (typeof value === "string" && (value.length > 8_192 || value.includes("\0") || containsLikelySecret(value))) throw invalid(`Invalid memory setting: ${key}`);
          clean[key] = value;
        }
        await client.request(`/api/memory/providers/${encodeURIComponent(validProvider)}/config?surface=declared`, "PUT", { values: clean });
        return await providerConfigWith(client, validProvider);
      }, deadlineMs));
    },
    getBuiltinMemoryFiles: async (profile) => await withBuiltinMemory(async () => await builtinMemoryFiles.readAll(profile)),
    updateBuiltinMemoryFile: async (profile, key, content, expectedRevision) => {
      // Deliberately do not reject likely-secret prose: practical MEMORY/USER notes
      // false-positive under credential heuristics. Content is only returned on the
      // authorized memory.update surface and never embedded in audit or events.
      const validProfile = requiredProfile(profile);
      // Share one queue with reset so filesystem writes and Hermes deletes cannot race.
      return await runBuiltinMemoryMutation(resourceKey(validProfile, "builtin-memory"), async () =>
        await withBuiltinMemory(async () => await builtinMemoryFiles.write(validProfile, key, content, expectedRevision)));
    },
    resetBuiltinMemory: async (profile, target) => {
      if (target !== "all" && target !== "memory" && target !== "user") throw invalid("Memory reset target is invalid.");
      const validProfile = requiredProfile(profile);
      return await runMutation(resourceKey(validProfile, "builtin-memory"), async (deadlineMs) =>
        await withClient(validProfile, async (client) => {
          await client.request("/api/memory/reset", "POST", { target });
          const [files, status] = await Promise.all([
            settleBeforeDeadline(
              withBuiltinMemory(async () => await builtinMemoryFiles.readAll(validProfile)),
              deadlineMs,
              commitUnconfirmed,
            ),
            memoryStatusWith(client),
          ]);
          return { files, status };
        }, deadlineMs));
    },
    getProfileSoul: async (profile) => await withClient(profile, soulWith),
    updateProfileSoul: async (profile, content, expectedRevision) => {
      if (Buffer.byteLength(content) > 256 * 1024 || content.includes("\0")) throw invalid("Profile identity is invalid or too large.");
      if (containsLikelySecret(content)) throw invalid("Profile identity appears to contain a secret.");
      const validProfile = requiredProfile(profile);
      return await runMutation(resourceKey(validProfile, "soul"), async (deadlineMs) => await withClient(validProfile, async (client) => {
        if (expectedRevision !== undefined) {
          const current = await soulWith(client);
          if (current.redacted || current.revision !== requiredRevision(expectedRevision)) throw conflict();
        }
        await client.request(`/api/profiles/${encodeURIComponent(client.profile)}/soul`, "PUT", { content });
        return await soulWith(client);
      }, deadlineMs));
    },
    getProfileConfigSchema: async (profile) => {
      try {
        return await withClient(profile, async (client) => {
          const schema = await profileConfigSchemaWith(client);
          return { profile: client.profile, ...schema };
        });
      } catch (error) {
        return asSettingsError(error);
      }
    },
    getProfileConfig: async (profile) => {
      try {
        return await withClient(profile, profileConfigWith);
      } catch (error) {
        return asSettingsError(error);
      }
    },
    updateProfileConfig: async (profile, patch) => {
      const validProfile = requiredProfile(profile);
      const expectedRevision = requiredRevision(patch.expectedRevision);
      try {
        return await runMutation(resourceKey(validProfile, "config"), async (deadlineMs) => await withClient(validProfile, async (client) => {
          // Re-read under the profile config queue so concurrent Office writers
          // serialize. Hermes PUT is not conditional; expectedRevision is an
          // in-process Office concurrency token over the safe-leaf projection.
          const current = await profileConfigWith(client);
          if (current.revision !== expectedRevision) throw conflict();
          const changes = validateConfigPatchChanges(patch.changes, current.fields);
          const putBody = buildHermesConfigPutBody(changes);
          await client.request("/api/config", "PUT", { config: putBody });
          return await profileConfigWith(client);
        }, deadlineMs));
      } catch (error) {
        return asSettingsError(error);
      }
    },
    getPrivilegedProfileConfig: async (profile) => {
      try {
        return await withClient(profile, privilegedProfileConfigWith);
      } catch (error) {
        return asSettingsError(error);
      }
    },
    updatePrivilegedProfileConfig: async (profile, patch) => {
      const validProfile = requiredProfile(profile);
      const expectedRevision = requiredRevision(patch.expectedRevision);
      try {
        // Share the profile config queue with safe Advanced so both surfaces
        // cannot race the same Hermes PUT /api/config deep-merge.
        return await runMutation(resourceKey(validProfile, "config"), async (deadlineMs) => await withClient(validProfile, async (client) => {
          const current = await privilegedProfileConfigWith(client);
          if (current.revision !== expectedRevision) throw conflict();
          const changes = validatePrivilegedConfigPatchChanges(patch.changes, current.fields);
          const needsConfirmation = Object.keys(changes).some((key) => {
            const field = current.fields.find((item) => item.id === key);
            return field?.requiresConfirmation === true;
          });
          if (needsConfirmation && patch.confirmed !== true) {
            throw invalid("Confirmation is required for destructive or restart-impact privileged fields.");
          }
          const putBody = buildPrivilegedHermesConfigPutBody(changes);
          await client.request("/api/config", "PUT", { config: putBody });
          return await privilegedProfileConfigWith(client);
        }, deadlineMs));
      } catch (error) {
        return asSettingsError(error);
      }
    },
    listProfileSecrets: async (profile) => {
      try {
        return await withClient(profile, profileSecretsWith);
      } catch (error) {
        return asSettingsError(error);
      }
    },
    writeProfileSecret: async (profile, request) => {
      const validProfile = requiredProfile(profile);
      const source = request.source;
      if (source !== "env" && source !== "config" && source !== "memory-provider") {
        throw invalid("Secret source is invalid.");
      }
      const key = requiredSecretKey(request.key, source);
      const provider = source === "memory-provider"
        ? requiredProvider(request.provider, false)
        : undefined;
      if (typeof request.value !== "string" || request.value.includes("\0")) {
        throw invalid("Secret value is invalid.");
      }
      if (Buffer.byteLength(request.value) > 8 * 1024) throw invalid("Secret value is too large.");
      const clear = request.value === "";
      const expectedRevision = request.expectedRevision === undefined
        ? undefined
        : requiredRevision(request.expectedRevision);
      try {
        return await runMutation(resourceKey(validProfile, "secrets"), async (deadlineMs) => await withClient(validProfile, async (client) => {
          const current = await profileSecretsWith(client);
          if (expectedRevision !== undefined && current.revision !== expectedRevision) throw conflict();
          const field = current.fields.find((item) =>
            item.key === key
            && item.source === source
            && (source !== "memory-provider" || item.provider === provider));
          if (field === undefined) throw invalid("Secret field is not declared by Hermes.");
          if (clear && !field.isSet) throw invalid("Secret field is not set.");
          if (source === "env") {
            if (clear) {
              // Official clear path — empty transfer maps to DELETE, not a secret value body.
              await client.request("/api/env", "DELETE", { key });
            } else {
              await client.request("/api/env", "PUT", { key, value: request.value });
            }
          } else if (source === "config") {
            const putBody = buildPrivilegedHermesConfigPutBody({ [key]: request.value });
            await client.request("/api/config", "PUT", { config: putBody });
          } else {
            // Re-read declared provider schema; only write a live secret field.
            const memoryProvider = provider!;
            const schema = await providerConfigWith(client, memoryProvider);
            const live = schema.fields.find((item) => item.key === key && item.kind === "secret");
            if (live === undefined) throw invalid("Secret field is not declared by Hermes.");
            if (clear) {
              await clearMemoryProviderSecret(client, memoryProvider, key, schema);
            } else {
              await client.request(
                `/api/memory/providers/${encodeURIComponent(memoryProvider)}/config?surface=declared`,
                "PUT",
                { values: { [key]: request.value } },
              );
            }
          }
          return await profileSecretsWith(client);
        }, deadlineMs));
      } catch (error) {
        return asSettingsError(error);
      }
    },
  };
  return adapter;
}

function resourceKey(profile: string, resource: string, id = ""): string {
  return `${profile}\0${resource}\0${id}`;
}

interface NormalizedBackend { baseUrl: URL; sessionToken: string }

class ProfileClient {
  #mutationCommitted = false;

  constructor(
    readonly profile: string,
    private readonly backend: NormalizedBackend,
    private readonly deadlineMs: number,
    private readonly maxResponseBytes: number,
  ) {}

  get mutationCommitted(): boolean { return this.#mutationCommitted; }

  async request(path: string, method: "GET" | "POST" | "PUT" | "DELETE", body?: Record<string, unknown>): Promise<unknown> {
    const target = new URL(path, this.backend.baseUrl);
    if (target.origin !== this.backend.baseUrl.origin || !target.pathname.startsWith("/api/")) throw invalid("Hermes settings path is invalid.");
    const remainingMs = this.deadlineMs - Date.now();
    if (remainingMs <= 0) throw timedOut();
    const mutation = method !== "GET";
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
        if (response.status === 404) throw new HermesSettingsError("not_found", "Hermes setting was not found.");
        throw new HermesSettingsError("rejected", "Hermes rejected the settings request.");
      }
      if (mutation) this.#mutationCommitted = true;
      const text = await readBoundedText(response, this.maxResponseBytes);
      if (text === "") return {};
      try { return JSON.parse(text) as unknown; } catch { throw invalidBackend(); }
    } catch (error) {
      if (error instanceof HermesSettingsError) {
        if (mutation && this.#mutationCommitted && error.code !== "commit_unconfirmed") throw commitUnconfirmed();
        throw error;
      }
      if (mutation) throw commitUnconfirmed();
      if (isAbortError(error)) throw timedOut();
      throw new HermesSettingsError("rejected", "Unable to reach Hermes settings.");
    } finally {
      clearTimeout(timer);
    }
  }
}

async function resolveProfileBackendBeforeDeadline(
  profile: string,
  resolveProfileBackend: HermesSettingsAdapterOptions["resolveProfileBackend"],
  deadlineMs: number,
): Promise<HermesProfileBackendAccess> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw timedOut();
  const timeoutError = timedOut();
  let expired = false;
  const acquisition = resolveProfileBackend(profile, { deadlineMs }).then((lease) => {
    if (!expired) return lease;
    lease.release();
    throw timeoutError;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
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

async function listSkillsWith(client: ProfileClient): Promise<SkillSettingsDto[]> {
  const raw = await client.request("/api/skills", "GET");
  if (!Array.isArray(raw)) throw invalidBackend();
  return raw.slice(0, 1_000).flatMap((item): SkillSettingsDto[] => {
    if (!isRecord(item) || typeof item.name !== "string" || !NAME_PATTERN.test(item.name)) return [];
    return [{
      name: item.name,
      category: safePublicText(item.category, 120) ?? "uncategorized",
      description: safePublicText(item.description, 2_000) ?? "",
      enabled: item.enabled === true,
      provenance: item.provenance === "agent" || item.provenance === "bundled" || item.provenance === "hub" ? item.provenance : "unknown",
      usage: Math.max(0, Math.trunc(finiteNumber(item.usage) ?? 0)),
    }];
  });
}

async function skillContentWith(client: ProfileClient, skill: string, maxBytes: number): Promise<SkillContentDto> {
  const raw = await client.request(`/api/skills/content?name=${encodeURIComponent(skill)}`, "GET");
  if (!isRecord(raw) || typeof raw.content !== "string") throw invalidBackend();
  const safe = redactSecrets(raw.content);
  return { name: skill, content: truncateUtf8(safe.value, maxBytes), redacted: safe.redacted, revision: revisionOf(raw.content) };
}

async function memoryStatusWith(client: ProfileClient): Promise<MemoryStatusDto> {
  const raw = await client.request("/api/memory", "GET");
  if (!isRecord(raw)) throw invalidBackend();
  const files = isRecord(raw.builtin_files) ? raw.builtin_files : {};
  const memoryBytes = safeBytes(files.memory);
  const userBytes = safeBytes(files.user);
  const providers = Array.isArray(raw.providers) ? raw.providers.slice(0, 100).flatMap((item): MemoryProviderDto[] => {
    if (!isRecord(item) || typeof item.name !== "string" || !PROVIDER_PATTERN.test(item.name)) return [];
    return [{ name: item.name, description: safePublicText(item.description, 1_000) ?? "", configured: item.configured === true }];
  }) : [];
  return { activeProvider: safeProvider(raw.active), providers, builtin: { memoryBytes, userBytes, hasMemory: memoryBytes > 0, hasUser: userBytes > 0 } };
}

async function providerConfigWith(client: ProfileClient, provider: string): Promise<MemoryProviderConfigDto> {
  const raw = await client.request(`/api/memory/providers/${encodeURIComponent(provider)}/config?surface=declared`, "GET");
  if (!isRecord(raw)) throw invalidBackend();
  const fields = Array.isArray(raw.fields) ? raw.fields.slice(0, 100).flatMap((item): MemoryProviderFieldDto[] => {
    if (!isRecord(item) || typeof item.key !== "string" || !NAME_PATTERN.test(item.key)) return [];
    const declaredKind = memoryFieldKind(item.kind);
    if (declaredKind === undefined) return [];
    const kind: MemoryFieldKind = isLikelySecretIdentifier(item.key) ? "secret" : declaredKind;
    const options = kind !== "secret" && Array.isArray(item.options) ? item.options.slice(0, 100).flatMap((option): MemoryProviderFieldDto["options"] => {
      if (!isRecord(option) || typeof option.value !== "string") return [];
      const value = publicOptionValue(option.value, 200);
      if (value === undefined) return [];
      return [{ value, label: safePublicText(option.label, 200) ?? value, description: safePublicText(option.description, 1_000) ?? "" }];
    }) : [];
    const value = kind === "secret" ? undefined : safeFieldValue(item.value, kind);
    return [{ key: item.key, label: safePublicText(item.label, 200) ?? item.key, kind, description: safePublicText(item.description, 1_000) ?? "", required: item.required === true, isSet: item.is_set === true, ...(value === undefined ? {} : { value }), options }];
  }) : [];
  const label = safePublicText(raw.label, 200) ?? provider;
  return { name: provider, label, fields, revision: revisionOf(JSON.stringify({ name: provider, label, fields })) };
}

async function soulWith(client: ProfileClient): Promise<ProfileSoulDto> {
  const raw = await client.request(`/api/profiles/${encodeURIComponent(client.profile)}/soul`, "GET");
  if (!isRecord(raw) || typeof raw.content !== "string") throw invalidBackend();
  const safe = redactSecrets(raw.content);
  return { profile: client.profile, content: truncateUtf8(safe.value, 256 * 1024), exists: raw.exists === true, redacted: safe.redacted, revision: revisionOf(raw.content) };
}

async function profileConfigSchemaWith(client: ProfileClient): Promise<Omit<HermesConfigSchemaDto, "profile">> {
  const raw = await client.request("/api/config/schema", "GET");
  return normalizeHermesConfigSchema(raw);
}

async function profileConfigWith(client: ProfileClient): Promise<HermesConfigDto> {
  const [schemaRaw, configRaw] = await Promise.all([
    client.request("/api/config/schema", "GET"),
    client.request("/api/config", "GET"),
  ]);
  // Value-aware projection: deny Hermes null→string mislabels and non-string lists.
  return { profile: client.profile, ...projectSafeHermesConfig(schemaRaw, configRaw) };
}

async function privilegedProfileConfigWith(client: ProfileClient): Promise<HermesPrivilegedConfigDto> {
  const [schemaRaw, configRaw] = await Promise.all([
    client.request("/api/config/schema", "GET"),
    client.request("/api/config", "GET"),
  ]);
  return { profile: client.profile, ...projectPrivilegedHermesConfig(schemaRaw, configRaw) };
}

async function profileSecretsWith(client: ProfileClient): Promise<HermesSecretsDto> {
  const [schemaRaw, configRaw, envRaw, memory] = await Promise.all([
    client.request("/api/config/schema", "GET"),
    client.request("/api/config", "GET"),
    client.request("/api/env", "GET"),
    memoryStatusWith(client),
  ]);
  // Normalize each source to HermesSecretFieldMetaDto so optional provider/
  // providerLabel (memory-provider only) and canClear are one static shape.
  const configSecrets: HermesSecretFieldMetaDto[] = projectConfigSecretFieldMeta(schemaRaw, configRaw).map((field) => ({
    key: field.key,
    source: field.source,
    label: field.label,
    description: field.description,
    category: field.category,
    isSet: field.isSet,
    isPassword: field.isPassword,
    // Config secrets clear via empty PUT; always clearable when set. No provider.
    canClear: field.isSet,
  }));
  const envSecrets: HermesSecretFieldMetaDto[] = projectEnvSecretMeta(envRaw);
  const memorySecrets: HermesSecretFieldMetaDto[] = await discoverMemoryProviderSecrets(client, memory, envRaw);
  // Env keys, then config secret leaves, then declared memory-provider secrets.
  const fields: HermesSecretFieldMetaDto[] = [...envSecrets, ...configSecrets, ...memorySecrets].slice(0, SECRETS_MAX_FIELDS);
  const revision = revisionOf(JSON.stringify(fields.map((field) => [
    field.source,
    field.provider ?? "",
    field.key,
    field.isSet,
    field.canClear,
    field.category,
  ])));
  return { profile: client.profile, revision, fields };
}

/**
 * Sequential discovery of secret fields declared by Hermes memory providers.
 * Only providers reported by GET /api/memory are considered; only
 * surface=declared secret fields are exposed (isSet only, never values).
 */
async function discoverMemoryProviderSecrets(
  client: ProfileClient,
  memory: MemoryStatusDto,
  envRaw: unknown,
): Promise<HermesSecretFieldMetaDto[]> {
  const names: string[] = [];
  for (const provider of memory.providers) {
    if (names.length >= MEMORY_PROVIDER_SECRET_MAX_PROVIDERS) break;
    // builtin has no declared secret surface.
    if (provider.name === "builtin" || provider.name === "") continue;
    if (!PROVIDER_PATTERN.test(provider.name)) continue;
    if (names.includes(provider.name)) continue;
    names.push(provider.name);
  }
  // Also include the active provider if it is declared and not already listed.
  if (
    names.length < MEMORY_PROVIDER_SECRET_MAX_PROVIDERS
    && memory.activeProvider
    && memory.activeProvider !== "builtin"
    && PROVIDER_PATTERN.test(memory.activeProvider)
    && !names.includes(memory.activeProvider)
  ) {
    names.push(memory.activeProvider);
  }

  const fields: HermesSecretFieldMetaDto[] = [];
  for (const name of names) {
    if (fields.length >= SECRETS_MAX_FIELDS) break;
    let schema: MemoryProviderConfigDto;
    try {
      schema = await providerConfigWith(client, name);
    } catch (error) {
      // Unknown/undeclared providers return empty fields; hard failures skip.
      if (error instanceof HermesSettingsError && error.code === "not_found") continue;
      if (error instanceof HermesSettingsError && error.code === "rejected") continue;
      throw error;
    }
    // canClear requires: this field isSet, exactly one isSet secret on the
    // provider schema, and exactly one env key with explicit provider match.
    // Never expose the mapped env key name.
    const setSecretCount = schema.fields.filter((item) => item.kind === "secret" && item.isSet).length;
    const clearCandidate = findUniqueEnvKeyForMemoryProvider(envRaw, name);
    let taken = 0;
    for (const field of schema.fields) {
      if (taken >= MEMORY_PROVIDER_SECRET_MAX_FIELDS_PER) break;
      if (field.kind !== "secret") continue;
      if (!NAME_PATTERN.test(field.key)) continue;
      fields.push({
        key: field.key,
        source: "memory-provider",
        label: field.label || field.key,
        description: field.description,
        category: "memory-provider",
        isSet: field.isSet,
        isPassword: true,
        canClear: field.isSet && setSecretCount === 1 && clearCandidate !== undefined,
        provider: name,
        providerLabel: schema.label || name,
      });
      taken += 1;
      if (fields.length >= SECRETS_MAX_FIELDS) break;
    }
  }
  return fields;
}

/**
 * Env keys eligible for memory-provider clear: must carry an explicit
 * non-empty provider slug. Missing provider metadata never matches.
 */
export function listExactProviderEnvClearCandidates(
  envRaw: unknown,
  provider: string,
): string[] {
  if (!isRecord(envRaw) || typeof provider !== "string" || provider === "" || !PROVIDER_PATTERN.test(provider)) {
    return [];
  }
  const candidates: string[] = [];
  for (const [envKey, meta] of Object.entries(envRaw).slice(0, 400)) {
    if (!SECRET_ENV_KEY_PATTERN.test(envKey) || !isRecord(meta)) continue;
    if (meta.custom === true || meta.channel_managed === true) continue;
    if (meta.is_set !== true) continue;
    // Fail closed: missing/empty provider is never a match.
    if (typeof meta.provider !== "string" || meta.provider === "") continue;
    if (meta.provider !== provider) continue;
    candidates.push(envKey);
  }
  return candidates;
}

/**
 * Unique env key for a memory provider clear, or undefined when zero or
 * multiple exact-provider candidates exist (ambiguous — do not delete).
 * Does not use field-key / suffix heuristics.
 */
export function findUniqueEnvKeyForMemoryProvider(
  envRaw: unknown,
  provider: string,
): string | undefined {
  const candidates = listExactProviderEnvClearCandidates(envRaw, provider);
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Clear a declared memory-provider secret via DELETE of a single env key
 * that is unambiguously associated with the validated provider.
 *
 * Hermes 0.18.2 declared PUT ignores empty secret values and omits env_key
 * from the declared schema response. Office therefore never issues a no-op
 * provider PUT, never guesses env keys by suffix, and never treats missing
 * provider metadata as a match. Zero or multiple exact candidates reject.
 * Clear is only allowed when exactly one secret field is set on the provider
 * (the field being cleared) and exactly one env key has provider === slug.
 */
async function clearMemoryProviderSecret(
  client: ProfileClient,
  provider: string,
  fieldKey: string,
  schema: MemoryProviderConfigDto,
): Promise<void> {
  const setSecrets = schema.fields.filter((item) => item.kind === "secret" && item.isSet);
  if (setSecrets.length !== 1 || setSecrets[0]!.key !== fieldKey) {
    throw invalid("Secret clear is unavailable for this field.");
  }
  const envRaw = await client.request("/api/env", "GET");
  const envKey = findUniqueEnvKeyForMemoryProvider(envRaw, provider);
  if (envKey === undefined) {
    // Generic message — no field names, env keys, or candidate counts.
    throw invalid("Secret clear is unavailable for this field.");
  }
  await client.request("/api/env", "DELETE", { key: envKey });
}

/**
 * Hermes GET /api/env → metadata only. Never forward redacted_value or raw
 * values; isSet is the only presence signal.
 */
function projectEnvSecretMeta(raw: unknown): HermesSecretFieldMetaDto[] {
  if (!isRecord(raw)) throw invalidBackend();
  const fields: HermesSecretFieldMetaDto[] = [];
  for (const [key, meta] of Object.entries(raw).slice(0, 400)) {
    if (!SECRET_ENV_KEY_PATTERN.test(key) || !isRecord(meta)) continue;
    // Refuse custom/arbitrary env rows and channel-managed credentials — those
    // are free-form or owned by messaging surfaces; only declared catalog keys.
    if (meta.custom === true) continue;
    if (meta.channel_managed === true) continue;
    const description = safePublicText(meta.description, 2_000) ?? key;
    const category = typeof meta.category === "string" && meta.category.length > 0 && meta.category.length <= 64
      ? meta.category
      : (typeof meta.provider === "string" && meta.provider.length > 0 ? meta.provider : "provider");
    const label = typeof meta.provider_label === "string" && meta.provider_label.length > 0
      ? safePublicText(meta.provider_label, 200) ?? key
      : key;
    const isSet = meta.is_set === true;
    fields.push({
      key,
      source: "env",
      label,
      description,
      category,
      isSet,
      isPassword: meta.is_password !== false,
      canClear: isSet,
    });
  }
  return fields;
}

function requiredSecretKey(value: string, source: HermesSecretSource): string {
  if (source === "env") {
    if (!SECRET_ENV_KEY_PATTERN.test(value)) throw invalid("Secret key is invalid.");
    return value;
  }
  if (source === "memory-provider") {
    // Declared provider field keys (e.g. api_key), not dotted paths.
    if (!NAME_PATTERN.test(value)) throw invalid("Secret key is invalid.");
    return value;
  }
  // Config secret fields use dotted Hermes field ids.
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}(?:\.[A-Za-z][A-Za-z0-9_]{0,63}){0,7}$/.test(value) || value.length > 200) {
    throw invalid("Secret key is invalid.");
  }
  return value;
}

export interface OfficeGlobalSettingsDto {
  revision: number;
  sharedSkillsEnabled: boolean;
  sharedContextEnabled: boolean;
  skills: string[];
  context: string;
  updatedAt: string;
  skillSync: {
    state: "pending" | "ready";
    failures: Array<{ profile: string; skill: string; operation: "disable" | "enable" }>;
  };
}

export interface OfficeManagedSkill { profile: string; skill: string }
export interface OfficePendingSkillOverride extends OfficeManagedSkill {
  id: string;
  desiredEnabled: boolean;
  expectedEnabled: boolean;
  createdAt: string;
}
export interface OfficePendingGlobalSkillMutation extends OfficeManagedSkill {
  id: string;
  revision: number;
  desiredEnabled: boolean;
  expectedEnabled: boolean;
  createdAt: string;
}
export interface OfficeGlobalMaterializationState {
  settings: OfficeGlobalSettingsDto;
  managedSkills: OfficeManagedSkill[];
  skillOverrides: OfficeManagedSkill[];
  pendingSkillOverrides: OfficePendingSkillOverride[];
  pendingGlobalSkillMutations: OfficePendingGlobalSkillMutation[];
}

export interface OfficeGlobalSettingsStoreOptions {
  /** Testable storage boundary; throwing leaves the previous atomic state intact. */
  beforeWrite?: (state: OfficeGlobalMaterializationState) => Promise<void> | void;
}

export interface OfficeGlobalSettingsUpdate {
  expectedRevision: number;
  sharedSkillsEnabled?: boolean;
  sharedContextEnabled?: boolean;
  skills?: string[];
  context?: string;
}

/** Office-owned global inheritance store. Hermes has no global profile layer. */
export class OfficeGlobalSettingsStore {
  readonly #filePath: string;
  readonly #options: OfficeGlobalSettingsStoreOptions;
  #queue: Promise<void> = Promise.resolve();

  constructor(filePath: string, options: OfficeGlobalSettingsStoreOptions = {}) {
    if (filePath.trim() === "" || filePath.includes("\0")) throw invalid("Global settings path is invalid.");
    this.#filePath = filePath;
    this.#options = options;
  }

  async read(): Promise<OfficeGlobalSettingsDto> {
    await this.#queue;
    return (await this.#readStateUnsafe()).settings;
  }

  async update(input: OfficeGlobalSettingsUpdate): Promise<OfficeGlobalSettingsDto> {
    const staged = await this.beginMaterialization(input);
    return await this.finishMaterialization(staged.settings.revision, staged.managedSkills, staged.skillOverrides, []);
  }

  async readMaterialization(): Promise<OfficeGlobalMaterializationState> {
    await this.#queue;
    return await this.#readStateUnsafe();
  }

  async beginMaterialization(input: OfficeGlobalSettingsUpdate): Promise<OfficeGlobalMaterializationState> {
    return await this.#mutate(async () => {
      const current = await this.#readStateUnsafe();
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== current.settings.revision) throw new HermesSettingsError("conflict", "Global settings changed; refresh before saving.");
      const settings = validateGlobal({
        revision: current.settings.revision + 1,
        sharedSkillsEnabled: input.sharedSkillsEnabled ?? current.settings.sharedSkillsEnabled,
        sharedContextEnabled: input.sharedContextEnabled ?? current.settings.sharedContextEnabled,
        skills: input.skills ?? current.settings.skills,
        context: input.context ?? current.settings.context,
        updatedAt: new Date().toISOString(),
        skillSync: { state: "pending", failures: [] },
      });
      const next = { ...current, settings };
      await this.#writeState(next);
      return next;
    });
  }

  async finishMaterialization(
    expectedRevision: number,
    managedSkills: OfficeManagedSkill[],
    skillOverrides: OfficeManagedSkill[],
    failures: OfficeGlobalSettingsDto["skillSync"]["failures"],
  ): Promise<OfficeGlobalSettingsDto> {
    return await this.#mutate(async () => {
      const current = await this.#readStateUnsafe();
      if (current.settings.revision !== expectedRevision) throw new HermesSettingsError("conflict", "Global settings changed while skills were being synchronized.");
      const settings = validateGlobal({
        ...current.settings,
        skillSync: { state: failures.length === 0 ? "ready" : "pending", failures },
      });
      const next = { ...current, settings, managedSkills: validateManagedSkills(managedSkills), skillOverrides: validateManagedSkills(skillOverrides) };
      await this.#writeState(next);
      return settings;
    });
  }

  async markSkillOverride(profile: string, skill: string): Promise<void> {
    await this.#mutate(async () => {
      const current = await this.#readStateUnsafe();
      const managedSkills = current.managedSkills.filter((item) => item.profile !== profile || item.skill !== skill);
      const key = `${profile}\0${skill}`;
      const skillOverrides = current.skillOverrides.some((item) => `${item.profile}\0${item.skill}` === key)
        ? current.skillOverrides
        : [...current.skillOverrides, { profile, skill }];
      const pendingSkillOverrides = current.pendingSkillOverrides.filter((item) => `${item.profile}\0${item.skill}` !== key);
      await this.#writeState({ ...current, managedSkills, skillOverrides, pendingSkillOverrides });
    });
  }

  async prepareSkillOverride(
    profile: string,
    skill: string,
    desiredEnabled: boolean,
    expectedEnabled: boolean,
  ): Promise<{ transaction: OfficePendingSkillOverride; existing: boolean }> {
    return await this.#mutate(async () => {
      const current = await this.#readStateUnsafe();
      const validProfile = requiredProfile(profile);
      const validSkill = requiredName(skill, "managed skill");
      const existing = current.pendingSkillOverrides.find((item) => item.profile === validProfile && item.skill === validSkill);
      if (existing !== undefined) {
        if (existing.desiredEnabled !== desiredEnabled || existing.expectedEnabled !== expectedEnabled) {
          throw new HermesSettingsError("conflict", "A different Profile skill change is pending reconciliation.");
        }
        return { transaction: existing, existing: true };
      }
      const transaction: OfficePendingSkillOverride = {
        id: randomBytes(32).toString("base64url"),
        profile: validProfile,
        skill: validSkill,
        desiredEnabled,
        expectedEnabled,
        createdAt: new Date().toISOString(),
      };
      await this.#writeState({
        ...current,
        pendingSkillOverrides: [...current.pendingSkillOverrides, transaction],
      });
      return { transaction, existing: false };
    });
  }

  async commitSkillOverride(transaction: OfficePendingSkillOverride): Promise<void> {
    await this.#mutate(async () => {
      const current = await this.#readStateUnsafe();
      const pending = current.pendingSkillOverrides.find((item) => item.id === transaction.id);
      const key = `${transaction.profile}\0${transaction.skill}`;
      if (pending === undefined) {
        if (current.skillOverrides.some((item) => `${item.profile}\0${item.skill}` === key)) return;
        throw new HermesSettingsError("conflict", "Profile skill ownership transaction is no longer current.");
      }
      if (pending.profile !== transaction.profile || pending.skill !== transaction.skill
        || pending.desiredEnabled !== transaction.desiredEnabled || pending.expectedEnabled !== transaction.expectedEnabled) {
        throw new HermesSettingsError("conflict", "Profile skill ownership transaction does not match durable state.");
      }
      const pendingKey = `${pending.profile}\0${pending.skill}`;
      const managedSkills = current.managedSkills.filter((item) => `${item.profile}\0${item.skill}` !== pendingKey);
      const skillOverrides = current.skillOverrides.some((item) => `${item.profile}\0${item.skill}` === pendingKey)
        ? current.skillOverrides
        : [...current.skillOverrides, { profile: pending.profile, skill: pending.skill }];
      await this.#writeState({
        ...current,
        managedSkills,
        skillOverrides,
        pendingSkillOverrides: current.pendingSkillOverrides.filter((item) => item.id !== transaction.id),
      });
    });
  }

  async abortSkillOverride(transaction: OfficePendingSkillOverride): Promise<void> {
    await this.#mutate(async () => {
      const current = await this.#readStateUnsafe();
      if (!current.pendingSkillOverrides.some((item) => item.id === transaction.id)) return;
      await this.#writeState({
        ...current,
        pendingSkillOverrides: current.pendingSkillOverrides.filter((item) => item.id !== transaction.id),
      });
    });
  }

  async prepareGlobalSkillMutation(
    revision: number,
    profile: string,
    skill: string,
    desiredEnabled: boolean,
    expectedEnabled: boolean,
  ): Promise<{ transaction: OfficePendingGlobalSkillMutation; existing: boolean }> {
    return await this.#mutate(async () => {
      const current = await this.#readStateUnsafe();
      if (current.settings.revision !== revision) throw new HermesSettingsError("conflict", "Global settings changed before skill mutation was prepared.");
      const validProfile = requiredProfile(profile);
      const validSkill = requiredName(skill, "managed skill");
      const existing = current.pendingGlobalSkillMutations.find((item) => item.profile === validProfile && item.skill === validSkill);
      if (existing !== undefined) {
        if (existing.revision !== revision || existing.desiredEnabled !== desiredEnabled || existing.expectedEnabled !== expectedEnabled) {
          throw new HermesSettingsError("conflict", "A different global skill mutation is pending reconciliation.");
        }
        return { transaction: existing, existing: true };
      }
      const transaction: OfficePendingGlobalSkillMutation = {
        id: randomBytes(32).toString("base64url"), revision, profile: validProfile, skill: validSkill,
        desiredEnabled, expectedEnabled, createdAt: new Date().toISOString(),
      };
      await this.#writeState({ ...current, pendingGlobalSkillMutations: [...current.pendingGlobalSkillMutations, transaction] });
      return { transaction, existing: false };
    });
  }

  async commitGlobalSkillMutation(transaction: OfficePendingGlobalSkillMutation): Promise<void> {
    await this.#mutate(async () => {
      const current = await this.#readStateUnsafe();
      const pending = current.pendingGlobalSkillMutations.find((item) => item.id === transaction.id);
      if (pending === undefined) return;
      if (current.settings.revision !== pending.revision) throw new HermesSettingsError("conflict", "Global skill mutation revision is no longer current.");
      const key = `${pending.profile}\0${pending.skill}`;
      const managedSkills = pending.desiredEnabled
        ? (current.managedSkills.some((item) => `${item.profile}\0${item.skill}` === key) ? current.managedSkills : [...current.managedSkills, { profile: pending.profile, skill: pending.skill }])
        : current.managedSkills.filter((item) => `${item.profile}\0${item.skill}` !== key);
      await this.#writeState({
        ...current,
        managedSkills,
        pendingGlobalSkillMutations: current.pendingGlobalSkillMutations.filter((item) => item.id !== pending.id),
      });
    });
  }

  async abortGlobalSkillMutation(transaction: OfficePendingGlobalSkillMutation): Promise<void> {
    await this.#mutate(async () => {
      const current = await this.#readStateUnsafe();
      if (!current.pendingGlobalSkillMutations.some((item) => item.id === transaction.id)) return;
      await this.#writeState({
        ...current,
        pendingGlobalSkillMutations: current.pendingGlobalSkillMutations.filter((item) => item.id !== transaction.id),
      });
    });
  }

  async #readStateUnsafe(): Promise<OfficeGlobalMaterializationState> {
    try {
      const text = await readFile(this.#filePath, "utf8");
      return validateGlobalState(JSON.parse(text) as unknown);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { settings: defaultGlobalSettings(), managedSkills: [], skillOverrides: [], pendingSkillOverrides: [], pendingGlobalSkillMutations: [] };
      if (error instanceof HermesSettingsError) throw error;
      throw new HermesSettingsError("rejected", "Global settings could not be read.");
    }
  }

  async #writeState(state: OfficeGlobalMaterializationState): Promise<void> {
    await this.#options.beforeWrite?.(state);
    await atomicWriteJson(this.#filePath, state.managedSkills.length === 0 && state.skillOverrides.length === 0 && state.pendingSkillOverrides.length === 0 && state.pendingGlobalSkillMutations.length === 0
      ? state.settings
      : {
          ...state.settings,
          managedSkills: state.managedSkills,
          skillOverrides: state.skillOverrides,
          pendingSkillOverrides: state.pendingSkillOverrides,
          pendingGlobalSkillMutations: state.pendingGlobalSkillMutations,
        });
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return await result;
  }
}

function validateGlobal(value: unknown): OfficeGlobalSettingsDto {
  if (!isRecord(value) || !Number.isInteger(value.revision) || (value.revision as number) < 0 || typeof value.sharedSkillsEnabled !== "boolean" || typeof value.sharedContextEnabled !== "boolean" || !Array.isArray(value.skills) || typeof value.context !== "string" || typeof value.updatedAt !== "string") throw new HermesSettingsError("rejected", "Global settings are invalid.");
  const skills = value.skills.map((item) => requiredName(item, "global skill"));
  if (skills.length > GLOBAL_SETTINGS_MAX_SKILLS || new Set(skills).size !== skills.length) throw invalid("Global skill selection is invalid.");
  if (!isGlobalContextWithinBudget(value.context) || containsLikelySecret(value.context)) throw invalid("Global context is invalid, too large, or contains a possible secret.");
  if (Number.isNaN(Date.parse(value.updatedAt))) throw new HermesSettingsError("rejected", "Global settings timestamp is invalid.");
  const sync = isRecord(value.skillSync) ? value.skillSync : { state: "ready", failures: [] };
  const state = sync.state === "pending" ? "pending" : "ready";
  const failures = Array.isArray(sync.failures) ? sync.failures.slice(0, 100).flatMap((item): OfficeGlobalSettingsDto["skillSync"]["failures"] => {
    if (!isRecord(item) || typeof item.profile !== "string" || !PROFILE_PATTERN.test(item.profile) || typeof item.skill !== "string" || !NAME_PATTERN.test(item.skill) || (item.operation !== "enable" && item.operation !== "disable")) return [];
    return [{ profile: item.profile, skill: item.skill, operation: item.operation }];
  }) : [];
  return { revision: value.revision as number, sharedSkillsEnabled: value.sharedSkillsEnabled, sharedContextEnabled: value.sharedContextEnabled, skills: [...skills], context: value.context, updatedAt: value.updatedAt, skillSync: { state, failures } };
}

function defaultGlobalSettings(): OfficeGlobalSettingsDto {
  return { revision: 0, sharedSkillsEnabled: true, sharedContextEnabled: true, skills: [], context: "", updatedAt: new Date(0).toISOString(), skillSync: { state: "ready", failures: [] } };
}

function validateGlobalState(value: unknown): OfficeGlobalMaterializationState {
  const settings = validateGlobal(value);
  const managed = isRecord(value) && Array.isArray(value.managedSkills) ? value.managedSkills : [];
  const overrides = isRecord(value) && Array.isArray(value.skillOverrides) ? value.skillOverrides : [];
  const pending = isRecord(value) && Array.isArray(value.pendingSkillOverrides) ? value.pendingSkillOverrides : [];
  const pendingGlobal = isRecord(value) && Array.isArray(value.pendingGlobalSkillMutations) ? value.pendingGlobalSkillMutations : [];
  return {
    settings,
    managedSkills: validateManagedSkills(managed),
    skillOverrides: validateManagedSkills(overrides),
    pendingSkillOverrides: validatePendingSkillOverrides(pending),
    pendingGlobalSkillMutations: validatePendingGlobalSkillMutations(pendingGlobal),
  };
}

function validatePendingGlobalSkillMutations(value: unknown[]): OfficePendingGlobalSkillMutation[] {
  if (value.length > 10_000) throw invalid("Pending global skill mutations are too large.");
  const result = value.map((item): OfficePendingGlobalSkillMutation => {
    if (!isRecord(item) || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(item.id)
      || !Number.isInteger(item.revision) || (item.revision as number) < 0
      || typeof item.desiredEnabled !== "boolean" || typeof item.expectedEnabled !== "boolean"
      || typeof item.createdAt !== "string" || Number.isNaN(Date.parse(item.createdAt))) throw invalid("Pending global skill mutation is invalid.");
    return { id: item.id, revision: item.revision as number, profile: requiredProfile(item.profile), skill: requiredName(item.skill, "managed skill"), desiredEnabled: item.desiredEnabled, expectedEnabled: item.expectedEnabled, createdAt: item.createdAt };
  });
  if (new Set(result.map((item) => item.id)).size !== result.length || new Set(result.map((item) => `${item.profile}\0${item.skill}`)).size !== result.length) throw invalid("Pending global skill mutations contain duplicates.");
  return result;
}

function validatePendingSkillOverrides(value: unknown[]): OfficePendingSkillOverride[] {
  if (value.length > 1_000) throw invalid("Pending Profile skill changes are too large.");
  const result = value.map((item): OfficePendingSkillOverride => {
    if (!isRecord(item) || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(item.id)
      || typeof item.desiredEnabled !== "boolean" || typeof item.expectedEnabled !== "boolean"
      || typeof item.createdAt !== "string" || Number.isNaN(Date.parse(item.createdAt))) {
      throw invalid("Pending Profile skill change is invalid.");
    }
    return {
      id: item.id,
      profile: requiredProfile(item.profile),
      skill: requiredName(item.skill, "managed skill"),
      desiredEnabled: item.desiredEnabled,
      expectedEnabled: item.expectedEnabled,
      createdAt: item.createdAt,
    };
  });
  if (new Set(result.map((item) => item.id)).size !== result.length
    || new Set(result.map((item) => `${item.profile}\0${item.skill}`)).size !== result.length) {
    throw invalid("Pending Profile skill changes contain duplicates.");
  }
  return result;
}

function validateManagedSkills(value: unknown[]): OfficeManagedSkill[] {
  if (value.length > 10_000) throw invalid("Global skill provenance is too large.");
  const result = value.map((item): OfficeManagedSkill => {
    if (!isRecord(item)) throw invalid("Global skill provenance is invalid.");
    return { profile: requiredProfile(item.profile), skill: requiredName(item.skill, "managed skill") };
  });
  const unique = new Set(result.map((item) => `${item.profile}\0${item.skill}`));
  if (unique.size !== result.length) throw invalid("Global skill provenance contains duplicates.");
  return result;
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, filePath);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

function normalizeBackend(value: HermesProfileBackendAccess): NormalizedBackend {
  const baseUrl = value.baseUrl instanceof URL ? new URL(value.baseUrl) : new URL(value.baseUrl);
  if (baseUrl.protocol !== "http:" || baseUrl.username !== "" || baseUrl.password !== "" || baseUrl.pathname !== "/" || baseUrl.search !== "" || baseUrl.hash !== "" || !isLoopback(baseUrl.hostname)) throw invalid("Profile backend must be a credential-free loopback HTTP origin.");
  if (value.sessionToken.length < 16 || value.sessionToken.length > 512 || value.sessionToken.includes("\0")) throw invalid("Profile backend token is invalid.");
  return { baseUrl, sessionToken: value.sessionToken };
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel(); throw new HermesSettingsError("response_too_large", "Hermes settings response was too large."); }
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new HermesSettingsError("response_too_large", "Hermes settings response was too large."); }
    text += decoder.decode(value, { stream: true });
  }
}

function revisionOf(value: string): string { return createHash("sha256").update(value).digest("base64url"); }
function requiredRevision(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw invalid("Settings revision is invalid."); return value; }
function conflict(): HermesSettingsError { return new HermesSettingsError("conflict", "Hermes setting changed; refresh before saving."); }
function commitUnconfirmed(): HermesSettingsError { return new HermesSettingsError("commit_unconfirmed", "Hermes may have committed this setting; refresh before retrying."); }
function timedOut(): HermesSettingsError { return new HermesSettingsError("timed_out", "Hermes settings request timed out."); }
function assertBeforeDeadline(deadlineMs: number): void { if (deadlineMs <= Date.now()) throw timedOut(); }
function operationDeadline(adapterDeadlineMs: number, requestedDeadlineMs: number | undefined): number {
  return requestedDeadlineMs === undefined || !Number.isFinite(requestedDeadlineMs)
    ? adapterDeadlineMs
    : Math.min(adapterDeadlineMs, Math.trunc(requestedDeadlineMs));
}
async function settleBeforeDeadline<T>(
  operation: Promise<T>,
  deadlineMs: number,
  timeoutError: () => HermesSettingsError,
): Promise<T> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw timeoutError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError()), remainingMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
function requiredProfile(value: unknown): string { if (typeof value !== "string" || !PROFILE_PATTERN.test(value)) throw invalid("Profile name is invalid."); return value; }
function requiredName(value: unknown, label: string): string { if (typeof value !== "string" || !NAME_PATTERN.test(value)) throw invalid(`${label} name is invalid.`); return value; }
function requiredProvider(value: unknown, allowBuiltin: boolean): string { if (allowBuiltin && value === "") return ""; if (typeof value !== "string" || !PROVIDER_PATTERN.test(value)) throw invalid("Memory provider is invalid."); return value; }
function safeProvider(value: unknown): string { return typeof value === "string" && (value === "" || PROVIDER_PATTERN.test(value)) ? value : ""; }
function memoryFieldKind(value: unknown): MemoryFieldKind | undefined { return value === "boolean" || value === "secret" || value === "select" || value === "text" ? value : undefined; }
function safeFieldValue(value: unknown, kind: MemoryFieldKind): boolean | string | undefined {
  if (kind === "boolean") return typeof value === "boolean" ? value : undefined;
  if (typeof value !== "string") return undefined;
  const safe = redactSecrets(value);
  return safe.redacted ? undefined : safe.value.slice(0, 8_192).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}
function safePublicText(value: unknown, maxChars: number): string | undefined { return typeof value === "string" ? redactSecrets(value).value.slice(0, maxChars).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "") : undefined; }
function publicOptionValue(value: string, maxChars: number): string | undefined { const safe = redactSecrets(value); return safe.redacted ? undefined : safe.value.slice(0, maxChars).replace(/[\u0000-\u001f\u007f]/g, ""); }
function safeBytes(value: unknown): number { const number = finiteNumber(value); return number === undefined ? 0 : Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(number))); }
function finiteNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function bounded(value: number | undefined, fallback: number, min: number, max: number): number { return value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.trunc(value))); }
function truncateUtf8(value: string, limit: number): string { if (Buffer.byteLength(value) <= limit) return value; let end = Math.min(value.length, limit); while (end > 0 && Buffer.byteLength(value.slice(0, end)) > limit - 3) end = Math.floor(end * 0.9); while (end < value.length && Buffer.byteLength(value.slice(0, end + 1)) <= limit - 3) end += 1; return `${value.slice(0, end)}…`; }
function isLoopback(host: string): boolean { return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]"; }
function isAbortError(error: unknown): boolean { return error instanceof DOMException && error.name === "AbortError"; }
function isNodeError(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function invalid(message: string): HermesSettingsError { return new HermesSettingsError("invalid_request", message); }
function invalidBackend(): HermesSettingsError { return new HermesSettingsError("rejected", "Hermes returned an invalid settings response."); }
