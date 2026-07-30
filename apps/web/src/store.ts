import { effect } from "@preact/signals";
import { officeInventoryReliability } from "@hermes-studio/protocol";
import { initialSessions, initialTaskComments, initialTasks, initialTeams, profiles } from "./demo-data";
import { createDemoKanbanApi } from "./demo-kanban-api";
import { loadTeamsDemoRuntime, resetTeamsRuntimeState } from "./teams-store";
import type { ChatTarget } from "./chat-api";
import type { OfficeSnapshot, OfficeSnapshotRequestIdentity, Profile, SettingsTab, Surface } from "./domain";
import type { DeviceLoginFailure } from "./auth-state";
import { loadKanbanDemoRuntime, registerKanbanProfileTaskUpdater, resetKanbanRuntimeState } from "./kanban-store";
import { prefetchSelectedProfileSettings } from "./settings-prefetch";
import { findStoredSession, storedSessionClientId } from "./session-identity";
import { isScheduledSessionHidden } from "./scheduled-sessions";
import { deleteStoredSessions } from "./sessions-api";
import { runSessionDeletionBatch, type SessionDeletionProgress } from "./session-deletion";
import { isChatRunActive, mergeServerSessionStatus } from "./session-runtime";
import { reconcileChatSessionDisconnected } from "./chat-session-reconciliation";
import { reconcileDefaultAvatarProfiles, registerDefaultAvatarProfiles } from "./avatar-preferences";
import { ensurePokemonDisplayNames } from "./profile-names";
import { resolvedCreateModelPrefs } from "./chat-model-prefs";
import { setOfficeWindowOpen } from "./office-window";
import { officeMessage, officeRuntimeMessage } from "./i18n";
import {
  buildCardAskSeedPrompt,
  cardAskSeedInputFromTask,
  findCardAskSession,
} from "./kanban-ask";
import {
  clearMobileRoutes,
  noteMobileWorkspaceClosed,
  openMobileWorkspace,
} from "./mobile-routes";
import {
  MAX_LIVE_CHAT_SESSIONS,
  MAX_LIVE_CHAT_SESSIONS_PER_PROFILE,
  activeSessionId,
  activeSurface,
  chatSocketState,
  embeddedChatSessionIds,
  inspectorTab,
  latestOfficeSnapshotIdentity,
  officeAccess,
  officeConnection,
  officeRuntimeHooks,
  officeSnapshot,
  openSessionIds,
  workspaceSessionDropPreview,
  workspaceSessionDropPlacement,
  profileList,
  profileSettingsModalId,
  profileSettingsModalTab,
  settingsModalOpen,
  profileChatModalId,
  profileChatModalPaneIds,
  profileChatModalActivePaneId,
  runtimeDataSource,
  selectedProfile,
  selectedProfileId,
  selectedProfileSessions,
  sessions,
  settingsTab,
  setLatestOfficeSnapshotIdentity,
  setRuntimeDataSource,
} from "./store-state";
import { persistUiNavPreferences } from "./ui-nav-prefs";
import { addPanelToActiveDashboard, removePanel, activeDashboard } from "./dashboard-layout";
import { clearAllChatComposerStates, clearChatComposerState } from "./chat-composer-state";
import {
  saveProfileChatModalLayout,
  savedProfileChatModalLayout,
  type ProfileChatModalLayout,
} from "./profile-chat-modal-prefs";

export {
  MAX_LIVE_CHAT_SESSIONS,
  MAX_LIVE_CHAT_SESSIONS_PER_PROFILE,
  activeSessionId,
  activeSurface,
  chatSocketState,
  embeddedChatSessionIds,
  inspectorTab,
  mobileInspectorOpen,
  mobileWorkspaceOpen,
  workspaceSessionDropPreview,
  workspaceSessionDropPlacement,
  officeAccess,
  officeConnection,
  officeSnapshot,
  openSessionIds,
  profileList,
  profileSettingsModalId,
  profileSettingsModalTab,
  settingsModalOpen,
  profileChatModalId,
  profileChatModalPaneIds,
  profileChatModalActivePaneId,
  selectedProfile,
  selectedProfileId,
  selectedProfileSessions,
  sessions,
  settingsTab,
} from "./store-state";

export {
  clearMobileRoutes,
  closeMobileRoute,
  installMobileRouteHistory,
  openMobileInspector,
  openMobileWorkspace,
} from "./mobile-routes";

export { addTaskComment, assignTask, clearFocusedKanbanTask, createTask, expandedTaskId, focusKanbanTask, focusedKanbanTaskId, kanbanAssignees, kanbanState, moveTask, refreshKanbanBoard, registerKanbanRuntime, retryTaskComments, taskCommentDetail, tasks, toggleTaskComments } from "./kanban-store";
import {
  applyChatGatewayEvent,
  applyChatHistory,
  applySessionModelPrefs,
  stageSessionModelChange,
  cancelSessionModelChange,
  clearFollowUpSuggestions,
  interruptSession,
  reconcilePromptOperationsWithHistory,
  reconnectChatSession,
  reduceChatGatewayEvent,
  refreshFollowUpSuggestions,
  respondToApproval,
  respondToClarification,
  sendMessage as sendChatMessage,
  setChatHistoryError,
  setChatHistoryLoading,
  setChatSessionConnecting,
  setChatSessionDisconnected,
  setChatSessionError,
  setChatSessionQueued,
  setChatSessionReady,
  setChatSocketState,
  steerSession,
  tryFlushCardSeed,
  pendingCardSeedForPrompt,
  consumeCardSeed,
  consumeChatComposerPrefill,
} from "./store-chat";

export {
  applyChatGatewayEvent,
  applyChatHistory,
  applySessionModelPrefs,
  stageSessionModelChange,
  cancelSessionModelChange,
  clearFollowUpSuggestions,
  interruptSession,
  reconcilePromptOperationsWithHistory,
  reconnectChatSession,
  reduceChatGatewayEvent,
  refreshFollowUpSuggestions,
  respondToApproval,
  respondToClarification,
  setChatHistoryError,
  setChatHistoryLoading,
  setChatSessionConnecting,
  setChatSessionDisconnected,
  setChatSessionError,
  setChatSessionQueued,
  setChatSessionReady,
  setChatSocketState,
  steerSession,
  tryFlushCardSeed,
  pendingCardSeedForPrompt,
  consumeCardSeed,
  consumeChatComposerPrefill,
};

export function sendMessage(sessionId: string, body: string): ReturnType<typeof sendChatMessage> {
  const pending = pendingProfileChatModalLayout;
  if (pending?.profileId === profileChatModalId.value
    && profileChatModalPaneIds.value.includes(sessionId)
    && !pending.paneSessionIds.includes(sessionId)) {
    // Sending from the temporary composer is an explicit choice to replace the
    // unavailable saved layout. Preserve that choice before the prompt starts.
    pendingProfileChatModalLayout = undefined;
    persistCurrentProfileChatModalLayout();
  }
  return sendChatMessage(sessionId, body);
}

