import { officeFetchJson, type OfficeApiRequestOptions } from "./office-api";

export type SkillSettings = {
  name: string;
  category: string;
  description: string;
  enabled: boolean;
  provenance: "agent" | "bundled" | "hub" | "unknown";
  usage: number;
};

export type SkillContent = {
  name: string;
  content: string;
  redacted: boolean;
  revision: string;
};

export type MemoryProvider = {
  name: string;
  description: string;
  configured: boolean;
};

export type MemoryStatus = {
  activeProvider: string;
  providers: MemoryProvider[];
  builtin: {
    memoryBytes: number;
    userBytes: number;
    hasMemory: boolean;
    hasUser: boolean;
  };
};

export type BuiltinMemoryFileKey = "memory" | "user";

export type BuiltinMemoryFile = {
  key: BuiltinMemoryFileKey;
  content: string;
  exists: boolean;
  bytes: number;
  revision: string;
};

export type BuiltinMemoryFiles = {
  profile: string;
  memory: BuiltinMemoryFile;
  user: BuiltinMemoryFile;
};

export type MemoryResetTarget = "all" | "memory" | "user";

export type MemoryResetResult = {
  ok: true;
  target: MemoryResetTarget;
  files: BuiltinMemoryFiles;
  status: MemoryStatus;
};

export type MemoryFieldKind = "boolean" | "secret" | "select" | "text";

export type MemoryProviderField = {
  key: string;
  label: string;
  kind: MemoryFieldKind;
  description: string;
  required: boolean;
  isSet: boolean;
  value?: boolean | string;
  options: Array<{ value: string; label: string; description: string }>;
};

export type MemoryProviderConfig = {
  name: string;
  label: string;
  fields: MemoryProviderField[];
  revision: string;
};

export type ProfileSoul = {
  profile: string;
  content: string;
  exists: boolean;
  redacted: boolean;
  revision: string;
};

export type ProfileAgentSettings = {
  profile: string;
  skills: SkillSettings[];
  memory: MemoryStatus;
  soul: ProfileSoul;
};

export type ProfileProjectFolder = {
  path: string;
  label: string | null;
  isPrimary: boolean;
  addedAt: number;
};

export type ProfileProject = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  boardSlug: string | null;
  primaryPath: string | null;
  archived: boolean;
  createdAt: number;
  folders: ProfileProjectFolder[];
};

export type ProfileProjects = {
  projects: ProfileProject[];
  activeId: string | null;
};

export type SubagentMode = "auto" | "manual";

export type SharedSubagentCandidate = {
  id: string;
  label: string;
  provider: string;
  model: string;
  reasoningEffort: string;
  enabled: boolean;
};

export type ProfileAgentBehavior = {
  profile: string;
  revision: number;
  subagentMode: SubagentMode;
  preferredSubagent: string;
  preferredCandidateIds: string[];
  updatedAt: string;
};

export type AgentBehaviorSnapshot = {
  sharedRevision: number;
  sharedCandidates: SharedSubagentCandidate[];
  profile: ProfileAgentBehavior;
};

export type ProfileAgentBehaviorUpdate = {
  expectedRevision: number;
  expectedSharedRevision?: number;
  subagentMode?: SubagentMode;
  preferredSubagent?: string;
  preferredCandidateIds?: string[];
  sharedCandidates?: SharedSubagentCandidate[];
};

export type HermesConfigFieldType = "boolean" | "number" | "string" | "select" | "list";

export type HermesConfigFieldOption = {
  value: string;
  label: string;
};

export type HermesConfigField = {
  id: string;
  category: string;
  type: HermesConfigFieldType;
  description: string;
  options: HermesConfigFieldOption[];
};

export type HermesConfigScalar = boolean | number | string;
export type HermesConfigValue = HermesConfigScalar | HermesConfigScalar[];

export type ProfileHermesConfig = {
  profile: string;
  revision: string;
  categories: string[];
  fields: HermesConfigField[];
  values: Record<string, HermesConfigValue>;
  excludedCount: number;
};

export type ProfileHermesConfigUpdate = {
  expectedRevision: string;
  changes: Record<string, HermesConfigValue>;
};

export type HermesPrivilegedFieldType = HermesConfigFieldType | "json";
export type PrivilegedConfigImpact = "new-session" | "restart" | "destructive";

