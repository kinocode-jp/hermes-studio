import type { IncomingMessage } from "node:http";
import {
  GLOBAL_SETTINGS_MAX_REQUEST_UTF8_BYTES,
  GLOBAL_SETTINGS_MAX_SKILLS,
  isGlobalContextWithinBudget,
  PRIVILEGED_CONFIG_MAX_REQUEST_UTF8_BYTES,
  PROFILE_CONFIG_MAX_REQUEST_UTF8_BYTES,
  SECRET_TRANSFER_ID_PATTERN,
} from "@hermes-studio/protocol";
import type {
  HermesSettingsAdapter,
  OfficeGlobalSettingsStore,
} from "./hermes-settings.js";
import { HermesSettingsError } from "./hermes-settings.js";
import type { HermesProjectsAdapter } from "./hermes-projects.js";
import type { GlobalInheritanceCoordinator } from "./global-inheritance.js";
import type { OfficeAgentBehaviorStore, SharedSubagentCandidate, SubagentMode } from "./office-agent-behavior.js";
import type { HermesConfigValue } from "./hermes-config.js";
import type { HermesPrivilegedConfigValue } from "./hermes-privileged-config.js";
import type { SecretTransferStore } from "./secret-transfer.js";
import { SecretTransferError } from "./secret-transfer.js";
import {
  ChatModelPreferencesError,
  type OfficeChatModelPreferencesStore,
  validateChatModelPreferencesDocument,
} from "./chat-model-preferences.js";

export interface SettingsHttpDependencies {
  /** Required for Hermes profile/global routes; not for Studio-owned standalone settings. */
  settings?: HermesSettingsAdapter;
  globalSettings?: OfficeGlobalSettingsStore;
  globalInheritance?: GlobalInheritanceCoordinator;
  agentBehavior?: OfficeAgentBehaviorStore;
  /** Official per-profile Hermes Projects (gateway `projects.*` proxy). */
  projects?: HermesProjectsAdapter;
  /** One-shot secret transfer store (owner privileged sessions only). */
  secretTransfers?: SecretTransferStore;
  /** Studio-owned model selection shared across desktop and remote clients. */
  chatModelPreferences?: OfficeChatModelPreferencesStore;
  /**
   * True when authorize already established an owner privileged-settings session
   * (local owner, or remote owner when HERMES_STUDIO_REMOTE_PRIVILEGED is on).
   * Server-derived only — never from client headers.
   */
  privilegedOwnerSession?: boolean;
}

export interface SettingsHttpResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  changed?: {
    kind: "global" | "memory" | "skill" | "soul" | "agent-behavior" | "config" | "privileged-config" | "secret" | "projects" | "chat-model-preferences";
    profile?: string;
    id?: string;
    /** Metadata-only: category or change count — never field names for secrets, never values. */
    count?: number;
    category?: string;
  };
}

export function isSettingsHttpPath(pathname: string): boolean {
  return pathname === "/api/v1/settings/global"
    || pathname === "/api/v1/settings/chat-model-preferences"
    || pathname === "/api/v1/secret-transfers"
    || /^\/api\/v1\/profiles\/[^/]+\/(?:settings|skills|soul|memory|agent-behavior|config|privileged-config|secrets|projects)(?:\/|$)/.test(pathname);
}

export function isSettingsMutation(method: string | undefined): boolean {
  return method === "PATCH" || method === "POST" || method === "PUT" || method === "DELETE";
}

