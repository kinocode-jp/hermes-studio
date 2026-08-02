import assert from "node:assert/strict";
import test from "node:test";
import type { ChatSession } from "../src/domain.ts";
import {
  MAX_LIVE_CHAT_SESSIONS,
  MAX_LIVE_CHAT_SESSIONS_PER_PROFILE,
  activeSessionId,
  addProfileChatModalPane,
  appendOpenSessionId,
  closeProfileChatModal,
  closeEmbeddedChatSession,
  closeSession,
  embeddedChatSessionIds,
  getOpenChatTargets,
  officeConnection,
  openProfileChatModal,
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
  sendMessage,
  setProfileChatModalSessionInventoryAuthoritative,
  setProfileChatModalActivePane,
  setProfileChatModalPanes,
  sessions,
} from "../src/store.ts";
import {
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
import { addDashboardPanel, closeDashboardPanel, createDashboardWithDefaultChat, dashboardChatMirrorSuspended, dashboardSessionInventoryAuthoritative, initializeDefaultDashboardChat, installDashboardWiring, replaceDashboardPanel, selectDashboardChatSession } from "../src/dashboard-actions.ts";
import { horizontalDropEdge, paneDropTargetAt } from "../src/dashboard-drag.ts";
import {
  saveProfileChatModalLayout,
  savedProfileChatModalLayout,
} from "../src/profile-chat-modal-prefs.ts";
import {
  clearChatComposerState,
  setChatComposerAttachments,
  setChatComposerDraft,
} from "../src/chat-composer-state.ts";

test("opening a fifth chat keeps every visible pane", () => {
  const current = ["one", "two", "three", "four"];
  const next = appendOpenSessionId(current, "five");

  assert.deepEqual(next, ["one", "two", "three", "four", "five"]);
  assert.deepEqual(current, ["one", "two", "three", "four"]);
});

test("reopening an existing chat does not reorder or duplicate it", () => {
  assert.deepEqual(appendOpenSessionId(["one", "two"], "one"), ["one", "two"]);
});

test("live-session safety bounds are separate from visible pane counts", () => {
  assert.equal(MAX_LIVE_CHAT_SESSIONS, 16);
  assert.equal(MAX_LIVE_CHAT_SESSIONS_PER_PROFILE, 8);
});

test("a draft's first prompt claims capacity before session.create", async () => {
  const released: string[] = [];
  const ensured: string[] = [];
  const storedSessions: ChatSession[] = Array.from({ length: MAX_LIVE_CHAT_SESSIONS }, (_, index) => ({
    id: `lease-${index + 1}`,
    storedSessionId: `stored-${index + 1}`,
    liveSessionId: `live-${index + 1}`,
    profileId: `profile-${index + 1}`,
    title: `Lease ${index + 1}`,
    status: "ready",
    messages: [],
    remoteKind: "stored",
    connectionState: "ready",
    historyState: "loaded",
  }));
  const draft: ChatSession = {
    id: "first-prompt-draft", profileId: "draft-profile", title: "", status: "ready", messages: [],
    remoteKind: "draft", connectionState: "ready", historyState: "loaded", readOnly: false,
  };
  sessions.value = [...storedSessions, draft];
  openSessionIds.value = [...storedSessions.map((session) => session.id), draft.id];
  activeSessionId.value = draft.id;
  registerChatRuntime({
    ensureSession(target) { ensured.push(target.clientSessionId); }, releaseSession(sessionId) { released.push(sessionId); },
    async submitPrompt() { return { status: "rejected", message: "synthetic" }; },
    async steer() { return { status: "queued" }; }, interrupt() {}, async respondClarify() {}, async respondApproval() {},
  });
  ensured.length = 0;

  await sendMessage(draft.id, "claim a live slot");

  assert.equal(released.includes(storedSessions.at(-1)!.id), true);
  assert.equal(ensured.includes(storedSessions.at(-1)!.id), true, "a rejected first prompt returns the borrowed slot");
});

test("a draft's first slash command also claims live-session capacity", async () => {
  const released: string[] = [];
  const ensured: string[] = [];
  const storedSessions: ChatSession[] = Array.from({ length: MAX_LIVE_CHAT_SESSIONS }, (_, index) => ({
    id: `slash-lease-${index + 1}`,
    storedSessionId: `slash-stored-${index + 1}`,
    liveSessionId: `slash-live-${index + 1}`,
    profileId: `slash-profile-${index + 1}`,
    title: `Slash lease ${index + 1}`,
    status: "ready",
    messages: [],
    remoteKind: "stored",
    connectionState: "ready",
    historyState: "loaded",
  }));
  const draft: ChatSession = {
    id: "first-slash-draft", profileId: "draft-profile", title: "", status: "ready", messages: [],
    remoteKind: "draft", connectionState: "ready", historyState: "loaded", readOnly: false,
  };
  sessions.value = [...storedSessions, draft];
  openSessionIds.value = [...storedSessions.map((session) => session.id), draft.id];
  activeSessionId.value = draft.id;
  registerChatRuntime({
    ensureSession(target) { ensured.push(target.clientSessionId); }, releaseSession(sessionId) { released.push(sessionId); },
    async submitPrompt() { return { status: "accepted" }; },
    async execSlash() { return { status: "ok", output: "ready", warning: "" }; },
    async steer() { return { status: "queued" }; }, interrupt() {}, async respondClarify() {}, async respondApproval() {},
  });
  ensured.length = 0;

  await sendMessage(draft.id, "/status");

  assert.equal(released.includes(storedSessions.at(-1)!.id), true);
  assert.equal(ensured.includes(storedSessions.at(-1)!.id), true, "the completed local slash returns the borrowed slot");
});

test("closing and reopening an unused draft keeps its local composer ready", () => {
  const released: string[] = [];
  const ensured: string[] = [];
  const draft: ChatSession = {
    id: "reopen-local-draft", profileId: "draft-profile", title: "", status: "ready", messages: [],
    remoteKind: "draft", connectionState: "ready", historyState: "loaded", readOnly: false,
  };
  sessions.value = [draft];
  openSessionIds.value = [draft.id];
  activeSessionId.value = draft.id;
  registerChatRuntime({
    ensureSession(target) { ensured.push(target.clientSessionId); }, releaseSession(sessionId) { released.push(sessionId); },
    async submitPrompt() { return { status: "accepted" }; }, async steer() { return { status: "queued" }; },
    interrupt() {}, async respondClarify() {}, async respondApproval() {},
  });

  closeSession(draft.id);
  assert.deepEqual(released, [draft.id]);
  assert.equal(sessions.value[0]?.connectionState, "ready");
  assert.equal(sessions.value[0]?.readOnly, false);

  openSession(draft.id);
  assert.equal(ensured.includes(draft.id), true);
  assert.equal(sessions.value[0]?.connectionState, "ready");
  assert.equal(sessions.value[0]?.readOnly, false);
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

test("dashboard edge-add accepts a fifth chat without evicting a registered pane", () => {
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
  openSessionIds.value = ids.slice(0, 4);
  resetDashboardStateForTests({
    version: 1,
    activeDashboardId: "dashboard",
    dashboards: [{
      id: "dashboard",
      name: "",
      panels: ids.slice(0, 4).map((sessionId) => ({
        id: `panel-${sessionId}`,
        kind: "chat" as const,
        sessionId,
      })),
    }],
  });

  assert.equal(addDashboardPanel("chat", { sessionId: "five", index: 2 }), "added");
  assert.deepEqual(openSessionIds.value, ["one", "two", "five", "three", "four"]);
  assert.deepEqual(
    dashboards.value[0]?.panels.map((panel) => panel.sessionId),
    ["one", "two", "five", "three", "four"],
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

test("persisted dashboards retain more than four chat panes", () => {
  const normalized = normalizeDashboardsState({
    version: 1,
    activeDashboardId: "dashboard",
    dashboards: [{
      id: "dashboard",
      name: "",
      panels: Array.from({ length: 6 }, (_, index) => ({ id: `panel-${index}`, kind: "chat", sessionId: `session-${index}` })),
    }],
  });
  assert.equal(normalized?.dashboards[0]?.panels.length, 6);
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

test("sidebar chat clicks search all dashboards, create only when none has chat, and replace the last-active pane", () => {
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
  assert.equal(dashboards.value.length, 2, "the first chat is placed on a newly created dashboard");
  assert.deepEqual(activeDashboard.value.panels.map((panel) => panel.sessionId), ["one"]);

  openSessionIds.value = [];
  activeSessionId.value = "";
  resetDashboardStateForTests({
    version: 1,
    activeDashboardId: "studio-only",
    dashboards: [
      { id: "studio-only", name: "", panels: [{ id: "studio", kind: "studio" }] },
      { id: "chat-dashboard", name: "", panels: [{ id: "chat-one", kind: "chat", sessionId: "one" }] },
    ],
  });
  assert.equal(selectDashboardChatSession("one"), "focused");
  assert.equal(activeDashboardId.value, "chat-dashboard");
  assert.deepEqual(activeDashboard.value.panels.map((panel) => panel.sessionId), ["one"]);
  assert.equal(selectDashboardChatSession("two"), "replaced");
  assert.deepEqual(activeDashboard.value.panels.map((panel) => panel.sessionId), ["two"]);

  openSessionIds.value = ["one", "two"];
  activeSessionId.value = "one";
  resetDashboardStateForTests({
    version: 1,
    activeDashboardId: "multi-chat",
    dashboards: [{
      id: "multi-chat",
      name: "",
      activeChatPanelId: "chat-one",
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
  assert.equal(activeDashboard.value.activeChatPanelId, "chat-two");
});

test("sidebar chat click switches to the dashboard already showing the conversation", () => {
  const draft: ChatSession = {
    id: "initial-draft",
    profileId: "profile",
    title: "",
    titlePresentation: "new-chat",
    status: "ready",
    messages: [],
    remoteKind: "draft",
    connectionState: "ready",
    historyState: "loaded",
  };
  const existing: ChatSession = {
    id: "existing",
    storedSessionId: "stored-existing",
    profileId: "profile",
    title: "Existing",
    status: "ready",
    messages: [],
    remoteKind: "stored",
    connectionState: "ready",
    historyState: "loaded",
  };
  sessions.value = [draft, existing];
  openSessionIds.value = [draft.id];
  activeSessionId.value = draft.id;
  resetDashboardStateForTests({
    version: 1,
    activeDashboardId: "current",
    dashboards: [
      { id: "current", name: "", activeChatPanelId: "initial-pane", panels: [{ id: "initial-pane", kind: "chat", sessionId: draft.id }] },
      { id: "other", name: "", panels: [{ id: "existing-pane", kind: "chat", sessionId: existing.id }] },
    ],
  });

  // A conversation visible on another dashboard is focused there; the blank
  // initial pane on the active dashboard must not be replaced as a side effect.
  assert.equal(selectDashboardChatSession(existing.id), "focused");
  assert.equal(activeDashboardId.value, "other");
  assert.deepEqual(activeDashboard.value.panels.map((panel) => panel.sessionId), [existing.id]);
  assert.equal(activeDashboard.value.activeChatPanelId, "existing-pane");
  assert.deepEqual(
    dashboards.value.find((dashboard) => dashboard.id === "current")?.panels.map((panel) => panel.sessionId),
    [draft.id],
    "the previous dashboard keeps its panes unchanged",
  );
  assert.equal(activeSessionId.value, existing.id);
  assert.equal(sessions.value.some((session) => session.id === draft.id), true, "no replacement leaves the unused draft alone");
});

test("sidebar chat click replaces the blank initial pane only when the conversation is visible nowhere", () => {
  const localDraft: ChatSession = {
    id: "local-initial-draft",
    profileId: "profile",
    title: "",
    titlePresentation: "new-chat",
    status: "ready",
    messages: [],
    remoteKind: "draft",
    connectionState: "ready",
    historyState: "loaded",
  };
  const storedEmpty: ChatSession = {
    id: "stored-initial-empty",
    storedSessionId: "stored-initial",
    profileId: "profile",
    title: "",
    titlePresentation: "new-chat",
    status: "ready",
    messages: [],
    remoteKind: "stored",
    connectionState: "ready",
    historyState: "loaded",
  };
  const existing: ChatSession = {
    id: "existing",
    storedSessionId: "stored-existing",
    profileId: "profile",
    title: "Existing",
    status: "ready",
    messages: [],
    remoteKind: "stored",
    connectionState: "ready",
    historyState: "loaded",
  };

  // A purely local unpersisted draft behind the blank initial pane is
  // dismissed once its pane is replaced.
  sessions.value = [localDraft, existing];
  openSessionIds.value = [localDraft.id];
  activeSessionId.value = localDraft.id;
  resetDashboardStateForTests({
    version: 1,
    activeDashboardId: "current",
    dashboards: [
      { id: "current", name: "", activeChatPanelId: "initial-pane", panels: [{ id: "initial-pane", kind: "chat", sessionId: localDraft.id }] },
    ],
  });
  assert.equal(selectDashboardChatSession(existing.id), "replaced");
  assert.equal(activeDashboardId.value, "current");
  assert.deepEqual(activeDashboard.value.panels.map((panel) => panel.sessionId), [existing.id]);
  assert.deepEqual(openSessionIds.value, [existing.id]);
  assert.equal(activeSessionId.value, existing.id);
  assert.equal(sessions.value.some((session) => session.id === localDraft.id), false, "the replaced unused local draft leaves the session list");

  // A persisted empty conversation behind the blank initial pane is replaced
  // in the layout but stays available in the sidebar.
  sessions.value = [storedEmpty, existing];
  openSessionIds.value = [storedEmpty.id];
  activeSessionId.value = storedEmpty.id;
  resetDashboardStateForTests({
    version: 1,
    activeDashboardId: "current",
    dashboards: [
      { id: "current", name: "", activeChatPanelId: "initial-pane", panels: [{ id: "initial-pane", kind: "chat", sessionId: storedEmpty.id }] },
    ],
  });
  assert.equal(selectDashboardChatSession(existing.id), "replaced");
  assert.deepEqual(activeDashboard.value.panels.map((panel) => panel.sessionId), [existing.id]);
  assert.equal(sessions.value.some((session) => session.id === storedEmpty.id), true, "a persisted empty conversation stays available in the sidebar");
});

test("sidebar replacement keeps a new-chat session with delivery evidence or unsent composer content", async (context) => {
  const existing: ChatSession = {
    id: "dashboard-retention-existing", storedSessionId: "stored-existing", profileId: "profile", title: "Existing",
    status: "ready", messages: [], remoteKind: "stored", connectionState: "ready", historyState: "loaded",
  };
  const cases: Array<{ name: string; patch?: Partial<ChatSession>; compose?: (sessionId: string) => void }> = [
    { name: "delivery evidence", patch: { operationEvidence: [{ id: "sent", kind: "prompt", body: "hello", at: "12:00", state: "accepted" }] } },
    { name: "live identity", patch: { liveSessionId: "live-dashboard-draft" } },
    { name: "composer text", compose: (sessionId) => setChatComposerDraft(sessionId, "keep me") },
    { name: "composer attachment", compose: (sessionId) => setChatComposerAttachments(sessionId, [{
      id: "dashboard-attachment", name: "note.txt", mime: "text/plain", size: 4, kind: "file", textContent: "note",
    }]) },
  ];

  for (const item of cases) {
    await context.test(item.name, () => {
      const draft: ChatSession = {
        id: `dashboard-retention-${item.name.replaceAll(" ", "-")}`,
        profileId: "profile", title: "", titlePresentation: "new-chat",
        status: "ready", messages: [], remoteKind: "draft", connectionState: "ready", historyState: "loaded",
        ...item.patch,
      };
      clearChatComposerState(draft.id);
      item.compose?.(draft.id);
      sessions.value = [draft, existing];
      openSessionIds.value = [draft.id];
      activeSessionId.value = draft.id;
      resetDashboardStateForTests({
        version: 1,
        activeDashboardId: "retention-dashboard",
        dashboards: [{
          id: "retention-dashboard", name: "", activeChatPanelId: "draft-pane",
          panels: [{ id: "draft-pane", kind: "chat", sessionId: draft.id }],
        }],
      });

      assert.equal(selectDashboardChatSession(existing.id), "replaced");
      assert.deepEqual(activeDashboard.value.panels.map((panel) => panel.sessionId), [existing.id]);
      assert.equal(sessions.value.some((session) => session.id === draft.id), true, "sidebar replacement must retain the conversation in the session list");
      clearChatComposerState(draft.id);
    });
  }
});

test("sidebar chat click focuses a visible conversation before considering a blank initial pane", () => {
  const draft: ChatSession = {
    id: "visible-initial-draft", profileId: "profile", title: "", titlePresentation: "new-chat",
    status: "ready", messages: [], remoteKind: "draft", connectionState: "ready", historyState: "loaded",
  };
  const existing: ChatSession = {
    id: "visible-existing", storedSessionId: "stored-existing", profileId: "profile", title: "Existing",
    status: "ready", messages: [], remoteKind: "stored", connectionState: "ready", historyState: "loaded",
  };
  sessions.value = [draft, existing];
  openSessionIds.value = [draft.id, existing.id];
  activeSessionId.value = draft.id;
  resetDashboardStateForTests({
    version: 1,
    activeDashboardId: "current",
    dashboards: [{
      id: "current",
      name: "",
      activeChatPanelId: "initial-pane",
      panels: [
        { id: "initial-pane", kind: "chat", sessionId: draft.id },
        { id: "existing-pane", kind: "chat", sessionId: existing.id },
      ],
    }],
  });

  assert.equal(selectDashboardChatSession(existing.id), "focused");
  assert.deepEqual(activeDashboard.value.panels.map((panel) => panel.sessionId), [draft.id, existing.id]);
  assert.equal(activeDashboard.value.activeChatPanelId, "existing-pane");
  assert.equal(activeSessionId.value, existing.id);
});

test("restoring several persisted chat panes does not recursively reactivate them", () => {
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
  let dispose = () => {};
  try {
    const ids = ["restore-one", "restore-two", "restore-three"];
    officeConnection.value = { ...previousConnection, state: "demo", source: "demo" };
    profileList.value = [{
      id: "default", name: "Default", role: "", status: "idle", color: "#087f70",
      sessions: 0, taskCount: 0, memoryBytes: 0, memoryNote: "", skills: [], inheritedSkills: [],
    }];
    sessions.value = ids.map((id): ChatSession => ({
      id,
      profileId: "profile",
      title: id,
      status: "ready",
      messages: [],
      remoteKind: "demo",
      connectionState: "ready",
      historyState: "loaded",
    }));
    openSessionIds.value = [];
    activeSessionId.value = "";
    resetDashboardStateForTests({
      version: 1,
      activeDashboardId: "restore",
      dashboards: [{
        id: "restore",
        name: "",
        activeChatPanelId: "pane-1",
        panels: ids.map((sessionId, index) => ({ id: `pane-${index}`, kind: "chat" as const, sessionId })),
      }],
    });

    assert.doesNotThrow(() => { dispose = installDashboardWiring(); });
    assert.deepEqual(openSessionIds.value, ids);
    assert.equal(activeSessionId.value, "restore-two", "the persisted active pane is restored last and remains active");

    const repeatedEnsures: string[] = [];
    registerChatRuntime({
      ensureSession(target) { repeatedEnsures.push(target.clientSessionId); }, releaseSession() {}, submitPrompt() {},
      async steer() { return { status: "queued" }; }, interrupt() {}, async respondClarify() {}, async respondApproval() {},
    });
    sessions.value = sessions.value.map((session, index) => index === 0 ? {
      ...session,
      storedSessionId: `stored-${session.id}`,
      remoteKind: "stored" as const,
      connectionState: "error" as const,
      historyState: "loaded" as const,
    } : session);
    assert.deepEqual(repeatedEnsures, [], "a state update must not be mistaken for a request to reopen an existing pane");

    const newDashboardId = createDashboardWithDefaultChat();
    assert.equal(activeDashboardId.value, newDashboardId);
    assert.equal(activeDashboard.value.panels.length, 1, "old panes must not reopen during the dashboard handoff");
    const initialSession = sessions.value.find((session) => session.id === activeDashboard.value.panels[0]?.sessionId);
    assert.equal(initialSession?.titlePresentation, "new-chat");
  } finally {
    dispose();
    registerChatRuntime({
      ensureSession() {}, releaseSession() {}, submitPrompt() {}, async steer() { return { status: "queued" }; },
      interrupt() {}, async respondClarify() {}, async respondApproval() {},
    });
    officeConnection.value = previousConnection;
    profileList.value = previousProfiles;
    sessions.value = previousSessions;
    openSessionIds.value = previousOpenIds;
    activeSessionId.value = previousActiveId;
    resetDashboardStateForTests(previousDashboardState);
  }
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
  setProfileChatModalPanes([]);
  assert.equal(selectProfileChatModalSession("one"), true);
  assert.deepEqual(profileChatModalPaneIds.value, ["one"], "an empty modal receives its first pane");
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

test("modal click discards the unused local draft that its initial pane replaces", () => {
  const draft: ChatSession = {
    id: "modal-initial-draft", profileId: "profile", title: "", titlePresentation: "new-chat",
    status: "ready", messages: [], remoteKind: "draft", connectionState: "ready", historyState: "loaded",
  };
  const existing: ChatSession = {
    id: "modal-existing", storedSessionId: "stored-existing", profileId: "profile", title: "Existing",
    status: "ready", messages: [], remoteKind: "stored", connectionState: "ready", historyState: "loaded",
  };
  sessions.value = [draft, existing];
  profileChatModalId.value = "profile";
  profileChatModalPaneIds.value = [draft.id];
  profileChatModalActivePaneId.value = draft.id;

  assert.equal(selectProfileChatModalSession(existing.id), true);
  assert.deepEqual(profileChatModalPaneIds.value, [existing.id]);
  assert.equal(sessions.value.some((session) => session.id === draft.id), false);
});

test("modal replacement retains a new-chat draft once it contains user or runtime activity", async (context) => {
  const existing: ChatSession = {
    id: "modal-retention-existing", storedSessionId: "stored-existing", profileId: "profile", title: "Existing",
    status: "ready", messages: [], remoteKind: "stored", connectionState: "ready", historyState: "loaded",
  };
  const cases: Array<{
    name: string;
    patch?: Partial<ChatSession>;
    compose?: (sessionId: string) => void;
  }> = [
    { name: "operation evidence", patch: { operationEvidence: [{ id: "sent", kind: "prompt", body: "hello", at: "12:00", state: "accepted" }] } },
    { name: "live identity", patch: { liveSessionId: "live-draft" } },
    { name: "slash pending", patch: { slashPending: true } },
    { name: "active run", patch: { status: "waiting" } },
    { name: "composer text", compose: (sessionId) => setChatComposerDraft(sessionId, "unsent text") },
    { name: "composer attachment", compose: (sessionId) => setChatComposerAttachments(sessionId, [{
      id: "attachment", name: "note.txt", mime: "text/plain", size: 4, kind: "file", textContent: "note",
    }]) },
  ];

  for (const item of cases) {
    await context.test(item.name, () => {
      const draft: ChatSession = {
        id: `modal-retention-${item.name.replaceAll(" ", "-")}`,
        profileId: "profile", title: "", titlePresentation: "new-chat",
        status: "ready", messages: [], remoteKind: "draft", connectionState: "ready", historyState: "loaded",
        ...item.patch,
      };
      clearChatComposerState(draft.id);
      item.compose?.(draft.id);
      sessions.value = [draft, existing];
      profileChatModalId.value = "profile";
      profileChatModalPaneIds.value = [draft.id];
      profileChatModalActivePaneId.value = draft.id;

      assert.equal(selectProfileChatModalSession(existing.id), true);
      assert.deepEqual(profileChatModalPaneIds.value, [existing.id]);
      assert.equal(sessions.value.some((session) => session.id === draft.id), true, "replacement must not archive an authored or active draft");
      clearChatComposerState(draft.id);
    });
  }
});

test("opening a modal before session pagination completes preserves and later restores its saved panes", () => {
  const previousConnection = officeConnection.value;
  const previousProfiles = profileList.value;
  const previousSessions = sessions.value;
  const previousModalId = profileChatModalId.value;
  const previousPaneIds = profileChatModalPaneIds.value;
  const previousActivePaneId = profileChatModalActivePaneId.value;
  const profileId = "paged-profile";
  const savedSessionId = "stored:paged-profile:later";
  const later: ChatSession = {
    id: savedSessionId, storedSessionId: "later", profileId, title: "Later",
    status: "ready", messages: [], remoteKind: "stored", connectionState: "disconnected", historyState: "unloaded",
  };
  try {
    officeConnection.value = { ...previousConnection, source: "server", state: "connected", runtime: "ready" };
    profileList.value = [{
      id: profileId, name: "Paged", role: "", status: "idle", color: "#087f70",
      sessions: 1, taskCount: 0, memoryBytes: 0, memoryNote: "", skills: [], inheritedSkills: [],
    }];
    sessions.value = [];
    setProfileChatModalSessionInventoryAuthoritative(false);
    saveProfileChatModalLayout(profileId, [savedSessionId], savedSessionId);

    openProfileChatModal(profileId);
    const temporaryDraftId = profileChatModalPaneIds.value[0]!;
    assert.notEqual(temporaryDraftId, savedSessionId);
    assert.deepEqual(savedProfileChatModalLayout(profileId)?.paneSessionIds, [savedSessionId]);

    sessions.value = [...sessions.value, later];
    setProfileChatModalSessionInventoryAuthoritative(true);
    assert.deepEqual(profileChatModalPaneIds.value, [savedSessionId]);
    assert.equal(sessions.value.some((session) => session.id === temporaryDraftId), false);
    assert.deepEqual(savedProfileChatModalLayout(profileId)?.paneSessionIds, [savedSessionId]);
  } finally {
    closeProfileChatModal();
    saveProfileChatModalLayout(profileId, [], "");
    officeConnection.value = previousConnection;
    profileList.value = previousProfiles;
    sessions.value = previousSessions;
    profileChatModalId.value = previousModalId;
    profileChatModalPaneIds.value = previousPaneIds;
    profileChatModalActivePaneId.value = previousActivePaneId;
    setProfileChatModalSessionInventoryAuthoritative(true);
  }
});

test("modal clicks during a pending restore stay provisional until the saved layout is restored", () => {
  const previousConnection = officeConnection.value;
  const previousProfiles = profileList.value;
  const previousSessions = sessions.value;
  const previousModalId = profileChatModalId.value;
  const previousPaneIds = profileChatModalPaneIds.value;
  const previousActivePaneId = profileChatModalActivePaneId.value;
  const profileId = "provisional-profile";
  const savedIds = ["saved-a", "saved-b", "saved-c"];
  const storedSession = (id: string): ChatSession => ({
    id, storedSessionId: `stored-${id}`, profileId, title: id,
    status: "ready", messages: [], remoteKind: "stored", connectionState: "disconnected", historyState: "unloaded",
  });
  try {
    officeConnection.value = { ...previousConnection, source: "server", state: "connected", runtime: "ready" };
    profileList.value = [{
      id: profileId, name: "Provisional", role: "", status: "idle", color: "#087f70",
      sessions: 3, taskCount: 0, memoryBytes: 0, memoryNote: "", skills: [], inheritedSkills: [],
    }];
    // Only the first saved session has paginated in; the rest arrive later.
    sessions.value = [storedSession("saved-a")];
    setProfileChatModalSessionInventoryAuthoritative(false);
    saveProfileChatModalLayout(profileId, savedIds, "saved-c");

    openProfileChatModal(profileId);
    assert.deepEqual(profileChatModalPaneIds.value, ["saved-a"]);

    // Clicking another conversation while the inventory is unauthoritative
    // must not overwrite the saved layout.
    const other: ChatSession = {
      id: "other-stored", storedSessionId: "stored-other", profileId, title: "Other",
      status: "ready", messages: [], remoteKind: "stored", connectionState: "ready", historyState: "loaded",
    };
    sessions.value = [...sessions.value, other];
    assert.equal(selectProfileChatModalSession("other-stored"), true);
    assert.deepEqual(profileChatModalPaneIds.value, ["other-stored"], "the click applies provisionally on screen");
    assert.deepEqual(savedProfileChatModalLayout(profileId)?.paneSessionIds, savedIds, "the saved layout survives provisional clicks");

    // Once the inventory is authoritative and every saved session is known,
    // the saved layout is restored and persisted, superseding provisional panes.
    sessions.value = [...sessions.value, storedSession("saved-b"), storedSession("saved-c")];
    setProfileChatModalSessionInventoryAuthoritative(true);
    assert.deepEqual(profileChatModalPaneIds.value, savedIds);
    assert.equal(profileChatModalActivePaneId.value, "saved-c");
    assert.deepEqual(savedProfileChatModalLayout(profileId)?.paneSessionIds, savedIds);
    assert.equal(sessions.value.some((session) => session.id === "other-stored"), true, "a persisted provisional pane session stays listed");
  } finally {
    closeProfileChatModal();
    saveProfileChatModalLayout(profileId, [], "");
    officeConnection.value = previousConnection;
    profileList.value = previousProfiles;
    sessions.value = previousSessions;
    profileChatModalId.value = previousModalId;
    profileChatModalPaneIds.value = previousPaneIds;
    profileChatModalActivePaneId.value = previousActivePaneId;
    setProfileChatModalSessionInventoryAuthoritative(true);
  }
});

test("profile modals restore their saved panes and create a chat when the saved layout is unavailable", () => {
  const previousConnection = officeConnection.value;
  const previousProfiles = profileList.value;
  const previousSessions = sessions.value;
  const previousOpenIds = openSessionIds.value;
  const previousActiveId = activeSessionId.value;
  const previousModalId = profileChatModalId.value;
  const previousModalPaneIds = profileChatModalPaneIds.value;
  const previousModalActivePaneId = profileChatModalActivePaneId.value;
  const profile = (id: string) => ({
    id, name: id, role: "", status: "idle" as const, color: "#087f70",
    sessions: 0, taskCount: 0, memoryBytes: 0, memoryNote: "", skills: [], inheritedSkills: [],
  });
  const session = (id: string, profileId: string): ChatSession => ({
    id,
    profileId,
    title: id,
    status: "ready",
    messages: [],
    remoteKind: "demo",
    connectionState: "ready",
    historyState: "loaded",
  });
  try {
    officeConnection.value = { ...previousConnection, state: "demo", source: "demo" };
    profileList.value = [profile("restore-profile"), profile("fresh-profile")];
    const restoredSessionIds = ["one", "two", "three", "four", "five", "six"];
    sessions.value = restoredSessionIds.map((id) => session(id, "restore-profile"));
    openSessionIds.value = [];
    activeSessionId.value = "";
    profileChatModalId.value = "restore-profile";
    setProfileChatModalPanes(restoredSessionIds);
    setProfileChatModalActivePane("one");
    closeProfileChatModal();

    openProfileChatModal("restore-profile");
    assert.deepEqual(profileChatModalPaneIds.value, restoredSessionIds);
    assert.equal(profileChatModalActivePaneId.value, "one");
    closeProfileChatModal();

    saveProfileChatModalLayout("fresh-profile", ["missing"], "missing");
    openProfileChatModal("fresh-profile");
    assert.equal(profileChatModalPaneIds.value.length, 1);
    const freshSessionId = profileChatModalPaneIds.value[0]!;
    assert.notEqual(freshSessionId, "missing");
    assert.equal(sessions.value.find((item) => item.id === freshSessionId)?.profileId, "fresh-profile");
    assert.deepEqual(savedProfileChatModalLayout("fresh-profile")?.paneSessionIds, [freshSessionId]);
  } finally {
    saveProfileChatModalLayout("restore-profile", [], "");
    saveProfileChatModalLayout("fresh-profile", [], "");
    officeConnection.value = previousConnection;
    profileList.value = previousProfiles;
    sessions.value = previousSessions;
    openSessionIds.value = previousOpenIds;
    activeSessionId.value = previousActiveId;
    profileChatModalId.value = previousModalId;
    profileChatModalPaneIds.value = previousModalPaneIds;
    profileChatModalActivePaneId.value = previousModalActivePaneId;
  }
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

test("modal drop replacement preserves the existing session-list behavior", () => {
  const localDraft: ChatSession = {
    id: "drop-draft", profileId: "profile", title: "", titlePresentation: "new-chat",
    status: "ready", messages: [], remoteKind: "draft", connectionState: "ready", historyState: "loaded",
  };
  const storedEmpty: ChatSession = {
    id: "drop-stored-empty", storedSessionId: "stored-empty", profileId: "profile", title: "", titlePresentation: "new-chat",
    status: "ready", messages: [], remoteKind: "stored", connectionState: "ready", historyState: "loaded",
  };
  const existing: ChatSession = {
    id: "drop-existing", storedSessionId: "stored-existing", profileId: "profile", title: "Existing",
    status: "ready", messages: [], remoteKind: "stored", connectionState: "ready", historyState: "loaded",
  };
  profileChatModalId.value = "profile";

  sessions.value = [localDraft, existing];
  setProfileChatModalPanes([localDraft.id]);
  assert.equal(replaceProfileChatModalPane(localDraft.id, existing.id), true);
  assert.deepEqual(profileChatModalPaneIds.value, [existing.id]);
  assert.equal(sessions.value.some((session) => session.id === localDraft.id), true, "drop replacement only changes pane placement");

  sessions.value = [storedEmpty, existing];
  setProfileChatModalPanes([storedEmpty.id]);
  assert.equal(replaceProfileChatModalPane(storedEmpty.id, existing.id), true);
  assert.deepEqual(profileChatModalPaneIds.value, [existing.id]);
  assert.equal(sessions.value.some((session) => session.id === storedEmpty.id), true, "a persisted empty conversation stays listed");
});

test("dashboard drop replacement preserves the existing session-list behavior", () => {
  const localDraft: ChatSession = {
    id: "dash-drop-draft", profileId: "profile", title: "", titlePresentation: "new-chat",
    status: "ready", messages: [], remoteKind: "draft", connectionState: "ready", historyState: "loaded",
  };
  const storedEmpty: ChatSession = {
    id: "dash-drop-stored-empty", storedSessionId: "stored-empty", profileId: "profile", title: "", titlePresentation: "new-chat",
    status: "ready", messages: [], remoteKind: "stored", connectionState: "ready", historyState: "loaded",
  };
  const existing: ChatSession = {
    id: "dash-drop-existing", storedSessionId: "stored-existing", profileId: "profile", title: "Existing",
    status: "ready", messages: [], remoteKind: "stored", connectionState: "ready", historyState: "loaded",
  };

  sessions.value = [localDraft, existing];
  openSessionIds.value = [localDraft.id];
  activeSessionId.value = localDraft.id;
  resetDashboardStateForTests({
    version: 1,
    activeDashboardId: "drop-dashboard",
    dashboards: [{ id: "drop-dashboard", name: "", panels: [{ id: "draft-pane", kind: "chat", sessionId: localDraft.id }] }],
  });
  assert.equal(replaceDashboardPanel("draft-pane", "chat", { sessionId: existing.id }), "replaced");
  assert.deepEqual(activeDashboard.value.panels.map((panel) => panel.sessionId), [existing.id]);
  assert.equal(sessions.value.some((session) => session.id === localDraft.id), true, "drop replacement only changes pane placement");

  sessions.value = [storedEmpty, existing];
  openSessionIds.value = [storedEmpty.id];
  activeSessionId.value = storedEmpty.id;
  resetDashboardStateForTests({
    version: 1,
    activeDashboardId: "drop-dashboard",
    dashboards: [{ id: "drop-dashboard", name: "", panels: [{ id: "stored-pane", kind: "chat", sessionId: storedEmpty.id }] }],
  });
  assert.equal(replaceDashboardPanel("stored-pane", "chat", { sessionId: existing.id }), "replaced");
  assert.deepEqual(activeDashboard.value.panels.map((panel) => panel.sessionId), [existing.id]);
  assert.equal(sessions.value.some((session) => session.id === storedEmpty.id), true, "a persisted empty conversation stays listed");
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

test("a hidden slash operation retains and reserves its live lease until the command settles", () => {
  const released: string[] = [];
  const slashSession: ChatSession = {
    id: "hidden-slash", storedSessionId: "stored-slash", liveSessionId: "live-slash",
    profileId: "slash-profile", title: "Slash", status: "ready", messages: [],
    operationEvidence: [{ id: "slash-op", kind: "prompt", body: "/status", at: "12:00", state: "pending" }],
    slashPending: true, remoteKind: "stored", connectionState: "ready", historyState: "loaded",
  };
  const visible = Array.from({ length: MAX_LIVE_CHAT_SESSIONS }, (_, index): ChatSession => ({
    id: `slash-visible-${index}`, storedSessionId: `stored-visible-${index}`,
    profileId: `visible-profile-${index}`, title: `Visible ${index}`, status: "ready", messages: [],
    remoteKind: "stored", connectionState: "ready", historyState: "loaded",
  }));
  sessions.value = [slashSession, ...visible];
  openSessionIds.value = [slashSession.id, ...visible.map((session) => session.id)];
  activeSessionId.value = slashSession.id;
  profileChatModalId.value = null;
  profileChatModalPaneIds.value = [];
  embeddedChatSessionIds.value = [];
  registerChatRuntime({
    ensureSession() {}, releaseSession(sessionId) { released.push(sessionId); },
    async submitPrompt() { return { status: "accepted" }; }, async steer() { return { status: "queued" }; }, interrupt() {},
    async respondClarify() {}, async respondApproval() {},
  });

  closeSession(slashSession.id);
  assert.deepEqual(released, []);
  assert.equal(getOpenChatTargets().length, MAX_LIVE_CHAT_SESSIONS - 1, "the hidden slash lease consumes one global slot");

  sessions.value = sessions.value.map((session) => session.id === slashSession.id ? {
    ...session,
    slashPending: false,
    operationEvidence: session.operationEvidence?.map((operation) => ({ ...operation, state: "accepted" as const })),
  } : session);
  assert.deepEqual(released, [slashSession.id]);
  assert.equal(getOpenChatTargets().length, MAX_LIVE_CHAT_SESSIONS);
});

test("an active pane displaces an older lease while a hidden run reserves profile capacity", () => {
  const ensured: string[] = [];
  const released: string[] = [];
  const workspaceSessions: ChatSession[] = Array.from(
    { length: MAX_LIVE_CHAT_SESSIONS_PER_PROFILE },
    (_, index): ChatSession => ({
      id: `workspace-${index + 1}`, storedSessionId: `stored-${index + 1}`, liveSessionId: `live-${index + 1}`,
      profileId: "profile", title: `Workspace ${index + 1}`, status: "ready", messages: [],
      remoteKind: "stored", connectionState: "ready", historyState: "loaded",
    }),
  );
  sessions.value = [
    {
      id: "background-run", storedSessionId: "stored-run", liveSessionId: "live-run", profileId: "profile", title: "Run",
      status: "streaming", streamingMessageId: "reply", messages: [{
        id: "reply", from: "agent", body: "working", at: "00:00", status: "streaming",
      }], remoteKind: "stored", connectionState: "ready", historyState: "loaded",
    },
    ...workspaceSessions,
    {
      id: "replacement", storedSessionId: "stored-replacement", profileId: "profile", title: "Replacement",
      status: "ready", messages: [], remoteKind: "stored", connectionState: "disconnected", historyState: "loaded",
    },
  ];
  openSessionIds.value = ["background-run", ...workspaceSessions.map((session) => session.id)];
  activeSessionId.value = "workspace-1";
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
  assert.equal(ensured.includes("replacement"), true, "the selected pane should receive a live lease");
  // One hidden streaming run reserves a profile slot. The replacement is
  // prioritized and one older visible lease is displaced at the real bound.
  const visibleWhileHidden = getOpenChatTargets().map((target) => target.clientSessionId);
  assert.equal(visibleWhileHidden[0], "replacement");
  assert.equal(visibleWhileHidden.length, MAX_LIVE_CHAT_SESSIONS_PER_PROFILE - 1);
  assert.equal(workspaceSessions.some((session) => released.includes(session.id)), true);

  sessions.value = sessions.value.map((item) => item.id === "background-run" ? {
    ...item,
    status: "ready" as const,
    streamingMessageId: undefined,
    messages: item.messages.map((message) => ({ ...message, status: "complete" as const })),
  } : item);
  assert.equal(released.includes("background-run"), true);
  assert.equal(getOpenChatTargets().length, MAX_LIVE_CHAT_SESSIONS_PER_PROFILE,
    "after the hidden run ends, visible panes reclaim the reserved profile slot");
});

test("modal panes take foreground lease priority within the per-profile live bound", () => {
  const ensured: string[] = [];
  const released: string[] = [];
  const workspaceSessions: ChatSession[] = Array.from(
    { length: MAX_LIVE_CHAT_SESSIONS_PER_PROFILE },
    (_, offset) => offset + 1,
  ).map((index) => ({
      id: `workspace-${index}`, storedSessionId: `stored-workspace-${index}`, profileId: "profile", title: `Workspace ${index}`,
      status: "ready", messages: [], remoteKind: "stored", connectionState: "ready", historyState: "loaded",
    }));
  sessions.value = [...workspaceSessions,
    {
      id: "modal", storedSessionId: "stored-modal", profileId: "profile", title: "Modal",
      status: "ready", messages: [], remoteKind: "stored", connectionState: "disconnected", historyState: "loaded",
    },
  ];
  openSessionIds.value = workspaceSessions.map((session) => session.id);
  activeSessionId.value = "workspace-1";
  profileChatModalId.value = "profile";
  profileChatModalPaneIds.value = [];
  registerChatRuntime({
    ensureSession(target) { ensured.push(target.clientSessionId); },
    releaseSession(sessionId) { released.push(sessionId); },
    async submitPrompt() { return { status: "accepted" }; }, async steer() { return { status: "queued" }; }, interrupt() {},
    async respondClarify() {}, async respondApproval() {},
  });

  assert.equal(addProfileChatModalPane("modal"), true);
  assert.deepEqual(getOpenChatTargets().map((target) => target.clientSessionId), [
    "modal", ...workspaceSessions.slice(0, -1).map((session) => session.id),
  ]);
  assert.deepEqual(released, [workspaceSessions.at(-1)!.id]);
  assert.equal(ensured.includes("modal"), true);

  closeProfileChatModal();
  assert.deepEqual(getOpenChatTargets().map((target) => target.clientSessionId), workspaceSessions.map((session) => session.id));
  assert.deepEqual(released, [workspaceSessions.at(-1)!.id, "modal"]);
  assert.equal(ensured.includes(workspaceSessions.at(-1)!.id), true);
});

test("embedded modal chats take a foreground lease without becoming workspace panes", () => {
  const ensured: string[] = [];
  const released: string[] = [];
  sessions.value = [
    ...Array.from({ length: MAX_LIVE_CHAT_SESSIONS_PER_PROFILE }, (_, index) => index + 1).map((index): ChatSession => ({
      id: `workspace-${index}`, storedSessionId: `stored-${index}`, profileId: "profile", title: "Workspace",
      status: "ready", messages: [], remoteKind: "stored", connectionState: "ready", historyState: "loaded",
    })),
    {
      id: "embedded", storedSessionId: "stored-embedded", profileId: "profile", title: "Embedded",
      status: "ready", messages: [], remoteKind: "stored", connectionState: "disconnected", historyState: "loaded",
    },
  ];
  const workspaceIds = sessions.value.filter((session) => session.id.startsWith("workspace-")).map((session) => session.id);
  openSessionIds.value = workspaceIds;
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
  assert.deepEqual(openSessionIds.value, workspaceIds, "embedded presentation does not mutate workspace pane membership");
  assert.deepEqual(getOpenChatTargets().map((target) => target.clientSessionId), ["embedded", ...workspaceIds.slice(0, -1)]);
  assert.deepEqual(released, [workspaceIds.at(-1)!]);

  closeEmbeddedChatSession("embedded");
  assert.deepEqual(getOpenChatTargets().map((target) => target.clientSessionId), workspaceIds);
  assert.deepEqual(released, [workspaceIds.at(-1)!, "embedded"]);
  assert.equal(ensured.includes("embedded"), true);
  assert.equal(ensured.includes(workspaceIds.at(-1)!), true);
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
