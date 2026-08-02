import assert from "node:assert/strict";
import test from "node:test";
import { LinkPreviewError, LinkPreviewRateLimiter, resolveLinkPreview } from "./link-preview.js";

test("link preview rate limits are per principal and refill over time", () => {
  let now = 1_000;
  const limiter = new LinkPreviewRateLimiter({ capacity: 2, ratePerSecond: 1, now: () => now });
  assert.equal(limiter.consume("device-a"), true);
  assert.equal(limiter.consume("device-a"), true);
  assert.equal(limiter.consume("device-a"), false);
  assert.equal(limiter.consume("device-b"), true);
  now += 1_000;
  assert.equal(limiter.consume("device-a"), true);
});

test("concurrent requests for the same URL share one provider flight", async () => {
  const originalFetch = globalThis.fetch;
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    await providerGate;
    return new Response(JSON.stringify({
      title: "YouTube test video",
      author_name: "Test channel",
      provider_name: "YouTube",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const first = resolveLinkPreview("https://youtu.be/M7lc1UVf-VE?singleflight=1");
    const second = resolveLinkPreview("https://youtu.be/M7lc1UVf-VE?singleflight=1");
    releaseProvider();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(fetchCalls, 1);
    assert.deepEqual(a, b);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the sole disconnected consumer cancels its provider request", async () => {
  const originalFetch = globalThis.fetch;
  let providerStarted!: () => void;
  const started = new Promise<void>((resolve) => { providerStarted = resolve; });
  let providerAborted = false;
  globalThis.fetch = async (_url, init) => {
    providerStarted();
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) return reject(new Error("missing provider abort signal"));
      const onAbort = () => {
        providerAborted = true;
        reject(signal.reason);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  try {
    const controller = new AbortController();
    const pending = resolveLinkPreview("https://youtu.be/M7lc1UVf-VE?cancel=1", controller.signal);
    await started;
    controller.abort(new DOMException("test disconnect", "AbortError"));
    await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
    assert.equal(providerAborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link previews reject arbitrary and non-content URLs before network access", async () => {
  for (const url of [
    "http://127.0.0.1/private",
    "https://example.com/article",
    "https://www.youtube.com/",
    "https://x.com/XDevelopers",
  ]) {
    await assert.rejects(
      resolveLinkPreview(url),
      (error: unknown) => error instanceof LinkPreviewError && error.code === "unsupported",
    );
  }
});