export async function routeSettingsHttp(
  request: IncomingMessage,
  url: URL,
  dependencies: SettingsHttpDependencies,
  maxBodyBytes: number,
): Promise<SettingsHttpResult> {
  try {
    // One-shot secret deposit: owner privileged session only (desktop native or
    // authenticated remote owner HTTPS). Value never returned or logged.
    if (url.pathname === "/api/v1/secret-transfers") {
      const denied = requirePrivilegedOwner(dependencies);
      if (denied) return denied;
      if (request.method !== "POST") return methodNotAllowed("POST");
      if (dependencies.secretTransfers === undefined) {
        return { status: 503, body: { error: { code: "runtime_unavailable", message: "Secret transfer is unavailable." } } };
      }
      const body = await readObject(request, Math.min(maxBodyBytes, 16 * 1024));
      assertOnlyKeys(body, ["value"]);
      try {
        const deposited = dependencies.secretTransfers.deposit(body.value);
        // Response: transferId + expiry only — never echo the secret.
        return ok({ transferId: deposited.transferId, expiresAt: deposited.expiresAt });
      } catch (error) {
        if (error instanceof SecretTransferError) {
          return secretTransferErrorResult(error);
        }
        throw error;
      }
    }

    if (url.pathname === "/api/v1/settings/global") {
      if (dependencies.globalSettings === undefined) {
        return { status: 503, body: { error: { code: "runtime_unavailable", message: "Hermes settings are unavailable." } } };
      }
      if (request.method === "GET") return ok(await (dependencies.globalInheritance?.read() ?? dependencies.globalSettings.read()));
      if (request.method === "PATCH") {
        const body = await readObject(request, Math.min(maxBodyBytes, GLOBAL_SETTINGS_MAX_REQUEST_UTF8_BYTES));
        assertOnlyKeys(body, ["expectedRevision", "sharedSkillsEnabled", "sharedContextEnabled", "skills", "context"]);
        const update = {
          expectedRevision: requiredInteger(body.expectedRevision, "expectedRevision", 0),
          ...(body.sharedSkillsEnabled === undefined ? {} : { sharedSkillsEnabled: requiredBoolean(body.sharedSkillsEnabled, "sharedSkillsEnabled") }),
          ...(body.sharedContextEnabled === undefined ? {} : { sharedContextEnabled: requiredBoolean(body.sharedContextEnabled, "sharedContextEnabled") }),
          ...(body.skills === undefined ? {} : { skills: requiredStringArray(body.skills, "skills", GLOBAL_SETTINGS_MAX_SKILLS) }),
          ...(body.context === undefined ? {} : { context: requiredGlobalContext(body.context) }),
        };
        const updated = dependencies.globalInheritance === undefined
          ? await dependencies.globalSettings.update(update)
          : await dependencies.globalInheritance.update(update);
        return { ...ok(updated), changed: { kind: "global" } };
      }
      return methodNotAllowed("GET, PATCH");
    }

    if (url.pathname === "/api/v1/settings/chat-model-preferences") {
      if (dependencies.chatModelPreferences === undefined) {
        return { status: 503, body: { error: { code: "storage_unavailable", message: "Chat model preferences are unavailable." } } };
      }
      if (request.method === "GET") return ok(await dependencies.chatModelPreferences.read());
      if (request.method === "PUT") {
        const body = await readObject(request, Math.min(maxBodyBytes, 64 * 1024));
        assertOnlyKeys(body, ["expectedRevision", "document"]);
        const updated = await dependencies.chatModelPreferences.update({
          expectedRevision: requiredInteger(body.expectedRevision, "expectedRevision", 0),
          document: validateChatModelPreferencesDocument(body.document),
        });
        return { ...ok(updated), changed: { kind: "chat-model-preferences" } };
      }
      return methodNotAllowed("GET, PUT");
    }

    const segments = decodeSegments(url.pathname);
    if (segments.length < 5 || segments[0] !== "api" || segments[1] !== "v1" || segments[2] !== "profiles") return notFound();
    if (dependencies.settings === undefined) {
      return { status: 503, body: { error: { code: "runtime_unavailable", message: "Hermes settings are unavailable." } } };
    }
    const settings = dependencies.settings;
    const profile = segments[3]!;
    const resource = segments[4]!;

    if (resource === "settings" && segments.length === 5) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return ok(await settings.getProfileSettings(profile));
    }

    if (resource === "skills") {
      if (segments.length === 5) {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return ok(await settings.listSkills(profile));
      }
      const skill = segments[5]!;
      if (segments.length === 6) {
        if (request.method !== "PATCH") return methodNotAllowed("PATCH");
        const body = await readObject(request, maxBodyBytes);
        assertOnlyKeys(body, ["enabled", "expectedEnabled"]);
        const enabled = requiredBoolean(body.enabled, "enabled");
        const expectedEnabled = requiredBoolean(body.expectedEnabled, "expectedEnabled");
        const mutation = async (): Promise<void> =>
          await settings.setSkillEnabled(profile, skill, enabled, expectedEnabled);
        if (dependencies.globalInheritance === undefined) await mutation();
        else await dependencies.globalInheritance.applyProfileSkillOverride(profile, skill, enabled, expectedEnabled, mutation);
        return { ...ok({ ok: true, name: skill, enabled }), changed: { kind: "skill", profile, id: skill } };
      }
      if (segments.length === 7 && segments[6] === "content") {
        if (request.method === "GET") return ok(await settings.getSkillContent(profile, skill));
        if (request.method === "PUT") {
          const body = await readObject(request, maxBodyBytes);
          assertOnlyKeys(body, ["content", "expectedRevision"]);
          const updated = await settings.updateSkillContent(
            profile,
            skill,
            requiredString(body.content, "content", 512 * 1024, true),
            requiredRevision(body.expectedRevision),
          );
          return { ...ok(updated), changed: { kind: "skill", profile, id: skill } };
        }
        return methodNotAllowed("GET, PUT");
      }
      return notFound();
    }

    if (resource === "soul" && segments.length === 5) {
      if (request.method === "GET") return ok(await settings.getProfileSoul(profile));
      if (request.method === "PUT") {
        const body = await readObject(request, maxBodyBytes);
        assertOnlyKeys(body, ["content", "expectedRevision"]);
        const updated = await settings.updateProfileSoul(
          profile,
          requiredString(body.content, "content", 256 * 1024, true),
          requiredRevision(body.expectedRevision),
        );
        return { ...ok(updated), changed: { kind: "soul", profile } };
      }
      return methodNotAllowed("GET, PUT");
    }

    if (resource === "agent-behavior" && segments.length === 5) {
      if (dependencies.agentBehavior === undefined) {
        return { status: 503, body: { error: { code: "runtime_unavailable", message: "Agent behavior settings are unavailable." } } };
      }
      if (request.method === "GET") return ok(await dependencies.agentBehavior.read(profile));
      if (request.method === "PUT") {
        const body = await readObject(request, maxBodyBytes);
        assertOnlyKeys(body, ["expectedRevision", "expectedSharedRevision", "subagentMode", "preferredSubagent", "preferredCandidateIds", "sharedCandidates"]);
        const updated = await dependencies.agentBehavior.update(profile, {
          expectedRevision: requiredInteger(body.expectedRevision, "expectedRevision", 0),
          ...(body.expectedSharedRevision === undefined ? {} : {
            expectedSharedRevision: requiredInteger(body.expectedSharedRevision, "expectedSharedRevision", 0),
          }),
          ...(body.subagentMode === undefined ? {} : { subagentMode: requiredSubagentMode(body.subagentMode) }),
          ...(body.preferredSubagent === undefined ? {} : { preferredSubagent: requiredString(body.preferredSubagent, "preferredSubagent", 128, true) }),
          ...(body.preferredCandidateIds === undefined ? {} : { preferredCandidateIds: requiredStringArray(body.preferredCandidateIds, "preferredCandidateIds", 3) }),
          ...(body.sharedCandidates === undefined ? {} : { sharedCandidates: requiredSharedSubagentCandidates(body.sharedCandidates) }),
        });
        return { ...ok(updated), changed: { kind: "agent-behavior", profile } };
      }
      return methodNotAllowed("GET, PUT");
    }

    if (resource === "projects") {
      // Official per-profile Hermes Projects (folders bound to named workspaces).
      // GET stays on state.read; mutations fall through to profile.update policy.
      if (dependencies.projects === undefined) {
        return { status: 503, body: { error: { code: "runtime_unavailable", message: "Hermes projects are unavailable." } } };
      }
      const projectsApi = dependencies.projects;
      if (segments.length === 5) {
        if (request.method === "GET") return ok(await projectsApi.listProjects(profile));
        if (request.method === "POST") {
          const body = await readObject(request, Math.min(maxBodyBytes, 16 * 1024));
          assertOnlyKeys(body, ["name", "path", "label", "isPrimary"]);
          const created = await projectsApi.createProject(profile, {
            name: requiredString(body.name, "name", 200),
            ...(body.path === undefined ? {} : { path: requiredProjectPath(body.path, "path") }),
            ...(body.label === undefined ? {} : { label: requiredString(body.label, "label", 200) }),
            ...(body.isPrimary === undefined ? {} : { isPrimary: requiredBoolean(body.isPrimary, "isPrimary") }),
          });
          return { ...ok(created), changed: { kind: "projects", profile } };
        }
        return methodNotAllowed("GET, POST");
      }
      const projectId = requiredProjectId(segments[5]);
      if (segments.length === 6) {
        if (request.method === "PATCH") {
          const body = await readObject(request, Math.min(maxBodyBytes, 4 * 1024));
          assertOnlyKeys(body, ["name"]);
          const updated = await projectsApi.updateProject(profile, projectId, {
            name: requiredString(body.name, "name", 200),
          });
          return { ...ok(updated), changed: { kind: "projects", profile, id: projectId } };
        }
        if (request.method === "DELETE") {
          return { ...ok(await projectsApi.deleteProject(profile, projectId)), changed: { kind: "projects", profile, id: projectId } };
        }
        return methodNotAllowed("PATCH, DELETE");
      }
      if (segments.length === 7 && segments[6] === "folders") {
        if (request.method === "POST") {
          const body = await readObject(request, Math.min(maxBodyBytes, 16 * 1024));
          assertOnlyKeys(body, ["path", "label", "isPrimary"]);
          const updated = await projectsApi.addFolder(profile, projectId, {
            path: requiredProjectPath(body.path, "path"),
            ...(body.label === undefined ? {} : { label: requiredString(body.label, "label", 200) }),
            ...(body.isPrimary === undefined ? {} : { isPrimary: requiredBoolean(body.isPrimary, "isPrimary") }),
          });
          return { ...ok(updated), changed: { kind: "projects", profile, id: projectId } };
        }
        if (request.method === "DELETE") {
          const body = await readObject(request, Math.min(maxBodyBytes, 16 * 1024));
          assertOnlyKeys(body, ["path"]);
          const updated = await projectsApi.removeFolder(profile, projectId, requiredProjectPath(body.path, "path"));
          return { ...ok(updated), changed: { kind: "projects", profile, id: projectId } };
        }
        return methodNotAllowed("POST, DELETE");
      }
      return notFound();
    }

    if (resource === "config") {
      // Schema-driven safe Hermes config. GET stays on state.read; PATCH uses
      // profile-config.update (manager + step-up-required). Bodies never accept
      // raw YAML or full root objects.
      if (segments.length === 6 && segments[5] === "schema") {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return ok(await settings.getProfileConfigSchema(profile));
      }
      if (segments.length === 5) {
        if (request.method === "GET") return ok(await settings.getProfileConfig(profile));
        if (request.method === "PATCH") {
          const body = await readObject(request, Math.min(maxBodyBytes, PROFILE_CONFIG_MAX_REQUEST_UTF8_BYTES));
          assertOnlyKeys(body, ["expectedRevision", "changes"]);
          const updated = await settings.updateProfileConfig(profile, {
            expectedRevision: requiredRevision(body.expectedRevision),
            changes: requiredConfigChanges(body.changes),
          });
          // Event payload: kind + profile only — never field names or values.
          return { ...ok(updated), changed: { kind: "config", profile } };
        }
        return methodNotAllowed("GET, PATCH");
      }
      return notFound();
    }

    if (resource === "privileged-config" && segments.length === 5) {
      // Owner privileged session (local owner, or remote owner when flag enabled).
      const denied = requirePrivilegedOwner(dependencies);
      if (denied) return denied;
      if (request.method === "GET") {
        return ok(await settings.getPrivilegedProfileConfig(profile));
      }
      if (request.method === "PATCH") {
        const body = await readObject(request, Math.min(maxBodyBytes, PRIVILEGED_CONFIG_MAX_REQUEST_UTF8_BYTES));
        assertOnlyKeys(body, ["expectedRevision", "changes", "confirmed"]);
        const changes = requiredPrivilegedConfigChanges(body.changes);
        // confirmed is required when any change targets a destructive/restart leaf.
        // The adapter re-validates field membership; here we only shape-check.
        if (body.confirmed !== undefined && body.confirmed !== true) {
          throw fieldError("confirmed");
        }
        const updated = await settings.updatePrivilegedProfileConfig(profile, {
          expectedRevision: requiredRevision(body.expectedRevision),
          changes,
          ...(body.confirmed === true ? { confirmed: true } : {}),
        });
        // Metadata-only event: kind, profile, change count — never field names/values.
        return {
          ...ok(updated),
          changed: { kind: "privileged-config", profile, count: Object.keys(changes).length },
        };
      }
      return methodNotAllowed("GET, PATCH");
    }

    if (resource === "secrets" && segments.length === 5) {
      const denied = requirePrivilegedOwner(dependencies);
      if (denied) return denied;
      if (request.method === "GET") {
        // Metadata only — never secret values.
        return ok(await settings.listProfileSecrets(profile));
      }
      if (request.method === "POST") {
        // Browser carries transferId + field metadata only. Secret bytes were
        // deposited by the desktop-native bridge and are consumed here once.
        if (dependencies.secretTransfers === undefined) {
          return { status: 503, body: { error: { code: "runtime_unavailable", message: "Secret transfer is unavailable." } } };
        }
        const body = await readObject(request, Math.min(maxBodyBytes, 4_096));
        assertOnlyKeys(body, ["transferId", "key", "source", "provider", "expectedRevision"]);
        const transferId = requiredTransferId(body.transferId);
        const source = requiredSecretSource(body.source);
        const key = requiredSecretKeyWire(body.key, source);
        const provider = source === "memory-provider"
          ? requiredMemoryProviderId(body.provider)
          : undefined;
        if (source === "memory-provider" && provider === undefined) throw fieldError("provider");
        if (source !== "memory-provider" && body.provider !== undefined) throw fieldError("provider");
        let secretValue: string;
        try {
          secretValue = dependencies.secretTransfers.consume(transferId);
        } catch (error) {
          if (error instanceof SecretTransferError) {
            return secretTransferErrorResult(error);
          }
          throw error;
        }
        try {
          const updated = await settings.writeProfileSecret(profile, {
            key,
            source,
            value: secretValue,
            ...(provider === undefined ? {} : { provider }),
            ...(body.expectedRevision === undefined ? {} : { expectedRevision: requiredRevision(body.expectedRevision) }),
          });
          // Never include key/provider names for secret audit/events — kind + profile + count only.
          return { ...ok(updated), changed: { kind: "secret", profile, count: 1 } };
        } finally {
          // Best-effort clear of the local binding (string immutability limits zeroize).
          secretValue = "";
        }
      }
      return methodNotAllowed("GET, POST");
    }

    if (resource === "memory") {
      if (segments.length === 5) {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return ok(await settings.getMemoryStatus(profile));
      }
      if (segments.length === 6 && segments[5] === "provider") {
        if (request.method !== "PUT") return methodNotAllowed("PUT");
        const body = await readObject(request, maxBodyBytes);
        assertOnlyKeys(body, ["provider", "expectedProvider"]);
        const provider = requiredString(body.provider, "provider", 64, true);
        const updated = await settings.setMemoryProvider(profile, provider, requiredString(body.expectedProvider, "expectedProvider", 64, true));
        return { ...ok(updated), changed: { kind: "memory", profile } };
      }
      if (segments.length === 6 && segments[5] === "files") {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return ok(await settings.getBuiltinMemoryFiles(profile));
      }
      if (segments.length === 7 && segments[5] === "files") {
        const fileKey = requiredMemoryFileKey(segments[6]);
        if (request.method === "GET") {
          const files = await settings.getBuiltinMemoryFiles(profile);
          return ok(fileKey === "memory" ? files.memory : files.user);
        }
        if (request.method === "PUT") {
          const body = await readObject(request, maxBodyBytes);
          assertOnlyKeys(body, ["content", "expectedRevision"]);
          const updated = await settings.updateBuiltinMemoryFile(
            profile,
            fileKey,
            requiredString(body.content, "content", 256 * 1024, true),
            requiredRevision(body.expectedRevision),
          );
          return { ...ok(updated), changed: { kind: "memory", profile, id: fileKey } };
        }
        return methodNotAllowed("GET, PUT");
      }
      if (segments.length === 6 && segments[5] === "reset") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const body = await readObject(request, maxBodyBytes);
        assertOnlyKeys(body, ["target"]);
        const target = requiredMemoryResetTarget(body.target);
        const updated = await settings.resetBuiltinMemory(profile, target);
        return {
          ...ok({
            ok: true,
            target,
            files: updated.files,
            status: updated.status,
          }),
          changed: { kind: "memory", profile, id: `reset:${target}` },
        };
      }
      if (segments.length === 7 && segments[5] === "providers") {
        const provider = segments[6]!;
        if (request.method === "GET") return ok(await settings.getMemoryProviderConfig(profile, provider));
        if (request.method === "PATCH") {
          const body = await readObject(request, maxBodyBytes);
          assertOnlyKeys(body, ["values", "expectedRevision"]);
          const updated = await settings.updateMemoryProviderConfig(
            profile,
            provider,
            requiredSettingsValues(body.values),
            requiredRevision(body.expectedRevision),
          );
          return { ...ok(updated), changed: { kind: "memory", profile, id: provider } };
        }
        return methodNotAllowed("GET, PATCH");
      }
      // Secret provider fields and setup/install commands remain out of the
      // remote-safe Office contract.
      return notFound();
    }

    return notFound();
  } catch (error) {
    if (error instanceof HttpInputError) return { status: error.status, body: { error: { code: error.code, message: error.message } } };
    if (error instanceof ChatModelPreferencesError) return chatModelPreferencesError(error);
    if (error instanceof HermesSettingsError) return settingsError(error);
    return { status: 502, body: { error: { code: "runtime_unavailable", message: "Hermes settings are unavailable." } } };
  }
}

