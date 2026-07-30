import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyUsage,
  classifyUsageName,
  periodCountFromDays,
  pruneDayMap,
  shiftTokyoDayKey,
  tokyoDayKey,
  UsageTelemetryStore,
} from "./usage-telemetry.js";

test("classifies mcp prefixes, skill names, and generic tools", () => {
  const skills = new Set(["browser", "code-review"]);
  assert.equal(classifyUsageName("mcp__filesystem__read", skills), "mcp");
  assert.equal(classifyUsageName("mcp:server/tool", skills), "mcp");
  assert.equal(classifyUsageName("mcp/fetch", skills), "mcp");
  assert.equal(classifyUsageName("browser", skills), "skill");
  assert.equal(classifyUsageName("BROWSER", skills), "skill");
  assert.deepEqual(classifyUsage("BROWSER", skills), { kind: "skill", name: "browser" });
  assert.equal(classifyUsageName("terminal", skills), "tool");
  assert.equal(classifyUsageName("unknown", new Set()), "tool");
});

test("tokyo day keys and civil-day shifts stay stable", () => {
  // 2026-03-14 15:00 UTC = 2026-03-15 00:00 JST
  assert.equal(tokyoDayKey(Date.parse("2026-03-14T15:00:00.000Z")), "2026-03-15");
  // 2026-03-14 14:59 UTC still 2026-03-14 in Tokyo
  assert.equal(tokyoDayKey(Date.parse("2026-03-14T14:59:00.000Z")), "2026-03-14");
  assert.equal(shiftTokyoDayKey("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftTokyoDayKey("2026-01-01", -1), "2025-12-31");
});

test("period aggregation sums the inclusive recent window", () => {
  const today = "2026-03-15";
  const days = {
    "2026-03-15": 2,
    "2026-03-14": 3,
    "2026-03-01": 9,
    "2026-02-01": 100,
  };
  assert.equal(periodCountFromDays(days, today, 1), 2);
  assert.equal(periodCountFromDays(days, today, 2), 5);
  assert.equal(periodCountFromDays(days, today, 30), 14);
});

test("retention keeps only the rolling day map window", () => {
  const today = "2026-03-15";
  const days: Record<string, number> = { "2026-03-15": 1 };
  days[shiftTokyoDayKey(today, -89)] = 2;
  days[shiftTokyoDayKey(today, -90)] = 3;
  days[shiftTokyoDayKey(today, -120)] = 4;
  const pruned = pruneDayMap(days, today, 90);
  assert.equal(pruned["2026-03-15"], 1);
  assert.equal(pruned[shiftTokyoDayKey(today, -89)], 2);
  assert.equal(pruned[shiftTokyoDayKey(today, -90)], undefined);
  assert.equal(pruned[shiftTokyoDayKey(today, -120)], undefined);
});

test("store records, classifies, rolls days, aggregates period, and prunes retention", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-usage-"));
  const filePath = join(directory, "usage-telemetry.json");
  let nowMs = Date.parse("2026-03-15T03:00:00.000Z"); // Tokyo 2026-03-15 12:00
  const store = new UsageTelemetryStore({
    filePath,
    now: () => nowMs,
    retentionDays: 90,
  });

  // Outside retention first, then older/recent days so lastUsedAt ends on "today".
  const ancientMs = Date.parse("2025-01-01T03:00:00.000Z");
  await store.record("coder", "browser", { skillNames: new Set(["browser"]), atMs: ancientMs });
  const oldMs = Date.parse("2026-02-01T03:00:00.000Z");
  await store.record("coder", "browser", { skillNames: new Set(["browser"]), atMs: oldMs });
  const yesterdayMs = Date.parse("2026-03-14T03:00:00.000Z");
  await store.record("coder", "browser", { skillNames: new Set(["browser"]), atMs: yesterdayMs });
  await store.record("coder", "browser", { skillNames: new Set(["browser"]), atMs: nowMs });
  await store.record("coder", "browser", { skillNames: new Set(["browser"]), atMs: nowMs });
  await store.record("coder", "mcp__fs__read", { skillNames: new Set(["browser"]), atMs: nowMs });
  await store.record("coder", "terminal", { skillNames: new Set(["browser"]), atMs: nowMs });

  // A later write prunes ancient day keys from every item.
  nowMs = Date.parse("2026-03-15T04:00:00.000Z");
  await store.record("coder", "terminal", { skillNames: new Set(["browser"]), atMs: nowMs });

  const stats = await store.query("coder", 30);
  assert.equal(stats.profile, "coder");
  assert.equal(stats.days, 30);

  const browser = stats.items.find((item) => item.kind === "skill" && item.name === "browser");
  assert.ok(browser);
  assert.equal(browser.total, 5); // ancient + old + yesterday + 2 today
  assert.equal(browser.periodCount, 3); // today 2 + yesterday 1 (Feb 1 and ancient excluded from 30d)
  assert.equal(browser.lastUsedAt, new Date(Date.parse("2026-03-15T03:00:00.000Z")).toISOString());

  const mcp = stats.items.find((item) => item.kind === "mcp" && item.name === "mcp__fs__read");
  assert.ok(mcp);
  assert.equal(mcp.total, 1);
  assert.equal(mcp.periodCount, 1);

  const tool = stats.items.find((item) => item.kind === "tool" && item.name === "terminal");
  assert.ok(tool);
  assert.equal(tool.total, 2);
  assert.equal(tool.periodCount, 2);

  const raw = JSON.parse(await readFile(filePath, "utf8")) as {
    profiles: { coder: { items: Record<string, { days: Record<string, number> }> } };
  };
  const browserDays = raw.profiles.coder.items["skill::browser"]!.days;
  assert.equal(browserDays["2025-01-01"], undefined);
  assert.equal(browserDays["2026-02-01"], 1);
  assert.equal(browserDays["2026-03-14"], 1);
  assert.equal(browserDays["2026-03-15"], 2);
});

test("observeChatEvent only counts tool.start and never throws", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-usage-event-"));
  const filePath = join(directory, "usage.json");
  const store = new UsageTelemetryStore({
    filePath,
    now: () => Date.parse("2026-06-01T00:00:00.000Z"),
  });
  store.rememberSkillNames("default", ["browser"]);

  store.observeChatEvent({ type: "tool.progress", profile: "default", payload: { name: "browser" } });
  store.observeChatEvent({ type: "tool.start", profile: "default", payload: { name: "browser" } });
  store.observeChatEvent({ type: "tool.complete", profile: "default", payload: { name: "browser" } });
  store.observeChatEvent({ type: "tool.start", payload: {} }); // missing name/profile
  // @ts-expect-error intentional bad shape for fail-safe check
  store.observeChatEvent(null);

  await store.flush();
  const stats = await store.query("default", 30);
  assert.equal(stats.items.length, 1);
  assert.equal(stats.items[0]?.kind, "skill");
  assert.equal(stats.items[0]?.total, 1);
});

