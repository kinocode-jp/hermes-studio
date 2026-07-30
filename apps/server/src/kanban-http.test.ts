import assert from "node:assert/strict";
import test from "node:test";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import {
  HermesKanbanAdapter,
  HermesKanbanCommitUnconfirmedError,
  type HermesKanbanRequest,
} from "./hermes-kanban.js";
import { createDemoRuntimeStatus, createDemoSnapshot } from "./demo-state.js";
import { createOfficeServer } from "./server.js";

const ORIGIN = "http://localhost:4173";
const RAW_CARD = {
  id: "t_deadbeef",
  title: "Office Kanban",
  body: "Connect the safe route",
  assignee: "mina",
  status: "todo",
  priority: 2,
  created_at: 100,
  started_at: null,
  completed_at: null,
  latest_summary: null,
  comment_count: 0,
  workspace_path: "/Users/private/repository",
  api_key: "never-return-this", // gitleaks:allow -- synthetic rejection fixture
};

function makeFixture(cardCount = 1) {
  const requests: HermesKanbanRequest[] = [];
  const adapter = new HermesKanbanAdapter({
    listAllowedProfiles: () => ["mina", "atlas"],
    request: async (request) => {
      requests.push(request);
      if (request.method === "GET" && request.path.includes("/tasks/")) {
        return {
          task: RAW_CARD,
          comments: [{ id: 1, task_id: RAW_CARD.id, author: "mina", body: "Looks good", created_at: 101 }],
          environment: { HOME: "/private" },
        };
      }
      if (request.method === "GET") {
        return {
          columns: [{ name: "todo", tasks: Array.from({ length: cardCount }, (_, index) => ({
            ...RAW_CARD,
            id: `t_${index.toString(16).padStart(8, "0")}`,
            title: `${RAW_CARD.title} ${index} ${"x".repeat(160)}`,
          })) }],
          assignees: ["mina"],
          latest_event_id: 3,
          now: 200,
          access_token: "never-return-this", // gitleaks:allow -- synthetic rejection fixture
        };
      }
      if (request.path.endsWith("/comments")) return { ok: true };
      const patch = request.body ?? {};
      return {
        task: {
          ...RAW_CARD,
          ...patch,
          assignee: patch.assignee === "" ? null : (patch.assignee ?? RAW_CARD.assignee),
        },
      };
    },
  });
  const runtime: HermesRuntimeSource = {
    status: () => createDemoRuntimeStatus(),
    snapshot: async () => createDemoSnapshot(),
    close: async () => {},
    chat: () => { throw new Error("chat not used"); },
    kanban: () => adapter,
  };
  return { requests, runtime };
}

test("Kanban responses use a bounded response budget independent from request bodies", async () => {
  const fixture = makeFixture(1_000);
  const server = createOfficeServer({ port: 0, runtimeSource: fixture.runtime, maxJsonBytes: 4 * 1024, allowedOrigins: [ORIGIN] });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await bootstrap(base);
    const response = await fetch(`${base}/api/v1/kanban`, { headers: headers(session) });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.ok(Buffer.byteLength(text) > 64 * 1024);
    assert.equal((JSON.parse(text) as { columns: Array<{ cards: unknown[] }> }).columns[0]?.cards.length, 1_000);
  } finally {
    await server.close();
  }
});

async function bootstrap(base: string): Promise<{ cookie: string; csrf: string }> {
  const response = await fetch(`${base}/api/v1/auth/local`, {
    method: "POST",
    headers: { Origin: ORIGIN },
  });
  assert.equal(response.status, 200);
  const session = await response.json() as { csrfToken: string };
  return { cookie: response.headers.get("set-cookie") ?? "", csrf: session.csrfToken };
}

function headers(session: { cookie: string; csrf?: string }): Record<string, string> {
  return {
    Origin: ORIGIN,
    Cookie: session.cookie,
    ...(session.csrf === undefined ? {} : { "X-CSRF-Token": session.csrf }),
  };
}

test("Kanban board and card reads require a session and return secret-safe DTOs", async () => {
  const fixture = makeFixture();
  const server = createOfficeServer({ port: 0, runtimeSource: fixture.runtime, allowedOrigins: [ORIGIN] });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const rejected = await fetch(`${base}/api/v1/kanban`, { headers: { Origin: ORIGIN } });
    assert.equal(rejected.status, 401);

    const session = await bootstrap(base);
    const board = await fetch(`${base}/api/v1/kanban?board=default&includeArchived=true`, {
      headers: headers(session),
    });
    assert.equal(board.status, 200);
    const boardText = await board.text();
    assert.equal(boardText.includes("Office Kanban"), true);
    assert.equal(boardText.includes("/Users/private"), false);
    assert.equal(boardText.includes("never-return-this"), false);

    const detail = await fetch(`${base}/api/v1/kanban/cards/t_deadbeef`, {
      headers: headers(session),
    });
    assert.equal(detail.status, 200);
    assert.deepEqual((await detail.json() as { comments: unknown[] }).comments.length, 1);
  } finally {
    await server.close();
  }
});

