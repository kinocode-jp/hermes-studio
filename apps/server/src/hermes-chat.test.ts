import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocketServer } from "ws";
import {
  createHermesChatTransport,
  composeStudioPromptForWire,
  HermesChatTransportError,
  type HermesChatEvent,
  type HermesChatRequest,
} from "./hermes-chat.js";
import {
  appendStudioDefaultDelegationTurnInstruction,
  appendStudioFollowUpTurnInstruction,
} from "./office-agent-behavior.js";

const TOKEN = "0123456789abcdef0123456789abcdef"; // gitleaks:allow -- synthetic test credential
const DASHBOARD_SECRET = "dashboard-example-value-123456"; // gitleaks:allow -- synthetic test credential
const OPENAI_SECRET = "openai-example-value-123456"; // gitleaks:allow -- synthetic test credential
const AWS_SECRET = "aws-example-value-123456"; // gitleaks:allow -- synthetic test credential
const PASSWORD_SECRET = "password-example-value-123456"; // gitleaks:allow -- synthetic test credential
const SERVICE_SECRET = "service-example-value-123456"; // gitleaks:allow -- synthetic test credential
const GITHUB_SECRET = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"; // gitleaks:allow -- synthetic test credential
const OPENAI_STANDALONE_SECRET = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"; // gitleaks:allow -- synthetic test credential
const AUTH_HEADER_SECRET = "opaque-auth-header-value"; // gitleaks:allow -- synthetic test credential
const COOKIE_SECRET = "office-cookie-example-value-123456"; // gitleaks:allow -- synthetic test credential
const JWT_SECRET = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "signature0123456789"].join(".");
const MINIMAL_TEST_CATALOG = JSON.stringify({
  version: 1, catalogStatus: "unavailable", usableFor: ["main", "subagent"],
  coverage: "profile-scoped live provider catalogs",
});

test("prompt wire budgeting preserves user text and degrades only the model catalog", () => {
  const catalog = [
    JSON.stringify({ version: 1, catalogStatus: "complete", usableFor: ["main", "subagent"] }),
    ...Array.from({ length: 400 }, (_, index) => JSON.stringify({
      profile: "coder", provider: "openai", model: `model-${index}`, reasoningEfforts: ["low", "high"],
    })),
  ].join("\n");
  const composed = composeStudioPromptForWire("keep-user-body", "live-budget", {
    studioDefaultDelegationTurn: true,
    studioDefaultDelegationModelCatalog: catalog,
    studioFollowUpTurn: true,
  }, 32 * 1024);
  assert.match(composed, /^keep-user-body/);
  assert.match(composed, /"catalogStatus":"partial"/);
  assert.match(composed, /"truncated":true/);
  assert.equal(composed.includes("model-399"), false);
  const serialized = JSON.stringify({
    jsonrpc: "2.0", id: Number.MAX_SAFE_INTEGER, method: "prompt.submit",
    params: { session_id: "live-budget", text: composed },
  });
  assert.ok(Buffer.byteLength(serialized) <= 32 * 1024);
});

test("prompt wire input boundary is identical for default and specialist Profiles", () => {
  const escapedBoundary = "\\".repeat(16_000);
  for (const internal of [
    { studioDefaultDelegationTurn: true as const, studioDefaultDelegationModelCatalog: MINIMAL_TEST_CATALOG, studioFollowUpTurn: true as const },
    { studioFollowUpTurn: true as const },
  ]) {
    assert.throws(
      () => composeStudioPromptForWire(escapedBoundary, "live-budget", internal, 16 * 1024),
      (error: unknown) => error instanceof HermesChatTransportError
        && error.code === "invalid_request"
        && /conversation context budget/.test(error.message),
    );
  }
});

