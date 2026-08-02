import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import type { HermesChatInternalRequestOptions, HermesChatRequest } from "./hermes-chat.js";
import { createDemoRuntimeStatus, createDemoSnapshot } from "./demo-state.js";
import {
  composeSessionCreateSystemSeed,
  studioDefaultProfileOrchestrationInstruction,
  studioFollowUpSessionInstruction,
} from "./office-agent-behavior.js";
import { createStudioServer } from "./server.js";
import { resolveDefaultDelegationModelCatalog } from "./chat-gateway.js";

test("model catalog deadline never starts new adapter calls after bounded workers expire", async () => {
  const snapshot = createDemoSnapshot();
  const profiles = Array.from({ length: 8 }, (_, index) => ({
    ...snapshot.profiles[0]!,
    id: `profile-${index}`,
    name: `Profile ${index}`,
  }));
  let providerCalls = 0;
  const never = new Promise<never>(() => undefined);
  const runtime = {
    snapshot: async () => ({ ...snapshot, profiles }),
    models: () => ({
      loadLiveCatalog: async (profile: string, provider?: string) => {
        if (provider !== undefined) {
          providerCalls += 1;
          return await never;
        }
        return {
          profile,
          providers: Array.from({ length: 16 }, (_, index) => ({
            id: `provider-${index}`, label: `Provider ${index}`, active: index === 0,
          })),
          provider: "provider-0",
          defaultProvider: "provider-0",
          defaultModel: "model-0",
          models: [{ id: "model-0", label: "Model 0" }],
          refreshedAt: "2026-08-02T00:00:00.000Z",
        };
      },
      syncLocalCliProviders: async () => ({ registered: 0 }),
    }),
  } as unknown as HermesRuntimeSource;

  const catalog = await resolveDefaultDelegationModelCatalog(runtime, 100);
  assert.ok(providerCalls > 0);
  assert.ok(providerCalls <= 4, "deadline expiry cannot launch more than the already-running worker calls");
  assert.match(catalog ?? "", /"catalogStatus":"partial"/);
});

test("delegation catalog never reports complete when Profile inventory metadata is partial", async (context) => {
  const base = createDemoSnapshot();
  const cases = [
    { name: "truncated", patch: { truncated: true } },
    { name: "partial failures", patch: { partialFailures: 1, truncated: true } },
    { name: "continuation", patch: { hasMore: true, nextCursor: "next" } },
    { name: "available rows omitted", patch: { returned: 1, available: 2, total: 2 } },
  ] as const;
  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const runtime = {
        snapshot: async () => ({
          ...base,
          inventory: {
            ...base.inventory,
            profiles: { ...base.inventory.profiles, ...scenario.patch },
          },
        }),
        models: () => ({
          loadLiveCatalog: async (profile: string) => ({
            profile,
            providers: [{ id: "openai", label: "OpenAI", active: true }],
            provider: "openai",
            defaultProvider: "openai",
            defaultModel: "gpt-main",
            models: [{ id: "gpt-main", label: "GPT" }],
            refreshedAt: "2026-08-02T00:00:00.000Z",
          }),
          syncLocalCliProviders: async () => ({ registered: 0 }),
        }),
      } as unknown as HermesRuntimeSource;
      assert.match(await resolveDefaultDelegationModelCatalog(runtime) ?? "", /"catalogStatus":"partial"/);
    });
  }
});

