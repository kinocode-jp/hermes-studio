import type { OfficeSnapshotRequestIdentity } from "./domain";

const latestRequests = new Map<string, OfficeSnapshotRequestIdentity>();

/** Record generation at request issuance, before any HTTP await can race chat promotion. */
export function recordOfficeSnapshotRequestIdentity(identity: OfficeSnapshotRequestIdentity): void {
  const key = connectionKey(identity.serverUrl, identity.connectionGeneration);
  const current = latestRequests.get(key);
  if (!current || identity.requestGeneration > current.requestGeneration) latestRequests.set(key, identity);
}

export function latestOfficeSnapshotRequestIdentity(
  applied: OfficeSnapshotRequestIdentity | undefined,
): OfficeSnapshotRequestIdentity | undefined {
  if (!applied) return undefined;
  return latestRequests.get(connectionKey(applied.serverUrl, applied.connectionGeneration)) ?? applied;
}

export function clearOfficeSnapshotRequestIdentities(): void {
  latestRequests.clear();
}

function connectionKey(serverUrl: string, connectionGeneration: number): string {
  return `${connectionGeneration}:${serverUrl}`;
}