test("fetchHistory authenticates internally and returns a bounded secret-safe DTO", async (t) => {
  const observedUrls: string[] = [];
  let observedToken = "";
  const server = createServer((request, response) => {
    const observedUrl = request.url ?? "";
    observedUrls.push(observedUrl);
    observedToken = String(request.headers["x-hermes-session-token"] ?? "");
    if (!observedUrl.includes("/messages?")) {
      writeJson(response, { id: "resolved-42", message_count: 501, system_prompt: "must never escape" });
      return;
    }
    const historyRows = [
      { role: "system", content: "internal system prompt", timestamp: 1_700_000_000 },
      { role: "user", content: appendStudioFollowUpTurnInstruction(`Use HERMES_DASHBOARD_SESSION_TOKEN=${DASHBOARD_SECRET} and ${GITHUB_SECRET} in this turn\nAuthorization: Token ${AUTH_HEADER_SECRET}\nCookie: hermes_office_session=${COOKIE_SECRET}`), timestamp: 1_700_000_001 },
      { role: "assistant", content: [{ type: "text", text: `Working with OPENAI_API_KEY = '${OPENAI_SECRET}'` }, { type: "image", data: "hidden" }] },
      { role: "tool", content: "PRIVATE OUTPUT", tool_name: `TOOL_TOKEN=${DASHBOARD_SECRET}` },
      { role: "invalid", content: "drop" },
    ];
    const requestedLimit = Number(new URL(observedUrl, "http://127.0.0.1").searchParams.get("limit") ?? historyRows.length);
    writeJson(response, {
      session_id: "resolved-42",
      messages: historyRows.slice(0, requestedLimit),
      system_prompt: "must never escape",
      model_config: { api_key: "must never escape" }, // gitleaks:allow -- synthetic rejection fixture
    });
  });
  const origin = await listen(server);
  t.after(() => server.close());

  const transport = createHermesChatTransport({ baseUrl: origin, sessionToken: TOKEN });
  const summary = await transport.inspectHistory({ sessionId: "session-42", profile: "coder" });
  const history = await transport.fetchHistory({
    sessionId: "session-42",
    profile: "coder",
    limit: 4,
    offset: 2,
  });

  assert.equal(observedToken, TOKEN);
  assert.deepEqual(summary, { sessionId: "resolved-42", total: 501 });
  assert.ok(observedUrls.some((url) => /^\/api\/sessions\/session-42\/messages\?/.test(url) && url.includes("limit=1") && url.includes("offset=0")));
  assert.ok(observedUrls.some((url) => /^\/api\/sessions\/resolved-42\?/.test(url) && url.includes("profile=coder")));
  assert.ok(observedUrls.some((url) => /^\/api\/sessions\/session-42\/messages\?/.test(url) && url.includes("limit=4") && url.includes("offset=2")));
  assert.deepEqual(history.pagination, { limit: 4, offset: 2, returned: 4, normalizedReturned: 4, dropped: 0 });
  assert.equal(history.sessionId, "resolved-42");
  assert.deepEqual(history.messages.map((message) => message.role), ["system", "user", "assistant", "tool"]);
  assert.equal(history.messages[0]?.text, "[System message hidden]");
  assert.equal(history.messages[1]?.text, "Use HERMES_DASHBOARD_SESSION_TOKEN=[REDACTED] and [REDACTED] in this turn\nAuthorization: [REDACTED]\nCookie: [REDACTED]");
  assert.equal(history.messages[2]?.text, "Working with OPENAI_API_KEY = '[REDACTED]'");
  assert.equal(history.messages[3]?.text, "[Tool output hidden]");
  assert.equal(history.messages[3]?.toolName, "TOOL_TOKEN=[REDACTED]");
  assert.equal(JSON.stringify(history).includes("must never escape"), false);
  assert.equal(JSON.stringify(history).includes("PRIVATE OUTPUT"), false);
  assert.equal(JSON.stringify(history).includes(DASHBOARD_SECRET), false);
  assert.equal(JSON.stringify(history).includes(OPENAI_SECRET), false);
  assert.equal(JSON.stringify(history).includes(GITHUB_SECRET), false);
  assert.equal(JSON.stringify(history).includes(AUTH_HEADER_SECRET), false);
  assert.equal(JSON.stringify(history).includes(COOKIE_SECRET), false);
  assert.equal(JSON.stringify(history).includes("studio-followups"), false);
});

