import type { ChatSession } from "./domain";

export type SessionDeleteScope =
  | { kind: "profile"; profileId: string }
  | { kind: "project"; profileId: string; projectGroupIds: readonly string[] }
  | { kind: "all-projects"; projectGroupIds: readonly string[] };

export function sessionMatchesDeleteScope(session: ChatSession, scope: SessionDeleteScope): boolean {
  switch (scope.kind) {
    case "profile":
      return session.profileId === scope.profileId;
    case "project":
      return session.profileId === scope.profileId
        && session.projectGroupId !== undefined
        && scope.projectGroupIds.includes(session.projectGroupId);
    case "all-projects":
      return session.projectGroupId !== undefined && scope.projectGroupIds.includes(session.projectGroupId);
  }
}
