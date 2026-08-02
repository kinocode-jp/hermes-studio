import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n";
import { officeFetchJson } from "../office-api-session";

export type LinkPreviewData = {
  url: string;
  provider: "youtube" | "x" | "vimeo" | "spotify";
  siteName: string;
  title: string;
  description?: string;
  authorName?: string;
  thumbnailDataUrl?: string;
};

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[,.:;!?\]}、。！？」』】]+$/;
const PREVIEW_CACHE_TTL_MS = 30 * 60_000;
const PREVIEW_CACHE_MAX_ENTRIES = 32;
const PREVIEW_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const PREVIEW_REQUEST_MAX_CONCURRENT = 4;

type PreviewCacheEntry = {
  value: LinkPreviewData;
  expiresAt: number;
  bytes: number;
};

type PreviewFlight = {
  promise: Promise<LinkPreviewData>;
  controller: AbortController;
  consumers: number;
};

type PreviewLease = {
  promise: Promise<LinkPreviewData>;
  release(): void;
};

type PreviewRequestWaiter = {
  resolve(): void;
  reject(error: unknown): void;
  signal: AbortSignal;
  onAbort(): void;
};

const previewCache = new Map<string, PreviewCacheEntry>();
const previewFlights = new Map<string, PreviewFlight>();
const previewRequestWaiters: PreviewRequestWaiter[] = [];
let activePreviewRequests = 0;

export function extractSupportedLinkPreviewUrls(text: string, limit = 4): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const candidate = trimUrl(match[0]);
    const normalized = supportedLinkPreviewUrl(candidate);
    if (normalized !== undefined && !urls.includes(normalized)) urls.push(normalized);
    if (urls.length >= limit) break;
  }
  return urls;
}

export function linkifyExternalUrls(text: string): Array<string | { text: string; href: string }> {
  const parts: Array<string | { text: string; href: string }> = [];
  let offset = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0;
    const raw = match[0];
    const href = trimUrl(raw);
    if (href === "") continue;
    if (index > offset) parts.push(text.slice(offset, index));
    parts.push({ text: href, href });
    const trailing = raw.slice(href.length);
    if (trailing !== "") parts.push(trailing);
    offset = index + raw.length;
  }
  if (offset < text.length) parts.push(text.slice(offset));
  return parts.length === 0 ? [text] : parts;
}

export function LinkPreviewCard({ url }: { url: string }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(() => typeof IntersectionObserver === "undefined");
  const [preview, setPreview] = useState<LinkPreviewData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (nearViewport || !slotRef.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setNearViewport(true);
      observer.disconnect();
    }, { rootMargin: "600px 0px" });
    observer.observe(slotRef.current);
    return () => observer.disconnect();
  }, [nearViewport]);

  useEffect(() => {
    if (!nearViewport) return;
    let active = true;
    setPreview(null);
    setLoading(true);
    const lease = leasePreview(url);
    void lease.promise.then(
      (value) => {
        if (!active) return;
        setPreview(value);
        setLoading(false);
      },
      () => {
        if (!active) return;
        setPreview(null);
        setLoading(false);
      },
    );
    return () => {
      active = false;
      lease.release();
    };
  }, [nearViewport, url]);

  return (
    <div ref={slotRef} class="md-link-preview-slot">
      {(!nearViewport || loading) && (
        <div
          class="md-link-preview is-loading"
          role="status"
          aria-hidden={!nearViewport}
          aria-label={t("chat.linkPreview.loading")}
        >
          <span class="md-link-preview__skeleton" />
          <span class="md-link-preview__skeleton is-short" />
        </div>
      )}
      {nearViewport && !loading && preview && (
        <a
          class={`md-link-preview is-${preview.provider}`}
          href={preview.url}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={t("chat.linkPreview.open", { title: preview.title })}
        >
          {preview.thumbnailDataUrl && (
            <img src={preview.thumbnailDataUrl} alt="" loading="lazy" decoding="async" />
          )}
          <span class="md-link-preview__content">
            <span class="md-link-preview__site">{preview.siteName}</span>
            <strong>{preview.title}</strong>
            {preview.description && <span class="md-link-preview__description">{preview.description}</span>}
            {preview.authorName && <small>{preview.authorName}</small>}
            <span class="md-link-preview__url">{displayHost(preview.url)}</span>
          </span>
        </a>
      )}
    </div>
  );
}

function leasePreview(url: string): PreviewLease {
  const current = previewCache.get(url);
  if (current !== undefined && current.expiresAt > Date.now()) {
    previewCache.delete(url);
    previewCache.set(url, current);
    return { promise: Promise.resolve(current.value), release: () => undefined };
  }
  if (current !== undefined) previewCache.delete(url);
  const currentFlight = previewFlights.get(url);
  if (currentFlight !== undefined) {
    currentFlight.consumers += 1;
    return flightLease(url, currentFlight);
  }
  const controller = new AbortController();
  const request = requestPreview(url, controller.signal)
    .then(parseLinkPreview)
    .then((value) => {
      previewCache.set(url, {
        value,
        expiresAt: Date.now() + PREVIEW_CACHE_TTL_MS,
        bytes: previewBytes(value),
      });
      trimPreviewCache();
      return value;
    });
  const flight: PreviewFlight = { promise: request, controller, consumers: 1 };
  flight.promise = request
    .finally(() => {
      if (previewFlights.get(url) === flight) previewFlights.delete(url);
    });
  previewFlights.set(url, flight);
  return flightLease(url, flight);
}