test("fetchHistory counts and safely drops individual malformed wire rows", async (t) => {
  const server = createServer((_request, response) => writeJson(response, {
    session_id: "resolved-safe",
    messages: [
      { role: "user", content: "kept" },
      { role: "future-role", content: "raw payload secret=never-return-this" },
      null,
      { role: "assistant", content: "also kept", timestamp: 1_700_000_001 },
      { role: "user", content: "bad timestamp secret=never-return-this", timestamp: "tomorrow" },
    ],
    api_key: "never-return-this", // gitleaks:allow -- synthetic rejection fixture
  }));
  const origin = await listen(server);
  t.after(() => server.close());

  const history = await createHermesChatTransport({ baseUrl: origin, sessionToken: TOKEN }).fetchHistory({
    sessionId: "stored-safe",
    profile: "coder",
    limit: 5,
    offset: 0,
  });
  assert.deepEqual(history.messages.map(({ index, text }) => ({ index, text })), [
    { index: 0, text: "kept" },
    { index: 3, text: "also kept" },
  ]);
  assert.deepEqual(history.pagination, { limit: 5, offset: 0, returned: 5, normalizedReturned: 2, dropped: 3 });
  assert.equal(JSON.stringify(history).includes("never-return-this"), false);
  assert.equal(JSON.stringify(history).includes("raw payload"), false);
});

