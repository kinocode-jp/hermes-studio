/**
 * Transport-neutral contracts shared by Hermes Studio clients and server.
 *
 * This package deliberately has no runtime dependencies. Authentication and
 * authorization context are derived by the server and are never accepted from
 * a client-supplied DTO.
 */

export const PROTOCOL_VERSION = 1 as const;

/** Maximum UTF-8 payload accepted for a single Hermes chat prompt. */
export const CHAT_PROMPT_MAX_UTF8_BYTES = 512 * 1024;
/** JSON-escaped prompt budget inside the 1 MiB chat RPC frame. */
export const CHAT_PROMPT_MAX_JSON_UTF8_BYTES = (1024 * 1024) - 2_048;

export function isChatPromptWithinBudget(value: string): boolean {
  if (value.includes("\0") || utf8ByteLength(value) > CHAT_PROMPT_MAX_UTF8_BYTES) return false;
  const encoded = JSON.stringify(value);
  return utf8ByteLength(encoded.slice(1, -1)) <= CHAT_PROMPT_MAX_JSON_UTF8_BYTES;
}

/**
 * Global context crosses the settings HTTP boundary and is later embedded in
 * a `session.create` JSON-RPC frame. Keep one wire contract for every layer.
 * The context count is its UTF-8 size after JSON string escaping; the reserve
 * leaves room for the settings/RPC envelope and bounded skill selection.
 */
export const GLOBAL_SETTINGS_MAX_REQUEST_UTF8_BYTES = 64 * 1024;
export const GLOBAL_CONTEXT_ENVELOPE_RESERVE_UTF8_BYTES = 16 * 1024;
export const GLOBAL_CONTEXT_MAX_UTF8_BYTES =
  GLOBAL_SETTINGS_MAX_REQUEST_UTF8_BYTES - GLOBAL_CONTEXT_ENVELOPE_RESERVE_UTF8_BYTES;
export const GLOBAL_SETTINGS_MAX_SKILLS = 64;

/**
 * Profile Hermes config (schema-driven advanced settings) wire budgets.
 * PATCH carries only dotted leaf changes; GET returns safe leaves only.
 */
export const PROFILE_CONFIG_MAX_REQUEST_UTF8_BYTES = 64 * 1024;
export const PROFILE_CONFIG_MAX_RESPONSE_UTF8_BYTES = 512 * 1024;
export const PROFILE_CONFIG_MAX_FIELDS = 600;
export const PROFILE_CONFIG_MAX_CHANGES = 100;
export const PROFILE_CONFIG_MAX_STRING_UTF8_BYTES = 8 * 1024;
export const PROFILE_CONFIG_MAX_LIST_ITEMS = 64;
export const PROFILE_CONFIG_MAX_LIST_ITEM_UTF8_BYTES = 2 * 1024;
export const PROFILE_CONFIG_MAX_NEST_DEPTH = 8;
export const PROFILE_CONFIG_MAX_OPTIONS = 64;

/**
 * Privileged Hermes config + one-shot secret transfer budgets.
 * Privileged leaves are owner-tier; remote access is deployment-gated.
 * Secrets never leave transfer paths as ordinary config DTOs.
 */
export const PRIVILEGED_CONFIG_MAX_REQUEST_UTF8_BYTES = 64 * 1024;
export const PRIVILEGED_CONFIG_MAX_RESPONSE_UTF8_BYTES = 512 * 1024;
export const PRIVILEGED_CONFIG_MAX_FIELDS = 600;
export const PRIVILEGED_CONFIG_MAX_CHANGES = 100;
export const PRIVILEGED_CONFIG_MAX_JSON_UTF8_BYTES = 16 * 1024;
export const SECRET_TRANSFER_MAX_VALUE_UTF8_BYTES = 8 * 1024;
export const SECRET_TRANSFER_MAX_PENDING = 8;
export const SECRET_TRANSFER_TTL_MS = 30_000;
export const SECRET_TRANSFER_ID_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;
export const SECRET_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** UTF-8 bytes occupied by the context inside a JSON string, excluding quotes. */
export function globalContextUtf8Bytes(value: string): number {
  const encoded = JSON.stringify(value);
  return utf8ByteLength(encoded.slice(1, -1));
}

export function isGlobalContextWithinBudget(value: string): boolean {
  return !value.includes("\0") && globalContextUtf8Bytes(value) <= GLOBAL_CONTEXT_MAX_UTF8_BYTES;
}

