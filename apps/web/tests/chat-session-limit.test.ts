import assert from "node:assert/strict";
import test from "node:test";
import type { ChatSession } from "../src/domain.ts";
import {
  MAX_OPEN_CHAT_SESSIONS,
  activeSessionId,
  addProfileChatModalPane,
  appendOpenSessionId,
  closeProfileChatModal,
  closeEmbeddedChatSession,
  closeSession,
  embeddedChatSessionIds,
  getOpenChatTargets,
  officeConnection,
  openSessionIds,
  openSession,
  openEmbeddedChatSession,
  profileList,
  profileChatModalId,
  profileChatModalActivePaneId,
  profileChatModalPaneIds,
  registerChatRuntime,
  replaceProfileChatModalPane,
  selectProfileChatModalSession,
  setProfileChatModalActivePane,
  setProfileChatModalPanes,
  sessions,
} from "../src/store.ts";
import {
  MAX_CHAT_PANELS,
  activeDashboard,
  activeDashboardId,
  dashboardContainingPanel,
  dashboardEffectiveSizes,
  dashboards,
  normalizeDashboardsState,
  readDashboardsState,
  replaceDashboardPanels,
  replacePanelInActiveDashboard,
  resetDashboardStateForTests,
} from "../src/dashboard-layout.ts";
import { addDashboardPanel, closeDashboardPanel, createDashboardWithDefaultChat, dashboardChatMirrorSuspended, dashboardSessionInventoryAuthoritative, initializeDefaultDashboardChat, selectDashboardChatSession } from "../src/dashboard-actions.ts";
import { horizontalDropEdge, paneDropTargetAt } from "../src/dashboard-drag.ts";

test("opening a fifth chat evicts the oldest pane and keeps four", () => {
  const current = ["one", "two", "three", "four"];
  const next = appendOpenSessionId(current, "five");

  assert.equal(MAX_OPEN_CHAT_SESSIONS, 4);
  assert.deepEqual(next, ["two", "three", "four", "five"]);
  assert.deepEqual(current, ["one", "two", "three", "four"]);
});

test("reopening an existing chat does not reorder or duplicate it", () => {
  assert.deepEqual(appendOpenSessionId(["one", "two"], "one"), ["one", "two"]);
});

test("dashboard chat capacity stays aligned with the live-session capacity", () => {
  assert.equal(MAX_CHAT_PANELS, MAX_OPEN_CHAT_SESSIONS);
});

test("fresh dashboard state waits for its runtime-backed default chat", () => {
  const state = readDashboardsState(() => null);
  assert.equal(state.dashboards.length, 1);
  assert.deepEqual(state.dashboards[0]?.panels, []);
  assert.equal(state.dashboards[0]?.defaultChatSeeded, false);
});

test("persisted empty dashboards are seeded once unless the user already removed the default chat", () => {
  const legacyEmpty = normalizeDashboardsState({
    version: 1,
    activeDashboardId: "legacy",
    dashboards: [{ id: "legacy", name: "", panels: [] }],
  });
  assert.equal(legacyEmpty?.dashboards[0]?.defaultChatSeeded, false);

  const intentionallyEmpty = normalizeDashboardsState({
    version: 1,
    activeDashboardId: "customized",
    dashboards: [{ id: "customized", name: "", panels: [], defaultChatSeeded: true }],
  });
  assert.equal(intentionallyEmpty?.dashboards[0]?.defaultChatSeeded, true);
});

