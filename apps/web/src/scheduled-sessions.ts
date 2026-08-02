import { signal } from "@preact/signals";
import type { ChatSession } from "./domain";

export type ScheduledSessionGroup = {
  key: string;
  label: string;
  profileId: string;
  sessions: ChatSession[];
};

const HIDDEN_KEY_STORAGE = "hermes-studio.scheduled-sessions.hidden.v1";
const HIDDEN_ID_STORAGE = "hermes-studio.scheduled-sessions.hidden-ids.v1";
const KEEP_STORAGE = "hermes-studio.scheduled-sessions.keep.v1";
const KEEP_BY_GROUP_STORAGE = "hermes-studio.scheduled-sessions.keep-by-group.v1";
const DEFAULT_KEEP_COUNT = 3;
const KANBAN_WORKER_MARKERS = new Set([
  "kanban task completion recorded",
  "kanban task transition recorded",
  "kanban terminal transition recorded",
  "kanban terminal transition recorded; this worker run is finished",
]);

export const hiddenScheduledSessionKeys = signal<Set<string>>(loadStringSet(HIDDEN_KEY_STORAGE));
export const hiddenScheduledSessionIds = signal<Set<string>>(loadStringSet(HIDDEN_ID_STORAGE));
/** Fallback keep count for groups without an explicit override. */
export const scheduledKeepCount = signal<number>(loadDefaultKeepCount());
/** Per scheduled-job/group keep counts. */
export const scheduledKeepCountsByGroup = signal<Record<string, number>>(loadKeepCountsByGroup());

/**
 * This is a Hermes worker lifecycle marker, not a user-authored conversation.
 * Keep it out of every surface that groups durable sessions as chats.
 */
function isKanbanWorkerSession(session: Pick<ChatSession, "title" | "lastMessagePreview" | "conversationKind">): boolean {
  // Delegated specialist conversations are durable protocol entities and must
  // remain visible even when their task has completed. Only exact standalone
  // lifecycle notices are presentation-filtered; no persisted data is changed.
  if (session.conversationKind === "delegated") return false;
  return KANBAN_WORKER_MARKERS.has(normalizeKanbanWorkerMarker(session.title))
    || KANBAN_WORKER_MARKERS.has(normalizeKanbanWorkerMarker(session.lastMessagePreview ?? ""));
}

function normalizeKanbanWorkerMarker(value: string): string {
  return value.trim().replace(/\.$/u, "").replace(/\s+/gu, " ").toLowerCase();
}

/** Hermes cron/scheduled runs show up as ordinary sessions. Detect them for a focused review list. */
export function isScheduledSession(session: Pick<ChatSession, "title" | "titlePresentation">): boolean {
  if (session.titlePresentation === "new-chat") return false;
  return /(?:毎時(?:実行|ログ|ジョブ)?|定期(?:実行|ジョブ|処理)?|hourly(?:\s+(?:log|job|run|report))?|recurring(?:\s+job)?|\bcron(?:\s+job)?\b|scheduled\s+(?:job|run|task))/iu.test(session.title);
}

export function scheduledSessionLabel(title: string): string {
  return title
    .replace(/\s*[·•|｜]\s*(?:[A-Z][a-z]{2}\s+\d{1,2}(?:\s+\d{1,2}:\d{2})?|\d{4}[-/]\d{1,2}[-/]\d{1,2}.*)$/iu, "")
    .replace(/\s+\d{1,2}:\d{2}(?::\d{2})?\s*$/u, "")
    .trim() || title;
}

export function scheduledSessionKey(profileId: string, title: string): string {
  return `${profileId}\0${scheduledSessionLabel(title)}`;
}

export function scheduledSessionHideId(session: Pick<ChatSession, "id" | "storedSessionId">): string {
  return session.storedSessionId ?? session.id;
}

export function isScheduledSessionHidden(session: Pick<ChatSession, "id" | "storedSessionId" | "profileId" | "title" | "titlePresentation" | "lastMessagePreview" | "conversationKind">): boolean {
  if (isKanbanWorkerSession(session)) return true;
  if (!isScheduledSession(session)) return false;
  if (hiddenScheduledSessionKeys.value.has(scheduledSessionKey(session.profileId, session.title))) return true;
  return hiddenScheduledSessionIds.value.has(scheduledSessionHideId(session));
}

export function scheduledSessionGroups(sessions: readonly ChatSession[], includeHidden = false): ScheduledSessionGroup[] {
  const groups = new Map<string, ScheduledSessionGroup>();
  for (const session of sessions) {
    if (!isScheduledSession(session)) continue;
    const label = scheduledSessionLabel(session.title);
    const key = scheduledSessionKey(session.profileId, session.title);
    if (!includeHidden && isScheduledSessionHidden(session)) continue;
    const current = groups.get(key);
    if (current) current.sessions.push(session);
    else groups.set(key, { key, label, profileId: session.profileId, sessions: [session] });
  }
  for (const group of groups.values()) group.sessions = sortNewestFirst(group.sessions);
  return [...groups.values()].sort((left, right) => {
    const leftTime = sessionTime(left.sessions[0]!);
    const rightTime = sessionTime(right.sessions[0]!);
    if (leftTime !== undefined && rightTime !== undefined && leftTime !== rightTime) return rightTime - leftTime;
    if (leftTime !== undefined) return -1;
    if (rightTime !== undefined) return 1;
    return left.label.localeCompare(right.label);
  });
}

