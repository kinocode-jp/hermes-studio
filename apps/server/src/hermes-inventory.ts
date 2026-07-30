import { createHash, randomBytes } from "node:crypto";
import type {
  AgentActivity,
  ChatSessionSummary,
  OfficeInventoryKind,
  OfficeInventoryMetadata,
  OfficeInventoryPage,
  OfficeInventoryPagination,
  ProfileSummary,
} from "@hermes-studio/protocol";
import { UNKNOWN_INVENTORY_TIMESTAMP } from "@hermes-studio/protocol";
import { redactSecrets } from "./secret-scrubber.js";

const UPSTREAM_PAGE_SIZE = 100;
const SNAPSHOT_PAGE_SIZE = 100;
const MAX_SESSION_PAGES = 20;
const MAX_SESSION_ROWS = UPSTREAM_PAGE_SIZE * MAX_SESSION_PAGES;
const MAX_PROFILE_ROWS = 2_000;
const MAX_INVENTORY_BYTES = 8 * 1024 * 1024;
// Cold profile discovery can consume most of the original seven-second shared
// budget before session paging begins. Keep the full snapshot below the
// server's outer request bound while leaving enough time to collect all pages.
const INVENTORY_TIMEOUT_MS = 12_000;
const INVENTORY_GENERATION_TTL_MS = 5 * 60_000;
const MAX_INVENTORY_GENERATIONS = 8;
const MAX_EPOCH_SECONDS = 8_640_000_000_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type HermesJsonResult = { value: unknown; bytes: number };
export type HermesInventoryRequester = (path: string, timeoutMs: number) => Promise<HermesJsonResult>;

type CollectionState = {
  rows: Record<string, unknown>[];
  total?: number;
  truncated: boolean;
  partialFailures: number;
};

export type CollectedHermesInventory = {
  profiles: ProfileSummary[];
  sessions: ChatSessionSummary[];
  profilesState: Omit<CollectionState, "rows">;
  sessionsState: Omit<CollectionState, "rows">;
};

/** Collects a bounded, ordered inventory from Hermes' real offset API. */
export async function collectHermesInventory(request: HermesInventoryRequester): Promise<CollectedHermesInventory> {
  try {
    const deadline = Date.now() + INVENTORY_TIMEOUT_MS;
    const budget = { bytes: 0 };
    const profilesResult = await collectProfiles(request, deadline, budget);
    const sessionsResult = await collectSessions(request, deadline, budget);
    const mappedSessions = mapSessions(sessionsResult.rows);
    const mappedProfiles = mapProfiles(profilesResult.rows, mappedSessions.items);
    return {
      profiles: mappedProfiles.items,
      sessions: mappedSessions.items,
      profilesState: mappedState(profilesResult, mappedProfiles.items.length, mappedProfiles.failures),
      sessionsState: mappedState(sessionsResult, mappedSessions.items.length, mappedSessions.failures),
    };
  } catch {
    // Unexpected mapper/collection failures must never become an authoritative
    // empty inventory. Clients retain last-known-good state for this shape.
    return unavailableInventory();
  }
}

async function collectProfiles(
  request: HermesInventoryRequester,
  deadline: number,
  budget: { bytes: number },
): Promise<CollectionState> {
  try {
    const result = await boundedRequest(request, "/api/profiles", deadline, budget);
    const source = requiredRecordArray(result, "profiles");
    const rows = dedupeRecords(source.records.slice(0, MAX_PROFILE_ROWS), (row) => readString(row, "name"));
    const incomplete = source.invalid || source.records.length > MAX_PROFILE_ROWS || rows.length < Math.min(source.records.length, MAX_PROFILE_ROWS);
    return {
      rows,
      total: source.wireLength,
      truncated: incomplete,
      partialFailures: incomplete ? 1 : 0,
    };
  } catch {
    return { rows: [], truncated: true, partialFailures: 1 };
  }
}

