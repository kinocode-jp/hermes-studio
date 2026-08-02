import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import type { HermesChatRequest } from "./hermes-chat.js";
import { createDemoRuntimeStatus, createDemoSnapshot } from "./demo-state.js";
import { createStudioServer } from "./server.js";

const ORIGIN = "https://office.tailnet.example";
const TOKEN = "remote-chat-enrollment-token-with-32-chars";

test("remote operator can resume, interrupt, and read visible single-tenant sessions while pending replies stay socket-bound", async (t) => {
  const captured: HermesChatRequest[] = [];
  const runtime = {
    status: createDemoRuntimeStatus,
    snapshot: async () => createDemoSnapshot(),
    close: async () => undefined,
    kanban: () => { throw new Error("unused"); },
    chat: () => ({
      inspectHistory: async ({ sessionId }: { sessionId: string }) => ({ sessionId, total: 0 }),
      fetchHistory: async ({ sessionId, profile }: { sessionId: string; profile: string }) => ({
        sessionId, profile, messages: [], pagination: { limit: 200, offset: 0, returned: 0, normalizedReturned: 0, dropped: 0 },
      }),
      connect: async () => ({
        closed: false,
        close: async () => undefined,
        request: async (request: HermesChatRequest) => {
          captured.push(request);
          if (request.method === "session.resume") {
            const storedSessionId = String(request.params?.session_id);
            return { method: request.method, value: { liveSessionId: storedSessionId, storedSessionId, running: false, status: "idle" } };
          }
          return { method: request.method, value: { status: "ok" } };
        },
      }),
    }),
  } as unknown as HermesRuntimeSource;
  const server = createStudioServer({ port: 0, runtimeSource: runtime, remoteToken: TOKEN, trustedProxyHops: 1, allowedOrigins: [ORIGIN] });
  const address = await server.listen();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/v1/auth/device`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Forwarded-Proto": "https", "X-Forwarded-For": "100.64.0.20" },
    body: JSON.stringify({ token: TOKEN, deviceName: "Remote operator" }),
  });
  assert.equal(login.status, 200);
  const cookie = requestCookies(login);

  const history = await fetch(`${base}/api/v1/sessions/stored-existing/messages?profile=default`, {
    headers: { Origin: ORIGIN, Cookie: cookie },
  });
  assert.equal(history.status, 200);
  assert.equal((await history.json() as { sessionId: string }).sessionId, "stored-existing");

  const websocket = new WebSocket(`${base.replace("http:", "ws:")}/api/v1/chat`, { headers: { Origin: ORIGIN, Cookie: cookie } });
  t.after(() => websocket.terminate());
  await waitForFrame(websocket, (frame) => frame.method === "office.ready");
  websocket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.resume", params: { session_id: "stored-existing", profile: "default" } }));
  assert.equal((await waitForFrame(websocket, (frame) => frame.id === 1)).error, undefined);
  websocket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session.interrupt", params: { session_id: "stored-existing" } }));
  assert.equal((await waitForFrame(websocket, (frame) => frame.id === 2)).error, undefined);
  websocket.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "approval.respond", params: { session_id: "stored-existing", choice: "once" } }));
  assert.equal(typeof (await waitForFrame(websocket, (frame) => frame.id === 3)).error, "object");
  assert.deepEqual(captured.map((request) => request.method), ["session.resume", "session.interrupt"]);
  websocket.close();
});

function requestCookies(response: Response): string {
  return [...(response.headers.get("set-cookie") ?? "").matchAll(/(?:^|,\s*)(hermes_office_(?:device|session))=([^;,\s]+)/g)]
    .map((match) => `${match[1]}=${match[2]}`)
    .join("; ");
}

async function waitForFrame(
  websocket: WebSocket,
  predicate: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("WebSocket frame timed out.")); }, 2_000);
    const onMessage = (data: WebSocket.RawData): void => {
      try {
        const frame = JSON.parse(data.toString()) as unknown;
        if (typeof frame === "object" && frame !== null && !Array.isArray(frame) && predicate(frame as Record<string, unknown>)) {
          cleanup(); resolve(frame as Record<string, unknown>);
        }
      } catch { /* Ignore unrelated malformed frames. */ }
    };
    const onError = (): void => { cleanup(); reject(new Error("WebSocket failed.")); };
    const cleanup = (): void => { clearTimeout(timer); websocket.off("message", onMessage); websocket.off("error", onError); };
    websocket.on("message", onMessage);
    websocket.on("error", onError);
  });
}