async function readObject(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers["content-type"] ?? ""))) throw new HttpInputError(415, "unsupported_media_type", "Content-Type must be application/json.");
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) { request.resume(); throw new HttpInputError(413, "body_too_large", "Request body is too large."); }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) throw new HttpInputError(413, "body_too_large", "Request body is too large.");
    chunks.push(bytes);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpInputError(400, "invalid_json", "Request body must be valid JSON."); }
  if (!isRecord(value)) throw new HttpInputError(400, "invalid_body", "Request body must be an object.");
  return value;
}

function decodeSegments(pathname: string): string[] {
  try { return pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment)); }
  catch { throw new HttpInputError(400, "invalid_path", "Request path is invalid."); }
}

function assertOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new HttpInputError(400, "invalid_body", "Request contains unsupported fields.");
}

function requiredBoolean(value: unknown, name: string): boolean { if (typeof value !== "boolean") throw fieldError(name); return value; }
function requiredInteger(value: unknown, name: string, min: number): number { if (typeof value !== "number" || !Number.isInteger(value) || value < min) throw fieldError(name); return value; }
function requiredString(value: unknown, name: string, maxBytes: number, allowEmpty = false): string { if (typeof value !== "string" || (!allowEmpty && value.trim() === "") || value.includes("\0") || Buffer.byteLength(value) > maxBytes) throw fieldError(name); return value; }
function requiredSubagentMode(value: unknown): SubagentMode {
  if (value !== "auto" && value !== "manual") throw fieldError("subagentMode");
  return value;
}
function requiredGlobalContext(value: unknown): string { if (typeof value !== "string" || !isGlobalContextWithinBudget(value)) throw fieldError("context"); return value; }
function requiredRevision(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw fieldError("expectedRevision"); return value; }
function requiredStringArray(value: unknown, name: string, maxItems: number): string[] { if (!Array.isArray(value) || value.length > maxItems || !value.every((item) => typeof item === "string")) throw fieldError(name); return [...value] as string[]; }
function requiredSharedSubagentCandidates(value: unknown): SharedSubagentCandidate[] {
  if (!Array.isArray(value) || value.length > 32) throw fieldError("sharedCandidates");
  return value.map((item, index) => {
    if (!isRecord(item)) throw fieldError(`sharedCandidates.${index}`);
    assertOnlyKeys(item, ["id", "label", "provider", "model", "reasoningEffort", "enabled"]);
    const id = requiredString(item.id, `sharedCandidates.${index}.id`, 64);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw fieldError(`sharedCandidates.${index}.id`);
    return {
      id,
      label: requiredString(item.label, `sharedCandidates.${index}.label`, 128, true),
      provider: requiredString(item.provider, `sharedCandidates.${index}.provider`, 128, true),
      model: requiredString(item.model, `sharedCandidates.${index}.model`, 128, true),
      reasoningEffort: requiredString(item.reasoningEffort, `sharedCandidates.${index}.reasoningEffort`, 32, true),
      enabled: requiredBoolean(item.enabled, `sharedCandidates.${index}.enabled`),
    };
  });
}
function requiredSettingsValues(value: unknown): Record<string, boolean | string> { if (!isRecord(value) || Object.keys(value).length > 100) throw fieldError("values"); const result: Record<string, boolean | string> = {}; for (const [key, item] of Object.entries(value)) { if (typeof item !== "boolean" && typeof item !== "string") throw fieldError(`values.${key}`); result[key] = item; } return result; }
function requiredMemoryFileKey(value: string | undefined): "memory" | "user" {
  if (value === "memory" || value === "user") return value;
  throw new HttpInputError(404, "not_found", "Settings route was not found.");
}
function requiredMemoryResetTarget(value: unknown): "all" | "memory" | "user" {
  if (value === "all" || value === "memory" || value === "user") return value;
  throw fieldError("target");
}
/** Project ids are gateway-issued slugs/ids; bound length and reject control chars. */
function requiredProjectId(value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.length > 128 || value.includes("\0")) {
    throw new HttpInputError(404, "not_found", "Settings route was not found.");
  }
  return value;
}
/** Folder paths bound to a project; Hermes normalizes to absolute paths itself. */
function requiredProjectPath(value: unknown, name: string): string {
  return requiredString(value, name, 4 * 1024);
}
/** HTTP layer shape check only; adapter re-validates against schema + policy. */
function requiredConfigChanges(value: unknown): Record<string, HermesConfigValue> {
  if (!isRecord(value) || Object.keys(value).length === 0 || Object.keys(value).length > 100) throw fieldError("changes");
  const result: Record<string, HermesConfigValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof key !== "string" || key.length === 0 || key.length > 200 || key.includes("\0")) throw fieldError("changes");
    if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) {
      result[key] = item;
      continue;
    }
    if (typeof item === "string") {
      if (item.includes("\0") || Buffer.byteLength(item) > 8 * 1024) throw fieldError(`changes.${key}`);
      result[key] = item;
      continue;
    }
    if (Array.isArray(item)) {
      // Advanced Config list contract is string rows only (no silent coercion).
      if (item.length > 64) throw fieldError(`changes.${key}`);
      const list: string[] = [];
      for (const entry of item) {
        if (typeof entry === "string" && !entry.includes("\0") && Buffer.byteLength(entry) <= 2 * 1024) {
          list.push(entry);
          continue;
        }
        throw fieldError(`changes.${key}`);
      }
      result[key] = list;
      continue;
    }
    throw fieldError(`changes.${key}`);
  }
  return result;
}