test("new dashboards open a removable full-size default-profile chat pane", () => {
  const previousConnection = officeConnection.value;
  const previousProfiles = profileList.value;
  const previousSessions = sessions.value;
  const previousOpenIds = openSessionIds.value;
  const previousActiveId = activeSessionId.value;
  const previousDashboardState = {
    version: 1 as const,
    activeDashboardId: activeDashboardId.value,
    dashboards: dashboards.value,
  };
  try {
    officeConnection.value = { ...previousConnection, state: "demo", source: "demo" };
    profileList.value = [{
      id: "default", name: "Default", role: "", status: "idle", color: "#087f70",
      sessions: 0, taskCount: 0, memoryBytes: 0, memoryNote: "", skills: [], inheritedSkills: [],
    }];
    sessions.value = [];
    openSessionIds.value = [];
    activeSessionId.value = "";
    resetDashboardStateForTests({
      version: 1,
      activeDashboardId: "existing",
      dashboards: [{ id: "existing", name: "", panels: [{ id: "studio", kind: "studio" }] }],
    });

    const dashboardId = createDashboardWithDefaultChat();
    assert.equal(activeDashboardId.value, dashboardId);
    assert.equal(activeDashboard.value.panels.length, 1);
    assert.deepEqual(dashboardEffectiveSizes(activeDashboard.value), { count: 1, rowFr: [1], colFr: [[1]] });
    const panel = activeDashboard.value.panels[0];
    assert.equal(panel?.kind, "chat");
    assert.equal(sessions.value.find((session) => session.id === panel?.sessionId)?.profileId, "default");

    closeDashboardPanel(panel!.id);
    assert.deepEqual(activeDashboard.value.panels, []);
    assert.equal(activeDashboard.value.defaultChatSeeded, true);
    assert.equal(initializeDefaultDashboardChat(), false, "a user-removed default pane must stay removed");
    assert.deepEqual(activeDashboard.value.panels, []);
  } finally {
    officeConnection.value = previousConnection;
    profileList.value = previousProfiles;
    sessions.value = previousSessions;
    openSessionIds.value = previousOpenIds;
    activeSessionId.value = previousActiveId;
    resetDashboardStateForTests(previousDashboardState);
  }
});

test("dashboard edge-add rejects a fifth chat instead of evicting a registered pane", () => {
  const ids = ["one", "two", "three", "four", "five"];
  sessions.value = ids.map((id): ChatSession => ({
    id,
    profileId: "profile",
    title: id,
    status: "ready",
    messages: [],
    remoteKind: "stored",
    connectionState: "ready",
    historyState: "loaded",
  }));
  openSessionIds.value = ids.slice(0, MAX_CHAT_PANELS);
  resetDashboardStateForTests({
    version: 1,
    activeDashboardId: "dashboard",
    dashboards: [{
      id: "dashboard",
      name: "",
      panels: ids.slice(0, MAX_CHAT_PANELS).map((sessionId) => ({
        id: `panel-${sessionId}`,
        kind: "chat" as const,
        sessionId,
      })),
    }],
  });

  assert.equal(addDashboardPanel("chat", { sessionId: "five", index: 2 }), "full");
  assert.deepEqual(openSessionIds.value, ids.slice(0, MAX_CHAT_PANELS));
  assert.deepEqual(
    dashboards.value[0]?.panels.map((panel) => panel.sessionId),
    ids.slice(0, MAX_CHAT_PANELS),
  );
});

test("external pane drops reserve only horizontal edges for insertion", () => {
  const rect = { left: 100, right: 300, width: 200 };
  assert.equal(horizontalDropEdge(110, rect), "before");
  assert.equal(horizontalDropEdge(290, rect), "after");
  assert.equal(horizontalDropEdge(200, rect), undefined);
});

test("external pane drops distinguish both ends, real gaps, and pane centers", () => {
  const rects = [
    { index: 0, left: 100, right: 290, top: 50, bottom: 250, width: 190 },
    { index: 1, left: 300, right: 490, top: 50, bottom: 250, width: 190 },
    { index: 2, left: 500, right: 690, top: 50, bottom: 250, width: 190 },
  ];

  assert.deepEqual(paneDropTargetAt(102, 120, rects), {
    mode: "insert", index: 0, anchorIndex: 0, edge: "before",
  });
  assert.deepEqual(paneDropTargetAt(295, 120, rects), {
    mode: "insert", index: 1, anchorIndex: 1, edge: "before",
  });
  assert.deepEqual(paneDropTargetAt(400, 120, rects), { mode: "replace", index: 1 });
  assert.deepEqual(paneDropTargetAt(688, 120, rects), {
    mode: "insert", index: 3, anchorIndex: 2, edge: "after",
  });
});

