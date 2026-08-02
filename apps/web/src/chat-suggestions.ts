/**
 * Builds up to three short follow-up prompts from the latest assistant reply.
 * Prefers agent-authored <studio-followups> chips; otherwise derives concrete
 * prompts from the reply body. Stock phrases are only a last-resort fill.
 */
export function buildFollowUpSuggestions(agentText: string, locale: "ja" | "en" = "ja"): string[] {
  const text = agentText.trim();
  if (!text) return defaultSuggestions(locale);

  const authored = extractAgentFollowUpSuggestions(text);
  if (authored.suggestions.length > 0) {
    return uniqueStrings(authored.suggestions.map((item) => naturalizeSuggestion(item, locale))).slice(0, 3);
  }

  const body = authored.body.trim() || text;
  const contentDriven = uniqueStrings([
    ...extractQuestions(body),
    ...extractActionItems(body, locale),
    ...extractOutlinePrompts(body, locale),
    ...extractKeywordPrompts(body, locale),
    // Bullets last: action chips already cover list items with a stronger prompt.
    ...extractBulletPrompts(body, locale),
  ]);
  if (contentDriven.length >= 3) return contentDriven.slice(0, 3);

  const merged = uniqueStrings([
    ...contentDriven,
    ...contextualDefaults(body, locale),
  ]);
  return (merged.length > 0 ? merged : defaultSuggestions(locale)).slice(0, 3);
}

/** Extract an agent-authored follow-up envelope and remove it from the reply. */
export function extractAgentFollowUpSuggestions(text: string): { body: string; suggestions: string[] } {
  // Accept the footer even when trailing whitespace or an extra blank line
  // follows it, and tolerate common accidental code-fence wrappers.
  const unfenced = text
    .replace(/\s*```(?:text|markdown|md)?\s*(<studio-followups>[\s\S]*?<\/studio-followups>)\s*```\s*$/i, "\n$1")
    .trimEnd();
  const match = unfenced.match(/\s*<studio-followups>\s*([\s\S]*?)\s*<\/studio-followups>\s*$/i);
  if (!match) return { body: text, suggestions: [] };
  const suggestions = uniqueStrings(
    match[1]!.split(/\n+/)
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
      .map((line) => line.replace(/^["'「『]|["'」』]$/g, "").trim())
      .filter((line) => line.length >= 3 && line.length <= 160),
  ).slice(0, 3);
  return { body: unfenced.slice(0, match.index ?? unfenced.length).trimEnd(), suggestions };
}

function extractQuestions(text: string): string[] {
  const lines = text.split(/\n+/).map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim());
  const questions = lines.filter((line) => /[?？]$/.test(line) && line.length >= 8 && line.length <= 80);
  const inline = [...text.matchAll(/([^\n。.!?]{8,80}[?？])/g)]
    .map((match) => match[1]!.trim())
    .filter((line) => !line.includes("```"));
  return uniqueStrings([...questions, ...inline]);
}

function extractActionItems(text: string, locale: "ja" | "en"): string[] {
  // Only treat list-like lines as actions. Full paragraphs that merely mention
  // words like 調査/実装 must not become awkward chips.
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const out: string[] = [];
  for (const line of lines) {
    if (!/^(?:[-*•]|\d+[.)]|\*\*)/.test(line)) continue;
    const bare = line
      .replace(/^[-*•]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/^\*\*(.+?)\*\*:?\s*/, "$1: ")
      .trim();
    if (bare.length < 4 || bare.length > 60) continue;
    if (bare.startsWith("```") || bare.startsWith("|")) continue;
    out.push(/[?？]$/.test(bare) ? bare : continuationForTopic(bare, locale));
  }
  return uniqueStrings(out).slice(0, 3);
}

function extractBulletPrompts(text: string, locale: "ja" | "en"): string[] {
  const bullets = [...text.matchAll(/^\s*(?:[-*•]|\d+[.)])\s+(.+)$/gm)]
    .map((match) => match[1]!.replace(/\*\*/g, "").trim())
    .filter((line) => line.length >= 4 && line.length <= 60)
    .filter((line) => !/^[`|]/.test(line));
  return uniqueStrings(bullets.slice(0, 5).map((item) => (
    continuationForTopic(item, locale)
  )));
}

function extractOutlinePrompts(text: string, locale: "ja" | "en"): string[] {
  const headings = [...text.matchAll(/^#{1,3}\s+(.+)$/gm)]
    .map((match) => match[1]!.replace(/\*\*/g, "").trim())
    .filter((line) => line.length >= 2 && line.length <= 60);
  return headings.slice(0, 3).map((heading) => (
    continuationForTopic(heading, locale)
  ));
}

function extractKeywordPrompts(text: string, locale: "ja" | "en"): string[] {
  // Pull fenced identifiers / path-like tokens so chips can target real artifacts.
  const tokens = uniqueStrings([
    ...[...text.matchAll(/`([^`\n]{3,48})`/g)].map((match) => match[1]!.trim()),
    ...[...text.matchAll(/\b([A-Za-z0-9_.\/-]{3,48}\.(?:ts|tsx|js|py|md|json|yml|yaml))\b/g)].map((match) => match[1]!),
    ...[...text.matchAll(/\b(t_[a-z0-9]{6,})\b/g)].map((match) => match[1]!),
  ]).slice(0, 4);
  return tokens.map((token) => (
    locale === "ja" ? `${token} の内容を見せて` : `Show me what is in ${token}`
  ));
}

