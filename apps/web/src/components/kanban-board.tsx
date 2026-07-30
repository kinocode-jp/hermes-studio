import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { TaskStatus, TaskWritableStatus, WorkTask } from "../domain";
import { chatSessionTitle, locale, localizeRuntimeMessage, t, type TranslationKey } from "../i18n";
import { appModalSizes, createModalResizeHandlers, getAppModalSize, shouldIgnoreModalOutsideClose } from "../app-modal-layout";
import {
  addTaskComment,
  askAssigneeAboutTask,
  assignTask,
  clearFocusedKanbanTask,
  closeEmbeddedChatSession,
  createTask,
  expandedTaskId,
  focusedKanbanTaskId,
  kanbanAssignees,
  kanbanState,
  officeConnection,
  profileList,
  refreshKanbanBoard,
  retryTaskComments,
  sessions,
  taskCommentDetail,
  tasks,
  toggleTaskComments
} from "../store";
import {
  allowUnconfirmedCommentResend,
  allowUnconfirmedTaskResend,
  confirmUnconfirmedComment,
  confirmUnconfirmedTaskCreation,
  taskCreationBusy,
  unconfirmedTaskComments,
  unconfirmedTaskCreation
} from "../kanban-store";
import { profileDisplayName } from "../profile-names";
import {
  kanbanTeamFilterId,
  setKanbanTeamFilter,
  teams,
} from "../teams-store";
import {
  isKanbanColumnCollapsed,
  loadKanbanColumnVisibility,
  paintKanbanColumns,
  requestTaskMove,
  saveKanbanColumnVisibility,
  toggleKanbanSelectedStatus,
  visibleKanbanStatuses,
  type KanbanBoardStatus,
  type KanbanColumnVisibility,
} from "../kanban-board-logic";
import { InfoTip } from "./info-tip";
import { ChatIcon, CloseIcon, MenuIcon, SendIcon } from "./icons";
import { useMobileOverlay } from "./use-mobile-overlay";
import { useModalOutsideClose } from "./use-modal-outside-close";
import { ChatPane } from "./chat-pane";

export { isKanbanColumnCollapsed, requestTaskMove } from "../kanban-board-logic";

const columns: Array<{ id: TaskStatus; label: TranslationKey; caption: TranslationKey; writable?: TaskWritableStatus }> = [
  { id: "triage", label: "kanban.column.triage", caption: "kanban.caption.triage", writable: "triage" },
  { id: "todo", label: "kanban.column.todo", caption: "kanban.caption.todo", writable: "todo" },
  { id: "scheduled", label: "kanban.column.scheduled", caption: "kanban.caption.scheduled", writable: "scheduled" },
  { id: "ready", label: "kanban.column.ready", caption: "kanban.caption.ready", writable: "ready" },
  { id: "running", label: "kanban.column.running", caption: "kanban.caption.running" },
  { id: "blocked", label: "kanban.column.blocked", caption: "kanban.caption.blocked", writable: "blocked" },
  { id: "review", label: "kanban.column.review", caption: "kanban.caption.review" },
  { id: "done", label: "kanban.column.done", caption: "kanban.caption.done", writable: "done" }
];
const writableColumns = columns.filter((column): column is typeof column & { writable: TaskWritableStatus } => Boolean(column.writable));
const writableStatuses = new Set<TaskStatus>(writableColumns.map((column) => column.writable));

const DRAG_MIME = "application/x-hermes-task";

function isKanbanTaskDrag(event: DragEvent): boolean {
  return Boolean(event.dataTransfer?.types && [...event.dataTransfer.types].includes(DRAG_MIME));
}
const DETAIL_CLICK_SLOP_PX = 6;

