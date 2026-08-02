import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import {
  GLOBAL_SETTINGS_MAX_SKILLS,
  isGlobalContextWithinBudget,
  type OfficeTeam,
  type OfficeTeamSettings,
  type ProfileId,
  type TeamId,
} from "@hermes-studio/protocol";
import { containsLikelySecret } from "./secret-scrubber.js";

const MAX_TEAMS = 64;
const MAX_MEMBERS = 64;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 500;
/** Teams document may include per-team context up to the global context budget. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const TEAM_ID_PATTERN = /^team-[a-f0-9]{24}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SCHEMA_VERSION = 1 as const;

export type OfficeTeamsErrorCode = "bad_request" | "not_found" | "conflict" | "storage";

export class OfficeTeamsError extends Error {
  constructor(
    readonly code: OfficeTeamsErrorCode,
    message: string,
    readonly currentRevision?: number,
  ) {
    super(message);
    this.name = "OfficeTeamsError";
  }
}

export interface CreateOfficeTeamInput {
  name: string;
  color: string;
  description?: string;
  leadProfileId?: ProfileId | null;
  memberProfileIds?: readonly ProfileId[];
}

export interface UpdateOfficeTeamInput {
  expectedRevision: number;
  name?: string;
  color?: string;
  description?: string | null;
  leadProfileId?: ProfileId | null;
  memberProfileIds?: readonly ProfileId[];
}

export interface UpdateOfficeTeamSettingsInput {
  expectedRevision: number;
  skillsEnabled?: boolean;
  contextEnabled?: boolean;
  skills?: readonly string[];
  context?: string;
}

/** Flattened team layer used by skill/context inheritance (global ∪ teams → profile). */
export interface OfficeTeamSkillLayer {
  teamId: TeamId;
  memberProfileIds: readonly ProfileId[];
  skillsEnabled: boolean;
  skills: readonly string[];
  contextEnabled: boolean;
  context: string;
}

export interface OfficeTeamsStoreOptions {
  /** Testable storage boundary; throwing leaves the previous atomic state intact. */
  beforeWrite?: (teams: readonly OfficeTeam[]) => Promise<void> | void;
}

interface StoredTeamsDocument {
  version: typeof SCHEMA_VERSION;
  teams: OfficeTeam[];
}

/**
 * Durable Office-owned teams. Many-to-many grouping of Hermes profile IDs.
 * Never writes Hermes Agent kanban.db or invents an upstream Hermes API.
 */
export class OfficeTeamsStore {
  readonly #filePath: string;
  readonly #options: OfficeTeamsStoreOptions;
  #queue: Promise<void> = Promise.resolve();

  constructor(filePath: string, options: OfficeTeamsStoreOptions = {}) {
    this.#filePath = normalizeTeamsPath(filePath);
    this.#options = options;
  }

