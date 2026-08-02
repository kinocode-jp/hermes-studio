import type { OfficeTeam, OfficeTeamSettings } from "@hermes-studio/protocol";
import {
  GLOBAL_SETTINGS_MAX_SKILLS,
  isGlobalContextWithinBudget,
} from "@hermes-studio/protocol";
import { OfficeHttpError, officeFetchJson } from "./office-api";

export type TeamsListResult = { teams: OfficeTeam[] };

export type CreateTeamInput = {
  name: string;
  color: string;
  description?: string;
  leadProfileId?: string | null;
  memberProfileIds?: readonly string[];
};

export type UpdateTeamInput = {
  expectedRevision: number;
  name?: string;
  color?: string;
  description?: string | null;
  leadProfileId?: string | null;
  memberProfileIds?: readonly string[];
};

export type UpdateTeamSettingsInput = {
  expectedRevision: number;
  skillsEnabled?: boolean;
  contextEnabled?: boolean;
  skills?: readonly string[];
  context?: string;
};

export type TeamsApi = {
  list(): Promise<TeamsListResult>;
  create(input: CreateTeamInput): Promise<OfficeTeam>;
  update(teamId: string, input: UpdateTeamInput): Promise<OfficeTeam>;
  updateSettings(teamId: string, input: UpdateTeamSettingsInput): Promise<OfficeTeamSettings>;
  remove(teamId: string, expectedRevision?: number): Promise<void>;
};

const MAX_TEAMS = 64;
const TEAM_ID_PATTERN = /^team-[a-f0-9]{24}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class TeamsMutationFailure extends Error {
  constructor(
    readonly kind: "rejected" | "conflict" | "commit-unknown",
    cause?: unknown,
  ) {
    super(
      kind === "conflict" ? "Team changed elsewhere; refresh and try again."
        : kind === "commit-unknown"
          ? "The team change may have been saved, but its result could not be confirmed."
          : errorMessage(cause),
      { cause },
    );
    this.name = "TeamsMutationFailure";
  }
}

export function createTeamsApi(): TeamsApi {
  return {
    async list() {
      const value = await officeFetchJson<unknown>("/api/v1/teams", { timeoutMs: 8_000 });
      return normalizeList(value);
    },
    async create(input) {
      try {
        const value = await officeFetchJson<unknown>("/api/v1/teams", {
          method: "POST",
          body: input,
          timeoutMs: 8_000,
        });
        return normalizeTeam(value);
      } catch (error) {
        throw asMutationFailure(error);
      }
    },
    async update(teamId, input) {
      try {
        const value = await officeFetchJson<unknown>(`/api/v1/teams/${encodeURIComponent(teamId)}`, {
          method: "PATCH",
          body: input,
          timeoutMs: 8_000,
        });
        return normalizeTeam(value);
      } catch (error) {
        throw asMutationFailure(error);
      }
    },
    async updateSettings(teamId, input) {
      try {
        const value = await officeFetchJson<unknown>(
          `/api/v1/teams/${encodeURIComponent(teamId)}/settings`,
          {
            method: "PUT",
            body: input,
            timeoutMs: 15_000,
          },
        );
        return normalizeTeamSettings(value);
      } catch (error) {
        throw asMutationFailure(error);
      }
    },
    async remove(teamId, expectedRevision) {
      try {
        await officeFetchJson<unknown>(`/api/v1/teams/${encodeURIComponent(teamId)}`, {
          method: "DELETE",
          ...(expectedRevision === undefined
            ? {}
            : { body: { expectedRevision } }),
          timeoutMs: 8_000,
        });
      } catch (error) {
        throw asMutationFailure(error);
      }
    },
  };
}

