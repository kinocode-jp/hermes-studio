/**
 * A newly-created session can become durable before an older HTTP snapshot
 * returns. Keep that promoted identity through authoritative omissions until
 * inventory has acknowledged it once; later omissions are real deletions.
 */
import type { OfficeSnapshotRequestIdentity } from "./domain";

const awaitingObservation = new Map<string, OfficeSnapshotRequestIdentity | undefined>();

export function awaitSessionInventoryObservation(
  profileId: string,
  storedSessionId: string,
  issuedThrough?: OfficeSnapshotRequestIdentity,
): void {
  awaitingObservation.set(observationKey(profileId, storedSessionId), issuedThrough);
}

export function recordSessionInventoryObservation(profileId: string, storedSessionId: string): void {
  awaitingObservation.delete(observationKey(profileId, storedSessionId));
}

/**
 * Protect omissions from requests already issued at promotion time. A newer
 * complete authoritative request proves external deletion even if no row was
 * ever observed, and consumes the barrier.
 */
export function protectSessionInventoryOmission(
  profileId: string,
  storedSessionId: string,
  candidate?: OfficeSnapshotRequestIdentity,
): boolean {
  const key = observationKey(profileId, storedSessionId);
  if (!awaitingObservation.has(key)) return false;
  const issuedThrough = awaitingObservation.get(key);
  if (!issuedThrough || !candidate) return true;
  const newer = candidate.serverUrl !== issuedThrough.serverUrl
    || candidate.connectionGeneration > issuedThrough.connectionGeneration
    || (candidate.connectionGeneration === issuedThrough.connectionGeneration
      && candidate.requestGeneration > issuedThrough.requestGeneration);
  if (!newer) return true;
  awaitingObservation.delete(key);
  return false;
}

export function forgetSessionInventoryObservation(profileId: string, storedSessionId: string): void {
  awaitingObservation.delete(observationKey(profileId, storedSessionId));
}

export function clearSessionInventoryObservations(): void {
  awaitingObservation.clear();
}

function observationKey(profileId: string, storedSessionId: string): string {
  return `${profileId.length}:${profileId}${storedSessionId}`;
}