export type HermesPrivilegedField = {
  id: string;
  category: string;
  type: HermesPrivilegedFieldType;
  description: string;
  options: HermesConfigFieldOption[];
  impact: PrivilegedConfigImpact;
  requiresConfirmation: boolean;
};

export type HermesPrivilegedConfigValue = HermesConfigValue | unknown;

export type ProfilePrivilegedHermesConfig = {
  profile: string;
  revision: string;
  categories: string[];
  fields: HermesPrivilegedField[];
  values: Record<string, HermesPrivilegedConfigValue>;
  unsupportedCount: number;
  secretFieldCount: number;
};

export type ProfilePrivilegedHermesConfigUpdate = {
  expectedRevision: string;
  changes: Record<string, HermesPrivilegedConfigValue>;
  confirmed?: true;
};

export type HermesSecretSource = "env" | "config" | "memory-provider";

export type HermesSecretFieldMeta = {
  key: string;
  source: HermesSecretSource;
  label: string;
  description: string;
  category: string;
  isSet: boolean;
  isPassword: boolean;
  /** Clear is safe from live metadata; server recomputes on clear regardless. */
  canClear: boolean;
  /** Present only for memory-provider secrets. */
  provider?: string;
  providerLabel?: string;
};

export type ProfileSecrets = {
  profile: string;
  revision: string;
  fields: HermesSecretFieldMeta[];
};

export type GlobalAgentSettings = {
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
};

export type GlobalSettingsUpdate = {
  expectedRevision: number;
  sharedSkillsEnabled?: boolean;
  sharedContextEnabled?: boolean;
  skills?: string[];
  context?: string;
};

export class SettingsApiError extends Error {
  constructor(
    readonly kind: "conflict" | "invalid" | "offline" | "unauthorized" | "unknown",
    message: string,
  ) {
    super(message);
    this.name = "SettingsApiError";
  }
}

export async function loadGlobalSettings(): Promise<GlobalAgentSettings> {
  return parseGlobalSettings(await settingsRequest<unknown>("/api/v1/settings/global"));
}

export async function updateGlobalSettings(update: GlobalSettingsUpdate): Promise<GlobalAgentSettings> {
  return parseGlobalSettings(await settingsRequest<unknown>("/api/v1/settings/global", { method: "PATCH", body: update }));
}

export async function loadProfileSettings(profile: string): Promise<ProfileAgentSettings> {
  return validateProfile(await settingsRequest<unknown>(profilePath(profile, "settings")));
}

export async function loadSkills(profile: string): Promise<SkillSettings[]> {
  const value = await settingsRequest<unknown>(profilePath(profile, "skills"));
  if (!Array.isArray(value)) throw incompatible();
  return value.map(validateSkill);
}

export type UsageKind = "skill" | "mcp" | "tool";

export type UsageStatItem = {
  kind: UsageKind;
  name: string;
  total: number;
  lastUsedAt: string;
  periodCount: number;
};

export type UsageStats = {
  profile: string;
  days: number;
  items: UsageStatItem[];
};

/** Studio-owned skill/MCP/tool usage stats for a profile (names + counts only). */
export async function loadUsageStats(profile: string, days = 30): Promise<UsageStats> {
  const params = new URLSearchParams({ profile, days: String(days) });
  return validateUsageStats(await settingsRequest<unknown>(`/api/v1/stats/usage?${params.toString()}`));
}

export async function setSkillEnabled(
  profile: string,
  skill: string,
  enabled: boolean,
  expectedEnabled: boolean,
): Promise<void> {
  await settingsRequest(profilePath(profile, `skills/${encodeSegment(skill)}`), {
    method: "PATCH",
    body: { enabled, expectedEnabled },
  });
}

export async function loadSkillContent(profile: string, skill: string): Promise<SkillContent> {
  return validateSkillContent(await settingsRequest<unknown>(profilePath(profile, `skills/${encodeSegment(skill)}/content`)));
}

export async function updateSkillContent(
  profile: string,
  skill: string,
  content: string,
  expectedRevision: string,
): Promise<SkillContent> {
  return validateSkillContent(await settingsRequest<unknown>(profilePath(profile, `skills/${encodeSegment(skill)}/content`), {
    method: "PUT", body: { content, expectedRevision },
  }));
}