registerKanbanProfileTaskUpdater((counts) => {
  profileList.value = profileList.value.map((profile) => ({ ...profile, taskCount: counts.get(profile.id) ?? 0 }));
});

/**
 * Legacy navigation shim. Surfaces no longer exist as exclusive views;
 * navigating to one now adds (or focuses) the matching panel on the active
 * dashboard. Settings still opens as the header modal.
 */
export function navigateToSurface(surface: Surface): void {
  if (surface === "settings" || surface === "library") {
    clearMobileRoutes();
    openSettingsModal(surface === "library" ? "global" : settingsTab.value);
    return;
  }
  const kind = surface === "office" ? "studio"
    : surface === "kanban" ? "kanban"
    : surface === "teams" ? "teams"
    : "scheduled";
  addPanelToActiveDashboard(kind);
  activeSurface.value = surface;
  settingsModalOpen.value = false;
  if (surface === "office") setOfficeWindowOpen(true);
  clearMobileRoutes();
  persistNavigationState();
}

function persistNavigationState(): void {
  persistUiNavPreferences({
    surface: activeSurface.value,
    settingsTab: settingsTab.value,
    selectedProfileId: selectedProfileId.value,
  });
}

export function registerChatRuntime(actions: {
  ensureSession(target: ChatTarget): void;
  releaseSession(clientSessionId: string): void;
  submitPrompt(clientSessionId: string, text: string, operationId: string): Promise<import("./chat-api").ChatPromptResult> | void;
  steer(clientSessionId: string, text: string): Promise<import("./chat-api").ChatSteerResult>;
  execSlash?(clientSessionId: string, command: string, confirmExpensiveModel?: boolean): Promise<import("./chat-api").ChatSlashResult>;
  completeSlash?(text: string): Promise<import("./chat-api").SlashCompletionItem[]>;
  interrupt(clientSessionId: string): Promise<void> | void;
  respondClarify(clientSessionId: string, requestId: string, answer: string): Promise<void>;
  respondApproval(clientSessionId: string, approvalId: string, choice: import("./domain").ApprovalChoice): Promise<void>;
}): void {
  officeRuntimeHooks.ensureChatSession = actions.ensureSession;
  officeRuntimeHooks.releaseChatSession = actions.releaseSession;
  officeRuntimeHooks.submitChatPrompt = actions.submitPrompt;
  officeRuntimeHooks.steerChatSession = actions.steer;
  officeRuntimeHooks.execSlashCommand = actions.execSlash
    ?? (async () => { throw new Error("Chat runtime does not support slash commands."); });
  officeRuntimeHooks.completeSlashCommand = actions.completeSlash ?? (async () => []);
  officeRuntimeHooks.interruptChatSession = actions.interrupt;
  officeRuntimeHooks.respondClarify = actions.respondClarify;
  officeRuntimeHooks.respondApproval = actions.respondApproval;
  for (const target of getOpenChatTargets()) officeRuntimeHooks.ensureChatSession(target);
}

// A hidden session can keep its Hermes lease while a run finishes. Those
// leases still count against the server's per-owner cap even though they are
// intentionally absent from the visible target list.
const deferredChatTargetReleases = new Set<string>();
let profileChatModalSessionInventoryAuthoritative = false;
let pendingProfileChatModalLayout: ProfileChatModalLayout | undefined;

export function getOpenChatTargets(): ChatTarget[] {
  // Pane visibility is unbounded. Live Hermes leases stay within the server's
  // operational bounds, prioritizing the panes the user most recently chose.
  const modalIds = profileChatModalPaneIds.value;
  const workspaceIds = openSessionIds.value;
  const requestedSessionIds = [...new Set([
    ...(modalIds.includes(profileChatModalActivePaneId.value) ? [profileChatModalActivePaneId.value] : []),
    ...modalIds,
    ...embeddedChatSessionIds.value,
    ...(workspaceIds.includes(activeSessionId.value) ? [activeSessionId.value] : []),
    ...workspaceIds,
  ])];
  const requested = new Set(requestedSessionIds);
  const hiddenReservedSessions = [...deferredChatTargetReleases].flatMap((sessionId) => {
    if (requested.has(sessionId)) return [];
    const session = sessions.value.find((item) => item.id === sessionId);
    return session !== undefined && isChatRunActive(session) ? [session] : [];
  });
  const visibleCapacity = Math.max(0, MAX_LIVE_CHAT_SESSIONS - hiddenReservedSessions.length);
  const profileLeaseCounts = new Map<string, number>();
  for (const session of hiddenReservedSessions) {
    profileLeaseCounts.set(session.profileId, (profileLeaseCounts.get(session.profileId) ?? 0) + 1);
  }
  const activeSessionIds: string[] = [];
  for (const sessionId of requestedSessionIds) {
    if (activeSessionIds.length >= visibleCapacity) break;
    const session = sessions.value.find((item) => item.id === sessionId);
    if (!session) continue;
    const profileLeaseCount = profileLeaseCounts.get(session.profileId) ?? 0;
    if (profileLeaseCount >= MAX_LIVE_CHAT_SESSIONS_PER_PROFILE) continue;
    profileLeaseCounts.set(session.profileId, profileLeaseCount + 1);
    activeSessionIds.push(sessionId);
  }
  return [...new Set(activeSessionIds)].flatMap((clientSessionId) => {
    const session = sessions.value.find((item) => item.id === clientSessionId);
    const target = session === undefined ? undefined : chatTarget(session);
    return target === undefined ? [] : [target];
  });
}

export function registerOfficeRetry(action: () => void): void {
  officeRuntimeHooks.retryOfficeConnection = action;
}

export function retryOfficeServer(): void {
  officeAccess.value = { ...officeAccess.value, state: "checking", message: officeMessage("runtime.office.reconnecting") };
  officeRuntimeHooks.retryOfficeConnection();
}

export function requireDeviceLogin(serverUrl: string): void {
  officeAccess.value = {
    state: "login-required",
    serverUrl,
    message: officeMessage("runtime.auth.loginRequired")
  };
}

export function setDeviceLoginSubmitting(): void {
  officeAccess.value = { ...officeAccess.value, state: "submitting", message: officeMessage("runtime.auth.authenticating") };
}

export function setDeviceLoginFailure(failure: DeviceLoginFailure): void {
  officeAccess.value = {
    ...officeAccess.value,
    state: failure.code === "unavailable" ? "unavailable" : "login-required",
    message: officeRuntimeMessage(failure.message),
    failureCode: failure.code,
    ...(failure.retryAfterSeconds ? { retryAfterSeconds: failure.retryAfterSeconds } : {})
  };
}

export function setOfficeAuthenticated(serverUrl: string): void {
  officeAccess.value = { state: "authenticated", serverUrl, message: officeMessage("runtime.auth.authenticated") };
}

export function setOfficeAccessUnavailable(serverUrl: string, message: string): void {
  officeAccess.value = { state: "unavailable", serverUrl, message: officeRuntimeMessage(message), failureCode: "unavailable" };
}