export type ProtocolVersion = typeof PROTOCOL_VERSION;
export type IsoDateTime = string;
/** Stable DTO sentinel used only when Hermes omits an inventory timestamp. */
export const UNKNOWN_INVENTORY_TIMESTAMP = "0001-01-01T00:00:00.000Z" as const;
export type EntityId = string;
export type ProfileId = EntityId;
export type SessionId = EntityId;
export type MessageId = EntityId;
export type BoardId = EntityId;
export type CardId = EntityId;
export type DeviceId = EntityId;
export type TeamId = EntityId;
export type SkillId = EntityId;
export type EventId = EntityId;

export type RuntimeMode = "managed-sidecar" | "existing-local";
export type RuntimeState =
  | "unconfigured"
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "unreachable"
  | "incompatible"
  | "error";
export type NetworkExposure = "loopback" | "tailnet" | "public";
export type AuthenticationMode =
  | "desktop-capability"
  | "local-cookie"
  | "device-cookie"
  | "tailscale-identity"
  | "oidc";

/** Increasing tiers. The server is the sole authority for the effective tier. */
export type PermissionTier = "viewer" | "operator" | "manager" | "owner";

/**
 * Mutation boundaries are independent of roles. A high tier does not make a
 * local-only operation remotely callable.
 */
export type MutationBoundary =
  | "read-only"
  | "remote-safe"
  | "step-up-required"
  | "local-only";

export type Operation =
  | "state.read"
  | "chat.session.create"
  | "chat.session.archive"
  | "chat.message.send"
  | "chat.run.cancel"
  | "chat.approval.permanent"
  | "kanban.card.create"
  | "kanban.card.update"
  | "kanban.card.comment"
  | "team.create"
  | "team.update"
  | "team.delete"
  | "profile.create"
  | "profile.update"
  | "profile.delete"
  | "memory.update"
  | "skill.enable"
  | "skill.install"
  | "global-settings.update"
  | "chat-model-preferences.update"
  | "local-model-providers.sync"
  /** Schema-driven safe Hermes config leaves for a profile. */
  | "profile-config.update"
  /**
   * Previously excluded non-secret Hermes config leaves. Owner tier;
   * remote-safe when deployment enables remote privileged (Tailscale path).
   */
  | "privileged-config.read"
  | "privileged-config.update"
  /** Install a fixed allowlisted application on the Studio host. */
  | "host-app.install"
  /** Browse host directories (names only) for folder pickers. */
  | "host-fs.read"
  /** Open or reveal a user-selected absolute path on the local Studio host. */
  | "host-fs.open"
  /** Read registered Obsidian vault metadata and its bounded note graph. */
  | "obsidian.vault.read"
  /** Update the fixed local Hermes Agent install on the Studio host. */
  | "hermes-agent.update"
  | "runtime.start"
  | "runtime.stop"
  | "runtime.configure"
  | "secret.write"
  | "device.revoke"
  | "audit.read";

/** Operations gated by HERMES_STUDIO_REMOTE_PRIVILEGED for non-local sessions. */
export const REMOTE_PRIVILEGED_OPERATIONS: readonly Operation[] = [
  "privileged-config.read",
  "privileged-config.update",
  "secret.write",
  "host-app.install",
  "host-fs.read",
  "obsidian.vault.read",
  "hermes-agent.update",
] as const;

export function isRemotePrivilegedOperation(operation: Operation): boolean {
  return (REMOTE_PRIVILEGED_OPERATIONS as readonly string[]).includes(operation);
}

export interface OperationPolicy {
  operation: Operation;
  minimumTier: PermissionTier;
  boundary: MutationBoundary;
  auditable: boolean;
}

