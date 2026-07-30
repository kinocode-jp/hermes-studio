import { signal } from "@preact/signals";
import type { KanbanConnectionState, TaskWritableStatus, WorkTask } from "./domain";
import { classifyKanbanMutationFailure, type KanbanApi } from "./kanban-api";
import { createTaskCommentController } from "./kanban-comments";
import { officeMessage, type RuntimeMessage } from "./i18n";

type KanbanState = { state: KanbanConnectionState; message: RuntimeMessage; latestEventId: number };
type MutationContext = { api: KanbanApi; runtime: number; operation: number; message: RuntimeMessage };
export type KanbanSubmissionOutcome = "success" | "rejected" | "commit-unknown" | "stale";
export type UnconfirmedSubmission = { input: string; operation: number; checked: boolean; checking: boolean };

export const tasks = signal<WorkTask[]>([]);
export const focusedKanbanTaskId = signal("");
export const kanbanAssignees = signal<string[]>([]);
export const kanbanState = signal<KanbanState>({
  state: "idle",
  message: officeMessage("runtime.kanban.connecting"),
  latestEventId: 0
});
export const unconfirmedTaskCreation = signal<UnconfirmedSubmission | undefined>(undefined);
export const unconfirmedTaskComments = signal<Record<string, UnconfirmedSubmission>>({});
export const taskCreationBusy = signal(false);

let kanbanApi: KanbanApi | undefined;
let liveKanbanApi: KanbanApi | undefined;
let demoRuntimeActive = false;
let kanbanRefresh: Promise<void> | undefined;
let kanbanRefreshRequested = 0;
let kanbanRefreshCompleted = 0;
let kanbanRefreshShowLoadingRequested = false;
const kanbanRefreshOutcomes = new Map<number, boolean>();
let boardGeneration = 0;
let runtimeGeneration = 0;
let operationGeneration = 0;
let boardError: RuntimeMessage | undefined;
let mutationError: { runtime: number; operation: number; message: RuntimeMessage } | undefined;
const currentOperations = new Map<string, number>();
const pendingMutations = new Map<number, MutationContext>();
let taskCreationFlight: { runtime: number; operation: number } | undefined;
let updateProfileTaskCounts = (_counts: ReadonlyMap<string, number>) => {};

const taskComments = createTaskCommentController(() => kanbanApi);
export const expandedTaskId = taskComments.expandedTaskId;
export const taskCommentDetail = taskComments.taskCommentDetail;
export const toggleTaskComments = taskComments.toggle;
export const retryTaskComments = taskComments.retry;

export function registerKanbanProfileTaskUpdater(update: (counts: ReadonlyMap<string, number>) => void): void {
  updateProfileTaskCounts = update;
}

export function focusKanbanTask(taskId: string): void {
  focusedKanbanTaskId.value = taskId.trim();
}

export function clearFocusedKanbanTask(taskId: string): void {
  if (focusedKanbanTaskId.value === taskId) focusedKanbanTaskId.value = "";
}

export function registerKanbanRuntime(api: KanbanApi): void {
  liveKanbanApi = api;
  if (demoRuntimeActive) return;
  activateRuntime(api);
  void refreshKanbanBoard();
}

export function loadKanbanDemoRuntime(api: KanbanApi): void {
  demoRuntimeActive = true;
  activateRuntime(api);
  kanbanState.value = { state: "loading", message: officeMessage("runtime.kanban.loading"), latestEventId: 0 };
  void refreshKanbanBoard();
}

function activateRuntime(api: KanbanApi | undefined): void {
  runtimeGeneration += 1;
  kanbanApi = api;
  currentOperations.clear();
  pendingMutations.clear();
  taskCreationFlight = undefined;
  taskCreationBusy.value = false;
  boardError = undefined;
  mutationError = undefined;
  unconfirmedTaskCreation.value = undefined;
  unconfirmedTaskComments.value = {};
  taskComments.collapse();
  focusedKanbanTaskId.value = "";
  kanbanRefreshShowLoadingRequested = false;
  tasks.value = [];
  kanbanAssignees.value = [];
}

