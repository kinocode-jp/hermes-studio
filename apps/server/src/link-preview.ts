const OEMBED_TIMEOUT_MS = 6_000;
const OEMBED_MAX_BYTES = 128 * 1024;
// Base64 expands by roughly 4/3. Keep the complete JSON response comfortably
// below StudioServerOptions' supported 1 MiB minimum response budget.
const THUMBNAIL_MAX_BYTES = 512 * 1024;
const CACHE_TTL_MS = 6 * 60 * 60_000;
const CACHE_MAX_ENTRIES = 128;
const MAX_CONCURRENT_FETCHES = 4;
const MAX_QUEUED_FETCHES = 12;

export type LinkPreviewProvider = "youtube" | "x" | "vimeo" | "spotify";

export type LinkPreview = {
  url: string;
  provider: LinkPreviewProvider;
  siteName: string;
  title: string;
  description?: string;
  authorName?: string;
  thumbnailDataUrl?: string;
};

type MatchedPreview = {
  url: URL;
  provider: LinkPreviewProvider;
  endpoint: URL;
};

type OEmbedPayload = {
  title?: unknown;
  author_name?: unknown;
  provider_name?: unknown;
  thumbnail_url?: unknown;
  html?: unknown;
};

type PreviewFlight = {
  promise: Promise<LinkPreview>;
  controller: AbortController;
  consumers: number;
};

type FetchWaiter = {
  resolve(): void;
  reject(error: unknown): void;
  signal: AbortSignal;
  onAbort(): void;
};

export class LinkPreviewError extends Error {
  constructor(readonly code: "unsupported" | "unavailable", message: string) {
    super(message);
    this.name = "LinkPreviewError";
  }
}

const cache = new Map<string, { expiresAt: number; value: LinkPreview }>();
const flights = new Map<string, PreviewFlight>();
const fetchWaiters: FetchWaiter[] = [];
let activeFetches = 0;

export class LinkPreviewRateLimiter {
  readonly #capacity: number;
  readonly #ratePerSecond: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(options: { capacity?: number; ratePerSecond?: number; now?: () => number } = {}) {
    this.#capacity = Math.max(1, options.capacity ?? 60);
    this.#ratePerSecond = Math.max(0, options.ratePerSecond ?? 1);
    this.#now = options.now ?? Date.now;
  }

  consume(principalId: string): boolean {
    const now = this.#now();
    const current = this.#buckets.get(principalId) ?? { tokens: this.#capacity, updatedAt: now };
    const elapsedSeconds = Math.max(0, now - current.updatedAt) / 1_000;
    const tokens = Math.min(this.#capacity, current.tokens + elapsedSeconds * this.#ratePerSecond);
    if (tokens < 1) {
      this.#buckets.set(principalId, { tokens, updatedAt: now });
      return false;
    }
    this.#buckets.set(principalId, { tokens: tokens - 1, updatedAt: now });
    return true;
  }
}

export async function resolveLinkPreview(rawUrl: string | null, signal?: AbortSignal): Promise<LinkPreview> {
  if (signal?.aborted) throw signal.reason;
  const matched = matchPreview(rawUrl);
  const key = matched.url.href;
  const cached = cache.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
  if (cached !== undefined) cache.delete(key);
  let flight = flights.get(key);
  if (flight === undefined) {
    const controller = new AbortController();
    const request = fetchAndRemember(matched, key, controller.signal);
    flight = { promise: request, controller, consumers: 0 };
    const createdFlight = flight;
    flight.promise = request.finally(() => {
      if (flights.get(key) === createdFlight) flights.delete(key);
    });
    flights.set(key, flight);
  }
  flight.consumers += 1;
  try {
    return await waitForFlight(flight.promise, signal);
  } finally {
    flight.consumers = Math.max(0, flight.consumers - 1);
    if (flight.consumers === 0 && flights.get(key) === flight) {
      flights.delete(key);
      flight.controller.abort(new DOMException("Link preview request was cancelled.", "AbortError"));
    }
  }
}