test("each existing pane uses left, center, and right thirds for insert or replace", () => {
  const rects = [{ index: 0, left: 100, right: 400, top: 50, bottom: 250, width: 300 }];
  assert.deepEqual(paneDropTargetAt(199, 120, rects), {
    mode: "insert", index: 0, anchorIndex: 0, edge: "before",
  });
  assert.deepEqual(paneDropTargetAt(250, 120, rects), { mode: "replace", index: 0 });
  assert.deepEqual(paneDropTargetAt(301, 120, rects), {
    mode: "insert", index: 1, anchorIndex: 0, edge: "after",
  });
});

test("external pane drops select the visual row before resolving an insertion", () => {
  const rects = [
    { index: 0, left: 100, right: 300, top: 50, bottom: 200, width: 200 },
    { index: 1, left: 301, right: 500, top: 50, bottom: 200, width: 199 },
    { index: 2, left: 100, right: 300, top: 201, bottom: 350, width: 200 },
    { index: 3, left: 301, right: 500, top: 201, bottom: 350, width: 199 },
  ];

  assert.deepEqual(paneDropTargetAt(400, 280, rects), { mode: "replace", index: 3 });
  assert.deepEqual(paneDropTargetAt(300.5, 280, rects), {
    mode: "insert", index: 3, anchorIndex: 3, edge: "before",
  });
});

test("persisted dashboards discard chat panes beyond the live-session cap", () => {
  const normalized = normalizeDashboardsState({
    version: 1,
    activeDashboardId: "dashboard",
    dashboards: [{
      id: "dashboard",
      name: "",
      panels: Array.from({ length: 6 }, (_, index) => ({ id: `panel-${index}`, kind: "chat", sessionId: `session-${index}` })),
    }],
  });
  assert.equal(normalized?.dashboards[0]?.panels.length, MAX_CHAT_PANELS);
});

test("panel membership and order changes invalidate position-based dashboard sizes", () => {
  const first = { id: "one", kind: "studio" as const };
  const second = { id: "two", kind: "kanban" as const };
  const sized = {
    id: "dashboard",
    name: "",
    panels: [first, second],
    sizes: { count: 2, rowFr: [1], colFr: [[3, 1]] },
  };

  const added = replaceDashboardPanels(sized, [...sized.panels, { id: "three", kind: "teams" as const }]);
  assert.equal(added.sizes, undefined);
  const returnedToTwo = replaceDashboardPanels(added, [first, second]);
  assert.deepEqual(dashboardEffectiveSizes(returnedToTwo).colFr, [[1, 1]]);

  const reordered = replaceDashboardPanels(sized, [second, first]);
  assert.equal(reordered.sizes, undefined, "fractions cannot follow panels without a panel-id signature");
});

test("sidebar navigation finds a registered pane without adding it", () => {
  resetDashboardStateForTests({
    version: 1,
    activeDashboardId: "first",
    dashboards: [
      { id: "first", name: "First", panels: [{ id: "studio", kind: "studio" }] },
      { id: "second", name: "Second", panels: [{ id: "kanban", kind: "kanban" }, { id: "chat", kind: "chat", sessionId: "session" }] },
    ],
  });

  assert.equal(dashboardContainingPanel("studio")?.id, "first", "the active dashboard wins when it contains the pane");
  assert.equal(dashboardContainingPanel("kanban")?.id, "second");
  assert.equal(dashboardContainingPanel("chat", { sessionId: "session" })?.id, "second");
  assert.equal(dashboardContainingPanel("teams"), undefined);
  assert.equal(dashboards.value[0]?.panels.length, 1, "lookup never mutates dashboard membership");
});

