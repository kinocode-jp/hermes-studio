import assert from "node:assert/strict";
import test from "node:test";
import {
  HermesKanbanAdapter,
  HermesKanbanCommitUnconfirmedError,
  KanbanValidationError,
  createHermesKanbanHttpRequester,
  type HermesKanbanRequest,
} from "./hermes-kanban.js";

const CARD = {
  id: "t_deadbeef",
  title: "Ship the office",
  body: "Finish the safe adapter",
  assignee: "mina",
  status: "todo",
  priority: 4,
  created_at: 100,
  started_at: null,
  completed_at: null,
  latest_summary: null,
  comment_count: 2,
  workspace_path: "/Users/private/project",
  api_key: "must-not-leak", // gitleaks:allow -- synthetic rejection fixture
};

function mockAdapter(handler: (request: HermesKanbanRequest) => unknown | Promise<unknown>) {
  return new HermesKanbanAdapter({
    request: async (request) => await handler(request),
    listAllowedProfiles: () => ["mina", "atlas"],
  });
}

test("board reads are allowlisted and strip paths, secrets, and unknown fields", async () => {
  const adapter = mockAdapter(() => ({
    columns: [{ name: "todo", tasks: [CARD] }],
    assignees: ["mina"],
    latest_event_id: 9,
    now: 200,
    access_token: "must-not-leak", // gitleaks:allow -- synthetic rejection fixture
  }));
  const board = await adapter.getBoard({ board: "Project_One", includeArchived: true });

  assert.equal(board.board, "project_one");
  assert.equal(board.columns[0]?.cards[0]?.title, "Ship the office");
  const serialized = JSON.stringify(board);
  assert.equal(serialized.includes("/Users/private"), false);
  assert.equal(serialized.includes("must-not-leak"), false);
  assert.equal(serialized.includes("workspace_path"), false);
});

test("board and detail redact secret assignments from every free-form Hermes field", async () => {
  const secret = "dashboard-example-value-123456";
  const standalone = "xoxb-" + "123456789012-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const authorization = "opaque-kanban-credential";
  const cookie = "office-cookie-example-value-123456";
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "signature0123456789"].join(".");
  const card = {
    ...CARD,
    title: `note: HERMES_DASHBOARD_SESSION_TOKEN=${secret}`,
    body: `OPENAI_API_KEY=${secret}; ${standalone}; ${jwt}\nAuthorization: Digest ${authorization}\nSet-Cookie: hermes_office_session=${cookie}; HttpOnly`,
    latest_summary: `clientSecret=${secret}`,
  };
  const adapter = mockAdapter((request) => request.path.includes("/tasks/")
    ? {
        task: card,
        comments: [{
          id: 1,
          task_id: CARD.id,
          author: `service_token=${secret}`,
          body: `credential: AWS_SECRET_ACCESS_KEY=${secret}`,
          created_at: 101,
        }],
      }
    : { columns: [{ name: "todo", tasks: [card] }], assignees: ["mina"], latest_event_id: 1, now: 2 });

  const serialized = JSON.stringify({ board: await adapter.getBoard(), detail: await adapter.getCard(CARD.id) });
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(standalone), false);
  assert.equal(serialized.includes(authorization), false);
  assert.equal(serialized.includes(cookie), false);
  assert.equal(serialized.includes(jwt), false);
  assert.equal(serialized.includes("[REDACTED]"), true);
});

test("create, assignment, status, and comments send only bounded allowlisted JSON", async () => {
  const requests: HermesKanbanRequest[] = [];
  const adapter = mockAdapter((request) => {
    requests.push(request);
    if (request.path.endsWith("/comments")) return { ok: true, debug_path: "/private" };
    const patch = request.body ?? {};
    return { task: { ...CARD, ...patch, assignee: patch.assignee === "" ? null : (patch.assignee ?? CARD.assignee) } };
  });

  await adapter.createCard({ title: " New card ", body: "Body", assignee: "mina", priority: 3 });
  await adapter.setAssignee("t_deadbeef", null);
  await adapter.setStatus("t_deadbeef", "blocked");
  await adapter.addComment("t_deadbeef", " Need input ");

  assert.deepEqual(requests[0]?.body, {
    title: "New card",
    workspace_kind: "scratch",
    body: "Body",
    assignee: "mina",
    priority: 3,
  });
  assert.deepEqual(requests[1]?.body, { assignee: "" });
  assert.deepEqual(requests[2]?.body, { status: "blocked" });
  assert.deepEqual(requests[3]?.body, { body: "Need input", author: "hermes-studio" });
});

