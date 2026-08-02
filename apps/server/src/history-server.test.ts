import assert from "node:assert/strict";
import test from "node:test";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import { createDemoRuntimeStatus, createDemoSnapshot } from "./demo-state.js";
import { createStudioServer } from "./server.js";

const ORIGIN = "http://localhost:4173";

test("Office history endpoint serves large histories as bounded cursor pages", async (t) => {
  const requests: Array<{ limit?: number; offset?: number }> = [];
  const messages = Array.from({ length: 60 }, (_, index) => ({
    index,
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    // Keep a page above the regular 64 KiB JSON budget without making every
    // concurrently-running test file contend with a multi-megabyte fixture.
    text: `history-${index}-${"x".repeat(3_000)}`,
  }));
  const runtime: HermesRuntimeSource = {
    status: createDemoRuntimeStatus,
    snapshot: async () => createDemoSnapshot(),
    close: async () => undefined,
    chat: () => ({
      connect: async () => { throw new Error("unused"); },
      inspectHistory: async ({ sessionId }) => ({ sessionId, total: messages.length }),
      fetchHistory: async (request) => {
        requests.push({
          ...(request.limit === undefined ? {} : { limit: request.limit }),
          ...(request.offset === undefined ? {} : { offset: request.offset }),
        });
        const limit = request.limit ?? 25;
        const offset = request.offset ?? 0;
        const page = messages.slice(offset, offset + limit);
        return {
          sessionId: request.sessionId,
          profile: request.profile,
          messages: page,
          pagination: { limit, offset, returned: page.length, normalizedReturned: page.length, dropped: 0 },
        };
      },
    }),
    kanban: () => { throw new Error("unused"); },
  };
  const server = createStudioServer({ port: 0, runtimeSource: runtime, maxJsonBytes: 4 * 1024, allowedOrigins: [ORIGIN] });
  const address = await server.listen();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${address.port}`;
  const bootstrap = await fetch(`${base}/api/v1/auth/local`, { method: "POST", headers: { Origin: ORIGIN } });
  const cookie = bootstrap.headers.get("set-cookie") ?? "";

  const first = await fetch(`${base}/api/v1/sessions/stored-1/messages?profile=default&limit=25`, {
    headers: { Origin: ORIGIN, Cookie: cookie },
  });
  const firstText = await first.text();
  assert.equal(first.status, 200);
  assert.ok(Buffer.byteLength(firstText) > 64 * 1024);
  const firstPage = JSON.parse(firstText) as { messages: unknown[]; pagination: { hasMore: boolean; nextCursor?: string } };
  assert.equal(firstPage.messages.length, 25);
  assert.equal(firstPage.pagination.hasMore, true);

  const second = await fetch(`${base}/api/v1/sessions/stored-1/messages?profile=default&limit=25&cursor=${firstPage.pagination.nextCursor!}`, {
    headers: { Origin: ORIGIN, Cookie: cookie },
  });
  const secondPage = await second.json() as { messages: Array<{ index: number }> };
  assert.equal(second.status, 200);
  assert.equal(secondPage.messages[0]?.index, 10);
  assert.deepEqual(requests.slice(0, 2), [{ limit: 25, offset: 35 }, { limit: 25, offset: 10 }]);

  const invalid = await fetch(`${base}/api/v1/sessions/stored-1/messages?limit=500`, {
    headers: { Origin: ORIGIN, Cookie: cookie },
  });
  assert.equal(invalid.status, 400);
});