test("chat connection sends only validated allowlisted RPC and normalizes results/events", async (t) => {
  const events: HermesChatEvent[] = [];
  const received: Array<Record<string, unknown>> = [];
  let observedToken = "";
  const http = createServer((_request, response) => { response.writeHead(404).end(); });
  const sockets = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    observedToken = url.searchParams.get("token") ?? "";
    sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket, request));
  });
  sockets.on("connection", (websocket) => {
    websocket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "secret.request", session_id: "live-1", payload: { request_id: "secret-1", prompt: "API key" } } }));
    websocket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "status.update", session_id: "live-1", payload: { kind: `KIND_TOKEN=${DASHBOARD_SECRET}`, status: `STATUS_TOKEN=${OPENAI_SECRET}`, text: `Preparing with ci_token = '${DASHBOARD_SECRET}'`, private_state: "hidden" } } }));
    websocket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "approval.request", session_id: "live-1", payload: { command: "curl https://x/?token=supersecretvalue", description: `AWS_SECRET_ACCESS_KEY = \"${AWS_SECRET}\"`, choices: ["once", `CHOICE_TOKEN=${DASHBOARD_SECRET}`, "deny"], allow_permanent: false, raw_args: { password: "hidden" } } } }));
    websocket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "clarify.request", session_id: "live-1", payload: { request_id: "clarify-1", question: "Continue?", choices: ["yes", `OPENAI_API_KEY=${OPENAI_SECRET}`] } } }));
    websocket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "message.delta", session_id: "live-1", payload: { message_id: "opaque/message+1==", messageId: "shared-message-alias", text: `OPENAI_API_KEY=${OPENAI_SECRET}; ${OPENAI_STANDALONE_SECRET}; ${JWT_SECRET}\nAuthorization: Bearer ${AUTH_HEADER_SECRET}`, role: "assistant" } } }));
    websocket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "tool.progress", session_id: "live-1", payload: { tool_id: "shared-tool", tool_call_id: "opaque/call+1==", name: `TOOL_TOKEN=${DASHBOARD_SECRET}`, status: `STATUS_TOKEN=${OPENAI_SECRET}`, summary: `database_password = '${PASSWORD_SECRET}'` } } }));
    websocket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "tool.generating", session_id: "live-1", payload: { tool_call_id: "x".repeat(2_049), call_id: "tool-call-2", tool_id: "shared-tool", name: "Fallback tool" } } }));
    websocket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "session.info", session_id: "live-1", payload: { model: "model-safe", provider: "provider-safe", reasoning_effort: "high", private_config: `token=${DASHBOARD_SECRET}` } } }));
    websocket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "error", session_id: "live-1", payload: { status: `STATUS_TOKEN=${DASHBOARD_SECRET}`, message: `service_secret: ${SERVICE_SECRET}`, model: `MODEL_TOKEN=${OPENAI_SECRET}`, provider: `PROVIDER_TOKEN=${AWS_SECRET}`, version: `VERSION_TOKEN=${PASSWORD_SECRET}` } } }));
    websocket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      received.push(frame);
      const params = frame.params as Record<string, unknown>;
      const result = frame.method === "clarify.respond"
        ? { status: "ok" }
        : frame.method === "prompt.submit"
          ? { status: "streaming", task_id: "task-1" }
        : { session_id: "live-1", stored_session_id: "stored-1", message_count: 0, model: "model-safe", info: { running: false, provider: "provider-safe", reasoning_effort: "high" }, status: `RPC_TOKEN=${DASHBOARD_SECRET}`, cwd: "/private/path", token: "hidden", echoed: params };
      websocket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
    });
  });
  const origin = await listen(http);
  t.after(async () => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    http.close();
  });

  const transport = createHermesChatTransport({ baseUrl: origin, sessionToken: TOKEN });
  const connection = await transport.connect((event) => events.push(event));
  const result = await connection.request({ method: "session.create", params: { profile: "coder", title: "New chat" } });
  await connection.request(
    { method: "session.create", params: { profile: "coder", title: "Seeded chat" } },
    { sessionCreateSystemSeed: "Office shared context" },
  );
  await connection.request({ method: "session.resume", params: { session_id: "stored-1", profile: "coder" } });
  await connection.request(
    { method: "prompt.submit", params: { session_id: "live-1", text: "What changed?" } },
    { studioDefaultDelegationTurn: true, studioFollowUpTurn: true },
  );
  await connection.request({ method: "clarify.respond", params: { request_id: "clarify-1", answer: "" } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(observedToken, TOKEN);
  assert.equal(received.length, 5);
  assert.equal(received[0]?.method, "session.create");
  assert.deepEqual(received[0]?.params, { profile: "coder", title: "New chat", close_on_disconnect: true, source: "desktop" });
  assert.deepEqual(received[1]?.params, { profile: "coder", title: "Seeded chat", close_on_disconnect: true, source: "desktop", messages: [{ role: "system", content: "Office shared context" }] });
  assert.deepEqual(received[2]?.params, { session_id: "stored-1", profile: "coder", close_on_disconnect: true, source: "desktop" });
  assert.deepEqual(received[3]?.params, {
    session_id: "live-1",
    text: appendStudioFollowUpTurnInstruction(
      appendStudioDefaultDelegationTurnInstruction("What changed?", MINIMAL_TEST_CATALOG),
    ),
  });
  assert.deepEqual(received[4]?.params, { request_id: "clarify-1", answer: "" });
  assert.deepEqual(result.value, { liveSessionId: "live-1", storedSessionId: "stored-1", messageCount: 0, running: false, status: "RPC_TOKEN=[REDACTED]", model: "model-safe", provider: "provider-safe", reasoningEffort: "high" });
  assert.equal(JSON.stringify(result).includes("private/path"), false);
  assert.equal(events.length, 8);
  assert.deepEqual(events[0], { type: "status.update", sessionId: "live-1", payload: { kind: "KIND_TOKEN=[REDACTED]", status: "STATUS_TOKEN=[REDACTED]", message: "Preparing with ci_token = '[REDACTED]'" } });
  assert.equal(events[1]?.type, "approval.request");
  assert.equal(events[1]?.payload.command, "curl https://x/?token=[REDACTED]");
  assert.equal(events[1]?.payload.description, 'AWS_SECRET_ACCESS_KEY = "[REDACTED]"');
  assert.deepEqual(events[1]?.payload.choices, ["once", "CHOICE_TOKEN=[REDACTED]", "deny"]);
  assert.deepEqual(events[2], { type: "clarify.request", sessionId: "live-1", payload: { requestId: "clarify-1", question: "Continue?", choices: ["yes", "OPENAI_API_KEY=[REDACTED]"] } });
  assert.equal(events[3]?.payload.text, "OPENAI_API_KEY=[REDACTED]; [REDACTED]; [REDACTED]\nAuthorization: [REDACTED]");
  const messageIds = events[3]?.payload.messageIds;
  assert.ok(Array.isArray(messageIds));
  assert.equal(messageIds.length, 2);
  assert.equal(events[3]?.payload.messageId, messageIds[0]);
  assert.equal(String(messageIds[0]).startsWith("message-source-"), true);
  assert.equal(JSON.stringify(events[3]).includes("opaque/message+1=="), false);
  assert.equal(JSON.stringify(events[3]).includes("shared-message-alias"), false);
  assert.equal(events[4]?.payload.name, "TOOL_TOKEN=[REDACTED]");
  const firstToolIds = events[4]?.payload.toolIds;
  assert.ok(Array.isArray(firstToolIds));
  assert.equal(firstToolIds.length, 2);
  assert.equal(events[4]?.payload.toolId, firstToolIds[0]);
  assert.equal(String(firstToolIds[0]).startsWith("tool-source-"), true);
  assert.equal(JSON.stringify(events[4]).includes("opaque/call+1=="), false);
  assert.equal(events[4]?.payload.status, "STATUS_TOKEN=[REDACTED]");
  assert.equal(events[4]?.payload.summary, "database_password = '[REDACTED]'");
  const secondToolIds = events[5]?.payload.toolIds;
  assert.ok(Array.isArray(secondToolIds));
  assert.equal(secondToolIds.length, 2, "an oversized occurrence id is ignored before hashing");
  assert.equal(events[5]?.payload.toolId, secondToolIds[0]);
  assert.equal(firstToolIds[1], secondToolIds[1], "the shared alias remains stable across phases");
  assert.equal(JSON.stringify(events[5]).includes("tool-call-2"), false);
  assert.deepEqual(events[6]?.payload, { model: "model-safe", provider: "provider-safe", reasoningEffort: "high" });
  assert.deepEqual(events[7]?.payload, {
    status: "STATUS_TOKEN=[REDACTED]",
    message: "service_secret: [REDACTED]",
    model: "MODEL_TOKEN=[REDACTED]",
    provider: "PROVIDER_TOKEN=[REDACTED]",
    version: "VERSION_TOKEN=[REDACTED]",
  });
  assert.equal(JSON.stringify(events).includes("hidden"), false);
  for (const secret of [DASHBOARD_SECRET, OPENAI_SECRET, AWS_SECRET, PASSWORD_SECRET, SERVICE_SECRET, OPENAI_STANDALONE_SECRET, AUTH_HEADER_SECRET, JWT_SECRET]) {
    assert.equal(JSON.stringify(events).includes(secret), false);
  }
  await connection.close();
});

