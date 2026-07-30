import assert from "node:assert/strict";
import test from "node:test";
import type { OfficeSnapshot } from "../src/domain.ts";
import type { KanbanApi } from "../src/kanban-api.ts";
import {
  addTaskComment,
  applyOfficeSnapshot,
  assignTask,
  createTask,
  createSession,
  closeEmbeddedChatSession,
  kanbanAssignees,
  kanbanState,
  moveTask,
  officeConnection,
  openSession,
  openEmbeddedChatSession,
  openSessionIds,
  profileList,
  registerChatRuntime,
  registerKanbanRuntime,
  refreshKanbanBoard,
  sessions,
  setChatSessionReady,
  setOfficeError,
  taskCommentDetail,
  toggleTaskComments,
  tasks
} from "../src/store.ts";
import { chatComposerState, setChatComposerDraft } from "../src/chat-composer-state.ts";
import { chatSessionTitle, locale, localizeRuntimeMessage, setLocale } from "../src/i18n.ts";

const serverUrl = "http://127.0.0.1:4317";

function snapshot(options: {
  demo?: boolean;
  state?: OfficeSnapshot["capabilities"]["runtime"]["state"];
  profiles?: OfficeSnapshot["profiles"];
  sessions?: OfficeSnapshot["sessions"];
  profileInventory?: OfficeSnapshot["inventory"]["profiles"];
  sessionInventory?: OfficeSnapshot["inventory"]["sessions"];
} = {}): OfficeSnapshot {
  const snapshotProfiles = options.profiles ?? [{ id: "live-profile", name: "Live Profile", activity: "idle", activeSessionCount: 0 }];
  const snapshotSessions = options.sessions ?? [];
  return {
    generatedAt: new Date(0).toISOString(),
    sequence: 1,
    capabilities: {
      protocolVersion: 1,
      serverVersion: "test",
      runtime: { state: options.state ?? "ready", adapterVersion: options.demo ? "test-demo" : "test" },
      access: {
        deviceId: "local-test",
        tier: "owner",
        exposure: "loopback",
        authentication: "local-cookie",
        allowedOperations: ["state.read"]
      },
      features: ["chat", "profiles", ...(options.demo ? ["demo" as const] : [])]
    },
    profiles: snapshotProfiles,
    sessions: snapshotSessions,
    inventory: {
      profiles: options.profileInventory ?? completePage(snapshotProfiles.length),
      sessions: options.sessionInventory ?? completePage(snapshotSessions.length)
    },
    boards: []
  };
}

function completePage(count = 0) { return { returned: count, available: count, total: count, hasMore: false, truncated: false, partialFailures: 0 }; }
function unavailablePage() { return { returned: 0, available: 0, hasMore: false, truncated: true, partialFailures: 1 }; }

function resetRuntime(): void {
  applyOfficeSnapshot(snapshot({ state: "starting", profiles: [] }), serverUrl);
}

function recordChatRuntime(): { ensured: string[]; released: string[] } {
  const calls = { ensured: [] as string[], released: [] as string[] };
  registerChatRuntime({
    ensureSession: (target) => { calls.ensured.push(target.clientSessionId); },
    releaseSession: (sessionId) => { calls.released.push(sessionId); },
    submitPrompt: () => {},
    steer: async () => ({ status: "queued" }),
    interrupt: () => {},
    respondClarify: async () => {},
    respondApproval: async () => {}
  });
  return calls;
}

test("demo fixtures load only when the server explicitly advertises demo mode", async () => {
  assert.deepEqual(profileList.value, []);
  assert.deepEqual(sessions.value, []);

  applyOfficeSnapshot(snapshot({ demo: true, state: "unconfigured" }), serverUrl);
  assert.equal(officeConnection.value.source, "demo");
  assert.equal(officeConnection.value.state, "demo");
  assert.ok(profileList.value.length > 0);
  assert.ok(sessions.value.every((session) => session.remoteKind === "demo"));
  await waitUntil(() => kanbanState.value.state === "ready");
  assert.deepEqual(tasks.value.map((task) => task.id), ["t-104", "t-105", "t-106", "t-107", "t-108", "t-102"]);
  assert.deepEqual(kanbanAssignees.value, ["researcher", "builder", "operator", "editor"]);
});