  async list(): Promise<readonly OfficeTeam[]> {
    await this.#queue;
    return (await this.#readStateUnsafe()).teams.map(cloneTeam);
  }

  async get(teamId: string): Promise<OfficeTeam | undefined> {
    await this.#queue;
    const team = (await this.#readStateUnsafe()).teams.find((item) => item.id === teamId);
    return team === undefined ? undefined : cloneTeam(team);
  }

  async create(input: CreateOfficeTeamInput): Promise<OfficeTeam> {
    return await this.#mutate(async () => {
      const state = await this.#readStateUnsafe();
      if (state.teams.length >= MAX_TEAMS) {
        throw new OfficeTeamsError("bad_request", "The team limit has been reached.");
      }
      const now = new Date().toISOString();
      const leadProfileId = normalizeOptionalLead(input.leadProfileId);
      const members = normalizeMembers(input.memberProfileIds ?? []);
      if (leadProfileId !== undefined && !members.includes(leadProfileId)) members.push(leadProfileId);
      const description = normalizeOptionalDescription(input.description);
      const team = validateTeam({
        id: `team-${randomBytes(12).toString("hex")}`,
        name: requiredName(input.name),
        color: requiredColor(input.color),
        ...(description === undefined ? {} : { description }),
        ...(leadProfileId === undefined ? {} : { leadProfileId }),
        memberProfileIds: members,
        settings: defaultTeamSettings(now),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      await this.#writeState({ version: SCHEMA_VERSION, teams: [...state.teams, team] });
      return cloneTeam(team);
    });
  }

  async update(teamId: string, input: UpdateOfficeTeamInput): Promise<OfficeTeam> {
    return await this.#mutate(async () => {
      const state = await this.#readStateUnsafe();
      const index = state.teams.findIndex((item) => item.id === teamId);
      if (index < 0) throw new OfficeTeamsError("not_found", "Team was not found.");
      const current = state.teams[index]!;
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== current.revision) {
        throw new OfficeTeamsError("conflict", "Team changed; refresh before saving.", current.revision);
      }
      const nextMembers = input.memberProfileIds === undefined
        ? [...current.memberProfileIds]
        : normalizeMembers(input.memberProfileIds);
      let nextLead = current.leadProfileId;
      if (input.leadProfileId !== undefined) {
        nextLead = normalizeOptionalLead(input.leadProfileId);
      }
      if (nextLead !== undefined && !nextMembers.includes(nextLead)) {
        nextMembers.push(nextLead);
      }
      let nextDescription = current.description;
      if (input.description !== undefined) {
        nextDescription = input.description === null
          ? undefined
          : normalizeOptionalDescription(input.description);
      }
      const updated = validateTeam({
        id: current.id,
        name: input.name === undefined ? current.name : requiredName(input.name),
        color: input.color === undefined ? current.color : requiredColor(input.color),
        ...(nextDescription === undefined ? {} : { description: nextDescription }),
        ...(nextLead === undefined ? {} : { leadProfileId: nextLead }),
        memberProfileIds: nextMembers,
        settings: current.settings,
        revision: current.revision + 1,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      });
      const teams = [...state.teams];
      teams[index] = updated;
      await this.#writeState({ version: SCHEMA_VERSION, teams });
      return cloneTeam(updated);
    });
  }

  async getSettings(teamId: string): Promise<OfficeTeamSettings | undefined> {
    const team = await this.get(teamId);
    return team === undefined ? undefined : cloneSettings(team.settings);
  }

  /**
   * Revision-checked update of the team inheritance layer only.
   * Does not bump membership `revision`; uses independent `settings.revision`.
   */
  async updateSettings(teamId: string, input: UpdateOfficeTeamSettingsInput): Promise<OfficeTeamSettings> {
    return await this.#mutate(async () => {
      const state = await this.#readStateUnsafe();
      const index = state.teams.findIndex((item) => item.id === teamId);
      if (index < 0) throw new OfficeTeamsError("not_found", "Team was not found.");
      const current = state.teams[index]!;
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== current.settings.revision) {
        throw new OfficeTeamsError(
          "conflict",
          "Team settings changed; refresh before saving.",
          current.settings.revision,
        );
      }
      if (
        input.skillsEnabled === undefined
        && input.contextEnabled === undefined
        && input.skills === undefined
        && input.context === undefined
      ) {
        throw new OfficeTeamsError("bad_request", "At least one team settings field is required.");
      }
      const nextSettings = validateTeamSettings({
        revision: current.settings.revision + 1,
        skillsEnabled: input.skillsEnabled ?? current.settings.skillsEnabled,
        contextEnabled: input.contextEnabled ?? current.settings.contextEnabled,
        skills: input.skills === undefined ? current.settings.skills : input.skills,
        context: input.context === undefined ? current.settings.context : input.context,
        updatedAt: new Date().toISOString(),
      });
      const updated = validateTeam({
        ...current,
        settings: nextSettings,
        updatedAt: nextSettings.updatedAt,
      });
      const teams = [...state.teams];
      teams[index] = updated;
      await this.#writeState({ version: SCHEMA_VERSION, teams });
      return cloneSettings(nextSettings);
    });
  }

  /** Snapshot of every team layer for skill/context materialization. */
  async listSkillLayers(): Promise<readonly OfficeTeamSkillLayer[]> {
    const teams = await this.list();
    return teams.map((team) => ({
      teamId: team.id,
      memberProfileIds: [...team.memberProfileIds],
      skillsEnabled: team.settings.skillsEnabled,
      skills: [...team.settings.skills],
      contextEnabled: team.settings.contextEnabled,
      context: team.settings.context,
    }));
  }

  /**
   * Deletes a team. Returns true when a row was removed.
   * Missing IDs return false so HTTP can expose clear 404 semantics.
   * Optional expectedRevision yields 409 when the row still exists but is stale.
   */
  async delete(teamId: string, expectedRevision?: number): Promise<boolean> {
    return await this.#mutate(async () => {
      const state = await this.#readStateUnsafe();
      const current = state.teams.find((item) => item.id === teamId);
      if (current === undefined) return false;
      if (expectedRevision !== undefined
        && (!Number.isInteger(expectedRevision) || expectedRevision !== current.revision)) {
        throw new OfficeTeamsError("conflict", "Team changed; refresh before deleting.", current.revision);
      }
      await this.#writeState({
        version: SCHEMA_VERSION,
        teams: state.teams.filter((item) => item.id !== teamId),
      });
      return true;
    });
  }

  async #readStateUnsafe(): Promise<StoredTeamsDocument> {
    try {
      const info = await stat(this.#filePath);
      if (!info.isFile()) throw new OfficeTeamsError("storage", "Teams storage path is not a regular file.");
      if (info.size > MAX_FILE_BYTES) throw new OfficeTeamsError("storage", "Teams storage file is too large.");
      const text = await readFile(this.#filePath, "utf8");
      if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
        throw new OfficeTeamsError("storage", "Teams storage file is too large.");
      }
      return validateDocument(JSON.parse(text) as unknown);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { version: SCHEMA_VERSION, teams: [] };
      if (error instanceof OfficeTeamsError) throw error;
      if (error instanceof SyntaxError) {
        throw new OfficeTeamsError("storage", "Teams storage is malformed and was not loaded.");
      }
      throw new OfficeTeamsError("storage", "Teams could not be read.");
    }
  }

  async #writeState(document: StoredTeamsDocument): Promise<void> {
    const validated = validateDocument(document);
    await this.#options.beforeWrite?.(validated.teams);
    await atomicWriteJson(this.#filePath, validated);
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return await result;
  }
}