/**
 * Privileged changes may include bounded JSON leaves (objects / nested lists).
 * Adapter re-validates against live privileged projection; no secret bytes here.
 */
function requiredPrivilegedConfigChanges(value: unknown): Record<string, HermesPrivilegedConfigValue> {
  if (!isRecord(value) || Object.keys(value).length === 0 || Object.keys(value).length > 100) throw fieldError("changes");
  const result: Record<string, HermesPrivilegedConfigValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof key !== "string" || key.length === 0 || key.length > 200 || key.includes("\0")) throw fieldError("changes");
    if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) {
      result[key] = item;
      continue;
    }
    if (typeof item === "string") {
      if (item.includes("\0") || Buffer.byteLength(item) > 8 * 1024) throw fieldError(`changes.${key}`);
      result[key] = item;
      continue;
    }
    if (Array.isArray(item) || (typeof item === "object" && item !== null)) {
      // Bound JSON wire size; deep validation happens in the adapter.
      const encoded = JSON.stringify(item);
      if (Buffer.byteLength(encoded) > 16 * 1024) throw fieldError(`changes.${key}`);
      result[key] = item;
      continue;
    }
    throw fieldError(`changes.${key}`);
  }
  return result;
}

function requirePrivilegedOwner(dependencies: SettingsHttpDependencies): SettingsHttpResult | undefined {
  if (dependencies.privilegedOwnerSession) return undefined;
  return {
    status: 403,
    body: {
      error: {
        code: "forbidden",
        message: "Owner privileged access is required (local owner or Tailscale-authorized remote owner).",
      },
    },
  };
}