export async function loadProfileSoul(profile: string): Promise<ProfileSoul> {
  return validateSoul(await settingsRequest<unknown>(profilePath(profile, "soul")));
}

export async function loadProfileProjects(profile: string): Promise<ProfileProjects> {
  return validateProjects(await settingsRequest<unknown>(profilePath(profile, "projects")));
}

export interface HostDirListing {
  path: string;
  parent: string | null;
  home: string;
  dirs: { name: string; path: string }[];
  truncated: boolean;
}

/** Browse host directories (names only) for the project folder picker. */
export async function listHostDirs(path?: string): Promise<HostDirListing> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  const value = await settingsRequest<unknown>(`/api/v1/host/fs/dirs${query}`);
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.home !== "string"
    || (value.parent !== null && typeof value.parent !== "string")
    || !Array.isArray(value.dirs)) throw incompatible();
  return {
    path: value.path,
    parent: value.parent as string | null,
    home: value.home,
    truncated: value.truncated === true,
    dirs: value.dirs.filter(isRecord).map((dir) => {
      if (typeof dir.name !== "string" || typeof dir.path !== "string") throw incompatible();
      return { name: dir.name, path: dir.path };
    }),
  };
}

export async function createProfileProject(
  profile: string,
  input: { name: string; path?: string; label?: string; isPrimary?: boolean },
): Promise<{ project: ProfileProject | null }> {
  const value = await settingsRequest<unknown>(profilePath(profile, "projects"), {
    method: "POST",
    body: {
      name: input.name,
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.isPrimary === undefined ? {} : { isPrimary: input.isPrimary }),
    },
  });
  if (!isRecord(value) || (value.project !== null && !isRecord(value.project))) throw incompatible();
  return { project: value.project === null ? null : validateProject(value.project) };
}

export async function renameProfileProject(profile: string, projectId: string, name: string): Promise<ProfileProject> {
  const value = await settingsRequest<unknown>(profilePath(profile, `projects/${encodeSegment(projectId)}`), {
    method: "PATCH",
    body: { name },
  });
  if (!isRecord(value)) throw incompatible();
  return validateProject(value.project);
}

export async function deleteProfileProject(profile: string, projectId: string): Promise<ProfileProjects> {
  return validateProjects(await settingsRequest<unknown>(profilePath(profile, `projects/${encodeSegment(projectId)}`), {
    method: "DELETE",
  }));
}

export async function addProfileProjectFolder(
  profile: string,
  projectId: string,
  input: { path: string; label?: string; isPrimary?: boolean },
): Promise<ProfileProject> {
  const value = await settingsRequest<unknown>(profilePath(profile, `projects/${encodeSegment(projectId)}/folders`), {
    method: "POST",
    body: {
      path: input.path,
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.isPrimary === undefined ? {} : { isPrimary: input.isPrimary }),
    },
  });
  if (!isRecord(value)) throw incompatible();
  return validateProject(value.project);
}

export async function removeProfileProjectFolder(profile: string, projectId: string, path: string): Promise<ProfileProject> {
  const value = await settingsRequest<unknown>(profilePath(profile, `projects/${encodeSegment(projectId)}/folders`), {
    method: "DELETE",
    body: { path },
  });
  if (!isRecord(value)) throw incompatible();
  return validateProject(value.project);
}

export async function updateProfileSoul(profile: string, content: string, expectedRevision: string): Promise<ProfileSoul> {
  return validateSoul(await settingsRequest<unknown>(profilePath(profile, "soul"), {
    method: "PUT", body: { content, expectedRevision },
  }));
}

export async function loadAgentBehavior(profile: string): Promise<AgentBehaviorSnapshot> {
  return validateAgentBehaviorSnapshot(await settingsRequest<unknown>(profilePath(profile, "agent-behavior")));
}

export async function updateAgentBehavior(
  profile: string,
  update: ProfileAgentBehaviorUpdate,
): Promise<AgentBehaviorSnapshot> {
  return validateAgentBehaviorSnapshot(await settingsRequest<unknown>(profilePath(profile, "agent-behavior"), {
    method: "PUT",
    body: update,
  }));
}

export async function loadProfileHermesConfig(profile: string): Promise<ProfileHermesConfig> {
  return validateHermesConfig(await settingsRequest<unknown>(profilePath(profile, "config")));
}

