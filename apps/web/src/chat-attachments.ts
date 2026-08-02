import { isChatPromptWithinBudget } from "@hermes-studio/protocol";

export type ChatAttachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "file";
  /** data URL for images; text content for text files; empty for binary refs */
  dataUrl?: string;
  textContent?: string;
};

// Base64 expands raw image data by roughly 4/3. Keep enough room for the data
// URL and Markdown envelope inside the shared Hermes prompt budget.
const MAX_IMAGE_BYTES = 390_000;
const MAX_TEXT_BYTES = 60_000;
const MAX_ATTACHMENTS = 4;

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

export function isImageMime(mime: string, name = ""): boolean {
  if (mime.startsWith("image/")) return true;
  // Some pickers leave type empty or as octet-stream; trust common image extensions.
  return IMAGE_EXTENSIONS.test(name);
}

export function isTextMime(mime: string, name: string): boolean {
  if (mime.startsWith("text/")) return true;
  return /\.(txt|md|json|csv|ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|css|html|xml|yaml|yml|toml|sh)$/i.test(name);
}

export function isUnsupportedBinary(mime: string, name: string): boolean {
  if (isImageMime(mime, name) || isTextMime(mime, name)) return false;
  return mime === "application/pdf" || /\.pdf$/i.test(name) || mime.startsWith("application/") || mime.startsWith("video/") || mime.startsWith("audio/");
}

export async function fileToAttachment(file: File): Promise<ChatAttachment | { error: string }> {
  if (file.size <= 0) return { error: "empty" };
  const id = crypto.randomUUID();
  const mime = file.type || "";
  if (isImageMime(mime, file.name)) {
    if (file.size > MAX_IMAGE_BYTES) return { error: "image-too-large" };
    const imageMime = imageMimeForFile(mime, file.name);
    const dataUrl = normalizeImageDataUrl(await readAsDataUrl(file), imageMime);
    return { id, name: file.name, mime: imageMime, size: file.size, kind: "image", dataUrl };
  }
  if (isTextMime(mime, file.name)) {
    if (file.size > MAX_TEXT_BYTES) return { error: "text-too-large" };
    const textContent = await file.text();
    return { id, name: file.name, mime: mime || "text/plain", size: file.size, kind: "file", textContent };
  }
  if (isUnsupportedBinary(mime, file.name)) return { error: "unsupported" };
  return { error: "unsupported" };
}

export function appendAttachments(
  current: readonly ChatAttachment[],
  next: readonly ChatAttachment[],
): { attachments: ChatAttachment[]; truncated: number } {
  const room = Math.max(0, MAX_ATTACHMENTS - current.length);
  const taken = next.slice(0, room);
  return {
    attachments: [...current, ...taken],
    truncated: Math.max(0, next.length - taken.length),
  };
}

export function buildPromptWithAttachments(text: string, attachments: readonly ChatAttachment[]): string | { error: "payload-too-large" } {
  const body = text.trim();
  if (attachments.length === 0) {
    return isChatPromptWithinBudget(body) ? body : { error: "payload-too-large" };
  }
  const blocks: string[] = [];
  if (body) blocks.push(body);
  for (const item of attachments) {
    if (item.kind === "image" && item.dataUrl) {
      blocks.push(`Attached image: ${item.name}\n![${item.name}](${item.dataUrl})`);
      if (!isChatPromptWithinBudget(blocks.join("\n\n"))) return { error: "payload-too-large" };
      continue;
    }
    if (item.textContent !== undefined) {
      const fence = uniqueFence(item.textContent);
      const lang = item.name.endsWith(".md") ? "markdown" : extensionLanguage(item.name);
      // CommonMark: opening fence, optional info string, newline, content, closing fence.
      blocks.push(`Attached file: ${item.name}\n${fence}${lang}\n${item.textContent}\n${fence}`);
      if (!isChatPromptWithinBudget(blocks.join("\n\n"))) return { error: "payload-too-large" };
      continue;
    }
    blocks.push(`Attached file: ${item.name} (${item.mime}, ${formatBytes(item.size)}). Content could not be inlined.`);
  }
  return blocks.join("\n\n");
}

/** Operation evidence should not store multi-MB data URLs. */
export function summarizePromptForEvidence(text: string): string {
  return text
    .replace(/data:[^,\s)]*;base64,[A-Za-z0-9+/=]+/gi, "data:…")
    .slice(0, 4_000);
}

export function imageMimeForFile(mime: string, name: string): string {
  if (mime.startsWith("image/")) return mime;
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  if (extension === "bmp") return "image/bmp";
  if (extension === "svg") return "image/svg+xml";
  return "image/*";
}

export function normalizeImageDataUrl(dataUrl: string, mime: string): string {
  return dataUrl.replace(/^data:[^;,]*;base64,/i, `data:${mime};base64,`);
}

function uniqueFence(content: string): string {
  let longestRun = 0;
  let currentRun = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 0x60) {
      currentRun += 1;
      if (currentRun > longestRun) longestRun = currentRun;
    } else {
      currentRun = 0;
    }
  }
  return "`".repeat(Math.max(3, longestRun + 1));
}

function extensionLanguage(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match?.[1]?.toLowerCase() ?? "";
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read-failed"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}