test("demo Kanban supports its primary interactions without Hermes", async () => {
  applyOfficeSnapshot(snapshot({ demo: true, state: "unconfigured" }), serverUrl);
  await waitUntil(() => kanbanState.value.state === "ready");

  await toggleTaskComments("t-104");
  assert.equal(taskCommentDetail.value.state, "ready");
  assert.equal(taskCommentDetail.value.comments.length, 3);
  assert.equal(await addTaskComment("t-104", "デモから追加したコメント"), "success");
  await waitUntil(() => taskCommentDetail.value.state === "ready" && taskCommentDetail.value.comments.length === 4);
  assert.equal(tasks.value.find((task) => task.id === "t-104")?.comments, 4);

  await moveTask("t-105", "blocked");
  await assignTask("t-107", "editor");
  assert.equal(tasks.value.find((task) => task.id === "t-105")?.status, "blocked");
  assert.equal(tasks.value.find((task) => task.id === "t-107")?.assigneeId, "editor");

  assert.equal(await createTask("デモで作成したカード"), "success");
  assert.ok(tasks.value.some((task) => task.title === "デモで作成したカード" && task.status === "triage"));
  await toggleTaskComments("t-104");
});

test("live Kanban registration cannot replace an active demo and is restored afterward", async () => {
  applyOfficeSnapshot(snapshot({ demo: true, state: "unconfigured" }), serverUrl);
  await waitUntil(() => kanbanState.value.state === "ready");
  const liveCard = { id: "live-card", title: "Live only", status: "todo" as const, priority: "normal" as const, comments: 0 };
  const liveApi: KanbanApi = {
    fetchBoard: async () => ({ tasks: [liveCard], assignees: ["live-profile"], latestEventId: 9 }),
    fetchCard: async () => ({ card: liveCard, comments: [], availableCommentCount: 0, truncated: false }),
    createCard: async () => liveCard,
    updateCard: async () => liveCard,
    addComment: async () => {}
  };

  registerKanbanRuntime(liveApi);
  await refreshKanbanBoard();
  assert.ok(tasks.value.some((task) => task.id === "t-104"));
  assert.ok(!tasks.value.some((task) => task.id === liveCard.id));

  applyOfficeSnapshot(snapshot(), serverUrl);
  await refreshKanbanBoard();
  assert.deepEqual(tasks.value.map((task) => task.id), [liveCard.id]);
});

test("real runtime errors, non-ready state, and empty inventory clear stale demo data", () => {
  applyOfficeSnapshot(snapshot({ demo: true, state: "unconfigured" }), serverUrl);
  applyOfficeSnapshot(snapshot({ state: "starting" }), serverUrl);
  assert.deepEqual(profileList.value, []);
  assert.deepEqual(sessions.value, []);
  assert.deepEqual(openSessionIds.value, []);

  applyOfficeSnapshot(snapshot(), serverUrl);
  assert.deepEqual(profileList.value.map((profile) => profile.id), ["live-profile"]);
  applyOfficeSnapshot(snapshot({ profiles: [] }), serverUrl);
  assert.deepEqual(profileList.value, []);

  applyOfficeSnapshot(snapshot(), serverUrl);
  setOfficeError("runtime unavailable", serverUrl);
  assert.equal(officeConnection.value.source, "server");
  assert.equal(officeConnection.value.state, "error");
  assert.deepEqual(profileList.value, []);
  assert.deepEqual(sessions.value, []);
  createSession("live-profile");
  assert.deepEqual(sessions.value, []);
});