test("sidebar chat clicks seed an empty dashboard, require drag without chat, and replace the last-active chat", () => {
  sessions.value = ["one", "two", "three"].map((id): ChatSession => ({
    id,
    profileId: "profile",
    title: id,
    status: "ready",
    messages: [],
    remoteKind: "stored",
    connectionState: "ready",
    historyState: "loaded",
  }));

  openSessionIds.value = [];
  activeSessionId.value = "";
  resetDashboardStateForTests({
    version: 1,
    activeDashboardId: "empty",
    dashboards: [{ id: "empty", name: "", panels: [], defaultChatSeeded: true }],
  });
  assert.equal(selectDashboardChatSession("one"), "added");
  assert.deepEqual(activeDashboard.value.panels.map((panel) => panel.sessionId), ["one"]);

  openSessionIds.value = [];
  activeSessionId.value = "";
  resetDashboardStateForTests({
    version: 1,
    activeDashboardId: "studio-only",
    dashboards: [{ id: "studio-only", name: "", panels: [{ id: "studio", kind: "studio" }] }],
  });
  assert.equal(selectDashboardChatSession("one"), "drag-required");
  assert.deepEqual(activeDashboard.value.panels.map((panel) => panel.kind), ["studio"]);

  openSessionIds.value = ["one", "two"];
  activeSessionId.value = "one";
  resetDashboardStateForTests({
    version: 1,
    activeDashboardId: "multi-chat",
    dashboards: [{
      id: "multi-chat",
      name: "",
      panels: [
        { id: "studio", kind: "studio" },
        { id: "chat-one", kind: "chat", sessionId: "one" },
        { id: "chat-two", kind: "chat", sessionId: "two" },
      ],
    }],
  });
  assert.equal(selectDashboardChatSession("three"), "replaced");
  assert.deepEqual(
    activeDashboard.value.panels.filter((panel) => panel.kind === "chat").map((panel) => panel.sessionId),
    ["three", "two"],
  );
  assert.equal(activeSessionId.value, "three");

  assert.equal(selectDashboardChatSession("two"), "focused");
  assert.equal(activeSessionId.value, "two");
});

test("dropping a sidebar item on a pane replaces it and removes a duplicate source pane", () => {
  resetDashboardStateForTests({
    version: 1,
    activeDashboardId: "dashboard",
    dashboards: [{
      id: "dashboard",
      name: "",
      panels: [{ id: "studio", kind: "studio" }, { id: "kanban", kind: "kanban" }, { id: "chat", kind: "chat", sessionId: "session" }],
      sizes: { count: 3, rowFr: [1], colFr: [[2, 1, 1]] },
    }],
  });

  assert.equal(replacePanelInActiveDashboard("kanban", "teams"), "replaced");
  assert.deepEqual(dashboards.value[0]?.panels.map((panel) => [panel.id, panel.kind]), [
    ["studio", "studio"], ["kanban", "teams"], ["chat", "chat"],
  ]);
  assert.deepEqual(dashboards.value[0]?.sizes?.colFr, [[2, 1, 1]], "in-place replacement keeps matching panel sizes");

  assert.equal(replacePanelInActiveDashboard("studio", "teams"), "replaced");
  assert.deepEqual(dashboards.value[0]?.panels.map((panel) => [panel.id, panel.kind]), [
    ["studio", "teams"], ["chat", "chat"],
  ]);
  assert.equal(dashboards.value[0]?.sizes, undefined, "removing the old duplicate invalidates position-based sizes");
});

test("modal-only sessions release their live target only after the last presentation closes", () => {
  const released: string[] = [];
  sessions.value = [{
    id: "modal-only", storedSessionId: "stored", liveSessionId: "live", profileId: "profile", title: "Session",
    status: "ready", messages: [], remoteKind: "stored", connectionState: "ready", historyState: "loaded",
  }];
  openSessionIds.value = ["modal-only"];
  profileChatModalId.value = "profile";
  profileChatModalPaneIds.value = ["modal-only"];
  registerChatRuntime({
    ensureSession() {}, releaseSession(sessionId) { released.push(sessionId); },
    async submitPrompt() { return { status: "accepted" }; }, async steer() { return { status: "queued" }; }, interrupt() {},
    async respondClarify() {}, async respondApproval() {},
  });

  closeSession("modal-only");
  assert.deepEqual(released, [], "the modal still presents the live target");
  closeProfileChatModal();
  assert.deepEqual(released, ["modal-only"]);
  assert.equal(sessions.value[0]?.connectionState, "disconnected");
});

