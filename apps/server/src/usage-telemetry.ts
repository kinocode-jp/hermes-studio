import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { HermesChatEvent } from "./hermes-chat.js";

/** Office-owned skill / MCP / tool usage telemetry (names + counts only). */

export type UsageKind = "skill" | "mcp" | "tool";

export type UsageItemState = {
  kind: UsageKind;
  total: number;
  lastUsedAt: string;
  days: Record<string, number>;
};

export type UsageTelemetryFile = {
  version: 1;
  /** Per-profile item maps keyed by `${kind}::${name}`. */
  profiles: Record<string, { items: Record<string, UsageItemState> }>;
};

export type UsageStatItem = {
  kind: UsageKind;
  name: string;
  total: number;
  lastUsedAt: string;
  periodCount: number;
};

export type UsageStatsDto = {
  profile: string;
  days: number;
  items: UsageStatItem[];
};

export type UsageTelemetryOptions = {
  filePath: string;
  /** Clock for day keys and lastUsedAt (ms since epoch). */
  now?: () => number;
  retentionDays?: number;
  /**
   * Optional skill-name resolver used to classify tool names as skills.
   * Must be fail-safe (never throw to the chat path); may be async.
   */
  resolveSkillNames?: (profile: string) => ReadonlySet<string> | Promise<ReadonlySet<string>>;
};

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NAME_MAX = 120;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_PERIOD_DAYS = 30;
const MAX_PERIOD_DAYS = 90;
const MCP_NAME_PATTERN = /^mcp(?:__|:|\/)/i;
const TOOL_EVENT_TYPES = new Set(["tool.start"]);

/**
 * Classify an observed tool/skill name.
 * - MCP: prefixes `mcp__`, `mcp:`, `mcp/`
 * - Skill: exact/case-insensitive match against the profile skill set (when known)
 * - Otherwise: generic tool
 */
export function classifyUsageName(name: string, skillNames: ReadonlySet<string> = new Set()): UsageKind {
  return classifyUsage(name, skillNames).kind;
}

/** Resolve kind + canonical name (skills prefer the profile skill list spelling). */
export function classifyUsage(
  name: string,
  skillNames: ReadonlySet<string> = new Set(),
): { kind: UsageKind; name: string } {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { kind: "tool", name: trimmed };
  if (MCP_NAME_PATTERN.test(trimmed)) return { kind: "mcp", name: trimmed };
  if (skillNames.has(trimmed)) return { kind: "skill", name: trimmed };
  const lower = trimmed.toLocaleLowerCase();
  for (const skill of skillNames) {
    if (skill.toLocaleLowerCase() === lower) return { kind: "skill", name: skill };
  }
  return { kind: "tool", name: trimmed };
}

export function itemKey(kind: UsageKind, name: string): string {
  return `${kind}::${name}`;
}

/** Calendar day key in Asia/Tokyo as `YYYY-MM-DD`. */
export function tokyoDayKey(atMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(atMs));
}

/** Shift a `YYYY-MM-DD` civil day key (Tokyo calendar keys use pure date arithmetic). */
export function shiftTokyoDayKey(dayKey: string, deltaDays: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (match === null) throw new Error("Invalid Tokyo day key.");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + deltaDays);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function pruneDayMap(
  days: Record<string, number>,
  todayKey: string,
  retentionDays: number,
): Record<string, number> {
  const keep = new Set<string>();
  keep.add(todayKey);
  let cursor = todayKey;
  for (let i = 1; i < retentionDays; i += 1) {
    cursor = shiftTokyoDayKey(cursor, -1);
    keep.add(cursor);
  }
  const next: Record<string, number> = {};
  for (const [key, count] of Object.entries(days)) {
    if (keep.has(key) && Number.isFinite(count) && count > 0) next[key] = Math.trunc(count);
  }
  return next;
}

export function periodCountFromDays(
  days: Record<string, number>,
  todayKey: string,
  periodDays: number,
): number {
  if (periodDays <= 0) return 0;
  let total = 0;
  let cursor = todayKey;
  for (let i = 0; i < periodDays; i += 1) {
    total += days[cursor] ?? 0;
    if (i + 1 < periodDays) cursor = shiftTokyoDayKey(cursor, -1);
  }
  return total;
}

