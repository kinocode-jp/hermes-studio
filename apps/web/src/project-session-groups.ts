import type { ChatSession } from "./domain";

export type ProjectSessionGroup = {
  kind: "project" | "unassigned";
  key: string;
  name: string;
  sessions: ChatSession[];
};

/** Group visible sessions by the opaque workspace identity from Studio Server. */
export function groupSessionsByProject(source: readonly ChatSession[]): ProjectSessionGroup[] {
  const grouped = new Map<string, ProjectSessionGroup>();
  const unassigned: ChatSession[] = [];

  for (const session of source) {
    if (!session.projectGroupId || !session.projectGroupName) {
      unassigned.push(session);
      continue;
    }
    const existing = grouped.get(session.projectGroupId);
    if (existing) existing.sessions.push(session);
    else grouped.set(session.projectGroupId, {
      kind: "project",
      key: session.projectGroupId,
      name: session.projectGroupName,
      sessions: [session],
    });
  }

  const projects = [...grouped.values()].sort((left, right) => {
    const byActivity = groupActivity(right) - groupActivity(left);
    return byActivity || left.name.localeCompare(right.name);
  });
  if (unassigned.length > 0) projects.push({ kind: "unassigned", key: "unassigned", name: "", sessions: unassigned });
  return projects;
}

function groupActivity(group: ProjectSessionGroup): number {
  return group.sessions.reduce((latest, session) => {
    const value = Date.parse(session.updatedAt ?? session.createdAt ?? "");
    return Number.isFinite(value) ? Math.max(latest, value) : latest;
  }, 0);
}
