/**
 * Bridges dashboard panel state with the chat/session store.
 *
 * Design: the store's `openSessionIds` remains the source of truth for which
 * chat sessions are live (connection lifecycle, eviction, mobile routes all
 * already hang off it). The active dashboard mirrors it: every open session
 * gets a chat panel, and switching dashboards rewrites `openSessionIds` to
 * match the target dashboard's chat panels. dashboard-layout.ts stays pure
 * and never imports store.ts.
 */
import { effect, untracked } from "@preact/signals";
import { officeInventoryReliability } from "@hermes-studio/protocol";
import type { ChatSession, OfficeConnection, OfficeInventoryPagination, OfficeSnapshotRequestIdentity } from "./domain";
import { inventorySnapshotIdentity, sessionInventoryComplete, sessionInventoryState } from "./inventory";
import { latestOfficeSnapshotIdentity } from "./store-state";
import {
  activeDashboard,
  addPanelToActiveDashboard,
  createDashboard,
  dashboardContainingPanel,
  deleteDashboard,
  initialDashboardNeedsDefaultChat,
  MAX_DASHBOARD_PANELS,
  movePanel,
  newPanelId,
  persistDashboards,
  reconcileChatPanels,
  replacePanelInActiveDashboard,
  replaceDashboardPanels,
  removePanel,
  setActiveDashboardChatPanel,
  switchDashboard,
  dashboards,
  activeDashboardId,
  type AddPanelResult,
  type DashboardPanelKind,
  type ReplacePanelResult,
} from "./dashboard-layout";
import { officeWindowOpen, setOfficeWindowOpen } from "./office-window";
import {
  isDiscardableUnusedChatDraft,
  isReplaceableInitialChatSession,
} from "./chat-session-retention";
import {
  activeSessionId,
  closeSession,
  createSession,
  dismissSessions,
  officeConnection,
  openSession,
  openSessionIds,
  profileList,
  sessions,
} from "./store";

/** Guard so dashboard-initiated session changes do not re-enter the mirror effect. */
let switching = false;
const pendingDefaultChatDashboardIds = new Set<string>();

export function dashboardChatMirrorSuspended(
  connection: Pick<OfficeConnection, "source" | "state" | "runtime">,
  sessionCount: number,
): boolean {
  return sessionCount === 0 && connection.source === "server"
    && (connection.state === "connecting" || connection.state === "error" || connection.runtime !== "ready");
}

export function dashboardSessionInventoryAuthoritative(
  connection: Pick<OfficeConnection, "source" | "state" | "runtime">,
  inventory: (OfficeInventoryPagination & { loading?: boolean; error?: unknown }) | undefined,
  identityMatches = true,
): boolean {
  if (connection.source === "demo" && connection.state === "demo") return true;
  if (connection.source !== "server" || connection.state !== "connected" || connection.runtime !== "ready"
    || !inventory || !identityMatches || inventory.loading === true || inventory.error !== undefined) {
    return false;
  }
  return officeInventoryReliability(inventory) === "complete" && !inventory.hasMore;
}

function currentSessionInventoryIsAuthoritative(connection: Pick<OfficeConnection, "source" | "state" | "runtime">): boolean {
  return dashboardSessionInventoryAuthoritative(
    connection,
    sessionInventoryState.value,
    sessionInventoryComplete.value
      && snapshotIdentitiesMatch(inventorySnapshotIdentity.value, latestOfficeSnapshotIdentity),
  );
}

function snapshotIdentitiesMatch(
  inventory: OfficeSnapshotRequestIdentity | undefined,
  latest: OfficeSnapshotRequestIdentity | undefined,
): boolean {
  if (inventory === undefined) return false;
  // Legacy/string snapshot callers do not publish a latest identity; their
  // synthetic generation is still paired atomically by initializeInventory.
  if (latest === undefined) return inventory.connectionGeneration === 0;
  return inventory.serverUrl === latest.serverUrl
    && inventory.connectionGeneration === latest.connectionGeneration
    && inventory.requestGeneration === latest.requestGeneration;
}

