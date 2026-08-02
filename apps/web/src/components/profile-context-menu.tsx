import { useEffect, useRef, useState } from "preact/hooks";
import type { Ref } from "preact";
import type { ChatSession } from "../domain";
import { chatSessionTitle, locale, t } from "../i18n";
import { loadAllSessions, requestInventorySnapshotRefresh } from "../inventory";
import { profileDisplayName, profileSecondaryName } from "../profile-names";
import {
  closeSession,
  openMobileWorkspace,
  openProfileChatModal,
  openProfileSettingsModal,
  openSession,
  openSessionIds,
  profileList,
  selectProfile,
  sessions,
} from "../store";
import { isScheduledSessionHidden } from "../scheduled-sessions";
import {
  isSidebarProfileOpen,
  setSidebarProfileOpen,
} from "../sidebar-layout";
import { createProfileSession } from "./profile-panel";
import { SessionsDeleteDialog } from "./session-delete-dialog";

export type ProfileContextMenuState =
  | { kind: "profile"; profileId: string; left: number; top: number }
  | { kind: "session"; sessionId: string; profileId: string; left: number; top: number };

const MENU_WIDTH = 260;
const MENU_MAX_HEIGHT = 360;
const MAX_MENU_SESSIONS = 8;

export function menuPositionFromPointer(clientX: number, clientY: number): { left: number; top: number } {
  return {
    left: Math.min(clientX, Math.max(8, window.innerWidth - MENU_WIDTH - 8)),
    top: Math.min(clientY, Math.max(8, window.innerHeight - 120)),
  };
}

export function menuPositionFromEvent(event: MouseEvent | PointerEvent): { left: number; top: number } {
  return menuPositionFromPointer(event.clientX, event.clientY);
}

/**
 * Shared profile/session context menu state: outside click, Escape, and
 * viewport clamping after first paint.
 */
export function useProfileContextMenu() {
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<ProfileContextMenuState | null>(null);

  useEffect(() => {
    if (!menu) return;
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".profile-context-menu")) setMenu(null);
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", closeOnPointer);
    window.addEventListener("keydown", closeOnKey);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointer);
      window.removeEventListener("keydown", closeOnKey);
    };
  }, [menu]);

  useEffect(() => {
    if (!menu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
    const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
    const nextLeft = Math.min(Math.max(8, menu.left), maxLeft);
    const nextTop = Math.min(Math.max(8, menu.top), maxTop);
    if (nextLeft !== menu.left || nextTop !== menu.top) {
      setMenu({ ...menu, left: nextLeft, top: nextTop });
    }
  }, [menu?.kind, menu && ("sessionId" in menu ? menu.sessionId : menu.profileId), menu?.left, menu?.top]);

  const openProfileMenu = (event: MouseEvent | PointerEvent, profileId: string) => {
    event.preventDefault();
    event.stopPropagation();
    // Selection only — do not open chat/detail modals from a context-menu gesture.
    selectProfile(profileId, { openDetail: false });
    setMenu({ kind: "profile", profileId, ...menuPositionFromEvent(event) });
  };

  const openSessionMenu = (event: MouseEvent | PointerEvent, sessionId: string, profileId: string) => {
    event.preventDefault();
    event.stopPropagation();
    selectProfile(profileId, { openDetail: false });
    setMenu({ kind: "session", sessionId, profileId, ...menuPositionFromEvent(event) });
  };

  const openMenuSession = (sessionId: string) => {
    openSession(sessionId);
    openMobileWorkspace();
    setMenu(null);
  };

  return {
    menu,
    menuRef,
    setMenu,
    closeMenu: () => setMenu(null),
    openProfileMenu,
    openSessionMenu,
    openMenuSession,
  };
}

