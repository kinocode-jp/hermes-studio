import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

const RETENTION_DAYS = 90;
const DEFAULT_FLUSH_MS = 400;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PROFILES_PER_DAY = 256;
const MAX_TOKENS = Number.MAX_SAFE_INTEGER;

export type TokenUsageRow = {
  day: string;
  profile: string;
  tokensIn: number;
  tokensOut: number;
  estimated: boolean;
};

export type TokenUsageTotals = {
  tokensIn: number;
  tokensOut: number;
  tokens: number;
};

export type TokenUsageProfileDay = TokenUsageTotals & {
  profile: string;
  estimated: boolean;
};

export type TokenUsageDay = TokenUsageTotals & {
  day: string;
  estimated: boolean;
  byProfile: TokenUsageProfileDay[];
};

export type TokenUsageQuery = {
  days: number;
  estimated: boolean;
  total: TokenUsageTotals;
  profiles: string[];
  daily: TokenUsageDay[];
};

export type TokenUsageRecordInput = {
  profile: string;
  tokensIn?: number;
  tokensOut?: number;
  estimated?: boolean;
  /** Override wall clock (tests). Defaults to Asia/Tokyo today. */
  day?: string;
  nowMs?: number;
};

type FileState = {
  version: 1;
  rows: TokenUsageRow[];
};

/**
 * Office-owned daily token counters. Never stores message text — only numeric
 * counts keyed by Tokyo calendar day and Profile. Writes are debounced and
 * never throw into the chat path.
 */
export class TokenUsageStore {
  readonly #filePath: string;
  readonly #retentionDays: number;
  readonly #flushMs: number;
  readonly #now: () => number;
  #rows = new Map<string, TokenUsageRow>();
  #loaded = false;
  #loadPromise: Promise<void> | undefined;
  #dirty = false;
  #flushTimer: NodeJS.Timeout | undefined;
  #mutateChain: Promise<void> = Promise.resolve();
  #writeChain: Promise<void> = Promise.resolve();

  constructor(
    filePath: string,
    options: { retentionDays?: number; flushMs?: number; now?: () => number } = {},
  ) {
    this.#filePath = filePath;
    this.#retentionDays = boundedInteger(options.retentionDays, RETENTION_DAYS, 1, 366);
    this.#flushMs = boundedInteger(options.flushMs, DEFAULT_FLUSH_MS, 0, 10_000);
    this.#now = options.now ?? Date.now;
  }

  /** Fire-and-forget accumulation. Failures never reject the caller. */
  record(input: TokenUsageRecordInput): void {
    this.#mutateChain = this.#mutateChain
      .then(async () => await this.#recordSafe(input))
      .catch(() => undefined);
  }

  async flush(): Promise<void> {
    if (this.#flushTimer !== undefined) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
    }
    await this.#mutateChain.catch(() => undefined);
    await this.#ensureLoaded();
    await this.#writeChain;
    if (!this.#dirty) return;
    this.#writeChain = this.#writeChain.then(async () => {
      if (!this.#dirty) return;
      this.#dirty = false;
      try {
        await this.#persist();
      } catch {
        this.#dirty = true;
      }
    });
    await this.#writeChain;
  }