export function createDemoTeamsApi(seed: readonly OfficeTeam[]): TeamsApi {
  let teams = seed.map(cloneTeam);
  let next = 1;
  return {
    async list() {
      return { teams: teams.map(cloneTeam) };
    },
    async create(input) {
      const now = new Date().toISOString();
      let id = `team-${next.toString(16).padStart(24, "0")}`;
      next += 1;
      while (teams.some((team) => team.id === id)) {
        id = `team-${next.toString(16).padStart(24, "0")}`;
        next += 1;
      }
      const lead = input.leadProfileId ?? undefined;
      const members = [...(input.memberProfileIds ?? [])];
      if (typeof lead === "string" && !members.includes(lead)) members.push(lead);
      const team: OfficeTeam = {
        id,
        name: input.name.trim(),
        color: input.color.toLowerCase(),
        ...(input.description?.trim() ? { description: input.description.trim() } : {}),
        ...(typeof lead === "string" ? { leadProfileId: lead } : {}),
        memberProfileIds: members,
        settings: defaultTeamSettings(now),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      teams = [...teams, team];
      return cloneTeam(team);
    },
    async update(teamId, input) {
      const current = teams.find((team) => team.id === teamId);
      if (!current) throw new TeamsMutationFailure("rejected", new Error("Team was not found."));
      if (current.revision !== input.expectedRevision) {
        throw new TeamsMutationFailure("conflict");
      }
      const members = input.memberProfileIds === undefined
        ? [...current.memberProfileIds]
        : [...input.memberProfileIds];
      let lead = current.leadProfileId;
      if (input.leadProfileId !== undefined) {
        lead = input.leadProfileId === null ? undefined : input.leadProfileId;
      }
      if (lead !== undefined && !members.includes(lead)) members.push(lead);
      let description = current.description;
      if (input.description !== undefined) {
        description = input.description === null || input.description.trim() === ""
          ? undefined
          : input.description.trim();
      }
      const updated: OfficeTeam = {
        id: current.id,
        name: input.name === undefined ? current.name : input.name.trim(),
        color: input.color === undefined ? current.color : input.color.toLowerCase(),
        ...(description === undefined ? {} : { description }),
        ...(lead === undefined ? {} : { leadProfileId: lead }),
        memberProfileIds: members,
        settings: cloneSettings(current.settings),
        revision: current.revision + 1,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      };
      teams = teams.map((team) => team.id === teamId ? updated : team);
      return cloneTeam(updated);
    },
    async updateSettings(teamId, input) {
      const current = teams.find((team) => team.id === teamId);
      if (!current) throw new TeamsMutationFailure("rejected", new Error("Team was not found."));
      if (current.settings.revision !== input.expectedRevision) {
        throw new TeamsMutationFailure("conflict");
      }
      const skills = input.skills === undefined ? [...current.settings.skills] : [...input.skills];
      if (skills.length > GLOBAL_SETTINGS_MAX_SKILLS || new Set(skills).size !== skills.length) {
        throw new TeamsMutationFailure("rejected", new Error("Team skill selection is invalid."));
      }
      const context = input.context === undefined ? current.settings.context : input.context;
      if (!isGlobalContextWithinBudget(context)) {
        throw new TeamsMutationFailure("rejected", new Error("Team context exceeds budget."));
      }
      const now = new Date().toISOString();
      const settings: OfficeTeamSettings = {
        revision: current.settings.revision + 1,
        skillsEnabled: input.skillsEnabled ?? current.settings.skillsEnabled,
        contextEnabled: input.contextEnabled ?? current.settings.contextEnabled,
        skills,
        context,
        updatedAt: now,
      };
      teams = teams.map((team) => team.id === teamId
        ? { ...cloneTeam(team), settings: cloneSettings(settings), updatedAt: now }
        : team);
      return cloneSettings(settings);
    },
    async remove(teamId, expectedRevision) {
      const current = teams.find((team) => team.id === teamId);
      if (!current) throw new TeamsMutationFailure("rejected", new Error("Team was not found."));
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new TeamsMutationFailure("conflict");
      }
      teams = teams.filter((team) => team.id !== teamId);
    },
  };
}

function normalizeList(value: unknown): TeamsListResult {
  if (!value || typeof value !== "object" || !Array.isArray((value as { teams?: unknown }).teams)) {
    throw new Error("Studio Server returned an incompatible teams list.");
  }
  const teams = (value as { teams: unknown[] }).teams.slice(0, MAX_TEAMS).map(normalizeTeam);
  return { teams };
}