/** Mirror `openSessionIds` into the active dashboard's chat panels. */
function mirrorOpenSessionsIntoActiveDashboard(): void {
  const open = openSessionIds.value;
  const dashboard = activeDashboard.value;
  const chatPanels = dashboard.panels.filter((panel) => panel.kind === "chat");
  const stale = chatPanels.filter((panel) => panel.sessionId === undefined || !open.includes(panel.sessionId));
  const missing = open.filter((sessionId) => !chatPanels.some((panel) => panel.sessionId === sessionId));
  if (stale.length === 0 && missing.length === 0) return;
  const panels = dashboard.panels.filter((panel) => !stale.includes(panel));
  const overflow: string[] = [];
  for (const sessionId of missing) {
    if (panels.length >= MAX_DASHBOARD_PANELS) {
      overflow.push(sessionId);
      continue;
    }
    panels.push({ id: newPanelId(), kind: "chat", sessionId });
  }
  dashboards.value = dashboards.value.map((item) =>
    item.id === dashboard.id ? replaceDashboardPanels(item, panels) : item);
  persistDashboards();
  if (overflow.length > 0) {
    // The dashboard is full: sessions that cannot get a panel are closed so
    // the store and the visible layout never diverge.
    switching = true;
    try {
      for (const sessionId of overflow) closeSession(sessionId);
    } finally {
      switching = false;
    }
  }
}

/** Add a panel to the active dashboard, wiring session and studio side effects. */
export function addDashboardPanel(kind: DashboardPanelKind, options?: { sessionId?: string; index?: number }): AddPanelResult {
  if (kind === "chat") {
    const sessionId = options?.sessionId;
    if (!sessionId || !sessions.value.some((session) => session.id === sessionId)) return "full";
    const already = activeDashboard.value.panels.some((panel) => panel.kind === "chat" && panel.sessionId === sessionId);
    if (!already && activeDashboard.value.panels.length >= MAX_DASHBOARD_PANELS) return "full";
    // openSession handles connection + eviction; the mirror effect adds the panel.
    openSession(sessionId, { workspace: true, ...(typeof options?.index === "number" ? { index: options.index } : {}) });
    mirrorOpenSessionsIntoActiveDashboard();
    const panel = activeDashboard.value.panels.find((item) => item.kind === "chat" && item.sessionId === sessionId);
    if (panel) setActiveDashboardChatPanel(panel.id);
    if (typeof options?.index === "number") {
      if (panel) movePanel(panel.id, options.index);
    }
    return already ? "focused" : "added";
  }
  const result = addPanelToActiveDashboard(kind, options);
  if ((result === "added" || result === "focused") && kind === "studio") setOfficeWindowOpen(true);
  return result;
}

/** Seed the active empty dashboard with a removable draft chat for `default`. */
function addDefaultChatToActiveDashboard(): boolean {
  if (activeDashboard.value.panels.length > 0) return false;
  const defaultProfile = profileList.value.find((profile) => profile.id === "default");
  if (!defaultProfile) return false;
  const sessionId = createSession(defaultProfile.id);
  if (!sessionId) return false;
  mirrorOpenSessionsIntoActiveDashboard();
  activeSessionId.value = sessionId;
  return true;
}

/** Create, activate, and initialize a dashboard with a default-profile chat. */
export function createDashboardWithDefaultChat(name = ""): string | undefined {
  const dashboardId = createDashboard(name);
  if (!dashboardId) return undefined;
  pendingDefaultChatDashboardIds.add(dashboardId);
  activateDashboard(dashboardId);
  initializeDefaultDashboardChat();
  return dashboardId;
}

/** Open the dashboard that already contains the requested pane. Never adds one. */
export function activateDashboardContainingPanel(
  kind: DashboardPanelKind,
  options?: { sessionId?: string },
): boolean {
  const dashboard = dashboardContainingPanel(kind, options);
  if (!dashboard) return false;
  activateDashboard(dashboard.id);
  if (kind === "chat" && options?.sessionId) {
    const panel = activeDashboard.value.panels.find((item) =>
      item.kind === "chat" && item.sessionId === options.sessionId,
    );
    if (panel) setActiveDashboardChatPanel(panel.id);
    openSession(options.sessionId, { workspace: true });
    activeSessionId.value = options.sessionId;
  }
  return true;
}

export type DashboardChatClickResult = AddPanelResult | ReplacePanelResult | "missing";

function replaceableInitialChatPanel(): { panelId: string; sessionId: string } | undefined {
  const candidates = activeDashboard.value.panels.flatMap((panel) => {
    if (panel.kind !== "chat" || panel.sessionId === undefined) return [];
    const session = sessions.value.find((item) => item.id === panel.sessionId);
    return isReplaceableInitialChatSession(session)
      ? [{ panelId: panel.id, sessionId: panel.sessionId }]
      : [];
  });
  return candidates.find((candidate) => candidate.panelId === activeDashboard.value.activeChatPanelId)
    ?? candidates.at(-1);
}

