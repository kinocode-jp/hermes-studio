import assert from "node:assert/strict";
import test from "node:test";
import type { HermesChatTransport, HermesHistoryMessageDto } from "./hermes-chat.js";
import { fetchOfficeHistoryPage, HistoryHttpInputError, type HistoryAggregateLimits, type OfficeHistoryPage } from "./history-http.js";

test("history pages prioritize newest messages while staying inside the response budget", async () => {
  const source = Array.from({ length: 6 }, (_, index): HermesHistoryMessageDto => ({
    index,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `message-${index}-${"\u0001".repeat(150_000)}`,
  }));
  const requests: Array<{ limit?: number; offset?: number }> = [];
  const chat = historyFixture(source, requests);
  const first = await fetchOfficeHistoryPage(chat, new URL("http://office.local/messages?profile=default&limit=6"), "stored-1", 1024 * 1024);
  assert.equal(first.pagination.direction, "older");
  assert.equal(first.pagination.pageLimitedByBytes, true);
  assert.equal(first.pagination.hasMore, true);
  assert.deepEqual(first.messages.map(({ index }) => index), [5]);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 1024 * 1024);

  const second = await fetchOfficeHistoryPage(chat, historyUrl(first), "stored-1", 1024 * 1024);
  assert.deepEqual(second.messages.map(({ index }) => index), [4]);
  assert.deepEqual(requests, [{ limit: 6, offset: 0 }, { limit: 5, offset: 0 }]);
});

test("history query rejects unbounded limits, forged cursors, and cross-session cursor reuse", async () => {
  const chat = historyFixture([shortMessage(0), shortMessage(1)]);
  await assert.rejects(
    fetchOfficeHistoryPage(chat, new URL("http://office.local/messages?limit=500"), "stored-1", 1024 * 1024),
    HistoryHttpInputError,
  );
  await assert.rejects(
    fetchOfficeHistoryPage(chat, new URL("http://office.local/messages?cursor=forged"), "stored-1", 1024 * 1024),
    HistoryHttpInputError,
  );
  const first = await fetchOfficeHistoryPage(chat, new URL("http://office.local/messages?limit=1"), "stored-1", 1024 * 1024);
  const cursor = first.pagination.nextCursor!;
  await assert.rejects(fetchOfficeHistoryPage(chat, new URL(`http://office.local/messages?limit=1&cursor=${cursor}`), "other-session", 1024 * 1024), HistoryHttpInputError);
});

test("history pages reject an upstream session identity change after cursor resolution", async () => {
  const chat: HermesChatTransport = {
    connect: async () => { throw new Error("unused"); },
    inspectHistory: async () => ({ sessionId: "resolved-a", total: 1 }),
    fetchHistory: async (request) => ({
      sessionId: "resolved-b",
      profile: request.profile,
      messages: [shortMessage(0)],
      pagination: { limit: 1, offset: 0, returned: 1, normalizedReturned: 1, dropped: 0 },
    }),
  };
  await assert.rejects(
    fetchOfficeHistoryPage(chat, new URL("http://office.local/messages?profile=default&limit=1"), "stored-a", 1024 * 1024),
    /history changed/,
  );
});

test("history cursors reject non-canonical outer, session, and signature encodings", async () => {
  const chat = historyFixture([shortMessage(0), shortMessage(1)]);
  const cursor = await continuationCursor(chat);
  await assert.rejects(fetchWithCursor(chat, `${cursor}=`), HistoryHttpInputError);

  const fields = decodeCursorFields(cursor);
  fields[1] = nonCanonicalAlias(fields[1]!);
  await assert.rejects(fetchWithCursor(chat, encodeCursorFields(fields)), HistoryHttpInputError);

  const signatureAlias = decodeCursorFields(cursor);
  signatureAlias[8] = nonCanonicalAlias(signatureAlias[8]!);
  await assert.rejects(fetchWithCursor(chat, encodeCursorFields(signatureAlias)), HistoryHttpInputError);
});