export async function updateProfileHermesConfig(
  profile: string,
  update: ProfileHermesConfigUpdate,
): Promise<ProfileHermesConfig> {
  return validateHermesConfig(await settingsRequest<unknown>(profilePath(profile, "config"), {
    method: "PATCH",
    body: update,
  }));
}

export async function loadPrivilegedProfileConfig(profile: string): Promise<ProfilePrivilegedHermesConfig> {
  return validatePrivilegedHermesConfig(await settingsRequest<unknown>(profilePath(profile, "privileged-config")));
}

export async function updatePrivilegedProfileConfig(
  profile: string,
  update: ProfilePrivilegedHermesConfigUpdate,
): Promise<ProfilePrivilegedHermesConfig> {
  return validatePrivilegedHermesConfig(await settingsRequest<unknown>(profilePath(profile, "privileged-config"), {
    method: "PATCH",
    body: update,
  }));
}

export async function loadProfileSecrets(profile: string): Promise<ProfileSecrets> {
  return validateProfileSecrets(await settingsRequest<unknown>(profilePath(profile, "secrets")));
}

/**
 * Consume a desktop-native transfer. Browser request carries transferId + field
 * metadata only — never the secret value.
 */
export async function consumeSecretTransfer(
  profile: string,
  input: {
    transferId: string;
    key: string;
    source: HermesSecretSource;
    provider?: string;
    expectedRevision?: string;
  },
): Promise<ProfileSecrets> {
  return validateProfileSecrets(await settingsRequest<unknown>(profilePath(profile, "secrets"), {
    method: "POST",
    body: {
      transferId: input.transferId,
      key: input.key,
      source: input.source,
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    },
  }));
}

/** Stable client key for write-only secret drafts (includes provider when present). */
export function secretFieldDraftKey(field: Pick<HermesSecretFieldMeta, "source" | "key" | "provider">): string {
  return `${field.source}:${field.provider ?? ""}:${field.key}`;
}

export async function loadMemoryStatus(profile: string): Promise<MemoryStatus> {
  return validateMemory(await settingsRequest<unknown>(profilePath(profile, "memory")));
}

export async function setMemoryProvider(
  profile: string,
  provider: string,
  expectedProvider: string,
): Promise<MemoryStatus> {
  return validateMemory(await settingsRequest<unknown>(profilePath(profile, "memory/provider"), {
    method: "PUT", body: { provider, expectedProvider },
  }));
}

export async function loadMemoryProviderConfig(profile: string, provider: string): Promise<MemoryProviderConfig> {
  return validateProviderConfig(await settingsRequest<unknown>(profilePath(profile, `memory/providers/${encodeSegment(provider)}`)));
}

export async function updateMemoryProviderConfig(
  profile: string,
  provider: string,
  values: Record<string, boolean | string>,
  expectedRevision: string,
): Promise<MemoryProviderConfig> {
  return validateProviderConfig(await settingsRequest<unknown>(profilePath(profile, `memory/providers/${encodeSegment(provider)}`), {
    method: "PATCH", body: { values, expectedRevision },
  }));
}

export async function loadBuiltinMemoryFiles(profile: string): Promise<BuiltinMemoryFiles> {
  return validateBuiltinMemoryFiles(await settingsRequest<unknown>(profilePath(profile, "memory/files")));
}

export async function updateBuiltinMemoryFile(
  profile: string,
  key: BuiltinMemoryFileKey,
  content: string,
  expectedRevision: string,
): Promise<BuiltinMemoryFile> {
  return validateBuiltinMemoryFile(await settingsRequest<unknown>(profilePath(profile, `memory/files/${encodeSegment(key)}`), {
    method: "PUT", body: { content, expectedRevision },
  }));
}

export async function resetBuiltinMemory(profile: string, target: MemoryResetTarget): Promise<MemoryResetResult> {
  return validateMemoryResetResult(await settingsRequest<unknown>(profilePath(profile, "memory/reset"), {
    method: "POST", body: { target },
  }));
}

