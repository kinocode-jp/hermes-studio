import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import { ChatDeviceRateLimiter, handleOfficeChatConnection } from "./chat-gateway.js";
import {
  HermesChatTransportError,
  type HermesChatConnection,
  type HermesChatEvent,
  type HermesChatRequest,
} from "./hermes-chat.js";
import { ChatSessionCoordinator } from "./chat-session-coordinator.js";
import { ChatUpstreamHub } from "./chat-upstream-hub.js";
import { OfficeAuth, type OfficeAuthSession } from "./office-auth.js";

const SESSION: OfficeAuthSession = {
  principal: { id: "boundary-device", tier: "operator", local: false, deviceName: "Boundary device" },
  csrfToken: "c".repeat(32),
  expiresAt: "2099-01-01T00:00:00.000Z",
};

test("prompt received by Hermes then closed upstream is reported as commit_unconfirmed before downstream close", async () => {
  let closeUpstream!: () => void;
  const requests: HermesChatRequest[] = [];
  const runtime = chatRuntime((onClosed) => {
    closeUpstream = onClosed;
    return connection(async (request) => {
      requests.push(request);
      if (request.method === "session.resume") return resumeResult(request, "live-uncertain");
      if (request.method === "prompt.submit") {
        closeUpstream();
        throw new HermesChatTransportError("backend_closed", "private upstream detail");
      }
      return { method: request.method, value: { status: "ok" } };
    });
  });
  const client = new DelayedCloseWebSocket();
  connectGateway(client, runtime);
  await settle();

  client.rpc(1, "session.resume", { session_id: "stored-uncertain", profile: "default" });
  await settle();
  client.rpc(2, "prompt.submit", { session_id: "live-uncertain", text: "run once" });
  await settle(8);

  assert.equal(requests.filter(({ method }) => method === "prompt.submit").length, 1);
  assert.deepEqual(client.error(2), {
    code: -32008,
    message: "Hermes may have committed this request; reload history before retrying.",
    data: { reason: "commit_unconfirmed" },
  });
  assert.equal(JSON.stringify(client.frames()).includes("private upstream detail"), false);
  assert.deepEqual(client.closeCalls.at(-1), { code: 1013, reason: "Hermes chat restarted; reload history" });
});

test("slash mutation received by Hermes then closed upstream is reported as commit_unconfirmed", async () => {
  let closeUpstream!: () => void;
  const requests: HermesChatRequest[] = [];
  const runtime = chatRuntime((onClosed) => {
    closeUpstream = onClosed;
    return connection(async (request) => {
      requests.push(request);
      if (request.method === "session.resume") return resumeResult(request, "live-slash-uncertain");
      if (request.method === "slash.exec") {
        closeUpstream();
        throw new HermesChatTransportError("backend_closed", "private slash detail");
      }
      return { method: request.method, value: { status: "ok" } };
    });
  });
  const client = new DelayedCloseWebSocket();
  connectGateway(client, runtime);
  await settle();

  client.rpc(1, "session.resume", { session_id: "stored-slash-uncertain", profile: "default" });
  await settle();
  client.rpc(2, "slash.exec", { session_id: "live-slash-uncertain", command: "/compact" });
  await settle(8);

  assert.equal(requests.filter(({ method }) => method === "slash.exec").length, 1);
  assert.deepEqual(client.error(2), {
    code: -32008,
    message: "Hermes may have committed this request; reload history before retrying.",
    data: { reason: "commit_unconfirmed" },
  });
  assert.equal(JSON.stringify(client.frames()).includes("private slash detail"), false);
});

test("steer received by Hermes then closed upstream is reported as commit_unconfirmed", async () => {
  let closeUpstream!: () => void;
  const requests: HermesChatRequest[] = [];
  const runtime = chatRuntime((onClosed) => {
    closeUpstream = onClosed;
    return connection(async (request) => {
      requests.push(request);
      if (request.method === "session.resume") return resumeResult(request, "live-steer-uncertain");
      if (request.method === "session.steer") {
        closeUpstream();
        throw new HermesChatTransportError("backend_closed", "private steer detail");
      }
      return { method: request.method, value: { status: "ok" } };
    });
  });
  const client = new DelayedCloseWebSocket();
  connectGateway(client, runtime);
  await settle();

  client.rpc(1, "session.resume", { session_id: "stored-steer-uncertain", profile: "default" });
  await settle();
  client.rpc(2, "session.steer", { session_id: "live-steer-uncertain", text: "change direction" });
  await settle(8);

  assert.equal(requests.filter(({ method }) => method === "session.steer").length, 1);
  assert.deepEqual(client.error(2), {
    code: -32008,
    message: "Hermes may have committed this request; reload history before retrying.",
    data: { reason: "commit_unconfirmed" },
  });
  assert.equal(JSON.stringify(client.frames()).includes("private steer detail"), false);
});

test("an explicit Hermes prompt rejection remains a definitive generic rejection", async () => {
  const runtime = chatRuntime(() => connection(async (request) => {
    if (request.method === "session.resume") return resumeResult(request, "live-rejected");
    throw new HermesChatTransportError("backend_rejected", "private rejection", 4090);
  }));
  const client = new DelayedCloseWebSocket();
  connectGateway(client, runtime);
  await settle();
  client.rpc(1, "session.resume", { session_id: "stored-rejected", profile: "default" });
  await settle();
  client.rpc(2, "prompt.submit", { session_id: "live-rejected", text: "reject me" });
  await settle();

  assert.equal(client.error(2)?.code, -32000);
  assert.equal(client.error(2)?.data, undefined);
  assert.equal(JSON.stringify(client.frames()).includes("private rejection"), false);
});