export function setOfficeConnecting(serverUrl: string): void {
  officeConnection.value = {
    ...officeConnection.value,
    state: "connecting",
    serverUrl,
    eventStream: "closed",
    message: officeMessage("runtime.office.connecting")
  };
}

export function applyOfficeSnapshot(snapshot: OfficeSnapshot, source: string | OfficeSnapshotRequestIdentity): boolean {
  const serverUrl = typeof source === "string" ? source : source.serverUrl;
  if (typeof source !== "string") {
    const latest = latestOfficeSnapshotIdentity;
    if (latest && (source.connectionGeneration < latest.connectionGeneration
      || (source.connectionGeneration === latest.connectionGeneration && source.requestGeneration <= latest.requestGeneration))) return false;
    setLatestOfficeSnapshotIdentity(source);
  }
  const explicitDemo = snapshot.capabilities.features.includes("demo");
  const runtimeReady = snapshot.capabilities.runtime.state === "ready";
  const sessionInventoryAuthoritative = officeInventoryReliability(snapshot.inventory.sessions) === "complete"
    && !snapshot.inventory.sessions.hasMore;
  const nonReadyInventoryUnreliable = !explicitDemo
    && !runtimeReady
    && (officeInventoryReliability(snapshot.inventory.profiles) !== "complete"
      || officeInventoryReliability(snapshot.inventory.sessions) !== "complete");
  const profileInventoryUnavailable = !explicitDemo
    && runtimeReady
    && snapshot.profiles.length === 0
    && officeInventoryReliability(snapshot.inventory.profiles) !== "complete";
  const preserveLastKnownLiveState = runtimeDataSource === "live" && nonReadyInventoryUnreliable;
  officeSnapshot.value = snapshot;
  officeConnection.value = {
    state: explicitDemo ? "demo" : profileInventoryUnavailable || nonReadyInventoryUnreliable ? "degraded" : "connected",
    source: explicitDemo ? "demo" : "server",
    serverUrl,
    runtime: snapshot.capabilities.runtime.state,
    protocolVersion: snapshot.capabilities.protocolVersion,
    generatedAt: snapshot.generatedAt,
    eventStream: officeConnection.value.eventStream,
    message: explicitDemo ? officeMessage("runtime.office.demo")
      : profileInventoryUnavailable ? officeMessage("runtime.office.profileInventoryUnavailable")
        : officeMessage("runtime.office.hermesState", { state: snapshot.capabilities.runtime.state })
  };

  if (explicitDemo) {
    loadExplicitDemoState();
    setProfileChatModalSessionInventoryAuthoritative(true);
    return true;
  }
  if (!runtimeReady) {
    setProfileChatModalSessionInventoryAuthoritative(false);
    if (!preserveLastKnownLiveState) clearRuntimeState();
    return true;
  }
  if (profileInventoryUnavailable) {
    setProfileChatModalSessionInventoryAuthoritative(false);
    if (runtimeDataSource !== "live") clearRuntimeState();
    return true;
  }
  if (snapshot.profiles.length === 0) {
    if (officeInventoryReliability(snapshot.inventory.profiles) === "complete" && !snapshot.inventory.profiles.hasMore) {
      reconcileDefaultAvatarProfiles([]);
    }
    clearRuntimeState();
    return true;
  }
  if (runtimeDataSource === "demo") clearRuntimeState();

  const previousProfiles = new Map(profileList.value.map((profile) => [profile.id, profile]));
  const previousTargetIds = new Set(getOpenChatTargets().map((target) => target.clientSessionId));
  const sessionCounts = new Map<string, number>();
  for (const session of snapshot.sessions) {
    sessionCounts.set(session.profileId, (sessionCounts.get(session.profileId) ?? 0) + 1);
  }
  const palette = ["#64b7a7", "#e07a55", "#d6a94f", "#8499c8", "#55d6be", "#f06a57"];
  const snapshotProfileIds = snapshot.profiles.map((profile) => profile.id);
  if (officeInventoryReliability(snapshot.inventory.profiles) === "complete" && !snapshot.inventory.profiles.hasMore) {
    reconcileDefaultAvatarProfiles(snapshotProfileIds);
  } else {
    registerDefaultAvatarProfiles(snapshotProfileIds);
  }
  ensurePokemonDisplayNames(snapshotProfileIds);
  profileList.value = snapshot.profiles.map((live, index) => {
    const previous = previousProfiles.get(live.id);
    return {
      id: live.id,
      name: live.name,
      role: previous?.role ?? "",
      status: activityToStatus(live.activity),
      color: previous?.color ?? palette[index % palette.length]!,
      sessions: sessionCounts.get(live.id) ?? live.activeSessionCount,
      taskCount: previous?.taskCount ?? 0,
      memoryBytes: previous?.memoryBytes ?? 0,
      memoryNote: previous?.memoryNote ?? "Hermes runtimeから読み取ったProfileです。",
      skills: previous?.skills ?? [],
      inheritedSkills: previous?.inheritedSkills ?? []
    };
  });
  if (snapshot.inventory.profiles.hasMore || snapshot.inventory.profiles.truncated) profileList.value = [...profileList.value, ...[...previousProfiles.values()].filter((profile) => !snapshot.profiles.some((live) => live.id === profile.id))];

  const previousSessions = sessions.value;
  const snapshotSessions = snapshot.sessions
    .filter((live) => !isScheduledSessionHidden({
      id: live.id,
      storedSessionId: live.id,
      profileId: live.profileId,
      title: live.title,
      titlePresentation: undefined,
    }))
    .map((live): import("./domain").ChatSession => {
    const previous = findStoredSession(previousSessions, live);
    return {
      ...(previous ?? { id: storedSessionClientId(live.profileId, live.id), messages: [] }),
      storedSessionId: live.id,
      profileId: live.profileId,
      title: live.title,
      titlePresentation: undefined,
      ...(live.createdAt === undefined ? {} : { createdAt: live.createdAt }),
      ...(live.updatedAt === undefined ? {} : { updatedAt: live.updatedAt }),
      ...(live.lastMessagePreview === undefined ? {} : { lastMessagePreview: live.lastMessagePreview }),
      ...(live.conversationKind === undefined ? {} : { conversationKind: live.conversationKind }),
      ...(live.delegationTaskId === undefined ? {} : { delegationTaskId: live.delegationTaskId }),
      ...(live.delegatedByProfileId === undefined ? {} : { delegatedByProfileId: live.delegatedByProfileId }),
      status: mergeServerSessionStatus(previous, live.activity),
      connectionState: previous?.connectionState ?? "disconnected",
      historyState: previous?.historyState ?? "unloaded",
      remoteKind: "stored",
      readOnly: previous?.connectionState !== "ready"
    };
  });
  const retainedStored = snapshot.inventory.sessions.hasMore || snapshot.inventory.sessions.truncated ? previousSessions.filter((session) => session.remoteKind === "stored" && !snapshot.sessions.some((live) => live.id === (session.storedSessionId ?? session.id) && live.profileId === session.profileId)) : [];
  const unpersistedDrafts = previousSessions.filter((session) => session.remoteKind === "draft" && !session.storedSessionId);
  const nextSessions = [
    ...snapshotSessions,
    ...retainedStored.filter((session) => !isScheduledSessionHidden(session)),
    ...unpersistedDrafts,
  ];
  const nextSessionIds = new Set(nextSessions.map((session) => session.id));
  for (const previous of previousSessions) {
    if (!nextSessionIds.has(previous.id)) clearChatComposerState(previous.id);
  }
  sessions.value = nextSessions;

  const liveSessionIds = nextSessionIds;
  openSessionIds.value = openSessionIds.value.filter((id) => liveSessionIds.has(id));
  if (profileChatModalId.value !== null
    && !profileList.value.some((profile) => profile.id === profileChatModalId.value)) {
    pendingProfileChatModalLayout = undefined;
    profileChatModalId.value = null;
    profileChatModalPaneIds.value = [];
    profileChatModalActivePaneId.value = "";
  } else {
    profileChatModalPaneIds.value = profileChatModalPaneIds.value.filter((id) => liveSessionIds.has(id));
    if (!profileChatModalPaneIds.value.includes(profileChatModalActivePaneId.value)) {
      profileChatModalActivePaneId.value = profileChatModalPaneIds.value.at(-1) ?? "";
    }
  }
  setProfileChatModalSessionInventoryAuthoritative(sessionInventoryAuthoritative);
  if (sessionInventoryAuthoritative) persistCurrentProfileChatModalLayout();
  embeddedChatSessionIds.value = embeddedChatSessionIds.value.filter((id) => liveSessionIds.has(id));
  // Reconcile both presentation surfaces after inventory removal. A vanished
  // modal-only session must not retain a hidden lease, and a newly available
  // workspace slot must resume automatically.
  reconcileActiveChatTargets(previousTargetIds);
  if (!liveSessionIds.has(activeSessionId.value)) activeSessionId.value = openSessionIds.value.at(-1) ?? "";
  if (!profileList.value.some((profile) => profile.id === selectedProfileId.value)) {
    selectedProfileId.value = profileList.value[0]?.id ?? "";
    prefetchSelectedProfileSettings(selectedProfileId.value || null);
  }
  setRuntimeDataSource("live");
  for (const target of getOpenChatTargets()) if (!previousTargetIds.has(target.clientSessionId)) officeRuntimeHooks.ensureChatSession(target);
  return true;
}