function TaskCard({ task, focusRequested = false }: { task: WorkTask; focusRequested?: boolean }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const detailGesture = useRef<{ x: number; y: number; dragged: boolean; pointerId: number | null } | null>(null);
  const suppressOpenUntil = useRef(0);
  const assignee = profileList.value.find((profile) => profile.id === task.assigneeId);
  const selectableProfiles = kanbanAssignees.value.length === 0
    ? profileList.value
    // `default` is the Studio reception/coordinator profile. Hermes board
    // snapshots may omit it from active-worker candidates, but the server
    // accepts it as a valid assignee and coordinator work must be trackable.
    : profileList.value.filter((profile) => profile.id === "default" || kanbanAssignees.value.includes(profile.id));
  const expanded = expandedTaskId.value === task.id;
  const detail = taskCommentDetail.value.cardId === task.id ? taskCommentDetail.value : undefined;
  const unconfirmedComment = unconfirmedTaskComments.value[task.id];
  const chatReady = (officeConnection.value.source === "server" && officeConnection.value.runtime === "ready")
    || (officeConnection.value.source === "demo" && officeConnection.value.state === "demo");
  const canAskAssignee = Boolean(task.assigneeId) && !task.pending && chatReady;
  const askDisabledReason = task.pending
    ? t("kanban.saving")
    : !task.assigneeId
      ? t("kanban.askAssigneeNoAssignee")
      : !chatReady
        ? t("kanban.askAssigneeUnavailable")
        : undefined;
  const previewText = task.latestSummary ?? task.body;
  const statusLabel = columns.find((column) => column.id === task.status);

  useEffect(() => {
    if (!focusRequested) return;
    const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    cardRef.current?.scrollIntoView({ block: "center", inline: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
    setDetailOpen(true);
    clearFocusedKanbanTask(task.id);
  }, [focusRequested, task.id]);

  const submitComment = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem("comment") as HTMLInputElement;
    const submittedValue = input.value;
    if (await addTaskComment(task.id, submittedValue) === "success" && input.isConnected && input.value === submittedValue) {
      input.value = "";
    }
  };

  const openDetailIfClick = () => {
    if (detailOpen) return;
    if (Date.now() < suppressOpenUntil.current) return;
    if (shouldIgnoreModalOutsideClose()) return;
    if (detailGesture.current?.dragged) return;
    setDetailOpen(true);
  };

  const closeDetail = () => {
    // Closing via scrim can synthesize a click/pointerup on the card underneath.
    suppressOpenUntil.current = Date.now() + 350;
    detailGesture.current = null;
    setDetailOpen(false);
  };

  return (
    <article
      ref={cardRef}
      class={`task-card priority-${task.priority} ${task.pending ? "is-pending" : ""}`}
      draggable={!task.pending}
      onDragStart={(event) => {
        if (task.pending) {
          event.preventDefault();
          return;
        }
        if (detailGesture.current) detailGesture.current.dragged = true;
        event.dataTransfer?.setData(DRAG_MIME, task.id);
        event.dataTransfer!.effectAllowed = "move";
      }}
    >
      <div class="task-card-topline">
        <span class="task-id">{task.id}</span>
        {task.pending && <span class="task-saving" role="img" aria-label={t("kanban.saving")} title={t("kanban.saving")} />}
      </div>
      <div
        class="task-card-content"
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-label={t("kanban.detailOpenAria", { title: task.title })}
        onPointerDown={(event) => {
          if (detailOpen || shouldIgnoreModalOutsideClose() || Date.now() < suppressOpenUntil.current) {
            detailGesture.current = null;
            return;
          }
          detailGesture.current = {
            x: event.clientX,
            y: event.clientY,
            dragged: false,
            pointerId: event.pointerId,
          };
        }}
        onPointerMove={(event) => {
          const gesture = detailGesture.current;
          if (!gesture || gesture.dragged) return;
          if (gesture.pointerId !== null && gesture.pointerId !== event.pointerId) return;
          const dx = event.clientX - gesture.x;
          const dy = event.clientY - gesture.y;
          if (dx * dx + dy * dy > DETAIL_CLICK_SLOP_PX * DETAIL_CLICK_SLOP_PX) gesture.dragged = true;
        }}
        onPointerUp={(event) => {
          const gesture = detailGesture.current;
          if (!gesture || (gesture.pointerId !== null && gesture.pointerId !== event.pointerId)) {
            detailGesture.current = null;
            return;
          }
          openDetailIfClick();
          detailGesture.current = null;
        }}
        onPointerCancel={() => { detailGesture.current = null; }}
        onClick={(event) => {
          // Modal scrim close can fall through as a click on the card.
          if (detailOpen || shouldIgnoreModalOutsideClose() || Date.now() < suppressOpenUntil.current) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setDetailOpen(true);
          }
        }}
      >
        <h3>{task.title}</h3>
        {previewText && <p class="task-summary">{previewText}</p>}
        {!previewText && <p class="task-summary task-summary--empty">{t("kanban.detailNoBody")}</p>}
      </div>

      {detailOpen && (
        <TaskDetailModal
          task={task}
          onClose={closeDetail}
        />
      )}

      <label class="task-assignee-select">
        <span>{t("kanban.assignee")}</span>
        <select
          value={task.assigneeId ?? ""}
          disabled={task.pending}
          onChange={(event) => void assignTask(task.id, event.currentTarget.value || null)}
        >
          <option value="">{t("kanban.unassigned")}</option>
          {selectableProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profileDisplayName(profile)}</option>)}
        </select>
      </label>

      <label class="task-status-select">
        <span>{t("kanban.status")}</span>
        <select
          value={writableStatuses.has(task.status) ? task.status : ""}
          disabled={task.pending}
          onChange={(event) => void requestTaskMove(task.id, event.currentTarget.value)}
        >
          {!writableStatuses.has(task.status) && <option value="" disabled>{t("kanban.managedStatus")}</option>}
          {writableColumns.map((column) => <option key={column.id} value={column.writable}>{t(column.label)}</option>)}
        </select>
      </label>
      <span class="task-status-info"><InfoTip text={t("kanban.managedStatusHint")} align="end" side="top" /></span>

      <footer>
        <span class="task-assignee">
          {assignee ? <i style={{ background: assignee.color }} /> : <i class="unassigned" />}
          {assignee ? profileDisplayName(assignee) : t("kanban.unassigned")}
        </span>
        <button
          type="button"
          class="quiet-button task-ask-assignee"
          disabled={!canAskAssignee}
          title={askDisabledReason ?? t("kanban.askAssignee")}
          aria-label={t("kanban.askAssigneeAria", { title: task.title })}
          onClick={() => { askAssigneeAboutTask(task); }}
        >
          <ChatIcon width={16} height={16} />
        </button>
        <button type="button" class="task-notes-button" aria-expanded={expanded} aria-label={t("kanban.notes", { count: task.comments })} title={t("kanban.notes", { count: task.comments })} onClick={() => void toggleTaskComments(task.id)}>
          <ChatIcon width={14} height={14} /><span>{task.comments}</span>
        </button>
      </footer>

      {expanded && (
        <section class="task-comments" aria-label={t("kanban.commentsAria", { title: task.title })}>
          {detail?.state === "loading" && <p class="task-comments-state" role="status">{t("kanban.commentsLoading")}</p>}
          {detail?.state === "error" && (
            <div class="task-comments-error" role="alert">
              <span>{t("kanban.commentsError")}</span>
              <button type="button" onClick={() => void retryTaskComments()}>{t("kanban.commentsRetry")}</button>
            </div>
          )}
          {detail && detail.comments.length > 0 && (
            <ol class="task-comment-list">
              {detail.comments.map((comment) => (
                <li key={comment.id}>
                  <header><strong>{comment.author}</strong><time dateTime={commentDate(comment.createdAt).toISOString()}>{formatCommentTime(comment.createdAt)}</time></header>
                  <p>{comment.body}</p>
                </li>
              ))}
            </ol>
          )}
          {detail?.state === "ready" && detail.comments.length === 0 && <p class="task-comments-empty">{t("kanban.commentsEmpty")}</p>}
          {detail?.truncated && <p class="task-comments-limit">{t("kanban.commentsLimited", { shown: detail.comments.length, count: detail.availableCommentCount })}</p>}
          <form class="task-comment-form" onSubmit={submitComment}>
            <input name="comment" aria-label={t("kanban.commentAria", { title: task.title })} placeholder={t("kanban.commentPlaceholder")} maxLength={16000} required />
            <button type="submit" disabled={task.pending || Boolean(unconfirmedComment)} aria-label={t("chat.send")} title={t("chat.send")}><SendIcon width={16} height={16} /></button>
          </form>
          {unconfirmedComment && (
            <UnconfirmedSubmissionNotice
              detail={t("kanban.unknown.comment")}
              checked={unconfirmedComment.checked}
              checking={unconfirmedComment.checking}
              onCheck={() => void confirmUnconfirmedComment(task.id)}
              onAllow={() => allowUnconfirmedCommentResend(task.id)}
            />
          )}
        </section>
      )}
    </article>
  );
}