test("chat boundary rejects arbitrary methods, unsafe params, IDs, and profiles before I/O", async (t) => {
  let frameCount = 0;
  const http = createServer((_request, response) => { response.writeHead(404).end(); });
  const sockets = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket, request)));
  sockets.on("connection", (websocket) => websocket.on("message", () => { frameCount += 1; }));
  const origin = await listen(http);
  t.after(() => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    http.close();
  });

  const transport = createHermesChatTransport({ baseUrl: origin, sessionToken: TOKEN });
  const connection = await transport.connect(() => undefined);
  await assert.rejects(
    connection.request({ method: "secret.respond", params: { request_id: "a", value: "secret" } } as unknown as HermesChatRequest),
    (error: unknown) => error instanceof HermesChatTransportError && error.code === "invalid_request",
  );
  await assert.rejects(
    connection.request({ method: "session.create", params: { profile: "../escape", cwd: "/tmp" } }),
    (error: unknown) => error instanceof HermesChatTransportError && error.code === "invalid_request",
  );
  await assert.rejects(
    connection.request({ method: "session.create", params: { profile: "coder", messages: [{ role: "system", content: "browser seed" }] } }),
    (error: unknown) => error instanceof HermesChatTransportError && error.code === "invalid_request",
  );
  await assert.rejects(
    connection.request({ method: "slash.exec", params: { session_id: "live-1", command: "/config set unsafe" } }),
    (error: unknown) => error instanceof HermesChatTransportError && error.code === "invalid_request",
  );
  await assert.rejects(
    connection.request({ method: "slash.exec", params: { session_id: "live-1", command: "/memory clear" } }),
    (error: unknown) => error instanceof HermesChatTransportError && error.code === "invalid_request",
  );
  await assert.rejects(
    connection.request({ method: "slash.exec", params: { session_id: "live-1", command: "/model gpt-5.6-terra" } }),
    (error: unknown) => error instanceof HermesChatTransportError && error.code === "invalid_request",
  );
  await assert.rejects(
    connection.request({ method: "slash.exec", params: { session_id: "live-1", command: "/help", confirm_expensive_model: true } }),
    (error: unknown) => error instanceof HermesChatTransportError && error.code === "invalid_request",
  );
  await assert.rejects(
    transport.fetchHistory({ sessionId: "../../state.db", profile: "coder" }),
    (error: unknown) => error instanceof HermesChatTransportError && error.code === "invalid_request",
  );
  assert.equal(frameCount, 0);
  await connection.close();
});