function secretTransferErrorResult(error: SecretTransferError): SettingsHttpResult {
  const status = error.code === "invalid_request" ? 400
    : error.code === "capacity" ? 429
      : error.code === "expired" || error.code === "not_found" ? 404
        : 400;
  return {
    status,
    body: {
      error: {
        code: error.code === "expired" ? "not_found" : error.code,
        message: error.message,
      },
    },
  };
}

function requiredTransferId(value: unknown): string {
  if (typeof value !== "string" || !SECRET_TRANSFER_ID_PATTERN.test(value)) throw fieldError("transferId");
  return value;
}

function requiredSecretSource(value: unknown): "env" | "config" | "memory-provider" {
  if (value !== "env" && value !== "config" && value !== "memory-provider") throw fieldError("source");
  return value;
}

function requiredMemoryProviderId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) || value === "builtin") {
    throw fieldError("provider");
  }
  return value;
}

function requiredSecretKeyWire(value: unknown, source: "env" | "config" | "memory-provider"): string {
  if (typeof value !== "string" || value.includes("\0") || value.length === 0 || value.length > 200) {
    throw fieldError("key");
  }
  if (source === "env") {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) throw fieldError("key");
    return value;
  }
  if (source === "memory-provider") {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw fieldError("key");
    return value;
  }
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}(?:\.[A-Za-z][A-Za-z0-9_]{0,63}){0,7}$/.test(value)) throw fieldError("key");
  return value;
}
function fieldError(name: string): HttpInputError { return new HttpInputError(400, "invalid_body", `${name} is invalid.`); }
function ok(body: unknown): SettingsHttpResult { return { status: 200, body }; }
function notFound(): SettingsHttpResult { return { status: 404, body: { error: { code: "not_found", message: "Settings route was not found." } } }; }
function methodNotAllowed(allow: string): SettingsHttpResult { return { status: 405, body: { error: { code: "method_not_allowed", message: "Method is not allowed." } }, headers: { Allow: allow } }; }
function settingsError(error: HermesSettingsError): SettingsHttpResult { const status = error.code === "conflict" || error.code === "commit_unconfirmed" ? 409 : error.code === "invalid_request" ? 400 : error.code === "not_found" ? 404 : error.code === "timed_out" ? 504 : 502; const code = error.code === "rejected" ? "runtime_unavailable" : error.code; return { status, body: { error: { code, message: error.message } } }; }
function chatModelPreferencesError(error: ChatModelPreferencesError): SettingsHttpResult { const status = error.code === "conflict" ? 409 : error.code === "invalid_request" ? 400 : 503; return { status, body: { error: { code: error.code, message: error.message } } }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

class HttpInputError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