test("Kanban mutations require CSRF and expose create/update/status/assignee/comment routes", async () => {
  const fixture = makeFixture();
  const server = createOfficeServer({ port: 0, runtimeSource: fixture.runtime, allowedOrigins: [ORIGIN] });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await bootstrap(base);
    const withoutCsrf = await fetch(`${base}/api/v1/kanban/cards`, {
      method: "POST",
      headers: { ...headers({ cookie: session.cookie }), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Rejected" }),
    });
    assert.equal(withoutCsrf.status, 403);
    assert.equal(fixture.requests.length, 0);

    const mutationHeaders = { ...headers({ ...session, csrf: session.csrf }), "Content-Type": "application/json" };
    const created = await fetch(`${base}/api/v1/kanban/cards?board=default`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ title: "Created", assignee: "mina", priority: 3 }),
    });
    assert.equal(created.status, 201);

    const updated = await fetch(`${base}/api/v1/kanban/cards/t_deadbeef`, {
      method: "PATCH",
      headers: mutationHeaders,
      body: JSON.stringify({ status: "blocked", assignee: "atlas" }),
    });
    assert.equal(updated.status, 200);

    const status = await fetch(`${base}/api/v1/kanban/cards/t_deadbeef/status`, {
      method: "PATCH",
      headers: mutationHeaders,
      body: JSON.stringify({ status: "ready" }),
    });
    assert.equal(status.status, 200);

    const assignee = await fetch(`${base}/api/v1/kanban/cards/t_deadbeef/assignee`, {
      method: "PATCH",
      headers: mutationHeaders,
      body: JSON.stringify({ assignee: null }),
    });
    assert.equal(assignee.status, 200);

    const comment = await fetch(`${base}/api/v1/kanban/cards/t_deadbeef/comments`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ body: "Please continue" }),
    });
    assert.equal(comment.status, 201);
    assert.equal(fixture.requests.length, 5);
    assert.deepEqual(fixture.requests[4]?.body, { body: "Please continue", author: "hermes-studio" });
  } finally {
    await server.close();
  }
});

test("Kanban HTTP boundary rejects unknown fields, unsafe transitions, and oversized JSON", async () => {
  const fixture = makeFixture();
  const server = createOfficeServer({ port: 0, runtimeSource: fixture.runtime, maxJsonBytes: 32 * 1024, allowedOrigins: [ORIGIN] });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await bootstrap(base);
    const mutationHeaders = {
      ...headers({ ...session, csrf: session.csrf }),
      "Content-Type": "application/json",
    };
    const unknown = await fetch(`${base}/api/v1/kanban/cards`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ title: "No", workspacePath: "/private" }),
    });
    assert.equal(unknown.status, 400);

    const running = await fetch(`${base}/api/v1/kanban/cards/t_deadbeef/status`, {
      method: "PATCH",
      headers: mutationHeaders,
      body: JSON.stringify({ status: "running" }),
    });
    assert.equal(running.status, 400);

    const unknownProfile = await fetch(`${base}/api/v1/kanban/cards/t_deadbeef/assignee`, {
      method: "PATCH",
      headers: mutationHeaders,
      body: JSON.stringify({ assignee: "intruder" }),
    });
    assert.equal(unknownProfile.status, 400);

    const oversized = await fetch(`${base}/api/v1/kanban/cards`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ title: "x", body: "x".repeat(40_000) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("Kanban POST ambiguity returns a non-retryable commit-unconfirmed contract", async () => {
  const fixture = makeFixture();
  const adapter = new HermesKanbanAdapter({
    listAllowedProfiles: () => ["mina"],
    request: async () => { throw new HermesKanbanCommitUnconfirmedError(); },
  });
  const runtime = { ...fixture.runtime, kanban: () => adapter };
  const server = createOfficeServer({ port: 0, runtimeSource: runtime, allowedOrigins: [ORIGIN] });
  const address = await server.listen();
  try {
    const session = await bootstrap(`http://127.0.0.1:${address.port}`);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/kanban/cards`, {
      method: "POST",
      headers: { ...headers({ ...session, csrf: session.csrf }), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Maybe created" }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      code: "commit_unconfirmed",
      message: "Hermes may have committed this Kanban change; refresh before retrying.",
      retryable: false,
    });
  } finally {
    await server.close();
  }
});