function TaskDetailModal({
  task,
  onClose,
}: {
  task: WorkTask;
  onClose(): void;
}) {
  const overlay = useMobileOverlay<HTMLElement>({
    kind: "modal",
    open: true,
    onClose,
    viewport: "(min-width: 0px)",
  });
  const _sizes = appModalSizes.value;
  const modalSize = getAppModalSize("task-detail");
  const resize = useMemo(() => createModalResizeHandlers("task-detail"), []);
  useEffect(() => () => resize.dispose(), [resize]);
  const outsideClose = useModalOutsideClose(onClose);

  // Keep comments expanded while the modal is open.
  useEffect(() => {
    if (expandedTaskId.value !== task.id) void toggleTaskComments(task.id);
  }, [task.id]);

  const liveTask = tasks.value.find((item) => item.id === task.id) ?? task;
  const assignee = profileList.value.find((profile) => profile.id === liveTask.assigneeId);
  const selectableProfiles = kanbanAssignees.value.length === 0
    ? profileList.value
    : profileList.value.filter((profile) => profile.id === "default" || kanbanAssignees.value.includes(profile.id));
  const detail = taskCommentDetail.value.cardId === liveTask.id ? taskCommentDetail.value : undefined;
  const unconfirmedComment = unconfirmedTaskComments.value[liveTask.id];
  const chatReady = (officeConnection.value.source === "server" && officeConnection.value.runtime === "ready")
    || (officeConnection.value.source === "demo" && officeConnection.value.state === "demo");
  const canAskAssignee = Boolean(liveTask.assigneeId) && !liveTask.pending && chatReady;
  const askDisabledReason = liveTask.pending
    ? t("kanban.saving")
    : !liveTask.assigneeId
      ? t("kanban.askAssigneeNoAssignee")
      : !chatReady
        ? t("kanban.askAssigneeUnavailable")
        : undefined;

  // null = closed by user; undefined = not opened yet; string = explicit open session id
  const [chatSessionId, setChatSessionId] = useState<string | null | undefined>(undefined);
  const chatSession = typeof chatSessionId === "string"
    ? sessions.value.find((session) => session.id === chatSessionId)
    : undefined;
  const chatProfile = chatSession
    ? profileList.value.find((profile) => profile.id === chatSession.profileId)
    : undefined;

  const body = liveTask.body?.trim() || "";
  const summary = liveTask.latestSummary?.trim() || "";
  const showBoth = Boolean(body && summary && body !== summary);
  const showChat = chatSessionId !== null && Boolean(chatSession && chatProfile);
  const chatStatusText = !chatSession ? ""
    : chatSession.connectionState === "error" ? t("chat.status.error")
      : chatSession.connectionState === "queued" ? t("chat.status.queued")
        : chatSession.connectionState === "connecting" ? t("chat.status.connecting")
        : chatSession.connectionState === "disconnected" ? t("chat.status.reconnecting")
          : chatSession.status === "waiting" ? t("chat.status.waiting")
            : chatSession.status === "streaming" ? t("chat.status.running")
              : t("chat.status.ready");

  const closeChatPane = (event?: Event) => {
    event?.preventDefault();
    event?.stopPropagation();
    setChatSessionId(null);
  };

  useEffect(() => {
    if (typeof chatSessionId !== "string") return;
    return () => closeEmbeddedChatSession(chatSessionId);
  }, [chatSessionId]);

  const submitComment = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem("comment") as HTMLInputElement;
    const submittedValue = input.value;
    if (await addTaskComment(liveTask.id, submittedValue) === "success" && input.isConnected && input.value === submittedValue) {
      input.value = "";
    }
  };

  const askAssignee = () => {
    const sessionId = askAssigneeAboutTask(liveTask, { openWorkspace: false });
    if (sessionId) setChatSessionId(sessionId);
  };

  return (
    <div
      class="task-detail-modal-layer"
      data-modal-affordance="true"
      role="presentation"
      {...outsideClose}
    >
      <button
        class="task-detail-modal-scrim"
        type="button"
        aria-label={t("common.close")}
        onPointerDown={(event) => {
          if (shouldIgnoreModalOutsideClose()) return;
          event.stopPropagation();
          onClose();
        }}
        onClick={(event) => {
          event.stopPropagation();
        }}
      />
      <section
        ref={overlay.ref}
        class={`task-detail-modal ${showChat ? "has-chat" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`task-detail-title-${liveTask.id}`}
        tabIndex={-1}
        style={{ width: `${modalSize.width}px`, height: `${modalSize.height}px` }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <header class="task-detail-modal-head">
          <div>
            <span class="task-id">{liveTask.id}</span>
            <h2 id={`task-detail-title-${liveTask.id}`}>{liveTask.title}</h2>
          </div>
          <button
            type="button"
            class="task-detail-modal-close"
            data-mobile-overlay-initial-focus
            onClick={onClose}
            aria-label={t("common.close")}
            title={t("common.close")}
          >
            <CloseIcon width={18} height={18} />
          </button>
        </header>

        <div class={`task-detail-modal-layout ${showChat ? "is-split" : ""}`}>
          <div class="task-detail-main">
            <div class="task-detail-controls">
              <div class="task-detail-controls-row">
                <label class="task-assignee-select">
                  <span>{t("kanban.assignee")}</span>
                  <select
                    value={liveTask.assigneeId ?? ""}
                    disabled={liveTask.pending}
                    onChange={(event) => void assignTask(liveTask.id, event.currentTarget.value || null)}
                  >
                    <option value="">{t("kanban.unassigned")}</option>
                    {selectableProfiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>{profileDisplayName(profile)}</option>
                    ))}
                  </select>
                </label>

                <label class="task-status-select">
                  <span>{t("kanban.status")}</span>
                  <select
                    value={writableStatuses.has(liveTask.status) ? liveTask.status : ""}
                    disabled={liveTask.pending}
                    onChange={(event) => void requestTaskMove(liveTask.id, event.currentTarget.value)}
                  >
                    {!writableStatuses.has(liveTask.status) && <option value="" disabled>{t("kanban.managedStatus")}</option>}
                    {writableColumns.map((column) => (
                      <option key={column.id} value={column.writable}>{t(column.label)}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div class="task-detail-controls-foot">
                <small class="task-status-hint">{t("kanban.managedStatusHint")}</small>
                <div class="task-detail-actions">
                  <span class="task-assignee">
                    {assignee ? <i style={{ background: assignee.color }} /> : <i class="unassigned" />}
                    {assignee ? profileDisplayName(assignee) : t("kanban.unassigned")}
                  </span>
                  <button
                    type="button"
                    class="secondary-button task-ask-assignee"
                    disabled={!canAskAssignee}
                    title={askDisabledReason ?? t("kanban.askAssignee")}
                    aria-label={t("kanban.askAssigneeAria", { title: liveTask.title })}
                    onClick={askAssignee}
                  >
                    {t("kanban.askAssignee")}
                  </button>
                </div>
              </div>
            </div>

            <dl class="task-detail-meta">
              <div>
                <dt>{t("kanban.detailPriority")}</dt>
                <dd>{liveTask.priority === "high" ? t("kanban.detailPriorityHigh") : t("kanban.detailPriorityNormal")}</dd>
              </div>
              <div>
                <dt>{t("kanban.notes", { count: liveTask.comments })}</dt>
                <dd>{liveTask.comments}</dd>
              </div>
            </dl>

            <div class="task-detail-modal-body">
              {showBoth && (
                <section class="task-detail-section">
                  <h3>{t("kanban.detailSummary")}</h3>
                  <p class="task-detail-text">{summary}</p>
                </section>
              )}
              <section class="task-detail-section">
                <h3>{showBoth ? t("kanban.detailBody") : t("kanban.detailContent")}</h3>
                {body || summary
                  ? <p class="task-detail-text">{body || summary}</p>
                  : <p class="task-detail-empty">{t("kanban.detailNoBody")}</p>}
              </section>

              <section class="task-comments task-detail-comments" aria-label={t("kanban.commentsAria", { title: liveTask.title })}>
                <h3>{t("kanban.notes", { count: liveTask.comments })}</h3>
                {detail?.state === "loading" && <p class="task-comments-state" role="status">{t("kanban.commentsLoading")}</p>}
                {detail?.state === "error" && (
                  <div class="task-comments-error" role="alert">
                    <span>{t("kanban.commentsError")}</span>
                    <button type="button" onClick={() => void retryTaskComments()}>{t("kanban.commentsRetry")}</button>
                  </div>
                )}
                {detail && detail.comments.length > 0 && (
                  <ol class="task-comment-list">
                    {detail.comments.map((comment) => (
                      <li key={comment.id}>
                        <header>
                          <strong>{comment.author}</strong>
                          <time dateTime={commentDate(comment.createdAt).toISOString()}>{formatCommentTime(comment.createdAt)}</time>
                        </header>
                        <p>{comment.body}</p>
                      </li>
                    ))}
                  </ol>
                )}
                {detail?.state === "ready" && detail.comments.length === 0 && (
                  <p class="task-comments-empty">{t("kanban.commentsEmpty")}</p>
                )}
                {detail?.truncated && (
                  <p class="task-comments-limit">
                    {t("kanban.commentsLimited", { shown: detail.comments.length, count: detail.availableCommentCount })}
                  </p>
                )}
                <form class="task-comment-form" onSubmit={submitComment}>
                  <input
                    name="comment"
                    aria-label={t("kanban.commentAria", { title: liveTask.title })}
                    placeholder={t("kanban.commentPlaceholder")}
                    maxLength={16000}
                    required
                  />
                  <button type="submit" disabled={liveTask.pending || Boolean(unconfirmedComment)}>{t("chat.send")}</button>
                </form>
                {unconfirmedComment && (
                  <UnconfirmedSubmissionNotice
                    detail={t("kanban.unknown.comment")}
                    checked={unconfirmedComment.checked}
                    checking={unconfirmedComment.checking}
                    onCheck={() => void confirmUnconfirmedComment(liveTask.id)}
                    onAllow={() => allowUnconfirmedCommentResend(liveTask.id)}
                  />
                )}
              </section>
            </div>
          </div>

          {showChat && chatSession && chatProfile && (
            <div class="task-detail-chat" aria-label={t("kanban.askAssignee")}>
              <header class="task-detail-chat-head">
                <div class="task-detail-chat-identity">
                  <span class="profile-dot" style={{ background: chatProfile.color }} />
                  <div>
                    <span>{t("kanban.askAssignee")}</span>
                    <strong title={`${profileDisplayName(chatProfile)} · ${chatSessionTitle(chatSession)}`}>
                      {profileDisplayName(chatProfile)}
                      <em>{chatSessionTitle(chatSession)}</em>
                    </strong>
                  </div>
                </div>
                <div class="task-detail-chat-meta">
                  <span
                    class={`chat-state state-${chatSession.connectionState ?? chatSession.status}`}
                    role="img"
                    aria-label={chatStatusText}
                    title={chatStatusText}
                  />
                  <button
                    type="button"
                    class="icon-button"
                    onPointerDown={closeChatPane}
                    onClick={closeChatPane}
                    aria-label={t("common.close")}
                    title={t("common.close")}
                  >
                    <CloseIcon width={18} height={18} />
                  </button>
                </div>
              </header>
              <div class="task-detail-chat-pane">
                <ChatPane
                  session={chatSession}
                  profile={chatProfile}
                  hideHeader
                  onClosePane={() => setChatSessionId(null)}
                />
              </div>
            </div>
          )}
        </div>

        {resize.handles.map((handle) => (
          <div
            key={handle.edge}
            class={`app-modal-resize ${handle.className}`}
            role="separator"
            aria-label={t("common.resizeModal")}
            title={t("common.resizeModal")}
            onPointerDown={resize.begin(handle.edge)}
          />
        ))}
      </section>
    </div>
  );
}

function TaskCreateModal({
  title,
  titleRef,
  busy,
  onTitleChange,
  onClose,
  onSubmit,
}: {
  title: string;
  titleRef: { current: HTMLInputElement | null };
  busy: boolean;
  onTitleChange(value: string): void;
  onClose(): void;
  onSubmit(event: SubmitEvent): void | Promise<void>;
}) {
  const overlay = useMobileOverlay<HTMLElement>({
    kind: "modal",
    open: true,
    onClose,
    viewport: "(min-width: 0px)",
  });
  const _sizes = appModalSizes.value;
  const modalSize = getAppModalSize("task-create");
  const resize = useMemo(() => createModalResizeHandlers("task-create"), []);
  useEffect(() => () => resize.dispose(), [resize]);

  return (
    <div
      class="task-create-modal-layer"
      data-modal-affordance="true"
      role="presentation"
      onPointerDown={(event) => {
        if (shouldIgnoreModalOutsideClose() || busy) return;
        if (event.target === event.currentTarget) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <button
        class="task-create-modal-scrim"
        type="button"
        aria-label={t("common.close")}
        disabled={busy}
        onPointerDown={(event) => {
          if (shouldIgnoreModalOutsideClose() || busy) return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      />
      <section
        ref={overlay.ref}
        class="task-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-create-modal-title"
        tabIndex={-1}
        style={{ width: `${modalSize.width}px`, height: `${modalSize.height}px` }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <header class="task-create-modal-head">
          <h2 id="task-create-modal-title">{t("kanban.createTitle")}</h2>
          <button
            type="button"
            class="task-create-modal-close"
            data-mobile-overlay-initial-focus
            onClick={onClose}
            disabled={busy}
            aria-label={t("common.close")}
            title={t("common.close")}
          >
            <CloseIcon width={18} height={18} />
          </button>
        </header>
        <form class="task-create-form" onSubmit={onSubmit}>
          <label class="task-create-field">
            <span>{t("kanban.newTask")}</span>
            <input
              ref={titleRef}
              name="task-title"
              value={title}
              onInput={(event) => onTitleChange(event.currentTarget.value)}
              aria-label={t("kanban.newTask")}
              placeholder={t("kanban.newTaskPlaceholder")}
              maxLength={240}
              required
              disabled={busy}
            />
          </label>
          <footer class="task-create-actions">
            <button type="button" class="quiet-button" onClick={onClose} disabled={busy}>{t("kanban.createCancel")}</button>
            <button class="primary-button" type="submit" disabled={busy || !title.trim()}>{t("kanban.createSubmit")}</button>
          </footer>
        </form>
        {resize.handles.map((handle) => (
          <div
            key={handle.edge}
            class={`app-modal-resize ${handle.className}`}
            role="separator"
            aria-label={t("common.resizeModal")}
            title={t("common.resizeModal")}
            onPointerDown={resize.begin(handle.edge)}
          />
        ))}
      </section>
    </div>
  );
}

function UnconfirmedSubmissionNotice({
  detail,
  checked,
  checking,
  onCheck,
  onAllow
}: {
  detail: string;
  checked: boolean;
  checking: boolean;
  onCheck(): void;
  onAllow(): void;
}) {
  return (
    <section class="kanban-unconfirmed" role="alert">
      <strong>{t("kanban.unknown.title")}</strong>
      <p>{checked ? t("kanban.unknown.checked") : detail}</p>
      {checked
        ? <button type="button" onClick={onAllow}>{t("kanban.unknown.retry")}</button>
        : <button type="button" disabled={checking} onClick={onCheck}>{t("kanban.unknown.check")}</button>}
    </section>
  );
}

export function KanbanBoard({ hideTitle = false }: { hideTitle?: boolean } = {}) {
  const [columnCollapse, setColumnCollapse] = useState<Partial<Record<TaskStatus, boolean>>>({});
  const [dragOverColumn, setDragOverColumn] = useState<TaskStatus | null>(null);
  const [columnVisibility, setColumnVisibility] = useState(loadKanbanColumnVisibility);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const createTitleRef = useRef<HTMLInputElement>(null);

  const closeCreateModal = () => {
    if (taskCreationBusy.value) return;
    setCreateOpen(false);
  };

  const openCreateModal = () => {
    if (boardStateLoadingOrBusy()) return;
    setCreateTitle("");
    setCreateOpen(true);
    requestAnimationFrame(() => createTitleRef.current?.focus());
  };

  const submitTask = async (event: SubmitEvent) => {
    event.preventDefault();
    const title = createTitle.trim();
    if (!title) return;
    if (await createTask(title) === "success") {
      setCreateTitle("");
        setCreateOpen(false);
    }
  };

  function boardStateLoadingOrBusy(): boolean {
    return kanbanState.value.state === "loading" || taskCreationBusy.value || Boolean(unconfirmedTaskCreation.value);
  }
  const boardState = kanbanState.value;
  const teamFilterId = kanbanTeamFilterId.value;
  const filterTeam = teamFilterId ? teams.value.find((team) => team.id === teamFilterId) : undefined;
  const memberIds = filterTeam ? new Set(filterTeam.memberProfileIds) : null;
  const itemCountFor = (columnId: TaskStatus): number => tasks.value.reduce((count, task) => {
    if (task.status !== columnId) return count;
    if (memberIds && (task.assigneeId === undefined || !memberIds.has(task.assigneeId))) return count;
    return count + 1;
  }, 0);
  const visibleColumns = paintKanbanColumns(columns, columnVisibility, itemCountFor);
  const selectedStatusCount = visibleKanbanStatuses(columnVisibility).length;
  const focusedTask = tasks.value.find((task) => task.id === focusedKanbanTaskId.value);

  const updateColumnVisibility = (next: KanbanColumnVisibility) => {
    const sanitized: KanbanColumnVisibility = {
      mode: next.mode === "selected" ? "selected" : "all",
      selected: next.selected,
      hideEmpty: next.hideEmpty === true,
      layout: next.layout === "stream" ? "stream" : "columns",
    };
    setColumnVisibility(sanitized);
    saveKanbanColumnVisibility(sanitized);
  };

  useEffect(() => {
    if (!focusedTask) return;
    if (memberIds && (focusedTask.assigneeId === undefined || !memberIds.has(focusedTask.assigneeId))) {
      setKanbanTeamFilter("");
    }
    if (columnVisibility.mode === "selected"
      && !columnVisibility.selected.includes(focusedTask.status as KanbanBoardStatus)) {
      updateColumnVisibility({
        ...columnVisibility,
        selected: toggleKanbanSelectedStatus(
          columnVisibility.selected,
          focusedTask.status as KanbanBoardStatus,
        ),
      });
    }
    setColumnCollapse((current) => ({ ...current, [focusedTask.status]: false }));
  }, [
    focusedTask?.id,
    focusedTask?.status,
    focusedTask?.assigneeId,
    teamFilterId,
    columnVisibility.mode,
    columnVisibility.selected.join("|"),
  ]);


  const toggleColumn = (columnId: TaskStatus, itemCount: number) => {
    setColumnCollapse((current) => {
      const nextCollapsed = !isKanbanColumnCollapsed(columnId, itemCount, current);
      return { ...current, [columnId]: nextCollapsed };
    });
  };

  const acceptDrop = (column: (typeof columns)[number], event: DragEvent) => {
    const status = column.writable;
    if (!status) return;
    const taskId = event.dataTransfer?.getData(DRAG_MIME);
    // Other draggable content (sidebar panels and chats) belongs to the
    // dashboard-level drop target and must keep bubbling through the board.
    if (!taskId) return;
    event.preventDefault();
    event.stopPropagation();
    setDragOverColumn(null);
    // Dropping onto a collapsed column expands it so the move is visible.
    setColumnCollapse((current) => ({ ...current, [column.id]: false }));
    void requestTaskMove(taskId, status);
  };

  return (
    <section class="kanban-page">
      <header class={`page-title-row ${hideTitle ? "is-title-hidden" : ""}`}>
        {!hideTitle && (
          <div class="heading-info-group">
            <h1>{t("kanban.title")}</h1>
            <InfoTip text={t("kanban.boardHint")} align="start" side="bottom" />
          </div>
        )}
        <div class="page-title-actions">
          <div class="kanban-filter-toolbar">
            <button
              type="button"
              class={`kanban-filter-toggle ${filtersOpen ? "is-open" : ""}`}
              aria-expanded={filtersOpen}
              aria-controls="kanban-filter-panel"
              aria-label={t("kanban.filters.toggle")}
              title={t("kanban.filters.toggle")}
              onClick={() => setFiltersOpen((current) => !current)}
            >
              <MenuIcon width={18} height={18} />
            </button>
            <InfoTip
              text={[
                columnVisibility.mode === "all"
                  ? t("kanban.columnFilter.modeAll")
                  : t("kanban.columnFilter.selectedSummary", { count: selectedStatusCount }),
                columnVisibility.layout === "stream" ? t("kanban.layout.stream") : t("kanban.layout.columns"),
                columnVisibility.hideEmpty ? t("kanban.columnFilter.hideEmptyOn") : t("kanban.columnFilter.hideEmptyOff"),
              ].join(" · ")}
              align="end"
              side="bottom"
            />
          </div>
          <div class={`kanban-sync state-${boardState.state}`} role={boardState.state === "error" ? "alert" : "status"}>
            <span
              class="kanban-sync-dot"
              role="img"
              aria-label={localizeRuntimeMessage(boardState.message)}
              title={localizeRuntimeMessage(boardState.message)}
            />
            {(boardState.state === "loading" || boardState.state === "saving" || boardState.state === "error") && (
              <span class="visually-hidden">{localizeRuntimeMessage(boardState.message)}</span>
            )}
            <button
              type="button"
              class="kanban-sync-reload"
              onClick={() => void refreshKanbanBoard({ acknowledgeErrors: true })}
              disabled={boardState.state === "loading"}
              title={localizeRuntimeMessage(boardState.message)}
              aria-label={t("kanban.reload")}
            >
              <span aria-hidden="true">↻</span>
            </button>
          </div>
          <button
            class="primary-button"
            type="button"
            aria-label={t("kanban.add")}
            title={t("kanban.add")}
            onClick={openCreateModal}
            disabled={boardState.state === "loading" || taskCreationBusy.value || Boolean(unconfirmedTaskCreation.value)}
          >
            <span aria-hidden="true">＋</span>
          </button>
        </div>
        {unconfirmedTaskCreation.value && (
          <UnconfirmedSubmissionNotice
            detail={t("kanban.unknown.task")}
            checked={unconfirmedTaskCreation.value.checked}
            checking={unconfirmedTaskCreation.value.checking}
            onCheck={() => void confirmUnconfirmedTaskCreation()}
            onAllow={allowUnconfirmedTaskResend}
          />
        )}
      </header>

      {createOpen && (
        <TaskCreateModal
          title={createTitle}
          titleRef={createTitleRef}
          busy={taskCreationBusy.value}
          onTitleChange={setCreateTitle}
          onClose={closeCreateModal}
          onSubmit={submitTask}
        />
      )}

      <div class="kanban-filters">
        {filtersOpen && (
        <div id="kanban-filter-panel" class="kanban-filter-card" role="region" aria-label={t("kanban.filters.label")}>
          <div class="kanban-filter-row">
            <label class="kanban-filter-field">
              <span>{t("kanban.teamFilter")}</span>
              <select
                value={teamFilterId}
                onChange={(event) => setKanbanTeamFilter(event.currentTarget.value)}
                aria-label={t("kanban.teamFilter")}
              >
                <option value="">{t("kanban.teamFilterAll")}</option>
                {teams.value.map((team) => (
                  <option key={team.id} value={team.id}>{team.name}</option>
                ))}
              </select>
            </label>
            <div class="kanban-filter-modes" role="group" aria-label={t("kanban.columnFilter.label")}>
              <span class="kanban-filter-kicker">
                {t("kanban.columnFilter.label")}
                <InfoTip
                  text={[
                    columnVisibility.mode === "selected"
                      ? t("kanban.columnFilter.hint", { count: selectedStatusCount })
                      : t("kanban.columnFilter.modeAll"),
                    columnVisibility.hideEmpty
                      ? t("kanban.columnFilter.hideEmptyHint", { shown: visibleColumns.length })
                      : t("kanban.columnFilter.hideEmptyOff"),
                  ].filter(Boolean).join(" · ")}
                  align="start"
                  side="bottom"
                />
              </span>
              <label class={`kanban-mode-chip ${columnVisibility.mode === "all" ? "is-active" : ""}`}>
                <input
                  type="radio"
                  name="kanban-column-mode"
                  checked={columnVisibility.mode === "all"}
                  onChange={() => updateColumnVisibility({ ...columnVisibility, mode: "all" })}
                />
                <span>{t("kanban.columnFilter.modeAll")}</span>
              </label>
              <label class={`kanban-mode-chip ${columnVisibility.mode === "selected" ? "is-active" : ""}`}>
                <input
                  type="radio"
                  name="kanban-column-mode"
                  checked={columnVisibility.mode === "selected"}
                  onChange={() => updateColumnVisibility({ ...columnVisibility, mode: "selected" })}
                />
                <span>{t("kanban.columnFilter.modeSelected")}</span>
              </label>
            </div>
            <div class="kanban-filter-modes" role="group" aria-label={t("kanban.layout.label")}>
              <span class="kanban-filter-kicker">{t("kanban.layout.label")}</span>
              <label class={`kanban-mode-chip ${columnVisibility.layout !== "stream" ? "is-active" : ""}`}>
                <input
                  type="radio"
                  name="kanban-layout"
                  checked={columnVisibility.layout !== "stream"}
                  onChange={() => updateColumnVisibility({ ...columnVisibility, layout: "columns" })}
                />
                <span>{t("kanban.layout.columns")}</span>
              </label>
              <label class={`kanban-mode-chip ${columnVisibility.layout === "stream" ? "is-active" : ""}`}>
                <input
                  type="radio"
                  name="kanban-layout"
                  checked={columnVisibility.layout === "stream"}
                  onChange={() => updateColumnVisibility({ ...columnVisibility, layout: "stream" })}
                />
                <span>{t("kanban.layout.stream")}</span>
              </label>
            </div>
            <label class={`kanban-status-check kanban-hide-empty ${columnVisibility.hideEmpty ? "is-checked" : ""}`}>
              <input
                type="checkbox"
                checked={columnVisibility.hideEmpty}
                onChange={(event) => updateColumnVisibility({
                  ...columnVisibility,
                  hideEmpty: event.currentTarget.checked,
                })}
              />
              <span>{t("kanban.columnFilter.hideEmpty")}</span>
            </label>
          </div>

          {filterTeam && (
            <small class="kanban-filter-hint">{t("kanban.teamFilterHint", { name: filterTeam.name, count: filterTeam.memberProfileIds.length })}</small>
          )}

          <div class={`kanban-column-checks ${columnVisibility.mode === "selected" ? "is-enabled" : "is-disabled"}`}>
            {columns.map((column) => {
              const checked = columnVisibility.selected.includes(column.id as KanbanBoardStatus);
              const count = itemCountFor(column.id);
              return (
                <label key={column.id} class={`kanban-status-check ${checked ? "is-checked" : ""}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={columnVisibility.mode !== "selected"}
                    onChange={() => {
                      updateColumnVisibility({
                        ...columnVisibility,
                        mode: "selected",
                        selected: toggleKanbanSelectedStatus(columnVisibility.selected, column.id as KanbanBoardStatus),
                      });
                    }}
                  />
                  <span>{t(column.label)}</span>
                  <em aria-hidden="true">{count}</em>
                </label>
              );
            })}
          </div>

        </div>
        )}
      </div>

      <div class={`kanban-board ${columnVisibility.mode === "selected" || columnVisibility.hideEmpty ? "is-focus-mode" : ""} ${columnVisibility.layout === "stream" ? "is-stream" : ""}`}>
        {visibleColumns.length === 0 && (
          <div class="kanban-board-empty" role="status">
            <strong>{t("kanban.columnFilter.emptyTitle")}</strong>
            <p>
              {columnVisibility.hideEmpty
                ? t("kanban.columnFilter.emptyHideEmpty")
                : t("kanban.columnFilter.emptySelected")}
            </p>
          </div>
        )}
        {visibleColumns.map((column) => {
          const items = tasks.value.filter((task) => {
            if (task.status !== column.id) return false;
            if (!memberIds) return true;
            return task.assigneeId !== undefined && memberIds.has(task.assigneeId);
          });
          const collapsed = isKanbanColumnCollapsed(column.id, items.length, columnCollapse);
          const dropActive = dragOverColumn === column.id && Boolean(column.writable);
          return (
            <section
              class={`kanban-column column-${column.id} ${column.writable ? "is-writable" : "is-managed"} ${collapsed && columnVisibility.layout !== "stream" ? "is-collapsed" : ""} ${dropActive ? "is-drop-target" : ""}`}
              key={column.id}
              data-column={column.id}
              onDragEnter={(event) => {
                if (!column.writable || !isKanbanTaskDrag(event)) return;
                event.preventDefault();
                setDragOverColumn(column.id);
              }}
              onDragOver={(event) => {
                if (!column.writable || !isKanbanTaskDrag(event)) return;
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                if (dragOverColumn !== column.id) setDragOverColumn(column.id);
              }}
              onDragLeave={(event) => {
                const next = event.relatedTarget;
                if (next instanceof Node && event.currentTarget.contains(next)) return;
                if (dragOverColumn === column.id) setDragOverColumn(null);
              }}
              onDrop={(event) => acceptDrop(column, event)}
            >
              <header class="kanban-column-head">
                <button
                  type="button"
                  class="kanban-column-toggle"
                  aria-expanded={columnVisibility.layout === "stream" ? true : !collapsed}
                  aria-controls={`kanban-stack-${column.id}`}
                  title={columnVisibility.layout === "stream" ? t(column.label) : (collapsed ? t("kanban.columnExpand") : t("kanban.columnCollapse"))}
                  onClick={() => {
                    if (columnVisibility.layout === "stream") return;
                    toggleColumn(column.id, items.length);
                  }}
                >
                  {columnVisibility.layout !== "stream" && (
                    <span class="kanban-column-chevron" aria-hidden="true">{collapsed ? "›" : "▾"}</span>
                  )}
                  <span class="kanban-column-copy">
                    <b>
                      {t(column.label)}
                      {columnVisibility.layout !== "stream" && (
                        <span class="kanban-column-caption">
                          {t(column.caption)}{!column.writable ? ` · ${t("kanban.automatic")}` : ""}
                        </span>
                      )}
                    </b>
                  </span>
                  <strong aria-label={t("kanban.columnCount", { count: items.length })}>{items.length}</strong>
                </button>
              </header>
              <div
                id={`kanban-stack-${column.id}`}
                class="task-stack"
                hidden={columnVisibility.layout !== "stream" && collapsed}
                aria-hidden={columnVisibility.layout !== "stream" && collapsed}
              >
                {items.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    focusRequested={focusedKanbanTaskId.value === task.id}
                  />
                ))}
                {items.length === 0 && (
                  <p class={`column-empty ${column.writable ? "is-droppable" : ""}`}>
                    {column.writable ? t("kanban.emptyDrop") : t("kanban.empty")}
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

function commentDate(createdAt: number): Date {
  return new Date(createdAt * 1_000);
}

function formatCommentTime(createdAt: number): string {
  return new Intl.DateTimeFormat(locale.value === "ja" ? "ja-JP" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(commentDate(createdAt));
}
