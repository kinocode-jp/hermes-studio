import { officeFetchJson } from "./office-api";

const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;
const MAX_PROFILES = 64;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

export type TokenUsageSnapshot = {
  days: number;
  estimated: boolean;
  total: TokenUsageTotals;
  profiles: string[];
  daily: TokenUsageDay[];
};

export type TokenUsageChartBar = {
  day: string;
  /** Short label, e.g. "07/20". */
  label: string;
  tokens: number;
  estimated: boolean;
  segments: Array<{ profile: string; tokens: number; ratio: number }>;
};

/**
 * Loads the last `days` of Studio token usage (Asia/Tokyo day buckets).
 * Defaults to 14 for the office surface chart.
 */
export async function fetchTokenUsage(days = DEFAULT_DAYS): Promise<TokenUsageSnapshot> {
  const window = clampDays(days);
  const response = await officeFetchJson<unknown>(`/api/v1/stats/token-usage?days=${window}`);
  return parseTokenUsageResponse(response, window);
}

export function parseTokenUsageResponse(value: unknown, expectedDays = DEFAULT_DAYS): TokenUsageSnapshot {
  if (!isRecord(value) || !Array.isArray(value.daily) || !Array.isArray(value.profiles) || !isRecord(value.total)) {
    throw new Error("Token usage response is incompatible.");
  }
  const days = clampDays(typeof value.days === "number" ? value.days : expectedDays);
  const profiles = value.profiles
    .filter((item): item is string => typeof item === "string" && PROFILE_PATTERN.test(item))
    .slice(0, MAX_PROFILES);
  const daily = value.daily.flatMap((item): TokenUsageDay[] => {
    if (!isRecord(item) || typeof item.day !== "string" || !DAY_PATTERN.test(item.day) || !Array.isArray(item.byProfile)) {
      return [];
    }
    const byProfile = item.byProfile.flatMap((row): TokenUsageProfileDay[] => {
      if (!isRecord(row) || typeof row.profile !== "string" || !PROFILE_PATTERN.test(row.profile)) return [];
      const tokensIn = sanitizeCount(row.tokensIn);
      const tokensOut = sanitizeCount(row.tokensOut);
      const tokens = sanitizeCount(row.tokens) || tokensIn + tokensOut;
      return [{
        profile: row.profile,
        tokensIn,
        tokensOut,
        tokens,
        estimated: row.estimated !== false,
      }];
    });
    const tokensIn = sanitizeCount(item.tokensIn);
    const tokensOut = sanitizeCount(item.tokensOut);
    const tokens = sanitizeCount(item.tokens) || tokensIn + tokensOut;
    return [{
      day: item.day,
      tokensIn,
      tokensOut,
      tokens,
      estimated: item.estimated === true,
      byProfile,
    }];
  });

  if (daily.length > MAX_DAYS) throw new Error("Token usage response is incompatible.");

  const totalIn = sanitizeCount(value.total.tokensIn);
  const totalOut = sanitizeCount(value.total.tokensOut);
  const totalTokens = sanitizeCount(value.total.tokens) || totalIn + totalOut;

  return {
    days,
    estimated: value.estimated === true || daily.some((day) => day.estimated),
    total: { tokensIn: totalIn, tokensOut: totalOut, tokens: totalTokens },
    profiles,
    daily,
  };
}

/** Pure chart helper: stacked-bar ratios for the last N days (default 14). */
export function buildTokenUsageChart(
  snapshot: TokenUsageSnapshot,
  dayCount = DEFAULT_DAYS,
): { bars: TokenUsageChartBar[]; maxTokens: number; total: number; estimated: boolean } {
  const window = clampDays(dayCount);
  const days = snapshot.daily.slice(-window);
  const maxTokens = Math.max(1, ...days.map((day) => day.tokens));
  const bars: TokenUsageChartBar[] = days.map((day) => {
    const segments = day.byProfile
      .filter((row) => row.tokens > 0)
      .map((row) => ({
        profile: row.profile,
        tokens: row.tokens,
        ratio: day.tokens > 0 ? row.tokens / day.tokens : 0,
      }));
    return {
      day: day.day,
      label: day.day.slice(5).replace("-", "/"),
      tokens: day.tokens,
      estimated: day.estimated,
      segments,
    };
  });
  return {
    bars,
    maxTokens,
    total: snapshot.total.tokens,
    estimated: snapshot.estimated,
  };
}

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value < 1_000) return String(Math.floor(value));
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function clampDays(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(1, Math.trunc(value)));
}

function sanitizeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
