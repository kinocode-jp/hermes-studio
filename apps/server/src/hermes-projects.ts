import { WebSocket } from "ws";
import {
  HermesSettingsError,
  type HermesProfileBackendAccess,
  type HermesProfileBackendResolveOptions,
} from "./hermes-settings.js";

/**
 * Per-profile Hermes Projects (named workspaces binding folders/repos).
 *
 * Hermes exposes the official projects surface only as JSON-RPC methods
 * (`projects.*`) served by the gateway dispatcher. Each per-profile
 * `hermes serve` sidecar mounts that dispatcher at `/api/ws` (loopback token
 * auth), so this adapter opens a short-lived WebSocket per call, issues one
 * request, and closes — reusing the same profile-pinned backend leases as the
 * settings adapter. No local reimplementation of projects.db.
 */

export interface HermesProjectFolder {
  path: string;
  label: string | null;
  isPrimary: boolean;
  addedAt: number;
}

export interface HermesProject {
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
  folders: HermesProjectFolder[];
}

export interface HermesProjectsSnapshot {
  projects: HermesProject[];
  activeId: string | null;
}

export interface HermesProjectCreateInput {
  name: string;
  path?: string;
  label?: string;
  isPrimary?: boolean;
}

export interface HermesProjectFolderInput {
  path: string;
  label?: string;
  isPrimary?: boolean;
}

export interface HermesProjectsAdapter {
  listProjects(profile: string): Promise<HermesProjectsSnapshot>;
  createProject(profile: string, input: HermesProjectCreateInput): Promise<{ project: HermesProject | null }>;
  updateProject(profile: string, projectId: string, patch: { name: string }): Promise<{ project: HermesProject }>;
  deleteProject(profile: string, projectId: string): Promise<HermesProjectsSnapshot>;
  addFolder(profile: string, projectId: string, input: HermesProjectFolderInput): Promise<{ project: HermesProject }>;
  removeFolder(profile: string, projectId: string, path: string): Promise<{ project: HermesProject }>;
}

export interface HermesProjectsAdapterOptions {
  /** Must resolve a process whose HERMES_HOME is the requested profile. */
  resolveProfileBackend(profile: string, options?: HermesProfileBackendResolveOptions): Promise<HermesProfileBackendAccess>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_INBOUND_BYTES = 2 * 1024 * 1024;

// Gateway projects error codes (tui_gateway/server.py).
const E_NO_PROJECT = 5062;
const E_PROJECT_ARG = 5063;
const E_PROJECTS = 5061;

export function createHermesProjectsAdapter(options: HermesProjectsAdapterOptions): HermesProjectsAdapter {
  const timeoutMs = boundedTimeout(options.timeoutMs);

  async function call<T>(
    profile: string,
    method: string,
    params: Record<string, unknown>,
    decode: (value: unknown) => T,
  ): Promise<T> {
    const deadlineMs = Date.now() + timeoutMs;
    const mutation = method !== "projects.list";
    let backend: HermesProfileBackendAccess;
    try {
      backend = await resolveProfileBackendBeforeDeadline(profile, options.resolveProfileBackend, deadlineMs);
    } catch (error) {
      throw asProjectsError(error);
    }
    try {
      const value = await gatewayCall<unknown>(backend, method, params, deadlineMs, mutation);
      try {
        return decode(value);
      } catch (error) {
        if (mutation) throw commitUnconfirmed();
        throw error;
      }
    } catch (error) {
      throw asProjectsError(error);
    } finally {
      backend.release();
    }
  }

  return {
    async listProjects(profile) {
      return await call(profile, "projects.list", {}, validateSnapshot);
    },
    async createProject(profile, input) {
      const params: Record<string, unknown> = { name: input.name };
      if (input.path !== undefined && input.path.trim() !== "") {
        params.folders = [input.path];
        if (input.isPrimary === true) params.primary_path = input.path;
      }
      return await call(profile, "projects.create", params, (value) => ({ project: validateNullableProject(value) }));
    },
    async updateProject(profile, projectId, patch) {
      return await call(profile, "projects.update", { id: projectId, name: patch.name }, (value) => ({
        project: validateProject(unwrapRecord(value).project),
      }));
    },
    async deleteProject(profile, projectId) {
      return await call(profile, "projects.delete", { id: projectId }, validateSnapshot);
    },
    async addFolder(profile, projectId, input) {
      const params: Record<string, unknown> = { id: projectId, path: input.path, is_primary: input.isPrimary === true };
      if (input.label !== undefined && input.label.trim() !== "") params.label = input.label;
      return await call(profile, "projects.add_folder", params, (value) => ({
        project: validateProject(unwrapRecord(value).project),
      }));
    },
    async removeFolder(profile, projectId, path) {
      return await call(profile, "projects.remove_folder", { id: projectId, path }, (value) => ({
        project: validateProject(unwrapRecord(value).project),
      }));
    },
  };
}

/**
 * One JSON-RPC request over the per-profile sidecar `/api/ws`.
 *
 * Frames are newline-delimited JSON text messages (the server may coalesce
 * events into multi-line frames), so inbound text is buffered and split.
 */
async function gatewayCall<T>(
  backend: HermesProfileBackendAccess,
  method: string,
  params: Record<string, unknown>,
  deadlineMs: number,
  mutation: boolean,
): Promise<T> {
  const url = new URL("/api/ws", backend.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", backend.sessionToken);

  return await new Promise<T>((resolve, reject) => {
    const requestId = "projects-1";
    let socket: WebSocket | undefined;
    let settled = false;
    let opened = false;
    let dispatched = false;
    let inboundBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error: HermesSettingsError | null, value?: T): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      try { socket?.close(); } catch { /* closing a dead socket is best-effort */ }
      if (error !== null) reject(error);
      else resolve(value as T);
    };

    const fail = (error: HermesSettingsError): void => finish(error);
    const failTransport = (fallback: HermesSettingsError): void => {
      fail(mutation && dispatched ? commitUnconfirmed() : fallback);
    };

    const handleFrame = (frame: unknown): void => {
      if (!isRecord(frame)) return;
      if (frame.id !== requestId) return; // events and unrelated traffic
      if (isRecord(frame.error)) {
        fail(mapGatewayError(frame.error));
        return;
      }
      finish(null, frame.result as T);
    };

    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      fail(new HermesSettingsError("timed_out", "Hermes projects request timed out."));
      return;
    }
    timer = setTimeout(() => {
      failTransport(new HermesSettingsError("timed_out", "Hermes projects request timed out."));
    }, remainingMs);
    timer.unref();

    try {
      socket = new WebSocket(url);
    } catch {
      fail(new HermesSettingsError("rejected", "Hermes projects socket could not be created."));
      return;
    }

    socket.on("open", () => {
      opened = true;
      try {
        dispatched = true;
        socket?.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }));
      } catch {
        failTransport(new HermesSettingsError("rejected", "Hermes projects request could not be sent."));
      }
    });
    socket.on("message", (data: unknown) => {
      const text = typeof data === "string" ? data : String(data);
      inboundBytes += Buffer.byteLength(text);
      if (inboundBytes > MAX_INBOUND_BYTES) {
        failTransport(new HermesSettingsError("response_too_large", "Hermes projects response is too large."));
        return;
      }
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          handleFrame(JSON.parse(trimmed));
        } catch (error) {
          if (error instanceof HermesSettingsError) fail(error);
          // Malformed event lines are ignored; a malformed response simply
          // never matches the request id and the call times out.
        }
        if (settled) return;
      }
    });
    socket.on("error", () => {
      failTransport(new HermesSettingsError("rejected", "Hermes projects socket failed."));
    });
    socket.on("close", () => {
      if (!settled) {
        failTransport(new HermesSettingsError("rejected", opened
          ? "Hermes projects socket closed before a response arrived."
          : "Hermes projects socket was refused."));
      }
    });
  });
}

