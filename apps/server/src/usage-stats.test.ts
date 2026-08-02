import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildTokenUsageQuery,
  estimateTokensFromChars,
  estimateTokensFromText,
  tokyoDay,
  tokyoDayOffset,
  TokenUsageStore,
  type TokenUsageRow,
} from "./usage-stats.js";

// 2026-07-20 15:00:00 UTC ≈ 2026-07-21 00:00 JST boundary nearby.
// Use a fixed noon JST instant: 2026-07-20 03:00 UTC = 12:00 JST.
const NOON_JST_2026_07_20 = Date.parse("2026-07-20T03:00:00.000Z");

test("estimateTokensFromChars uses chars/4 with a non-empty floor of 1", () => {
  assert.equal(estimateTokensFromChars(0), 0);
  assert.equal(estimateTokensFromChars(1), 1);
  assert.equal(estimateTokensFromChars(4), 1);
  assert.equal(estimateTokensFromChars(5), 2);
  assert.equal(estimateTokensFromText("abcd"), 1);
  assert.equal(estimateTokensFromText("abcde"), 2);
});

test("tokyoDay rolls over on Asia/Tokyo midnight", () => {
  // 2026-07-20 14:59 UTC = 2026-07-20 23:59 JST
  assert.equal(tokyoDay(Date.parse("2026-07-20T14:59:00.000Z")), "2026-07-20");
  // 2026-07-20 15:00 UTC = 2026-07-21 00:00 JST
  assert.equal(tokyoDay(Date.parse("2026-07-20T15:00:00.000Z")), "2026-07-21");
  assert.equal(tokyoDayOffset("2026-07-20", -1), "2026-07-19");
  assert.equal(tokyoDayOffset("2026-07-01", -1), "2026-06-30");
  assert.equal(tokyoDayOffset("2026-01-01", -1), "2025-12-31");
});

test("store accumulates per day/profile, marks estimate, and caps retention", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-usage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "token-usage.json");
  const store = new TokenUsageStore(file, { flushMs: 0, now: () => NOON_JST_2026_07_20, retentionDays: 90 });

  store.record({ profile: "coder", tokensIn: 40, estimated: true, nowMs: NOON_JST_2026_07_20 });
  store.record({ profile: "coder", tokensOut: 80, estimated: true, nowMs: NOON_JST_2026_07_20 });
  store.record({ profile: "reviewer", tokensOut: 20, estimated: false, nowMs: NOON_JST_2026_07_20 });
  await store.flush();

  const today = await store.query(1, NOON_JST_2026_07_20);
  assert.equal(today.days, 1);
  assert.equal(today.estimated, true);
  assert.equal(today.total.tokensIn, 40);
  assert.equal(today.total.tokensOut, 100);
  assert.equal(today.total.tokens, 140);
  assert.deepEqual(today.profiles, ["coder", "reviewer"]);
  const day = today.daily[0]!;
  assert.equal(day.day, "2026-07-20");
  assert.equal(day.byProfile.find((row) => row.profile === "coder")?.estimated, true);
  assert.equal(day.byProfile.find((row) => row.profile === "reviewer")?.estimated, false);

  // Day rollover: next Tokyo day is a separate bucket.
  const nextDayMs = Date.parse("2026-07-20T15:00:00.000Z");
  store.record({ profile: "coder", tokensIn: 10, estimated: true, nowMs: nextDayMs });
  await store.flush();
  const twoDays = await store.query(2, nextDayMs);
  assert.equal(twoDays.daily.length, 2);
  assert.equal(twoDays.daily[0]!.day, "2026-07-20");
  assert.equal(twoDays.daily[1]!.day, "2026-07-21");
  assert.equal(twoDays.daily[1]!.tokensIn, 10);

  // Retention: rows older than 90 Tokyo days are dropped on write.
  const ancient = tokyoDayOffset("2026-07-20", -100);
  store.record({ profile: "coder", tokensOut: 999, estimated: true, day: ancient, nowMs: NOON_JST_2026_07_20 });
  await store.flush();
  const retained = await store.query(90, NOON_JST_2026_07_20);
  assert.equal(retained.daily.some((row) => row.day === ancient), false);
  assert.equal(retained.total.tokensOut >= 100, true);

  const persisted = JSON.parse(await readFile(file, "utf8")) as { version: number; rows: TokenUsageRow[] };
  assert.equal(persisted.version, 1);
  assert.equal(persisted.rows.some((row) => row.day === ancient), false);
  assert.equal(persisted.rows.every((row) => typeof row.tokensIn === "number" && typeof row.tokensOut === "number"), true);
  assert.equal(JSON.stringify(persisted).includes("hello"), false);
});

test("buildTokenUsageQuery fills empty Tokyo days and preserves estimate flags", () => {
  const rows: TokenUsageRow[] = [
    { day: "2026-07-18", profile: "default", tokensIn: 4, tokensOut: 8, estimated: true },
    { day: "2026-07-20", profile: "default", tokensIn: 0, tokensOut: 16, estimated: false },
  ];
  const query = buildTokenUsageQuery(rows, 3, NOON_JST_2026_07_20);
  assert.equal(query.days, 3);
  assert.deepEqual(query.daily.map((day) => day.day), ["2026-07-18", "2026-07-19", "2026-07-20"]);
  assert.equal(query.daily[1]!.tokens, 0);
  assert.equal(query.daily[0]!.estimated, true);
  assert.equal(query.daily[2]!.estimated, false);
  assert.equal(query.estimated, true);
  assert.equal(query.total.tokens, 28);
});

test("store reloads durable state after restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-usage-reload-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "token-usage.json");
  const first = new TokenUsageStore(file, { flushMs: 0, now: () => NOON_JST_2026_07_20 });
  first.record({ profile: "default", tokensIn: 12, tokensOut: 24, estimated: true, nowMs: NOON_JST_2026_07_20 });
  await first.flush();

  const second = new TokenUsageStore(file, { flushMs: 0, now: () => NOON_JST_2026_07_20 });
  const query = await second.query(1, NOON_JST_2026_07_20);
  assert.equal(query.total.tokensIn, 12);
  assert.equal(query.total.tokensOut, 24);
  assert.equal(query.estimated, true);
});
