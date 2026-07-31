import { Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatSession, Profile, WorkTask } from "../domain";
import { chatSessionTitle, localizeRuntimeMessage, t, type TranslationKey } from "../i18n";
import { loadMoreProfiles, loadMoreSessions, profileInventoryState, sessionInventoryState } from "../inventory";
import { deleteTask, tasks } from "../kanban-store";
import { profileDisplayName, profileDisplayNameMap, profileSecondaryName } from "../profile-names";
import {
  activeSessionId,
  focusKanbanTask,
  openMobileWorkspace,
  openProfileChatModal,
  openSessionIds,
  profileList,
  selectProfile,
  selectedProfileId,
  sessions,
} from "../store";
import {
  activeDashboard,
  activeDashboardId,
  dashboards,
  renameDashboard,
  MAX_DASHBOARD_PANELS,
  MAX_DASHBOARDS,
  type DashboardPanelKind,
} from "../dashboard-layout";
import { activateDashboard, activateDashboardContainingPanel, addDashboardPanel, createDashboardWithDefaultChat, deleteDashboardWithActivation, selectDashboardChatSession } from "../dashboard-actions";
import {
  beginSidebarPanelPointerDrag,
  beginSidebarSessionPointerDrag,
  consumeSidebarPanelClickSuppression,
  consumeSidebarSessionClickSuppression,
} from "../dashboard-drag";
import {
  SIDEBAR_ICON_THRESHOLD,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  isSidebarIconOnly,
  isSidebarProfileOpen,
  isSidebarProjectOpen,
  setSidebarProfilesOpen,
  setSidebarProjectsOpen,
  setSidebarMode,
  setSidebarTasksOpen,
  setSidebarTeamsOpen,
  setSidebarWidth,
  previewSidebarWidth,
  sidebarMode,
  sidebarProfilesOpen,
  sidebarProjectsOpen,
  sidebarTasksOpen,
  sidebarTeamsOpen,
  sidebarWidth,
  toggleSidebarProfileOpen,
  toggleSidebarProjectOpen,
} from "../sidebar-layout";
import { CharacterPortrait } from "./character-portrait";
import { BoardIcon, CardsIcon, ChatIcon, FolderIcon, GroupIcon, HomeIcon, ListIcon, ScheduleIcon, TrashIcon, UsersIcon } from "./icons";
import { StatusPill } from "./status-pill";
import { TeamBadges } from "./team-badges";
import { teams } from "../teams-store";
import { groupProfilesByTeams, profileGroupItemKey, type ProfileTeamGroup } from "../profile-team-groups";
import { setSidebarGroupMode, sidebarGroupMode } from "../group-display-prefs";
import {
  moveSidebarProfile,
  reconcileSidebarProfileOrder,
  sortProfilesBySidebarOrder,
} from "../profile-order";
import { ProfileContextMenu, useProfileContextMenu } from "./profile-context-menu";
import { isScheduledSessionHidden } from "../scheduled-sessions";
import { isPhoneViewport } from "../viewport";
import { createProfileSession } from "./profile-panel";
import { SessionDeleteDialog } from "./session-delete-dialog";
import { useMobileOverlay } from "./use-mobile-overlay";
import { groupSessionsByProject, type ProjectSessionGroup } from "../project-session-groups";
import {
  moveSidebarProject,
  reconcileSidebarProjectOrder,
  sortProjectsBySidebarOrder,
} from "../project-order";

const SIDEBAR_PROFILE_PAGE_SIZE = 8;

function sidebarTaskStatusLabel(status: string): string {
  switch (status) {
    case "triage": return t("kanban.column.triage");
    case "todo": return t("kanban.column.todo");
    case "scheduled": return t("kanban.column.scheduled");
    case "ready": return t("kanban.column.ready");
    case "running": return t("kanban.column.running");
    case "blocked": return t("kanban.column.blocked");
    case "review": return t("kanban.column.review");
    case "done": return t("kanban.column.done");
    default: return status;
  }
}

function sidebarTaskAssigneeName(assigneeId: string, profiles: readonly Profile[]): string {
  const profile = profiles.find((item) => item.id === assigneeId);
  return profile ? profileDisplayName(profile) : assigneeId;
}

/** Dashboard panel entries: click navigates to an existing pane; drag places one. */
const panelNavItems: { kind: DashboardPanelKind; icon: typeof HomeIcon; label: TranslationKey }[] = [
  { kind: "studio", icon: HomeIcon, label: "nav.office" },
  { kind: "kanban", icon: BoardIcon, label: "nav.kanban" },
  { kind: "teams", icon: UsersIcon, label: "nav.teams" },
  { kind: "scheduled", icon: ScheduleIcon, label: "nav.scheduled" },
  { kind: "profiles", icon: GroupIcon, label: "dashboard.panel.profiles" },
];