async function settingsRequest<T>(path: string, options: OfficeApiRequestOptions = {}): Promise<T> {
  try {
    // A cold profile settings read may lazily start `hermes --profile ... serve`.
    return await officeFetchJson<T>(path, { timeoutMs: 30_000, ...options });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /HTTP\s+(\d{3})/.exec(message)?.[1];
    if (status === "409") throw new SettingsApiError("conflict", "別の画面で設定が更新されました。再読込してから変更してください。");
    if (status === "400" || status === "413" || status === "415") throw new SettingsApiError("invalid", "入力内容を確認してください。");
    if (status === "401" || status === "403") throw new SettingsApiError("unauthorized", "この設定を変更する権限がありません。");
    if (status === "502" || status === "503" || status === "504" || error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError")) throw new SettingsApiError("offline", "Hermes設定へ接続できません。runtimeを確認してください。");
    throw new SettingsApiError("unknown", "設定を読み込めませんでした。");
  }
}

function profilePath(profile: string, suffix: string): string { return `/api/v1/profiles/${encodeSegment(profile)}/${suffix}`; }
function encodeSegment(value: string): string { if (!value || value.includes("/") || value.includes("\0")) throw new SettingsApiError("invalid", "設定対象の名前が不正です。"); return encodeURIComponent(value); }

export function parseGlobalSettings(value: unknown): GlobalAgentSettings {
  if (!isRecord(value) || !Number.isInteger(value.revision) || typeof value.sharedSkillsEnabled !== "boolean" || typeof value.sharedContextEnabled !== "boolean" || !isStringArray(value.skills) || typeof value.context !== "string" || typeof value.updatedAt !== "string" || !isRecord(value.skillSync) || (value.skillSync.state !== "pending" && value.skillSync.state !== "ready") || !Array.isArray(value.skillSync.failures)) throw incompatible();
  const failures = value.skillSync.failures.map((item): GlobalAgentSettings["skillSync"]["failures"][number] => {
    if (!isRecord(item) || typeof item.profile !== "string" || typeof item.skill !== "string" || (item.operation !== "enable" && item.operation !== "disable")) throw incompatible();
    return { profile: item.profile, skill: item.skill, operation: item.operation };
  });
  return { revision: value.revision as number, sharedSkillsEnabled: value.sharedSkillsEnabled, sharedContextEnabled: value.sharedContextEnabled, skills: [...value.skills], context: value.context, updatedAt: value.updatedAt, skillSync: { state: value.skillSync.state, failures } };
}

function validateProfile(value: unknown): ProfileAgentSettings {
  if (!isRecord(value) || typeof value.profile !== "string" || !Array.isArray(value.skills)) throw incompatible();
  return { profile: value.profile, skills: value.skills.map(validateSkill), memory: validateMemory(value.memory), soul: validateSoul(value.soul) };
}

function validateSkill(value: unknown): SkillSettings {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.category !== "string" || typeof value.description !== "string" || typeof value.enabled !== "boolean" || typeof value.usage !== "number") throw incompatible();
  const provenance = value.provenance === "agent" || value.provenance === "bundled" || value.provenance === "hub" ? value.provenance : "unknown";
  return { name: value.name, category: value.category, description: value.description, enabled: value.enabled, provenance, usage: value.usage };
}

function validateSkillContent(value: unknown): SkillContent {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.content !== "string" || typeof value.redacted !== "boolean" || typeof value.revision !== "string") throw incompatible();
  return { name: value.name, content: value.content, redacted: value.redacted, revision: value.revision };
}

function validateMemory(value: unknown): MemoryStatus {
  if (!isRecord(value) || typeof value.activeProvider !== "string" || !Array.isArray(value.providers) || !isRecord(value.builtin)) throw incompatible();
  const providers = value.providers.map((item): MemoryProvider => {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.description !== "string" || typeof item.configured !== "boolean") throw incompatible();
    return { name: item.name, description: item.description, configured: item.configured };
  });
  const builtin = value.builtin;
  if (typeof builtin.memoryBytes !== "number" || typeof builtin.userBytes !== "number" || typeof builtin.hasMemory !== "boolean" || typeof builtin.hasUser !== "boolean") throw incompatible();
  return { activeProvider: value.activeProvider, providers, builtin: { memoryBytes: builtin.memoryBytes, userBytes: builtin.userBytes, hasMemory: builtin.hasMemory, hasUser: builtin.hasUser } };
}