/**
 * Sidebar click contract for an existing conversation:
 * - focus the pane if any dashboard already presents the conversation;
 * - only a conversation visible nowhere may replace a blank initial pane;
 * - otherwise replace the sole or last-active chat pane without adding one;
 * - if no dashboard has a chat pane, create a dashboard for the conversation.
 */
export function selectDashboardChatSession(sessionId: string): DashboardChatClickResult {
  if (!sessions.value.some((session) => session.id === sessionId)) return "missing";

  // An already-visible conversation always wins, even when another pane is an
  // unused startup composer. Clicking a visible conversation must only focus
  // it; it must never move that pane or collapse the layout as a side effect.
  const activeExisting = activeDashboard.value.panels.find((panel) =>
    panel.kind === "chat" && panel.sessionId === sessionId,
  );
  if (activeExisting) {
    setActiveDashboardChatPanel(activeExisting.id);
    openSession(sessionId, { workspace: true });
    activeSessionId.value = sessionId;
    return "focused";
  }

  const existingDashboard = dashboardContainingPanel("chat", { sessionId });
  if (existingDashboard) {
    activateDashboard(existingDashboard.id);
    const existing = activeDashboard.value.panels.find((panel) =>
      panel.kind === "chat" && panel.sessionId === sessionId,
    );
    if (existing) setActiveDashboardChatPanel(existing.id);
    openSession(sessionId, { workspace: true });
    activeSessionId.value = sessionId;
    return "focused";
  }

  // A blank startup composer is a placeholder, not another conversation the
  // user chose to keep, but only a conversation visible nowhere may claim it:
  // a conversation already shown on another dashboard was focused above.
  // The sidebar-specific replacement dismisses the placeholder when it is a
  // purely local unpersisted draft.
  const initial = replaceableInitialChatPanel();
  if (initial && initial.sessionId !== sessionId) {
    return replaceDashboardChatPanelFromSidebar(initial.panelId, sessionId);
  }

  const activeWithChat = activeDashboard.value.panels.some((panel) => panel.kind === "chat")
    ? activeDashboard.value
    : undefined;
  const dashboardWithChat = activeWithChat
    ?? dashboards.value.find((dashboard) => dashboard.panels.some((panel) => panel.kind === "chat"));

  if (!dashboardWithChat) {
    const dashboardId = createDashboard();
    if (!dashboardId) return "full";
    const panelId = newPanelId();
    dashboards.value = dashboards.value.map((dashboard) =>
      dashboard.id === dashboardId
        ? replaceDashboardPanels(dashboard, [{ id: panelId, kind: "chat", sessionId }])
        : dashboard,
    );
    persistDashboards();
    activateDashboard(dashboardId);
    setActiveDashboardChatPanel(panelId);
    return "added";
  }

  activateDashboard(dashboardWithChat.id);
  const chatPanels = activeDashboard.value.panels.filter((panel) =>
    panel.kind === "chat" && panel.sessionId !== undefined,
  );
  const lastActive = chatPanels.find((panel) => panel.id === activeDashboard.value.activeChatPanelId);
  const target = chatPanels.length === 1 ? chatPanels[0] : lastActive ?? chatPanels.at(-1);
  if (!target) return "missing";
  return replaceDashboardChatPanelFromSidebar(target.id, sessionId);
}

/**
 * Sidebar clicks may discard the unused local composer they replace. Keep this
 * cleanup out of the shared replace primitive so drag-and-drop remains a pure
 * pane-layout operation.
 */
function replaceDashboardChatPanelFromSidebar(
  panelId: string,
  sessionId: string,
): ReplacePanelResult {
  const replacedPanel = activeDashboard.value.panels.find((panel) => panel.id === panelId);
  const replacedSession = replacedPanel?.kind === "chat" && replacedPanel.sessionId !== undefined
    ? sessions.value.find((session) => session.id === replacedPanel.sessionId)
    : undefined;
  const result = replaceDashboardPanel(panelId, "chat", { sessionId });
  if (replacedSession && result === "replaced" && isDiscardableUnusedChatDraft(replacedSession)) {
    dismissSessions([replacedSession.id]);
  }
  return result;
}