export class UsageTelemetryStore {
  readonly #filePath: string;
  readonly #now: () => number;
  readonly #retentionDays: number;
  readonly #resolveSkillNames?: (profile: string) => ReadonlySet<string> | Promise<ReadonlySet<string>>;
  readonly #skillCache = new Map<string, { names: ReadonlySet<string>; expiresAt: number }>();
  #chain: Promise<void> = Promise.resolve();
  #memory: UsageTelemetryFile | undefined;

  constructor(options: UsageTelemetryOptions) {
    this.#filePath = options.filePath;
    this.#now = options.now ?? Date.now;
    this.#retentionDays = Math.max(1, Math.min(365, options.retentionDays ?? DEFAULT_RETENTION_DAYS));
    if (options.resolveSkillNames !== undefined) {
      this.#resolveSkillNames = options.resolveSkillNames;
    }
  }

  /** Remember skill names for classification (e.g. after a settings load). Fail-safe. */
  rememberSkillNames(profile: string, names: Iterable<string>): void {
    try {
      if (!PROFILE_PATTERN.test(profile)) return;
      const set = new Set<string>();
      for (const name of names) {
        if (typeof name === "string" && name.trim().length > 0 && name.length <= NAME_MAX) set.add(name.trim());
      }
      this.#skillCache.set(profile, { names: set, expiresAt: this.#now() + 10 * 60_000 });
    } catch {
      // Telemetry must never affect settings/chat.
    }
  }