test("history cursors reject deterministic semantic payload tampering", async () => {
  const chat = historyFixture([shortMessage(0), shortMessage(1)]);
  const cursor = await continuationCursor(chat);
  const payloadTamper = decodeCursorFields(cursor);
  payloadTamper[4] = payloadTamper[4] === "0" ? "1" : "0";
  await assert.rejects(fetchWithCursor(chat, encodeCursorFields(payloadTamper)), HistoryHttpInputError);
});

test("history cursors reject deterministic signature bit tampering", async () => {
  const chat = historyFixture([shortMessage(0), shortMessage(1)]);
  const cursor = await continuationCursor(chat);
  const signatureTamper = decodeCursorFields(cursor);
  const signature = Buffer.from(signatureTamper[8]!, "base64url");
  signature[0] = signature[0]! ^ 0x01;
  signatureTamper[8] = signature.toString("base64url");
  await assert.rejects(fetchWithCursor(chat, encodeCursorFields(signatureTamper)), HistoryHttpInputError);
});

test("normal tail pages are returned newest-first by page and reconstruct insertion order", async () => {
  const result = await collectHistory(historyFixture(Array.from({ length: 3 }, (_, index) => shortMessage(index))), 2);
  assert.deepEqual(result.messages.map(({ index }) => index), [0, 1, 2]);
  assert.deepEqual(result.last.pagination.cumulative, {
    pages: 2,
    messages: 3,
    bytes: result.messages.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message)) + 1, 0),
  });
  assert.equal(result.last.pagination.truncated, false);
  assert.equal(result.last.pagination.partial, false);
});

test("499, exactly 500, and more than 500 messages keep the latest bounded window accurately", async () => {
  for (const total of [499, 500, 501]) {
    const source = Array.from({ length: total }, (_, index) => shortMessage(index));
    const result = await collectHistory(historyFixture(source), 25);
    const expectedStart = Math.max(0, total - 500);
    assert.equal(result.messages.length, Math.min(total, 500));
    assert.equal(result.messages[0]?.index, total === 0 ? undefined : expectedStart);
    assert.equal(result.messages.at(-1)?.index, total - 1);
    assert.equal(result.last.pagination.truncated, total > 500);
    assert.equal(result.last.pagination.partial, total > 500);
    assert.equal(result.last.pagination.truncationReason, total > 500 ? "message_limit" : undefined);
    assert.deepEqual(result.last.pagination.window, { start: expectedStart, end: total, omittedBefore: total > 500 });
  }
});

test("message, UTF-8 byte, and page limits retain the newest safe suffix", async () => {
  const messages = Array.from({ length: 6 }, (_, index) => shortMessage(index));
  const messageLimits = { maxPages: 10, maxMessages: 3, maxBytes: 1024 * 1024 };
  const byMessage = await collectHistory(historyFixture(messages), 2, messageLimits);
  assert.deepEqual(byMessage.messages.map(({ index }) => index), [3, 4, 5]);
  assert.equal(byMessage.last.pagination.truncationReason, "message_limit");

  const large = [shortMessage(0, "x".repeat(700)), shortMessage(1, "y".repeat(700))];
  const byByte = await fetchOfficeHistoryPage(historyFixture(large), new URL("http://office.local/messages?limit=2"), "stored-1", 1024 * 1024, { maxPages: 10, maxMessages: 10, maxBytes: 1024 });
  assert.deepEqual(byByte.messages.map(({ index }) => index), [1]);
  assert.equal(byByte.pagination.truncationReason, "byte_limit");

  const byPage = await collectHistory(historyFixture(messages), 1, { maxPages: 2, maxMessages: 10, maxBytes: 1024 * 1024 });
  assert.deepEqual(byPage.messages.map(({ index }) => index), [4, 5]);
  assert.equal(byPage.last.pagination.truncationReason, "page_limit");
});