function contextualDefaults(text: string, locale: "ja" | "en"): string[] {
  const lower = text.toLowerCase();
  if (locale === "ja") {
    const out: string[] = [];
    if (/コード|実装|typescript|python|api|bug|エラー|修正/.test(lower) || /エラー|実装|修正/.test(text)) {
      out.push("変更内容をファイルごとに見せて", "見落としやすい失敗ケースも確認して", "残っている懸念点を教えて");
    } else if (/調査|比較|レビュー|分析|監査/.test(text)) {
      out.push("候補を比較表にまとめて", "いちばんおすすめの案を理由付きで教えて", "実際に使い始める手順を教えて");
    } else {
      out.push("いちばんおすすめの案を教えて", "具体例を交えて説明して", "実際に進める手順を教えて");
    }
    return uniqueStrings(out);
  }
  const out: string[] = [];
  if (/code|implement|typescript|python|api|bug|error|fix/.test(lower)) {
    out.push("Show the changes file by file", "Check the easy-to-miss failure cases", "Tell me what concerns remain");
  } else if (/research|compare|review|analy|audit/.test(lower)) {
    out.push("Put the candidates in a comparison table", "Recommend one option and explain why", "Show me how to get started");
  } else {
    out.push("Recommend the best option", "Explain it with a concrete example", "Show me how to proceed");
  }
  return uniqueStrings(out);
}

function defaultSuggestions(locale: "ja" | "en"): string[] {
  return locale === "ja"
    ? ["いちばんおすすめの案を教えて", "具体例を交えて説明して", "実際に進める手順を教えて"]
    : ["Recommend the best option", "Explain it with a concrete example", "Show me how to proceed"];
}

function naturalizeSuggestion(value: string, locale: "ja" | "en"): string {
  if (locale === "ja") {
    const quotedNextStep = value.match(/^「(.+?)」について次の一手は[？?]?$/);
    if (quotedNextStep) return continuationForTopic(quotedNextStep[1]!, locale);
    const nextStep = value.match(/^(.+?)について次の一手は[？?]?$/);
    if (nextStep) return continuationForTopic(nextStep[1]!, locale);
    const proposedNextStep = value.match(/^(.+?)\s*を前提に次の一手を提案して$/);
    if (proposedNextStep) return continuationForTopic(proposedNextStep[1]!, locale);
    return value;
  }
  const nextStep = value.match(/^(?:What is the next step for:\s*|Propose the next step for\s+)(.+?)[?]?$/i);
  return nextStep ? continuationForTopic(nextStep[1]!, locale) : value;
}

function continuationForTopic(value: string, locale: "ja" | "en"): string {
  const topic = truncate(value.replace(/\*\*/g, "").replace(/^['"「『]|['"」』]$/g, "").trim(), locale === "ja" ? 34 : 44);
  const lower = topic.toLowerCase();
  if (locale === "ja") {
    if (/比較|候補|違い|選択肢/.test(topic) || /(?:codex|claude|grok|openai).*(?:codex|claude|grok|openai)/i.test(topic)) {
      return `「${topic}」を比較して、用途別のおすすめを教えて`;
    }
    if (/実装|変更|修正|追加|[/.][a-z0-9_-]+\.(?:ts|tsx|js|py|md|json|ya?ml)$/i.test(topic)) {
      return `「${topic}」の変更内容を見せて`;
    }
    if (/手順|方法|使い方/.test(topic)) return `「${topic}」を具体的な手順にして`;
    if (/動画|音声|whisper|文字起こし|スキル|ツール|リポジトリ/i.test(topic)) {
      return `「${topic}」をもう少し詳しく調べて`;
    }
    return `「${topic}」とは？`;
  }
  if (/compare|candidate|difference|option/.test(lower)) return `Compare “${topic}” and recommend the best fit`;
  if (/implement|change|fix|add|[/.][a-z0-9_-]+\.(?:ts|tsx|js|py|md|json|ya?ml)$/i.test(topic)) return `Show me the changes for “${topic}”`;
  if (/steps|method|how to|usage/.test(lower)) return `Turn “${topic}” into concrete steps`;
  return `Tell me more about “${topic}”`;
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
