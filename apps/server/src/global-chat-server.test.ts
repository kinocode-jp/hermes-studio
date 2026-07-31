import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import type { HermesChatInternalRequestOptions, HermesChatRequest } from "./hermes-chat.js";
import { createDemoRuntimeStatus, createDemoSnapshot } from "./demo-state.js";
import { createStudioServer } from "./server.js";

test("Studio Server seeds session.create and reinforces follow-ups on every prompt", async (t) => {
  const captured: Array<{ request: HermesChatRequest; internal?: HermesChatInternalRequestOptions }> = [];
  let contextReads = 0;
  const runtime = {
    status: createDemoRuntimeStatus,
    snapshot: async () => createDemoSnapshot(),
    close: async () => undefined,
    kanban: () => { throw new Error("unused"); },
    chat: () => ({
      inspectHistory: async ({ sessionId }: { sessionId: string }) => ({ sessionId, total: 0 }),
      fetchHistory: async () => { throw new Error("unused"); },
      connect: async () => ({
        closed: false,
        close: async () => undefined,
        request: async (request: HermesChatRequest, internal?: HermesChatInternalRequestOptions) => {
          captured.push({ request, ...(internal === undefined ? {} : { internal }) });
          if (request.method === "session.create") {
            return { method: request.method, value: { liveSessionId: "live-created", storedSessionId: "stored-created", running: false, status: "idle" } };
          }
          if (request.method === "session.resume") {
            return { method: request.method, value: { liveSessionId: "live-resumed", storedSessionId: String(request.params?.session_id), running: false, status: "idle" } };
          }
          return { method: request.method, value: { status: request.method === "prompt.submit" ? "streaming" : "ok" } };
        },
      }),
    }),
    globalInheritance: () => ({
      sessionCreateContext: async () => { contextReads += 1; return "Office-only shared context"; },
    }),
  } as unknown as HermesRuntimeSource;
  const server = createStudioServer({ port: 0, runtimeSource: runtime, allowedOrigins: ["http://localhost:4173"] });
  const address = await server.listen();
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${address.port}`;
  const browserOrigin = "http://localhost:4173";
  const auth = await fetch(`${origin}/api/v1/auth/local`, { method: "POST", headers: { Origin: browserOrigin } });
  const cookie = (auth.headers.get("set-cookie") ?? "").split(";")[0]!;
  const websocket = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/chat`, { headers: { Origin: browserOrigin, Cookie: cookie } });
  t.after(() => websocket.terminate());

  await waitForMethod(websocket, "office.ready");
  websocket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.create", params: { profile: "coder" } }));
  await waitForId(websocket, 1);
  websocket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "prompt.submit", params: { session_id: "live-created", text: "質問です" } }));
  await waitForId(websocket, 2);
  websocket.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session.resume", params: { profile: "coder", session_id: "stored-1" } }));
  await waitForId(websocket, 3);

  assert.equal(contextReads, 1);
  assert.deepEqual(captured[0]?.internal, { sessionCreateSystemSeed: "Office-only shared context" });
  assert.deepEqual(captured[1]?.internal, { studioFollowUpTurn: true });
  assert.equal(captured[2]?.internal, undefined);
  websocket.close();
});

async function waitForMethod(websocket: WebSocket, method: string): Promise<void> {
  await waitForFrame(websocket, (frame) => frame.method === method);
}

async function waitForId(websocket: WebSocket, id: number): Promise<void> {
  await waitForFrame(websocket, (frame) => frame.id === id);
}

async function waitForFrame(websocket: WebSocket, predicate: (frame: Record<string, unknown>) => boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("WebSocket frame timed out.")); }, 2_000);
    const onMessage = (data: WebSocket.RawData): void => {
      let frame: unknown;
      try { frame = JSON.parse(data.toString()); } catch { return; }
      if (typeof frame === "object" && frame !== null && !Array.isArray(frame) && predicate(frame as Record<string, unknown>)) { cleanup(); resolve(); }
    };
    const onError = (): void => { cleanup(); reject(new Error("WebSocket failed.")); };
    const cleanup = (): void => { clearTimeout(timer); websocket.off("message", onMessage); websocket.off("error", onError); };
    websocket.on("message", onMessage);
    websocket.on("error", onError);
  });
}