export function normalizeTeamsPath(value: string): string {
  if (!isAbsolute(value) || value.includes("\0") || value.trim() === "" || value.length > 4_096) {
    throw new Error("Teams storage path must be an absolute safe path.");
  }
  return value;
}

function validateDocument(value: unknown): StoredTeamsDocument {
  if (!isRecord(value)) throw new OfficeTeamsError("storage", "Teams storage is malformed.");
  if (value.version !== SCHEMA_VERSION) {
    throw new OfficeTeamsError("storage", "Teams storage version is unsupported.");
  }
  if (!Array.isArray(value.teams)) throw new OfficeTeamsError("storage", "Teams storage is malformed.");
  if (value.teams.length > MAX_TEAMS) throw new OfficeTeamsError("storage", "Teams storage exceeds the team limit.");
  const teams = value.teams.map((item) => validateTeam(item));
  if (new Set(teams.map((team) => team.id)).size !== teams.length) {
    throw new OfficeTeamsError("storage", "Teams storage contains duplicate identifiers.");
  }
  return { version: SCHEMA_VERSION, teams };
}

function validateTeam(value: unknown): OfficeTeam & { memberProfileIds: ProfileId[] } {
  if (!isRecord(value)) throw invalid("Team is invalid.");
  if (typeof value.id !== "string" || !TEAM_ID_PATTERN.test(value.id)) throw invalid("Team identifier is invalid.");
  if (typeof value.name !== "string") throw invalid("Team name is invalid.");
  if (typeof value.color !== "string" || !COLOR_PATTERN.test(value.color)) throw invalid("Team color is invalid.");
  if (!Number.isInteger(value.revision) || (value.revision as number) < 1) throw invalid("Team revision is invalid.");
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    throw invalid("Team createdAt is invalid.");
  }
  if (typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))) {
    throw invalid("Team updatedAt is invalid.");
  }
  if (!Array.isArray(value.memberProfileIds)) throw invalid("Team members are invalid.");
  const memberProfileIds = normalizeMembers(value.memberProfileIds);
  const description = value.description === undefined
    ? undefined
    : normalizeOptionalDescription(value.description as string);
  const leadProfileId = value.leadProfileId === undefined
    ? undefined
    : requiredProfileId(value.leadProfileId, "leadProfileId");
  if (leadProfileId !== undefined && !memberProfileIds.includes(leadProfileId)) {
    throw invalid("Team lead must be a member.");
  }
  // Missing settings (older durable docs) materialize to defaults so schema v1 stays readable.
  const settings = value.settings === undefined
    ? defaultTeamSettings(value.updatedAt)
    : validateTeamSettings(value.settings);
  return {
    id: value.id as TeamId,
    name: requiredName(value.name),
    color: requiredColor(value.color),
    ...(description === undefined ? {} : { description }),
    ...(leadProfileId === undefined ? {} : { leadProfileId }),
    memberProfileIds,
    settings,
    revision: value.revision as number,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function validateTeamSettings(value: unknown): OfficeTeamSettings {
  if (!isRecord(value)) throw invalid("Team settings are invalid.");
  if (!Number.isInteger(value.revision) || (value.revision as number) < 0) {
    throw invalid("Team settings revision is invalid.");
  }
  if (typeof value.skillsEnabled !== "boolean" || typeof value.contextEnabled !== "boolean") {
    throw invalid("Team settings toggles are invalid.");
  }
  if (!Array.isArray(value.skills)) throw invalid("Team skills are invalid.");
  if (typeof value.context !== "string") throw invalid("Team context is invalid.");
  if (typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))) {
    throw invalid("Team settings updatedAt is invalid.");
  }
  const skills = value.skills.map((item) => requiredSkillName(item));
  if (skills.length > GLOBAL_SETTINGS_MAX_SKILLS || new Set(skills).size !== skills.length) {
    throw invalid("Team skill selection is invalid.");
  }
  if (!isGlobalContextWithinBudget(value.context) || containsLikelySecret(value.context)) {
    throw invalid("Team context is invalid, too large, or contains a possible secret.");
  }
  return {
    revision: value.revision as number,
    skillsEnabled: value.skillsEnabled,
    contextEnabled: value.contextEnabled,
    skills,
    context: value.context,
    updatedAt: value.updatedAt,
  };
}