export async function refreshKanbanBoard(options: { acknowledgeErrors?: boolean; background?: boolean } = {}): Promise<boolean> {
  if (!kanbanApi) return false;
  const runtime = runtimeGeneration;
  if (!options.background) kanbanRefreshShowLoadingRequested = true;
  if (options.acknowledgeErrors) {
    boardError = undefined;
    mutationError = undefined;
  }
  const requested = ++kanbanRefreshRequested;
  while (kanbanRefreshCompleted < requested) {
    kanbanRefresh ??= drainKanbanRefreshes();
    await kanbanRefresh;
  }
  const succeeded = kanbanRefreshOutcomes.get(requested) ?? false;
  kanbanRefreshOutcomes.delete(requested);
  return succeeded && runtime === runtimeGeneration;
}

async function drainKanbanRefreshes(): Promise<void> {
  try {
    while (kanbanRefreshCompleted < kanbanRefreshRequested) {
      const previous = kanbanRefreshCompleted;
      const generation = kanbanRefreshRequested;
      const showLoading = kanbanRefreshShowLoadingRequested;
      kanbanRefreshShowLoadingRequested = false;
      const succeeded = await loadKanbanBoard(showLoading);
      for (let request = previous + 1; request <= generation; request += 1) {
        kanbanRefreshOutcomes.set(request, succeeded);
      }
      kanbanRefreshCompleted = generation;
    }
  } finally {
    kanbanRefresh = undefined;
  }
}

async function loadKanbanBoard(showLoading: boolean): Promise<boolean> {
  const api = kanbanApi!;
  const runtime = runtimeGeneration;
  if (showLoading && !hasCurrentMutations() && !currentError()) {
    kanbanState.value = { ...kanbanState.value, state: "loading", message: officeMessage("runtime.kanban.loading") };
  }
  try {
    const board = await api.fetchBoard();
    if (api !== kanbanApi || runtime !== runtimeGeneration) return false;
    boardGeneration += 1;
    boardError = undefined;
    tasks.value = board.tasks.map((task) => currentOperations.has(task.id) ? { ...task, pending: true } : task);
    kanbanAssignees.value = board.assignees;
    kanbanState.value = { ...kanbanState.value, latestEventId: board.latestEventId };
    notifyProfileTaskCounts();
    const expanded = expandedTaskId.value;
    if (expanded && !board.tasks.some((task) => task.id === expanded)) taskComments.collapse();
    else await taskComments.refreshIfExpanded();
    if (api !== kanbanApi || runtime !== runtimeGeneration) return false;
    publishKanbanState();
    return true;
  } catch (error) {
    if (api !== kanbanApi || runtime !== runtimeGeneration) return false;
    boardError = errorRuntimeMessage(error);
    publishKanbanState();
    return false;
  }
}

export function resetKanbanRuntimeState(): void {
  demoRuntimeActive = false;
  activateRuntime(liveKanbanApi);
  kanbanState.value = { state: "idle", message: officeMessage("runtime.kanban.waiting"), latestEventId: 0 };
  notifyProfileTaskCounts();
}

export async function assignTask(taskId: string, profileId: string | null): Promise<void> {
  const api = kanbanApi;
  const previous = tasks.value.find((task) => task.id === taskId);
  const nextAssignee = profileId ?? undefined;
  if (!api || !previous || previous.pending || previous.assigneeId === nextAssignee) return;
  const context = beginMutation(api, officeMessage("runtime.kanban.assigning"));
  beginTaskOperation(taskId, context.operation, { ...previous, assigneeId: nextAssignee });
  const startedAtBoard = boardGeneration;
  try {
    await context.api.updateCard(taskId, { assignee: profileId });
    if (!isCurrent(context)) return;
    await refreshKanbanBoard();
  } catch (error) {
    if (!isCurrent(context)) return;
    await refreshKanbanBoard();
    if (!isCurrent(context)) return;
    if (boardGeneration === startedAtBoard) rollbackAssignee(taskId, context.operation, nextAssignee, previous.assigneeId);
    finishTaskOperation(taskId, context.operation);
    failMutation(context, errorRuntimeMessage(error));
    return;
  }
  if (!isCurrent(context)) return;
  finishTaskOperation(taskId, context.operation);
  finishMutation(context);
}