async function fetchAndRemember(matched: MatchedPreview, key: string, signal: AbortSignal): Promise<LinkPreview> {
  await acquireFetchSlot(signal);
  try {
    const payload = await fetchOEmbed(matched.endpoint, signal);
    const thumbnailUrl = stringValue(payload.thumbnail_url, 2_048);
    const description = previewDescription(matched.provider, payload);
    const authorName = stringValue(payload.author_name, 100);
    const thumbnailDataUrl = thumbnailUrl === undefined
      ? undefined
      : await fetchThumbnail(thumbnailUrl, matched.provider, signal);
    const preview: LinkPreview = {
      url: matched.url.href,
      provider: matched.provider,
      siteName: siteName(matched.provider, payload),
      title: previewTitle(matched.provider, payload),
      ...(description === undefined ? {} : { description }),
      ...(authorName === undefined ? {} : { authorName }),
      ...(thumbnailDataUrl === undefined ? {} : { thumbnailDataUrl }),
    };
    remember(key, preview);
    return preview;
  } catch (error) {
    if (error instanceof LinkPreviewError) throw error;
    throw new LinkPreviewError("unavailable", "Link preview is temporarily unavailable.");
  } finally {
    releaseFetchSlot();
  }
}

async function waitForFlight<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return await promise;
  if (signal.aborted) throw signal.reason;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

async function acquireFetchSlot(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  if (activeFetches < MAX_CONCURRENT_FETCHES) {
    activeFetches += 1;
    return;
  }
  if (fetchWaiters.length >= MAX_QUEUED_FETCHES) {
    throw new LinkPreviewError("unavailable", "Link preview capacity is temporarily full.");
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: FetchWaiter = {
      resolve,
      reject,
      signal,
      onAbort: () => {
        const index = fetchWaiters.indexOf(waiter);
        if (index >= 0) fetchWaiters.splice(index, 1);
        reject(signal.reason);
      },
    };
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    fetchWaiters.push(waiter);
  });
}

function releaseFetchSlot(): void {
  const next = fetchWaiters.shift();
  if (next !== undefined) {
    next.signal.removeEventListener("abort", next.onAbort);
    next.resolve();
  }
  else activeFetches = Math.max(0, activeFetches - 1);
}

function matchPreview(rawUrl: string | null): MatchedPreview {
  if (rawUrl === null || rawUrl.length === 0 || rawUrl.length > 2_048) {
    throw new LinkPreviewError("unsupported", "Link URL is invalid.");
  }
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { throw new LinkPreviewError("unsupported", "Link URL is invalid."); }
  if (!["http:", "https:"].includes(url.protocol)
    || url.username !== "" || url.password !== "" || url.port !== "") {
    throw new LinkPreviewError("unsupported", "Link URL is not supported.");
  }
  url.protocol = "https:";
  url.hash = "";
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let provider: LinkPreviewProvider | undefined;
  if (host === "youtu.be" || host === "youtube.com" || host === "m.youtube.com") {
    provider = youtubeId(url, host) === undefined ? undefined : "youtube";
  } else if (host === "x.com" || host === "twitter.com" || host === "mobile.twitter.com") {
    provider = /\/status\/\d+(?:\/|$)/.test(url.pathname) ? "x" : undefined;
  } else if (host === "vimeo.com" || host === "player.vimeo.com") {
    provider = /(?:^|\/)\d+(?:\/|$)/.test(url.pathname) ? "vimeo" : undefined;
  } else if (host === "open.spotify.com") {
    provider = /^\/(?:track|album|artist|playlist|episode|show)\/[A-Za-z0-9]+(?:\/|$)/.test(url.pathname)
      ? "spotify"
      : undefined;
  }
  if (provider === undefined) throw new LinkPreviewError("unsupported", "This site is not supported for link previews.");

  const endpoint = provider === "youtube"
    ? new URL("https://www.youtube.com/oembed")
    : provider === "x"
      ? new URL("https://publish.twitter.com/oembed")
      : provider === "vimeo"
        ? new URL("https://vimeo.com/api/oembed.json")
        : new URL("https://open.spotify.com/oembed");
  endpoint.searchParams.set("url", url.href);
  if (provider === "youtube") endpoint.searchParams.set("format", "json");
  if (provider === "x") {
    endpoint.searchParams.set("omit_script", "true");
    endpoint.searchParams.set("dnt", "true");
  }
  return { url, provider, endpoint };
}

