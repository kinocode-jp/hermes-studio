import type { ChatSession } from "./domain";
import type { ProfileProject } from "./settings-api";

export type ConfiguredProjectSource = {
  profileId: string;
  profileName: string;
  projects: Array<{ project: ProfileProject; folderGroupIds: string[] }>;
};

export type ConfiguredProjectGroup = {
  key: string;
  name: string;
  profileId: string;
  profileName: string;
  projectGroupIds: string[];
  folderNames: string[];
  sessions: ChatSession[];
};

/**
 * Map durable Hermes Projects to the privacy-safe workspace keys supplied by
 * session inventory. A project stays visible even before it has a folder or
 * any conversation.
 */
export function groupSessionsByConfiguredProjects(
  sessions: readonly ChatSession[],
  sources: readonly ConfiguredProjectSource[],
): ConfiguredProjectGroup[] {
  const groups: ConfiguredProjectGroup[] = [];
  for (const source of sources) {
    for (const { project, folderGroupIds } of source.projects) {
      if (project.archived) continue;
      const projectGroupIds = [...new Set(folderGroupIds)];
      const ids = new Set(projectGroupIds);
      groups.push({
        key: `${source.profileId}:${project.id}`,
        name: project.name,
        profileId: source.profileId,
        profileName: source.profileName,
        projectGroupIds,
        folderNames: project.folders.map((folder) => folder.label?.trim() || folderBasename(folder.path)).filter(Boolean),
        sessions: sessions.filter((session) => session.profileId === source.profileId
          && session.projectGroupId !== undefined
          && ids.has(session.projectGroupId)),
      });
    }
  }
  return groups.sort((left, right) => left.profileName.localeCompare(right.profileName)
    || left.name.localeCompare(right.name));
}

function folderBasename(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean).at(-1) ?? "";
}

/** Match the normalized workspace hash emitted by the server inventory. */
export async function projectFolderGroupId(path: string): Promise<string | undefined> {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized || normalized.includes("\0")) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 24);
}