export async function moveTask(taskId: string, status: TaskWritableStatus): Promise<void> {
  const api = kanbanApi;
  const previous = tasks.value.find((task) => task.id === taskId);
  if (!api || !previous || previous.pending || previous.status === status) return;
  const context = beginMutation(api, officeMessage("runtime.kanban.moving"));
  beginTaskOperation(taskId, context.operation, { ...previous, status });
  const startedAtBoard = boardGeneration;
  try {
    await context.api.updateCard(taskId, { status });
    if (!isCurrent(context)) return;
    await refreshKanbanBoard();
  } catch (error) {
    if (!isCurrent(context)) return;
    await refreshKanbanBoard();
    if (!isCurrent(context)) return;
    if (boardGeneration === startedAtBoard) rollbackStatus(taskId, context.operation, status, previous.status);
    finishTaskOperation(taskId, context.operation);
    failMutation(context, errorRuntimeMessage(error));
    return;
  }
  if (!isCurrent(context)) return;
  finishTaskOperation(taskId, context.operation);
  finishMutation(context);
}

/**
 * Hermes Kanban's supported removal path is the archived status. Archived
 * cards disappear from the active board without deleting related chats or
 * durable conversation history.
 */
export async function deleteTask(taskId: string): Promise<boolean> {
  const task = tasks.value.find((item) => item.id === taskId);
  if (!task || task.pending) return false;
  await moveTask(taskId, "archived");
  return !tasks.value.some((item) => item.id === taskId && item.status !== "archived");
}

export async function createTask(title: string): Promise<KanbanSubmissionOutcome> {
  const trimmed = title.trim();
  const api = kanbanApi;
  if (!trimmed || !api) return "rejected";
  if (unconfirmedTaskCreation.value) return "commit-unknown";
  if (taskCreationFlight?.runtime === runtimeGeneration) return "rejected";
  const context = beginMutation(api, officeMessage("runtime.kanban.creating"));
  const flight = { runtime: context.runtime, operation: context.operation };
  taskCreationFlight = flight;
  taskCreationBusy.value = true;
  const temporaryId = `pending-${crypto.randomUUID()}`;
  const startedAtBoard = boardGeneration;
  tasks.value = [...tasks.value, { id: temporaryId, title: trimmed, status: "triage", priority: "normal", comments: 0, pending: true }];
  try {
    const created = await context.api.createCard(trimmed);
    if (!isCurrent(context)) return "stale";
    await refreshKanbanBoard();
    if (!isCurrent(context)) return "stale";
    if (boardGeneration === startedAtBoard) {
      tasks.value = tasks.value.map((task) => task.id === temporaryId ? { ...created, pending: false } : task);
      notifyProfileTaskCounts();
    }
    finishMutation(context);
    return "success";
  } catch (error) {
    if (!isCurrent(context)) return "stale";
    tasks.value = tasks.value.filter((task) => task.id !== temporaryId);
    const kind = classifyKanbanMutationFailure(error);
    if (kind === "commit-unknown") {
      unconfirmedTaskCreation.value = { input: trimmed, operation: context.operation, checked: false, checking: false };
      failMutation(context, officeMessage("kanban.unknown.title"));
      return kind;
    }
    failMutation(context, errorRuntimeMessage(error));
    return "rejected";
  } finally {
    if (taskCreationFlight === flight) {
      taskCreationFlight = undefined;
      taskCreationBusy.value = false;
    }
  }
}