function validateBuiltinMemoryFile(value: unknown): BuiltinMemoryFile {
  if (
    !isRecord(value)
    || (value.key !== "memory" && value.key !== "user")
    || typeof value.content !== "string"
    || typeof value.exists !== "boolean"
    || typeof value.bytes !== "number"
    || typeof value.revision !== "string"
  ) throw incompatible();
  return {
    key: value.key,
    content: value.content,
    exists: value.exists,
    bytes: value.bytes,
    revision: value.revision,
  };
}

function validateBuiltinMemoryFiles(value: unknown): BuiltinMemoryFiles {
  if (!isRecord(value) || typeof value.profile !== "string") throw incompatible();
  return {
    profile: value.profile,
    memory: validateBuiltinMemoryFile(value.memory),
    user: validateBuiltinMemoryFile(value.user),
  };
}

function validateMemoryResetResult(value: unknown): MemoryResetResult {
  if (!isRecord(value) || value.ok !== true || (value.target !== "all" && value.target !== "memory" && value.target !== "user")) {
    throw incompatible();
  }
  return {
    ok: true,
    target: value.target,
    files: validateBuiltinMemoryFiles(value.files),
    status: validateMemory(value.status),
  };
}

function validateSoul(value: unknown): ProfileSoul {
  if (!isRecord(value) || typeof value.profile !== "string" || typeof value.content !== "string" || typeof value.exists !== "boolean" || typeof value.redacted !== "boolean" || typeof value.revision !== "string") throw incompatible();
  return { profile: value.profile, content: value.content, exists: value.exists, redacted: value.redacted, revision: value.revision };
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw incompatible();
  return value;
}

function validateProjectFolder(value: unknown): ProfileProjectFolder {
  if (!isRecord(value) || typeof value.path !== "string") throw incompatible();
  return {
    path: value.path,
    label: nullableString(value.label),
    isPrimary: value.isPrimary === true,
    addedAt: typeof value.addedAt === "number" && Number.isFinite(value.addedAt) ? value.addedAt : 0,
  };
}

function validateProject(value: unknown): ProfileProject {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || !Array.isArray(value.folders)) throw incompatible();
  return {
    id: value.id,
    slug: typeof value.slug === "string" ? value.slug : "",
    name: value.name,
    description: nullableString(value.description),
    icon: nullableString(value.icon),
    color: nullableString(value.color),
    boardSlug: nullableString(value.boardSlug),
    primaryPath: nullableString(value.primaryPath),
    archived: value.archived === true,
    createdAt: typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : 0,
    folders: value.folders.map(validateProjectFolder),
  };
}

function validateProjects(value: unknown): ProfileProjects {
  if (!isRecord(value) || !Array.isArray(value.projects)) throw incompatible();
  return {
    projects: value.projects.map(validateProject),
    activeId: typeof value.activeId === "string" ? value.activeId : null,
  };
}

function validateAgentBehaviorSnapshot(value: unknown): AgentBehaviorSnapshot {
  if (!isRecord(value)
    || !Number.isInteger(value.sharedRevision)
    || (value.sharedRevision as number) < 0
    || !Array.isArray(value.sharedCandidates)
    || !isRecord(value.profile)) throw incompatible();
  return {
    sharedRevision: value.sharedRevision as number,
    sharedCandidates: value.sharedCandidates.map(validateSharedSubagentCandidate),
    profile: validateAgentBehavior(value.profile),
  };
}

function validateSharedSubagentCandidate(value: unknown): SharedSubagentCandidate {
  if (
    !isRecord(value)
    || typeof value.id !== "string"
    || typeof value.label !== "string"
    || typeof value.provider !== "string"
    || typeof value.model !== "string"
    || typeof value.reasoningEffort !== "string"
    || typeof value.enabled !== "boolean"
  ) throw incompatible();
  return {
    id: value.id,
    label: value.label,
    provider: value.provider,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
    enabled: value.enabled,
  };
}

function validateAgentBehavior(value: unknown): ProfileAgentBehavior {
  if (
    !isRecord(value)
    || typeof value.profile !== "string"
    || !Number.isInteger(value.revision)
    || (value.subagentMode !== "auto" && value.subagentMode !== "manual")
    || typeof value.preferredSubagent !== "string"
    || typeof value.updatedAt !== "string"
  ) throw incompatible();
  const preferredCandidateIds = Array.isArray(value.preferredCandidateIds)
    ? value.preferredCandidateIds.filter((item): item is string => typeof item === "string").slice(0, 3)
    : [];
  return {
    profile: value.profile,
    revision: value.revision as number,
    subagentMode: value.subagentMode,
    preferredSubagent: value.preferredSubagent,
    preferredCandidateIds,
    updatedAt: value.updatedAt,
  };
}