async function resolveProfileBackendBeforeDeadline(
  profile: string,
  resolveProfileBackend: HermesProjectsAdapterOptions["resolveProfileBackend"],
  deadlineMs: number,
): Promise<HermesProfileBackendAccess> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw projectsTimedOut();
  const timeoutError = projectsTimedOut();
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

function mapGatewayError(error: Record<string, unknown>): HermesSettingsError {
  const code = typeof error.code === "number" ? error.code : E_PROJECTS;
  if (code === E_NO_PROJECT) return new HermesSettingsError("not_found", "Hermes project was not found.");
  if (code === E_PROJECT_ARG) return new HermesSettingsError("invalid_request", "Hermes projects request is invalid.");
  return new HermesSettingsError("rejected", "Hermes projects request was rejected.");
}

function asProjectsError(error: unknown): HermesSettingsError {
  if (error instanceof HermesSettingsError) return error;
  return new HermesSettingsError("rejected", "Hermes projects are unavailable.");
}

function commitUnconfirmed(): HermesSettingsError {
  return new HermesSettingsError("commit_unconfirmed", "Hermes may have committed this project change; refresh before retrying.");
}

function projectsTimedOut(): HermesSettingsError {
  return new HermesSettingsError("timed_out", "Hermes projects request timed out.");
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(value), 1_000), 60_000);
}

function unwrapRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new HermesSettingsError("rejected", "Hermes projects response is incompatible.");
  return value;
}

function optionalNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new HermesSettingsError("rejected", "Hermes projects response is incompatible.");
  return value;
}

function validateFolder(value: unknown): HermesProjectFolder {
  if (!isRecord(value) || typeof value.path !== "string") {
    throw new HermesSettingsError("rejected", "Hermes projects response is incompatible.");
  }
  return {
    path: value.path,
    label: optionalNullableString(value.label),
    isPrimary: value.is_primary === true,
    addedAt: typeof value.added_at === "number" && Number.isFinite(value.added_at) ? value.added_at : 0,
  };
}

function validateProject(value: unknown): HermesProject {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    throw new HermesSettingsError("rejected", "Hermes projects response is incompatible.");
  }
  return {
    id: value.id,
    slug: typeof value.slug === "string" ? value.slug : "",
    name: value.name,
    description: optionalNullableString(value.description),
    icon: optionalNullableString(value.icon),
    color: optionalNullableString(value.color),
    boardSlug: optionalNullableString(value.board_slug),
    primaryPath: optionalNullableString(value.primary_path),
    archived: value.archived === true,
    createdAt: typeof value.created_at === "number" && Number.isFinite(value.created_at) ? value.created_at : 0,
    folders: Array.isArray(value.folders) ? value.folders.map(validateFolder) : [],
  };
}

function validateNullableProject(value: unknown): HermesProject | null {
  const record = unwrapRecord(value);
  if (record.project === null || record.project === undefined) return null;
  return validateProject(record.project);
}

function validateSnapshot(value: unknown): HermesProjectsSnapshot {
  const record = unwrapRecord(value);
  if (!Array.isArray(record.projects)) {
    throw new HermesSettingsError("rejected", "Hermes projects response is incompatible.");
  }
  return {
    projects: record.projects.map(validateProject),
    activeId: typeof record.active_id === "string" ? record.active_id : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