export function setOfficeEventStream(eventStream: import("./domain").OfficeConnection["eventStream"]): void {
  officeConnection.value = { ...officeConnection.value, eventStream };
}

export function setOfficeError(message: string, serverUrl: string, preserveRuntime = false): void {
  officeConnection.value = {
    ...officeConnection.value,
    state: "error",
    source: "server",
    serverUrl,
    eventStream: "closed",
    message: officeRuntimeMessage(message)
  };
  // Publish the unavailable transport state before clearing session inventory.
  // Dashboard wiring can then distinguish suspension from an intentional close.
  if (!preserveRuntime) { clearRuntimeState(); officeSnapshot.value = undefined; }
}

function activityToStatus(activity: string): Profile["status"] {
  if (activity === "thinking" || activity === "using-tool") return "working";
  if (activity === "waiting-for-user") return "waiting";
  if (activity === "blocked" || activity === "error") return "blocked";
  return "idle";
}

function updateProfileSessionCounts(): void {
  const counts = new Map<string, number>();
  for (const session of sessions.value) {
    if (session.remoteKind === "demo" || isScheduledSessionHidden(session)) continue;
    counts.set(session.profileId, (counts.get(session.profileId) ?? 0) + 1);
  }
  profileList.value = profileList.value.map((profile) => ({ ...profile, sessions: counts.get(profile.id) ?? 0 }));
}

export function selectProfile(profileId: string, options?: { openWorkspace?: boolean; openDetail?: boolean }): void {
  selectedProfileId.value = profileId;
  prefetchSelectedProfileSettings(profileId);
  inspectorTab.value = "chat";
  persistNavigationState();
  if (options?.openWorkspace) {
    // A profile/character click means "start a chat", not "resume whichever
    // durable conversation happened to be listed first". Existing sessions
    // are resumed only by an explicit session-row selection.
    createSession(profileId);
    // Studio floor / character click: chat workspace only on mobile (not the inspector).
    openMobileWorkspace();
    return;
  }
  if (options?.openDetail !== false) {
    openProfileChatModal(profileId);
  }
}


export function openScheduledSessions(): void {
  addPanelToActiveDashboard("scheduled");
}

export function closeScheduledSessions(): void {
  const panel = activeDashboard.value.panels.find((item) => item.kind === "scheduled");
  if (panel) removePanel(panel.id);
}

export function openSettingsModal(tab: SettingsTab = "global"): void {
  settingsTab.value = tab === "host" ? "host" : "global";
  settingsModalOpen.value = true;
  persistNavigationState();
}

export function closeSettingsModal(): void {
  settingsModalOpen.value = false;
  persistNavigationState();
}

export function openProfileSettingsModal(profileId: string, tab: SettingsTab = "soul"): void {
  selectedProfileId.value = profileId;
  prefetchSelectedProfileSettings(profileId);
  profileSettingsModalId.value = profileId;
  // Profile settings stay modal-scoped; only profile-owned tabs are accepted.
  profileSettingsModalTab.value = tab === "global" || tab === "host" ? "soul" : tab;
  persistNavigationState();
}

export function closeProfileSettingsModal(): void {
  profileSettingsModalId.value = null;
}

export function openProfileChatModal(profileId: string, options?: { sessionId?: string }): void {
  const reusingOpenModal = profileChatModalId.value === profileId;
  if (!reusingOpenModal) discardTemporaryPendingProfileModalDrafts();
  selectedProfileId.value = profileId;
  prefetchSelectedProfileSettings(profileId);
  profileChatModalId.value = profileId;
  if (!reusingOpenModal) {
    pendingProfileChatModalLayout = undefined;
    const saved = savedProfileChatModalLayout(profileId);
    const restoredPaneIds = saved?.paneSessionIds.filter((sessionId) =>
      sessions.value.some((session) => session.id === sessionId && session.profileId === profileId),
    ) ?? [];
    const restoredActiveSessionId = saved && restoredPaneIds.includes(saved.activeSessionId)
      ? saved.activeSessionId
      : restoredPaneIds.at(-1) ?? "";
    const inventoryAuthoritative = profileChatModalSessionInventoryAuthoritative
      || (officeConnection.value.source === "demo" && officeConnection.value.state === "demo");
    if (saved && !inventoryAuthoritative && restoredPaneIds.length < saved.paneSessionIds.length) {
      pendingProfileChatModalLayout = saved;
    }
    replaceProfileChatModalPanes(restoredPaneIds, restoredActiveSessionId, false);
    if (restoredPaneIds.length > 0 && !pendingProfileChatModalLayout) {
      persistCurrentProfileChatModalLayout();
    }
  }
  if (options?.sessionId) {
    const session = sessions.value.find((item) => item.id === options.sessionId);
    if (session?.profileId === profileId) selectProfileChatModalSession(options.sessionId);
  }
  // A newly opened profile modal should always present a usable conversation.
  // Saved panes are restored first; only a missing or entirely stale saved
  // layout gets a fresh draft.
  if (profileChatModalPaneIds.value.length === 0) {
    const sessionId = createSession(profileId, { workspace: false });
    if (sessionId) {
      replaceProfileChatModalPanes([sessionId], sessionId, pendingProfileChatModalLayout === undefined);
    } else if (!pendingProfileChatModalLayout) {
      persistCurrentProfileChatModalLayout();
    }
  }
  persistNavigationState();
}