export function SideRail() {
  const resizePointerId = useRef<number | null>(null);
  const [renamingDashboardId, setRenamingDashboardId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const {
    menu,
    menuRef,
    closeMenu,
    openProfileMenu,
    openSessionMenu,
    openMenuSession,
  } = useProfileContextMenu();
  const inventory = profileInventoryState.value;
  const sessionInventory = sessionInventoryState.value;
  const iconOnly = isSidebarIconOnly();
  const [phoneViewport, setPhoneViewport] = useState(isPhoneViewport());
  const [mobileTabKind, setMobileTabKind] = useState<DashboardPanelKind>(() =>
    panelNavItems.find((item) => activeDashboard.value.panels.some((panel) => panel.kind === item.kind))?.kind
    ?? "studio"
  );
  const [dragProfileId, setDragProfileId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dragProjectId, setDragProjectId] = useState<string | null>(null);
  const [dropProjectTargetId, setDropProjectTargetId] = useState<string | null>(null);
  const [visibleProfileCount, setVisibleProfileCount] = useState(SIDEBAR_PROFILE_PAGE_SIZE);
  const [panelActionNote, setPanelActionNote] = useState("");
  const [sessionDeleteRequestId, setSessionDeleteRequestId] = useState<string | null>(null);
  const [dashboardDeleteRequest, setDashboardDeleteRequest] = useState<{ id: string; name: string } | null>(null);
  const [taskDeleteRequest, setTaskDeleteRequest] = useState<WorkTask | null>(null);
  const [taskDeleteBusy, setTaskDeleteBusy] = useState(false);
  const [taskDeleteFailed, setTaskDeleteFailed] = useState(false);
  const panelActionNoteTimer = useRef<number | undefined>(undefined);
  const dashboardDeleteOverlay = useMobileOverlay<HTMLElement>({
    kind: "modal",
    open: dashboardDeleteRequest !== null,
    onClose: () => setDashboardDeleteRequest(null),
    viewport: "(min-width: 0px)",
  });
  const taskDeleteOverlay = useMobileOverlay<HTMLElement>({
    kind: "modal",
    open: taskDeleteRequest !== null,
    onClose: () => {
      if (!taskDeleteBusy) setTaskDeleteRequest(null);
    },
    viewport: "(min-width: 0px)",
  });

  const requestTaskDelete = (task: WorkTask) => {
    if (task.pending || taskDeleteBusy) return;
    setTaskDeleteFailed(false);
    setTaskDeleteRequest(task);
  };

  const confirmTaskDelete = async () => {
    const request = taskDeleteRequest;
    if (!request || taskDeleteBusy) return;
    setTaskDeleteBusy(true);
    setTaskDeleteFailed(false);
    const deleted = await deleteTask(request.id);
    setTaskDeleteBusy(false);
    if (deleted) setTaskDeleteRequest(null);
    else setTaskDeleteFailed(true);
  };

  const showPanelActionNote = (message: string) => {
    if (panelActionNoteTimer.current !== undefined) window.clearTimeout(panelActionNoteTimer.current);
    setPanelActionNote(message);
    panelActionNoteTimer.current = window.setTimeout(() => {
      setPanelActionNote("");
      panelActionNoteTimer.current = undefined;
    }, 2200);
  };

  const activateOrAddPanelFromClick = (kind: DashboardPanelKind): boolean => {
    if (activeDashboard.value.panels.length === 0) {
      const result = addDashboardPanel(kind);
      if (result === "full") {
        showPanelActionNote(t("dashboard.panelLimit", { count: MAX_DASHBOARD_PANELS }));
        return false;
      }
      return true;
    }
    return activateDashboardContainingPanel(kind);
  };

  const revealMobilePanel = (kind: DashboardPanelKind, sessionId?: string) => {
    window.requestAnimationFrame(() => {
      const candidates = [...document.querySelectorAll<HTMLElement>(`.dashboard-panel--${kind}`)];
      const panel = sessionId
        ? candidates.find((item) => item.dataset.sessionId === sessionId)
        : candidates[0];
      if (!panel) return;
      const reducedMotion = typeof matchMedia === "function"
        && matchMedia("(prefers-reduced-motion: reduce)").matches;
      panel.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    });
  };

  const activateMobileTab = (kind: DashboardPanelKind): boolean => {
    setMobileTabKind(kind);
    const alreadyPresent = activeDashboard.value.panels.some((panel) => panel.kind === kind);
    if (!alreadyPresent && !activateDashboardContainingPanel(kind)) {
      const result = addDashboardPanel(kind);
      if (result === "full") {
        showPanelActionNote(t("dashboard.panelLimit", { count: MAX_DASHBOARD_PANELS }));
        return false;
      }
    }
    revealMobilePanel(kind);
    return true;
  };

  const activateMobileChatTab = (profileId: string) => {
    setMobileTabKind("chat");
    const sessionId = activeSessionId.value;
    if (sessionId) {
      if (!activateDashboardContainingPanel("chat", { sessionId })) {
        const result = addDashboardPanel("chat", { sessionId });
        if (result === "full") {
          showPanelActionNote(t("dashboard.panelLimit", { count: MAX_DASHBOARD_PANELS }));
          return;
        }
      }
      openMobileWorkspace();
      revealMobilePanel("chat", sessionId);
      closeMobileProfiles();
      return;
    }
    if (createProfileSession(profileId)) revealMobilePanel("chat", activeSessionId.value);
    closeMobileProfiles();
  };

  const addPanelFromKeyboard = (kind: DashboardPanelKind) => {
    const result = addDashboardPanel(kind);
    if (result === "full") {
      showPanelActionNote(t("dashboard.panelLimit", { count: MAX_DASHBOARD_PANELS }));
      return;
    }
    if (panelActionNoteTimer.current !== undefined) window.clearTimeout(panelActionNoteTimer.current);
    panelActionNoteTimer.current = undefined;
    setPanelActionNote("");
    if (phoneViewport) closeMobileProfiles();
  };

  useEffect(() => () => {
    if (panelActionNoteTimer.current !== undefined) window.clearTimeout(panelActionNoteTimer.current);
  }, []);

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(max-width: 768px)");
    const sync = () => setPhoneViewport(query.matches);
    sync();
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", sync);
      return () => query.removeEventListener("change", sync);
    }
    query.addListener(sync);
    return () => query.removeListener(sync);
  }, []);

  const profileIdsKey = profileList.value.map((profile) => profile.id).join("|");
  useEffect(() => {
    reconcileSidebarProfileOrder(profileList.value.map((profile) => profile.id));
  }, [profileIdsKey]);

  void profileDisplayNameMap();
  const hasTeams = teams.value.length > 0;
  const groupMode = hasTeams && sidebarGroupMode.value === "teams" ? "teams" : "profiles";
  const orderedProfiles = sortProfilesBySidebarOrder(profileList.value);
  const visibleProfiles = orderedProfiles.slice(0, visibleProfileCount);
  const defaultProfile = profileList.value.find((profile) => profile.id === "default");
  const grouping = groupMode === "teams"
    ? groupProfilesByTeams(visibleProfiles, teams.value)
    : { mode: "flat" as const, profiles: visibleProfiles };
  const discoveredProjectGroups = groupSessionsByProject(
    sessions.value.filter((session) => !isScheduledSessionHidden(session)),
  );
  const projectGroups = sortProjectsBySidebarOrder(discoveredProjectGroups);
  const projectIdsKey = discoveredProjectGroups.map((group) => group.key).join("|");
  useEffect(() => {
    reconcileSidebarProjectOrder(discoveredProjectGroups.map((group) => group.key));
  }, [projectIdsKey]);

  const profilesRemaining = Math.max(0, orderedProfiles.length - visibleProfiles.length);
  const hasMoreProfiles = profilesRemaining > 0 || inventory.hasMore;

  const showMoreProfiles = async () => {
    const nextCount = visibleProfileCount + SIDEBAR_PROFILE_PAGE_SIZE;
    setVisibleProfileCount(nextCount);
    if (nextCount >= orderedProfiles.length && inventory.hasMore) await loadMoreProfiles();
  };

  const copy = {
    displayMode: t(sidebarMode.value === "rows" ? "sidebar.mode.cards" : "sidebar.mode.rows"),
    profileExpand: t("sidebar.sessionsShow"),
    profileCollapse: t("sidebar.sessionsHide"),
    resize: t("sidebar.resize"),
    resizeTitle: t("sidebar.resizeTitle"),
    sessionCount: (count: number) => t("sidebar.sessionCount", { count }),
  };

  const updateWidth = (event: PointerEvent) => {
    if (resizePointerId.current !== event.pointerId) return;
    previewSidebarWidth(event.clientX);
  };
  const finishResize = (event: PointerEvent) => {
    if (resizePointerId.current !== event.pointerId) return;
    resizePointerId.current = null;
    setSidebarWidth(sidebarWidth.value);
    if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const beginResize = (event: PointerEvent) => {
    if (event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) return;
    event.preventDefault();
    resizePointerId.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const openMobileProfiles = () => {
    setSidebarProfilesOpen(true);
  };

  const closeMobileProfiles = () => {
    setSidebarProfilesOpen(false);
  };

  const onProfileClick = (event: MouseEvent, profileId: string) => {
    if (event.altKey || event.metaKey || event.ctrlKey) {
      openProfileMenu(event, profileId);
      return;
    }
    // Icon-only mode has no session list; open the chat modal directly.
    if (iconOnly && !phoneViewport) {
      selectProfile(profileId, { openDetail: false });
      openProfileChatModal(profileId);
      closeMenu();
      return;
    }
    // Name row only toggles the session accordion when there are conversations.
    selectProfile(profileId, { openDetail: false });
    const hasSessions = sessions.value.some((session) => session.profileId === profileId);
    if (hasSessions) toggleSidebarProfileOpen(profileId);
    // On phones this row is the accordion control inside the profile sheet.
    // Keep the sheet open so the newly revealed conversations can be selected
    // or dragged; only a profile with no conversations closes the sheet.
    if (phoneViewport && !hasSessions) closeMobileProfiles();
    closeMenu();
  };

  const openProfileChat = (event: MouseEvent, profileId: string) => {
    event.preventDefault();
    event.stopPropagation();
    selectProfile(profileId, { openDetail: false });
    openProfileChatModal(profileId);
    if (phoneViewport) closeMobileProfiles();
    closeMenu();
  };

  const onProfileDragStart = (event: DragEvent, profileId: string) => {
    if (!(event.dataTransfer instanceof DataTransfer)) return;
    event.dataTransfer.setData("application/x-hermes-profile", profileId);
    event.dataTransfer.setData("text/plain", profileId);
    event.dataTransfer.effectAllowed = "move";
    setDragProfileId(profileId);
    setDropTargetId(null);
  };

  const onProfileDragOver = (event: DragEvent, profileId: string) => {
    if (!dragProfileId || dragProfileId === profileId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    if (dropTargetId !== profileId) setDropTargetId(profileId);
  };

  const onProfileDrop = (event: DragEvent, profileId: string) => {
    event.preventDefault();
    const sourceId = event.dataTransfer?.getData("application/x-hermes-profile")
      || event.dataTransfer?.getData("text/plain")
      || dragProfileId
      || "";
    if (!sourceId || sourceId === profileId) {
      setDragProfileId(null);
      setDropTargetId(null);
      return;
    }
    moveSidebarProfile(sourceId, profileId);
    setDragProfileId(null);
    setDropTargetId(null);
  };

  const onProfileDragEnd = () => {
    setDragProfileId(null);
    setDropTargetId(null);
  };

  const onProjectDragStart = (event: DragEvent, projectId: string) => {
    if (!(event.dataTransfer instanceof DataTransfer)) return;
    event.dataTransfer.setData("application/x-hermes-project", projectId);
    event.dataTransfer.setData("text/plain", projectId);
    event.dataTransfer.effectAllowed = "move";
    setDragProjectId(projectId);
    setDropProjectTargetId(null);
  };

  const onProjectDragOver = (event: DragEvent, projectId: string) => {
    if (!dragProjectId || dragProjectId === projectId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    if (dropProjectTargetId !== projectId) setDropProjectTargetId(projectId);
  };

  const onProjectDrop = (event: DragEvent, projectId: string) => {
    event.preventDefault();
    const sourceId = event.dataTransfer?.getData("application/x-hermes-project")
      || event.dataTransfer?.getData("text/plain")
      || dragProjectId
      || "";
    if (sourceId && sourceId !== projectId) moveSidebarProject(sourceId, projectId);
    setDragProjectId(null);
    setDropProjectTargetId(null);
  };

  const onProjectDragEnd = () => {
    setDragProjectId(null);
    setDropProjectTargetId(null);
  };

  const onSessionClick = (event: MouseEvent, sessionId: string, profileId: string) => {
    if (consumeSidebarSessionClickSuppression(sessionId)) return;
    if (event.altKey || event.metaKey || event.ctrlKey) {
      openSessionMenu(event, sessionId, profileId);
      return;
    }
    const result = selectDashboardChatSession(sessionId);
    if (result === "full") {
      showPanelActionNote(t("dashboard.panelLimit", { count: MAX_DASHBOARD_PANELS }));
      return;
    }
    if (result === "missing") return;
    if (phoneViewport) setMobileTabKind("chat");
    openMobileWorkspace();
    if (phoneViewport) revealMobilePanel("chat", sessionId);
    closeMenu();
    if (phoneViewport) closeMobileProfiles();
  };

  const onSessionKeyDown = (event: KeyboardEvent, sessionId: string) => {
    if (event.key !== "Enter" || !event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    const result = addDashboardPanel("chat", { sessionId });
    if (result === "full") {
      showPanelActionNote(t("dashboard.panelLimit", { count: MAX_DASHBOARD_PANELS }));
      return;
    }
    setMobileTabKind("chat");
    openMobileWorkspace();
    revealMobilePanel("chat", sessionId);
    if (phoneViewport) closeMobileProfiles();
  };

  const renderProfileEntry = (profile: Profile, entryKey: string) => {
    const displayName = profileDisplayName(profile);
    const secondaryName = profileSecondaryName(profile);
    const profileSessions = sessions.value.filter((session) => session.profileId === profile.id && !isScheduledSessionHidden(session));
    const hasSessions = profileSessions.length > 0;
    const sessionsOpen = hasSessions && isSidebarProfileOpen(profile.id);
    const isDragging = dragProfileId === profile.id;
    const isDropTarget = dropTargetId === profile.id && dragProfileId !== profile.id;
    return (
      <div
        class={`sidebar-profile-entry ${isDragging ? "is-dragging" : ""} ${isDropTarget ? "is-drop-target" : ""}`}
        key={entryKey}
        data-sessions-open={sessionsOpen ? "true" : "false"}
        data-profile-id={profile.id}
        onDragOver={(event) => onProfileDragOver(event, profile.id)}
        onDrop={(event) => onProfileDrop(event, profile.id)}
      >
        <div class={`sidebar-profile-row ${selectedProfileId.value === profile.id ? "is-active" : ""}`}>
          <button
            class="sidebar-profile-button"
            type="button"
            draggable
            aria-current={selectedProfileId.value === profile.id ? "true" : undefined}
            aria-expanded={hasSessions ? sessionsOpen : undefined}
            aria-label={`${displayName}${secondaryName ? ` (${secondaryName})` : ""}${hasSessions ? ` — ${sessionsOpen ? copy.profileCollapse : copy.profileExpand}` : ""}`}
            onClick={(event) => onProfileClick(event, profile.id)}
            onContextMenu={(event) => openProfileMenu(event, profile.id)}
            onDragStart={(event) => onProfileDragStart(event, profile.id)}
            onDragEnd={onProfileDragEnd}
          >
            <CharacterPortrait profileId={profile.id} profileName={displayName} class="character-portrait--sidebar" decorative />
            <span class="sidebar-profile-copy">
              <b>{displayName}</b>
              {secondaryName ? <small>{secondaryName}</small> : null}
              <TeamBadges profileId={profile.id} />
            </span>
            {hasSessions && (
              <span class="sidebar-profile-chevron" aria-hidden="true">{sessionsOpen ? "▾" : "▸"}</span>
            )}
            <StatusPill status={profile.status} />
          </button>
          <button
            class="sidebar-profile-chat"
            type="button"
            aria-label={t("sidebar.openChat")}
            title={t("sidebar.openChat")}
            onClick={(event) => openProfileChat(event, profile.id)}
          >
            <ChatIcon width={15} height={15} />
          </button>
          <button
            class="sidebar-item-menu-trigger"
            type="button"
            aria-label={t("sidebar.menu.trigger")}
            title={t("sidebar.menu.trigger")}
            onClick={(event) => openProfileMenu(event, profile.id)}
          >⋯</button>
        </div>
        {sessionsOpen && hasSessions && (
          <div class="sidebar-session-list" aria-label={copy.sessionCount(profileSessions.length)}>
            {profileSessions.map((session) => {
              const isOpen = openSessionIds.value.includes(session.id);
              return (
                <div
                  key={session.id}
                  class={`sidebar-session-row ${isOpen ? "is-open" : ""} ${activeSessionId.value === session.id ? "is-active" : ""}`}
                >
                  <button
                    class="sidebar-session"
                    type="button"
                    data-session-id={session.id}
                    style={isOpen ? { "--session-color": profile.color } : undefined}
                    aria-current={activeSessionId.value === session.id ? "true" : undefined}
                    aria-keyshortcuts="Shift+Enter"
                    aria-label={`${displayName} — ${chatSessionTitle(session)}${session.conversationKind === "delegated" ? ` — ${t("profile.delegatedChat")}` : ""}`}
                    onClick={(event) => onSessionClick(event, session.id, profile.id)}
                    onKeyDown={(event) => onSessionKeyDown(event, session.id)}
                    onContextMenu={(event) => openSessionMenu(event, session.id, profile.id)}
                    onPointerDown={(event) => {
                      if (event.pointerType === "mouse") beginSidebarSessionPointerDrag(event, session.id);
                    }}
                  >
                    <i
                      aria-hidden="true"
                      onPointerDown={(event) => {
                        if (event.pointerType === "mouse") return;
                        event.stopPropagation();
                        beginSidebarSessionPointerDrag(event, session.id);
                      }}
                    />
                    <span>
                      {chatSessionTitle(session)}
                      {session.conversationKind === "delegated" && <em class="delegated-chat-badge">{t("profile.delegatedChat")}</em>}
                    </span>
                    <small>{session.status === "streaming" ? t("profile.running") : isOpen ? t("profile.open") : "·"}</small>
                    {isOpen && <em aria-hidden="true">●</em>}
                  </button>
                  <button
                    class="sidebar-item-menu-trigger sidebar-session-delete"
                    type="button"
                    aria-label={t("chat.sessionDelete")}
                    title={t("chat.sessionDelete")}
                    onClick={() => setSessionDeleteRequestId(session.id)}
                  ><TrashIcon width={14} height={14} /></button>
                  <button
                    class="sidebar-item-menu-trigger"
                    type="button"
                    aria-label={t("sidebar.menu.trigger")}
                    title={t("sidebar.menu.trigger")}
                    onClick={(event) => openSessionMenu(event, session.id, profile.id)}
                  >⋯</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const renderGroup = (group: ProfileTeamGroup<Profile>) => (
    <section
      key={group.key}
      class={`profile-group ${group.kind === "unassigned" ? "profile-group--unassigned" : ""}`}
      aria-label={group.kind === "team" ? group.name : t("team.group.unassigned")}
    >
      <header
        class="profile-group-header"
        style={group.kind === "team" ? { "--team-color": group.color } : undefined}
      >
        <i aria-hidden="true" />
        <b title={group.kind === "team" ? group.name : t("team.group.unassigned")}>
          {group.kind === "team" ? group.name : t("team.group.unassigned")}
        </b>
        <small>{t("team.group.count", { count: group.profiles.length })}</small>
      </header>
      <div class="profile-group-body">
        {group.profiles.map((profile) => renderProfileEntry(profile, profileGroupItemKey(group.key, profile.id)))}
      </div>
    </section>
  );

  const renderProjectSession = (session: ChatSession) => {
    const profile = profileList.value.find((item) => item.id === session.profileId);
    const displayName = profile ? profileDisplayName(profile) : session.profileId;
    const isOpen = openSessionIds.value.includes(session.id);
    return (
      <div
        key={`${session.profileId}\0${session.id}`}
        class={`sidebar-session-row ${isOpen ? "is-open" : ""} ${activeSessionId.value === session.id ? "is-active" : ""}`}
      >
        <button
          class="sidebar-session"
          type="button"
          data-session-id={session.id}
          style={isOpen && profile ? { "--session-color": profile.color } : undefined}
          aria-current={activeSessionId.value === session.id ? "true" : undefined}
          aria-keyshortcuts="Shift+Enter"
          aria-label={`${displayName} — ${chatSessionTitle(session)}${session.conversationKind === "delegated" ? ` — ${t("profile.delegatedChat")}` : ""}`}
          onClick={(event) => onSessionClick(event, session.id, session.profileId)}
          onKeyDown={(event) => onSessionKeyDown(event, session.id)}
          onContextMenu={(event) => openSessionMenu(event, session.id, session.profileId)}
          onPointerDown={(event) => {
            if (event.pointerType === "mouse") beginSidebarSessionPointerDrag(event, session.id);
          }}
        >
          <i
            aria-hidden="true"
            onPointerDown={(event) => {
              if (event.pointerType === "mouse") return;
              event.stopPropagation();
              beginSidebarSessionPointerDrag(event, session.id);
            }}
          />
          <span>
            {chatSessionTitle(session)}
            {session.conversationKind === "delegated" && <em class="delegated-chat-badge">{t("profile.delegatedChat")}</em>}
          </span>
          <small>{displayName}{session.status === "streaming" ? ` · ${t("profile.running")}` : ""}</small>
          {isOpen && <em aria-hidden="true">●</em>}
        </button>
        <button
          class="sidebar-item-menu-trigger sidebar-session-delete"
          type="button"
          aria-label={t("chat.sessionDelete")}
          title={t("chat.sessionDelete")}
          onClick={() => setSessionDeleteRequestId(session.id)}
        ><TrashIcon width={14} height={14} /></button>
        <button
          class="sidebar-item-menu-trigger"
          type="button"
          aria-label={t("sidebar.menu.trigger")}
          title={t("sidebar.menu.trigger")}
          onClick={(event) => openSessionMenu(event, session.id, session.profileId)}
        >⋯</button>
      </div>
    );
  };

  const renderProjectGroup = (group: ProjectSessionGroup) => {
    const label = group.kind === "project" ? group.name : t("project.group.unassigned");
    const open = isSidebarProjectOpen(group.key);
    const dragging = dragProjectId === group.key;
    const dropTarget = dropProjectTargetId === group.key && dragProjectId !== group.key;
    return (
      <section
        key={group.key}
        class={`profile-group project-session-group ${group.kind === "unassigned" ? "profile-group--unassigned" : ""} ${dragging ? "is-dragging" : ""} ${dropTarget ? "is-drop-target" : ""}`}
        aria-label={label}
        onDragOver={(event) => onProjectDragOver(event, group.key)}
        onDrop={(event) => onProjectDrop(event, group.key)}
      >
        <button
          type="button"
          class="profile-group-header project-group-header-button"
          draggable
          aria-expanded={open}
          title={label}
          onClick={() => toggleSidebarProjectOpen(group.key)}
          onDragStart={(event) => onProjectDragStart(event, group.key)}
          onDragEnd={onProjectDragEnd}
        >
          <i aria-hidden="true" />
          <b>{label}</b>
          <small>{t("project.group.count", { count: group.sessions.length })}</small>
          <span class="sidebar-profile-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
        </button>
        {open && (
          <div class="sidebar-session-list sidebar-project-session-list" aria-label={copy.sessionCount(group.sessions.length)}>
            {group.sessions.map(renderProjectSession)}
          </div>
        )}
      </section>
    );
  };

  const activeSidebarTasks = tasks.value
    .filter((task) => task.status !== "done" && task.status !== "archived")
    .slice()
    .sort((left, right) => {
      const rank = (status: string): number => {
        switch (status) {
          case "blocked": return 0;
          case "running": return 1;
          case "review": return 2;
          case "ready": return 3;
          case "triage": return 4;
          case "todo": return 5;
          case "scheduled": return 6;
          default: return 9;
        }
      };
      const byStatus = rank(left.status) - rank(right.status);
      if (byStatus !== 0) return byStatus;
      return left.title.localeCompare(right.title);
    });
  const kanbanTaskTree = !iconOnly ? (
    <section
      class={`sidebar-tasks sidebar-tasks--nested${sidebarTasksOpen.value ? "" : " is-collapsed"}`}
      aria-label={t("sidebar.tasks")}
    >
      {sidebarTasksOpen.value && <div id="sidebar-tasks-list" class="sidebar-tasks-list">
        {activeSidebarTasks.length === 0 ? (
          <p class="sidebar-tasks-empty">{t("sidebar.tasksEmpty")}</p>
        ) : activeSidebarTasks.map((task) => (
          <div key={task.id} class="sidebar-task-row">
            <button
              type="button"
              class="sidebar-task-button"
              disabled={task.pending}
              onClick={() => {
                if (activateOrAddPanelFromClick("kanban")) focusKanbanTask(task.id);
              }}
              aria-label={t("kanban.detailOpenAria", { title: task.title })}
              title={t("kanban.detailOpenAria", { title: task.title })}
            >
              <b>{task.title}</b>
              <small>
                {sidebarTaskStatusLabel(task.status)}
                {" · "}
                {task.assigneeId
                  ? sidebarTaskAssigneeName(task.assigneeId, profileList.value)
                  : t("kanban.unassigned")}
              </small>
            </button>
            <button
              type="button"
              class="sidebar-task-delete"
              disabled={task.pending || taskDeleteBusy}
              aria-label={t("sidebar.taskDelete", { title: task.title })}
              title={t("sidebar.taskDelete", { title: task.title })}
              onClick={() => requestTaskDelete(task)}
            >
              <TrashIcon />
            </button>
          </div>
        ))}
      </div>}
    </section>
  ) : null;
  const teamTree = !iconOnly ? (
    <section
      class={`sidebar-nav-tree sidebar-teams--nested${sidebarTeamsOpen.value ? "" : " is-collapsed"}`}
      aria-label={t("nav.teams")}
    >
      {sidebarTeamsOpen.value && <div id="sidebar-teams-list" class="sidebar-team-list">
        {teams.value.length === 0 ? (
          <p class="sidebar-nav-tree-empty">{t("teams.empty")}</p>
        ) : teams.value.map((team) => (
          <button
            key={team.id}
            type="button"
            class="sidebar-team-button"
            style={{ "--team-color": team.color }}
            aria-label={`${team.name}, ${t("teams.memberCount", { count: team.memberProfileIds.length })}`}
            title={team.name}
            onClick={() => activateOrAddPanelFromClick("teams")}
          >
            <i aria-hidden="true" />
            <b>{team.name}</b>
            <small>{t("teams.memberCount", { count: team.memberProfileIds.length })}</small>
          </button>
        ))}
      </div>}
    </section>
  ) : null;
  const profileTree = (
    <section
      id="sidebar-profiles-sheet"
      class={`sidebar-profiles sidebar-profiles--nested${sidebarProfilesOpen.value ? "" : " is-collapsed"}`}
      aria-labelledby="sidebar-profiles-title"
    >
      {sidebarProfilesOpen.value && (
        <>
          {hasTeams && <header class="sidebar-section-head sidebar-profile-tools">
              <div class="sidebar-section-head-tools">
                <div class="profile-group-toggle" role="group" aria-label={t("sidebar.group.aria")}>
                  <button
                    type="button"
                    class={groupMode === "profiles" ? "is-active" : ""}
                    aria-pressed={groupMode === "profiles"}
                    title={t("sidebar.group.profiles")}
                    aria-label={t("sidebar.group.profiles")}
                    onClick={() => setSidebarGroupMode("profiles")}
                  ><ListIcon /></button>
                  <button
                    type="button"
                    class={groupMode === "teams" ? "is-active" : ""}
                    aria-pressed={groupMode === "teams"}
                    title={t("sidebar.group.teams")}
                    aria-label={t("sidebar.group.teams")}
                    onClick={() => setSidebarGroupMode("teams")}
                  ><GroupIcon /></button>
                </div>
              </div>
            </header>}
          <div class="sidebar-profile-list">
            {grouping.mode === "flat"
              ? grouping.profiles.map((profile) => renderProfileEntry(profile, profile.id))
              : grouping.groups.map((group) => renderGroup(group))}
            {profileList.value.length === 0 && <p class="sidebar-profile-empty">-</p>}
          </div>
          {hasMoreProfiles && !iconOnly && (
            <button
              class="sidebar-more"
              type="button"
              disabled={inventory.loading}
              onClick={() => void showMoreProfiles()}
            >
              {inventory.loading ? t("inventory.loading") : t("sidebar.loadMore")}
            </button>
          )}
          {inventory.error && !iconOnly && (
            <small class="inventory-note inventory-note--error">
              {localizeRuntimeMessage(inventory.error)}
            </small>
          )}
        </>
      )}
    </section>
  );
  const projectTree = !iconOnly ? (
    <section
      id="sidebar-projects-tree"
      class={`sidebar-nav-tree sidebar-projects--nested${sidebarProjectsOpen.value ? "" : " is-collapsed"}`}
      aria-labelledby="sidebar-projects-title"
    >
      {sidebarProjectsOpen.value && (
        <>
          <div class="sidebar-project-list">
            {projectGroups.map(renderProjectGroup)}
            {projectGroups.length === 0 && <p class="sidebar-nav-tree-empty">-</p>}
          </div>
          {sessionInventory.hasMore && (
            <button class="sidebar-more" type="button" disabled={sessionInventory.loading} onClick={() => void loadMoreSessions()}>
              {sessionInventory.loading ? t("inventory.loading") : t("inventory.showMore")}
            </button>
          )}
          {sessionInventory.error && (
            <small class="inventory-note inventory-note--error">{localizeRuntimeMessage(sessionInventory.error)}</small>
          )}
        </>
      )}
    </section>
  ) : null;

  return (
    <nav
      class="side-rail"
      aria-label={t("nav.main")}
      data-mobile-route-chrome
      data-sidebar-mode={sidebarMode.value}
      data-sidebar-icon-only={iconOnly ? "true" : "false"}
      data-sidebar-tasks-open={sidebarTasksOpen.value ? "true" : "false"}
      data-sidebar-teams-open={sidebarTeamsOpen.value ? "true" : "false"}
      data-sidebar-profiles-open={sidebarProfilesOpen.value ? "true" : "false"}
      data-sidebar-projects-open={sidebarProjectsOpen.value ? "true" : "false"}
      data-mobile-profiles-open={phoneViewport && sidebarProfilesOpen.value ? "true" : "false"}
      data-mobile-chat-available={phoneViewport && defaultProfile ? "true" : "false"}
      data-sidebar-group={groupMode}
    >
      <section class="sidebar-dashboards" aria-label={t("dashboard.listAria")}>
        <header class="sidebar-section-head">
          <b class="sidebar-dashboards-title">{iconOnly ? "" : t("dashboard.list")}</b>
          <button
            class="sidebar-dashboard-add"
            type="button"
            disabled={dashboards.value.length >= MAX_DASHBOARDS}
            aria-label={t("dashboard.create")}
            title={t("dashboard.create")}
            onClick={() => {
              createDashboardWithDefaultChat();
            }}
          >＋</button>
        </header>
        <div class="sidebar-dashboard-list" role="listbox" aria-label={t("dashboard.listAria")}>
          {dashboards.value.map((dashboard, index) => {
            const isActive = dashboard.id === activeDashboardId.value;
            const name = dashboard.name || t("dashboard.unnamed", { index: index + 1 });
            if (renamingDashboardId === dashboard.id) {
              return (
                <form
                  key={dashboard.id}
                  class="sidebar-dashboard-rename"
                  onSubmit={(event) => {
                    event.preventDefault();
                    renameDashboard(dashboard.id, renameDraft);
                    setRenamingDashboardId(null);
                  }}
                >
                  <input
                    value={renameDraft}
                    aria-label={t("dashboard.rename")}
                    // eslint-disable-next-line jsx-a11y/no-autofocus -- inline rename field
                    autoFocus
                    onInput={(event) => setRenameDraft(event.currentTarget.value)}
                    onBlur={() => {
                      renameDashboard(dashboard.id, renameDraft);
                      setRenamingDashboardId(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setRenamingDashboardId(null);
                    }}
                  />
                </form>
              );
            }
            return (
              <div key={dashboard.id} class={`sidebar-dashboard-row ${isActive ? "is-active" : ""}`}>
                <button
                  class="sidebar-dashboard-button"
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  aria-current={isActive ? "page" : undefined}
                  title={name}
                  onClick={() => {
                    activateDashboard(dashboard.id);
                    if (phoneViewport) closeMobileProfiles();
                  }}
                  onDblClick={() => {
                    if (phoneViewport) return;
                    setRenameDraft(dashboard.name);
                    setRenamingDashboardId(dashboard.id);
                  }}
                >
                  <span aria-hidden="true"><CardsIcon /></span>
                  {!iconOnly && <b>{name}</b>}
                </button>
                {!iconOnly && !phoneViewport && (
                  <button
                    class="sidebar-item-menu-trigger sidebar-dashboard-rename-trigger"
                    type="button"
                    aria-label={t("dashboard.rename")}
                    title={t("dashboard.rename")}
                    onClick={() => {
                      setRenameDraft(dashboard.name);
                      setRenamingDashboardId(dashboard.id);
                    }}
                  >✎</button>
                )}
                {!iconOnly && !phoneViewport && dashboards.value.length > 1 && (
                  <button
                    class="sidebar-item-menu-trigger sidebar-dashboard-delete"
                    type="button"
                    aria-label={t("dashboard.delete")}
                    title={t("dashboard.delete")}
                    onClick={() => {
                      setDashboardDeleteRequest({ id: dashboard.id, name });
                    }}
                  >×</button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <div class="side-rail-rule" aria-hidden="true" />

      <div class="side-rail-nav" role="group" aria-label={t("dashboard.addPanelGroup")}>
        {panelNavItems.map((item) => {
          const present = activeDashboard.value.panels.some((panel) => panel.kind === item.kind);
          const selected = phoneViewport ? mobileTabKind === item.kind : present;
          const available = dashboards.value.some((dashboard) => dashboard.panels.some((panel) => panel.kind === item.kind));
          const label = t(item.label);
          const dragLabel = t("dashboard.dragPanelFromSidebar", { label });
          const keyboardAddLabel = t("dashboard.keyboardAddPanel", { label });
          const actionLabel = `${available ? `${t("dashboard.openPanel", { label })} / ${dragLabel}` : dragLabel} / ${keyboardAddLabel}`;
          const disclosureOpen = item.kind === "kanban"
            ? sidebarTasksOpen.value
            : item.kind === "teams"
              ? sidebarTeamsOpen.value
              : item.kind === "profiles"
                ? sidebarProfilesOpen.value
                : undefined;
          const disclosureId = item.kind === "kanban"
            ? "sidebar-tasks-list"
            : item.kind === "teams"
              ? "sidebar-teams-list"
              : item.kind === "profiles"
                ? "sidebar-profiles-sheet"
                : undefined;
          const disclosureCount = item.kind === "kanban"
            ? activeSidebarTasks.length
            : item.kind === "teams"
              ? teams.value.length
              : item.kind === "profiles"
                ? profileList.value.length
                : undefined;
          const hasDisclosure = disclosureOpen !== undefined
            && (!iconOnly || (phoneViewport && item.kind === "profiles"));
          const navButton = (
            <button
              id={item.kind === "profiles" ? "sidebar-profiles-title" : undefined}
              type="button"
              class={`sidebar-nav-button ${selected ? "is-active" : ""}${hasDisclosure ? " has-disclosure" : ""}`}
              data-panel-kind={item.kind}
              data-dashboard-available={available ? "true" : "false"}
              aria-current={selected ? "page" : undefined}
              aria-expanded={hasDisclosure ? disclosureOpen : undefined}
              aria-controls={hasDisclosure ? disclosureId : undefined}
              aria-keyshortcuts={phoneViewport ? undefined : "Shift+Enter"}
              title={phoneViewport ? label : actionLabel}
              aria-label={phoneViewport ? label : actionLabel}
              onClick={() => {
                if (consumeSidebarPanelClickSuppression(item.kind)) return;
                if (phoneViewport) {
                  activateMobileTab(item.kind);
                  if (item.kind === "profiles") {
                    if (sidebarProfilesOpen.value) closeMobileProfiles();
                    else openMobileProfiles();
                  } else {
                    closeMobileProfiles();
                  }
                  return;
                }
                activateOrAddPanelFromClick(item.kind);
                if (item.kind === "kanban" && !iconOnly) setSidebarTasksOpen(!sidebarTasksOpen.value);
                if (item.kind === "teams" && !iconOnly) setSidebarTeamsOpen(!sidebarTeamsOpen.value);
                if (item.kind === "profiles" && (!iconOnly || phoneViewport)) {
                  if (phoneViewport) {
                    if (sidebarProfilesOpen.value) closeMobileProfiles();
                    else openMobileProfiles();
                  } else {
                    setSidebarProfilesOpen(!sidebarProfilesOpen.value);
                  }
                } else if (phoneViewport) {
                  closeMobileProfiles();
                }
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !event.shiftKey) return;
                event.preventDefault();
                event.stopPropagation();
                addPanelFromKeyboard(item.kind);
              }}
              onPointerDown={(event) => beginSidebarPanelPointerDrag(event, item.kind)}
            >
              <span aria-hidden="true"><item.icon /></span>
              {(!iconOnly || phoneViewport) && <b>{label}</b>}
              {hasDisclosure && (
                <>
                  <small class="sidebar-nav-count" aria-hidden="true">{disclosureCount}</small>
                  <span class="sidebar-nav-chevron" aria-hidden="true">{disclosureOpen ? "▾" : "▸"}</span>
                </>
              )}
            </button>
          );
          return (
            <Fragment key={item.kind}>
              {item.kind === "profiles" && !iconOnly ? (
                <div class="sidebar-profile-nav-row">
                  {navButton}
                  <button
                    class="sidebar-display-toggle sidebar-profile-inline-display"
                    type="button"
                    aria-label={copy.displayMode}
                    title={copy.displayMode}
                    aria-pressed={sidebarMode.value === "rows"}
                    onClick={() => setSidebarMode(sidebarMode.value === "rows" ? "cards" : "rows")}
                  >{sidebarMode.value === "rows" ? <CardsIcon /> : <ListIcon />}</button>
                </div>
              ) : navButton}
              {item.kind === "kanban" && kanbanTaskTree}
              {item.kind === "teams" && teamTree}
              {item.kind === "profiles" && profileTree}
            </Fragment>
          );
        })}
        <button
          id="sidebar-projects-title"
          type="button"
          class="sidebar-nav-button sidebar-projects-trigger has-disclosure"
          aria-expanded={sidebarProjectsOpen.value}
          aria-controls="sidebar-projects-tree"
          title={t("sidebar.projects")}
          aria-label={t("sidebar.projects")}
          onClick={() => setSidebarProjectsOpen(!sidebarProjectsOpen.value)}
        >
          <span aria-hidden="true"><FolderIcon /></span>
          {!iconOnly && <b>{t("sidebar.projects")}</b>}
          {!iconOnly && (
            <>
              <small class="sidebar-nav-count" aria-hidden="true">{projectGroups.length}</small>
              <span class="sidebar-nav-chevron" aria-hidden="true">{sidebarProjectsOpen.value ? "▾" : "▸"}</span>
            </>
          )}
        </button>
        {projectTree}
      </div>

      <p class="sidebar-panel-action-note" role="status" aria-live="polite" aria-atomic="true">
        {panelActionNote}
      </p>

      {sessionDeleteRequestId && (() => {
        const session = sessions.value.find((item) => item.id === sessionDeleteRequestId);
        return session
          ? <SessionDeleteDialog session={session} onClose={() => setSessionDeleteRequestId(null)} />
          : null;
      })()}

      {dashboardDeleteRequest && (
        <div
          class="scheduled-delete-dialog-layer"
          role="presentation"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            class="scheduled-delete-dialog-scrim"
            aria-label={t("common.cancel")}
            onClick={() => setDashboardDeleteRequest(null)}
          />
          <section
            ref={dashboardDeleteOverlay.ref}
            class="scheduled-delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="sidebar-dashboard-delete-title"
            aria-describedby="sidebar-dashboard-delete-message"
            tabIndex={-1}
          >
            <header>
              <TrashIcon />
              <h2 id="sidebar-dashboard-delete-title">{t("dashboard.delete")}</h2>
            </header>
            <div id="sidebar-dashboard-delete-message" class="scheduled-delete-dialog-message">
              <p>{t("dashboard.deleteConfirm", { name: dashboardDeleteRequest.name })}</p>
            </div>
            <footer>
              <button
                type="button"
                class="quiet-button"
                data-mobile-overlay-initial-focus
                onClick={() => setDashboardDeleteRequest(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                class="scheduled-delete-dialog-confirm"
                onClick={() => {
                  const dashboardId = dashboardDeleteRequest.id;
                  setDashboardDeleteRequest(null);
                  deleteDashboardWithActivation(dashboardId);
                }}
              >
                <TrashIcon />
                <span>{t("dashboard.delete")}</span>
              </button>
            </footer>
          </section>
        </div>
      )}

      {taskDeleteRequest && (
        <div
          class="scheduled-delete-dialog-layer"
          role="presentation"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            class="scheduled-delete-dialog-scrim"
            aria-label={t("common.cancel")}
            disabled={taskDeleteBusy}
            onClick={() => {
              if (!taskDeleteBusy) setTaskDeleteRequest(null);
            }}
          />
          <section
            ref={taskDeleteOverlay.ref}
            class="scheduled-delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="sidebar-task-delete-title"
            aria-describedby="sidebar-task-delete-message"
            tabIndex={-1}
          >
            <header>
              <TrashIcon />
              <h2 id="sidebar-task-delete-title">{t("sidebar.taskDeleteTitle")}</h2>
            </header>
            <div id="sidebar-task-delete-message" class="scheduled-delete-dialog-message">
              <p>{t("sidebar.taskDeleteConfirm", { title: taskDeleteRequest.title })}</p>
              <p>{t("sidebar.taskDeleteNote")}</p>
            </div>
            {taskDeleteFailed && <p class="scheduled-delete-error" role="alert">{t("sidebar.taskDeleteFailed")}</p>}
            <footer>
              <button
                type="button"
                class="quiet-button"
                disabled={taskDeleteBusy}
                data-mobile-overlay-initial-focus
                onClick={() => setTaskDeleteRequest(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                class="scheduled-delete-dialog-confirm"
                disabled={taskDeleteBusy}
                onClick={() => void confirmTaskDelete()}
              >
                <TrashIcon />
                <span>{taskDeleteBusy ? t("sidebar.taskDeleting") : t("sidebar.taskDeleteAction")}</span>
              </button>
            </footer>
          </section>
        </div>
      )}

      {phoneViewport && defaultProfile && (
        <button
          class={`sidebar-default-chat-trigger ${mobileTabKind === "chat" ? "is-active" : ""}`}
          type="button"
          aria-current={mobileTabKind === "chat" ? "page" : undefined}
          aria-label={activeSessionId.value
            ? t("sidebar.currentChatOpen")
            : t("sidebar.defaultChatStart", { name: profileDisplayName(defaultProfile) })}
          title={activeSessionId.value
            ? t("sidebar.currentChatOpen")
            : t("sidebar.defaultChatStart", { name: profileDisplayName(defaultProfile) })}
          onClick={() => activateMobileChatTab(defaultProfile.id)}
        >
          <span aria-hidden="true"><ChatIcon /></span>
          <b>{t("dashboard.panel.chat")}</b>
        </button>
      )}

      <div
        class="sidebar-resize-handle"
        role="separator"
        tabIndex={0}
        aria-label={copy.resize}
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={sidebarWidth.value}
        title={copy.resizeTitle}
        onPointerDown={beginResize}
        onPointerMove={updateWidth}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={finishResize}
        onKeyDown={(event) => {
          if (event.key === "Home") { event.preventDefault(); setSidebarWidth(SIDEBAR_MIN_WIDTH); }
          if (event.key === "End") { event.preventDefault(); setSidebarWidth(SIDEBAR_MAX_WIDTH); }
          if (event.key === "ArrowLeft") { event.preventDefault(); setSidebarWidth(sidebarWidth.value - 16); }
          if (event.key === "ArrowRight") { event.preventDefault(); setSidebarWidth(sidebarWidth.value + 16); }
        }}
      >
        <span aria-hidden="true" />
      </div>

      {menu && (
        <ProfileContextMenu
          menu={menu}
          menuRef={menuRef}
          onClose={closeMenu}
          onOpenSession={openMenuSession}
          onDeleteSession={setSessionDeleteRequestId}
        />
      )}

      {sidebarWidth.value <= SIDEBAR_ICON_THRESHOLD && <span class="visually-hidden" aria-live="polite">{t("sidebar.iconOnly")}</span>}
    </nav>
  );
}
