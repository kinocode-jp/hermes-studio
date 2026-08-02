import type { IncomingMessage } from "node:http";
import {
  GLOBAL_SETTINGS_MAX_REQUEST_UTF8_BYTES,
  GLOBAL_SETTINGS_MAX_SKILLS,
  isGlobalContextWithinBudget,
  type ProtocolError,
} from "@hermes-studio/protocol";
import type { GlobalInheritanceCoordinator } from "./global-inheritance.js";
import {
  OfficeTeamsError,
  type CreateOfficeTeamInput,
  type OfficeTeamsStore,
  type UpdateOfficeTeamInput,
  type UpdateOfficeTeamSettingsInput,
} from "./office-teams.js";
import { HermesSettingsError } from "./hermes-settings.js";

const OFFICE_TEAMS_PATH = "/api/v1/teams";
const MAX_TEAMS_BODY_BYTES = 32 * 1024;

export interface TeamsHttpResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface TeamsHttpDependencies {
  store: OfficeTeamsStore;
  globalInheritance?: GlobalInheritanceCoordinator;
}

export function isTeamsHttpPath(pathname: string): boolean {
  return pathname === OFFICE_TEAMS_PATH || pathname.startsWith(`${OFFICE_TEAMS_PATH}/`);
}

export function isTeamsMutation(method: string | undefined): boolean {
  return method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";
}

export async function routeTeamsHttp(
  request: IncomingMessage,
  requestUrl: URL,
  storeOrDeps: OfficeTeamsStore | TeamsHttpDependencies,
  maxJsonBytes: number,
): Promise<TeamsHttpResult> {
  const deps: TeamsHttpDependencies = isTeamsStore(storeOrDeps)
    ? { store: storeOrDeps }
    : storeOrDeps;
  const store = deps.store;

  try {
    validateQuery(requestUrl, []);

    if (request.method === "GET" && requestUrl.pathname === OFFICE_TEAMS_PATH) {
      if (requestHasBody(request)) {
        request.resume();
        throw badRequest("GET request bodies are not accepted.");
      }
      const teams = await store.list();
      return { status: 200, body: { teams } };
    }

    if (request.method === "POST" && requestUrl.pathname === OFFICE_TEAMS_PATH) {
      const raw = await readJsonObject(request, Math.min(MAX_TEAMS_BODY_BYTES, maxJsonBytes));
      assertKeys(raw, ["name", "color", "description", "leadProfileId", "memberProfileIds"]);
      if (!("name" in raw)) throw badRequest("name is required.");
      if (!("color" in raw)) throw badRequest("color is required.");
      const input: CreateOfficeTeamInput = {
        name: raw.name as string,
        color: raw.color as string,
        ...(raw.description === undefined ? {} : { description: raw.description as string }),
        ...(raw.leadProfileId === undefined ? {} : { leadProfileId: raw.leadProfileId as string | null }),
        ...(raw.memberProfileIds === undefined
          ? {}
          : { memberProfileIds: asStringArray(raw.memberProfileIds, "memberProfileIds") }),
      };
      const team = await store.create(input);
      return { status: 201, body: team };
    }

    const settingsMatch = /^\/api\/v1\/teams\/([^/]+)\/settings$/.exec(requestUrl.pathname);
    if (settingsMatch !== null) {
      const teamId = decodePathSegment(settingsMatch[1]!);
      return await routeTeamSettings(request, store, teamId, deps.globalInheritance, maxJsonBytes);
    }

    const detailMatch = /^\/api\/v1\/teams\/([^/]+)$/.exec(requestUrl.pathname);
    if (detailMatch === null) {
      return { status: 404, body: protocolError("not_found", "Teams route not found.") };
    }

    const teamId = decodePathSegment(detailMatch[1]!);

    if (request.method === "GET") {
      if (requestHasBody(request)) {
        request.resume();
        throw badRequest("GET request bodies are not accepted.");
      }
      const team = await store.get(teamId);
      if (team === undefined) return { status: 404, body: protocolError("not_found", "Team was not found.") };
      return { status: 200, body: team };
    }

    if (request.method === "PATCH") {
      const raw = await readJsonObject(request, Math.min(MAX_TEAMS_BODY_BYTES, maxJsonBytes));
      assertKeys(raw, ["expectedRevision", "name", "color", "description", "leadProfileId", "memberProfileIds"]);
      if (!("expectedRevision" in raw)) throw badRequest("expectedRevision is required.");
      if (!Number.isInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 1) {
        throw badRequest("expectedRevision must be a positive integer.");
      }
      const hasUpdate = "name" in raw || "color" in raw || "description" in raw
        || "leadProfileId" in raw || "memberProfileIds" in raw;
      if (!hasUpdate) throw badRequest("At least one mutable field is required.");
      const membersChanged = "memberProfileIds" in raw || "leadProfileId" in raw;
      const input: UpdateOfficeTeamInput = {
        expectedRevision: raw.expectedRevision as number,
        ...(raw.name === undefined ? {} : { name: raw.name as string }),
        ...(raw.color === undefined ? {} : { color: raw.color as string }),
        ...(raw.description === undefined ? {} : { description: raw.description as string | null }),
        ...(raw.leadProfileId === undefined ? {} : { leadProfileId: raw.leadProfileId as string | null }),
        ...(raw.memberProfileIds === undefined
          ? {}
          : { memberProfileIds: asStringArray(raw.memberProfileIds, "memberProfileIds") }),
      };
      const team = await store.update(teamId, input);
      if (membersChanged) await rematerializeQuietly(deps.globalInheritance);
      return { status: 200, body: team };
    }

    if (request.method === "DELETE") {
      // Empty DELETE body is allowed; a JSON body may carry expectedRevision only.
      let expectedRevision: number | undefined;
      if (requestHasBody(request)) {
        const raw = await readJsonObject(request, Math.min(MAX_TEAMS_BODY_BYTES, maxJsonBytes));
        assertKeys(raw, ["expectedRevision"]);
        if ("expectedRevision" in raw) {
          if (!Number.isInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 1) {
            throw badRequest("expectedRevision must be a positive integer.");
          }
          expectedRevision = raw.expectedRevision as number;
        }
      }
      const removed = await store.delete(teamId, expectedRevision);
      if (!removed) return { status: 404, body: protocolError("not_found", "Team was not found.") };
      await rematerializeQuietly(deps.globalInheritance);
      return { status: 200, body: { ok: true, id: teamId } };
    }

    return {
      status: 405,
      body: protocolError("bad_request", "Method not allowed."),
      headers: { Allow: allowedMethods(requestUrl.pathname) },
    };
  } catch (error) {
    return errorResult(error);
  }
}

