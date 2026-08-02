import assert from "node:assert/strict";
import test from "node:test";
import type { OfficeSnapshot } from "../src/domain.ts";
import type { KanbanApi } from "../src/kanban-api.ts";
import {
  addTaskComment,
  activeSessionId,
  applyOfficeSnapshot,
  assignTask,
  createTask,
  createSession,
  deleteSessions,
  closeEmbeddedChatSession,
  embeddedChatSessionIds,
  kanbanAssignees,
  kanbanState,
  moveTask,
  officeConnection,
  openSession,
  openEmbeddedChatSession,
  openSessionIds,
  profileList,
  profileChatModalActivePaneId,
  profileChatModalId,
  profileChatModalPaneIds,
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
import { activeDashboard, resetDashboardStateForTests } from "../src/dashboard-layout.ts";
import { chatComposerState, clearAcknowledgedChatComposer, setChatComposerAttachments, setChatComposerDraft } from "../src/chat-composer-state.ts";
import { chatSessionTitle, locale, localizeRuntimeMessage, officeRuntimeMessage, setLocale } from "../src/i18n.ts";
import { storedSessionClientId } from "../src/session-identity.ts";
import { recordOfficeSnapshotRequestIdentity } from "../src/office-snapshot-request-tracker.ts";

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
  assert.equal(draft.connectionState, "ready", "an unused draft stays locally compose-ready");
  assert.equal(draft.readOnly, false);
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

test("snapshot before ready coalesces its provisional stored row into the original draft identity", () => {
  resetRuntime();
  recordChatRuntime();
  applyOfficeSnapshot(snapshot(), serverUrl);
  const draftId = createSession("live-profile")!;
  sessions.value = sessions.value.map((session) => session.id === draftId ? {
    ...session,
    messages: [
      { id: "shared-message", timelineSequence: 20, from: "agent", body: "interim local state", at: "00:01", status: "streaming" },
      { id: "local-message", timelineSequence: 30, from: "user", body: "keep me", at: "00:02" },
      { id: "timeline-new-message", timelineSequence: 40, from: "agent", body: "new timeline state", at: "00:03", status: "complete" },
    ],
    operationEvidence: [
      { id: "shared-operation", timelineSequence: 25, kind: "prompt", body: "pending local evidence", at: "00:01", state: "pending" },
      { id: "prompt-op", timelineSequence: 35, kind: "prompt", body: "keep evidence", at: "00:02", state: "accepted" },
      { id: "timeline-new-operation", timelineSequence: 45, kind: "prompt", body: "new timeline evidence", at: "00:03", state: "accepted" },
    ],
  } : session);
  setChatComposerDraft(draftId, "retained composer");
  setChatComposerAttachments(draftId, [{
    id: "retained-attachment", name: "retained.txt", mime: "text/plain", size: 8, kind: "file", textContent: "retained",
  }]);
  const submittedComposer = chatComposerState(draftId).value;

  const storedId = "stored-race";
  const provisionalId = storedSessionClientId("live-profile", storedId);
  applyOfficeSnapshot(snapshot({
    sessions: [{ id: storedId, profileId: "live-profile", title: "Authoritative title", activity: "idle" }],
  }), serverUrl);
  assert.deepEqual(sessions.value.map((session) => session.id), [provisionalId, draftId]);
  const partialNotice = officeRuntimeMessage("partial durable history");
  sessions.value = sessions.value.map((session) => session.id === provisionalId ? {
    ...session,
    messages: [
      { id: "durable-message", timelineSequence: 10, from: "agent", body: "durable history", at: "00:00", status: "complete" },
      { id: "shared-message", timelineSequence: 20, from: "agent", body: "old durable state", at: "00:01", status: "complete" },
      { id: "timeline-old-message", timelineSequence: 40, from: "agent", body: "old timeline state", at: "00:03", status: "complete" },
    ],
    operationEvidence: [
      { id: "durable-operation", timelineSequence: 15, kind: "prompt", body: "durable evidence", at: "00:00", state: "accepted" },
      { id: "shared-operation", timelineSequence: 25, kind: "prompt", body: "old durable evidence", at: "00:01", state: "accepted" },
      { id: "timeline-old-operation", timelineSequence: 45, kind: "prompt", body: "old timeline evidence", at: "00:03", state: "accepted" },
    ],
    historyState: "loaded",
    historyPartial: true,
    historyNotice: partialNotice,
  } : session);
  setChatComposerDraft(provisionalId, "provisional composer");
  setChatComposerAttachments(provisionalId, [{
    id: "provisional-attachment", name: "provisional.txt", mime: "text/plain", size: 11, kind: "file", textContent: "provisional",
  }]);

  profileChatModalId.value = "live-profile";
  profileChatModalPaneIds.value = [draftId, provisionalId];
  profileChatModalActivePaneId.value = provisionalId;
  embeddedChatSessionIds.value = [provisionalId];
  openSessionIds.value = [draftId, provisionalId];
  activeSessionId.value = provisionalId;
  resetDashboardStateForTests({
    version: 1,
    dashboards: [{
      id: "race-dashboard",
      name: "Race",
      panels: [
        { id: "draft-pane", kind: "chat", sessionId: draftId },
        { id: "provisional-pane", kind: "chat", sessionId: provisionalId },
      ],
      activeChatPanelId: "draft-pane",
      defaultChatSeeded: true,
    }],
    activeDashboardId: "race-dashboard",
  });

  setChatSessionReady(draftId, "live-race", storedId, { running: false });
  assert.deepEqual(sessions.value.map((session) => session.id), [draftId]);
  const retained = sessions.value[0]!;
  assert.equal(retained.storedSessionId, storedId);
  assert.equal(retained.liveSessionId, "live-race");
  assert.equal(retained.title, "Authoritative title");
  assert.deepEqual(retained.messages.map(({ id, body }) => [id, body]), [
    ["durable-message", "durable history"],
    ["shared-message", "old durable state"],
    ["local-message", "keep me"],
    ["timeline-old-message", "old timeline state"],
    ["timeline-new-message", "new timeline state"],
  ]);
  assert.deepEqual(retained.operationEvidence?.map(({ id, body }) => [id, body]), [
    ["durable-operation", "durable evidence"],
    ["shared-operation", "old durable evidence"],
    ["prompt-op", "keep evidence"],
    ["timeline-old-operation", "old timeline evidence"],
    ["timeline-new-operation", "new timeline evidence"],
  ]);
  assert.equal(retained.historyState, "loaded");
  assert.equal(retained.historyPartial, true);
  assert.equal(retained.historyNotice, partialNotice);
  assert.deepEqual(chatComposerState(draftId).value, {
    draft: "retained composer\n\nprovisional composer",
    attachments: [
      { id: "retained-attachment", name: "retained.txt", mime: "text/plain", size: 8, kind: "file", textContent: "retained" },
      { id: "provisional-attachment", name: "provisional.txt", mime: "text/plain", size: 11, kind: "file", textContent: "provisional" },
    ],
  });
  assert.deepEqual(chatComposerState(provisionalId).value, { draft: "", attachments: [] });
  assert.equal(clearAcknowledgedChatComposer(draftId, submittedComposer), true);
  assert.deepEqual(chatComposerState(draftId).value, {
    draft: "provisional composer",
    attachments: [
      { id: "provisional-attachment", name: "provisional.txt", mime: "text/plain", size: 11, kind: "file", textContent: "provisional" },
    ],
  });
  assert.deepEqual(openSessionIds.value, [draftId]);
  assert.equal(activeSessionId.value, draftId);
  assert.deepEqual(profileChatModalPaneIds.value, [draftId]);
  assert.equal(profileChatModalActivePaneId.value, draftId);
  assert.deepEqual(embeddedChatSessionIds.value, [draftId]);
  assert.deepEqual(activeDashboard.value.panels, [{ id: "draft-pane", kind: "chat", sessionId: draftId }]);

  applyOfficeSnapshot(snapshot({
    sessions: [{ id: storedId, profileId: "live-profile", title: "Refreshed title", activity: "idle" }],
  }), serverUrl);
  assert.deepEqual(sessions.value.map((session) => session.id), [draftId]);
  assert.equal(sessions.value[0]?.title, "Refreshed title");
  assert.equal(sessions.value[0]?.liveSessionId, "live-race");
  assert.deepEqual(sessions.value[0]?.messages.map(({ id }) => id), ["durable-message", "shared-message", "local-message", "timeline-old-message", "timeline-new-message"]);
  assert.deepEqual(sessions.value[0]?.operationEvidence?.map(({ id }) => id), ["durable-operation", "shared-operation", "prompt-op", "timeline-old-operation", "timeline-new-operation"]);
  assert.deepEqual(chatComposerState(draftId).value, {
    draft: "provisional composer",
    attachments: [
      { id: "provisional-attachment", name: "provisional.txt", mime: "text/plain", size: 11, kind: "file", textContent: "provisional" },
    ],
  });
  assert.deepEqual(activeDashboard.value.panels, [{ id: "draft-pane", kind: "chat", sessionId: draftId }]);
  resetDashboardStateForTests();
});

test("promotion survives an already-issued snapshot but a newer authoritative omission prunes it", () => {
  resetRuntime();
  const calls = recordChatRuntime();
  const initialRequest = { serverUrl, connectionGeneration: 9001, requestGeneration: 1 };
  applyOfficeSnapshot(snapshot(), initialRequest);

  // This request starts before session.create persists. Promotion records it
  // as the last request whose omission is known to be stale.
  const alreadyIssuedRequest = { ...initialRequest, requestGeneration: 2 };
  recordOfficeSnapshotRequestIdentity(alreadyIssuedRequest);
  const draftId = createSession("live-profile")!;
  setChatSessionReady(draftId, "live-before-snapshot", "stored-before-snapshot", { running: false });

  applyOfficeSnapshot(snapshot({ sessions: [] }), alreadyIssuedRequest);
  assert.deepEqual(sessions.value.map((session) => session.id), [draftId]);
  assert.deepEqual(openSessionIds.value, [draftId]);
  assert.equal(sessions.value[0]?.liveSessionId, "live-before-snapshot");
  assert.deepEqual(calls.released, []);

  // An incomplete response cannot prove deletion and must not consume the
  // promotion barrier for the next complete inventory response.
  applyOfficeSnapshot(snapshot({ sessions: [], sessionInventory: unavailablePage() }), {
    ...initialRequest,
    requestGeneration: 3,
  });
  assert.deepEqual(sessions.value.map((session) => session.id), [draftId]);

  // A request issued after promotion is authoritative for absence, even when
  // the newly-created row was never observed in an intervening snapshot.
  applyOfficeSnapshot(snapshot({ sessions: [] }), { ...initialRequest, requestGeneration: 4 });
  assert.deepEqual(sessions.value, []);
  assert.deepEqual(openSessionIds.value, []);
  assert.deepEqual(calls.released, [draftId]);

  resetRuntime();
  applyOfficeSnapshot(snapshot({
    sessions: [{ id: "stored-resume", profileId: "live-profile", title: "Resume", activity: "idle" }],
  }), serverUrl);
  const resumedId = storedSessionClientId("live-profile", "stored-resume");
  setChatSessionReady(resumedId, "live-resume", "stored-resume", { running: false });
  assert.deepEqual(sessions.value.map((session) => session.id), [resumedId]);
  assert.equal(sessions.value[0]?.liveSessionId, "live-resume");
});

test("ready coalescing never crosses profile scope for equal stored IDs", () => {
  resetRuntime();
  recordChatRuntime();
  const profiles = [
    { id: "profile-a", name: "Profile A", activity: "idle", activeSessionCount: 0 },
    { id: "profile-b", name: "Profile B", activity: "idle", activeSessionCount: 0 },
  ];
  applyOfficeSnapshot(snapshot({ profiles }), serverUrl);
  const draftId = createSession("profile-a")!;
  applyOfficeSnapshot(snapshot({
    profiles,
    sessions: [
      { id: "shared-stored", profileId: "profile-a", title: "A", activity: "idle" },
      { id: "shared-stored", profileId: "profile-b", title: "B", activity: "idle" },
    ],
  }), serverUrl);

  setChatSessionReady(draftId, "live-a", "shared-stored", { running: false });
  assert.deepEqual(sessions.value.map((session) => [session.id, session.profileId]), [
    [draftId, "profile-a"],
    [storedSessionClientId("profile-b", "shared-stored"), "profile-b"],
  ]);
});

test("durable deletion follows ready coalescing aliases without crossing an equal ID in another profile", async () => {
  resetRuntime();
  const calls = recordChatRuntime();
  const profiles = [
    { id: "profile-delete-a", name: "Profile A", activity: "idle", activeSessionCount: 0 },
    { id: "profile-delete-b", name: "Profile B", activity: "idle", activeSessionCount: 0 },
  ];
  applyOfficeSnapshot(snapshot({
    profiles,
    sessions: [
      { id: "shared-delete", profileId: "profile-delete-a", title: "Delete A", activity: "idle" },
      { id: "shared-delete", profileId: "profile-delete-b", title: "Keep B", activity: "idle" },
    ],
  }), serverUrl);
  const canonicalA = storedSessionClientId("profile-delete-a", "shared-delete");
  const canonicalB = storedSessionClientId("profile-delete-b", "shared-delete");
  const draftA = createSession("profile-delete-a")!;
  const deleteResponse = deferred<void>();
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { protocol: "http:", hostname: "127.0.0.1", origin: serverUrl },
  });
  let bulkRequestBody = "";
  let bulkStarted = false;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/auth/local")) {
      return new Response(JSON.stringify({ csrfToken: "runtime-delete-test-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/api/v1/sessions/bulk-delete")) {
      bulkStarted = true;
      bulkRequestBody = String(init?.body ?? "");
      await deleteResponse.promise;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    assert.ok(sessions.value.some(({ id }) => id === canonicalA));
    const deletion = deleteSessions([canonicalA]);
    await waitUntil(() => bulkStarted);
    const promotion = Promise.resolve(setChatSessionReady(
      draftA,
      "live-delete-a",
      "shared-delete",
      { running: false },
    ));
    let promotionSettled = false;
    void promotion.then(() => { promotionSettled = true; });
    await Promise.resolve();

    assert.equal(promotionSettled, false, "ready waits for the durable delete transaction");
    assert.deepEqual(sessions.value.map(({ id }) => id).sort(), [canonicalB, draftA].sort());
    assert.deepEqual(JSON.parse(bulkRequestBody), {
      profile: "profile-delete-a",
      sessionIds: ["shared-delete"],
    });

    deleteResponse.resolve();
    assert.deepEqual(await deletion, { deleted: [canonicalA], failed: [] });
    await promotion;
    assert.deepEqual(sessions.value.map(({ id }) => id), [canonicalB]);
    assert.deepEqual(calls.released, [canonicalA, canonicalA, draftA]);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "location", { configurable: true, value: originalLocation });
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("unconfirmed create deletion coalesces a provisional stored alias into the stable draft", async () => {
  resetRuntime();
  registerChatRuntime({
    ensureSession() {}, releaseSession() {}, submitPrompt() {}, interrupt() {},
    async deleteSession() {
      return { status: "unconfirmed", storedSessionId: "stored-unconfirmed", message: "delete unknown" };
    },
    async steer() { return { status: "queued" }; },
    async respondClarify() {}, async respondApproval() {},
  });
  applyOfficeSnapshot(snapshot(), serverUrl);
  const draftId = createSession("live-profile")!;
  sessions.value = sessions.value.map((session) => session.id === draftId ? {
    ...session,
    messages: [{ id: "draft-message", from: "user", body: "keep draft", at: "00:01" }],
  } : session);
  setChatComposerDraft(draftId, "stable composer");
  const provisionalId = storedSessionClientId("live-profile", "stored-unconfirmed");
  applyOfficeSnapshot(snapshot({
    sessions: [{ id: "stored-unconfirmed", profileId: "live-profile", title: "Durable", activity: "idle" }],
  }), serverUrl);
  sessions.value = sessions.value.map((session) => session.id === provisionalId ? {
    ...session,
    messages: [{ id: "durable-message", from: "agent", body: "durable history", at: "00:00", status: "complete" }],
  } : session);
  setChatComposerDraft(provisionalId, "provisional composer");

  assert.deepEqual(await deleteSessions([draftId]), { deleted: [], failed: [draftId] });
  assert.deepEqual(sessions.value.map(({ id }) => id), [draftId]);
  assert.equal(sessions.value[0]?.storedSessionId, "stored-unconfirmed");
  assert.equal(sessions.value[0]?.connectionState, "disconnected");
  assert.equal(sessions.value[0]?.historyState, "error");
  assert.deepEqual(sessions.value[0]?.messages.map(({ id }) => id), ["durable-message", "draft-message"]);
  assert.deepEqual(chatComposerState(draftId).value.draft, "stable composer\n\nprovisional composer");
  assert.deepEqual(chatComposerState(provisionalId).value, { draft: "", attachments: [] });
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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