async function collectSessions(
  request: HermesInventoryRequester,
  deadline: number,
  budget: { bytes: number },
): Promise<CollectionState> {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const failedProfiles = new Set<string>();
  let offset = 0;
  let total: number | undefined;
  let truncated = false;
  let requestFailures = 0;
  let rowFailures = 0;
  let totalFailures = 0;
  let previousReportedTotal: number | undefined;
  let sawReportedTotal = false;
  let sawMissingTotal = false;
  let totalContractInconsistent = false;

  for (let page = 0; page < MAX_SESSION_PAGES && rows.length < MAX_SESSION_ROWS; page += 1) {
    let value: unknown;
    try {
      value = await boundedRequest(
        request,
        `/api/profiles/sessions?limit=${UPSTREAM_PAGE_SIZE}&offset=${offset}&order=recent`,
        deadline,
        budget,
      );
    } catch {
      truncated = true;
      requestFailures += 1;
      break;
    }
    let pageSource: { records: Record<string, unknown>[]; wireLength: number; invalid: boolean };
    try {
      pageSource = requiredRecordArray(value, "sessions");
    } catch {
      truncated = true;
      requestFailures += 1;
      break;
    }
    const pageRows = pageSource.records;
    if (pageSource.invalid) { truncated = true; requestFailures += 1; }
    const pageEnd = offset + pageSource.wireLength;
    const rawTotal = isRecord(value) ? value.total : undefined;
    const reportedTotal = readNonNegativeInteger(value, "total");
    let pageTotalInconsistent = false;
    if (reportedTotal === undefined) {
      if (rawTotal !== undefined || sawReportedTotal) pageTotalInconsistent = true;
      sawMissingTotal = true;
    } else {
      if (sawMissingTotal || (previousReportedTotal !== undefined && reportedTotal !== previousReportedTotal) || reportedTotal < pageEnd) {
        pageTotalInconsistent = true;
      }
      sawReportedTotal = true;
      previousReportedTotal = reportedTotal;
      total = Math.max(total ?? 0, reportedTotal);
    }
    if (pageTotalInconsistent) {
      totalContractInconsistent = true;
      truncated = true;
      totalFailures += 1;
    }
    let failures: Record<string, unknown>[] = [];
    try { failures = optionalRecordArray(value, "errors"); }
    catch { truncated = true; requestFailures += 1; }
    for (const failure of failures) {
      failedProfiles.add(readString(failure, "profile") ?? "unknown");
    }
    for (const row of pageRows) {
      try {
        const id = readString(row, "id");
        const profile = readString(row, "profile");
        if (id === undefined || profile === undefined) { rowFailures += 1; continue; }
        const key = `${profile}\0${id}`;
        if (seen.has(key)) { rowFailures += 1; continue; }
        seen.add(key);
        rows.push(row);
        if (rows.length === MAX_SESSION_ROWS) break;
      } catch { rowFailures += 1; }
    }

    if (pageSource.wireLength === 0) {
      if ((total ?? offset) > offset) { truncated = true; requestFailures += 1; }
      break;
    }
    offset += pageSource.wireLength;
    const upstreamHasMore = !totalContractInconsistent && reportedTotal !== undefined
      ? offset < reportedTotal
      : pageSource.wireLength >= UPSTREAM_PAGE_SIZE;
    if (!upstreamHasMore) break;
    if (page === MAX_SESSION_PAGES - 1 || rows.length === MAX_SESSION_ROWS) truncated = true;
  }

  if (rowFailures > 0) truncated = true;
  if (total !== undefined && rows.length < Math.min(total, MAX_SESSION_ROWS) && !truncated) {
    truncated = true;
    requestFailures += 1;
  }
  if (failedProfiles.size > 0) truncated = true;
  return { rows, ...(total === undefined ? {} : { total }), truncated, partialFailures: failedProfiles.size + requestFailures + rowFailures + totalFailures };
}

