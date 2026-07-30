import { useEffect, useMemo, useState } from "preact/hooks";
import type { ChatSession } from "../domain";
import { chatSessionTitle, t } from "../i18n";
import {
  activeSessionId,
  clearWorkspaceSessionDropPreview,
  closeMobileRoute,
  mobileWorkspaceOpen,
  openMobileWorkspace,
  openProfileSettingsModal,
  openSession,
  openSessionIds,
  profileChatModalId,
  profileList,
  sessions,
  selectedProfileId,
  workspaceSessionDropPlacement,
  workspaceSessionDropPreview,
} from "../store";
import { ChatPane } from "./chat-pane";
import { InfoTip } from "./info-tip";
import { SettingsIcon } from "./icons";
import { useMobileOverlay } from "./use-mobile-overlay";
import { profileDisplayName } from "../profile-names";

type DropTarget = {
  index: number;
  label: string;
};

function workspaceSessionDropPlacementLabel(): string {
  const edge = workspaceSessionDropPlacement.value;
  if (edge === "top") return t("workspace.dock.top");
  if (edge === "right") return t("workspace.dock.right");
  if (edge === "bottom") return t("workspace.dock.bottom");
  if (edge === "left") return t("workspace.dock.left");
  return "";
}

export function ChatWorkspace() {
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [dropNote, setDropNote] = useState<string | null>(null);
  const mobileOverlay = useMobileOverlay<HTMLElement>({
    kind: "route",
    open: mobileWorkspaceOpen.value,
    onClose: closeMobileRoute,
  });
  const openSessions = useMemo(
    () => openSessionIds.value
      .map((id) => sessions.value.find((session) => session.id === id))
      .filter((session): session is ChatSession => session !== undefined),
    [openSessionIds.value, sessions.value],
  );

  const clearDropUi = () => {
    setDropTarget(null);
    clearWorkspaceSessionDropPreview();
  };

  useEffect(() => {
    const end = () => clearDropUi();
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    window.addEventListener("dragcancel", end as EventListener);
    return () => {
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
      window.removeEventListener("dragcancel", end as EventListener);
      clearDropUi();
    };
  }, []);

  useEffect(() => {
    // Opening/closing panes must never leave a stale insert marker behind.
    setDropTarget(null);
  }, [openSessionIds.value.join("|")]);

  const resolveDropTarget = (event: DragEvent, host: HTMLElement): DropTarget | null => {
    if (profileChatModalId.value) return null;
    const count = openSessions.length;
    if (count === 0) {
      return { index: 0, label: t("workspace.dropHere") };
    }
    const panes = [...host.querySelectorAll<HTMLElement>(".chat-pane")];
    if (panes.length === 0) {
      return { index: count, label: t("workspace.dropAtEnd") };
    }
    const x = event.clientX;
    for (let i = 0; i < panes.length; i += 1) {
      const rect = panes[i]!.getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      if (x < mid) {
        return {
          index: i,
          label: i === 0 ? t("workspace.dropAtStart") : t("workspace.dropBefore", { position: i + 1 }),
        };
      }
    }
    return {
      index: panes.length,
      label: t("workspace.dropAtEnd"),
    };
  };

  const onDragOverHost = (event: DragEvent) => {
    if (profileChatModalId.value) return;
    if (!(event.currentTarget instanceof HTMLElement)) return;
    // Edge docking is handled by the layout-level zones. Only resolve in-pane insert
    // targets when the pointer is over the chat surface itself.
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const overEdgeZone = path.some((node) => node instanceof Element && node.classList?.contains("session-drop-zones"));
    if (overEdgeZone) {
      clearDropUi();
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      const types = event.dataTransfer.types ? [...event.dataTransfer.types] : [];
      event.dataTransfer.dropEffect = types.includes("application/x-hermes-session") ? "move" : "copy";
    }
    const next = resolveDropTarget(event, event.currentTarget);
    if (!next) {
      clearDropUi();
      return;
    }
    setDropTarget((current) => (
      current && current.index === next.index && current.label === next.label ? current : next
    ));
  };

  const acceptSessionDrop = (event: DragEvent) => {
    event.preventDefault();
    const host = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const sessionId = event.dataTransfer?.getData("application/x-hermes-session");
    const target = host ? resolveDropTarget(event, host) : dropTarget;
    // Always clear insert guides immediately on drop, even if session open fails.
    setDropTarget(null);
    clearWorkspaceSessionDropPreview();
    if (!sessionId) return;
    if (profileChatModalId.value) {
      setDropNote(t("workspace.dropBlockedByModal"));
      window.setTimeout(() => setDropNote(null), 2200);
      return;
    }
    openSession(sessionId, {
      workspace: true,
      ...(target ? { index: target.index } : {}),
    });
    openMobileWorkspace();
    setDropTarget(null);
    clearWorkspaceSessionDropPreview();
    setDropNote(null);
  };

  if (openSessions.length === 0) {
    return (
      <section
        class={`workspace-empty ${dropTarget || workspaceSessionDropPreview.value ? "is-drop-target" : ""}`}
        onDragOver={onDragOverHost}
        onDragLeave={(event) => { if (event.currentTarget === event.target) clearDropUi(); }}
        onDrop={acceptSessionDrop}
      >
        <div class="workspace-empty-copy">
          <span>{t("workspace.emptyKicker")}</span>
          <InfoTip text={t("workspace.empty")} />
        </div>
        {(dropTarget || workspaceSessionDropPreview.value) ? (
          <div class="workspace-drop-ghost" aria-live="polite">
            <b>{t("workspace.dropPreviewTitle")}</b>
            <small>
              {dropTarget?.label
                ?? (workspaceSessionDropPlacementLabel() || t("workspace.dropEdgeHint"))}
            </small>
          </div>
        ) : (
          <p class="workspace-drop-hint">{t("workspace.dropToAddPaneUnlimited")}</p>
        )}
        {dropNote && <p class="workspace-drop-note">{dropNote}</p>}
      </section>
    );
  }

  return (
    <section
      ref={mobileOverlay.ref}
      class={`chat-workspace-shell ${dropTarget || workspaceSessionDropPreview.value ? "is-drop-target" : ""}`}
      role={mobileOverlay.active ? "region" : undefined}
      aria-labelledby={mobileOverlay.active ? "mobile-workspace-title" : undefined}
      tabIndex={mobileOverlay.active ? -1 : undefined}
      onDragOver={onDragOverHost}
      onDragLeave={(event) => { if (event.currentTarget === event.target) clearDropUi(); }}
      onDrop={acceptSessionDrop}
    >
      <header class="mobile-workspace-bar">
        <button
          data-mobile-overlay-initial-focus
          type="button"
          aria-label={t("workspace.profiles")}
          title={t("workspace.profiles")}
          onClick={closeMobileRoute}
        ><span aria-hidden="true">←</span></button>
        <b id="mobile-workspace-title">{t("workspace.chats", { count: openSessions.length })}</b>
        <button
          type="button"
          aria-label={t("workspace.profileSettings")}
          title={t("workspace.profileSettings")}
          onClick={() => {
            const profileId = sessions.value.find((session) => session.id === activeSessionId.value)?.profileId
              ?? selectedProfileId.value;
            if (profileId) openProfileSettingsModal(profileId);
          }}
        ><SettingsIcon width={18} height={18} /></button>
      </header>
      <nav class="mobile-chat-tabs" aria-label={t("workspace.switchChats")}>
        {openSessions.map((session) => {
          if (!session) return null;
          const profile = profileList.value.find((item) => item.id === session.profileId);
          const profileName = profile ? profileDisplayName(profile) : session.profileId;
          const tab = mobileChatTabPresentation(session, profileName, openSessions);
          return (
            <button
              key={session.id}
              type="button"
              class={activeSessionId.value === session.id ? "is-active" : ""}
              aria-label={tab.accessibleLabel}
              aria-current={activeSessionId.value === session.id ? "page" : undefined}
              onClick={() => openSession(session.id)}
            >
              <span>{tab.profileName}</span>
              <small title={tab.sessionTitle}>{tab.sessionTitle}</small>
            </button>
          );
        })}
      </nav>
      {(dropTarget || workspaceSessionDropPreview.value) && (
        <p class="workspace-drop-banner">
          {dropTarget?.label
            ?? (workspaceSessionDropPlacementLabel() || t("workspace.dropEdgeHint"))}
        </p>
      )}
      {dropNote && <p class="workspace-drop-note">{dropNote}</p>}
      <div
        class={`chat-workspace ${openSessions.length > 4 ? "has-many-panes" : ""} ${dropTarget ? "is-dropping" : ""}`}
        style={{ "--pane-count": openSessions.length }}
        aria-label={t("workspace.openChats")}
      >
        {openSessions.map((session, index) => {
          if (!session) return null;
          const profile = profileList.value.find((item) => item.id === session.profileId);
          if (!profile) return null;
          const showLineBefore = dropTarget?.index === index;
          const showLineAfter = dropTarget?.index === openSessions.length && index === openSessions.length - 1;
          return (
            <div
              class={`chat-workspace-slot ${showLineBefore ? "has-drop-before" : ""} ${showLineAfter ? "has-drop-after" : ""}`}
              key={session.id}
            >
              {showLineBefore && (
                <div class="workspace-drop-line" aria-hidden="true">
                  <span>{dropTarget?.label}</span>
                </div>
              )}
              <ChatPane session={session} profile={profile} activateWorkspaceOnPointerDown />
              {showLineAfter && (
                <div class="workspace-drop-line is-after" aria-hidden="true">
                  <span>{dropTarget?.label}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function mobileChatTabPresentation(
  session: Pick<ChatSession, "id" | "profileId" | "title" | "titlePresentation">,
  profileName: string,
  siblings: readonly Pick<ChatSession, "id" | "profileId" | "title" | "titlePresentation">[] = [session],
): { profileName: string; sessionTitle: string; accessibleLabel: string } {
  const sessionTitle = chatSessionTitle(session);
  const matching = siblings.filter((candidate) => (
    candidate.profileId === session.profileId && chatSessionTitle(candidate) === sessionTitle
  ));
  const ordinal = matching.findIndex((candidate) => candidate.id === session.id) + 1;
  const disambiguatedTitle = matching.length > 1 && ordinal > 0 ? `${sessionTitle} · ${ordinal}` : sessionTitle;
  return { profileName, sessionTitle: disambiguatedTitle, accessibleLabel: `${profileName} — ${disambiguatedTitle}` };
}