/** Replace a registered pane and keep chat/Studio side effects synchronized. */
export function replaceDashboardPanel(
  panelId: string,
  kind: DashboardPanelKind,
  options?: { sessionId?: string },
): ReplacePanelResult {
  if (kind === "chat") {
    const sessionId = options?.sessionId;
    if (!sessionId || !sessions.value.some((session) => session.id === sessionId)) return "missing";
  }
  let result: ReplacePanelResult;
  switching = true;
  try {
    result = replacePanelInActiveDashboard(panelId, kind, options);
    if (result !== "replaced") return result;
    const wanted = activeDashboard.value.panels
      .filter((panel) => panel.kind === "chat" && panel.sessionId !== undefined
        && sessions.value.some((session) => session.id === panel.sessionId))
      .map((panel) => panel.sessionId!);
    for (const id of openSessionIds.value.filter((sessionId) => !wanted.includes(sessionId))) closeSession(id);
    for (const id of wanted) openSession(id, { workspace: true });
  } finally {
    switching = false;
  }
  setOfficeWindowOpen(activeDashboard.value.panels.some((panel) => panel.kind === "studio"));
  mirrorOpenSessionsIntoActiveDashboard();
  if (kind === "chat" && options?.sessionId) {
    setActiveDashboardChatPanel(panelId);
    activeSessionId.value = options.sessionId;
  }
  else if (!openSessionIds.value.includes(activeSessionId.value)) activeSessionId.value = openSessionIds.value.at(-1) ?? "";
  return result;
}

/** Close one panel; chat panels release their session via the store. */
export function closeDashboardPanel(panelId: string): void {
  const panel = activeDashboard.value.panels.find((item) => item.id === panelId);
  if (!panel) return;
  if (panel.kind === "chat" && panel.sessionId) {
    // closeSession updates openSessionIds; the mirror effect removes the panel.
    closeSession(panel.sessionId);
    mirrorOpenSessionsIntoActiveDashboard();
    return;
  }
  const removed = removePanel(panelId);
  if (!removed) return;
  if (removed.kind === "studio") setOfficeWindowOpen(false);
}

/** Switch dashboards, rewriting the open-session list to match the target. */
export function activateDashboard(dashboardId: string): void {
  const currentActivePanel = activeDashboard.value.panels.find((panel) =>
    panel.kind === "chat" && panel.sessionId === activeSessionId.value,
  );
  if (currentActivePanel) setActiveDashboardChatPanel(currentActivePanel.id);
  const target = dashboards.value.find((dashboard) => dashboard.id === dashboardId);
  if (!target) return;
  if (target.defaultChatSeeded !== true) pendingDefaultChatDashboardIds.add(dashboardId);
  if (dashboardId === activeDashboardId.value) {
    initializeDefaultDashboardChat();
    return;
  }
  const wanted = target.panels
    .filter((panel) => panel.kind === "chat" && panel.sessionId !== undefined
      && sessions.value.some((session) => session.id === panel.sessionId))
    .map((panel) => panel.sessionId!);
  switching = true;
  try {
    for (const id of openSessionIds.value.filter((sessionId) => !wanted.includes(sessionId))) closeSession(id);
    for (const id of wanted) openSession(id, { workspace: true });
  } finally {
    switching = false;
  }
  switchDashboard(dashboardId);
  if (target.panels.some((panel) => panel.kind === "studio")) setOfficeWindowOpen(true);
  mirrorOpenSessionsIntoActiveDashboard();
  const preferred = target.panels.find((panel) =>
    panel.id === target.activeChatPanelId && panel.kind === "chat" && panel.sessionId !== undefined,
  )?.sessionId;
  activeSessionId.value = preferred ?? wanted.at(-1) ?? "";
  initializeDefaultDashboardChat();
}

/** Delete a dashboard without bypassing the live chat-session handoff. */
export function deleteDashboardWithActivation(dashboardId: string): void {
  const target = dashboards.value.find((dashboard) => dashboard.id === dashboardId);
  if (!target) return;
  pendingDefaultChatDashboardIds.delete(dashboardId);
  if (dashboardId !== activeDashboardId.value) {
    deleteDashboard(dashboardId);
    return;
  }
  const fallback = dashboards.value.find((dashboard) => dashboard.id !== dashboardId);
  if (!fallback) {
    switching = true;
    try {
      for (const panel of target.panels) {
        if (panel.kind === "chat" && panel.sessionId) closeSession(panel.sessionId);
      }
    } finally {
      switching = false;
    }
    setOfficeWindowOpen(false);
    deleteDashboard(dashboardId);
    pendingDefaultChatDashboardIds.add(activeDashboardId.value);
    initializeDefaultDashboardChat();
    return;
  }
  // Switch while the source dashboard still exists so activateDashboard can
  // close its sessions and restore the destination's sessions transactionally.
  activateDashboard(fallback.id);
  deleteDashboard(dashboardId);
}

let wiringInstalled = false;
let hadStudioPanel = false;
/** Chat panels restore only after the session list first loads. */
let restoredPersistedChats = false;

