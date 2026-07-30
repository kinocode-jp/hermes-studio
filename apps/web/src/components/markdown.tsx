import type { ComponentChild } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { runHostFileAction, isAbsoluteMediaPath, type HostFileAction } from "../host-file-api";
import { t } from "../i18n";

/**
 * Minimal, safe markdown renderer for chat messages.
 * Builds Preact VNodes directly (never innerHTML), so message text is always escaped.
 * Supports: headings, bold/italic, inline code, fenced code blocks,
 * pipe tables, unordered/ordered lists, horizontal rules, links, paragraphs.
 */

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "media"; text: string; path: string; code?: boolean };

// Unquoted files stop at their extension; extensionless paths use a whitespace
// or punctuation boundary. Paths containing spaces should use inline code or
// an angle-bracket Markdown target: `[label](</absolute/path with spaces/file.py>)`.
const INLINE_PATTERN = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\((?:<[^>\n]+>|[^)\s]+)\)|MEDIA:(?:"(?:\/|[A-Za-z]:[\\/]|\\\\)[^"\n]+"|'(?:\/|[A-Za-z]:[\\/]|\\\\)[^'\n]+'|(?:\/|[A-Za-z]:[\\/]|\\\\)[^\n]*?\.[A-Za-z0-9]{1,12}(?=$|[\s,.:;!?)}\]、。！？」』】—–]))|(?:\/|[A-Za-z]:[\\/]|\\\\)[^\s<>"'`()\[\]{}]+[\\/]|(?:\/|[A-Za-z]:[\\/]|\\\\)[^\s<>"'`()\[\]{}]*?\.[A-Za-z0-9]{1,12}(?::\d+(?::\d+)?)?(?=$|[\s,.:;!?)}\]、。！？」』】—–])|(?:\/|[A-Za-z]:[\\/]|\\\\)[^\s<>"'`()\[\]{}:,;!?、。！？」』】—–]+(?=$|[\s,:;!?)}\]、。！？」』】—–]))/g;
const LINK_PATTERN = /^\[([^\]\n]+)\]\((<[^>\n]+>|[^)\s]+)\)$/;
const PATH_POSITION_SUFFIX = /:\d+(?::\d+)?$/;

function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href.trim());
}

export function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) tokens.push({ kind: "text", text: text.slice(lastIndex, index) });
    const raw = match[0];
    if (raw.startsWith("**")) tokens.push({ kind: "bold", text: raw.slice(2, -2) });
    else if (raw.startsWith("*")) tokens.push({ kind: "italic", text: raw.slice(1, -1) });
    else if (raw.startsWith("`")) {
      const value = raw.slice(1, -1);
      const path = localInlineCodePath(value);
      if (path !== undefined) tokens.push({ kind: "media", text: value, path, code: true });
      else tokens.push({ kind: "code", text: value });
    }
    else if (raw.startsWith("MEDIA:")) {
      const path = mediaPathFromToken(raw);
      if (path !== undefined) tokens.push({ kind: "media", text: path, path });
      else tokens.push({ kind: "text", text: raw });
    }
    else if (raw.startsWith("[")) {
      const link = LINK_PATTERN.exec(raw);
      const label = link?.[1] ?? raw;
      const href = link?.[2] ?? "";
      const target = markdownTarget(href);
      const path = localHostPath(target);
      if (path !== undefined) tokens.push({ kind: "media", text: label, path });
      else if (isSafeHref(target)) tokens.push({ kind: "link", text: label, href: target });
      else tokens.push({ kind: "text", text: raw });
    }
    else {
      const path = localInlineCodePath(raw);
      if (path !== undefined && isBarePathBoundary(text, index)) tokens.push({ kind: "media", text: raw, path });
      else tokens.push({ kind: "text", text: raw });
    }
    lastIndex = index + raw.length;
  }
  if (lastIndex < text.length) tokens.push({ kind: "text", text: text.slice(lastIndex) });
  return tokens;
}

function mediaPathFromToken(raw: string): string | undefined {
  let path = raw.slice("MEDIA:".length);
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) {
    path = path.slice(1, -1);
  }
  return isAbsoluteMediaPath(path) ? path : undefined;
}

