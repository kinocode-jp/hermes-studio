/** Minimal team shape used by the pure grouping helper. */
export type TeamGroupInput = {
  id: string;
  name: string;
  color: string;
  memberProfileIds: readonly string[];
};

export type ProfileWithId = { id: string };

export type ProfileTeamGroup<T extends ProfileWithId> =
  | {
      kind: "team";
      /** Stable unique key for React lists (includes team id). */
      key: string;
      teamId: string;
      name: string;
      color: string;
      profiles: T[];
    }
  | {
      kind: "unassigned";
      key: "unassigned";
      profiles: T[];
    };

export type ProfileTeamGrouping<T extends ProfileWithId> =
  | { mode: "flat"; profiles: T[] }
  | { mode: "grouped"; groups: ProfileTeamGroup<T>[] };

/**
 * Group profiles for team-aware UI.
 *
 * - No teams → flat list (callers render profiles directly).
 * - With teams → nonempty teams in the given order, each with live members;
 *   then an `unassigned` group only when at least one profile belongs to no team.
 * - Membership is many-to-many: a profile appears under every matching team.
 * - Stale member IDs and in-team duplicates are ignored.
 * - Every live profile appears at least once (in one or more teams, or unassigned).
 */
export function groupProfilesByTeams<T extends ProfileWithId>(
  profiles: readonly T[],
  teams: readonly TeamGroupInput[],
): ProfileTeamGrouping<T> {
  if (teams.length === 0) {
    return { mode: "flat", profiles: [...profiles] };
  }

  const byId = new Map<string, T>();
  for (const profile of profiles) {
    if (!byId.has(profile.id)) byId.set(profile.id, profile);
  }

  const assigned = new Set<string>();
  const groups: ProfileTeamGroup<T>[] = [];

  for (const team of teams) {
    const members: T[] = [];
    const seenInTeam = new Set<string>();
    for (const memberId of team.memberProfileIds) {
      if (seenInTeam.has(memberId)) continue;
      seenInTeam.add(memberId);
      const profile = byId.get(memberId);
      if (profile === undefined) continue;
      members.push(profile);
      assigned.add(memberId);
    }
    if (members.length === 0) continue;
    groups.push({
      kind: "team",
      key: `team:${team.id}`,
      teamId: team.id,
      name: team.name,
      color: team.color,
      profiles: members,
    });
  }

  const unassigned = profiles.filter((profile) => !assigned.has(profile.id));
  if (unassigned.length > 0) {
    groups.push({ kind: "unassigned", key: "unassigned", profiles: unassigned });
  }

  return { mode: "grouped", groups };
}

/** React list key when the same profile can appear under multiple teams. */
export function profileGroupItemKey(groupKey: string, profileId: string): string {
  return `${groupKey}\0${profileId}`;
}