test("mixed malformed Hermes rows are omitted but never promoted to a complete transcript", async () => {
  const chat = malformedHistoryFixture([
    shortMessage(0),
    undefined,
    shortMessage(2),
    undefined,
    shortMessage(4),
  ]);
  const page = await fetchOfficeHistoryPage(chat, new URL("http://office.local/messages?limit=5"), "stored-1", 1024 * 1024);
  assert.deepEqual(page.messages.map(({ index }) => index), [0, 2, 4]);
  assert.deepEqual(page.pagination.source, { returned: 5, normalizedReturned: 3, dropped: 2 });
  assert.equal(page.pagination.hasMore, false);
  assert.equal(page.pagination.nextCursor, undefined);
  assert.equal(page.pagination.truncated, true);
  assert.equal(page.pagination.partial, true);
  assert.equal(page.pagination.truncationReason, "upstream_invalid_rows");
  assert.equal(JSON.stringify(page).includes("raw payload"), false);
});

test("an all-invalid page returns an empty explicit partial result instead of a complete transcript", async () => {
  const page = await fetchOfficeHistoryPage(
    malformedHistoryFixture([undefined, undefined]),
    new URL("http://office.local/messages?limit=2"),
    "stored-1",
    1024 * 1024,
  );
  assert.deepEqual(page.messages, []);
  assert.deepEqual(page.pagination.source, { returned: 2, normalizedReturned: 0, dropped: 2 });
  assert.deepEqual(
    { truncated: page.pagination.truncated, partial: page.pagination.partial, reason: page.pagination.truncationReason },
    { truncated: true, partial: true, reason: "upstream_invalid_rows" },
  );
});

test("a malformed row on a later page retains the newest fetched suffix and stops safely", async () => {
  const source = [shortMessage(0), undefined, shortMessage(2), shortMessage(3), shortMessage(4), shortMessage(5)];
  const chat = malformedHistoryFixture(source);
  const first = await fetchOfficeHistoryPage(chat, new URL("http://office.local/messages?limit=2"), "stored-1", 1024 * 1024);
  assert.deepEqual(first.messages.map(({ index }) => index), [4, 5]);
  assert.equal(first.pagination.hasMore, true);
  const second = await fetchOfficeHistoryPage(chat, historyUrl(first, 2), "stored-1", 1024 * 1024);
  assert.deepEqual(second.messages.map(({ index }) => index), [2, 3]);
  assert.equal(second.pagination.truncationReason, undefined);
  const third = await fetchOfficeHistoryPage(chat, historyUrl(second, 2), "stored-1", 1024 * 1024);
  assert.deepEqual(third.messages.map(({ index }) => index), [0]);
  assert.deepEqual({ hasMore: third.pagination.hasMore, partial: third.pagination.partial, reason: third.pagination.truncationReason }, {
    hasMore: false, partial: true, reason: "upstream_invalid_rows",
  });
});

test("malformed rows outside the latest 500 window do not taint it and a later clean reload recovers", async () => {
  const outside = malformedHistoryFixture([undefined, ...Array.from({ length: 500 }, (_, index) => shortMessage(index + 1))]);
  const bounded = await collectHistory(outside, 25);
  assert.equal(bounded.messages.length, 500);
  assert.equal(bounded.last.pagination.truncationReason, "message_limit");
  assert.deepEqual(bounded.last.pagination.source, { returned: 25, normalizedReturned: 25, dropped: 0 });

  let malformed = true;
  const recovering = malformedHistoryFixture([shortMessage(0), undefined], () => malformed);
  const first = await fetchOfficeHistoryPage(recovering, new URL("http://office.local/messages?limit=2"), "stored-1", 1024 * 1024);
  assert.equal(first.pagination.truncationReason, "upstream_invalid_rows");
  malformed = false;
  const second = await fetchOfficeHistoryPage(recovering, new URL("http://office.local/messages?limit=2"), "stored-1", 1024 * 1024);
  assert.equal(second.pagination.truncated, false);
  assert.equal(second.pagination.partial, false);
  assert.deepEqual(second.messages.map(({ index }) => index), [0, 1]);
});

