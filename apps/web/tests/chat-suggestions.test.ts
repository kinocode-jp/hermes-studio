import assert from "node:assert/strict";
import test from "node:test";
import { buildFollowUpSuggestions, extractAgentFollowUpSuggestions } from "../src/chat-suggestions.ts";

test("agent-authored studio-followups win over heuristics", () => {
  const parsed = extractAgentFollowUpSuggestions(`答えです。\n<studio-followups>\n- 実装差分を見せて\n- テスト結果を要約して\n- 残課題は？\n</studio-followups>`);
  assert.equal(parsed.body, "答えです。");
  assert.deepEqual(parsed.suggestions, ["実装差分を見せて", "テスト結果を要約して", "残課題は？"]);
  assert.deepEqual(buildFollowUpSuggestions(`答えです。\n<studio-followups>\n- 実装差分を見せて\n- テスト結果を要約して\n- 残課題は？\n</studio-followups>`, "ja"), parsed.suggestions);
});

test("list-heavy replies produce content-specific chips instead of only stock phrases", () => {
  const chips = buildFollowUpSuggestions(`## 進捗\n- 表示名実装\n- テスト追加\n完了です。`, "ja");
  assert.equal(chips.length, 3);
  assert.match(chips[0]!, /表示名実装/);
  assert.match(chips[1]!, /テスト追加|進捗/);
  assert.equal(chips.includes("次にやるべきことを3つに要約して"), false);
});

test("generic bullet fallbacks use concise とは questions", () => {
  const chips = buildFollowUpSuggestions(`対応状況です。\n- 公式HyperFramesを導入済み\n- Node.js 22が動作`, "ja");
  assert.equal(chips[0], "「公式HyperFramesを導入済み」とは？");
  assert.equal(chips[1], "「Node.js 22が動作」とは？");
});

test("fenced paths become actionable chips", () => {
  const chips = buildFollowUpSuggestions("更新: `apps/web/src/chat-suggestions.ts` と t_6d732d7d", "ja");
  assert.ok(chips.some((chip) => chip.includes("apps/web/src/chat-suggestions.ts")));
  assert.ok(chips.some((chip) => chip.includes("t_6d732d7d")));
});

test("list topics become natural continuations instead of repeated next-step templates", () => {
  const chips = buildFollowUpSuggestions(`調査した候補です。
- Codex、Claude Code、Grok、OpenAI
- 動画1本を渡すだけで自動編集
- Whisperによる文字起こし`, "ja");
  assert.equal(chips.length, 3);
  assert.ok(chips.some((chip) => chip.includes("比較して")));
  assert.ok(chips.some((chip) => chip.includes("詳しく調べて")));
  assert.equal(chips.some((chip) => chip.includes("次の一手")), false);
});

test("legacy authored next-step templates are rewritten", () => {
  const chips = buildFollowUpSuggestions(`答えです。
<studio-followups>
- 「Whisperによる文字起こし」について次の一手は？
</studio-followups>`, "ja");
  assert.deepEqual(chips, ["「Whisperによる文字起こし」をもう少し詳しく調べて"]);
});