function normalizeTeam(value: unknown): OfficeTeam {
  if (!value || typeof value !== "object") throw new Error("Studio Server returned an incompatible team.");
  const team = value as Record<string, unknown>;
  if (typeof team.id !== "string" || !TEAM_ID_PATTERN.test(team.id)) {
    throw new Error("Studio Server returned an incompatible team identifier.");
  }
  if (typeof team.name !== "string" || team.name.length < 1 || team.name.length > 64) {
    throw new Error("Studio Server returned an incompatible team name.");
  }
  if (typeof team.color !== "string" || !COLOR_PATTERN.test(team.color)) {
    throw new Error("Studio Server returned an incompatible team color.");
  }
  if (!Number.isInteger(team.revision) || (team.revision as number) < 1) {
    throw new Error("Studio Server returned an incompatible team revision.");
  }
  if (typeof team.createdAt !== "string" || typeof team.updatedAt !== "string") {
    throw new Error("Studio Server returned incompatible team timestamps.");
  }
  if (!Array.isArray(team.memberProfileIds)
    || team.memberProfileIds.length > 64
    || !team.memberProfileIds.every((id) => typeof id === "string" && PROFILE_PATTERN.test(id))) {
    throw new Error("Studio Server returned incompatible team members.");
  }
  const description = team.description === undefined
    ? undefined
    : typeof team.description === "string" && team.description.length <= 500
      ? team.description
      : undefined;
  const leadProfileId = team.leadProfileId === undefined
    ? undefined
    : typeof team.leadProfileId === "string" && PROFILE_PATTERN.test(team.leadProfileId)
      ? team.leadProfileId
      : undefined;
  const settings = team.settings === undefined
    ? defaultTeamSettings(team.updatedAt)
    : normalizeTeamSettings(team.settings);
  return {
    id: team.id,
    name: team.name,
    color: team.color.toLowerCase(),
    ...(description === undefined || description === "" ? {} : { description }),
    ...(leadProfileId === undefined ? {} : { leadProfileId }),
    memberProfileIds: [...team.memberProfileIds as string[]],
    settings,
    revision: team.revision as number,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

function normalizeTeamSettings(value: unknown): OfficeTeamSettings {
  if (!value || typeof value !== "object") {
    throw new Error("Studio Server returned incompatible team settings.");
  }
  const settings = value as Record<string, unknown>;
  if (!Number.isInteger(settings.revision) || (settings.revision as number) < 0) {
    throw new Error("Studio Server returned an incompatible team settings revision.");
  }
  if (typeof settings.skillsEnabled !== "boolean" || typeof settings.contextEnabled !== "boolean") {
    throw new Error("Studio Server returned incompatible team settings toggles.");
  }
  if (!Array.isArray(settings.skills)
    || settings.skills.length > GLOBAL_SETTINGS_MAX_SKILLS
    || !settings.skills.every((item) => typeof item === "string")) {
    throw new Error("Studio Server returned incompatible team skills.");
  }
  if (typeof settings.context !== "string" || !isGlobalContextWithinBudget(settings.context)) {
    throw new Error("Studio Server returned incompatible team context.");
  }
  if (typeof settings.updatedAt !== "string") {
    throw new Error("Studio Server returned incompatible team settings timestamps.");
  }
  return {
    revision: settings.revision as number,
    skillsEnabled: settings.skillsEnabled,
    contextEnabled: settings.contextEnabled,
    skills: [...settings.skills as string[]],
    context: settings.context,
    updatedAt: settings.updatedAt,
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

function cloneTeam(team: OfficeTeam): OfficeTeam {
  return {
    ...team,
    memberProfileIds: [...team.memberProfileIds],
    settings: cloneSettings(team.settings),
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

function asMutationFailure(error: unknown): TeamsMutationFailure {
  if (error instanceof TeamsMutationFailure) return error;
  if (error instanceof OfficeHttpError) {
    if (error.status === 409) return new TeamsMutationFailure("conflict", error);
    if (error.status >= 400 && error.status < 500 && error.status !== 408) {
      return new TeamsMutationFailure("rejected", error);
    }
  }
  return new TeamsMutationFailure("commit-unknown", error);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unable to update teams.";
}