async function routeTeamSettings(
  request: IncomingMessage,
  store: OfficeTeamsStore,
  teamId: string,
  inheritance: GlobalInheritanceCoordinator | undefined,
  maxJsonBytes: number,
): Promise<TeamsHttpResult> {
  if (request.method === "GET") {
    if (requestHasBody(request)) {
      request.resume();
      throw badRequest("GET request bodies are not accepted.");
    }
    const settings = await store.getSettings(teamId);
    if (settings === undefined) return { status: 404, body: protocolError("not_found", "Team was not found.") };
    return { status: 200, body: settings };
  }

  if (request.method === "PUT") {
    const raw = await readJsonObject(request, Math.min(maxJsonBytes, GLOBAL_SETTINGS_MAX_REQUEST_UTF8_BYTES));
    assertKeys(raw, ["expectedRevision", "skillsEnabled", "contextEnabled", "skills", "context"]);
    if (!("expectedRevision" in raw)) throw badRequest("expectedRevision is required.");
    if (!Number.isInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 0) {
      throw badRequest("expectedRevision must be a non-negative integer.");
    }
    const hasUpdate = "skillsEnabled" in raw || "contextEnabled" in raw || "skills" in raw || "context" in raw;
    if (!hasUpdate) throw badRequest("At least one team settings field is required.");
    if ("context" in raw) {
      if (typeof raw.context !== "string") throw badRequest("context must be a string.");
      if (!isGlobalContextWithinBudget(raw.context as string)) {
        throw badRequest("Team context exceeds the shared context budget.");
      }
    }
    if ("skills" in raw) {
      asStringArray(raw.skills, "skills");
      if ((raw.skills as unknown[]).length > GLOBAL_SETTINGS_MAX_SKILLS) {
        throw badRequest(`skills may include at most ${GLOBAL_SETTINGS_MAX_SKILLS} entries.`);
      }
    }
    const input: UpdateOfficeTeamSettingsInput = {
      expectedRevision: raw.expectedRevision as number,
      ...(raw.skillsEnabled === undefined ? {} : { skillsEnabled: requiredBoolean(raw.skillsEnabled, "skillsEnabled") }),
      ...(raw.contextEnabled === undefined ? {} : { contextEnabled: requiredBoolean(raw.contextEnabled, "contextEnabled") }),
      ...(raw.skills === undefined ? {} : { skills: asStringArray(raw.skills, "skills") }),
      ...(raw.context === undefined ? {} : { context: raw.context as string }),
    };
    const settings = await store.updateSettings(teamId, input);
    if (inheritance !== undefined) {
      try {
        await inheritance.rematerializeSkills();
      } catch (error) {
        if (error instanceof HermesSettingsError && error.code === "rejected") {
          // Settings are durable; skill sync may still be pending — surface for retry.
          return {
            status: 502,
            body: {
              ...settings,
              skillSync: { state: "pending" as const, message: error.message },
            },
          };
        }
        throw error;
      }
    }
    return { status: 200, body: settings };
  }

  return {
    status: 405,
    body: protocolError("bad_request", "Method not allowed."),
    headers: { Allow: "GET, PUT" },
  };
}