function youtubeId(url: URL, host: string): string | undefined {
  const value = host === "youtu.be"
    ? url.pathname.split("/").filter(Boolean)[0]
    : url.pathname === "/watch"
      ? url.searchParams.get("v") ?? undefined
      : /^\/(?:shorts|live|embed)\/([^/]+)/.exec(url.pathname)?.[1];
  return value !== undefined && /^[A-Za-z0-9_-]{6,20}$/.test(value) ? value : undefined;
}

async function fetchOEmbed(endpoint: URL, signal: AbortSignal): Promise<OEmbedPayload> {
  return await withProviderTimeout(signal, async (providerSignal) => {
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json", "User-Agent": "Hermes-Studio-Link-Preview/1.0" },
      redirect: "error",
      signal: providerSignal,
    });
    if (!response.ok) throw new LinkPreviewError("unavailable", "The linked post is unavailable.");
    const text = await readBoundedBody(response, OEMBED_MAX_BYTES);
    let payload: unknown;
    try { payload = JSON.parse(text); }
    catch { throw new LinkPreviewError("unavailable", "The preview provider returned invalid data."); }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new LinkPreviewError("unavailable", "The preview provider returned invalid data.");
    }
    return payload as OEmbedPayload;
  });
}

async function fetchThumbnail(rawUrl: string, provider: LinkPreviewProvider, signal: AbortSignal): Promise<string | undefined> {
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { return undefined; }
  if (url.protocol !== "https:" || !thumbnailHostAllowed(url.hostname.toLowerCase(), provider)) return undefined;
  try {
    return await withProviderTimeout(signal, async (providerSignal) => {
      const response = await fetch(url, {
        headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif" },
        redirect: "error",
        signal: providerSignal,
      });
      if (!response.ok) return undefined;
      const type = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (!["image/avif", "image/webp", "image/png", "image/jpeg", "image/gif"].includes(type)) return undefined;
      const bytes = await readBoundedBytes(response, THUMBNAIL_MAX_BYTES);
      return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
    });
  } catch {
    if (signal.aborted) throw signal.reason;
    return undefined;
  }
}

async function withProviderTimeout<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal.reason);
  if (signal.aborted) abortFromCaller();
  else signal.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Link preview provider timed out.", "TimeoutError")),
    OEMBED_TIMEOUT_MS,
  );
  try { return await operation(controller.signal); }
  finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abortFromCaller);
  }
}

function thumbnailHostAllowed(host: string, provider: LinkPreviewProvider): boolean {
  if (provider === "youtube") return host === "i.ytimg.com" || host.endsWith(".ytimg.com");
  if (provider === "vimeo") return host === "i.vimeocdn.com" || host.endsWith(".vimeocdn.com");
  if (provider === "spotify") {
    return host === "i.scdn.co" || host.endsWith(".scdn.co")
      || host === "spotifycdn.com" || host.endsWith(".spotifycdn.com");
  }
  return false;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBoundedBytes(response, maxBytes));
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("response too large");
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new Error("response too large");
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function siteName(provider: LinkPreviewProvider, payload: OEmbedPayload): string {
  if (provider === "x") return "X";
  return stringValue(payload.provider_name, 40)
    ?? (provider === "youtube" ? "YouTube" : provider === "vimeo" ? "Vimeo" : "Spotify");
}

function previewTitle(provider: LinkPreviewProvider, payload: OEmbedPayload): string {
  const title = stringValue(payload.title, 200);
  if (title !== undefined) return title;
  const author = stringValue(payload.author_name, 100);
  if (provider === "x") return author === undefined ? "Post on X" : `${author} on X`;
  return siteName(provider, payload);
}

function previewDescription(provider: LinkPreviewProvider, payload: OEmbedPayload): string | undefined {
  if (provider !== "x" || typeof payload.html !== "string") return undefined;
  const paragraph = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/i.exec(payload.html)?.[1];
  return paragraph === undefined ? undefined : cleanHtmlText(paragraph, 500);
}

function cleanHtmlText(value: string, maxLength: number): string | undefined {
  return stringValue(
    decodeEntities(value.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]*>/g, "")),
    maxLength,
  );
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (raw, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? raw;
  });
}

function stringValue(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized === "") return undefined;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function remember(key: string, value: LinkPreview): void {
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value ?? "");
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
}
