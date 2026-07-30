/**
 * Profile Chat Modal — master/detail layout.
 * Left: recent sessions list. Right: up to 4 conversation panes for this profile.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  addProfileChatModalPane,
  closeProfileChatModal,
  createSession,
  ensureSessionConnection,
  MAX_PROFILE_CHAT_MODAL_PANES,
  openMobileWorkspace,
  officeConnection,
  openProfileSettingsModal,
  openSession,
  profileChatModalId,
  profileChatModalActivePaneId,
  profileChatModalPaneIds,
  profileList,
  removeProfileChatModalPane,
  replaceProfileChatModalPane,
  moveProfileChatModalPane,
  selectProfileChatModalSession,
  setProfileChatModalActivePane,
  sessions,
  setProfileChatModalPanes,
} from "../store";
import type { ChatSession, Profile } from "../domain";
import { ChatPane } from "./chat-pane";
import { CharacterPortrait } from "./character-portrait";
import { StatusPill } from "./status-pill";
import { TeamBadges } from "./team-badges";
import { ChatIcon, CloseIcon, SettingsIcon, TrashIcon } from "./icons";
import { chatSessionTitle, localizeRuntimeMessage, officeRuntimeMessage, t } from "../i18n";
import { profileDisplayName } from "../profile-names";
import { loadProfileSoul, SettingsApiError } from "../settings-api";
import {
  previewProfileChatModalSize,
  profileChatModalSize,
  setProfileChatModalSize,
} from "../profile-chat-modal-layout";
import { markAppModalResizeEnd, markAppModalResizeStart, shouldIgnoreModalOutsideClose } from "../app-modal-layout";
import { isScheduledSessionHidden } from "../scheduled-sessions";
import { ProfileContextMenu, useProfileContextMenu } from "./profile-context-menu";
import { useModalOutsideClose } from "./use-modal-outside-close";
import { useMobileOverlay } from "./use-mobile-overlay";
import { DASHBOARD_SESSION_DRAG_TYPE, paneDropTargetAt } from "../dashboard-drag";
import { SessionDeleteDialog } from "./session-delete-dialog";

const INITIAL_SESSION_COUNT = 10;
const MODAL_SESSION_DRAG_THRESHOLD_PX = 7;

type ModalDropTarget =
  | { mode: "insert"; index: number; anchorSessionId?: string; edge?: "before" | "after" }
  | { mode: "replace"; index: number; sessionId: string };

type ModalSessionPointerDrag = {
  pointerId: number;
  sessionId: string;
  startX: number;
  startY: number;
  active: boolean;
  sourceElement: HTMLElement;
};

export function ProfileChatModal() {
  const profileId = profileChatModalId.value;
  const profile = profileId ? profileList.value.find((item: Profile) => item.id === profileId) : undefined;
  if (!profileId || !profile) return null;
  return <OpenProfileChatModal profileId={profileId} profile={profile} />;
}

function OpenProfileChatModal({ profileId, profile }: { profileId: string; profile: Profile }) {
  const overlay = useMobileOverlay<HTMLElement>({
    kind: "modal",
    open: true,
    onClose: closeProfileChatModal,
    viewport: "(min-width: 0px)",
  });

  const outsideClose = useModalOutsideClose(closeProfileChatModal);

  const profileSessions = useMemo(
    () => sessions.value
      .filter((session) => session.profileId === profileId && !isScheduledSessionHidden(session))
      .sort((a, b) => {
        const left = a.updatedAt ?? a.createdAt ?? "";
        const right = b.updatedAt ?? b.createdAt ?? "";
        return right.localeCompare(left);
      }),
    [profileId, sessions.value],
  );

  const displayName = profileDisplayName(profile);
  const hasSessions = profileSessions.length > 0;
  const {
    menu,
    menuRef,
    closeMenu,
    openSessionMenu,
  } = useProfileContextMenu();
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [sessionDeleteRequestId, setSessionDeleteRequestId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<ModalDropTarget | null>(null);
  const [dropNote, setDropNote] = useState<string | null>(null);
  const [newChatError, setNewChatError] = useState(false);
  const [soulOpen, setSoulOpen] = useState(false);
  const [soulLoading, setSoulLoading] = useState(false);
  const [soulError, setSoulError] = useState<string | null>(null);
  const [soulContent, setSoulContent] = useState<string | null>(null);

  useEffect(() => {
    setShowAllSessions(false);
    setSessionDeleteRequestId(null);
    setDropTarget(null);
    setDropNote(null);
    setNewChatError(false);
    setSoulOpen(false);
    setSoulLoading(false);
    setSoulError(null);
    setSoulContent(null);
  }, [profileId]);

  useEffect(() => {
    const onWindowResize = () => {
      setProfileChatModalSize(profileChatModalSize.value);
    };
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, []);

  const visibleSessions = showAllSessions
    ? profileSessions
    : profileSessions.slice(0, INITIAL_SESSION_COUNT);
  const hiddenSessionCount = Math.max(0, profileSessions.length - visibleSessions.length);
  const profileSessionIdsKey = profileSessions.map((session) => session.id).join("|");
  useEffect(() => {
    // Drop panes that no longer belong to this profile / no longer exist.
    const allowed = new Set(profileSessions.map((session) => session.id));
    const next = profileChatModalPaneIds.value.filter((id) => allowed.has(id));
    if (next.length !== profileChatModalPaneIds.value.length) {
      setProfileChatModalPanes(next);
    }
  }, [profileId, profileSessionIdsKey]);

  const openPaneIds = profileChatModalPaneIds.value.filter((id) =>
    profileSessions.some((session) => session.id === id),
  );
  const openPanes = openPaneIds
    .map((id) => profileSessions.find((session) => session.id === id))
    .filter((session): session is ChatSession => session !== undefined);

  useEffect(() => {
    for (const session of openPanes) ensureSessionConnection(session.id);
  }, [openPaneIds.join("|")]);

  const startNewChat = () => {
    const sessionId = createSession(profile.id, { workspace: false });
    if (!sessionId) {
      setNewChatError(true);
      return;
    }
    setNewChatError(false);
    if (!addProfileChatModalPane(sessionId)) {
      // Explicit new-chat adds until full, then replaces the last-active pane.
      selectProfileChatModalSession(sessionId);
    }
  };
  const canCreateChat = (
    officeConnection.value.source === "server"
      && officeConnection.value.runtime === "ready"
  ) || (
    officeConnection.value.source === "demo"
      && officeConnection.value.state === "demo"
  );
  useEffect(() => {
    if (!canCreateChat) return;
    setNewChatError(false);
    if (openPaneIds.length > 0) return;

    // The store attempts this synchronously when the modal opens. It can fail
    // while Hermes is temporarily non-ready, so retry when readiness returns;
    // the empty modal must never remain a stale manual-recovery state.
    const sessionId = createSession(profile.id, { workspace: false });
    if (!sessionId) {
      setNewChatError(true);
      return;
    }
    if (!addProfileChatModalPane(sessionId)) {
      selectProfileChatModalSession(sessionId);
    }
  }, [canCreateChat, profile.id, openPaneIds.length]);

  const showDropNote = (message: string) => {
    setDropNote(message);
    window.setTimeout(() => setDropNote(null), 2200);
  };

  const placeModalSession = (sessionId: string, target: ModalDropTarget): boolean => {
    const session = sessions.value.find((item) => item.id === sessionId);
    if (!session || session.profileId !== profile.id) {
      showDropNote(t("profile.modalDropWrongProfile"));
      return false;
    }
    const current = profileChatModalPaneIds.value;
    if (target.mode === "replace") {
      const replaced = replaceProfileChatModalPane(target.sessionId, sessionId);
      if (replaced) setDropNote(null);
      return replaced;
    }
    if (current.includes(sessionId)) {
      moveProfileChatModalPane(sessionId, target.index);
      setProfileChatModalActivePane(sessionId);
      setDropNote(null);
      return true;
    }
    if (!addProfileChatModalPane(sessionId, { index: target.index })) {
      showDropNote(t("profile.modalPaneLimit"));
      return false;
    }
    setDropNote(null);
    return true;
  };

  const resolveModalDropTargetAt = (
    x: number,
    y: number,
    body: HTMLElement,
  ): ModalDropTarget | null => {
    const detail = body.querySelector<HTMLElement>(".profile-chat-detail-pane");
    const detailRect = detail?.getBoundingClientRect();
    if (!detail || !detailRect || x < detailRect.left || x > detailRect.right
      || y < detailRect.top || y > detailRect.bottom) return null;
    const panes = [...detail.querySelectorAll<HTMLElement>(".profile-chat-modal-pane")];
    if (panes.length === 0) return { mode: "insert", index: 0 };
    const geometry = paneDropTargetAt(
      x,
      y,
      panes.map((pane, index) => {
        const rect = pane.getBoundingClientRect();
        return { index, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
      }),
    );
    if (geometry?.mode === "replace") {
      const sessionId = openPaneIds[geometry.index];
      if (sessionId) return { ...geometry, sessionId };
    }
    if (geometry?.mode === "insert") {
      const anchorSessionId = openPaneIds[geometry.anchorIndex];
      return {
        mode: "insert",
        index: geometry.index,
        ...(anchorSessionId ? { anchorSessionId, edge: geometry.edge } : {}),
      };
    }
    return null;
  };

  const acceptSessionDrop = (event: DragEvent) => {
    const sessionId = event.dataTransfer?.getData(DASHBOARD_SESSION_DRAG_TYPE);
    if (!sessionId || !(event.currentTarget instanceof HTMLElement)) return;
    event.preventDefault();
    event.stopPropagation();
    const target = resolveModalDropTargetAt(event.clientX, event.clientY, event.currentTarget);
    setDropTarget(null);
    if (target) placeModalSession(sessionId, target);
  };

  const modalBodyRef = useRef<HTMLDivElement>(null);
  const pointerDragRef = useRef<ModalSessionPointerDrag | null>(null);
  const suppressedClickRef = useRef<{ sessionId: string; until: number } | null>(null);

  const beginModalSessionPointerDrag = (event: PointerEvent, sessionId: string) => {
    if (event.button !== 0 || event.altKey || event.metaKey || event.ctrlKey
      || !(event.currentTarget instanceof HTMLElement)) return;
    pointerDragRef.current = {
      pointerId: event.pointerId,
      sessionId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      sourceElement: event.currentTarget,
    };
  };

  const consumeModalSessionClickSuppression = (sessionId: string): boolean => {
    const suppressed = suppressedClickRef.current;
    if (!suppressed || suppressed.sessionId !== sessionId || suppressed.until < Date.now()) return false;
    suppressedClickRef.current = null;
    return true;
  };

  useEffect(() => {
    const clearPointerDrag = () => {
      pointerDragRef.current?.sourceElement.classList.remove("is-pointer-dragging");
      pointerDragRef.current = null;
      setDropTarget(null);
    };
    const pointerMove = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (!drag.active && distance < MODAL_SESSION_DRAG_THRESHOLD_PX) return;
      if (!drag.active) {
        drag.active = true;
        drag.sourceElement.classList.add("is-pointer-dragging");
      }
      event.preventDefault();
      const body = modalBodyRef.current;
      const rect = body?.getBoundingClientRect();
      if (!body || !rect || event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom) {
        setDropTarget(null);
        return;
      }
      setDropTarget(resolveModalDropTargetAt(event.clientX, event.clientY, body));
    };
    const finishPointerDrag = (event: PointerEvent, cancelled = false) => {
      const drag = pointerDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (drag.active && !cancelled) {
        event.preventDefault();
        const body = modalBodyRef.current;
        const rect = body?.getBoundingClientRect();
        if (body && rect && event.clientX >= rect.left && event.clientX <= rect.right
          && event.clientY >= rect.top && event.clientY <= rect.bottom) {
          const target = resolveModalDropTargetAt(event.clientX, event.clientY, body);
          if (target) placeModalSession(drag.sessionId, target);
        }
        suppressedClickRef.current = { sessionId: drag.sessionId, until: Date.now() + 600 };
      }
      clearPointerDrag();
    };
    const pointerUp = (event: PointerEvent) => finishPointerDrag(event);
    const pointerCancel = (event: PointerEvent) => finishPointerDrag(event, true);
    window.addEventListener("pointermove", pointerMove, { passive: false });
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerCancel);
    window.addEventListener("blur", clearPointerDrag);
    return () => {
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerCancel);
      window.removeEventListener("blur", clearPointerDrag);
      clearPointerDrag();
    };
  }, [profileId, profileSessionIdsKey, openPaneIds.join("|")]);

  const openSoulPreview = async () => {
    setSoulOpen(true);
    if (soulContent !== null || soulLoading) return;
    setSoulLoading(true);
    setSoulError(null);
    try {
      const soul = await loadProfileSoul(profile.id);
      setSoulContent(soul.content);
    } catch (reason) {
      const message = reason instanceof SettingsApiError
        ? localizeRuntimeMessage(officeRuntimeMessage(reason.message))
        : t("profile.soulPreviewFailed");
      setSoulError(message);
    } finally {
      setSoulLoading(false);
    }
  };

  const modalSize = profileChatModalSize.value;
  type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
  const resizePointerId = useRef<number | null>(null);
  const resizeOrigin = useRef<{
    x: number;
    y: number;
    width: number;
    height: number;
    edge: ResizeEdge;
  } | null>(null);

  const stopDocumentResizeListeners = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    stopDocumentResizeListeners.current?.();
    stopDocumentResizeListeners.current = null;
  }, []);

  const beginResize = (edge: ResizeEdge) => (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const origin = {
      x: event.clientX,
      y: event.clientY,
      width: profileChatModalSize.value.width,
      height: profileChatModalSize.value.height,
      edge,
    };
    resizePointerId.current = event.pointerId;
    resizeOrigin.current = origin;
    markAppModalResizeStart();

    const onMove = (moveEvent: PointerEvent) => {
      if (resizePointerId.current !== moveEvent.pointerId || !resizeOrigin.current) return;
      moveEvent.preventDefault();
      const current = resizeOrigin.current;
      const dx = moveEvent.clientX - current.x;
      const dy = moveEvent.clientY - current.y;
      let width = current.width;
      let height = current.height;
      if (current.edge === "e" || current.edge === "ne" || current.edge === "se") width = current.width + dx;
      if (current.edge === "w" || current.edge === "nw" || current.edge === "sw") width = current.width - dx;
      if (current.edge === "s" || current.edge === "se" || current.edge === "sw") height = current.height + dy;
      if (current.edge === "n" || current.edge === "ne" || current.edge === "nw") height = current.height - dy;
      previewProfileChatModalSize({ width, height });
    };

    const onUp = (upEvent: PointerEvent) => {
      if (resizePointerId.current !== upEvent.pointerId) return;
      upEvent.preventDefault();
      upEvent.stopPropagation();
      resizePointerId.current = null;
      resizeOrigin.current = null;
      setProfileChatModalSize(profileChatModalSize.value);
      markAppModalResizeEnd();
      stopDocumentResizeListeners.current?.();
      stopDocumentResizeListeners.current = null;
    };

    stopDocumentResizeListeners.current?.();
    const onClick = (clickEvent: MouseEvent) => {
      if (!shouldIgnoreModalOutsideClose()) return;
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    window.addEventListener("click", onClick, true);
    stopDocumentResizeListeners.current = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      window.removeEventListener("click", onClick, true);
    };
  };

  const resizeHandles: Array<{ edge: ResizeEdge; className: string }> = [
    { edge: "n", className: "is-n" },
    { edge: "s", className: "is-s" },
    { edge: "e", className: "is-e" },
    { edge: "w", className: "is-w" },
    { edge: "ne", className: "is-ne" },
    { edge: "nw", className: "is-nw" },
    { edge: "se", className: "is-se" },
    { edge: "sw", className: "is-sw" },
  ];


  return (
    <div
      class="profile-chat-modal-layer"
      data-modal-affordance="true"
      {...outsideClose}
    >
      <button class="profile-chat-modal-scrim" type="button" aria-label={t("common.close")} onClick={() => { if (!shouldIgnoreModalOutsideClose()) closeProfileChatModal(); }} />
      <section
        ref={overlay.ref}
        class={`profile-chat-modal ${hasSessions ? "has-sessions" : "is-empty"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-chat-modal-title"
        tabIndex={-1}
        style={{
          width: `${modalSize.width}px`,
          height: hasSessions ? `${modalSize.height}px` : undefined,
        }}
      >
        <header class="profile-chat-modal-head">
          <div class="profile-chat-modal-identity">
            <CharacterPortrait profileId={profile.id} profileName={displayName} class="character-portrait--modal" decorative />
            <div class="profile-chat-modal-copy">
              <div class="profile-chat-modal-title-row">
                <h2 id="profile-chat-modal-title" title={displayName}>{displayName}</h2>
                <button
                  type="button"
                  class={`profile-chat-soul-button ${soulOpen ? "is-open" : ""}`}
                  title={t("profile.viewSoul")}
                  aria-label={t("profile.viewSoul")}
                  aria-expanded={soulOpen}
                  onClick={() => {
                    if (soulOpen) setSoulOpen(false);
                    else void openSoulPreview();
                  }}
                >
                  {t("profile.viewSoul")}
                </button>
                <StatusPill status={profile.status} />
              </div>
              <div class="profile-chat-modal-meta">
                <TeamBadges profileId={profile.id} />
                {hasSessions && (
                  <span class="profile-chat-session-count">{profileSessions.length} {t("office.chats")}</span>
                )}
              </div>
            </div>
          </div>
          <div class="profile-chat-modal-actions">
            <button
              type="button"
              class="profile-chat-new profile-chat-new--header"
              title={t("profile.newChat")}
              aria-label={t("profile.newChat")}
              disabled={!canCreateChat}
              onClick={startNewChat}
            >
              <ChatIcon width={18} height={18} />
            </button>
            <button
              type="button"
              class="quiet-button"
              title={t("profile.settings")}
              aria-label={t("profile.settings")}
              onClick={() => {
                closeProfileChatModal();
                openProfileSettingsModal(profileId);
              }}
            >
              <SettingsIcon width={18} height={18} />
            </button>
            <button
              type="button"
              class="profile-chat-modal-close"
              data-mobile-overlay-initial-focus
              aria-label={t("common.close")}
              title={t("common.close")}
              onClick={closeProfileChatModal}
            >
              <CloseIcon width={18} height={18} />
            </button>
          </div>
        </header>

        {soulOpen && (
          <div class="profile-chat-soul-preview" role="region" aria-label={t("profile.soulPreviewTitle")}>
            <div class="profile-chat-soul-preview-head">
              <b>{t("profile.soulPreviewTitle")}</b>
              <div class="profile-chat-soul-preview-actions">
                <button
                  type="button"
                  class="profile-chat-soul-open-settings"
                  onClick={() => {
                    closeProfileChatModal();
                    openProfileSettingsModal(profileId, "soul");
                  }}
                >
                  {t("profile.soulPreviewOpenSettings")}
                </button>
                <button type="button" class="profile-chat-soul-close" onClick={() => setSoulOpen(false)} aria-label={t("common.close")} title={t("common.close")}>
                  <CloseIcon width={16} height={16} />
                </button>
              </div>
            </div>
            {soulLoading ? (
              <p class="profile-chat-soul-status">{t("profile.soulPreviewLoading")}</p>
            ) : soulError ? (
              <p class="profile-chat-soul-status is-error">{soulError}</p>
            ) : soulContent?.trim() ? (
              <pre class="profile-chat-soul-body">{soulContent}</pre>
            ) : (
              <p class="profile-chat-soul-status">{t("profile.soulPreviewEmpty")}</p>
            )}
          </div>
        )}

        <div
          ref={modalBodyRef}
          class={`profile-chat-modal-body ${hasSessions ? "is-split" : "is-empty-body"}`}
          onDragOver={(event) => {
            const types = event.dataTransfer?.types ? [...event.dataTransfer.types] : [];
            if (!types.includes(DASHBOARD_SESSION_DRAG_TYPE)) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
            if (event.currentTarget instanceof HTMLElement) {
              setDropTarget(resolveModalDropTargetAt(event.clientX, event.clientY, event.currentTarget));
            }
          }}
          onDragLeave={(event) => {
            const next = event.relatedTarget;
            if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDropTarget(null);
          }}
          onDrop={acceptSessionDrop}
        >
          {hasSessions ? (
            <>
              <aside class="profile-chat-session-pane" aria-label={t("profile.openChats")}>
                <div class="profile-chat-session-pane-head">
                  <b>{t("profile.recentChats")}</b>
                  <span>{openPanes.length}/{MAX_PROFILE_CHAT_MODAL_PANES}</span>
                </div>
                <div class="profile-chat-session-list">
                  {visibleSessions.map((session) => (
                    <SessionListItem
                      key={session.id}
                      session={session}
                      selected={openPaneIds.includes(session.id)}
                      active={profileChatModalActivePaneId.value === session.id}
                      onSelect={() => {
                        if (consumeModalSessionClickSuppression(session.id)) return;
                        if (openPaneIds.includes(session.id)) {
                          setProfileChatModalActivePane(session.id);
                        } else {
                          selectProfileChatModalSession(session.id);
                        }
                        setDropNote(null);
                      }}
                      onDelete={() => setSessionDeleteRequestId(session.id)}
                      onPointerDown={(event) => beginModalSessionPointerDrag(event, session.id)}
                      onContextMenu={(event) => openSessionMenu(event, session.id, profile.id)}
                    />
                  ))}
                </div>
                {!showAllSessions && hiddenSessionCount > 0 && (
                  <button
                    type="button"
                    class="profile-chat-show-more"
                    onClick={() => setShowAllSessions(true)}
                  >
                    {t("profile.showMoreChats", { count: hiddenSessionCount })}
                  </button>
                )}
                {showAllSessions && profileSessions.length > INITIAL_SESSION_COUNT && (
                  <button
                    type="button"
                    class="profile-chat-show-more"
                    onClick={() => setShowAllSessions(false)}
                  >
                    {t("profile.showRecentChats")}
                  </button>
                )}
                {dropTarget && <p class="profile-chat-drop-hint">{t("profile.modalDropToAddPane")}</p>}
                {dropNote && <p class="profile-chat-drop-note" role="status" aria-live="polite" aria-atomic="true">{dropNote}</p>}
              </aside>

              <div class={`profile-chat-detail-pane panes-${Math.min(Math.max(openPanes.length, 1), MAX_PROFILE_CHAT_MODAL_PANES)} ${dropTarget ? "is-drop-target" : ""}`}>
                {openPanes.length > 0 ? (
                  openPanes.map((session, index) => (
                    <div
                      class={`profile-chat-modal-pane ${profileChatModalActivePaneId.value === session.id ? "is-active" : ""} ${dropTarget?.mode === "replace" && dropTarget.sessionId === session.id ? "is-drop-replace" : ""} ${dropTarget?.mode === "insert" && (dropTarget.anchorSessionId ? dropTarget.anchorSessionId === session.id && dropTarget.edge === "before" : dropTarget.index === index) ? "has-drop-before" : ""} ${dropTarget?.mode === "insert" && (dropTarget.anchorSessionId ? dropTarget.anchorSessionId === session.id && dropTarget.edge === "after" : dropTarget.index === openPanes.length && index === openPanes.length - 1) ? "has-drop-after" : ""}`}
                      key={session.id}
                      data-session-id={session.id}
                      onPointerDownCapture={() => setProfileChatModalActivePane(session.id)}
                      onFocusCapture={() => setProfileChatModalActivePane(session.id)}
                    >
                      {dropTarget?.mode === "insert" && (dropTarget.anchorSessionId
                        ? dropTarget.anchorSessionId === session.id && dropTarget.edge === "before"
                        : dropTarget.index === index) && (
                        <div class="workspace-drop-line" aria-hidden="true">
                          <span>{dropTarget.index === 0 ? t("dashboard.dropInsertStart") : t("dashboard.dropInsertBetween")}</span>
                        </div>
                      )}
                      {dropTarget?.mode === "replace" && dropTarget.sessionId === session.id && (
                        <div class="profile-chat-pane-replace-drop" aria-hidden="true">
                          <span>{t("profile.modalDropReplace")}</span>
                          <small>{t("dashboard.dropReplaceHint")}</small>
                        </div>
                      )}
                      <ChatPane
                        session={session}
                        profile={profile}
                        onClosePane={() => removeProfileChatModalPane(session.id)}
                      />
                      {dropTarget?.mode === "insert" && (dropTarget.anchorSessionId
                        ? dropTarget.anchorSessionId === session.id && dropTarget.edge === "after"
                        : dropTarget.index === openPanes.length && index === openPanes.length - 1) && (
                        <div class="workspace-drop-line is-after" aria-hidden="true"><span>{t("dashboard.dropInsertEnd")}</span></div>
                      )}
                    </div>
                  ))
                ) : (
                  <div class="profile-chat-empty">
                    <p>{t("profile.modalDropToAddPane")}</p>
                    {(newChatError || !canCreateChat) && (
                      <p class="profile-chat-new-error" role="alert">{t("profile.newChatUnavailable")}</p>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div class="profile-chat-empty">
              <p>{t("profile.noChats")}</p>
              {(newChatError || !canCreateChat) && (
                <p class="profile-chat-new-error" role="alert">{t("profile.newChatUnavailable")}</p>
              )}
              <button type="button" class="profile-chat-new" disabled={!canCreateChat} onClick={startNewChat}>
                {t("profile.newChat")}
              </button>
            </div>
          )}
        </div>
        {hasSessions && resizeHandles.map((handle) => (
          <div
            key={handle.edge}
            class={`profile-chat-modal-resize ${handle.className}`}
            role="separator"
            aria-orientation={handle.edge === "n" || handle.edge === "s" ? "horizontal" : handle.edge === "e" || handle.edge === "w" ? "vertical" : undefined}
            aria-label={t("profile.chatModalResize")}
            title={t("profile.chatModalResize")}
            onPointerDown={beginResize(handle.edge)}
          />
        ))}
      </section>
      {sessionDeleteRequestId && (() => {
        const session = sessions.value.find((item) => item.id === sessionDeleteRequestId);
        return session
          ? <SessionDeleteDialog session={session} onClose={() => setSessionDeleteRequestId(null)} />
          : null;
      })()}
      {menu && (
        <ProfileContextMenu
          menu={menu}
          menuRef={menuRef}
          onClose={closeMenu}
          onDeleteSession={setSessionDeleteRequestId}
          onOpenSession={(sessionId) => {
            openSession(sessionId, { workspace: true });
            openMobileWorkspace();
            closeMenu();
          }}
        />
      )}
    </div>
  );
}

function SessionListItem({
  session,
  selected,
  active,
  onSelect,
  onDelete,
  onPointerDown,
  onContextMenu,
}: {
  session: ChatSession;
  selected: boolean;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onPointerDown: (event: PointerEvent) => void;
  onContextMenu: (event: MouseEvent) => void;
}) {
  const title = chatSessionTitle(session);
  const updatedAt = session.updatedAt ?? session.createdAt;
  const timeStr = updatedAt
    ? new Date(updatedAt).toLocaleString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
  const status = session.status === "streaming" ? "working" : session.status === "waiting" ? "waiting" : "idle";

  return (
    <div class="profile-chat-session-row">
      <button
        type="button"
        class={`profile-chat-session-item ${selected ? "is-selected" : ""} ${active ? "is-active" : ""}`}
        onClick={onSelect}
        onPointerDown={onPointerDown}
        onContextMenu={onContextMenu}
        aria-pressed={selected}
        aria-current={active ? "true" : undefined}
        data-modal-session-id={session.id}
        title={t("profile.modalClickReplace")}
      >
        <span class="profile-chat-session-item-main">
          <span class="profile-chat-session-title-line">
            <b title={title}>{title}</b>
            {session.conversationKind === "delegated" && <em class="delegated-chat-badge">{t("profile.delegatedChat")}</em>}
          </span>
          {timeStr && <small>{timeStr}</small>}
        </span>
        <StatusPill status={status} />
      </button>
      <button
        type="button"
        class="profile-chat-session-delete"
        aria-label={t("chat.sessionDelete")}
        title={t("chat.sessionDelete")}
        onClick={onDelete}
      ><TrashIcon width={15} height={15} /></button>
    </div>
  );
}