test("modal clicks replace the only or last-active pane without growing the layout", () => {
  sessions.value = ["one", "two", "three"].map((id): ChatSession => ({
    id,
    storedSessionId: `stored-${id}`,
    profileId: "profile",
    title: id,
    status: "ready",
    messages: [],
    remoteKind: "stored",
    connectionState: "ready",
    historyState: "loaded",
  }));
  profileChatModalId.value = "profile";
  setProfileChatModalPanes(["one"]);
  assert.equal(profileChatModalActivePaneId.value, "one");

  assert.equal(selectProfileChatModalSession("two"), true);
  assert.deepEqual(profileChatModalPaneIds.value, ["two"], "a single pane is replaced instead of appended");
  assert.equal(profileChatModalActivePaneId.value, "two");

  setProfileChatModalPanes(["one", "two"]);
  setProfileChatModalActivePane("one");
  assert.equal(selectProfileChatModalSession("three"), true);
  assert.deepEqual(profileChatModalPaneIds.value, ["three", "two"], "the last-active pane is replaced in place");
  assert.equal(profileChatModalActivePaneId.value, "three");

  assert.equal(selectProfileChatModalSession("two"), true);
  assert.deepEqual(profileChatModalPaneIds.value, ["three", "two"], "an existing pane is focused without duplication");
  assert.equal(profileChatModalActivePaneId.value, "two");
});

test("modal drop replacement removes a duplicate source pane and keeps the target position", () => {
  sessions.value = ["one", "two", "three"].map((id): ChatSession => ({
    id,
    storedSessionId: `stored-${id}`,
    profileId: "profile",
    title: id,
    status: "ready",
    messages: [],
    remoteKind: "stored",
    connectionState: "ready",
    historyState: "loaded",
  }));
  profileChatModalId.value = "profile";
  setProfileChatModalPanes(["one", "two", "three"]);

  assert.equal(replaceProfileChatModalPane("one", "three"), true);
  assert.deepEqual(profileChatModalPaneIds.value, ["three", "two"]);
  assert.equal(profileChatModalActivePaneId.value, "three");
});

test("closing a streaming pane defers its live release until the run becomes terminal", () => {
  const released: string[] = [];
  sessions.value = [{
    id: "background-run", storedSessionId: "stored", liveSessionId: "live", profileId: "profile", title: "Session",
    status: "streaming", streamingMessageId: "reply", messages: [{
      id: "reply", from: "agent", body: "working", at: "00:00", status: "streaming",
    }], remoteKind: "stored", connectionState: "ready", historyState: "loaded",
  }];
  openSessionIds.value = ["background-run"];
  profileChatModalId.value = null;
  profileChatModalPaneIds.value = [];
  embeddedChatSessionIds.value = [];
  registerChatRuntime({
    ensureSession() {}, releaseSession(sessionId) { released.push(sessionId); },
    async submitPrompt() { return { status: "accepted" }; }, async steer() { return { status: "queued" }; }, interrupt() {},
    async respondClarify() {}, async respondApproval() {},
  });

  closeSession("background-run");
  assert.deepEqual(released, []);
  assert.equal(sessions.value[0]?.connectionState, "ready");

  sessions.value = sessions.value.map((session) => ({
    ...session,
    status: "ready" as const,
    streamingMessageId: undefined,
    messages: session.messages.map((message) => ({ ...message, status: "complete" as const })),
  }));
  assert.deepEqual(released, ["background-run"]);
  assert.equal(sessions.value[0]?.connectionState, "disconnected");
});

