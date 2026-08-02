import { useState } from "preact/hooks";
import type { ChatSession } from "../domain";
import { loadAllSessions, requestInventorySnapshotRefresh } from "../inventory";
import { isScheduledSessionHidden } from "../scheduled-sessions";
import { sessionMatchesDeleteScope, type SessionDeleteScope } from "../session-delete-scope";
import { deleteSessions, sessions as sessionStore } from "../store";
import { chatSessionTitle, t } from "../i18n";
import { TrashIcon } from "./icons";
import { useMobileOverlay } from "./use-mobile-overlay";

export function SessionDeleteDialog({ session, onClose }: {
  session: ChatSession;
  onClose: () => void;
}) {
  return <SessionsDeleteDialog sessions={[session]} onClose={onClose} />;
}

export function SessionsDeleteDialog({ sessions, onClose, deleteScope }: {
  sessions: readonly ChatSession[];
  onClose: () => void;
  deleteScope?: SessionDeleteScope;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const ids = [...new Set(sessions.map((session) => session.id))];
  const single = sessions.length === 1;
  const bulk = !single || deleteScope !== undefined;
  const overlay = useMobileOverlay<HTMLElement>({
    kind: "modal",
    open: true,
    onClose: () => { if (!busy) onClose(); },
    viewport: "(min-width: 0px)",
  });

  const confirmDelete = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    setProgress(bulk ? { completed: 0, total: ids.length } : null);
    try {
      let pendingIds = ids;
      let completed = 0;
      let total = ids.length;
      for (let round = 0; round < 100; round += 1) {
        const base = completed;
        const result = await deleteSessions(pendingIds, {
          onProgress: (next) => setProgress({
            completed: base + next.completed,
            total: Math.max(total, base + next.total),
          }),
        });
        if (result.failed.length > 0) throw new Error("session-delete-partial");
        completed += result.deleted.length;
        if (!deleteScope) {
          onClose();
          return;
        }

        await requestInventorySnapshotRefresh();
        if (!await loadAllSessions()) throw new Error("session-inventory-incomplete");
        pendingIds = sessionStore.value
          .filter((session) => sessionMatchesDeleteScope(session, deleteScope) && !isScheduledSessionHidden(session))
          .map((session) => session.id);
        if (pendingIds.length === 0) {
          onClose();
          return;
        }
        total = Math.max(total, completed + pendingIds.length);
        setProgress({ completed, total });
      }
      throw new Error("session-delete-round-limit");
    } catch {
      // The destructive action stays explicit and retryable in the dialog.
    }
    setBusy(false);
    setProgress(null);
    setFailed(true);
  };

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
        onClick={() => { if (!busy) onClose(); }}
      />
      <section
        ref={overlay.ref}
        class="scheduled-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="session-delete-title"
        aria-describedby="session-delete-message"
        tabIndex={-1}
      >
        <header>
          <TrashIcon />
          <h2 id="session-delete-title">{bulk ? t("chat.sessionsDeleteTitle") : t("chat.sessionDeleteTitle")}</h2>
        </header>
        <div id="session-delete-message" class="scheduled-delete-dialog-message">
          <p>{!bulk
            ? t("chat.sessionDeleteConfirm", { title: chatSessionTitle(sessions[0]!) })
            : deleteScope?.kind === "project"
              ? t("project.menu.deleteProjectConfirm", { count: ids.length })
              : deleteScope?.kind === "all-projects"
                ? t("project.menu.deleteAllConfirm", { count: ids.length })
                : t("chat.sessionsDeleteConfirm", { count: ids.length })}</p>
          <p>{t("chat.sessionDeleteNote")}</p>
        </div>
        {progress && (
          <div class="scheduled-delete-progress" role="status" aria-live="polite">
            <span>{t("chat.sessionsDeletingProgress", { completed: progress.completed, total: progress.total })}</span>
            <div class="scheduled-delete-progress-track" aria-hidden="true">
              <span style={{ width: `${progress.total > 0 ? (progress.completed / progress.total) * 100 : 0}%` }} />
            </div>
          </div>
        )}
        {failed && <p class="scheduled-delete-error" role="alert">{bulk ? t("chat.sessionsDeleteFailed") : t("chat.sessionDeleteFailed")}</p>}
        <footer>
          <button
            type="button"
            class="quiet-button"
            disabled={busy}
            data-mobile-overlay-initial-focus
            onClick={() => { if (!busy) onClose(); }}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            class="scheduled-delete-dialog-confirm"
            disabled={busy}
            onClick={() => void confirmDelete()}
          >
            <TrashIcon />
            <span>{busy
              ? t("chat.sessionDeleting")
              : bulk
                ? t("chat.sessionsDeleteAction", { count: ids.length })
                : t("chat.sessionDeleteAction")}</span>
          </button>
        </footer>
      </section>
    </div>
  );
}