function flightLease(url: string, flight: PreviewFlight): PreviewLease {
  let released = false;
  return {
    promise: flight.promise,
    release: () => {
      if (released) return;
      released = true;
      flight.consumers = Math.max(0, flight.consumers - 1);
      if (flight.consumers > 0) return;
      if (previewFlights.get(url) === flight) previewFlights.delete(url);
      flight.controller.abort(new DOMException("Link preview was cancelled.", "AbortError"));
    },
  };
}

async function requestPreview(url: string, signal: AbortSignal): Promise<unknown> {
  await acquirePreviewRequestSlot(signal);
  try {
    return await officeFetchJson<unknown>(
      `/api/v1/link-preview?url=${encodeURIComponent(url)}`,
      { timeoutMs: 14_000, signal },
    );
  } finally {
    releasePreviewRequestSlot();
  }
}

async function acquirePreviewRequestSlot(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  if (activePreviewRequests < PREVIEW_REQUEST_MAX_CONCURRENT) {
    activePreviewRequests += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: PreviewRequestWaiter = {
      resolve,
      reject,
      signal,
      onAbort: () => {
        const index = previewRequestWaiters.indexOf(waiter);
        if (index >= 0) previewRequestWaiters.splice(index, 1);
        reject(signal.reason);
      },
    };
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    previewRequestWaiters.push(waiter);
  });
}

function releasePreviewRequestSlot(): void {
  const next = previewRequestWaiters.shift();
  if (next !== undefined) {
    next.signal.removeEventListener("abort", next.onAbort);
    next.resolve();
  }
  else activePreviewRequests = Math.max(0, activePreviewRequests - 1);
}

function trimPreviewCache(): void {
  const totalBytes = () => [...previewCache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  while (previewCache.size > PREVIEW_CACHE_MAX_ENTRIES || totalBytes() > PREVIEW_CACHE_MAX_BYTES) {
    const oldest = previewCache.keys().next().value;
    if (oldest === undefined) return;
    previewCache.delete(oldest);
  }
}

function previewBytes(preview: LinkPreviewData): number {
  return preview.url.length + preview.siteName.length + preview.title.length
    + (preview.description?.length ?? 0)
    + (preview.authorName?.length ?? 0)
    + (preview.thumbnailDataUrl?.length ?? 0);
}

function parseLinkPreview(value: unknown): LinkPreviewData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid link preview response.");
  const candidate = value as Partial<Record<keyof LinkPreviewData, unknown>>;
  const provider = candidate.provider;
  const url = typeof candidate.url === "string" ? supportedLinkPreviewUrl(candidate.url) : undefined;
  const siteName = candidate.siteName;
  const title = candidate.title;
  const description = candidate.description;
  const authorName = candidate.authorName;
  const thumbnailDataUrl = candidate.thumbnailDataUrl;
  if (url === undefined
    || !["youtube", "x", "vimeo", "spotify"].includes(String(provider))
    || typeof siteName !== "string" || siteName.length === 0 || siteName.length > 40
    || typeof title !== "string" || title.length === 0 || title.length > 200
    || (description !== undefined && (typeof description !== "string" || description.length > 500))
    || (authorName !== undefined && (typeof authorName !== "string" || authorName.length > 100))
    || (thumbnailDataUrl !== undefined && (typeof thumbnailDataUrl !== "string"
      || thumbnailDataUrl.length > 1_100_000
      || !/^data:image\/(?:avif|webp|png|jpeg|gif);base64,[A-Za-z0-9+/]+=*$/.test(thumbnailDataUrl)))) {
    throw new Error("Invalid link preview response.");
  }
  return {
    url,
    provider: provider as LinkPreviewData["provider"],
    siteName,
    title,
    ...(description === undefined ? {} : { description }),
    ...(authorName === undefined ? {} : { authorName }),
    ...(thumbnailDataUrl === undefined ? {} : { thumbnailDataUrl }),
  };
}

function supportedLinkPreviewUrl(raw: string): string | undefined {
  let url: URL;
  try { url = new URL(raw); }
  catch { return undefined; }
  if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "" || url.port !== "") return undefined;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const youtube = host === "youtu.be"
    ? /^\/[A-Za-z0-9_-]{6,20}(?:\/|$)/.test(url.pathname)
    : (host === "youtube.com" || host === "m.youtube.com")
      && (url.pathname === "/watch"
        ? /^[A-Za-z0-9_-]{6,20}$/.test(url.searchParams.get("v") ?? "")
        : /^\/(?:shorts|live|embed)\/[A-Za-z0-9_-]{6,20}(?:\/|$)/.test(url.pathname));
  const x = (host === "x.com" || host === "twitter.com" || host === "mobile.twitter.com")
    && /\/status\/\d+(?:\/|$)/.test(url.pathname);
  const vimeo = (host === "vimeo.com" || host === "player.vimeo.com")
    && /(?:^|\/)\d+(?:\/|$)/.test(url.pathname);
  const spotify = host === "open.spotify.com"
    && /^\/(?:track|album|artist|playlist|episode|show)\/[A-Za-z0-9]+(?:\/|$)/.test(url.pathname);
  const supported = youtube || x || vimeo || spotify;
  return supported ? url.href : undefined;
}

function trimUrl(value: string): string {
  let trimmed = value.replace(TRAILING_PUNCTUATION, "");
  while (trimmed.endsWith(")") && countCharacter(trimmed, ")") > countCharacter(trimmed, "(")) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function countCharacter(value: string, character: string): number {
  let count = 0;
  for (const current of value) if (current === character) count += 1;
  return count;
}

function displayHost(value: string): string {
  try { return new URL(value).hostname.replace(/^www\./, ""); }
  catch { return value; }
}