function markdownTarget(raw: string): string {
  return raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
}

function localFilePath(raw: string): string | undefined {
  const path = localHostPath(raw);
  if (path === undefined) return undefined;
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  return name.includes(".") ? path : undefined;
}

function localInlineCodePath(raw: string): string | undefined {
  const path = localHostPath(raw);
  if (path === undefined) return undefined;
  if (localFilePath(raw) !== undefined || /[\\/]$/.test(raw)) return path;
  return /^(?:\/(?:Applications|Library|System|Users|Volumes|bin|dev|etc|home|mnt|opt|private|root|run|sbin|srv|tmp|usr|var)(?:\/|$)|[A-Za-z]:[\\/]|\\\\)/.test(path)
    ? path
    : undefined;
}

function localHostPath(raw: string): string | undefined {
  const path = raw.replace(PATH_POSITION_SUFFIX, "");
  return isAbsoluteMediaPath(path) ? path : undefined;
}

function isBarePathBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const before = text.slice(0, index);
  if (/[A-Za-z][A-Za-z0-9+.-]*:$/.test(before)) return false;
  return /[\s([{"'「『【<:：=•—–-]/.test(text[index - 1] ?? "");
}

export function codeBlockPathReference(line: string): { text: string; path: string } | undefined {
  const text = line.trim();
  if (text === "" || text.includes("\n")) return undefined;
  if (text.startsWith("MEDIA:")) {
    const path = mediaPathFromToken(text);
    return path === undefined ? undefined : { text: path, path };
  }
  const path = localInlineCodePath(text);
  return path === undefined ? undefined : { text, path };
}

type MediaLinkHandlers = {
  open(path: string, event: MouseEvent): void;
  openMenu(path: string, event: MouseEvent): void;
};

function mediaFileHref(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const encoded = encodeURI(normalized).replace(/#/g, "%23").replace(/\?/g, "%3F");
  return normalized.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
}

function renderMediaLink(
  token: Extract<InlineToken, { kind: "media" }>,
  key: string,
  media?: MediaLinkHandlers,
): ComponentChild {
  return (
    <a
      key={key}
      class="md-media-link"
      href={mediaFileHref(token.path)}
      title={t("chat.media.open")}
      onClick={(event) => {
        event.preventDefault();
        media?.open(token.path, event);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        media?.openMenu(token.path, event);
      }}
    >
      {token.code ? <code>{token.text}</code> : token.text}
    </a>
  );
}

function renderInline(
  text: string,
  keyPrefix: string,
  transformText?: (value: string) => string,
  media?: MediaLinkHandlers,
): ComponentChild[] {
  // Transform the whole inline source so context-sensitive substitutions can
  // see text surrounding Markdown emphasis/link tokens. The profile-name
  // transform preserves code spans before this tokenizer handles them.
  const displayText = transformText ? transformText(text) : text;
  return tokenizeInline(displayText).map((token, index) => {
    const key = `${keyPrefix}:${index}`;
    switch (token.kind) {
      case "bold": return <strong key={key}>{token.text}</strong>;
      case "italic": return <em key={key}>{token.text}</em>;
      case "code": return <code key={key}>{token.text}</code>;
      case "link": return <a key={key} href={token.href} target="_blank" rel="noreferrer noopener">{token.text}</a>;
      case "media": return renderMediaLink(token, key, media);
      default: return token.text;
    }
  });
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "hr" };

const HEADING_PATTERN = /^(#{1,4})\s+(.*)$/;
const LIST_ITEM_PATTERN = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function looksLikeTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && (trimmed.startsWith("|") || trimmed.indexOf("|") > 0);
}

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";

    // Fenced code block
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      index += 1; // skip closing fence
      blocks.push({ kind: "code", lang: fence[1] ?? "", text: codeLines.join("\n") });
      continue;
    }

    // Blank line separates blocks
    if (line.trim() === "") {
      flushParagraph();
      index += 1;
      continue;
    }

    // Heading
    const heading = HEADING_PATTERN.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, text: (heading[2] ?? "").trim() });
      index += 1;
      continue;
    }

    // Horizontal rule (--- alone on a line)
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushParagraph();
      blocks.push({ kind: "hr" });
      index += 1;
      continue;
    }

    // List items (consecutive)
    const listItem = LIST_ITEM_PATTERN.exec(line);
    if (listItem) {
      flushParagraph();
      const ordered = /^\d/.test(listItem[2] ?? "");
      const items: string[] = [];
      while (index < lines.length) {
        const item = LIST_ITEM_PATTERN.exec(lines[index] ?? "");
        if (!item) break;
        if (/^\d/.test(item[2] ?? "") !== ordered) break;
        items.push((item[3] ?? "").trim());
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    // Table: header row + separator row
    if (looksLikeTableRow(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1] ?? "")) {
      flushParagraph();
      const header = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").trim() !== "" && looksLikeTableRow(lines[index] ?? "")) {
        rows.push(splitTableRow(lines[index] ?? ""));
        index += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    // Plain text line
    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  return blocks;
}

function renderBlock(
  block: Block,
  key: string,
  transformText?: (value: string) => string,
  media?: MediaLinkHandlers,
): ComponentChild {
  switch (block.kind) {
    case "heading": {
      const Tag = (`h${Math.min(block.level + 1, 6)}`) as "h2" | "h3" | "h4" | "h5";
      return <Tag key={key}>{renderInline(block.text, key, transformText, media)}</Tag>;
    }
    case "paragraph":
      return <p key={key}>{renderInline(block.text, key, transformText, media)}</p>;
    case "code": {
      const pathLines = block.text.split("\n").map(codeBlockPathReference);
      const references = pathLines.filter((line): line is { text: string; path: string } => line !== undefined);
      if (references.length > 0 && references.length === pathLines.length) {
        return (
          <p key={key} class="md-local-path-list">
            {references.map((line, index) => (
              <span key={`${key}:path-line:${index}`}>
                {renderMediaLink({ kind: "media", ...line }, `${key}:path:${index}`, media)}
                {index < references.length - 1 && <br />}
              </span>
            ))}
          </p>
        );
      }
      return (
        <pre key={key} data-lang={block.lang || undefined}>
          <code>{renderCodeBlock(block.text, key, media)}</code>
        </pre>
      );
    }
    case "list": {
      const items = block.items.map((item, itemIndex) => <li key={`${key}:${itemIndex}`}>{renderInline(item, `${key}:${itemIndex}`, transformText, media)}</li>);
      return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
    case "table":
      return (
        <div key={key} class="md-table-wrap">
          <table>
            <thead>
              <tr>{block.header.map((cell, cellIndex) => <th key={`${key}:h${cellIndex}`}>{renderInline(cell, `${key}:h${cellIndex}`, transformText, media)}</th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${key}:r${rowIndex}`}>
                  {block.header.map((_, cellIndex) => (
                    <td key={`${key}:r${rowIndex}c${cellIndex}`}>{renderInline(row[cellIndex] ?? "", `${key}:r${rowIndex}c${cellIndex}`, transformText, media)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr key={key} />;
    default:
      return null;
  }
}

function renderCodeBlock(text: string, key: string, media?: MediaLinkHandlers): ComponentChild[] {
  const lines = text.split("\n");
  return lines.flatMap((line, index) => {
    const reference = codeBlockPathReference(line);
    const content: ComponentChild = reference === undefined
      ? line
      : renderMediaLink({ kind: "media", ...reference }, `${key}:path:${index}`, media);
    return index < lines.length - 1 ? [content, "\n"] : [content];
  });
}

export function MarkdownBody({ text, streaming, transformText }: { text: string; streaming?: boolean; transformText?: (value: string) => string }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [mediaMenu, setMediaMenu] = useState<{ path: string; left: number; top: number } | null>(null);
  const [mediaBusy, setMediaBusy] = useState<HostFileAction | "copy" | null>(null);
  const [mediaError, setMediaError] = useState(false);

  useEffect(() => {
    if (!mediaMenu) return;
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".media-context-menu")) setMediaMenu(null);
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMediaMenu(null);
    };
    const closeOnResize = () => setMediaMenu(null);
    window.addEventListener("pointerdown", closeOnPointer);
    window.addEventListener("keydown", closeOnKey);
    window.addEventListener("resize", closeOnResize);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointer);
      window.removeEventListener("keydown", closeOnKey);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [mediaMenu]);

  useEffect(() => {
    if (!mediaMenu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const left = Math.min(Math.max(8, mediaMenu.left), Math.max(8, window.innerWidth - rect.width - 8));
    const top = Math.min(Math.max(8, mediaMenu.top), Math.max(8, window.innerHeight - rect.height - 8));
    if (left !== mediaMenu.left || top !== mediaMenu.top) setMediaMenu({ ...mediaMenu, left, top });
  }, [mediaMenu?.path, mediaMenu?.left, mediaMenu?.top]);

  const runMediaAction = async (path: string, action: HostFileAction) => {
    if (mediaBusy) return;
    setMediaBusy(action);
    setMediaError(false);
    try {
      await runHostFileAction(path, action);
      setMediaMenu(null);
    } catch {
      setMediaError(true);
    } finally {
      setMediaBusy(null);
    }
  };

  const openMediaMenu = (path: string, event: MouseEvent) => {
    event.stopPropagation();
    const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const rect = target?.getBoundingClientRect();
    const left = event.clientX || rect?.left || 8;
    const top = event.clientY || rect?.bottom || 8;
    setMediaError(false);
    setMediaBusy(null);
    setMediaMenu({ path, left, top });
  };

  const copyMediaPath = async (path: string) => {
    if (mediaBusy) return;
    setMediaBusy("copy");
    setMediaError(false);
    try {
      await navigator.clipboard.writeText(path);
      setMediaMenu(null);
    } catch {
      setMediaError(true);
    } finally {
      setMediaBusy(null);
    }
  };

  const trimmed = text.trim();
  if (!trimmed) return <div class="md-body">{streaming ? "…" : ""}</div>;
  const blocks = parseBlocks(trimmed);
  const mediaHandlers: MediaLinkHandlers = {
    open: (path) => void runMediaAction(path, "open"),
    openMenu: openMediaMenu,
  };
  const mediaName = mediaMenu?.path.split(/[\\/]/).filter(Boolean).at(-1) ?? mediaMenu?.path ?? "";
  return (
    <div class={`md-body ${streaming ? "is-streaming" : ""}`}>
      {blocks.map((block, index) => renderBlock(block, `b${index}`, transformText, mediaHandlers))}
      {streaming && <span class="md-caret" aria-hidden="true">▍</span>}
      {mediaError && <span class="md-media-error" role="alert">{t("chat.media.actionFailed")}</span>}
      {mediaMenu && (
        <div
          ref={menuRef}
          class="media-context-menu"
          role="menu"
          aria-label={t("chat.media.menu", { name: mediaName })}
          style={{ left: `${mediaMenu.left}px`, top: `${mediaMenu.top}px` }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <strong title={mediaName}>{mediaName}</strong>
          <small title={mediaMenu.path}>{mediaMenu.path}</small>
          <div role="separator" />
          <button type="button" role="menuitem" disabled={mediaBusy !== null} onClick={() => void runMediaAction(mediaMenu.path, "open")}>
            {mediaBusy === "open" ? t("chat.media.opening") : t("chat.media.open")}
          </button>
          <button type="button" role="menuitem" disabled={mediaBusy !== null} onClick={() => void runMediaAction(mediaMenu.path, "reveal")}>
            {mediaBusy === "reveal" ? t("chat.media.revealing") : t("chat.media.reveal")}
          </button>
          <button type="button" role="menuitem" disabled={mediaBusy !== null} onClick={() => void copyMediaPath(mediaMenu.path)}>
            {mediaBusy === "copy" ? t("chat.media.copying") : t("chat.media.copyPath")}
          </button>
        </div>
      )}
    </div>
  );
}