test("profile identities preserve case across assignment, board reads, and updates", async () => {
  const requests: HermesKanbanRequest[] = [];
  const adapter = new HermesKanbanAdapter({
    listAllowedProfiles: () => ["TeamLead", "teamlead", "QA.Lead-2"],
    request: async (request) => {
      requests.push(request);
      if (request.method === "GET") return {
        columns: [{ name: "todo", tasks: [{ ...CARD, assignee: "TeamLead" }] }],
        assignees: ["TeamLead", "teamlead", "QA.Lead-2"], latest_event_id: 1, now: 2,
      };
      const assignee = request.body?.assignee;
      return { task: { ...CARD, assignee: typeof assignee === "string" ? assignee : CARD.assignee } };
    },
  });

  const created = await adapter.createCard({ title: "Mixed case", assignee: "QA.Lead-2" });
  const upper = await adapter.setAssignee("t_deadbeef", "TeamLead");
  const lower = await adapter.setAssignee("t_deadbeef", "teamlead");
  const board = await adapter.getBoard();

  assert.equal(requests[0]?.body?.assignee, "QA.Lead-2");
  assert.equal(created.assignee, "QA.Lead-2");
  assert.equal(requests[1]?.body?.assignee, "TeamLead");
  assert.equal(requests[2]?.body?.assignee, "teamlead");
  assert.equal(upper.assignee, "TeamLead");
  assert.equal(lower.assignee, "teamlead");
  assert.deepEqual(board.assignees, ["TeamLead", "teamlead", "QA.Lead-2"]);
  assert.equal(board.columns[0]?.cards[0]?.assignee, "TeamLead");
});

test("profile validation remains exact and rejects unsafe identifiers", async () => {
  let calls = 0;
  const adapter = new HermesKanbanAdapter({
    listAllowedProfiles: () => ["TeamLead"],
    request: async () => { calls += 1; return { task: CARD }; },
  });
  await assert.rejects(adapter.setAssignee("t_deadbeef", "teamlead"), /not available/);
  for (const unsafe of ["../TeamLead", "Team/Lead", "Team Lead", "Team@Lead", ".TeamLead"]) {
    await assert.rejects(adapter.setAssignee("t_deadbeef", unsafe), KanbanValidationError);
  }
  assert.equal(calls, 0);
});

test("unsafe identifiers, profiles, and dispatcher-owned statuses fail before transport", async () => {
  let calls = 0;
  const adapter = mockAdapter(() => { calls += 1; return { task: CARD }; });

  await assert.rejects(adapter.setAssignee("../../kanban.db", "mina"), KanbanValidationError);
  await assert.rejects(adapter.setAssignee("t_deadbeef", "unknown"), /not available/);
  await assert.rejects(
    adapter.updateCard("t_deadbeef", { status: "running" as never }),
    /cannot be set directly/,
  );
  await assert.rejects(
    adapter.updateCard("t_deadbeef", { status: "review" as never }),
    /cannot be set directly/,
  );
  await assert.rejects(adapter.addComment("t_deadbeef", "x".repeat(16_001)), /invalid length/);
  assert.equal(calls, 0);
});

test("card detail is identity-bound to the requested card", async () => {
  const otherCard = { ...CARD, id: "t_cafebabe" };
  const validComment = { id: 1, task_id: CARD.id, author: "mina", body: "note", created_at: 101 };

  await assert.rejects(
    mockAdapter(() => ({ task: otherCard, comments: [validComment] })).getCard(CARD.id),
    /mismatched card detail/,
  );
  await assert.rejects(
    mockAdapter(() => ({ task: CARD, comments: [{ ...validComment, task_id: otherCard.id }] })).getCard(CARD.id),
    /mismatched card detail/,
  );
});

test("HTTP requester is loopback-only, route-limited, and never returns upstream details", async () => {
  assert.throws(
    () => createHermesKanbanHttpRequester({ baseUrl: "https://example.com", sessionToken: "x".repeat(32) }),
    /loopback/,
  );
  const requester = createHermesKanbanHttpRequester({
    baseUrl: "http://127.0.0.1:9119",
    sessionToken: "x".repeat(32),
    fetch: async () => new Response(JSON.stringify({ detail: "/Users/private/.env SECRET=abc" }), { status: 500 }),
  });
  await assert.rejects(
    requester({ method: "GET", path: "/api/plugins/kanban/board" }),
    (error: unknown) => error instanceof Error
      && error.message === "Hermes Kanban request failed (500)."
      && !error.message.includes("private"),
  );
  await assert.rejects(
    requester({ method: "GET", path: "/api/profiles" }),
    /Only Hermes Kanban routes/,
  );
});

test("non-idempotent POST transport and response-shape failures are commit-unconfirmed", async () => {
  const requester = createHermesKanbanHttpRequester({
    baseUrl: "http://127.0.0.1:9119",
    sessionToken: "x".repeat(32),
    fetch: async () => { throw new Error("reply lost after dispatch"); },
  });
  await assert.rejects(
    requester({ method: "POST", path: "/api/plugins/kanban/tasks", body: { title: "Maybe created" } }),
    HermesKanbanCommitUnconfirmedError,
  );

  await assert.rejects(
    mockAdapter(() => ({ accepted: true })).createCard({ title: "Malformed success" }),
    HermesKanbanCommitUnconfirmedError,
  );
  await assert.rejects(
    mockAdapter(() => ({ ok: false })).addComment("t_deadbeef", "Maybe added"),
    HermesKanbanCommitUnconfirmedError,
  );
});