export function closeProfileChatModal(): void {
  // Clearing the live modal must not erase the per-profile layout that will
  // be restored the next time this profile is opened.
  discardTemporaryPendingProfileModalDrafts();
  replaceProfileChatModalPanes([], "", false);
  pendingProfileChatModalLayout = undefined;
  profileChatModalId.value = null;
}

export function openEmbeddedChatSession(sessionId: string): boolean {
  if (!sessions.value.some((session) => session.id === sessionId)) return false;
  const previousTargets = new Set(getOpenChatTargets().map((target) => target.clientSessionId));
  embeddedChatSessionIds.value = [
    sessionId,
    ...embeddedChatSessionIds.value.filter((id) => id !== sessionId),
  ];
  reconcileActiveChatTargets(previousTargets);
  return true;
}

export function closeEmbeddedChatSession(sessionId: string): void {
  if (!embeddedChatSessionIds.value.includes(sessionId)) return;
  const previousTargets = new Set(getOpenChatTargets().map((target) => target.clientSessionId));
  embeddedChatSessionIds.value = embeddedChatSessionIds.value.filter((id) => id !== sessionId);
  reconcileActiveChatTargets(previousTargets);
}

export function addProfileChatModalPane(sessionId: string, options?: { index?: number }): boolean {
  const modalProfileId = profileChatModalId.value;
  if (!modalProfileId) return false;
  const session = sessions.value.find((item) => item.id === sessionId);
  if (!session || session.profileId !== modalProfileId) return false;
  const current = profileChatModalPaneIds.value;
  if (current.includes(sessionId)) {
    return typeof options?.index === "number"
      ? moveProfileChatModalPane(sessionId, options.index)
      : setProfileChatModalActivePane(sessionId);
  }
  const next = [...current];
  const insertAt = typeof options?.index === "number"
    ? Math.max(0, Math.min(next.length, Math.floor(options.index)))
    : next.length;
  next.splice(insertAt, 0, sessionId);
  replaceProfileChatModalPanes(next, sessionId);
  return true;
}

export function setProfileChatModalActivePane(sessionId: string): boolean {
  if (!profileChatModalPaneIds.value.includes(sessionId)) return false;
  if (pendingProfileChatModalLayout?.profileId === profileChatModalId.value
    && pendingProfileChatModalLayout.paneSessionIds.includes(sessionId)) {
    pendingProfileChatModalLayout = { ...pendingProfileChatModalLayout, activeSessionId: sessionId };
  }
  const previousTargets = new Set(getOpenChatTargets().map((target) => target.clientSessionId));
  profileChatModalActivePaneId.value = sessionId;
  reconcileActiveChatTargets(previousTargets);
  ensureSessionConnection(sessionId);
  persistCurrentProfileChatModalLayout();
  return true;
}

/** Click contract: focus an existing pane, otherwise replace the last-active pane. */
export function selectProfileChatModalSession(sessionId: string): boolean {
  const modalProfileId = profileChatModalId.value;
  const session = sessions.value.find((item) => item.id === sessionId);
  if (!modalProfileId || session?.profileId !== modalProfileId) return false;
  const current = profileChatModalPaneIds.value;
  if (current.includes(sessionId)) return setProfileChatModalActivePane(sessionId);
  if (current.length === 0) return addProfileChatModalPane(sessionId);
  const target = current.includes(profileChatModalActivePaneId.value)
    ? profileChatModalActivePaneId.value
    : current.at(-1)!;
  const replacedSession = sessions.value.find((item) => item.id === target);
  const replaced = replaceProfileChatModalPane(target, sessionId);
  // A list click may discard the unused local composer it replaces. The shared
  // replace primitive deliberately does not do this so drag-and-drop keeps its
  // existing pane-only behavior.
  if (replaced && target !== sessionId && isDiscardableEmptyProfileModalDraft(replacedSession)) {
    dismissSessions([target]);
  }
  return replaced;
}

/** Replace one modal pane, removing a duplicate source pane when necessary. */
export function replaceProfileChatModalPane(targetSessionId: string, sessionId: string): boolean {
  const modalProfileId = profileChatModalId.value;
  const session = sessions.value.find((item) => item.id === sessionId);
  const current = profileChatModalPaneIds.value;
  if (!modalProfileId || session?.profileId !== modalProfileId || !current.includes(targetSessionId)) return false;
  if (targetSessionId === sessionId) return setProfileChatModalActivePane(sessionId);
  const next: string[] = [];
  for (const id of current) {
    if (id === targetSessionId) next.push(sessionId);
    else if (id !== sessionId) next.push(id);
  }
  replaceProfileChatModalPanes(next, sessionId);
  ensureSessionConnection(sessionId);
  return true;
}

export function moveProfileChatModalPane(sessionId: string, index: number): boolean {
  const current = profileChatModalPaneIds.value;
  const from = current.indexOf(sessionId);
  if (from < 0) return false;
  let desired = Math.max(0, Math.min(current.length, Math.floor(index)));
  if (from < desired) desired -= 1;
  const next = current.filter((id) => id !== sessionId);
  next.splice(Math.max(0, Math.min(next.length, desired)), 0, sessionId);
  replaceProfileChatModalPanes(next, sessionId);
  return true;
}

export function removeProfileChatModalPane(sessionId: string): void {
  replaceProfileChatModalPanes(profileChatModalPaneIds.value.filter((id) => id !== sessionId));
}

export function setProfileChatModalPanes(sessionIds: readonly string[]): void {
  const modalProfileId = profileChatModalId.value;
  if (!modalProfileId) {
    replaceProfileChatModalPanes([]);
    return;
  }
  const allowed = sessionIds.filter((sessionId) => {
    const session = sessions.value.find((item) => item.id === sessionId);
    return Boolean(session && session.profileId === modalProfileId);
  });
  const unique: string[] = [];
  for (const id of allowed) {
    if (!unique.includes(id)) unique.push(id);
  }
  replaceProfileChatModalPanes(unique);
}

