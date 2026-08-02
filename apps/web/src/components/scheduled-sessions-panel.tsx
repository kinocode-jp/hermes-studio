import { useEffect, useRef, useState } from "preact/hooks";
import { chatSessionTitle, t } from "../i18n";
import { profileDisplayName } from "../profile-names";
import {
  deleteSessions,
  openMobileWorkspace,
  openSession,
  profileList,
  sessions,
} from "../store";
import {
  getScheduledKeepCount,
  scheduledKeepCount,
  scheduledKeepCountsByGroup,
  scheduledSessionGroups,
  setScheduledKeepCount,
} from "../scheduled-sessions";
import { TrashIcon } from "./icons";
import { InfoTip } from "./info-tip";
import { useMobileOverlay } from "./use-mobile-overlay";
import type { SessionDeletionProgress } from "../session-deletion";
import { loadMoreSessions, sessionInventoryComplete, sessionInventoryState } from "../inventory";

const INITIAL_VISIBLE_SESSIONS = 3;
const VISIBLE_SESSION_STEP = 10;

type ScheduledDeleteRequest = {
  key: string;
  ids: string[];
  message: string;
};

function ScheduledDeleteDialog({
  request,
  busy,
  progress,
  onCancel,
  onConfirm,
}: {
  request: ScheduledDeleteRequest | null;
  busy: boolean;
  progress: SessionDeletionProgress | null;
  onCancel(): void;
  onConfirm(): Promise<void>;
}) {
  const close = () => {
    if (!busy) onCancel();
  };
  const overlay = useMobileOverlay<HTMLElement>({
    kind: "modal",
    open: request !== null,
    onClose: close,
    viewport: "(min-width: 0px)",
  });

  if (!request) return null;

  return (
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
        disabled={busy}
        onClick={close}
      />
      <section
        ref={overlay.ref}
        class="scheduled-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={t("scheduled.confirmTitle")}
        tabIndex={-1}
      >
        <header>
          <TrashIcon />
          <h2>{t("scheduled.confirmTitle")}</h2>
        </header>
        <div class="scheduled-delete-dialog-message">
          {request.message.split("\n").map((line) => <p key={line}>{line}</p>)}
        </div>
        {busy && progress && (
          <div class="scheduled-delete-progress" role="status" aria-live="polite">
            <span>{t("scheduled.deletingProgress", { completed: progress.completed, total: progress.total })}</span>
            <div
              class="scheduled-delete-progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.completed}
              aria-label={t("scheduled.deletingProgress", { completed: progress.completed, total: progress.total })}
            >
              <span style={{ width: `${progress.total === 0 ? 0 : (progress.completed / progress.total) * 100}%` }} />
            </div>
          </div>
        )}
        <footer>
          <button
            type="button"
            class="quiet-button"
            disabled={busy}
            data-mobile-overlay-initial-focus
            onClick={close}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            class="scheduled-delete-dialog-confirm"
            disabled={busy}
            onClick={() => void onConfirm()}
          >
            <TrashIcon />
            <span>{busy ? t("scheduled.deleting") : t("scheduled.confirmAction")}</span>
          </button>
        </footer>
      </section>
    </div>
  );
}