  async query(days: number, nowMs = this.#now()): Promise<TokenUsageQuery> {
    await this.#ensureLoaded();
    const window = boundedInteger(days, 30, 1, this.#retentionDays);
    return buildTokenUsageQuery([...this.#rows.values()], window, nowMs, this.#retentionDays);
  }

  /** Synchronous query against already-loaded or injected rows (tests). */
  querySync(days: number, nowMs = this.#now()): TokenUsageQuery {
    const window = boundedInteger(days, 30, 1, this.#retentionDays);
    return buildTokenUsageQuery([...this.#rows.values()], window, nowMs, this.#retentionDays);
  }

  /** Test helper: force a loaded empty or provided state without disk I/O. */
  replaceRowsForTests(rows: readonly TokenUsageRow[]): void {
    this.#rows = new Map();
    for (const row of rows) {
      const key = rowKey(row.day, row.profile);
      this.#rows.set(key, { ...row });
    }
    this.#loaded = true;
    this.#dirty = false;
  }

  async #recordSafe(input: TokenUsageRecordInput): Promise<void> {
    await this.#ensureLoaded();
    const profile = normalizeProfile(input.profile);
    if (profile === undefined) return;
    const tokensIn = sanitizeCount(input.tokensIn);
    const tokensOut = sanitizeCount(input.tokensOut);
    if (tokensIn === 0 && tokensOut === 0) return;
    const day = input.day !== undefined && DAY_PATTERN.test(input.day)
      ? input.day
      : tokyoDay(input.nowMs ?? this.#now());
    const estimated = input.estimated !== false;
    const key = rowKey(day, profile);
    const existing = this.#rows.get(key);
    if (existing === undefined) {
      this.#rows.set(key, {
        day,
        profile,
        tokensIn,
        tokensOut,
        estimated,
      });
    } else {
      existing.tokensIn = clampSum(existing.tokensIn, tokensIn);
      existing.tokensOut = clampSum(existing.tokensOut, tokensOut);
      // Once any estimated increment is mixed in, the day/profile stays estimated.
      if (estimated) existing.estimated = true;
    }
    this.#prune(input.nowMs ?? this.#now());
    this.#dirty = true;
    this.#scheduleFlush();
  }

  #scheduleFlush(): void {
    if (this.#flushMs === 0) {
      void this.flush();
      return;
    }
    if (this.#flushTimer !== undefined) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      void this.flush();
    }, this.#flushMs);
    this.#flushTimer.unref?.();
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    if (this.#loadPromise !== undefined) {
      await this.#loadPromise;
      return;
    }
    this.#loadPromise = (async () => {
      try {
        const raw = await readFile(this.#filePath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        const rows = parseFileState(parsed);
        this.#rows = new Map(rows.map((row) => [rowKey(row.day, row.profile), row]));
        this.#prune(this.#now());
      } catch {
        this.#rows = new Map();
      } finally {
        this.#loaded = true;
        this.#loadPromise = undefined;
      }
    })();
    await this.#loadPromise;
  }

  #prune(nowMs: number): void {
    const cutoff = tokyoDayOffset(tokyoDay(nowMs), -(this.#retentionDays - 1));
    for (const [key, row] of this.#rows) {
      if (row.day < cutoff) this.#rows.delete(key);
    }
  }

  async #persist(): Promise<void> {
    const state: FileState = {
      version: 1,
      rows: [...this.#rows.values()].sort((left, right) => {
        if (left.day !== right.day) return left.day < right.day ? -1 : 1;
        return left.profile < right.profile ? -1 : left.profile > right.profile ? 1 : 0;
      }),
    };
    await atomicWriteJson(this.#filePath, state);
  }
}

/** Estimate tokens from character count (≈ chars/4). Always at least 1 for non-empty text. */
export function estimateTokensFromChars(charCount: number): number {
  if (!Number.isFinite(charCount) || charCount <= 0) return 0;
  return Math.max(1, Math.ceil(charCount / 4));
}

export function estimateTokensFromText(text: string): number {
  return estimateTokensFromChars(text.length);
}

/** Calendar day in Asia/Tokyo as YYYY-MM-DD. */
export function tokyoDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/**
 * Shift a YYYY-MM-DD Tokyo day by `deltaDays` using pure civil arithmetic
 * (no local TZ dependence).
 */
export function tokyoDayOffset(day: string, deltaDays: number): string {
  if (!DAY_PATTERN.test(day) || !Number.isSafeInteger(deltaDays)) return day;
  const [yearText, monthText, dayText] = day.split("-");
  const utc = Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText) + deltaDays);
  const date = new Date(utc);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${dayOfMonth}`;
}

export function buildTokenUsageQuery(
  rows: readonly TokenUsageRow[],
  days: number,
  nowMs: number,
  retentionDays = RETENTION_DAYS,
): TokenUsageQuery {
  const window = boundedInteger(days, 30, 1, retentionDays);
  const today = tokyoDay(nowMs);
  const start = tokyoDayOffset(today, -(window - 1));
  const dayList: string[] = [];
  for (let offset = 0; offset < window; offset += 1) {
    dayList.push(tokyoDayOffset(start, offset));
  }
  const daySet = new Set(dayList);
  const profiles = new Set<string>();
  const byDay = new Map<string, Map<string, TokenUsageRow>>();
  let anyEstimated = false;

  for (const row of rows) {
    if (!daySet.has(row.day) || !PROFILE_PATTERN.test(row.profile)) continue;
    profiles.add(row.profile);
    let profileMap = byDay.get(row.day);
    if (profileMap === undefined) {
      profileMap = new Map();
      byDay.set(row.day, profileMap);
    }
    if (profileMap.size >= MAX_PROFILES_PER_DAY && !profileMap.has(row.profile)) continue;
    profileMap.set(row.profile, row);
    if (row.estimated) anyEstimated = true;
  }

  const profileList = [...profiles].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const daily: TokenUsageDay[] = dayList.map((day) => {
    const profileMap = byDay.get(day);
    const byProfile: TokenUsageProfileDay[] = [];
    let tokensIn = 0;
    let tokensOut = 0;
    let dayEstimated = false;
    if (profileMap !== undefined) {
      for (const profile of profileList) {
        const row = profileMap.get(profile);
        if (row === undefined) continue;
        const inCount = sanitizeCount(row.tokensIn);
        const outCount = sanitizeCount(row.tokensOut);
        byProfile.push({
          profile,
          tokensIn: inCount,
          tokensOut: outCount,
          tokens: clampSum(inCount, outCount),
          estimated: row.estimated,
        });
        tokensIn = clampSum(tokensIn, inCount);
        tokensOut = clampSum(tokensOut, outCount);
        if (row.estimated) dayEstimated = true;
      }
    }
    return {
      day,
      tokensIn,
      tokensOut,
      tokens: clampSum(tokensIn, tokensOut),
      estimated: dayEstimated,
      byProfile,
    };
  });

  let totalIn = 0;
  let totalOut = 0;
  for (const day of daily) {
    totalIn = clampSum(totalIn, day.tokensIn);
    totalOut = clampSum(totalOut, day.tokensOut);
  }

  return {
    days: window,
    estimated: anyEstimated,
    total: { tokensIn: totalIn, tokensOut: totalOut, tokens: clampSum(totalIn, totalOut) },
    profiles: profileList,
    daily,
  };
}

function parseFileState(value: unknown): TokenUsageRow[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.rows)) return [];
  const rows: TokenUsageRow[] = [];
  for (const item of value.rows) {
    if (!isRecord(item)) continue;
    if (typeof item.day !== "string" || !DAY_PATTERN.test(item.day)) continue;
    if (typeof item.profile !== "string" || !PROFILE_PATTERN.test(item.profile)) continue;
    const tokensIn = sanitizeCount(item.tokensIn);
    const tokensOut = sanitizeCount(item.tokensOut);
    if (tokensIn === 0 && tokensOut === 0) continue;
    rows.push({
      day: item.day,
      profile: item.profile,
      tokensIn,
      tokensOut,
      estimated: item.estimated !== false,
    });
    if (rows.length >= RETENTION_DAYS * MAX_PROFILES_PER_DAY) break;
  }
  return rows;
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

function rowKey(day: string, profile: string): string {
  return `${day}\0${profile}`;
}

function normalizeProfile(value: string): string | undefined {
  return PROFILE_PATTERN.test(value) ? value : undefined;
}

function sanitizeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_TOKENS, Math.floor(value));
}

function clampSum(left: number, right: number): number {
  const sum = left + right;
  return sum > MAX_TOKENS ? MAX_TOKENS : sum;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