function replaceProfileChatModalPanes(
  next: string[],
  activePaneId = profileChatModalActivePaneId.value,
  persist = true,
): void {
  const previousTargets = new Set(getOpenChatTargets().map((target) => target.clientSessionId));
  profileChatModalPaneIds.value = next;
  profileChatModalActivePaneId.value = next.includes(activePaneId) ? activePaneId : next.at(-1) ?? "";
  reconcileActiveChatTargets(previousTargets);
  // Pane mutations stay provisional while a saved layout awaits an
  // authoritative inventory; persisting now would destroy the saved panes
  // before reconcilePendingProfileChatModalRestore can apply them.
  const persistAllowed = persist && pendingProfileChatModalLayout?.profileId !== profileChatModalId.value;
  if (persistAllowed) persistCurrentProfileChatModalLayout();
}

function discardTemporaryPendingProfileModalDrafts(): void {
  const pending = pendingProfileChatModalLayout;
  if (!pending || pending.profileId !== profileChatModalId.value) return;
  const transientDraftIds = profileChatModalPaneIds.value.filter((sessionId) =>
    !pending.paneSessionIds.includes(sessionId)
      && isDiscardableEmptyProfileModalDraft(sessions.value.find((session) => session.id === sessionId)),
  );
  if (transientDraftIds.length > 0) dismissSessions(transientDraftIds);
}

function isDiscardableEmptyProfileModalDraft(session: import("./domain").ChatSession | undefined): boolean {
  return session?.titlePresentation === "new-chat"
    && session.messages.length === 0
    && session.status !== "streaming"
    && session.remoteKind === "draft"
    && session.storedSessionId === undefined;
}

/**
 * Inventory pages can arrive after the modal opens. Keep the saved layout
 * intact until every referenced session is known or the inventory becomes
 * authoritative; otherwise an early modal open would erase unloaded panes.
 */
function reconcilePendingProfileChatModalRestore(): void {
  const pending = pendingProfileChatModalLayout;
  if (!pending || profileChatModalId.value !== pending.profileId) return;
  const restoredPaneIds = pending.paneSessionIds.filter((sessionId) =>
    sessions.value.some((session) => session.id === sessionId && session.profileId === pending.profileId),
  );
  const restoredActiveSessionId = restoredPaneIds.includes(pending.activeSessionId)
    ? pending.activeSessionId
    : restoredPaneIds.at(-1) ?? "";
  const transientDraftIds = profileChatModalPaneIds.value.filter((sessionId) =>
    !pending.paneSessionIds.includes(sessionId)
      && isDiscardableEmptyProfileModalDraft(sessions.value.find((session) => session.id === sessionId)),
  );

  if (restoredPaneIds.length > 0) {
    replaceProfileChatModalPanes(restoredPaneIds, restoredActiveSessionId, false);
  }

  const resolved = restoredPaneIds.length === pending.paneSessionIds.length;
  if (!resolved && !profileChatModalSessionInventoryAuthoritative) {
    if (transientDraftIds.length > 0 && restoredPaneIds.length > 0) dismissSessions(transientDraftIds);
    return;
  }

  pendingProfileChatModalLayout = undefined;
  if (restoredPaneIds.length === 0 && profileChatModalPaneIds.value.length === 0) {
    const sessionId = createSession(pending.profileId, { workspace: false });
    if (sessionId) replaceProfileChatModalPanes([sessionId], sessionId, false);
  }
  if (transientDraftIds.length > 0 && restoredPaneIds.length > 0) dismissSessions(transientDraftIds);
  persistCurrentProfileChatModalLayout();
}

/** Called by inventory pagination whenever its view of stored sessions changes. */
export function setProfileChatModalSessionInventoryAuthoritative(authoritative: boolean): void {
  profileChatModalSessionInventoryAuthoritative = authoritative;
  reconcilePendingProfileChatModalRestore();
}

function persistCurrentProfileChatModalLayout(): void {
  const profileId = profileChatModalId.value;
  if (!profileId) return;
  if (pendingProfileChatModalLayout?.profileId === profileId) return;
  saveProfileChatModalLayout(
    profileId,
    profileChatModalPaneIds.value,
    profileChatModalActivePaneId.value,
  );
}


export function setWorkspaceSessionDropPreview(active: boolean): void {
  workspaceSessionDropPreview.value = active;
  if (!active) workspaceSessionDropPlacement.value = null;
}

export function setWorkspaceSessionDropPlacement(placement: "top" | "right" | "bottom" | "left" | null): void {
  workspaceSessionDropPlacement.value = placement;
  if (placement) workspaceSessionDropPreview.value = true;
}

export function clearWorkspaceSessionDropPreview(): void {
  workspaceSessionDropPreview.value = false;
  workspaceSessionDropPlacement.value = null;
}

export function ensureSessionConnection(sessionId: string): void {
  if (!getOpenChatTargets().some((target) => target.clientSessionId === sessionId)) return;
  const session = sessions.value.find((item) => item.id === sessionId);
  if (!session) return;
  selectedProfileId.value = session.profileId;
  prefetchSelectedProfileSettings(session.profileId);
  // connectionState !== "ready" already covers "error" and "disconnected".
  const needsEnsure = session.connectionState !== "ready"
    || session.historyState === "error"
    || session.historyState === "unloaded";
  if (!needsEnsure) return;
  const target = chatTarget(session);
  if (target) officeRuntimeHooks.ensureChatSession(target);
}

export function openSession(sessionId: string, options?: { workspace?: boolean; index?: number }): void {
  const addToWorkspace = options?.workspace !== false;
  const wasOpen = openSessionIds.value.includes(sessionId);
  const previousTargets = new Set(getOpenChatTargets().map((target) => target.clientSessionId));
  if (addToWorkspace) {
    if (!wasOpen) {
      openSessionIds.value = appendOpenSessionId(openSessionIds.value, sessionId, options?.index);
    } else if (typeof options?.index === "number") {
      openSessionIds.value = moveOpenSessionId(openSessionIds.value, sessionId, options.index);
    }
    activeSessionId.value = sessionId;
    reconcileActiveChatTargets(previousTargets);
  }
  const session = sessions.value.find((item) => item.id === sessionId);
  if (session) {
    selectedProfileId.value = session.profileId;
  prefetchSelectedProfileSettings(session.profileId);
    // connectionState !== "ready" already covers "error" and "disconnected".
    const needsEnsure = (addToWorkspace && !wasOpen)
      || session.connectionState !== "ready"
      || session.historyState === "error"
      || session.historyState === "unloaded";
    const newlyActivated = addToWorkspace
      && !previousTargets.has(sessionId)
      && getOpenChatTargets().some((target) => target.clientSessionId === sessionId);
    if (needsEnsure && !newlyActivated) ensureSessionConnection(sessionId);
  }
}

export function appendOpenSessionId(currentIds: readonly string[], sessionId: string, index?: number): string[] {
  if (currentIds.includes(sessionId)) return [...currentIds];
  const next = [...currentIds];
  const insertAt = typeof index === "number"
    ? Math.max(0, Math.min(next.length, Math.floor(index)))
    : next.length;
  next.splice(insertAt, 0, sessionId);
  return next;
}