function historyFixture(source: HermesHistoryMessageDto[], requests: Array<{ limit?: number; offset?: number }> = []): HermesChatTransport {
  return {
    connect: async () => { throw new Error("unused"); },
    inspectHistory: async ({ sessionId }) => ({ sessionId, total: source.length }),
    fetchHistory: async (request) => {
      requests.push({ ...(request.limit === undefined ? {} : { limit: request.limit }), ...(request.offset === undefined ? {} : { offset: request.offset }) });
      const limit = request.limit ?? 25;
      const offset = request.offset ?? 0;
      const messages = source.slice(offset, offset + limit);
      return { sessionId: request.sessionId, profile: request.profile, messages, pagination: { limit, offset, returned: messages.length, normalizedReturned: messages.length, dropped: 0 } };
    },
  };
}

function malformedHistoryFixture(
  source: Array<HermesHistoryMessageDto | undefined>,
  isMalformed: () => boolean = () => true,
): HermesChatTransport {
  return {
    connect: async () => { throw new Error("unused"); },
    inspectHistory: async ({ sessionId }) => ({ sessionId, total: source.length }),
    fetchHistory: async (request) => {
      const limit = request.limit ?? 25;
      const offset = request.offset ?? 0;
      const wire = source.slice(offset, offset + limit);
      const messages = wire.flatMap((message, index) => {
        if (message !== undefined) return [message];
        return isMalformed() ? [] : [shortMessage(offset + index)];
      });
      const dropped = isMalformed() ? wire.filter((message) => message === undefined).length : 0;
      return {
        sessionId: request.sessionId,
        profile: request.profile,
        messages,
        pagination: { limit, offset, returned: wire.length, normalizedReturned: messages.length, dropped },
      };
    },
  };
}

async function collectHistory(chat: HermesChatTransport, limit: number, limits?: HistoryAggregateLimits) {
  const pages: OfficeHistoryPage[] = [];
  let url = new URL(`http://office.local/messages?limit=${limit}`);
  for (;;) {
    const page = await fetchOfficeHistoryPage(chat, url, "stored-1", 1024 * 1024, limits);
    pages.unshift(page);
    if (!page.pagination.hasMore) break;
    url = historyUrl(page, limit);
  }
  return { messages: pages.flatMap(({ messages }) => messages), last: pages[0]! };
}

function historyUrl(page: OfficeHistoryPage, limit = page.pagination.limit): URL {
  return new URL(`http://office.local/messages?limit=${limit}&cursor=${page.pagination.nextCursor!}`);
}

async function continuationCursor(chat: HermesChatTransport): Promise<string> {
  const page = await fetchOfficeHistoryPage(chat, new URL("http://office.local/messages?limit=1"), "stored-1", 1024 * 1024);
  return page.pagination.nextCursor!;
}

function fetchWithCursor(chat: HermesChatTransport, cursor: string): Promise<OfficeHistoryPage> {
  return fetchOfficeHistoryPage(chat, new URL(`http://office.local/messages?limit=1&cursor=${encodeURIComponent(cursor)}`), "stored-1", 1024 * 1024);
}

function decodeCursorFields(cursor: string): string[] {
  return Buffer.from(cursor, "base64url").toString("utf8").split(":");
}

function encodeCursorFields(fields: string[]): string {
  return Buffer.from(fields.join(":"), "utf8").toString("base64url");
}

function nonCanonicalAlias(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(value.at(-1)!);
  const unusedBits = value.length % 4 === 2 ? 4 : value.length % 4 === 3 ? 2 : 0;
  if (last < 0 || unusedBits === 0) return `${value}=`;
  const alias = alphabet[(last & ~((1 << unusedBits) - 1)) | 1]!;
  assert.notEqual(alias, value.at(-1));
  assert.deepEqual(Buffer.from(`${value.slice(0, -1)}${alias}`, "base64url"), Buffer.from(value, "base64url"));
  return `${value.slice(0, -1)}${alias}`;
}

function shortMessage(index: number, text = `message-${index}`): HermesHistoryMessageDto {
  return { index, role: index % 2 === 0 ? "user" : "assistant", text };
}