test("an initially unavailable live Profile inventory stays empty and reports degraded state", () => {
  resetRuntime();
  const calls = recordChatRuntime();

  applyOfficeSnapshot(snapshot({ profiles: [], profileInventory: unavailablePage() }), serverUrl);

  assert.equal(officeConnection.value.source, "server");
  assert.equal(officeConnection.value.state, "degraded");
  assert.match(localizeRuntimeMessage(officeConnection.value.message), /Profile一覧/);
  assert.deepEqual(profileList.value, []);
  assert.deepEqual(sessions.value, []);
  assert.deepEqual(openSessionIds.value, []);
  assert.deepEqual(calls, { ensured: [], released: [] });
});

test("demo to unavailable live transition clears every fixture without creating fake chat targets", () => {
  resetRuntime();
  applyOfficeSnapshot(snapshot({ demo: true, state: "unconfigured" }), serverUrl);
  assert.ok(openSessionIds.value.length > 0);
  const calls = recordChatRuntime();

  applyOfficeSnapshot(snapshot({ profiles: [], profileInventory: unavailablePage() }), serverUrl);

  assert.equal(officeConnection.value.state, "degraded");
  assert.deepEqual(profileList.value, []);
  assert.deepEqual(sessions.value, []);
  assert.deepEqual(tasks.value, []);
  assert.deepEqual(openSessionIds.value, []);
  assert.deepEqual(calls.ensured, []);
  assert.deepEqual(calls.released, []);
});

test("temporary live inventory failure and recovery retain last-known-good state without chat churn", () => {
  resetRuntime();
  const calls = recordChatRuntime();
  const live = snapshot({
    sessions: [{ id: "stored-session", profileId: "live-profile", title: "Live session", activity: "idle" }]
  });
  applyOfficeSnapshot(live, serverUrl);
  const liveSessionId = sessions.value[0]!.id;
  openSession(liveSessionId);
  assert.deepEqual(calls.ensured, [liveSessionId]);

  applyOfficeSnapshot(snapshot({ profiles: [], profileInventory: unavailablePage() }), serverUrl);
  assert.equal(officeConnection.value.state, "degraded");
  assert.deepEqual(profileList.value.map((profile) => profile.id), ["live-profile"]);
  assert.deepEqual(sessions.value.map((session) => session.id), [liveSessionId]);
  assert.deepEqual(openSessionIds.value, [liveSessionId]);
  assert.deepEqual(calls, { ensured: [liveSessionId], released: [] });

  applyOfficeSnapshot(live, serverUrl);
  assert.equal(officeConnection.value.state, "connected");
  assert.deepEqual(openSessionIds.value, [liveSessionId]);
  assert.deepEqual(calls, { ensured: [liveSessionId], released: [] });
});

test("temporary non-ready runtime retains last-known-good live state and composer draft", () => {
  resetRuntime();
  const calls = recordChatRuntime();
  const live = snapshot({
    sessions: [{ id: "stored-session", profileId: "live-profile", title: "Live session", activity: "idle" }]
  });
  applyOfficeSnapshot(live, serverUrl);
  const liveSessionId = sessions.value[0]!.id;
  openSession(liveSessionId);
  setChatComposerDraft(liveSessionId, "unsent recovery draft");

  applyOfficeSnapshot(snapshot({
    state: "unreachable",
    profiles: [],
    sessions: [],
    profileInventory: unavailablePage(),
    sessionInventory: unavailablePage()
  }), serverUrl);

  assert.equal(officeConnection.value.state, "degraded");
  assert.equal(officeConnection.value.runtime, "unreachable");
  assert.deepEqual(profileList.value.map((profile) => profile.id), ["live-profile"]);
  assert.deepEqual(sessions.value.map((session) => session.id), [liveSessionId]);
  assert.deepEqual(openSessionIds.value, [liveSessionId]);
  assert.equal(chatComposerState(liveSessionId).value.draft, "unsent recovery draft");
  assert.deepEqual(calls, { ensured: [liveSessionId], released: [] });

  applyOfficeSnapshot(live, serverUrl);
  assert.equal(officeConnection.value.state, "connected");
  assert.deepEqual(openSessionIds.value, [liveSessionId]);
  assert.equal(chatComposerState(liveSessionId).value.draft, "unsent recovery draft");
  assert.deepEqual(calls, { ensured: [liveSessionId], released: [] });
});