async function boundedRequest(
  request: HermesInventoryRequester,
  path: string,
  deadline: number,
  budget: { bytes: number },
): Promise<unknown> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Hermes inventory deadline exceeded.");
  const result = await request(path, remaining);
  if (!Number.isSafeInteger(result.bytes) || result.bytes < 0 || budget.bytes + result.bytes > MAX_INVENTORY_BYTES) {
    throw new Error("Hermes inventory byte budget exceeded.");
  }
  budget.bytes += result.bytes;
  return result.value;
}

function mappedState(state: CollectionState, mappedLength: number, mappingFailures: number): Omit<CollectionState, "rows"> {
  const total = state.total === undefined ? undefined : Math.max(state.total, mappedLength);
  return {
    ...(total === undefined ? {} : { total }),
    truncated: state.truncated || mappingFailures > 0,
    partialFailures: state.partialFailures + mappingFailures,
  };
}

function unavailableInventory(): CollectedHermesInventory {
  const state = { truncated: true, partialFailures: 1 };
  return { profiles: [], sessions: [], profilesState: { ...state }, sessionsState: { ...state } };
}

type InventoryGeneration = CollectedHermesInventory & {
  token: string;
  signature: string;
  expiresAt: number;
};

export class HermesInventoryCache {
  readonly #generations = new Map<string, InventoryGeneration>();
  readonly #ttlMs: number;
  readonly #maxGenerations: number;
  readonly #now: () => number;

  constructor(options: { ttlMs?: number; maxGenerations?: number; now?: () => number } = {}) {
    this.#ttlMs = Math.max(1, options.ttlMs ?? INVENTORY_GENERATION_TTL_MS);
    this.#maxGenerations = Math.max(1, options.maxGenerations ?? MAX_INVENTORY_GENERATIONS);
    this.#now = options.now ?? Date.now;
  }

  replace(inventory: CollectedHermesInventory): { profiles: ProfileSummary[]; sessions: ChatSessionSummary[]; metadata: OfficeInventoryMetadata } {
    const now = this.#now();
    this.#prune(now);
    const signature = inventorySignature(inventory);
    let generation = [...this.#generations.values()].find((item) => item.signature === signature);
    if (generation === undefined) {
      generation = {
        token: randomBytes(12).toString("base64url"),
        signature,
        expiresAt: now + this.#ttlMs,
        profiles: [...inventory.profiles],
        sessions: [...inventory.sessions],
        profilesState: { ...inventory.profilesState },
        sessionsState: { ...inventory.sessionsState },
      };
    } else {
      generation.expiresAt = now + this.#ttlMs;
      this.#generations.delete(generation.token);
    }
    this.#generations.set(generation.token, generation);
    this.#prune(now);
    const profiles = this.#page(generation, "profiles", 0, SNAPSHOT_PAGE_SIZE);
    const sessions = this.#page(generation, "sessions", 0, SNAPSHOT_PAGE_SIZE);
    return { profiles: [...profiles.profiles], sessions: [...sessions.sessions], metadata: { profiles: profiles.pagination, sessions: sessions.pagination } };
  }

  clear(): void {
    this.#generations.clear();
  }

  page(kind: OfficeInventoryKind, cursor: string, limit: number): OfficeInventoryPage {
    const decoded = decodeCursor(cursor, kind);
    this.#prune(this.#now());
    const generation = this.#generations.get(decoded.token);
    if (generation === undefined) throw new InventoryCursorError("Inventory cursor is stale or invalid.");
    return this.#page(generation, kind, decoded.offset, Math.min(100, Math.max(1, Math.trunc(limit))));
  }

  #page(generation: InventoryGeneration, kind: OfficeInventoryKind, offset: number, limit: number): OfficeInventoryPage {
    const rows = kind === "profiles" ? generation.profiles : generation.sessions;
    const state = kind === "profiles" ? generation.profilesState : generation.sessionsState;
    const window = rows.slice(offset, offset + limit);
    const nextOffset = offset + window.length;
    const hasMore = nextOffset < rows.length;
    const pagination: OfficeInventoryPagination = {
      returned: window.length,
      available: rows.length,
      ...(state.total === undefined ? {} : { total: state.total }),
      hasMore,
      truncated: state.truncated,
      partialFailures: state.partialFailures,
      ...(hasMore ? { nextCursor: encodeCursor(generation.token, kind, nextOffset) } : {}),
    };
    return {
      kind,
      profiles: kind === "profiles" ? window as ProfileSummary[] : [],
      sessions: kind === "sessions" ? window as ChatSessionSummary[] : [],
      pagination,
    };
  }