export async function addTaskComment(taskId: string, body: string): Promise<KanbanSubmissionOutcome> {
  const trimmed = body.trim();
  const api = kanbanApi;
  const previous = tasks.value.find((task) => task.id === taskId);
  if (!trimmed || !api || !previous || previous.pending) return "rejected";
  if (unconfirmedTaskComments.value[taskId]) return "commit-unknown";
  const context = beginMutation(api, officeMessage("runtime.kanban.commenting"));
  const optimisticCount = previous.comments + 1;
  beginTaskOperation(taskId, context.operation, { ...previous, comments: optimisticCount });
  const startedAtBoard = boardGeneration;
  try {
    await context.api.addComment(taskId, trimmed);
    if (!isCurrent(context)) return "stale";
  } catch (error) {
    if (!isCurrent(context)) return "stale";
    const kind = classifyKanbanMutationFailure(error);
    if (kind === "commit-unknown") {
      rollbackCommentCount(taskId, context.operation, optimisticCount, previous.comments);
      finishTaskOperation(taskId, context.operation);
      unconfirmedTaskComments.value = {
        ...unconfirmedTaskComments.value,
        [taskId]: { input: trimmed, operation: context.operation, checked: false, checking: false }
      };
      failMutation(context, officeMessage("kanban.unknown.title"));
      return kind;
    }
    await refreshKanbanBoard();
    if (!isCurrent(context)) return "stale";
    if (boardGeneration === startedAtBoard) rollbackCommentCount(taskId, context.operation, optimisticCount, previous.comments);
    finishTaskOperation(taskId, context.operation);
    failMutation(context, errorRuntimeMessage(error));
    return "rejected";
  }

  const boardSucceeded = await refreshKanbanBoard();
  if (!isCurrent(context)) return "stale";
  let detailSucceeded = true;
  if (!boardSucceeded && expandedTaskId.value === taskId) {
    detailSucceeded = await taskComments.refreshIfExpanded(taskId) === true;
  } else if (expandedTaskId.value === taskId) {
    detailSucceeded = taskCommentDetail.value.cardId === taskId && taskCommentDetail.value.state === "ready";
  }
  if (!isCurrent(context)) return "stale";
  finishTaskOperation(taskId, context.operation);
  if (!boardSucceeded || !detailSucceeded) {
    failMutation(context, officeMessage("kanban.commentSentRefreshFailed"));
  } else {
    finishMutation(context);
  }
  return "success";
}

export async function confirmUnconfirmedTaskCreation(): Promise<boolean> {
  const pending = unconfirmedTaskCreation.value;
  const runtime = runtimeGeneration;
  if (!pending || pending.checking) return false;
  unconfirmedTaskCreation.value = { ...pending, checking: true };
  const succeeded = await refreshKanbanBoard();
  if (runtime !== runtimeGeneration || unconfirmedTaskCreation.value?.input !== pending.input) return false;
  unconfirmedTaskCreation.value = { ...pending, checked: succeeded, checking: false };
  return succeeded;
}

export function allowUnconfirmedTaskResend(): void {
  const pending = unconfirmedTaskCreation.value;
  if (!pending?.checked) return;
  unconfirmedTaskCreation.value = undefined;
  acknowledgeMutationError(pending.operation);
}

export async function confirmUnconfirmedComment(taskId: string): Promise<boolean> {
  const pending = unconfirmedTaskComments.value[taskId];
  const runtime = runtimeGeneration;
  if (!pending || pending.checking) return false;
  const detailGeneration = taskComments.currentLoadGeneration();
  unconfirmedTaskComments.value = updateUnconfirmedComment(taskId, { ...pending, checking: true });
  await refreshKanbanBoard();
  if (!isCurrentUnconfirmedComment(taskId, pending, runtime)) return false;
  let succeeded = taskComments.hasSuccessfulLoadStartedAfter(taskId, detailGeneration);
  if (!succeeded && expandedTaskId.value === taskId) {
    succeeded = await taskComments.refreshIfExpanded(taskId) === true;
  }
  if (!isCurrentUnconfirmedComment(taskId, pending, runtime)) return false;
  unconfirmedTaskComments.value = updateUnconfirmedComment(taskId, { ...pending, checked: succeeded, checking: false });
  return succeeded;
}

function isCurrentUnconfirmedComment(taskId: string, pending: UnconfirmedSubmission, runtime: number): boolean {
  const current = unconfirmedTaskComments.value[taskId];
  return runtime === runtimeGeneration && current?.operation === pending.operation && current.input === pending.input;
}

export function allowUnconfirmedCommentResend(taskId: string): void {
  const pending = unconfirmedTaskComments.value[taskId];
  if (!pending?.checked) return;
  const next = { ...unconfirmedTaskComments.value };
  delete next[taskId];
  unconfirmedTaskComments.value = next;
  acknowledgeMutationError(pending.operation);
}

