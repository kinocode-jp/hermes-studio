import { signal } from "@preact/signals";
import type { ChatSession, OfficeInventoryPagination, OfficeSnapshot, OfficeSnapshotProfile, OfficeSnapshotRequestIdentity, Profile } from "./domain";
import { officeMessage, type RuntimeMessage } from "./i18n";
import { OfficeHttpError, officeFetchJson, subscribeOfficeAuthChanges } from "./office-api";
import { storedSessionClientId } from "./session-identity";
import { isScheduledSessionHidden } from "./scheduled-sessions";
import { mergeServerSessionStatus } from "./session-runtime";
import { reconcileDefaultAvatarProfiles, registerDefaultAvatarProfiles } from "./avatar-preferences";
import { ensurePokemonDisplayNames } from "./profile-names";
import { activeSessionId, dismissSessions, openSessionIds, profileList, selectedProfileId, sessions } from "./store";

type InventoryKind = "profiles" | "sessions";
type InventoryPage = {
  kind: InventoryKind;
  profiles: OfficeSnapshotProfile[];
  sessions: OfficeSnapshot["sessions"];
  pagination: OfficeInventoryPagination;
};
type InventoryLoadState = OfficeInventoryPagination & { loading: boolean; error?: RuntimeMessage | undefined };
type InventoryIdentity = OfficeSnapshotRequestIdentity & {
  inventoryGeneration: number;
  seenProfiles: Set<string>;
  seenSessions: Set<string>;
  profilesReliable: boolean;
  sessionsReliable: boolean;
};
type SnapshotRefresh = (expected: Pick<OfficeSnapshotRequestIdentity, "serverUrl" | "connectionGeneration">) => Promise<OfficeSnapshotRequestIdentity | undefined>;

const emptyState: InventoryLoadState = { returned: 0, available: 0, total: 0, hasMore: false, truncated: false, partialFailures: 0, loading: false };
export const profileInventoryState = signal<InventoryLoadState>({ ...emptyState });
export const sessionInventoryState = signal<InventoryLoadState>({ ...emptyState });
/** True only after every page in the current session inventory was reliable. */
export const sessionInventoryComplete = signal(false);
/** Identity of the snapshot that initialized the exported inventory states. */
export const inventorySnapshotIdentity = signal<OfficeSnapshotRequestIdentity | undefined>(undefined);
let nextInventoryGeneration = 0;
let nextLegacyRequestGeneration = 0;
let inventoryIdentity: InventoryIdentity | undefined;
let refreshSnapshot: SnapshotRefresh | undefined;
subscribeOfficeAuthChanges(invalidateInventoryAuthentication);

export function initializeInventory(snapshot: OfficeSnapshot, source: string | OfficeSnapshotRequestIdentity): void {
  const snapshotIdentity = typeof source === "string"
    ? { serverUrl: source, connectionGeneration: 0, requestGeneration: ++nextLegacyRequestGeneration }
    : source;
  // Fence reactive consumers before replacing pagination. This also protects
  // legacy/string callers whose synthetic identities all use generation 0.
  inventorySnapshotIdentity.value = undefined;
  sessionInventoryComplete.value = false;
  inventoryIdentity = {
    ...snapshotIdentity,
    inventoryGeneration: ++nextInventoryGeneration,
    seenProfiles: new Set(snapshot.profiles.map((profile) => profile.id)),
    seenSessions: new Set(snapshot.sessions.map(sessionKey)),
    profilesReliable: isReliablePage(snapshot.inventory.profiles),
    sessionsReliable: isReliablePage(snapshot.inventory.sessions)
  };
  profileInventoryState.value = { ...snapshot.inventory.profiles, loading: false };
  sessionInventoryState.value = { ...snapshot.inventory.sessions, loading: false };
  sessionInventoryComplete.value = isReliablePage(snapshot.inventory.sessions)
    && isTerminal(snapshot.inventory.sessions);
  // Publish identity last so consumers never pair a new identity with stale pagination.
  inventorySnapshotIdentity.value = snapshotIdentity;
}

export function registerInventorySnapshotRefresh(action: SnapshotRefresh | undefined): void {
  refreshSnapshot = action;
}

/** Force a fresh snapshot (e.g. after profile create/delete) so lists update promptly. */
export async function requestInventorySnapshotRefresh(): Promise<void> {
  const identity = inventoryIdentity;
  if (!refreshSnapshot || !identity) return;
  try {
    await refreshSnapshot({ serverUrl: identity.serverUrl, connectionGeneration: identity.connectionGeneration });
  } catch {
    // The periodic snapshot cycle will converge eventually.
  }
}