test("a new embedded chat connects without entering the workspace list", () => {
  resetRuntime();
  const calls = recordChatRuntime();
  applyOfficeSnapshot(snapshot(), serverUrl);

  const sessionId = createSession("live-profile", { workspace: false });
  assert.ok(sessionId);
  assert.equal(openSessionIds.value.includes(sessionId!), false);
  assert.deepEqual(calls.ensured, []);

  assert.equal(openEmbeddedChatSession(sessionId!), true);
  assert.deepEqual(calls.ensured, [sessionId]);
  closeEmbeddedChatSession(sessionId!);
  assert.deepEqual(calls.released, [sessionId]);
});

test("authoritative stored inventory replaces a promoted draft title presentation in both locales", () => {
  resetRuntime();
  recordChatRuntime();
  applyOfficeSnapshot(snapshot(), serverUrl);
  createSession("live-profile");
  const draft = sessions.value.at(-1)!;
  assert.equal(draft.titlePresentation, "new-chat");
  setChatSessionReady(draft.id, "live-draft", "stored-draft");

  applyOfficeSnapshot(snapshot({
    sessions: [{ id: "stored-draft", profileId: "live-profile", title: "障害調査", activity: "idle" }]
  }), serverUrl);
  const promoted = sessions.value.find(({ id }) => id === draft.id)!;
  assert.equal(promoted.remoteKind, "stored");
  assert.equal(promoted.titlePresentation, undefined);

  const previous = locale.value;
  try {
    setLocale("ja");
    assert.equal(chatSessionTitle(promoted), "障害調査");
    setLocale("en");
    assert.equal(chatSessionTitle(promoted), "障害調査");
    applyOfficeSnapshot(snapshot({
      sessions: [{ id: "stored-draft", profileId: "live-profile", title: "New chat", activity: "idle" }]
    }), serverUrl);
    assert.equal(chatSessionTitle(sessions.value.find(({ id }) => id === draft.id)!), "New chat");
    applyOfficeSnapshot(snapshot({
      sessions: [{ id: "stored-draft", profileId: "live-profile", title: "新しい会話", activity: "idle" }]
    }), serverUrl);
    assert.equal(chatSessionTitle(sessions.value.find(({ id }) => id === draft.id)!), "新しい会話");
  } finally { setLocale(previous); }
});

test("Office reconnect exhaustion is stored as first-party presentation and switches locale", () => {
  const previous = locale.value;
  try {
    setOfficeError("Studio WebSocketへ再接続できませんでした。手動で再試行してください。", serverUrl, true);
    setLocale("ja");
    assert.equal(localizeRuntimeMessage(officeConnection.value.message), "Studio WebSocketへ再接続できませんでした。手動で再試行してください。");
    setLocale("en");
    assert.equal(localizeRuntimeMessage(officeConnection.value.message), "Unable to reconnect to the Studio WebSocket. Retry manually.");
  } finally { setLocale(previous); }
});

test("returning from live data to explicit demo releases live targets and replaces all state", () => {
  resetRuntime();
  const calls = recordChatRuntime();
  applyOfficeSnapshot(snapshot({
    sessions: [{ id: "stored-session", profileId: "live-profile", title: "Live session", activity: "idle" }]
  }), serverUrl);
  const liveSessionId = sessions.value[0]!.id;
  openSession(liveSessionId);

  applyOfficeSnapshot(snapshot({ demo: true, state: "unconfigured" }), serverUrl);

  assert.equal(officeConnection.value.state, "demo");
  assert.ok(profileList.value.length > 0);
  assert.ok(sessions.value.length > 0);
  assert.ok(sessions.value.every((session) => session.remoteKind === "demo"));
  assert.ok(openSessionIds.value.every((id) => id !== liveSessionId));
  assert.deepEqual(calls, { ensured: [liveSessionId], released: [liveSessionId] });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for runtime state.");
}
