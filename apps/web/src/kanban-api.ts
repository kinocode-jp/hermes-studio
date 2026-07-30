import type { TaskComment, TaskStatus, TaskWritableStatus, WorkTask } from "./domain";
import { OfficeHttpError, officeFetchJson } from "./office-api";

export type KanbanBoardResult = {
  tasks: WorkTask[];
  assignees: string[];
  latestEventId: number;
};

export type KanbanCardDetailResult = {
  card: WorkTask;
  comments: TaskComment[];
  availableCommentCount: number;
  truncated: boolean;
};

export type KanbanApi = {
  fetchBoard(): Promise<KanbanBoardResult>;
  fetchCard(cardId: string): Promise<KanbanCardDetailResult>;
  createCard(title: string): Promise<WorkTask>;
  updateCard(cardId: string, patch: { status?: TaskWritableStatus; assignee?: string | null }): Promise<WorkTask>;
  addComment(cardId: string, body: string): Promise<void>;
};

export type KanbanMutationFailureKind = "rejected" | "commit-unknown";

export class KanbanMutationFailure extends Error {
  constructor(readonly kind: KanbanMutationFailureKind, cause: unknown) {
    super(kind === "commit-unknown"
      ? "The Kanban update may have been saved, but its result could not be confirmed."
      : errorMessage(cause), { cause });
    this.name = "KanbanMutationFailure";
  }
}

/**
 * A 4xx response (other than Request Timeout) proves that Studio Server
 * rejected the request. Transport failures, 5xx responses, and invalid 2xx
 * bodies happen after a non-idempotent request may have committed, so callers
 * must not present them as safe-to-retry failures.
 */
export function classifyKanbanMutationFailure(error: unknown): KanbanMutationFailureKind {
  if (error instanceof KanbanMutationFailure) return error.kind;
  if (error instanceof OfficeHttpError && error.code === "commit_unconfirmed") return "commit-unknown";
  if (error instanceof OfficeHttpError && error.status >= 400 && error.status < 500 && error.status !== 408) {
    return "rejected";
  }
  return "commit-unknown";
}

const READ_STATUSES = new Set<TaskStatus>([
  "triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"
]);
const MAX_RESPONSE_COMMENTS = 2_000;
const MAX_DATE_SECONDS = 8_640_000_000_000;
export const MAX_VISIBLE_COMMENTS = 200;

export function createKanbanApi(): KanbanApi {
  return {
    async fetchBoard() {
      const value = await officeFetchJson<unknown>("/api/v1/kanban", { timeoutMs: 8_000 });
      return normalizeBoard(value);
    },
    async fetchCard(cardId) {
      const value = await officeFetchJson<unknown>(`/api/v1/kanban/cards/${encodeURIComponent(cardId)}`, {
        timeoutMs: 8_000
      });
      return normalizeCardDetail(value, cardId);
    },
    async createCard(title) {
      try {
        const value = await officeFetchJson<unknown>("/api/v1/kanban/cards", {
          method: "POST",
          body: { title, triage: true },
          timeoutMs: 8_000
        });
        return normalizeCardResult(value);
      } catch (error) {
        throw asKanbanMutationFailure(error);
      }
    },
    async updateCard(cardId, patch) {
      const value = await officeFetchJson<unknown>(`/api/v1/kanban/cards/${encodeURIComponent(cardId)}`, {
        method: "PATCH",
        body: patch,
        timeoutMs: 8_000
      });
      return normalizeCardResult(value);
    },
    async addComment(cardId, body) {
      try {
        await officeFetchJson<unknown>(`/api/v1/kanban/cards/${encodeURIComponent(cardId)}/comments`, {
          method: "POST",
          body: { body },
          timeoutMs: 8_000
        });
      } catch (error) {
        throw asKanbanMutationFailure(error);
      }
    }
  };
}