export async function loadMoreProfiles(): Promise<void> { await loadMore("profiles"); }
export async function loadMoreSessions(): Promise<void> { await loadMore("sessions"); }

/** Load every reliable session-inventory page before destructive "delete all" actions. */
export async function loadAllSessions(maxPages = 1_000): Promise<boolean> {
  let loadedPages = 0;
  while (sessionInventoryState.value.hasMore) {
    if (loadedPages >= maxPages) return false;
    if (sessionInventoryState.value.loading) {
      let settled = false;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
        if (!sessionInventoryState.value.loading) {
          settled = true;
          break;
        }
      }
      if (!settled) return false;
      continue;
    }
    const cursor = sessionInventoryState.value.nextCursor;
    if (!cursor) return false;
    await loadMoreSessions();
    loadedPages += 1;
    const next = sessionInventoryState.value;
    if (next.error !== undefined) return false;
    if (next.hasMore && next.nextCursor === cursor) return false;
  }
  // A Hermes snapshot may be marked truncated because one row was malformed
  // even after every exposed page was consumed. Destructive callers can still
  // safely delete the concrete IDs that were returned, refresh, and repeat.
  return !sessionInventoryState.value.hasMore && sessionInventoryState.value.error === undefined;
}

async function loadMore(kind: InventoryKind, retriedAfterRefresh = false): Promise<void> {
  const stateSignal = kind === "profiles" ? profileInventoryState : sessionInventoryState;
  const current = stateSignal.value;
  const identity = inventoryIdentity;
  if (current.loading || !current.hasMore || current.nextCursor === undefined || !identity) return;
  const cursor = current.nextCursor;
  stateSignal.value = { ...current, loading: true, error: undefined };
  try {
    const query = new URLSearchParams({ kind, cursor, limit: "100" });
    const page = await officeFetchJson<unknown>(`/api/v1/inventory?${query}`, {}, identity.serverUrl);
    if (!isCurrentLoad(identity, stateSignal.value, cursor)) return;
    if (!isInventoryPage(page, kind)) throw new InventoryLoadError("invalid-page");
    commitInventoryPage(page, identity);
    stateSignal.value = { ...page.pagination, loading: false };
  } catch (caught) {
    if (!isCurrentLoad(identity, stateSignal.value, cursor)) return;
    let error = caught;
    if (error instanceof OfficeHttpError && error.status === 409 && !retriedAfterRefresh && refreshSnapshot) {
      try {
        const refreshed = await refreshSnapshot({ serverUrl: identity.serverUrl, connectionGeneration: identity.connectionGeneration });
        if (!refreshed) throw new InventoryLoadError("snapshot-refresh");
        if (!isCurrentSnapshot(refreshed)) return;
        await loadMore(kind, true);
        return;
      } catch {
        error = new InventoryLoadError("snapshot-refresh");
      }
    }
    if (!isCurrentLoad(identity, stateSignal.value, cursor)) return;
    const message = inventoryErrorMessage(error);
    if (caught instanceof OfficeHttpError && caught.status === 409) {
      const { nextCursor: _staleCursor, ...withoutCursor } = current;
      stateSignal.value = { ...withoutCursor, hasMore: false, loading: false, error: message };
    } else {
      stateSignal.value = { ...current, loading: false, error: message };
    }
  }
}

class InventoryLoadError extends Error {
  constructor(readonly kind: "invalid-page" | "snapshot-refresh") {
    super(kind);
    this.name = "InventoryLoadError";
  }
}

function inventoryErrorMessage(error: unknown): RuntimeMessage {
  if (error instanceof InventoryLoadError) {
    return officeMessage(error.kind === "invalid-page" ? "inventory.error.invalidPage" : "inventory.error.snapshotRefresh");
  }
  if (error instanceof OfficeHttpError) return officeMessage("inventory.error.http", { status: error.status });
  return officeMessage("inventory.error.load");
}

function isCurrentLoad(identity: InventoryIdentity, state: InventoryLoadState, cursor: string): boolean {
  return inventoryIdentity === identity && state.loading && state.nextCursor === cursor;
}