test("a hidden running lease reserves capacity before a replacement target starts", () => {
  const ensured: string[] = [];
  const released: string[] = [];
  sessions.value = [
    {
      id: "background-run", storedSessionId: "stored-run", liveSessionId: "live-run", profileId: "profile", title: "Run",
      status: "streaming", streamingMessageId: "reply", messages: [{
        id: "reply", from: "agent", body: "working", at: "00:00", status: "streaming",
      }], remoteKind: "stored", connectionState: "ready", historyState: "loaded",
    },
    ...[2, 3, 4].map((index): ChatSession => ({
      id: `workspace-${index}`, storedSessionId: `stored-${index}`, liveSessionId: `live-${index}`,
      profileId: "profile", title: `Workspace ${index}`, status: "ready", messages: [],
      remoteKind: "stored", connectionState: "ready", historyState: "loaded",
    })),
    {
      id: "replacement", storedSessionId: "stored-replacement", profileId: "profile", title: "Replacement",
      status: "ready", messages: [], remoteKind: "stored", connectionState: "disconnected", historyState: "loaded",
    },
  ];
  openSessionIds.value = ["background-run", "workspace-2", "workspace-3", "workspace-4"];
  profileChatModalId.value = null;
  profileChatModalPaneIds.value = [];
  embeddedChatSessionIds.value = [];
  registerChatRuntime({
    ensureSession(target) { ensured.push(target.clientSessionId); },
    releaseSession(sessionId) { released.push(sessionId); },
    async submitPrompt() { return { status: "accepted" }; }, async steer() { return { status: "queued" }; }, interrupt() {},
    async respondClarify() {}, async respondApproval() {},
  });

  closeSession("background-run");
  openSession("replacement");
  assert.equal(ensured.includes("replacement"), false, "the fifth server lease must not start while the hidden run owns one");
  assert.deepEqual(getOpenChatTargets().map((target) => target.clientSessionId), ["workspace-2", "workspace-3", "workspace-4"]);

  sessions.value = sessions.value.map((item) => item.id === "background-run" ? {
    ...item,
    status: "ready" as const,
    streamingMessageId: undefined,
    messages: item.messages.map((message) => ({ ...message, status: "complete" as const })),
  } : item);
  assert.equal(released.includes("background-run"), true);
  assert.equal(ensured.includes("replacement"), true, "the newly-free lease should start the waiting visible target");
});

test("modal panes take foreground lease priority without exceeding four live targets", () => {
  const ensured: string[] = [];
  const released: string[] = [];
  const workspaceSessions: ChatSession[] = [1, 2, 3, 4].map((index) => ({
      id: `workspace-${index}`, storedSessionId: `stored-workspace-${index}`, profileId: "profile", title: `Workspace ${index}`,
      status: "ready", messages: [], remoteKind: "stored", connectionState: "ready", historyState: "loaded",
    }));
  sessions.value = [...workspaceSessions,
    {
      id: "modal", storedSessionId: "stored-modal", profileId: "profile", title: "Modal",
      status: "ready", messages: [], remoteKind: "stored", connectionState: "disconnected", historyState: "loaded",
    },
  ];
  openSessionIds.value = ["workspace-1", "workspace-2", "workspace-3", "workspace-4"];
  profileChatModalId.value = "profile";
  profileChatModalPaneIds.value = [];
  registerChatRuntime({
    ensureSession(target) { ensured.push(target.clientSessionId); },
    releaseSession(sessionId) { released.push(sessionId); },
    async submitPrompt() { return { status: "accepted" }; }, async steer() { return { status: "queued" }; }, interrupt() {},
    async respondClarify() {}, async respondApproval() {},
  });

  assert.equal(addProfileChatModalPane("modal"), true);
  assert.deepEqual(getOpenChatTargets().map((target) => target.clientSessionId), ["modal", "workspace-1", "workspace-2", "workspace-3"]);
  assert.deepEqual(released, ["workspace-4"]);
  assert.deepEqual(ensured, ["workspace-1", "workspace-2", "workspace-3", "workspace-4", "modal"]);

  closeProfileChatModal();
  assert.deepEqual(getOpenChatTargets().map((target) => target.clientSessionId), ["workspace-1", "workspace-2", "workspace-3", "workspace-4"]);
  assert.deepEqual(released, ["workspace-4", "modal"]);
  assert.deepEqual(ensured, ["workspace-1", "workspace-2", "workspace-3", "workspace-4", "modal", "workspace-4"]);
});