function validateHermesConfig(value: unknown): ProfileHermesConfig {
  if (
    !isRecord(value)
    || typeof value.profile !== "string"
    || typeof value.revision !== "string"
    || !Array.isArray(value.categories)
    || !Array.isArray(value.fields)
    || !isRecord(value.values)
    || typeof value.excludedCount !== "number"
  ) throw incompatible();
  const categories = value.categories.filter((item): item is string => typeof item === "string");
  const fields = value.fields.map((item): HermesConfigField => {
    if (
      !isRecord(item)
      || typeof item.id !== "string"
      || typeof item.category !== "string"
      || typeof item.description !== "string"
      || !Array.isArray(item.options)
    ) throw incompatible();
    const type: HermesConfigFieldType =
      item.type === "boolean" || item.type === "number" || item.type === "string"
      || item.type === "select" || item.type === "list"
        ? item.type
        : (() => { throw incompatible(); })();
    const options = item.options.map((option): HermesConfigFieldOption => {
      if (!isRecord(option) || typeof option.value !== "string" || typeof option.label !== "string") throw incompatible();
      return { value: option.value, label: option.label };
    });
    return { id: item.id, category: item.category, type, description: item.description, options };
  });
  const values: Record<string, HermesConfigValue> = {};
  for (const [key, item] of Object.entries(value.values)) {
    if (typeof item === "boolean" || typeof item === "number" || typeof item === "string") {
      values[key] = item;
      continue;
    }
    // List contract matches server: string rows only (no boolean/number coercion).
    if (Array.isArray(item) && item.every((entry): entry is string => typeof entry === "string")) {
      values[key] = [...item];
      continue;
    }
    throw incompatible();
  }
  return {
    profile: value.profile,
    revision: value.revision,
    categories,
    fields,
    values,
    excludedCount: Math.max(0, Math.trunc(value.excludedCount)),
  };
}

function validatePrivilegedHermesConfig(value: unknown): ProfilePrivilegedHermesConfig {
  if (
    !isRecord(value)
    || typeof value.profile !== "string"
    || typeof value.revision !== "string"
    || !Array.isArray(value.categories)
    || !Array.isArray(value.fields)
    || !isRecord(value.values)
    || typeof value.unsupportedCount !== "number"
    || typeof value.secretFieldCount !== "number"
  ) throw incompatible();
  const categories = value.categories.filter((item): item is string => typeof item === "string");
  const fields = value.fields.map((item): HermesPrivilegedField => {
    if (
      !isRecord(item)
      || typeof item.id !== "string"
      || typeof item.category !== "string"
      || typeof item.description !== "string"
      || !Array.isArray(item.options)
      || typeof item.requiresConfirmation !== "boolean"
    ) throw incompatible();
    const type: HermesPrivilegedFieldType =
      item.type === "boolean" || item.type === "number" || item.type === "string"
      || item.type === "select" || item.type === "list" || item.type === "json"
        ? item.type
        : (() => { throw incompatible(); })();
    const impact: PrivilegedConfigImpact =
      item.impact === "restart" || item.impact === "destructive" || item.impact === "new-session"
        ? item.impact
        : "new-session";
    const options = item.options.map((option): HermesConfigFieldOption => {
      if (!isRecord(option) || typeof option.value !== "string" || typeof option.label !== "string") throw incompatible();
      return { value: option.value, label: option.label };
    });
    return {
      id: item.id,
      category: item.category,
      type,
      description: item.description,
      options,
      impact,
      requiresConfirmation: item.requiresConfirmation,
    };
  });
  const values: Record<string, HermesPrivilegedConfigValue> = {};
  for (const [key, item] of Object.entries(value.values)) {
    if (typeof item === "boolean" || typeof item === "number" || typeof item === "string") {
      values[key] = item;
      continue;
    }
    if (Array.isArray(item) && item.every((entry): entry is string => typeof entry === "string")) {
      values[key] = [...item];
      continue;
    }
    // Bounded JSON leaves (objects / nested arrays) pass through as structured values.
    if (item !== null && typeof item === "object") {
      values[key] = item;
      continue;
    }
    throw incompatible();
  }
  return {
    profile: value.profile,
    revision: value.revision,
    categories,
    fields,
    values,
    unsupportedCount: Math.max(0, Math.trunc(value.unsupportedCount)),
    secretFieldCount: Math.max(0, Math.trunc(value.secretFieldCount)),
  };
}