function isCurrentSnapshot(identity: OfficeSnapshotRequestIdentity): boolean {
  return inventoryIdentity?.serverUrl === identity.serverUrl
    && inventoryIdentity.connectionGeneration === identity.connectionGeneration
    && inventoryIdentity.requestGeneration === identity.requestGeneration;
}

function invalidateInventoryAuthentication(serverUrl: string): void {
  if (inventoryIdentity?.serverUrl !== serverUrl) return;
  inventoryIdentity = undefined;
  inventorySnapshotIdentity.value = undefined;
  sessionInventoryComplete.value = false;
  profileInventoryState.value = invalidatedState(profileInventoryState.value);
  sessionInventoryState.value = invalidatedState(sessionInventoryState.value);
}

function invalidatedState(state: InventoryLoadState): InventoryLoadState {
  const { nextCursor: _invalidCursor, ...rest } = state;
  return { ...rest, hasMore: false, loading: false, error: undefined };
}

export function mergeInventoryPage(page: InventoryPage): void {
  if (page.kind === "profiles") mergeProfiles(page.profiles);
  else mergeSessions(page.sessions);
}

function commitInventoryPage(page: InventoryPage, identity: InventoryIdentity): void {
  if (page.kind === "profiles") {
    identity.profilesReliable &&= isReliablePage(page.pagination);
    mergeProfiles(page.profiles, identity.seenProfiles);
    if (identity.profilesReliable && isTerminal(page.pagination)) {
      pruneProfiles(identity.seenProfiles);
      reconcileDefaultAvatarProfiles([...identity.seenProfiles]);
    }
  } else {
    identity.sessionsReliable &&= isReliablePage(page.pagination);
    mergeSessions(page.sessions, identity.seenSessions);
    sessionInventoryComplete.value = identity.sessionsReliable && isTerminal(page.pagination);
    if (sessionInventoryComplete.value) pruneSessions(identity.seenSessions);
  }
}

function mergeProfiles(rows: OfficeSnapshotProfile[], seen?: Set<string>): void {
  const profileIds = rows.map((profile) => profile.id);
  registerDefaultAvatarProfiles(profileIds);
  ensurePokemonDisplayNames(profileIds);
  const next = [...profileList.value];
  const existing = new Map(next.map((profile, index) => [profile.id, index]));
  const pageSeen = new Set<string>();
  const palette = ["#64b7a7", "#e07a55", "#d6a94f", "#8499c8", "#55d6be", "#f06a57"];
  for (const live of rows) {
    if (pageSeen.has(live.id)) continue;
    pageSeen.add(live.id);
    seen?.add(live.id);
    const index = existing.get(live.id);
    const previous = index === undefined ? undefined : next[index];
    if (index === undefined || previous === undefined) {
      existing.set(live.id, next.length);
      next.push({ id: live.id, name: live.name, role: "", status: activityToStatus(live.activity), color: palette[next.length % palette.length]!, sessions: live.activeSessionCount, taskCount: 0, memoryBytes: 0, memoryNote: "Hermes runtimeから読み取ったProfileです。", skills: [], inheritedSkills: [] });
      continue;
    }
    next[index] = { ...previous, name: live.name, status: activityToStatus(live.activity), sessions: live.activeSessionCount };
  }
  profileList.value = next;
}