test("profiles are isolated and default period is 30", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-usage-profile-"));
  const store = new UsageTelemetryStore({
    filePath: join(directory, "usage.json"),
    now: () => Date.parse("2026-06-01T12:00:00.000Z"),
  });
  await store.record("alpha", "shell", { kind: "tool" });
  await store.record("beta", "shell", { kind: "tool" });
  await store.record("beta", "shell", { kind: "tool" });

  const alpha = await store.query("alpha");
  const beta = await store.query("beta");
  assert.equal(alpha.days, 30);
  assert.equal(alpha.items[0]?.total, 1);
  assert.equal(beta.items[0]?.total, 2);
});

test("a transient read failure is retryable and never cached as an empty store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-usage-retry-"));
  const filePath = join(directory, "usage.json");
  await mkdir(filePath);
  const store = new UsageTelemetryStore({
    filePath,
    now: () => Date.parse("2026-06-01T12:00:00.000Z"),
  });

  await assert.rejects(store.query("alpha"));
  await rm(filePath, { recursive: true });
  await writeFile(filePath, `${JSON.stringify({
    version: 1,
    profiles: {
      alpha: {
        items: {
          "tool::shell": {
            kind: "tool", total: 3, lastUsedAt: "2026-06-01T00:00:00.000Z", days: { "2026-06-01": 3 },
          },
        },
      },
    },
  })}\n`, "utf8");

  const recovered = await store.query("alpha");
  assert.equal(recovered.items[0]?.name, "shell");
  assert.equal(recovered.items[0]?.total, 3);
});