test("revocation signal invalidates queued chat work without waiting for the socket close handshake", async () => {
  const gate = deferred<void>();
  const requests: HermesChatRequest[] = [];
  const runtime = chatRuntime(() => connection(async (request) => {
    requests.push(request);
    if (request.method === "session.resume") return resumeResult(request, "live-revoked");
    if (request.method === "session.interrupt") await gate.promise;
    return { method: request.method, value: { status: "ok" } };
  }));
  const controller = new AbortController();
  const client = new DelayedCloseWebSocket();
  connectGateway(client, runtime, { invalidationSignal: controller.signal, sessionIsActive: () => true });
  await settle();
  client.rpc(1, "session.resume", { session_id: "stored-revoked", profile: "default" });
  await settle();
  client.rpc(2, "session.interrupt", { session_id: "live-revoked" });
  client.rpc(3, "prompt.submit", { session_id: "live-revoked", text: "must never run" });
  await settle();

  controller.abort();
  assert.equal(client.readyState, WebSocket.OPEN, "the test deliberately withholds the peer close handshake");
  gate.resolve(undefined);
  await settle(8);

  assert.equal(requests.some(({ method }) => method === "prompt.submit"), false);
  assert.deepEqual(client.closeCalls.at(-1), { code: 1008, reason: "Session expired or revoked" });
});

test("expiry is revalidated before dequeue and clears queued chat work", async () => {
  const gate = deferred<void>();
  const requests: HermesChatRequest[] = [];
  let active = true;
  const runtime = chatRuntime(() => connection(async (request) => {
    requests.push(request);
    if (request.method === "session.resume") return resumeResult(request, "live-expired");
    if (request.method === "session.interrupt") await gate.promise;
    return { method: request.method, value: { status: "ok" } };
  }));
  const client = new DelayedCloseWebSocket();
  connectGateway(client, runtime, { sessionIsActive: () => active });
  await settle();
  client.rpc(1, "session.resume", { session_id: "stored-expired", profile: "default" });
  await settle();
  client.rpc(2, "session.interrupt", { session_id: "live-expired" });
  client.rpc(3, "prompt.submit", { session_id: "live-expired", text: "must never dequeue" });
  await settle();

  active = false;
  gate.resolve(undefined);
  await settle(8);

  assert.equal(requests.some(({ method }) => method === "prompt.submit"), false);
  assert.deepEqual(client.closeCalls.at(-1), { code: 1008, reason: "Session expired or revoked" });
});

test("expiry during asynchronous request preparation is revalidated immediately before upstream I/O", async () => {
  const seed = deferred<string>();
  const requests: HermesChatRequest[] = [];
  let active = true;
  const runtime = chatRuntime(
    () => connection(async (request) => {
      requests.push(request);
      return { method: request.method, value: { status: "ok" } };
    }),
    () => seed.promise,
  );
  const client = new DelayedCloseWebSocket();
  connectGateway(client, runtime, { sessionIsActive: () => active });
  await settle();
  client.rpc(1, "session.create", { profile: "default" });
  await settle();

  active = false;
  seed.resolve("global context");
  await settle(8);

  assert.equal(requests.length, 0);
  assert.deepEqual(client.closeCalls.at(-1), { code: 1008, reason: "Session expired or revoked" });
});

function connectGateway(
  client: DelayedCloseWebSocket,
  runtime: HermesRuntimeSource,
  authBoundary: { invalidationSignal?: AbortSignal; sessionIsActive?: () => boolean } = {},
): void {
  const coordinator = new ChatSessionCoordinator();
  handleOfficeChatConnection(client as unknown as WebSocket, {
    auth: new OfficeAuth(), officeSession: SESSION, runtimeSource: runtime,
    maxJsonBytes: 64 * 1024,
    deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
    limits: { maxInFlight: 1, socketRateCapacity: 100 },
    sessionCoordinator: coordinator,
    chatHub: new ChatUpstreamHub(runtime, coordinator, 64 * 1024),
    ...authBoundary,
  });
}

function chatRuntime(
  makeConnection: (onClosed: () => void) => HermesChatConnection,
  sessionCreateContext?: () => Promise<string>,
): HermesRuntimeSource {
  return {
    chat: () => ({
      connect: async (_onEvent: (event: HermesChatEvent) => void, onClosed?: () => void) =>
        makeConnection(onClosed ?? (() => undefined)),
    }),
    ...(sessionCreateContext === undefined ? {} : {
      globalInheritance: () => ({ sessionCreateContext }),
    }),
  } as unknown as HermesRuntimeSource;
}

function connection(
  request: HermesChatConnection["request"],
): HermesChatConnection {
  return { closed: false, close: async () => undefined, request };
}

function resumeResult(request: HermesChatRequest, liveSessionId: string) {
  return {
    method: request.method,
    value: {
      storedSessionId: String(request.params?.session_id),
      liveSessionId,
      running: false,
      status: "idle",
    },
  };
}

class DelayedCloseWebSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code: number; reason: string }> = [];

  send(body: string, callback?: (error?: Error) => void): void {
    this.sent.push(body);
    callback?.();
  }

  close(code: number, reason: string): void {
    this.closeCalls.push({ code, reason });
  }

  rpc(id: number, method: string, params: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params })), false);
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((body) => JSON.parse(body) as Record<string, unknown>);
  }

  error(id: number): { code?: number; message?: string; data?: unknown } | undefined {
    return this.frames().find((frame) => frame.id === id)?.error as { code?: number; message?: string; data?: unknown } | undefined;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle(turns = 4): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