function mergeSessions(rows: OfficeSnapshot["sessions"], seen?: Set<string>): void {
  const next = [...sessions.value];
  const existing = new Map(next.flatMap((session, index) => session.remoteKind === "stored" ? [[sessionKey(session), index] as const] : []));
  const pageSeen = new Set<string>();
  for (const live of rows) {
    if (isScheduledSessionHidden({
      id: live.id,
      storedSessionId: live.id,
      profileId: live.profileId,
      title: live.title,
      titlePresentation: undefined,
    })) continue;
    const key = sessionKey(live);
    if (pageSeen.has(key)) continue;
    pageSeen.add(key);
    seen?.add(key);
    const index = existing.get(key);
    const previous = index === undefined ? undefined : next[index]!;
    const status = mergeServerSessionStatus(previous, live.activity);
    if (index === undefined || previous === undefined) {
      existing.set(key, next.length);
      next.push({ id: storedSessionClientId(live.profileId, live.id), storedSessionId: live.id, profileId: live.profileId, title: live.title, ...(live.createdAt === undefined ? {} : { createdAt: live.createdAt }), ...(live.updatedAt === undefined ? {} : { updatedAt: live.updatedAt }), ...(live.lastMessagePreview === undefined ? {} : { lastMessagePreview: live.lastMessagePreview }), ...(live.conversationKind === undefined ? {} : { conversationKind: live.conversationKind }), ...(live.delegationTaskId === undefined ? {} : { delegationTaskId: live.delegationTaskId }), ...(live.delegatedByProfileId === undefined ? {} : { delegatedByProfileId: live.delegatedByProfileId }), status, messages: [], connectionState: "disconnected", historyState: "unloaded", remoteKind: "stored", readOnly: true });
      continue;
    }
    next[index] = { ...previous, storedSessionId: live.id, profileId: live.profileId, title: live.title, titlePresentation: undefined, ...(live.createdAt === undefined ? {} : { createdAt: live.createdAt }), ...(live.updatedAt === undefined ? {} : { updatedAt: live.updatedAt }), ...(live.lastMessagePreview === undefined ? {} : { lastMessagePreview: live.lastMessagePreview }), ...(live.conversationKind === undefined ? {} : { conversationKind: live.conversationKind }), ...(live.delegationTaskId === undefined ? {} : { delegationTaskId: live.delegationTaskId }), ...(live.delegatedByProfileId === undefined ? {} : { delegatedByProfileId: live.delegatedByProfileId }), status, remoteKind: "stored" };
  }
  sessions.value = next.filter((session) => !isScheduledSessionHidden(session));
  updateProfileSessionCounts();
}

function pruneProfiles(seen: ReadonlySet<string>): void {
  const draftProfiles = new Set(sessions.value.flatMap((session) => session.remoteKind === "draft" ? [session.profileId] : []));
  profileList.value = profileList.value.filter((profile) => seen.has(profile.id) || draftProfiles.has(profile.id));
  if (!profileList.value.some((profile) => profile.id === selectedProfileId.value)) selectedProfileId.value = profileList.value[0]?.id ?? "";
}

function pruneSessions(seen: ReadonlySet<string>): void {
  const removedIds = new Set(sessions.value.flatMap((session) => session.remoteKind === "stored" && !seen.has(sessionKey(session)) ? [session.id] : []));
  if (removedIds.size === 0) return;
  dismissSessions([...removedIds]);
}

function updateProfileSessionCounts(): void {
  const counts = new Map<string, number>();
  for (const session of sessions.value) {
    if (session.remoteKind === "demo" || isScheduledSessionHidden(session)) continue;
    counts.set(session.profileId, (counts.get(session.profileId) ?? 0) + 1);
  }
  profileList.value = profileList.value.map((profile) => ({ ...profile, sessions: counts.get(profile.id) ?? 0 }));
}

function isReliablePage(page: OfficeInventoryPagination): boolean {
  return !page.truncated && page.partialFailures === 0;
}

function isTerminal(page: OfficeInventoryPagination): boolean {
  return !page.hasMore;
}

function sessionKey(session: { profileId: string; id: string; storedSessionId?: string | undefined }): string {
  return `${session.profileId}\0${session.storedSessionId ?? session.id}`;
}

function isInventoryPage(value: unknown, kind: InventoryKind): value is InventoryPage {
  if (!value || typeof value !== "object") return false;
  const page = value as Partial<InventoryPage>;
  const pagination = page.pagination as Partial<OfficeInventoryPagination> | undefined;
  return page.kind === kind && Array.isArray(page.profiles) && Array.isArray(page.sessions)
    && typeof pagination?.returned === "number" && pagination.returned >= 0 && pagination.returned <= 100 && Number.isSafeInteger(pagination.returned)
    && typeof pagination.available === "number" && pagination.available >= pagination.returned && Number.isSafeInteger(pagination.available)
    && typeof pagination?.hasMore === "boolean" && typeof pagination.truncated === "boolean"
    && typeof pagination.partialFailures === "number" && pagination.partialFailures >= 0 && Number.isSafeInteger(pagination.partialFailures)
    && (pagination.total === undefined || (typeof pagination.total === "number" && pagination.total >= pagination.available && Number.isSafeInteger(pagination.total)))
    && (pagination.partialFailures === 0 || pagination.truncated)
    && (!pagination.hasMore || (typeof pagination.nextCursor === "string" && pagination.nextCursor.length <= 256));
}

function activityToStatus(activity: string): Profile["status"] {
  if (activity === "thinking" || activity === "using-tool") return "working";
  if (activity === "waiting-for-user") return "waiting";
  if (activity === "blocked" || activity === "error") return "blocked";
  return "idle";
}