export function ProfileContextMenu({
  menu,
  menuRef,
  onClose,
  onOpenSession,
  onDeleteSession,
}: {
  menu: ProfileContextMenuState;
  menuRef: Ref<HTMLDivElement>;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
}) {
  void locale.value; // re-render when display language changes
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [deleteRequest, setDeleteRequest] = useState<{ sessions: readonly ChatSession[]; all: boolean } | null>(null);
  const [deleteAllLoading, setDeleteAllLoading] = useState(false);
  const [deleteAllLoadFailed, setDeleteAllLoadFailed] = useState(false);
  const profile = profileList.value.find((item) => item.id === menu.profileId);
  const displayName = profile ? profileDisplayName(profile) : menu.profileId;
  const secondaryName = profile ? profileSecondaryName(profile) : "";
  const profileSessions = sessions.value.filter((session) => session.profileId === menu.profileId && !isScheduledSessionHidden(session));
  const sessionsOpen = isSidebarProfileOpen(menu.profileId);

  useEffect(() => {
    setSelectedSessionIds([]);
    setDeleteRequest(null);
    setDeleteAllLoading(false);
    setDeleteAllLoadFailed(false);
  }, [menu.kind, menu.profileId, menu.kind === "session" ? menu.sessionId : ""]);

  if (menu.kind === "session") {
    const session = sessions.value.find((item) => item.id === menu.sessionId);
    if (!session) return null;
    const title = chatSessionTitle(session);
    const isOpen = openSessionIds.value.includes(session.id);
    return (
      <div
        ref={menuRef}
        class="profile-context-menu"
        role="menu"
        aria-label={t("sidebar.menu.aria", { name: title })}
        style={{ left: `${menu.left}px`, top: `${menu.top}px`, maxHeight: `${MENU_MAX_HEIGHT}px` }}
      >
        <p class="profile-context-menu-kicker">{t("sidebar.menu.threadLabel")}</p>
        <p class="profile-context-menu-title" title={title}>{title}</p>
        {secondaryName || displayName ? (
          <p class="profile-context-menu-subtitle">{displayName}{secondaryName ? ` · ${secondaryName}` : ""}</p>
        ) : null}
        <div class="profile-context-menu-divider" role="separator" />
        <button type="button" role="menuitem" onClick={() => onOpenSession(session.id)}>
          {t("profile.openInWorkspace")}
          {session.status === "streaming" ? <small>{t("profile.running")}</small> : isOpen ? <small>{t("profile.open")}</small> : null}
        </button>
        <button type="button" role="menuitem" onClick={() => { openProfileChatModal(menu.profileId, { sessionId: session.id }); onClose(); }}>
          {t("sidebar.openChat")}
        </button>
        {isOpen && (
          <button type="button" role="menuitem" onClick={() => { closeSession(session.id); onClose(); }}>
            {t("sidebar.menu.closeSession")}
          </button>
        )}
        <div class="profile-context-menu-divider" role="separator" />
        <button type="button" role="menuitem" onClick={() => { selectProfile(menu.profileId, { openDetail: false }); createProfileSession(menu.profileId); onClose(); }}>
          {t("sidebar.menu.newChat")}
        </button>
        <button type="button" role="menuitem" onClick={() => { openProfileSettingsModal(menu.profileId); onClose(); }}>
          {t("sidebar.menu.settings")}
        </button>
        {onDeleteSession && (
          <>
            <div class="profile-context-menu-divider" role="separator" />
            <button
              type="button"
              class="profile-context-menu-danger"
              role="menuitem"
              onClick={() => {
                onDeleteSession(session.id);
                onClose();
              }}
            >
              {t("chat.sessionDelete")}
            </button>
          </>
        )}
        <button type="button" role="menuitem" onClick={onClose}>
          {t("common.close")}
        </button>
      </div>
    );
  }

  const visibleSessions = profileSessions.slice(0, MAX_MENU_SESSIONS);
  const hiddenCount = Math.max(0, profileSessions.length - visibleSessions.length);
  const selectedSessions = profileSessions.filter((session) => selectedSessionIds.includes(session.id));

  const toggleSessionSelection = (sessionId: string) => {
    setSelectedSessionIds((current) => current.includes(sessionId)
      ? current.filter((id) => id !== sessionId)
      : [...current, sessionId]);
  };

  const requestDeleteAll = async () => {
    if (deleteAllLoading) return;
    setDeleteAllLoading(true);
    setDeleteAllLoadFailed(false);
    await requestInventorySnapshotRefresh();
    const complete = await loadAllSessions();
    setDeleteAllLoading(false);
    if (!complete) {
      setDeleteAllLoadFailed(true);
      return;
    }
    const allProfileSessions = sessions.value.filter((session) =>
      session.profileId === menu.profileId && !isScheduledSessionHidden(session));
    if (allProfileSessions.length > 0) setDeleteRequest({ sessions: allProfileSessions, all: true });
  };

  return (
    <>
      <div
        ref={menuRef}
        class="profile-context-menu"
        role="menu"
        aria-label={t("sidebar.menu.aria", { name: displayName })}
        style={{ left: `${menu.left}px`, top: `${menu.top}px`, maxHeight: `${MENU_MAX_HEIGHT}px` }}
      >
      <p class="profile-context-menu-kicker">{t("sidebar.menu.profileLabel")}</p>
      <p class="profile-context-menu-title" title={displayName}>{displayName}</p>
      {secondaryName ? <p class="profile-context-menu-subtitle">{secondaryName}</p> : null}
      <div class="profile-context-menu-divider" role="separator" />
      <button type="button" role="menuitem" onClick={() => { openProfileChatModal(menu.profileId); onClose(); }}>
        {t("sidebar.openChat")}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          setSidebarProfileOpen(menu.profileId, !sessionsOpen);
          selectProfile(menu.profileId, { openDetail: false });
          onClose();
        }}
      >
        
        {sessionsOpen ? t("sidebar.menu.collapseSessions") : t("sidebar.menu.expandSessions")}
      </button>
      <button type="button" role="menuitem" onClick={() => { selectProfile(menu.profileId, { openDetail: false }); createProfileSession(menu.profileId); onClose(); }}>
        {t("sidebar.menu.newChat")}
      </button>
      <button type="button" role="menuitem" onClick={() => { openProfileSettingsModal(menu.profileId); onClose(); }}>
        {t("sidebar.menu.settings")}
      </button>
      <div class="profile-context-menu-divider" role="separator" />
      <p class="profile-context-menu-section" role="presentation">{t("sidebar.menu.sessions")}</p>
      {profileSessions.length === 0 ? (
        <p class="profile-context-menu-empty" role="presentation">{t("sidebar.menu.noSessions")}</p>
      ) : (
        <div class="profile-context-menu-scroll">
          {visibleSessions.map((session) => {
            const isOpen = openSessionIds.value.includes(session.id);
            return (
              <div class="profile-context-menu-session-row" key={session.id}>
                <label
                  class="profile-context-menu-session-check"
                  aria-label={t("chat.sessionSelect", { title: chatSessionTitle(session) })}
                >
                  <input
                    type="checkbox"
                    checked={selectedSessionIds.includes(session.id)}
                    onChange={() => toggleSessionSelection(session.id)}
                  />
                </label>
                <button
                  type="button"
                  class="profile-context-menu-session-open"
                  role="menuitem"
                  aria-label={t("sidebar.menu.openSessionNamed", { title: chatSessionTitle(session) })}
                  onClick={() => onOpenSession(session.id)}
                >
                  <em>{chatSessionTitle(session)}</em>
                  <small>{session.status === "streaming" ? t("profile.running") : isOpen ? t("profile.open") : ""}</small>
                </button>
              </div>
            );
          })}
          {hiddenCount > 0 && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setSidebarProfileOpen(menu.profileId, true);
                selectProfile(menu.profileId, { openDetail: false });
                onClose();
              }}
            >
              {t("sidebar.menu.moreSessions", { count: hiddenCount })}
            </button>
          )}
        </div>
      )}
        {profileSessions.length > 0 && (
          <>
            <div class="profile-context-menu-divider" role="separator" />
            <div class="profile-context-menu-delete-actions" role="group" aria-label={t("chat.sessionsDeleteTitle")}>
              <button
                type="button"
                class="profile-context-menu-danger"
                disabled={selectedSessions.length === 0}
                onClick={() => setDeleteRequest({ sessions: selectedSessions, all: false })}
              >
                {t("chat.sessionsDeleteSelected", { count: selectedSessions.length })}
              </button>
              <button
                type="button"
                class="profile-context-menu-danger"
                disabled={deleteAllLoading}
                onClick={() => void requestDeleteAll()}
              >
                {deleteAllLoading
                  ? t("chat.sessionsLoadingAll")
                  : t("chat.sessionsDeleteAll", { count: profileSessions.length })}
              </button>
            </div>
            {deleteAllLoadFailed && (
              <p class="profile-context-menu-delete-error" role="alert">{t("chat.sessionsLoadFailed")}</p>
            )}
          </>
        )}
        <button type="button" role="menuitem" onClick={onClose}>
          {t("common.close")}
        </button>
      </div>
      {deleteRequest && (
        <SessionsDeleteDialog
          sessions={deleteRequest.sessions}
          {...(deleteRequest.all ? { deleteScope: { kind: "profile" as const, profileId: menu.profileId } } : {})}
          onClose={() => {
            setDeleteRequest(null);
            onClose();
          }}
        />
      )}
    </>
  );
}