  /**
   * Observe a normalized chat event. Fail-safe: never throws to the caller.
   * Counts only `tool.start` (one observation per invocation).
   */
  observeChatEvent(event: HermesChatEvent, profileHint?: string): void {
    try {
      if (!TOOL_EVENT_TYPES.has(event.type)) return;
      const name = typeof event.payload.name === "string" ? sanitizeName(event.payload.name) : undefined;
      if (name === undefined) return;
      const profile = sanitizeProfile(profileHint) ?? sanitizeProfile(event.profile);
      if (profile === undefined) return;
      void this.#enqueue(async () => {
        const skills = await this.#skillNames(profile);
        const classified = classifyUsage(name, skills);
        await this.#recordLocked(profile, classified.kind, classified.name, this.#now());
      });
    } catch {
      // never break chat
    }
  }

  /** Direct record for tests / internal use. Fail-safe when `safe` is true (default). */
  async record(
    profile: string,
    name: string,
    options: { kind?: UsageKind; atMs?: number; skillNames?: ReadonlySet<string>; safe?: boolean } = {},
  ): Promise<void> {
    const safe = options.safe !== false;
    try {
      const cleanProfile = sanitizeProfile(profile);
      const cleanName = sanitizeName(name);
      if (cleanProfile === undefined || cleanName === undefined) return;
      await this.#enqueue(async () => {
        const skills = options.skillNames ?? await this.#skillNames(cleanProfile);
        const classified = options.kind === undefined
          ? classifyUsage(cleanName, skills)
          : { kind: options.kind, name: cleanName };
        await this.#recordLocked(cleanProfile, classified.kind, classified.name, options.atMs ?? this.#now());
      });
    } catch (error) {
      if (!safe) throw error;
    }
  }

  async query(profile: string, days = DEFAULT_PERIOD_DAYS): Promise<UsageStatsDto> {
    const cleanProfile = sanitizeProfile(profile) ?? "default";
    const periodDays = clampPeriodDays(days);
    const state = await this.#load();
    const todayKey = tokyoDayKey(this.#now());
    const bucket = state.profiles[cleanProfile];
    const items: UsageStatItem[] = [];
    if (bucket !== undefined) {
      for (const [key, item] of Object.entries(bucket.items)) {
        const name = nameFromKey(key, item.kind);
        if (name === undefined) continue;
        items.push({
          kind: item.kind,
          name,
          total: item.total,
          lastUsedAt: item.lastUsedAt,
          periodCount: periodCountFromDays(item.days, todayKey, periodDays),
        });
      }
    }
    items.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind.localeCompare(right.kind);
      return left.name.localeCompare(right.name);
    });
    return { profile: cleanProfile, days: periodDays, items };
  }

  /** Test helper: wait for queued writes. */
  async flush(): Promise<void> {
    await this.#chain;
  }

  async #skillNames(profile: string): Promise<ReadonlySet<string>> {
    const cached = this.#skillCache.get(profile);
    if (cached !== undefined && cached.expiresAt > this.#now()) return cached.names;
    if (this.#resolveSkillNames === undefined) return cached?.names ?? new Set();
    try {
      const names = await this.#resolveSkillNames(profile);
      const set = names instanceof Set ? names : new Set(names);
      this.#skillCache.set(profile, { names: set, expiresAt: this.#now() + 10 * 60_000 });
      return set;
    } catch {
      return cached?.names ?? new Set();
    }
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#chain.then(operation, operation);
    this.#chain = next.then(() => undefined, () => undefined);
    return next;
  }

  async #recordLocked(profile: string, kind: UsageKind, name: string, atMs: number): Promise<void> {
    const state = await this.#load();
    const bucket = state.profiles[profile] ?? { items: {} };
    const key = itemKey(kind, name);
    const dayKey = tokyoDayKey(atMs);
    const existing = bucket.items[key];
    const days = { ...(existing?.days ?? {}) };
    days[dayKey] = (days[dayKey] ?? 0) + 1;
    const pruned = pruneDayMap(days, dayKey, this.#retentionDays);
    bucket.items[key] = {
      kind,
      total: (existing?.total ?? 0) + 1,
      lastUsedAt: new Date(atMs).toISOString(),
      days: pruned,
    };
    // Drop other items' stale day keys opportunistically (bounded).
    for (const [otherKey, other] of Object.entries(bucket.items)) {
      if (otherKey === key) continue;
      other.days = pruneDayMap(other.days, dayKey, this.#retentionDays);
    }
    state.profiles[profile] = bucket;
    this.#memory = state;
    await atomicWriteJson(this.#filePath, state);
  }

  async #load(): Promise<UsageTelemetryFile> {
    if (this.#memory !== undefined) return structuredClone(this.#memory);
    let raw: string;
    try {
      raw = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      const empty: UsageTelemetryFile = { version: 1, profiles: {} };
      this.#memory = empty;
      return structuredClone(empty);
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      const normalized = normalizeFile(parsed);
      this.#memory = normalized;
      return structuredClone(normalized);
    } catch {
      // A file that was read successfully but is not valid JSON can recover to
      // an empty store. Transient filesystem errors above remain retryable and
      // must never be cached as empty or overwrite valid telemetry later.
      const empty: UsageTelemetryFile = { version: 1, profiles: {} };
      this.#memory = empty;
      return structuredClone(empty);
    }
  }
}

function sanitizeProfile(value: unknown): string | undefined {
  return typeof value === "string" && PROFILE_PATTERN.test(value) ? value : undefined;
}

function sanitizeName(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX) return undefined;
  // Names are public labels only; reject control chars.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

function clampPeriodDays(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_PERIOD_DAYS;
  return Math.max(1, Math.min(MAX_PERIOD_DAYS, Math.trunc(days)));
}

function nameFromKey(key: string, kind: UsageKind): string | undefined {
  const prefix = `${kind}::`;
  if (!key.startsWith(prefix)) return undefined;
  const name = key.slice(prefix.length);
  return name.length > 0 ? name : undefined;
}

function normalizeFile(value: unknown): UsageTelemetryFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.profiles)) {
    return { version: 1, profiles: {} };
  }
  const profiles: UsageTelemetryFile["profiles"] = {};
  for (const [profile, bucket] of Object.entries(value.profiles)) {
    if (!PROFILE_PATTERN.test(profile) || !isRecord(bucket) || !isRecord(bucket.items)) continue;
    const items: Record<string, UsageItemState> = {};
    for (const [key, item] of Object.entries(bucket.items)) {
      const normalized = normalizeItem(item);
      if (normalized === undefined) continue;
      const name = nameFromKey(key, normalized.kind);
      if (name === undefined) continue;
      items[itemKey(normalized.kind, name)] = normalized;
    }
    profiles[profile] = { items };
  }
  return { version: 1, profiles };
}

function normalizeItem(value: unknown): UsageItemState | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind !== "skill" && value.kind !== "mcp" && value.kind !== "tool") return undefined;
  const total = Number(value.total);
  if (!Number.isFinite(total) || total < 0) return undefined;
  if (typeof value.lastUsedAt !== "string" || Number.isNaN(Date.parse(value.lastUsedAt))) return undefined;
  if (!isRecord(value.days)) return undefined;
  const days: Record<string, number> = {};
  for (const [day, count] of Object.entries(value.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const n = Number(count);
    if (!Number.isFinite(n) || n <= 0) continue;
    days[day] = Math.trunc(n);
  }
  return {
    kind: value.kind,
    total: Math.trunc(total),
    lastUsedAt: new Date(value.lastUsedAt).toISOString(),
    days,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