function updateUnconfirmedComment(taskId: string, value: UnconfirmedSubmission): Record<string, UnconfirmedSubmission> {
  return { ...unconfirmedTaskComments.value, [taskId]: value };
}

function acknowledgeMutationError(operation: number): void {
  if (mutationError?.runtime === runtimeGeneration && mutationError.operation === operation) {
    mutationError = undefined;
    publishKanbanState();
  }
}

function beginMutation(api: KanbanApi, message: RuntimeMessage): MutationContext {
  const context = { api, runtime: runtimeGeneration, operation: ++operationGeneration, message };
  pendingMutations.set(context.operation, context);
  publishKanbanState();
  return context;
}

function isCurrent(context: MutationContext): boolean {
  return context.api === kanbanApi
    && context.runtime === runtimeGeneration
    && pendingMutations.get(context.operation) === context;
}

function finishMutation(context: MutationContext): void {
  if (!isCurrent(context)) return;
  pendingMutations.delete(context.operation);
  publishKanbanState();
}

function failMutation(context: MutationContext, message: RuntimeMessage): void {
  if (!isCurrent(context)) return;
  pendingMutations.delete(context.operation);
  mutationError = { runtime: context.runtime, operation: context.operation, message };
  publishKanbanState();
}

function hasCurrentMutations(): boolean {
  return [...pendingMutations.values()].some((operation) => operation.runtime === runtimeGeneration);
}

function currentError(): RuntimeMessage | undefined {
  return mutationError?.runtime === runtimeGeneration ? mutationError.message : boardError;
}

function publishKanbanState(): void {
  const error = currentError();
  if (error) {
    kanbanState.value = { ...kanbanState.value, state: "error", message: error };
    return;
  }
  const active = [...pendingMutations.values()].filter((operation) => operation.runtime === runtimeGeneration);
  const latest = active.at(-1);
  kanbanState.value = {
    ...kanbanState.value,
    state: latest ? "saving" : "ready",
    message: latest ? latest.message : officeMessage("runtime.kanban.count", { count: tasks.value.length })
  };
}

function beginTaskOperation(taskId: string, operation: number, optimistic: WorkTask): void {
  currentOperations.set(taskId, operation);
  tasks.value = tasks.value.map((task) => task.id === taskId ? { ...optimistic, pending: true } : task);
}

function finishTaskOperation(taskId: string, operation: number): void {
  if (currentOperations.get(taskId) !== operation) return;
  currentOperations.delete(taskId);
  tasks.value = tasks.value.map((task) => task.id === taskId ? { ...task, pending: false } : task);
}

function rollbackAssignee(taskId: string, operation: number, optimistic: string | undefined, previous: string | undefined): void {
  if (currentOperations.get(taskId) !== operation) return;
  tasks.value = tasks.value.map((task) => task.id === taskId && task.assigneeId === optimistic
    ? { ...task, assigneeId: previous }
    : task);
}

function rollbackStatus(taskId: string, operation: number, optimistic: TaskWritableStatus, previous: WorkTask["status"]): void {
  if (currentOperations.get(taskId) !== operation) return;
  tasks.value = tasks.value.map((task) => task.id === taskId && task.status === optimistic ? { ...task, status: previous } : task);
}

function rollbackCommentCount(taskId: string, operation: number, optimistic: number, previous: number): void {
  if (currentOperations.get(taskId) !== operation) return;
  tasks.value = tasks.value.map((task) => task.id === taskId && task.comments === optimistic ? { ...task, comments: previous } : task);
}

function errorRuntimeMessage(error: unknown): RuntimeMessage {
  if (typeof error === "string") return officeMessage("runtime.office.error", { detail: error });
  if (error instanceof Error) return officeMessage("runtime.office.error", { detail: error.message });
  return officeMessage("runtime.kanban.updateFailed");
}

function notifyProfileTaskCounts(): void {
  const counts = new Map<string, number>();
  for (const task of tasks.value) if (task.assigneeId && task.status !== "done" && task.status !== "archived") {
    counts.set(task.assigneeId, (counts.get(task.assigneeId) ?? 0) + 1);
  }
  updateProfileTaskCounts(counts);
}