test("an expensive session model switch can be confirmed without widening the slash boundary", async (t) => {
  const received: Array<Record<string, unknown>> = [];
  const http = createServer((_request, response) => { response.writeHead(404).end(); });
  const sockets = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket, request)));
  sockets.on("connection", (websocket) => websocket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    received.push(frame);
    const params = frame.params as Record<string, unknown>;
    const confirmed = params.confirm_expensive_model === true;
    websocket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: frame.id,
      result: confirmed
        ? { key: "model", value: "costly-model", warning: "", confirm_required: false }
        : { key: "model", value: "costly-model", warning: "High known pricing", confirm_required: true, confirm_message: "Continue with costly-model?" },
    }));
  }));
  const origin = await listen(http);
  t.after(() => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    http.close();
  });

  const connection = await createHermesChatTransport({ baseUrl: origin, sessionToken: TOKEN }).connect(() => undefined);
  const command = "/model costly-model --provider costly --session";
  const initial = await connection.request({ method: "slash.exec", params: { session_id: "live-1", command } });
  const confirmed = await connection.request({
    method: "slash.exec",
    params: { session_id: "live-1", command, confirm_expensive_model: true },
  });

  assert.deepEqual(initial.value, {
    status: "confirm_required",
    warning: "High known pricing",
    confirmMessage: "Continue with costly-model?",
    key: "model",
    value: "costly-model",
  });
  assert.deepEqual(confirmed.value, {
    status: "ok",
    warning: "",
    key: "model",
    value: "costly-model",
  });
  assert.deepEqual(received.map((frame) => frame.method), ["config.set", "config.set"]);
  assert.deepEqual(received.map((frame) => (frame.params as Record<string, unknown>).confirm_expensive_model), [false, true]);
  await connection.close();
});

test("session reasoning can be restored to the Hermes default", async (t) => {
  let received: Record<string, unknown> | undefined;
  const http = createServer((_request, response) => { response.writeHead(404).end(); });
  const sockets = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket, request)));
  sockets.on("connection", (websocket) => websocket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    received = frame;
    websocket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: frame.id,
      result: { key: "reasoning", value: "" },
    }));
  }));
  const origin = await listen(http);
  t.after(() => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    http.close();
  });

  const connection = await createHermesChatTransport({ baseUrl: origin, sessionToken: TOKEN }).connect(() => undefined);
  const result = await connection.request({
    method: "slash.exec",
    params: { session_id: "live-1", command: "/reasoning default" },
  });

  assert.equal(received?.method, "config.set");
  assert.deepEqual(received?.params, { session_id: "live-1", key: "reasoning", value: "" });
  assert.deepEqual(result.value, { status: "ok", key: "reasoning", value: "" });
  await connection.close();
});

test("chat boundary returns public errors without reflecting Hermes details", async (t) => {
  const http = createServer((_request, response) => { response.writeHead(404).end(); });
  const sockets = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket, request)));
  sockets.on("connection", (websocket) => websocket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    websocket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: 5000, message: "Failed at /Users/private with api_key=supersecretvalue", data: { token: "hidden" } } }));
  }));
  const origin = await listen(http);
  t.after(() => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    http.close();
  });

  const connection = await createHermesChatTransport({ baseUrl: origin, sessionToken: TOKEN }).connect(() => undefined);
  await assert.rejects(
    connection.request({ method: "session.interrupt", params: { session_id: "live-1" } }),
    (error: unknown) => error instanceof HermesChatTransportError && error.message === "Hermes rejected the chat request." && !error.message.includes("private"),
  );
  await connection.close();
});