/** Seed a newly created empty dashboard after the chat runtime is available. */
export function initializeDefaultDashboardChat(): boolean {
  const dashboardId = activeDashboardId.value;
  if (activeDashboard.value.defaultChatSeeded === true) {
    pendingDefaultChatDashboardIds.delete(dashboardId);
    return false;
  }
  if (!pendingDefaultChatDashboardIds.has(dashboardId)) return false;
  if (activeDashboard.value.panels.length > 0) {
    pendingDefaultChatDashboardIds.delete(dashboardId);
    return false;
  }
  const added = addDefaultChatToActiveDashboard();
  if (added) pendingDefaultChatDashboardIds.delete(dashboardId);
  return added;
}

/** Install reactive wiring. Called once from app bootstrap; safe to re-call. */
export function installDashboardWiring(): () => void {
  if (wiringInstalled) return () => {};
  wiringInstalled = true;
  hadStudioPanel = activeDashboard.value.panels.some((panel) => panel.kind === "studio");
  if (initialDashboardNeedsDefaultChat) pendingDefaultChatDashboardIds.add(activeDashboardId.value);

  // Reopen the active dashboard's persisted chat sessions whenever inventory
  // returns after startup or a runtime interruption. Stored-session client ids
  // are stable (`stored:<profile>:<id>`), so panels survive reconnects.
  const disposeRestore = effect(() => {
    const list = sessions.value;
    const authoritative = currentSessionInventoryIsAuthoritative(officeConnection.value);
    if (switching) return;
    if (list.length === 0 && !authoritative) return;
    restoredPersistedChats = true;
    const dashboard = activeDashboard.value;
    const wanted = dashboard.panels
      .filter((panel) => panel.kind === "chat" && panel.sessionId !== undefined
        && list.some((session) => session.id === panel.sessionId))
      .map((panel) => panel.sessionId!);
    const preferred = dashboard.panels.find((panel) =>
      panel.id === dashboard.activeChatPanelId && panel.kind === "chat",
    )?.sessionId;
    // openSession reads and writes active-target signals. Those are restoration
    // side effects, not dependencies of this effect; tracking them causes a
    // multi-pane restore to reactivate every pane forever.
    untracked(() => {
      switching = true;
      try {
        const alreadyOpen = new Set(openSessionIds.value);
        // Restore in persisted panel order. Focus the preferred pane in a
        // separate idempotent call so active selection cannot reorder panes.
        for (const id of wanted) {
          if (alreadyOpen.has(id)) continue;
          openSession(id, { workspace: true });
          alreadyOpen.add(id);
        }
        if (preferred && alreadyOpen.has(preferred)) openSession(preferred, { workspace: true });
      } finally {
        switching = false;
      }
      mirrorOpenSessionsIntoActiveDashboard();
    });
  });

  // Mirror the store's open sessions into the active dashboard (new chats,
  // closes, evictions, demo bootstrap all flow through openSessionIds).
  const disposeMirror = effect(() => {
    void openSessionIds.value;
    const list = sessions.value;
    const connection = officeConnection.value;
    const authoritative = currentSessionInventoryIsAuthoritative(connection);
    if (switching) return;
    // Before restore, an empty open list must not wipe persisted chat panels.
    if (!restoredPersistedChats && openSessionIds.value.length === 0) return;
    // A cleared inventory during connection/runtime failure means suspended,
    // not user-closed. Keep persisted panels so the restore effect can reopen
    // them when the next reliable snapshot arrives.
    if (dashboardChatMirrorSuspended(connection, list.length)) return;
    if (list.length === 0 && !authoritative) return;
    mirrorOpenSessionsIntoActiveDashboard();
  });

  // Drop chat panels (on any dashboard) whose sessions were deleted.
  const disposeReconcile = effect(() => {
    const list = sessions.value;
    if (!currentSessionInventoryIsAuthoritative(officeConnection.value)) return;
    reconcileChatPanels(new Set(list.map((session) => session.id)));
  });

  // OfficeScene's own close button clears officeWindowOpen; mirror that to the panel.
  const disposeOffice = effect(() => {
    const open = officeWindowOpen.value;
    const panel = activeDashboard.value.panels.find((item) => item.kind === "studio");
    if (!open && panel && hadStudioPanel) removePanel(panel.id);
    hadStudioPanel = activeDashboard.value.panels.some((item) => item.kind === "studio");
  });

  return () => {
    disposeRestore();
    disposeMirror();
    disposeReconcile();
    disposeOffice();
    wiringInstalled = false;
  };
}