function defaultTeamSettings(updatedAt: string): OfficeTeamSettings {
  return {
    revision: 0,
    skillsEnabled: true,
    contextEnabled: true,
    skills: [],
    context: "",
    updatedAt,
  };
}

function requiredSkillName(value: unknown): string {
  if (typeof value !== "string" || !SKILL_NAME_PATTERN.test(value)) {
    throw invalid("Team skill name is invalid.");
  }
  return value;
}

function requiredName(value: unknown): string {
  if (typeof value !== "string") throw invalid("Team name is required.");
  const name = value.trim();
  if (name.length < 1 || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
    throw invalid("Team name must be 1 to 64 visible characters.");
  }
  return name;
}

function requiredColor(value: unknown): string {
  if (typeof value !== "string" || !COLOR_PATTERN.test(value)) {
    throw invalid("Team color must be a #RRGGBB hex value.");
  }
  return value.toLowerCase();
}

function normalizeOptionalDescription(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalid("Team description must be a string.");
  const description = value.trim();
  if (description.length === 0) return undefined;
  if (description.length > MAX_DESCRIPTION_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(description)) {
    throw invalid("Team description is invalid or too long.");
  }
  return description;
}

function normalizeOptionalLead(value: unknown): ProfileId | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredProfileId(value, "leadProfileId");
}

function normalizeMembers(value: readonly unknown[]): ProfileId[] {
  if (value.length > MAX_MEMBERS) throw invalid("A team may include at most 64 members.");
  const members = value.map((item) => requiredProfileId(item, "memberProfileIds"));
  if (new Set(members).size !== members.length) throw invalid("Team members must be unique.");
  return members;
}

function requiredProfileId(value: unknown, field: string): ProfileId {
  if (typeof value !== "string" || !PROFILE_PATTERN.test(value)) {
    throw invalid(`${field} must be a valid Hermes profile identifier.`);
  }
  return value;
}

function cloneTeam(team: OfficeTeam): OfficeTeam {
  return {
    id: team.id,
    name: team.name,
    color: team.color,
    ...(team.description === undefined ? {} : { description: team.description }),
    ...(team.leadProfileId === undefined ? {} : { leadProfileId: team.leadProfileId }),
    memberProfileIds: [...team.memberProfileIds],
    settings: cloneSettings(team.settings),
    revision: team.revision,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

function cloneSettings(settings: OfficeTeamSettings): OfficeTeamSettings {
  return {
    revision: settings.revision,
    skillsEnabled: settings.skillsEnabled,
    contextEnabled: settings.contextEnabled,
    skills: [...settings.skills],
    context: settings.context,
    updatedAt: settings.updatedAt,
  };
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      const body = `${JSON.stringify(value)}\n`;
      if (Buffer.byteLength(body, "utf8") > MAX_FILE_BYTES) {
        throw new OfficeTeamsError("bad_request", "Teams document exceeds the storage size limit.");
      }
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
    await chmod(filePath, 0o600).catch(() => undefined);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof OfficeTeamsError) throw error;
    throw new OfficeTeamsError("storage", "Teams could not be saved.");
  }
}

function invalid(message: string): OfficeTeamsError {
  return new OfficeTeamsError("bad_request", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