/** Canonical defaults; deployments may only make these stricter. */
export const OPERATION_POLICIES: Readonly<Record<Operation, OperationPolicy>> = {
  "state.read": policy("state.read", "viewer", "read-only", false),
  "chat.session.create": policy("chat.session.create", "operator", "remote-safe", true),
  "chat.session.archive": policy("chat.session.archive", "operator", "remote-safe", true),
  "chat.message.send": policy("chat.message.send", "operator", "remote-safe", true),
  "chat.run.cancel": policy("chat.run.cancel", "operator", "remote-safe", true),
  "chat.approval.permanent": policy("chat.approval.permanent", "owner", "local-only", true),
  "kanban.card.create": policy("kanban.card.create", "operator", "remote-safe", true),
  "kanban.card.update": policy("kanban.card.update", "operator", "remote-safe", true),
  "kanban.card.comment": policy("kanban.card.comment", "operator", "remote-safe", true),
  // Team membership, context, and skills are inherited by new sessions. Keep
  // these mutations on the same boundary as direct profile/skill changes.
  "team.create": policy("team.create", "manager", "step-up-required", true),
  "team.update": policy("team.update", "manager", "step-up-required", true),
  "team.delete": policy("team.delete", "manager", "step-up-required", true),
  "profile.create": policy("profile.create", "manager", "step-up-required", true),
  "profile.update": policy("profile.update", "manager", "step-up-required", true),
  "profile.delete": policy("profile.delete", "owner", "step-up-required", true),
  "memory.update": policy("memory.update", "manager", "step-up-required", true),
  "skill.enable": policy("skill.enable", "manager", "step-up-required", true),
  "skill.install": policy("skill.install", "owner", "local-only", true),
  "global-settings.update": policy(
    "global-settings.update",
    "owner",
    "step-up-required",
    true,
  ),
  // These preferences only select values the same operator may already send
  // when creating a chat session. Keep cross-device synchronization available
  // to enrolled Tailnet operators while retaining CSRF and revision checks.
  "chat-model-preferences.update": policy(
    "chat-model-preferences.update",
    "operator",
    "remote-safe",
    true,
  ),
  // Bounded discovery only: the server probes fixed loopback model endpoints
  // and may reconcile only Studio-owned custom endpoint ids for this profile.
  "local-model-providers.sync": policy(
    "local-model-providers.sync",
    "operator",
    "remote-safe",
    true,
  ),
  // Safe ordinary Hermes config only (fail-closed policy strips secrets /
  // execution-adjacent fields). Still step-up-required: remaining leaves can
  // change agent behavior, so remote devices without local step-up fail closed
  // (same pattern as skill.enable / profile.update).
  "profile-config.update": policy(
    "profile-config.update",
    "manager",
    "step-up-required",
    true,
  ),
  // Privileged non-secret Hermes leaves (model/toolsets/terminal/approvals/…).
  // Owner tier; remote-safe so Tailscale-enrolled owner devices may call when
  // HERMES_STUDIO_REMOTE_PRIVILEGED is enabled. OfficeAuth filters these out of
  // remote allowedOperations and denies authorize when the flag is off.
  "privileged-config.read": policy(
    "privileged-config.read",
    "owner",
    "read-only",
    true,
  ),
  "privileged-config.update": policy(
    "privileged-config.update",
    "owner",
    "remote-safe",
    true,
  ),
  // Fixed allowlisted host app installation. Remote use requires the same
  // explicit Tailnet privileged deployment gate as secrets/config.
  "host-app.install": policy("host-app.install", "owner", "remote-safe", true),
  // Directory-name browsing for folder pickers. Same remote-privileged
  // deployment gate as other host-scoped reads.
  "host-fs.read": policy("host-fs.read", "owner", "read-only", true),
  // Launching a file or revealing it in the host file manager is always a
  // local-owner gesture. Remote clients may still see and copy MEDIA paths.
  "host-fs.open": policy("host-fs.open", "owner", "local-only", true),
  "obsidian.vault.read": policy("obsidian.vault.read", "owner", "read-only", true),
  // Fixed Hermes Agent update (`hermes update --yes`). Same remote-privileged
  // deployment gate as host-app install / privileged config / secrets.
  "hermes-agent.update": policy("hermes-agent.update", "owner", "remote-safe", true),
  "runtime.start": policy("runtime.start", "owner", "local-only", true),
  "runtime.stop": policy("runtime.stop", "owner", "local-only", true),
  "runtime.configure": policy("runtime.configure", "owner", "local-only", true),
  // Secret deposit/consume: owner remote-safe under the same remote-privileged flag.
  "secret.write": policy("secret.write", "owner", "remote-safe", true),
  "device.revoke": policy("device.revoke", "owner", "local-only", true),
  "audit.read": policy("audit.read", "owner", "read-only", false),
} as const;

function policy(
  operation: Operation,
  minimumTier: PermissionTier,
  boundary: MutationBoundary,
  auditable: boolean,
): OperationPolicy {
  return { operation, minimumTier, boundary, auditable };
}