test("embedded modal chats take a foreground lease without becoming workspace panes", () => {
  const ensured: string[] = [];
  const released: string[] = [];
  sessions.value = [
    ...[1, 2, 3, 4].map((index): ChatSession => ({
      id: `workspace-${index}`, storedSessionId: `stored-${index}`, profileId: "profile", title: "Workspace",
      status: "ready", messages: [], remoteKind: "stored", connectionState: "ready", historyState: "loaded",
    })),
    {
      id: "embedded", storedSessionId: "stored-embedded", profileId: "profile", title: "Embedded",
      status: "ready", messages: [], remoteKind: "stored", connectionState: "disconnected", historyState: "loaded",
    },
  ];
  openSessionIds.value = ["workspace-1", "workspace-2", "workspace-3", "workspace-4"];
  profileChatModalId.value = null;
  profileChatModalPaneIds.value = [];
  embeddedChatSessionIds.value = [];
  registerChatRuntime({
    ensureSession(target) { ensured.push(target.clientSessionId); },
    releaseSession(sessionId) { released.push(sessionId); },
    async submitPrompt() { return { status: "accepted" }; }, async steer() { return { status: "queued" }; }, interrupt() {},
    async respondClarify() {}, async respondApproval() {},
  });

  assert.equal(openEmbeddedChatSession("embedded"), true);
  assert.deepEqual(openSessionIds.value, ["workspace-1", "workspace-2", "workspace-3", "workspace-4"]);
  assert.deepEqual(getOpenChatTargets().map((target) => target.clientSessionId), ["embedded", "workspace-1", "workspace-2", "workspace-3"]);
  assert.deepEqual(released, ["workspace-4"]);

  closeEmbeddedChatSession("embedded");
  assert.deepEqual(getOpenChatTargets().map((target) => target.clientSessionId), ["workspace-1", "workspace-2", "workspace-3", "workspace-4"]);
  assert.deepEqual(released, ["workspace-4", "embedded"]);
  assert.deepEqual(ensured, ["workspace-1", "workspace-2", "workspace-3", "workspace-4", "embedded", "workspace-4"]);
});

test("dashboard mirror pauses only for cleared, unavailable server inventory", () => {
  assert.equal(dashboardChatMirrorSuspended({ source: "server", state: "error", runtime: "ready" }, 0), true);
  assert.equal(dashboardChatMirrorSuspended({ source: "server", state: "connected", runtime: "starting" }, 0), true);
  assert.equal(dashboardChatMirrorSuspended({ source: "server", state: "error", runtime: "ready" }, 1), false);
  assert.equal(dashboardChatMirrorSuspended({ source: "server", state: "connected", runtime: "ready" }, 0), false);
  assert.equal(dashboardChatMirrorSuspended({ source: "demo", state: "demo", runtime: "unconfigured" }, 0), false);
});

test("dashboard cleanup accepts only a complete terminal session inventory", () => {
  const complete = { returned: 0, available: 0, total: 0, hasMore: false, truncated: false, partialFailures: 0 };
  assert.equal(dashboardSessionInventoryAuthoritative(
    { source: "server", state: "connected", runtime: "ready" },
    complete,
  ), true);
  assert.equal(dashboardSessionInventoryAuthoritative(
    { source: "server", state: "connected", runtime: "ready" },
    { ...complete, hasMore: true, nextCursor: "next" },
  ), false);
  assert.equal(dashboardSessionInventoryAuthoritative(
    { source: "server", state: "error", runtime: "ready" },
    complete,
  ), false);
  assert.equal(dashboardSessionInventoryAuthoritative(
    { source: "server", state: "connected", runtime: "ready" },
    complete,
    false,
  ), false);
});