export function moveOpenSessionId(currentIds: readonly string[], sessionId: string, index: number): string[] {
  const from = currentIds.indexOf(sessionId);
  if (from < 0) return [...currentIds];
  // `index` is a visual insert position computed while the dragged pane is still present.
  // When moving rightward, account for the vacated slot so the final order matches the drop line.
  let desired = Math.max(0, Math.min(currentIds.length, Math.floor(index)));
  if (from < desired) desired -= 1;
  const next = currentIds.filter((id) => id !== sessionId);
  const insertAt = Math.max(0, Math.min(next.length, desired));
  next.splice(insertAt, 0, sessionId);
  return next;
}

export function closeSession(sessionId: string): void {
  const previousTargets = new Set(getOpenChatTargets().map((target) => target.clientSessionId));
  openSessionIds.value = openSessionIds.value.filter((id) => id !== sessionId);
  reconcileActiveChatTargets(previousTargets);
  if (activeSessionId.value === sessionId) {
    activeSessionId.value = openSessionIds.value.at(-1) ?? "";
  }
  if (openSessionIds.value.length === 0) noteMobileWorkspaceClosed();
}

export function dismissSessions(sessionIds: readonly string[]): void {
  const ids = new Set(sessionIds);
  if (ids.size === 0) return;
  for (const sessionId of ids) clearChatComposerState(sessionId);
  const previouslyActiveTargetIds = new Set(getOpenChatTargets().map((target) => target.clientSessionId));
  for (const sessionId of ids) {
    if (!previouslyActiveTargetIds.has(sessionId)) releaseChatTarget(sessionId);
  }
  sessions.value = sessions.value.filter((session) => !ids.has(session.id));
  openSessionIds.value = openSessionIds.value.filter((sessionId) => !ids.has(sessionId));
  profileChatModalPaneIds.value = profileChatModalPaneIds.value.filter((sessionId) => !ids.has(sessionId));
  if (!profileChatModalPaneIds.value.includes(profileChatModalActivePaneId.value)) {
    profileChatModalActivePaneId.value = profileChatModalPaneIds.value.at(-1) ?? "";
  }
  persistCurrentProfileChatModalLayout();
  embeddedChatSessionIds.value = embeddedChatSessionIds.value.filter((sessionId) => !ids.has(sessionId));
  reconcileActiveChatTargets(previouslyActiveTargetIds);
  if (ids.has(activeSessionId.value)) activeSessionId.value = openSessionIds.value.at(-1) ?? "";
  updateProfileSessionCounts();
  if (openSessionIds.value.length === 0) noteMobileWorkspaceClosed();
}

export type DeleteSessionsOptions = {
  concurrency?: number;
  timeoutMs?: number;
  onProgress?(progress: SessionDeletionProgress): void;
};

const BULK_SESSION_DELETE_CONCURRENCY = 2;
const SESSION_DELETE_TIMEOUT_MS = 20_000;
const HERMES_SESSION_DELETE_BATCH_SIZE = 500;

/** Permanently delete durable Hermes sessions and immediately drop confirmed successes from Studio lists. */
export async function deleteSessions(
  sessionIds: readonly string[],
  options: DeleteSessionsOptions = {},
): Promise<{ deleted: string[]; failed: string[] }> {
  const requested = new Set(sessionIds);
  const targets = sessions.value.filter((session) => requested.has(session.id));
  if (targets.length === 0) return { deleted: [], failed: [] };

  type DurableDelete = { session: (typeof targets)[number]; storedId: string };
  type ProfileDeleteBatch = { profileId: string; targets: DurableDelete[] };
  const durableTargets: DurableDelete[] = [];
  const localTargets: (typeof targets)[number][] = [];
  for (const session of targets) {
    const storedId = session.storedSessionId ?? (session.remoteKind === "stored" ? session.id : undefined);
    if (storedId) durableTargets.push({ session, storedId });
    else localTargets.push(session);
  }
  const byProfile = new Map<string, DurableDelete[]>();
  for (const target of durableTargets) {
    const existing = byProfile.get(target.session.profileId) ?? [];
    existing.push(target);
    byProfile.set(target.session.profileId, existing);
  }
  const batches: ProfileDeleteBatch[] = [];
  for (const [profileId, profileTargets] of byProfile) {
    for (let offset = 0; offset < profileTargets.length; offset += HERMES_SESSION_DELETE_BATCH_SIZE) {
      batches.push({ profileId, targets: profileTargets.slice(offset, offset + HERMES_SESSION_DELETE_BATCH_SIZE) });
    }
  }

  const deletedLocalIds = localTargets.map((session) => session.id);
  if (deletedLocalIds.length > 0) dismissSessions(deletedLocalIds);
  let completed = localTargets.length;
  let deleted = localTargets.length;
  let failed = 0;
  if (completed > 0) options.onProgress?.({ completed, total: targets.length, deleted, failed });

  const result = await runSessionDeletionBatch(batches, async (batch) => {
    const storedIds = batch.targets.map((target) => target.storedId);
    let firstFailure: unknown;
    try {
      await deleteStoredSessions(batch.profileId, storedIds, { timeoutMs: options.timeoutMs ?? SESSION_DELETE_TIMEOUT_MS });
    } catch (error) {
      firstFailure = error;
      // Bulk deletion is idempotent: a retry safely resolves a transient
      // failure or a timeout after Hermes committed the transaction.
      try {
        await deleteStoredSessions(batch.profileId, storedIds, { timeoutMs: options.timeoutMs ?? SESSION_DELETE_TIMEOUT_MS });
      } catch {
        failed += batch.targets.length;
        completed += batch.targets.length;
        options.onProgress?.({ completed, total: targets.length, deleted, failed });
        throw firstFailure;
      }
    }
    const deletedIds = batch.targets.map((target) => target.session.id);
    dismissSessions(deletedIds);
    deleted += batch.targets.length;
    completed += batch.targets.length;
    options.onProgress?.({ completed, total: targets.length, deleted, failed });
  }, {
    concurrency: options.concurrency ?? BULK_SESSION_DELETE_CONCURRENCY,
  });

  return {
    deleted: [...deletedLocalIds, ...result.deleted.flatMap((batch) => batch.targets.map((target) => target.session.id))],
    failed: result.failed.flatMap((batch) => batch.targets.map((target) => target.session.id)),
  };
}

/**
 * Open or reuse a chat with the Kanban card's assignee for confirmation Q&A.
 * Does not change card status or call Hermes dispatch.
 */
