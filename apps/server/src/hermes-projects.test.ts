import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { WebSocketServer } from "ws";
import { createHermesProjectsAdapter } from "./hermes-projects.js";
import { HermesSettingsError } from "./hermes-settings.js";

type RpcHandler = (frame: { id: unknown; method: string; params: Record<string, unknown> }) => unknown;

/** Minimal stand-in for the per-profile `hermes serve` `/api/ws` sidecar. */
async function withFakeGateway(
  t: TestContext,
  handler: RpcHandler,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  t.after(() => wss.close());
  wss.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    assert.equal(url.pathname, "/api/ws");
    assert.equal(url.searchParams.get("token"), "sidecar-token");
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "gateway.ready", payload: {} },
    }));
    socket.on("message", (data) => {
      for (const line of String(data).split("\n")) {
        if (line.trim() === "") continue;
        const frame = JSON.parse(line) as { id: unknown; method: string; params: Record<string, unknown> };
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: handler(frame) }));
      }
    });
  });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  if (address === null || typeof address === "string") throw new Error("fake gateway has no port");
  await run(`http://127.0.0.1:${address.port}`);
}

function backendResolver(origin: string) {
  return async () => ({
    baseUrl: origin,
    sessionToken: "sidecar-token",
    release: () => undefined,
  });
}

test("projects adapter lists projects over the sidecar websocket", async (t) => {
  await withFakeGateway(t, (frame) => {
    assert.equal(frame.method, "projects.list");
    return {
      projects: [{
        id: "p1",
        slug: "web",
        name: "Web",
        description: null,
        icon: null,
        color: null,
        board_slug: null,
        primary_path: "/repo",
        archived: false,
        created_at: 1720000000,
        folders: [{ path: "/repo", label: null, is_primary: true, added_at: 1720000000 }],
      }],
      active_id: "p1",
    };
  }, async (origin) => {
    const adapter = createHermesProjectsAdapter({ resolveProfileBackend: backendResolver(origin) });
    const snapshot = await adapter.listProjects("coder");
    assert.equal(snapshot.activeId, "p1");
    assert.equal(snapshot.projects.length, 1);
    const project = snapshot.projects[0]!;
    assert.equal(project.primaryPath, "/repo");
    assert.equal(project.folders[0]?.isPrimary, true);
  });
});

test("projects adapter sends official snake_case params for folder binding", async (t) => {
  await withFakeGateway(t, (frame) => {
    assert.equal(frame.method, "projects.add_folder");
    assert.deepEqual(frame.params, { id: "p1", path: "/repo2", is_primary: false });
    return { project: null };
  }, async (origin) => {
    const adapter = createHermesProjectsAdapter({ resolveProfileBackend: backendResolver(origin) });
    await assert.rejects(() => adapter.addFolder("coder", "p1", { path: "/repo2" }), HermesSettingsError);
  });
});

test("projects adapter maps gateway error codes to settings errors", async (t) => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  t.after(() => wss.close());
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as { id: unknown };
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: 5062, message: "no such project" } }));
    });
  });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  if (address === null || typeof address === "string") throw new Error("fake gateway has no port");
  const adapter = createHermesProjectsAdapter({
    resolveProfileBackend: backendResolver(`http://127.0.0.1:${address.port}`),
  });
  await assert.rejects(
    () => adapter.deleteProject("coder", "missing"),
    (error: unknown) => error instanceof HermesSettingsError
      && error.code === "not_found"
      && error.message === "Hermes project was not found."
      && !error.message.includes("no such project"),
  );
});

test("projects adapter never exposes resolver diagnostics", async () => {
  const adapter = createHermesProjectsAdapter({
    resolveProfileBackend: async () => { throw new Error("private executable /Users/example/.hermes/token"); },
  });
  await assert.rejects(
    () => adapter.listProjects("coder"),
    (error: unknown) => error instanceof HermesSettingsError
      && error.code === "rejected"
      && error.message === "Hermes projects are unavailable."
      && !error.message.includes("/Users/example"),
  );
});