export function scheduledSessionCount(sessions: readonly ChatSession[]): number {
  return sessions.reduce((count, session) => count + (isScheduledSession(session) && !isScheduledSessionHidden(session) ? 1 : 0), 0);
}

export function getScheduledKeepCount(groupKey?: string, fallback = scheduledKeepCount.value): number {
  if (groupKey) {
    const override = scheduledKeepCountsByGroup.value[groupKey];
    if (override !== undefined) return normalizeKeepCount(override);
  }
  return normalizeKeepCount(fallback);
}

/** Newest-first groups already sorted; return older sessions beyond keepCount. */
export function scheduledSessionsToPrune(
  sessions: readonly ChatSession[],
  keepCount = scheduledKeepCount.value,
  groupKey?: string,
): ChatSession[] {
  if (groupKey) {
    const keep = getScheduledKeepCount(groupKey, keepCount);
    const group = scheduledSessionGroups(sessions).find((item) => item.key === groupKey);
    return group ? group.sessions.slice(keep) : [];
  }
  return scheduledSessionGroups(sessions).flatMap((group) => {
    const keep = getScheduledKeepCount(group.key, keepCount);
    return group.sessions.slice(keep);
  });
}

export function setScheduledKeepCount(value: number, groupKey?: string): void {
  const next = normalizeKeepCount(value);
  if (groupKey) {
    const current = { ...scheduledKeepCountsByGroup.value, [groupKey]: next };
    scheduledKeepCountsByGroup.value = current;
    persistKeepCountsByGroup(current);
    return;
  }
  scheduledKeepCount.value = next;
  try { window.localStorage.setItem(KEEP_STORAGE, String(next)); } catch { /* ignore */ }
}

export function hideScheduledSessionKeys(keys: readonly string[]): void {
  if (keys.length === 0) return;
  const next = new Set(hiddenScheduledSessionKeys.value);
  for (const key of keys) if (key) next.add(key);
  hiddenScheduledSessionKeys.value = next;
  persistStringSet(HIDDEN_KEY_STORAGE, next);
}

export function hideScheduledSessionIds(ids: readonly string[]): void {
  if (ids.length === 0) return;
  const next = new Set(hiddenScheduledSessionIds.value);
  for (const id of ids) if (id) next.add(id);
  hiddenScheduledSessionIds.value = next;
  persistStringSet(HIDDEN_ID_STORAGE, next);
}

export function hideScheduledSessions(sessions: readonly ChatSession[]): string[] {
  const keys = [...new Set(
    sessions
      .filter((session) => isScheduledSession(session))
      .map((session) => scheduledSessionKey(session.profileId, session.title)),
  )];
  hideScheduledSessionKeys(keys);
  hideScheduledSessionIds(sessions.map(scheduledSessionHideId));
  return sessions.map((session) => session.id);
}

export function pruneScheduledSessions(
  sessions: readonly ChatSession[],
  keepCount = scheduledKeepCount.value,
  groupKey?: string,
): string[] {
  const victims = scheduledSessionsToPrune(sessions, keepCount, groupKey);
  if (victims.length === 0) return [];
  hideScheduledSessionIds(victims.map(scheduledSessionHideId));
  return victims.map((session) => session.id);
}

function sortNewestFirst(sessions: readonly ChatSession[]): ChatSession[] {
  return sessions
    .map((session, index) => ({ session, index, time: sessionTime(session) }))
    .sort((left, right) => {
      if (left.time !== undefined && right.time !== undefined && left.time !== right.time) return right.time - left.time;
      if (left.time !== undefined) return -1;
      if (right.time !== undefined) return 1;
      return left.index - right.index;
    })
    .map(({ session }) => session);
}

function sessionTime(session: ChatSession): number | undefined {
  const value = session.updatedAt ?? session.createdAt;
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function normalizeKeepCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_KEEP_COUNT;
  return Math.max(0, Math.min(500, Math.floor(value)));
}

function loadDefaultKeepCount(): number {
  if (typeof window === "undefined") return DEFAULT_KEEP_COUNT;
  try {
    const raw = window.localStorage.getItem(KEEP_STORAGE);
    if (raw === null) return DEFAULT_KEEP_COUNT;
    return normalizeKeepCount(Number(raw));
  } catch {
    return DEFAULT_KEEP_COUNT;
  }
}

function loadKeepCountsByGroup(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEEP_BY_GROUP_STORAGE);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const next: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!key) continue;
      const count = normalizeKeepCount(Number(value));
      next[key] = count;
    }
    return next;
  } catch {
    return {};
  }
}

function persistKeepCountsByGroup(values: Record<string, number>): void {
  try {
    window.localStorage.setItem(KEEP_BY_GROUP_STORAGE, JSON.stringify(values));
  } catch {
    // Preferences may be blocked.
  }
}

function loadStringSet(storageKey: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string" && value.length > 0));
  } catch {
    return new Set();
  }
}

function persistStringSet(storageKey: string, values: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify([...values]));
  } catch {
    // Preferences may be blocked.
  }
}
