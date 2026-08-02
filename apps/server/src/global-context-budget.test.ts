import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GLOBAL_CONTEXT_MAX_UTF8_BYTES,
  GLOBAL_SETTINGS_MAX_REQUEST_UTF8_BYTES,
  GLOBAL_SETTINGS_MAX_SKILLS,
  globalContextUtf8Bytes,
  isGlobalContextWithinBudget,
} from "@hermes-studio/protocol";
import { WebSocketServer } from "ws";
import { createHermesChatTransport, HermesChatTransportError } from "./hermes-chat.js";
import type { HermesSettingsAdapter } from "./hermes-settings.js";
import { OfficeGlobalSettingsStore } from "./hermes-settings.js";
import { routeSettingsHttp } from "./settings-http.js";

const TOKEN = "0123456789abcdef0123456789abcdef"; // gitleaks:allow -- synthetic test credential

test("maximum global context saves over HTTP and seeds session.create within one wire budget", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-context-budget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OfficeGlobalSettingsStore(join(directory, "global.json"));
  const received: string[] = [];
  const server = createServer(async (request, response) => {
    const result = await routeSettingsHttp(
      request,
      new URL(request.url ?? "/", "http://office.local"),
      { settings: {} as HermesSettingsAdapter, globalSettings: store },
      GLOBAL_SETTINGS_MAX_REQUEST_UTF8_BYTES,
    );
    const body = JSON.stringify(result.body);
    response.writeHead(result.status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    response.end(body);
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket, request)));
  sockets.on("connection", (websocket) => websocket.on("message", (data) => {
    const serialized = data.toString();
    received.push(serialized);
    const frame = JSON.parse(serialized) as { id: number };
    websocket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { session_id: "live-1", stored_session_id: "stored-1" } }));
  }));
  const origin = await listen(server);
  t.after(async () => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    server.close();
  });

  const maximum = "x".repeat(GLOBAL_CONTEXT_MAX_UTF8_BYTES);
  const maximumSkills = Array.from({ length: GLOBAL_SETTINGS_MAX_SKILLS }, (_, index) => `s${String(index).padStart(2, "0")}${"x".repeat(125)}`);
  assert.equal(globalContextUtf8Bytes(maximum), GLOBAL_CONTEXT_MAX_UTF8_BYTES);
  const maximumUpdate = JSON.stringify({ expectedRevision: 0, skills: maximumSkills, context: maximum });
  assert.equal(Buffer.byteLength(maximumUpdate) <= GLOBAL_SETTINGS_MAX_REQUEST_UTF8_BYTES, true);
  const saved = await fetch(`${origin}/api/v1/settings/global`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: maximumUpdate,
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json() as { revision: number }).revision, 1);
  assert.equal((await store.read()).context, maximum);
  assert.equal((await store.read()).skills.length, maximumSkills.length);

  const transport = createHermesChatTransport({
    baseUrl: origin,
    sessionToken: TOKEN,
    maxFrameBytes: GLOBAL_SETTINGS_MAX_REQUEST_UTF8_BYTES,
  });
  const connection = await transport.connect(() => undefined);
  await connection.request(
    { method: "session.create", params: { profile: "coder" } },
    { sessionCreateSystemSeed: (await store.read()).context },
  );
  await assert.rejects(
    connection.request(
      { method: "session.create", params: { profile: "coder" } },
      { sessionCreateSystemSeed: `${maximum}x` },
    ),
    (error: unknown) => error instanceof HermesChatTransportError && error.code === "invalid_request",
  );
  await connection.close();

  assert.equal(received.length, 1);
  assert.equal(Buffer.byteLength(received[0]!) <= GLOBAL_SETTINGS_MAX_REQUEST_UTF8_BYTES, true);
  const frame = JSON.parse(received[0]!) as { params: { messages: Array<{ content: string }> } };
  assert.equal(frame.params.messages[0]?.content, maximum);

  const oversized = await fetch(`${origin}/api/v1/settings/global`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: 1, skills: [], context: `${maximum}x` }),
  });
  assert.equal(oversized.status, 400);
  await oversized.arrayBuffer();
  assert.equal((await store.read()).revision, 1);
});

test("UTF-8 JSON escaping and one-byte-over context are rejected consistently", async (t) => {
  assert.equal(globalContextUtf8Bytes("😀\n"), 6);
  assert.equal(isGlobalContextWithinBudget("x".repeat(GLOBAL_CONTEXT_MAX_UTF8_BYTES)), true);
  assert.equal(isGlobalContextWithinBudget("x".repeat(GLOBAL_CONTEXT_MAX_UTF8_BYTES + 1)), false);
  assert.equal(isGlobalContextWithinBudget("\n".repeat((GLOBAL_CONTEXT_MAX_UTF8_BYTES / 2) + 1)), false);

  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-context-over-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OfficeGlobalSettingsStore(join(directory, "global.json"));
  await assert.rejects(store.update({
    expectedRevision: 0,
    context: "x".repeat(GLOBAL_CONTEXT_MAX_UTF8_BYTES + 1),
  }));
});

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