export interface EffectiveAccess {
  deviceId: DeviceId;
  tier: PermissionTier;
  exposure: NetworkExposure;
  authentication: AuthenticationMode;
  stepUpValidUntil?: IsoDateTime;
  allowedOperations: readonly Operation[];
}

export interface DeviceSummary {
  id: DeviceId;
  displayName: string;
  tier: PermissionTier;
  createdAt: IsoDateTime;
  lastSeenAt?: IsoDateTime;
  revokedAt?: IsoDateTime;
}

/**
 * Owner-visible remote access status. Never contains secrets, digests,
 * credentials, or cookie values. Origins are returned as the canonical
 * configured HTTPS origins.
 */
export interface RemoteConfigStatus {
  enabled: boolean;
  origins: readonly string[];
  trustedProxyHops: number;
  devices: readonly DeviceSummary[];
}

export interface RuntimeStatus {
  mode: RuntimeMode;
  state: RuntimeState;
  hermesVersion?: string;
  adapterVersion: string;
  compatibilityMessage?: string;
}

export interface Capabilities {
  protocolVersion: ProtocolVersion;
  serverVersion: string;
  runtime: RuntimeStatus;
  access: EffectiveAccess;
  features: readonly (
    | "chat"
    | "profiles"
    | "skills"
    | "memory"
    | "kanban"
    | "teams"
    | "global-inheritance"
    | "demo"
  )[];
}

export type AgentActivity =
  | "offline"
  | "idle"
  | "thinking"
  | "using-tool"
  | "waiting-for-user"
  | "blocked"
  | "error";

export interface ProfileSummary {
  id: ProfileId;
  name: string;
  avatarKey: string;
  activity: AgentActivity;
  activeSessionCount: number;
  inheritedSkillCount: number;
  ownSkillCount: number;
  revision: number;
}

export type InheritanceMode = "inherit" | "override" | "disabled";

export interface ProfileSettings {
  profileId: ProfileId;
  displayName: string;
  avatarKey: string;
  model?: string;
  systemPrompt?: string;
  memoryMode: InheritanceMode;
  skillMode: InheritanceMode;
  revision: number;
}

export interface GlobalSettings {
  defaultModel?: string;
  sharedContextEnabled: boolean;
  sharedSkillsEnabled: boolean;
  revision: number;
}

export interface OfficeSnapshot {
  generatedAt: IsoDateTime;
  sequence: number;
  capabilities: Capabilities;
  globalSettings: GlobalSettings;
  profiles: readonly ProfileSummary[];
  sessions: readonly ChatSessionSummary[];
  inventory: OfficeInventoryMetadata;
  boards: readonly KanbanBoardSummary[];
}

export type OfficeInventoryKind = "profiles" | "sessions";

export interface OfficeInventoryPagination {
  returned: number;
  available: number;
  total?: number;
  hasMore: boolean;
  truncated: boolean;
  partialFailures: number;
  nextCursor?: string;
}

export type OfficeInventoryReliability = "complete" | "partial" | "unavailable";

/**
 * Controls whether a client may treat missing inventory rows as confirmed
 * deletions. An unavailable zero-row read must retain last-known-good state;
 * a complete zero-row read is an authoritative empty inventory.
 */
export function officeInventoryReliability(
  page: Pick<OfficeInventoryPagination, "returned" | "available" | "truncated" | "partialFailures">,
): OfficeInventoryReliability {
  if (page.returned === 0 && page.available === 0 && page.partialFailures > 0) return "unavailable";
  if (page.truncated || page.partialFailures > 0) return "partial";
  return "complete";
}

export interface OfficeInventoryMetadata {
  profiles: OfficeInventoryPagination;
  sessions: OfficeInventoryPagination;
}

export interface OfficeInventoryPage {
  kind: OfficeInventoryKind;
  profiles: readonly ProfileSummary[];
  sessions: readonly ChatSessionSummary[];
  pagination: OfficeInventoryPagination;
}

export interface SkillSummary {
  id: SkillId;
  name: string;
  description?: string;
  source: "global" | "profile";
  enabled: boolean;
  requiresLocalExecution: boolean;
}

export interface MemoryDocument {
  scope: "global" | "profile";
  profileId?: ProfileId;
  content: string;
  revision: number;
  updatedAt: IsoDateTime;
}