function asKanbanMutationFailure(error: unknown): KanbanMutationFailure {
  return error instanceof KanbanMutationFailure
    ? error
    : new KanbanMutationFailure(classifyKanbanMutationFailure(error), error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Hermes Kanban could not be updated.";
}

export function normalizeCardDetail(value: unknown, requestedCardId: string): KanbanCardDetailResult {
  const detail = record(value, "Kanban card detail");
  const cardValue = record(detail.card, "Kanban detail card");
  assertDetailCard(cardValue);
  const card = normalizeCard(cardValue);
  if (card.id !== requestedCardId || !Array.isArray(detail.comments) || detail.comments.length > MAX_RESPONSE_COMMENTS) {
    throw new Error("Kanban card detail is invalid.");
  }
  const comments = detail.comments.map((comment) => normalizeComment(comment, requestedCardId));
  const ids = new Set(comments.map((comment) => comment.id));
  if (ids.size !== comments.length) throw new Error("Kanban comments are invalid.");
  comments.sort((left, right) => left.createdAt - right.createdAt || left.id - right.id);
  const visible = comments.slice(-MAX_VISIBLE_COMMENTS);
  return {
    card,
    comments: visible,
    availableCommentCount: comments.length,
    truncated: visible.length < comments.length
  };
}

function assertDetailCard(card: Record<string, unknown>): void {
  const nullableText = (value: unknown, max: number) => value === null || boundedString(value, 0, max);
  const nullableTime = (value: unknown) => value === null || safeDateSeconds(value);
  if (!boundedString(card.id, 1, 128)
    || !boundedString(card.title, 1, 240)
    || !nullableText(card.body, 32_000)
    || !(card.assignee === null || boundedString(card.assignee, 1, 128))
    || typeof card.status !== "string" || !READ_STATUSES.has(card.status as TaskStatus)
    || !Number.isSafeInteger(card.priority) || (card.priority as number) < -100 || (card.priority as number) > 100
    || !safeDateSeconds(card.createdAt)
    || !nullableTime(card.startedAt)
    || !nullableTime(card.completedAt)
    || !nullableText(card.latestSummary, 16_000)
    || !nonNegativeSafeInteger(card.commentCount)) {
    throw new Error("Kanban detail card is invalid.");
  }
}

function normalizeBoard(value: unknown): KanbanBoardResult {
  const board = record(value, "Kanban board");
  if (!Array.isArray(board.columns)) throw new Error("Kanban board columns are invalid.");
  const tasks = board.columns.flatMap((entry): WorkTask[] => {
    const column = record(entry, "Kanban column");
    const status = taskStatus(column.status);
    if (!Array.isArray(column.cards)) throw new Error("Kanban cards are invalid.");
    return column.cards.map((card) => normalizeCard(card, status));
  });
  const assignees = Array.isArray(board.assignees)
    ? board.assignees.filter((value): value is string => typeof value === "string")
    : [];
  return {
    tasks,
    assignees,
    latestEventId: finiteNumber(board.latestEventId) ?? 0
  };
}

function normalizeCardResult(value: unknown): WorkTask {
  const result = record(value, "Kanban mutation result");
  return normalizeCard(result.card ?? value);
}

function normalizeCard(value: unknown, fallbackStatus?: TaskStatus): WorkTask {
  const card = record(value, "Kanban card");
  if (typeof card.id !== "string" || typeof card.title !== "string") {
    throw new Error("Kanban card identity is invalid.");
  }
  const status = card.status === undefined && fallbackStatus ? fallbackStatus : taskStatus(card.status);
  const priorityValue = finiteNumber(card.priority) ?? 0;
  const body = typeof card.body === "string" ? card.body : undefined;
  const assigneeId = typeof card.assignee === "string" ? card.assignee : undefined;
  const latestSummary = typeof card.latestSummary === "string" ? card.latestSummary : undefined;
  return {
    id: card.id,
    title: card.title,
    status,
    priority: priorityValue > 0 ? "high" : "normal",
    priorityValue,
    comments: finiteNumber(card.commentCount) ?? 0,
    ...(body ? { body } : {}),
    ...(assigneeId ? { assigneeId } : {}),
    ...(latestSummary ? { latestSummary } : {})
  };
}

function normalizeComment(value: unknown, cardId: string): TaskComment {
  const comment = record(value, "Kanban comment");
  if (!Number.isSafeInteger(comment.id) || (comment.id as number) < 0
    || comment.cardId !== cardId
    || !boundedString(comment.author, 1, 128)
    || !boundedString(comment.body, 1, 16_000)
    || !safeDateSeconds(comment.createdAt)) {
    throw new Error("Kanban comment is invalid.");
  }
  return {
    id: comment.id as number,
    cardId,
    author: comment.author,
    body: comment.body,
    createdAt: comment.createdAt as number
  };
}

function taskStatus(value: unknown): TaskStatus {
  if (typeof value !== "string" || !READ_STATUSES.has(value as TaskStatus)) {
    throw new Error("Kanban card status is invalid.");
  }
  return value as TaskStatus;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max && !value.includes("\0");
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function safeDateSeconds(value: unknown): value is number {
  return nonNegativeSafeInteger(value) && value <= MAX_DATE_SECONDS;
}