  #prune(now: number): void {
    for (const [token, generation] of this.#generations) {
      if (generation.expiresAt <= now) this.#generations.delete(token);
    }
    while (this.#generations.size > this.#maxGenerations) {
      const oldest = this.#generations.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#generations.delete(oldest);
    }
  }
}

export class InventoryCursorError extends Error {}

function encodeCursor(token: string, kind: OfficeInventoryKind, offset: number): string {
  return Buffer.from(`v1:${token}:${kind}:${offset}`, "utf8").toString("base64url");
}

function decodeCursor(value: string, kind: OfficeInventoryKind): { token: string; offset: number } {
  if (value.length < 1 || value.length > 256) throw new InventoryCursorError("Inventory cursor is invalid.");
  let decoded: string;
  try { decoded = Buffer.from(value, "base64url").toString("utf8"); }
  catch { throw new InventoryCursorError("Inventory cursor is invalid."); }
  const match = /^v1:([A-Za-z0-9_-]{16}):(profiles|sessions):(0|[1-9][0-9]{0,6})$/.exec(decoded);
  if (match === null || match[2] !== kind) throw new InventoryCursorError("Inventory cursor is stale or invalid.");
  const offset = Number(match[3]);
  if (!Number.isSafeInteger(offset) || offset > MAX_SESSION_ROWS) throw new InventoryCursorError("Inventory cursor is invalid.");
  return { token: match[1]!, offset };
}

function inventorySignature(inventory: CollectedHermesInventory): string {
  return createHash("sha256").update(JSON.stringify(inventory)).digest("base64url");
}

function dedupeRecords(rows: Record<string, unknown>[], keyOf: (row: Record<string, unknown>) => string | undefined): Record<string, unknown>[] {
  const seen = new Set<string>();
  return rows.filter((row) => { const key = keyOf(row); if (key === undefined || seen.has(key)) return false; seen.add(key); return true; });
}

type MappingResult<T> = { items: T[]; failures: number };

function mapProfiles(rows: Record<string, unknown>[], sessions: ChatSessionSummary[]): MappingResult<ProfileSummary> {
  const activeCounts = new Map<string, number>();
  for (const session of sessions) if (session.activity !== "idle") activeCounts.set(session.profileId, (activeCounts.get(session.profileId) ?? 0) + 1);
  const items: ProfileSummary[] = [];
  let failures = 0;
  for (const row of rows) {
    try {
      const name = safeIdentifier(readString(row, "name"), PROFILE_PATTERN);
      if (name === undefined) throw new Error("Hermes profile name is invalid.");
      const active = activeCounts.get(name) ?? 0;
      const rawSkillCount = row.skill_count;
      const parsedSkillCount = nonNegativeInteger(rawSkillCount);
      const skillCount = parsedSkillCount ?? 0;
      if (rawSkillCount !== undefined && parsedSkillCount === undefined) failures += 1;
      items.push({ id: name, name, avatarKey: name, activity: activity(row.gateway_running === true, active), activeSessionCount: active, inheritedSkillCount: 0, ownSkillCount: skillCount, revision: 1 });
    } catch { failures += 1; }
  }
  return { items, failures };
}