export function ScheduledSessionsPanel({ hideTitle = false }: { hideTitle?: boolean } = {}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ScheduledDeleteRequest | null>(null);
  const [deleteFailureCount, setDeleteFailureCount] = useState<number | null>(null);
  const [deleteProgress, setDeleteProgress] = useState<SessionDeletionProgress | null>(null);
  const deleteInFlight = useRef(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [visibleByGroup, setVisibleByGroup] = useState<Record<string, number>>({});
  const [keepDrafts, setKeepDrafts] = useState<Record<string, string>>({});
  const defaultKeepCount = scheduledKeepCount.value;
  const keepCountsByGroup = scheduledKeepCountsByGroup.value;
  const inventoryState = sessionInventoryState.value;
  const loadingAllSessions = !sessionInventoryComplete.value || inventoryState.loading || inventoryState.hasMore;

  useEffect(() => {
    if (!inventoryState.hasMore || inventoryState.loading) return;
    void loadMoreSessions();
  }, [inventoryState.hasMore, inventoryState.loading, inventoryState.nextCursor]);

  const groups = scheduledSessionGroups(sessions.value);
  const total = groups.reduce((count, group) => count + group.sessions.length, 0);

  const requestDelete = (key: string, ids: readonly string[], message: string) => {
    if (busyKey || pendingDelete || ids.length === 0) return;
    setDeleteFailureCount(null);
    setPendingDelete({ key, ids: [...new Set(ids)], message });
  };

  const confirmDelete = async () => {
    const request = pendingDelete;
    if (!request || deleteInFlight.current) return;
    deleteInFlight.current = true;
    setBusyKey(request.key);
    setDeleteProgress({ completed: 0, total: request.ids.length, deleted: 0, failed: 0 });
    try {
      const result = await deleteSessions(request.ids, { onProgress: setDeleteProgress });
      setDeleteFailureCount(result.failed.length > 0 ? result.failed.length : null);
    } catch {
      setDeleteFailureCount(request.ids.length);
    } finally {
      deleteInFlight.current = false;
      setBusyKey(null);
      setDeleteProgress(null);
      setPendingDelete(null);
    }
  };

  const deleteAll = () => requestDelete(
    "all",
    groups.flatMap((group) => group.sessions.map((session) => session.id)),
    t("scheduled.deleteAllConfirm", { count: total }),
  );

  const deleteGroup = (groupKey: string) => {
    const group = groups.find((item) => item.key === groupKey);
    const ids = (group?.sessions ?? []).map((session) => session.id);
    requestDelete(
      `group:${groupKey}`,
      ids,
      t("scheduled.deleteGroupConfirm", { count: ids.length }),
    );
  };

  const pruneGroup = (groupKey: string, keepCount: number, pruneCount: number) => {
    if (busyKey || pruneCount === 0) return;
    const group = groups.find((item) => item.key === groupKey);
    const ids = (group?.sessions ?? []).slice(keepCount).map((session) => session.id);
    requestDelete(
      `prune:${groupKey}`,
      ids,
      t("scheduled.pruneGroupConfirm", { keep: keepCount, count: ids.length }),
    );
  };

  const deleteOne = (sessionId: string) => requestDelete(
    sessionId,
    [sessionId],
    t("scheduled.deleteOneConfirm"),
  );

  const toggleGroup = (groupKey: string) => {
    setCollapsedGroups((current) => ({ ...current, [groupKey]: !current[groupKey] }));
  };

  const visibleCountFor = (groupKey: string, totalSessions: number) => {
    const requested = visibleByGroup[groupKey] ?? INITIAL_VISIBLE_SESSIONS;
    return Math.min(totalSessions, Math.max(INITIAL_VISIBLE_SESSIONS, requested));
  };

  const showMoreSessions = (groupKey: string, totalSessions: number) => {
    setVisibleByGroup((current) => {
      const currentVisible = current[groupKey] ?? INITIAL_VISIBLE_SESSIONS;
      return {
        ...current,
        [groupKey]: Math.min(totalSessions, currentVisible + VISIBLE_SESSION_STEP),
      };
    });
  };

  const keepDraftFor = (groupKey: string, keepCount: number) => {
    return keepDrafts[groupKey] ?? String(keepCount);
  };

  const commitKeepCount = (groupKey: string, draft: string, fallback: number) => {
    const next = Number(draft);
    if (!Number.isFinite(next)) {
      setKeepDrafts((current) => ({ ...current, [groupKey]: String(fallback) }));
      return;
    }
    setScheduledKeepCount(next, groupKey);
    setKeepDrafts((current) => ({ ...current, [groupKey]: String(getScheduledKeepCount(groupKey)) }));
  };

  return (
    <section
      class="scheduled-sessions-page"
      aria-label={hideTitle ? t("scheduled.title") : undefined}
      aria-labelledby={hideTitle ? undefined : "scheduled-sessions-title"}
    >
      <header class={`page-title-row scheduled-sessions-page-head ${hideTitle ? "is-title-hidden" : ""}`}>
        <div class="heading-info-group">
          {!hideTitle && <h1 id="scheduled-sessions-title">{t("scheduled.title")}</h1>}
          <InfoTip text={`${t("scheduled.subtitle", { count: total })} ${t("scheduled.note")} ${t("scheduled.deleteNote")}`} align="start" side="bottom" />
        </div>
        <button
          type="button"
          class="quiet-button scheduled-sessions-delete-all"
          disabled={total === 0 || busyKey !== null || loadingAllSessions}
          onClick={deleteAll}
        >
          <TrashIcon />
          <span>{busyKey === "all"
            ? t("scheduled.deleting")
            : loadingAllSessions
              ? t("scheduled.loadingAll")
              : t("scheduled.deleteAll")}</span>
        </button>
      </header>

      {deleteFailureCount !== null && (
        <p class="scheduled-delete-error" role="alert">
          {t("scheduled.deleteFailed", { count: deleteFailureCount })}
        </p>
      )}

      <div class="scheduled-sessions-list">
        {groups.length === 0 ? (
          <p class="scheduled-sessions-empty">{t("scheduled.empty")}</p>
        ) : groups.map((group, groupIndex) => {
          const profile = profileList.value.find((item) => item.id === group.profileId);
          const keepCount = getScheduledKeepCount(group.key, defaultKeepCount);
          void keepCountsByGroup[group.key];
          const pruneCount = Math.max(0, group.sessions.length - keepCount);
          const collapsed = Boolean(collapsedGroups[group.key]);
          const visibleCount = visibleCountFor(group.key, group.sessions.length);
          const visibleSessions = group.sessions.slice(0, visibleCount);
          const remainingCount = Math.max(0, group.sessions.length - visibleCount);
          const nextRevealCount = Math.min(VISIBLE_SESSION_STEP, remainingCount);
          const profileName = profile ? profileDisplayName(profile) : group.profileId;
          const groupDomId = `scheduled-session-group-${groupIndex}`;
          const keepDraft = keepDraftFor(group.key, keepCount);
          return (
            <section class={`scheduled-session-group ${collapsed ? "is-collapsed" : ""}`} key={group.key}>
              <header>
                <button
                  type="button"
                  class="scheduled-session-group-toggle"
                  aria-expanded={!collapsed}
                  aria-controls={groupDomId}
                  aria-label={`${collapsed ? t("scheduled.expandGroup") : t("scheduled.collapseGroup")}: ${group.label} · ${profileName} · ${t("scheduled.sessionCount", { count: group.sessions.length })}`}
                  onClick={() => toggleGroup(group.key)}
                >
                  <span class="scheduled-session-group-caret" aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
                  <span class="scheduled-session-group-title">
                    <b>{group.label}</b>
                    <small>{profileName}</small>
                    <span class="scheduled-session-group-count">{t("scheduled.sessionCount", { count: group.sessions.length })}</span>
                  </span>
                </button>
                <div class="scheduled-session-group-actions">
                  <label class="scheduled-session-group-keep">
                    <span class="scheduled-session-group-keep-label">{t("scheduled.keepLabelShort")}</span>
                    <input
                      type="number"
                      class="scheduled-keep-input"
                      min={0}
                      max={500}
                      step={1}
                      inputMode="numeric"
                      value={keepDraft}
                      disabled={busyKey !== null}
                      aria-label={t("scheduled.keepLabelForGroup", { label: group.label })}
                      title={t("scheduled.keepLabelForGroup", { label: group.label })}
                      onClick={(event) => event.stopPropagation()}
                      onInput={(event) => {
                        const value = event.currentTarget.value;
                        setKeepDrafts((current) => ({ ...current, [group.key]: value }));
                      }}
                      onBlur={() => commitKeepCount(group.key, keepDraft, keepCount)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.currentTarget.blur();
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    class="quiet-button scheduled-session-group-prune"
                    disabled={pruneCount === 0 || busyKey !== null}
                    aria-label={busyKey === `prune:${group.key}` ? t("scheduled.deleting") : t("scheduled.pruneGroup", { count: pruneCount, keep: keepCount })}
                    title={busyKey === `prune:${group.key}` ? t("scheduled.deleting") : t("scheduled.pruneGroup", { count: pruneCount, keep: keepCount })}
                    onClick={() => void pruneGroup(group.key, keepCount, pruneCount)}
                  >
                    <span>{busyKey === `prune:${group.key}` ? t("scheduled.deleting") : t("scheduled.pruneGroup", { count: pruneCount })}</span>
                  </button>
                  <button
                    type="button"
                    class="quiet-button scheduled-session-group-delete"
                    disabled={busyKey !== null}
                    aria-label={busyKey === `group:${group.key}` ? t("scheduled.deleting") : t("scheduled.deleteGroup")}
                    title={busyKey === `group:${group.key}` ? t("scheduled.deleting") : t("scheduled.deleteGroup")}
                    onClick={() => deleteGroup(group.key)}
                  >
                    <TrashIcon />
                    <span>{busyKey === `group:${group.key}` ? t("scheduled.deleting") : t("scheduled.deleteGroup")}</span>
                  </button>
                </div>
              </header>
              {!collapsed && (
                <div class="scheduled-session-rows" id={groupDomId}>
                  {visibleSessions.map((session, index) => (
                    <div
                      key={session.id}
                      class={`scheduled-session-row ${session.status === "streaming" ? "is-running" : session.connectionState === "error" || session.errorMessage ? "is-attention" : "is-ready"} ${index >= keepCount ? "is-prunable" : ""}`}
                    >
                      <button
                        type="button"
                        class="scheduled-session-open"
                        aria-label={chatSessionTitle(session)}
                        title={chatSessionTitle(session)}
                        onClick={() => {
                          openSession(session.id);
                          openMobileWorkspace();
                        }}
                      >
                        <i aria-hidden="true" />
                        <span>{chatSessionTitle(session)}</span>
                        <small>
                          {index < keepCount
                            ? t("scheduled.kept")
                            : session.status === "streaming"
                              ? t("profile.running")
                              : session.connectionState === "error" || session.errorMessage
                                ? t("chat.status.error")
                                : t("chat.status.ready")}
                        </small>
                      </button>
                      <button
                        type="button"
                        class="scheduled-session-delete"
                        disabled={busyKey !== null}
                        aria-label={t("scheduled.deleteOne")}
                        title={t("scheduled.deleteOne")}
                        onClick={() => void deleteOne(session.id)}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  ))}
                  {remainingCount > 0 && (
                    <button
                      type="button"
                      class="quiet-button scheduled-session-show-more"
                      onClick={() => showMoreSessions(group.key, group.sessions.length)}
                    >
                      {t("scheduled.showMore", { count: nextRevealCount, remaining: remainingCount })}
                    </button>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <ScheduledDeleteDialog
        request={pendingDelete}
        busy={busyKey !== null}
        progress={deleteProgress}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </section>
  );
}