function validateProfileSecrets(value: unknown): ProfileSecrets {
  if (
    !isRecord(value)
    || typeof value.profile !== "string"
    || typeof value.revision !== "string"
    || !Array.isArray(value.fields)
  ) throw incompatible();
  const fields = value.fields.map((item): HermesSecretFieldMeta => {
    if (
      !isRecord(item)
      || typeof item.key !== "string"
      || (item.source !== "env" && item.source !== "config" && item.source !== "memory-provider")
      || typeof item.label !== "string"
      || typeof item.description !== "string"
      || typeof item.category !== "string"
      || typeof item.isSet !== "boolean"
      || typeof item.isPassword !== "boolean"
      || typeof item.canClear !== "boolean"
    ) throw incompatible();
    // Fail closed: never accept a value property even if a buggy server sent one.
    if ("value" in item || "redacted_value" in item || "redactedValue" in item) throw incompatible();
    // Never accept env key names on memory-provider metadata.
    if ("envKey" in item || "env_key" in item || "_env_key" in item) throw incompatible();
    if (item.source === "memory-provider") {
      if (typeof item.provider !== "string" || item.provider.length === 0) throw incompatible();
      if (item.providerLabel !== undefined && typeof item.providerLabel !== "string") throw incompatible();
    } else if (item.provider !== undefined || item.providerLabel !== undefined) {
      throw incompatible();
    }
    return {
      key: item.key,
      source: item.source,
      label: item.label,
      description: item.description,
      category: item.category,
      isSet: item.isSet,
      isPassword: item.isPassword,
      canClear: item.canClear,
      ...(item.source === "memory-provider"
        ? {
          provider: item.provider as string,
          ...(typeof item.providerLabel === "string" ? { providerLabel: item.providerLabel } : {}),
        }
        : {}),
    };
  });
  return { profile: value.profile, revision: value.revision, fields };
}

function validateProviderConfig(value: unknown): MemoryProviderConfig {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.label !== "string" || !Array.isArray(value.fields) || typeof value.revision !== "string") throw incompatible();
  const fields = value.fields.map((item): MemoryProviderField => {
    if (!isRecord(item) || typeof item.key !== "string" || typeof item.label !== "string" || typeof item.description !== "string" || typeof item.required !== "boolean" || typeof item.isSet !== "boolean" || !Array.isArray(item.options)) throw incompatible();
    const kind: MemoryFieldKind = item.kind === "boolean" || item.kind === "secret" || item.kind === "select" ? item.kind : "text";
    const options = item.options.map((option) => {
      if (!isRecord(option) || typeof option.value !== "string" || typeof option.label !== "string" || typeof option.description !== "string") throw incompatible();
      return { value: option.value, label: option.label, description: option.description };
    });
    const field: MemoryProviderField = { key: item.key, label: item.label, description: item.description, required: item.required, isSet: item.isSet, kind, options };
    if (typeof item.value === "string" || typeof item.value === "boolean") field.value = item.value;
    return field;
  });
  return { name: value.name, label: value.label, fields, revision: value.revision };
}

function validateUsageStats(value: unknown): UsageStats {
  if (!isRecord(value) || typeof value.profile !== "string" || typeof value.days !== "number" || !Array.isArray(value.items)) throw incompatible();
  const items = value.items.map((item): UsageStatItem => {
    if (!isRecord(item) || (item.kind !== "skill" && item.kind !== "mcp" && item.kind !== "tool")
      || typeof item.name !== "string" || typeof item.total !== "number"
      || typeof item.lastUsedAt !== "string" || typeof item.periodCount !== "number") {
      throw incompatible();
    }
    return {
      kind: item.kind,
      name: item.name,
      total: item.total,
      lastUsedAt: item.lastUsedAt,
      periodCount: item.periodCount,
    };
  });
  return { profile: value.profile, days: value.days, items };
}

function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function incompatible(): SettingsApiError { return new SettingsApiError("unknown", "Studio Serverの設定応答に互換性がありません。"); }