export function askAssigneeAboutTask(
  task: import("./domain").WorkTask,
  options?: { openWorkspace?: boolean },
): string | undefined {
  const assigneeId = task.assigneeId;
  if (!assigneeId || task.pending) return undefined;
  const openWorkspace = options?.openWorkspace !== false;

  const existing = findCardAskSession(sessions.value, task.id, assigneeId);
  if (existing) {
    if (openWorkspace) {
      openSession(existing.id);
      openMobileWorkspace();
    } else {
      openEmbeddedChatSession(existing.id);
    }
    return existing.id;
  }

  const sessionId = createSession(assigneeId, { workspace: openWorkspace });
  if (sessionId === undefined) return undefined;
  if (!openWorkspace) openEmbeddedChatSession(sessionId);

  const seed = buildCardAskSeedPrompt(cardAskSeedInputFromTask({ ...task, assigneeId }));
  sessions.value = sessions.value.map((session) =>
    session.id === sessionId
      ? {
          ...session,
          sourceCardId: task.id,
          sourceCardTitle: task.title,
          sourceCardSeeded: false,
          pendingCardSeed: seed,
          title: task.title,
          titlePresentation: undefined,
        }
      : session,
  );
  if (openWorkspace) openMobileWorkspace();
  return sessionId;
}

export function createSession(profileId: string, options?: { workspace?: boolean }): string | undefined {
  const isLive = officeConnection.value.source === "server" && officeConnection.value.runtime === "ready";
  const isDemo = officeConnection.value.source === "demo" && officeConnection.value.state === "demo";
  if ((!isLive && !isDemo) || !profileList.value.some((profile) => profile.id === profileId)) return undefined;
  // Effort on prefs is only set after live-enum apply (or cleared). Shape-sanitize here.
  const { model, provider, reasoningEffort } = resolvedCreateModelPrefs();
  const session: import("./domain").ChatSession = {
    id: crypto.randomUUID(),
    profileId,
    title: "",
    titlePresentation: "new-chat",
    status: "ready",
    messages: [],
    connectionState: isLive ? "connecting" : "ready",
    historyState: "loaded",
    remoteKind: isLive ? "draft" : "demo",
    readOnly: isLive,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
  sessions.value = [...sessions.value, session];
  openSession(session.id, { workspace: options?.workspace !== false });
  return session.id;
}

function loadExplicitDemoState(): void {
  clearRuntimeState();
  reconcileDefaultAvatarProfiles(profiles.map((profile) => profile.id));
  ensurePokemonDisplayNames(profiles.map((profile) => profile.id));
  profileList.value = profiles.map((profile) => ({ ...profile, skills: [...profile.skills], inheritedSkills: [...profile.inheritedSkills] }));
  loadKanbanDemoRuntime(createDemoKanbanApi(initialTasks, initialTaskComments, profileList.value.map((profile) => profile.id)));
  loadTeamsDemoRuntime(initialTeams);
  sessions.value = initialSessions.map((session) => ({
    ...session,
    messages: session.messages.map((message) => ({ ...message })),
    connectionState: "ready",
    historyState: "loaded",
    remoteKind: "demo",
    readOnly: false
  }));
  selectedProfileId.value = profileList.value[0]?.id ?? "";
  openSessionIds.value = sessions.value.map((session) => session.id);
  activeSessionId.value = openSessionIds.value[0] ?? "";
  setRuntimeDataSource("demo");
}

function clearRuntimeState(): void {
  for (const target of getOpenChatTargets()) releaseChatTarget(target.clientSessionId);
  clearAllChatComposerStates();
  profileList.value = [];
  sessions.value = [];
  resetKanbanRuntimeState();
  resetTeamsRuntimeState();
  selectedProfileId.value = "";
  openSessionIds.value = [];
  activeSessionId.value = "";
  profileChatModalId.value = null;
  profileChatModalPaneIds.value = [];
  profileChatModalActivePaneId.value = "";
  pendingProfileChatModalLayout = undefined;
  profileChatModalSessionInventoryAuthoritative = false;
  embeddedChatSessionIds.value = [];
  clearMobileRoutes();
  chatSocketState.value = { state: "disconnected", message: officeMessage("runtime.chat.waiting") };
  setRuntimeDataSource("none");
}

function chatTarget(session: import("./domain").ChatSession): ChatTarget | undefined {
  if (!session.remoteKind || session.remoteKind === "demo") return undefined;
  // Session effort was set via apply (live allowlist) or createSession from validated prefs.
  const resolved = resolvedCreateModelPrefs({
    provider: session.provider ?? "",
    model: session.model ?? "",
    reasoningEffort: session.reasoningEffort ?? "",
  });
  return {
    clientSessionId: session.id,
    profileId: session.profileId,
    ...(session.storedSessionId ? { storedSessionId: session.storedSessionId } : {}),
    ...(resolved.model ? { model: resolved.model } : {}),
    ...(resolved.provider ? { provider: resolved.provider } : {}),
    ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
  };
}

function releaseChatTarget(sessionId: string): void {
  const session = sessions.value.find((item) => item.id === sessionId);
  if (session && isChatRunActive(session)) {
    deferredChatTargetReleases.add(sessionId);
    return;
  }
  releaseChatTargetNow(sessionId);
}

function releaseChatTargetNow(sessionId: string): void {
  sessions.value = sessions.value.map((session) => session.id === sessionId ? reconcileChatSessionDisconnected(session) : session);
  officeRuntimeHooks.releaseChatSession(sessionId);
}

// Closing a panel or switching dashboards is a layout operation, not an
// interrupt command. Keep an active Hermes lease alive off-screen until its
// terminal event has reached the store, then release it normally.
effect(() => {
  const currentSessions = sessions.value;
  const visibleTargetIds = new Set(getOpenChatTargets().map((target) => target.clientSessionId));
  for (const sessionId of deferredChatTargetReleases) {
    if (visibleTargetIds.has(sessionId)) {
      deferredChatTargetReleases.delete(sessionId);
      continue;
    }
    const session = currentSessions.find((item) => item.id === sessionId);
    if (session && isChatRunActive(session)) continue;
    deferredChatTargetReleases.delete(sessionId);
    releaseChatTargetNow(sessionId);
    // Releasing the hidden reservation can expose a workspace slot that was
    // deliberately held back. Ensures are idempotent for already-live targets.
    for (const target of getOpenChatTargets()) officeRuntimeHooks.ensureChatSession(target);
  }
});

function reconcileActiveChatTargets(previousTargetIds: ReadonlySet<string>): void {
  // Recompute after every deferred release: an outgoing active run consumes a
  // lease and can reduce how many newly-visible targets may start. Iteration
  // prevents a foreground switch from briefly opening a fifth server lease.
  const released = new Set<string>();
  while (true) {
    const nextTargetIds = new Set(getOpenChatTargets().map((target) => target.clientSessionId));
    const outgoing = [...previousTargetIds].find((sessionId) => (
      !released.has(sessionId) && !nextTargetIds.has(sessionId)
    ));
    if (outgoing === undefined) break;
    released.add(outgoing);
    releaseChatTarget(outgoing);
  }
  for (const target of getOpenChatTargets()) {
    if (!previousTargetIds.has(target.clientSessionId)) officeRuntimeHooks.ensureChatSession(target);
  }
}