async function rematerializeQuietly(inheritance: GlobalInheritanceCoordinator | undefined): Promise<void> {
  if (inheritance === undefined) return;
  try {
    await inheritance.rematerializeSkills();
  } catch {
    // Membership/settings already saved; skill sync can be retried via global or team settings save.
  }
}

function errorResult(error: unknown): TeamsHttpResult {
  if (error instanceof BodyTooLargeError) {
    return { status: 413, body: protocolError("bad_request", "Teams request body is too large.") };
  }
  if (error instanceof RequestBodyError) {
    return { status: 400, body: protocolError("bad_request", error.message) };
  }
  if (error instanceof OfficeTeamsError) {
    if (error.code === "not_found") return { status: 404, body: protocolError("not_found", error.message) };
    if (error.code === "conflict") {
      const body: ProtocolError = {
        code: "conflict",
        message: error.message,
        retryable: false,
        ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }),
      };
      return { status: 409, body };
    }
    if (error.code === "storage") {
      return { status: 500, body: protocolError("internal_error", "Teams storage is unavailable.") };
    }
    return { status: 400, body: protocolError("bad_request", error.message) };
  }
  if (error instanceof HermesSettingsError) {
    if (error.code === "conflict") return { status: 409, body: protocolError("conflict", error.message) };
    if (error.code === "invalid_request") return { status: 400, body: protocolError("bad_request", error.message) };
    return { status: 502, body: protocolError("runtime_unavailable", error.message, true) };
  }
  return { status: 500, body: protocolError("internal_error", "Teams request failed.") };
}

async function readJsonObject(request: IncomingMessage, maxJsonBytes: number): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw badRequest("Content-Type must be application/json.");
  const limit = maxJsonBytes;
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0) throw badRequest("Content-Length is invalid.");
    if (size > limit) {
      request.resume();
      throw new BodyTooLargeError();
    }
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > limit) {
      request.resume();
      throw new BodyTooLargeError();
    }
    chunks.push(buffer);
  }
  if (size === 0) throw badRequest("A JSON request body is required.");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw badRequest(`${field} must be an array of strings.`);
  }
  return value as string[];
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw badRequest(`${field} must be a boolean.`);
  return value;
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw badRequest(`Unknown field: ${unknown}.`);
}

function validateQuery(url: URL, allowed: readonly string[]): void {
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    if (!allowed.includes(key) || seen.has(key)) throw badRequest("Teams query parameters are invalid.");
    seen.add(key);
  }
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw badRequest("Team identifier is malformed.");
  }
}

function allowedMethods(pathname: string): string {
  if (pathname === OFFICE_TEAMS_PATH) return "GET, POST";
  if (/^\/api\/v1\/teams\/[^/]+\/settings$/.test(pathname)) return "GET, PUT";
  if (/^\/api\/v1\/teams\/[^/]+$/.test(pathname)) return "GET, PATCH, DELETE";
  return "GET";
}

function requestHasBody(request: IncomingMessage): boolean {
  if (request.headers["transfer-encoding"] !== undefined) return true;
  const declaredLength = request.headers["content-length"];
  if (declaredLength === undefined) return false;
  const length = Number(declaredLength);
  return !Number.isSafeInteger(length) || length > 0;
}

function protocolError(code: ProtocolError["code"], message: string, retryable = false): ProtocolError {
  return { code, message, retryable };
}

function badRequest(message: string): RequestBodyError {
  return new RequestBodyError(message);
}

function isTeamsStore(value: OfficeTeamsStore | TeamsHttpDependencies): value is OfficeTeamsStore {
  // Dependencies always nest the store under `.store`; the store itself does not.
  return !("store" in value);
}

class RequestBodyError extends Error {}
class BodyTooLargeError extends Error {}