/** Values and encrypted blobs are intentionally absent from all read models. */
export interface SecretMetadata {
  key: string;
  configured: boolean;
  updatedAt?: IsoDateTime;
}

export interface ChatSessionSummary {
  id: SessionId;
  profileId: ProfileId;
  title: string;
  activity: AgentActivity;
  /** `UNKNOWN_INVENTORY_TIMESTAMP` means the upstream field was absent. */
  createdAt: IsoDateTime;
  /** `UNKNOWN_INVENTORY_TIMESTAMP` means both update fields were absent. */
  updatedAt: IsoDateTime;
  lastMessagePreview?: string;
  /** Opaque Studio-generated grouping key derived from the Hermes workspace. */
  projectGroupId?: string;
  /** Safe basename shown for the workspace group; never contains the host path. */
  projectGroupName?: string;
  /** `delegated` identifies a durable specialist-profile worker conversation. */
  conversationKind?: "direct" | "delegated";
  delegationTaskId?: string;
  delegatedByProfileId?: ProfileId;
}

export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  id: MessageId;
  sessionId: SessionId;
  role: ChatRole;
  content: string;
  createdAt: IsoDateTime;
  status?: "streaming" | "complete" | "failed" | "cancelled";
}

export interface SendMessageRequest {
  sessionId: SessionId;
  content: string;
  clientMessageId: string;
}

export interface CreateSessionRequest {
  profileId: ProfileId;
  title?: string;
}

export type CardStatus = "backlog" | "ready" | "in-progress" | "blocked" | "done";

export interface KanbanBoardSummary {
  id: BoardId;
  name: string;
  cardCount: number;
  revision: number;
}

export interface KanbanCard {
  id: CardId;
  boardId: BoardId;
  title: string;
  description?: string;
  status: CardStatus;
  assigneeProfileId?: ProfileId;
  revision: number;
  updatedAt: IsoDateTime;
}

export interface KanbanComment {
  id: EntityId;
  cardId: CardId;
  authorProfileId?: ProfileId;
  authorDeviceId?: DeviceId;
  content: string;
  createdAt: IsoDateTime;
}

export interface CreateCardRequest {
  boardId: BoardId;
  title: string;
  description?: string;
  assigneeProfileId?: ProfileId;
}

export interface UpdateCardRequest {
  cardId: CardId;
  title?: string;
  description?: string;
  status?: CardStatus;
  assigneeProfileId?: ProfileId | null;
}

export interface AddCardCommentRequest {
  cardId: CardId;
  content: string;
}

/**
 * Office-owned team layer for skills and shared context.
 * Precedence when materializing into a Hermes profile:
 *   global ∪ enabled teams containing the profile
 * Profile-level skill toggles permanently override Office for that pair.
 * Each team's context is budgeted like global context; session seeds join
 * global + matching team contexts under one wire budget.
 */
export interface OfficeTeamSettings {
  revision: number;
  skillsEnabled: boolean;
  contextEnabled: boolean;
  skills: readonly string[];
  context: string;
  updatedAt: IsoDateTime;
}

/**
 * Office-owned metadata that groups Hermes profiles. Hermes remains the
 * canonical source for individual profiles and Kanban card assignment; teams
 * never write upstream kanban.db and never replace individual assignees.
 */
