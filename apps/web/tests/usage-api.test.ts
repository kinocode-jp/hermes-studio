import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTokenUsageChart,
  formatTokenCount,
  parseTokenUsageResponse,
  type TokenUsageSnapshot,
} from "../src/usage-api.ts";

test("parseTokenUsageResponse accepts bounded daily totals and drops invalid profiles", () => {
  const parsed = parseTokenUsageResponse({
    days: 3,
    estimated: true,
    total: { tokensIn: 10, tokensOut: 20, tokens: 30 },
    profiles: ["coder", "bad profile!", "reviewer"],
    daily: [
      {
        day: "2026-07-18",
        tokensIn: 4,
        tokensOut: 8,
        tokens: 12,
        estimated: true,
        byProfile: [
          { profile: "coder", tokensIn: 4, tokensOut: 8, tokens: 12, estimated: true },
          { profile: "not valid", tokensIn: 9, tokensOut: 9, tokens: 18, estimated: true },
        ],
      },
      {
        day: "2026-07-19",
        tokensIn: 0,
        tokensOut: 0,
        tokens: 0,
        estimated: false,
        byProfile: [],
      },
      {
        day: "2026-07-20",
        tokensIn: 6,
        tokensOut: 12,
        tokens: 18,
        estimated: false,
        byProfile: [
          { profile: "reviewer", tokensIn: 6, tokensOut: 12, tokens: 18, estimated: false },
        ],
      },
    ],
  }, 3);

  assert.equal(parsed.days, 3);
  assert.equal(parsed.estimated, true);
  assert.deepEqual(parsed.profiles, ["coder", "reviewer"]);
  assert.equal(parsed.daily[0]?.byProfile.length, 1);
  assert.equal(parsed.daily[0]?.byProfile[0]?.profile, "coder");
  assert.equal(parsed.total.tokens, 30);
});

test("buildTokenUsageChart stacks profile segments and reports max height basis", () => {
  const snapshot: TokenUsageSnapshot = {
    days: 3,
    estimated: true,
    total: { tokensIn: 10, tokensOut: 30, tokens: 40 },
    profiles: ["a", "b"],
    daily: [
      {
        day: "2026-07-18",
        tokensIn: 0,
        tokensOut: 0,
        tokens: 0,
        estimated: false,
        byProfile: [],
      },
      {
        day: "2026-07-19",
        tokensIn: 4,
        tokensOut: 6,
        tokens: 10,
        estimated: true,
        byProfile: [
          { profile: "a", tokensIn: 4, tokensOut: 0, tokens: 4, estimated: true },
          { profile: "b", tokensIn: 0, tokensOut: 6, tokens: 6, estimated: true },
        ],
      },
      {
        day: "2026-07-20",
        tokensIn: 6,
        tokensOut: 24,
        tokens: 30,
        estimated: true,
        byProfile: [
          { profile: "a", tokensIn: 6, tokensOut: 24, tokens: 30, estimated: true },
        ],
      },
    ],
  };

  const chart = buildTokenUsageChart(snapshot, 3);
  assert.equal(chart.maxTokens, 30);
  assert.equal(chart.total, 40);
  assert.equal(chart.estimated, true);
  assert.equal(chart.bars.length, 3);
  assert.equal(chart.bars[0]!.tokens, 0);
  assert.equal(chart.bars[1]!.segments.length, 2);
  assert.ok(Math.abs(chart.bars[1]!.segments[0]!.ratio + chart.bars[1]!.segments[1]!.ratio - 1) < 1e-9);
  assert.equal(chart.bars[1]!.label, "07/19");
  assert.equal(chart.bars[2]!.segments[0]!.profile, "a");
});

test("formatTokenCount uses compact monospace-friendly labels", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(1_200), "1.2k");
  assert.equal(formatTokenCount(12_400), "12k");
  assert.equal(formatTokenCount(1_500_000), "1.5M");
});