test("session.close preserves false and rejects a malformed success result", async (t) => {
  const http = createServer((_request, response) => { response.writeHead(404).end(); });
  const sockets = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket, request)));
  sockets.on("connection", (websocket) => websocket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    const params = frame.params as Record<string, unknown>;
    websocket.send(JSON.stringify({
      jsonrpc: "2.0", id: frame.id,
      result: params.session_id === "live-malformed" ? { status: "missing closed" } : { closed: false },
    }));
  }));
  const origin = await listen(http);
  t.after(() => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    http.close();
  });

  const connection = await createHermesChatTransport({ baseUrl: origin, sessionToken: TOKEN }).connect(() => undefined);
  const absent = await connection.request({ method: "session.close", params: { session_id: "live-absent" } });
  assert.deepEqual(absent.value, { closed: false });
  await assert.rejects(
    connection.request({ method: "session.close", params: { session_id: "live-malformed" } }),
    (error: unknown) => error instanceof HermesChatTransportError && error.code === "backend_rejected",
  );
  await connection.close();
});

test("prompt and interrupt accept only the pinned Hermes 0.18.2 success shapes", async (t) => {
  const http = createServer((_request, response) => { response.writeHead(404).end(); });
  const sockets = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket, request)));
  sockets.on("connection", (websocket) => websocket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    const params = frame.params as Record<string, unknown>;
    const sessionId = String(params.session_id);
    const result = sessionId === "prompt-valid" ? { status: "streaming", task_id: "task-1" }
      : sessionId === "interrupt-valid" ? { status: "interrupted" }
        : sessionId.endsWith("-empty") ? undefined
          : { status: "accepted" };
    websocket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
  }));
  const origin = await listen(http);
  t.after(() => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    http.close();
  });

  const connection = await createHermesChatTransport({ baseUrl: origin, sessionToken: TOKEN }).connect(() => undefined);
  assert.deepEqual(
    (await connection.request({ method: "prompt.submit", params: { session_id: "prompt-valid", text: "run" } })).value,
    { status: "streaming", taskId: "task-1" },
  );
  assert.deepEqual(
    (await connection.request({ method: "session.interrupt", params: { session_id: "interrupt-valid" } })).value,
    { status: "interrupted" },
  );
  for (const [method, sessionId, params] of [
    ["prompt.submit", "prompt-invalid", { session_id: "prompt-invalid", text: "run" }],
    ["prompt.submit", "prompt-empty", { session_id: "prompt-empty", text: "run" }],
    ["session.interrupt", "interrupt-invalid", { session_id: "interrupt-invalid" }],
    ["session.interrupt", "interrupt-empty", { session_id: "interrupt-empty" }],
  ] as const) {
    await assert.rejects(
      connection.request({ method, params }),
      (error: unknown) => error instanceof HermesChatTransportError && error.code === "backend_rejected",
      `${method} ${sessionId} must reject a malformed success frame`,
    );
  }
  await connection.close();
});

test("chat transport reports one lifecycle close and rejects pending RPC", async (t) => {
  let terminateUpstream!: () => void;
  let closedCount = 0;
  const http = createServer((_request, response) => { response.writeHead(404).end(); });
  const sockets = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket, request)));
  sockets.on("connection", (websocket) => { terminateUpstream = () => websocket.terminate(); });
  const origin = await listen(http);
  t.after(() => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    http.close();
  });

  const connection = await createHermesChatTransport({ baseUrl: origin, sessionToken: TOKEN }).connect(
    () => undefined,
    () => { closedCount += 1; },
  );
  const pending = connection.request({ method: "session.interrupt", params: { session_id: "live-pending" } });
  terminateUpstream();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof HermesChatTransportError && error.code === "backend_closed",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closedCount, 1);
  assert.equal(connection.closed, true);
});

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function writeJson(response: ServerResponse<IncomingMessage>, value: unknown): void {
  const text = JSON.stringify(value);
  response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  response.end(text);
}