function mapSessions(rows: Record<string, unknown>[]): MappingResult<ChatSessionSummary> {
  const items: ChatSessionSummary[] = [];
  let failures = 0;
  for (const row of rows) {
    try {
      const id = safeIdentifier(readString(row, "id"), SESSION_ID_PATTERN);
      const profile = safeIdentifier(readString(row, "profile"), PROFILE_PATTERN);
      if (id === undefined || profile === undefined) throw new Error("Hermes session identity is invalid.");
      const preview = safeInventoryText(readString(row, "preview"), 240);
      const startedAt = optionalEpochToIso(row, "started_at");
      const lastActive = optionalEpochToIso(row, "last_active");
      const endedAt = optionalEpochToIso(row, "ended_at");
      const createdAt = startedAt ?? UNKNOWN_INVENTORY_TIMESTAMP;
      const updatedAt = lastActive ?? endedAt ?? UNKNOWN_INVENTORY_TIMESTAMP;
      const title = safeInventoryText(readString(row, "title"), 240) || "Untitled session";
      const conversationKind = readString(row, "conversation_kind") === "delegated" ? "delegated" as const : undefined;
      const delegationTaskId = safeIdentifier(readString(row, "delegation_task_id"), SESSION_ID_PATTERN);
      const delegatedByProfileId = safeIdentifier(readString(row, "delegated_by_profile"), PROFILE_PATTERN);
      items.push({
        id,
        profileId: profile,
        title,
        activity: row.is_active === true ? "thinking" : "idle",
        createdAt,
        updatedAt,
        ...(preview === undefined ? {} : { lastMessagePreview: preview }),
        ...(conversationKind === undefined ? {} : { conversationKind }),
        ...(delegationTaskId === undefined ? {} : { delegationTaskId }),
        ...(delegatedByProfileId === undefined ? {} : { delegatedByProfileId }),
      });
    } catch { failures += 1; }
  }
  return { items, failures };
}

function safeInventoryText(value: string | undefined, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  return redactSecrets(value).value.slice(0, maxChars).replace(/[\u0000-\u001f\u007f]/g, "");
}

function safeIdentifier(value: string | undefined, pattern: RegExp): string | undefined {
  return value !== undefined && pattern.test(value) ? value : undefined;
}

function activity(gateway: boolean, active: number): AgentActivity { return active > 0 ? "thinking" : gateway ? "idle" : "offline"; }
function optionalEpochToIso(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  // Hermes serializes an unfinished session's optional timestamps as JSON
  // null. Treat null the same as an omitted optional field instead of dropping
  // the otherwise valid session from inventory.
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_EPOCH_SECONDS) {
    throw new Error(`Hermes inventory ${key} timestamp is invalid.`);
  }
  const date = new Date(value * 1_000);
  if (!Number.isFinite(date.valueOf())) throw new Error(`Hermes inventory ${key} timestamp is out of range.`);
  return date.toISOString();
}
function requiredRecordArray(value: unknown, key: string): { records: Record<string, unknown>[]; wireLength: number; invalid: boolean } {
  const rows = isRecord(value) ? value[key] : undefined;
  if (!Array.isArray(rows)) throw new Error(`Hermes inventory ${key} contract is invalid.`);
  const records = rows.filter(isRecord);
  return { records, wireLength: rows.length, invalid: records.length !== rows.length };
}
function optionalRecordArray(value: unknown, key: string): Record<string, unknown>[] {
  const rows = isRecord(value) ? value[key] : undefined;
  if (rows === undefined) return [];
  if (!Array.isArray(rows) || rows.some((row) => !isRecord(row))) throw new Error(`Hermes inventory ${key} contract is invalid.`);
  return rows;
}
function readString(value: unknown, key: string): string | undefined { const item = isRecord(value) ? value[key] : undefined; return typeof item === "string" ? item : undefined; }
function readNumber(value: unknown, key: string): number | undefined { const item = isRecord(value) ? value[key] : undefined; return typeof item === "number" && Number.isFinite(item) ? item : undefined; }
function readNonNegativeInteger(value: unknown, key: string): number | undefined { const item = readNumber(value, key); return item !== undefined && Number.isSafeInteger(item) && item >= 0 ? item : undefined; }
function nonNegativeInteger(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