test("Studio Server reinforces delegation only for default Profile prompts", async (t) => {
  const captured: Array<{ request: HermesChatRequest; internal?: HermesChatInternalRequestOptions }> = [];
  const catalogReads: Array<{ profile: string; provider?: string }> = [];
  let contextReads = 0;
  let catalogUnavailable = false;
  let snapshotUnavailable = false;
  const runtime = {
    status: createDemoRuntimeStatus,
    snapshot: async () => {
      if (snapshotUnavailable) throw new Error("synthetic snapshot failure");
      return createDemoSnapshot();
    },
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
            const profile = String(request.params?.profile ?? "default");
            return { method: request.method, value: { liveSessionId: `live-${profile}`, storedSessionId: `stored-${profile}`, running: false, status: "idle" } };
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
    models: () => ({
      loadLiveCatalog: async (profile: string, provider?: string) => {
        catalogReads.push({ profile, ...(provider === undefined ? {} : { provider }) });
        if (catalogUnavailable) throw new Error("synthetic catalog failure");
        const selected = provider ?? "openai";
        return {
          profile,
          providers: [
            { id: "openai", label: "ignored label", active: selected === "openai" },
            { id: "local", label: "ignored local label", active: selected === "local" },
          ],
          provider: selected,
          defaultProvider: "openai",
          defaultModel: "gpt-main",
          models: selected === "openai"
            ? [{ id: "gpt-main", label: "ignored model label", reasoningEfforts: ["low", "high"] }]
            : [{ id: "local-main", label: "ignored local model label" }],
          refreshedAt: "2026-08-02T00:00:00.000Z",
        };
      },
      syncLocalCliProviders: async () => ({ registered: 0 }),
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
  websocket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "prompt.submit", params: { session_id: "live-coder", text: "質問です" } }));
  await waitForId(websocket, 2);
  websocket.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session.create", params: { profile: "default" } }));
  await waitForId(websocket, 3);
  websocket.send(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "prompt.submit", params: { session_id: "live-default", text: "実装を依頼します" } }));
  await waitForId(websocket, 4);
  websocket.send(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "session.resume", params: { profile: "coder", session_id: "stored-1" } }));
  await waitForId(websocket, 5);
  catalogUnavailable = true;
  websocket.send(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "prompt.submit", params: { session_id: "live-default", text: "別の依頼です" } }));
  await waitForId(websocket, 6);
  snapshotUnavailable = true;
  websocket.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "prompt.submit", params: { session_id: "live-default", text: "さらに依頼です" } }));
  await waitForId(websocket, 7);

  assert.equal(contextReads, 2);
  assert.deepEqual(captured[0]?.internal, {
    sessionCreateSystemSeed: composeSessionCreateSystemSeed(
      "Office-only shared context",
      studioFollowUpSessionInstruction(),
    ),
  });
  assert.deepEqual(captured[1]?.internal, { studioFollowUpTurn: true });
  assert.deepEqual(captured[2]?.internal, {
    sessionCreateSystemSeed: composeSessionCreateSystemSeed(
      "Office-only shared context",
      studioDefaultProfileOrchestrationInstruction(),
      studioFollowUpSessionInstruction(),
    ),
  });
  assert.equal(captured[3]?.internal?.studioFollowUpTurn, true);
  assert.equal(captured[3]?.internal?.studioDefaultDelegationTurn, true);
  const catalog = captured[3]?.internal?.studioDefaultDelegationModelCatalog ?? "";
  assert.match(catalog, /"catalogStatus":"complete"/);
  assert.match(catalog, /"usableFor":\["main","subagent"\]/);
  assert.match(catalog, /"profile":"profile-builder"/);
  assert.match(catalog, /"model":"gpt-main","reasoningEfforts":\["low","high"\]/);
  assert.match(catalog, /"model":"local-main","reasoningEfforts":null/);
  assert.equal(catalog.includes("ignored label"), false);
  assert.equal(catalogReads.some(({ profile, provider }) => profile === "profile-builder" && provider === "local"), true);
  assert.equal(captured[4]?.internal, undefined);
  assert.match(captured[5]?.internal?.studioDefaultDelegationModelCatalog ?? "", /"catalogStatus":"unavailable"/);
  assert.match(captured[5]?.internal?.studioDefaultDelegationModelCatalog ?? "", /"status":"unavailable"/);
  assert.match(captured[6]?.internal?.studioDefaultDelegationModelCatalog ?? "", /"catalogStatus":"unavailable"/);
  assert.equal((captured[6]?.internal?.studioDefaultDelegationModelCatalog ?? "").includes("synthetic"), false);
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