export interface OfficeTeam {
  id: TeamId;
  name: string;
  color: string;
  description?: string;
  leadProfileId?: ProfileId;
  memberProfileIds: readonly ProfileId[];
  /** Team-layer skills/context (middle inheritance tier between global and profile). */
  settings: OfficeTeamSettings;
  revision: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface UpdateTeamSettingsRequest {
  expectedRevision: number;
  skillsEnabled?: boolean;
  contextEnabled?: boolean;
  skills?: readonly string[];
  context?: string;
}

export interface CreateTeamRequest {
  name: string;
  color: string;
  description?: string;
  leadProfileId?: ProfileId | null;
  memberProfileIds?: readonly ProfileId[];
}

export interface UpdateTeamRequest {
  teamId: TeamId;
  expectedRevision: number;
  name?: string;
  color?: string;
  description?: string | null;
  leadProfileId?: ProfileId | null;
  memberProfileIds?: readonly ProfileId[];
}

export interface CreateProfileRequest {
  displayName: string;
  avatarKey: string;
  model?: string;
}

export interface UpdateProfileRequest {
  profileId: ProfileId;
  displayName?: string;
  avatarKey?: string;
  model?: string | null;
  systemPrompt?: string | null;
  memoryMode?: InheritanceMode;
  skillMode?: InheritanceMode;
}

export interface UpdateMemoryRequest {
  scope: "global" | "profile";
  profileId?: ProfileId;
  content: string;
}

export interface SetSkillEnabledRequest {
  profileId?: ProfileId;
  skillId: SkillId;
  enabled: boolean;
}

export interface UpdateGlobalSettingsRequest {
  defaultModel?: string | null;
  sharedContextEnabled?: boolean;
  sharedSkillsEnabled?: boolean;
}

/** One main/sub model selection used by the Studio chat composer. */
export interface ChatModelPreferenceSlot {
  provider: string;
  model: string;
  /** Empty means the selected model's default reasoning effort. */
  reasoningEffort: string;
}

/** Named main/sub pairing shared by every client connected to this Studio host. */
export interface ChatModelPreferencePreset {
  id: string;
  name: string;
  main: ChatModelPreferenceSlot;
  sub: ChatModelPreferenceSlot;
}

export interface ChatModelPreferencesDocument {
  main: ChatModelPreferenceSlot;
  sub: ChatModelPreferenceSlot;
  presets: ChatModelPreferencePreset[];
  activePresetId?: string;
}

export interface ChatModelPreferencesSnapshot {
  revision: number;
  document: ChatModelPreferencesDocument;
  updatedAt: IsoDateTime;
}

export interface UpdateChatModelPreferencesRequest {
  expectedRevision: number;
  document: ChatModelPreferencesDocument;
}

/** Dotted-leaf patch for schema-driven safe Hermes profile config. */
export interface UpdateProfileConfigRequest {
  profileId: ProfileId;
  expectedRevision: string;
  /** Field id → value map; only Office-safe leaves accepted. */
  changes: Record<string, boolean | number | string | ReadonlyArray<boolean | number | string>>;
}

/** Dotted-leaf patch for privileged non-secret Hermes profile config. */
export interface UpdatePrivilegedProfileConfigRequest {
  profileId: ProfileId;
  expectedRevision: string;
  changes: Record<string, boolean | number | string | ReadonlyArray<string> | unknown>;
}

/** Consume a desktop-native one-shot secret transfer (metadata only on wire). */
export interface WriteSecretTransferRequest {
  profileId: ProfileId;
  key: string;
  transferId: string;
  source: "env" | "config" | "memory-provider";
  /** Required when source is memory-provider; validated provider id only. */
  provider?: string;
  expectedRevision?: string;
}

export interface ConfigureRuntimeRequest {
  mode: RuntimeMode;
  /** Accepted only through a verified local-native session. */
  executablePath?: string;
  endpoint?: string;
}

export type HostAppPhase = "available" | "installing" | "installed" | "blocked" | "failed" | "unsupported";
export type HostAppFailure = "homebrew_missing" | "unsupported_platform" | "install_failed" | "install_timeout";

/** Safe, bounded host-side application status exposed to authenticated clients. */
export interface HostAppStatus {
  id: "obsidian";
  name: "Obsidian";
  phase: HostAppPhase;
  installed: boolean;
  canInstall: boolean;
  installMethod: "homebrew-cask";
  failure?: HostAppFailure;
}

export interface ObsidianVaultSummary {
  id: string;
  name: string;
}

export interface ObsidianGraphNode {
  id: string;
  title: string;
  folder: string;
  links: number;
}

export interface ObsidianGraphEdge {
  source: string;
  target: string;
}

/** Bounded, content-free note graph. Note bodies and absolute paths are absent. */
export interface ObsidianGraph {
  vaultId: string;
  vaultName: string;
  generatedAt: IsoDateTime;
  truncated: boolean;
  nodes: readonly ObsidianGraphNode[];
  edges: readonly ObsidianGraphEdge[];
}

export type HermesAgentUpdatePhase =
  | "checking"
  | "up_to_date"
  | "available"
  | "updating"
  | "updated"
  | "blocked"
  | "failed"
  | "unsupported";

export type HermesAgentUpdateFailure =
  | "executable_missing"
  | "check_failed"
  | "update_failed"
  | "update_timeout"
  | "unsupported_install";

/** Safe, bounded Hermes Agent update status. No paths or process output. */
export interface HermesAgentUpdateStatus {
  phase: HermesAgentUpdatePhase;
  canUpdate: boolean;
  updateMethod: "hermes-update";
  currentVersion?: string;
  failure?: HermesAgentUpdateFailure;
}

export interface OperationPayloadMap {
  "chat.session.create": CreateSessionRequest;
  "chat.session.archive": { sessionId: SessionId };
  "chat.message.send": SendMessageRequest;
  "chat.run.cancel": { sessionId: SessionId };
  "chat.approval.permanent": { sessionId: SessionId };
  "kanban.card.create": CreateCardRequest;
  "kanban.card.update": UpdateCardRequest;
  "kanban.card.comment": AddCardCommentRequest;
  "team.create": CreateTeamRequest;
  "team.update": UpdateTeamRequest;
  "team.delete": { teamId: TeamId; expectedRevision?: number };
  "profile.create": CreateProfileRequest;
  "profile.update": UpdateProfileRequest;
  "profile.delete": { profileId: ProfileId };
  "memory.update": UpdateMemoryRequest;
  "skill.enable": SetSkillEnabledRequest;
  "skill.install": { source: string; expectedDigest?: string };
  "global-settings.update": UpdateGlobalSettingsRequest;
  "chat-model-preferences.update": UpdateChatModelPreferencesRequest;
  "local-model-providers.sync": { profileId: ProfileId };
  "profile-config.update": UpdateProfileConfigRequest;
  "privileged-config.read": { profileId: ProfileId };
  "privileged-config.update": UpdatePrivilegedProfileConfigRequest;
  "host-app.install": { appId: "obsidian" };
  "host-fs.open": { path: string; action: "open" | "reveal" };
  "hermes-agent.update": Record<string, never>;
  "runtime.start": Record<string, never>;
  "runtime.stop": Record<string, never>;
  "runtime.configure": ConfigureRuntimeRequest;
  /** Secret bytes travel through a separate native one-shot channel. */
  "secret.write": WriteSecretTransferRequest;
  "device.revoke": { deviceId: DeviceId };
}

/** Mutation operations are exactly those with a transport payload contract. */
export type MutationOperation = keyof OperationPayloadMap;

export interface MutationRequest<TOperation extends keyof OperationPayloadMap> {
  requestId: string;
  operation: TOperation;
  payload: OperationPayloadMap[TOperation];
  idempotencyKey: string;
  expectedRevision?: number;
}

export type AnyMutationRequest = {
  [TOperation in MutationOperation]: MutationRequest<TOperation>;
}[MutationOperation];

export interface MutationAccepted<TResult> {
  requestId: string;
  acceptedAt: IsoDateTime;
  result: TResult;
}

export type EventTopic =
  | "runtime.status"
  | "profile.changed"
  | "session.changed"
  | "message.delta"
  | "message.completed"
  | "agent.activity"
  | "kanban.changed"
  | "access.changed"
  | "resync.required";

/**
 * Every stream is ordered by server sequence. Clients resume with the last
 * observed sequence and fetch a fresh snapshot after `resync.required`.
 */
export interface EventEnvelope<TPayload = unknown> {
  protocolVersion: ProtocolVersion;
  eventId: EventId;
  topic: EventTopic;
  sequence: number;
  occurredAt: IsoDateTime;
  aggregateId?: EntityId;
  aggregateRevision?: number;
  correlationId?: string;
  payload: TPayload;
}

export interface MessageDelta {
  sessionId: SessionId;
  messageId: MessageId;
  delta: string;
}

export interface AgentActivityChanged {
  profileId: ProfileId;
  sessionId?: SessionId;
  activity: AgentActivity;
  detail?: string;
}

export type ErrorCode =
  | "bad_request"
  | "unauthenticated"
  | "forbidden"
  | "step_up_required"
  | "local_only"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "runtime_unavailable"
  | "runtime_incompatible"
  | "internal_error";

export interface ProtocolError {
  code: ErrorCode;
  message: string;
  requestId?: string;
  retryable: boolean;
  retryAfterMs?: number;
  currentRevision?: number;
}

export interface AuditRecord {
  id: EntityId;
  occurredAt: IsoDateTime;
  operation: Operation;
  outcome: "allowed" | "denied" | "failed";
  deviceId: DeviceId;
  actorSubject: string;
  targetId?: EntityId;
  requestId?: string;
  detail?: string;
}
