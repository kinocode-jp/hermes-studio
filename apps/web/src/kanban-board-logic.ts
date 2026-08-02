import type { TaskStatus, TaskWritableStatus } from "./domain";
import { moveTask } from "./kanban-store";

/** Statuses Studio may write. Hermes owns `running` / `review`. */
export const KANBAN_WRITABLE_STATUSES = [
  "triage",
  "todo",
  "scheduled",
  "ready",
  "blocked",
  "done",
  "archived",
] as const satisfies readonly TaskWritableStatus[];

/** Columns rendered on the board (archived is list-only / not a board column). */
export const KANBAN_BOARD_STATUSES = [
  "triage",
  "todo",
  "scheduled",
  "ready",
  "running",
  "blocked",
  "review",
  "done",
] as const satisfies readonly TaskStatus[];

export type KanbanBoardStatus = (typeof KANBAN_BOARD_STATUSES)[number];
export type KanbanColumnVisibilityMode = "all" | "selected";
export type KanbanBoardLayout = "columns" | "stream";

export type KanbanColumnVisibility = {
  mode: KanbanColumnVisibilityMode;
  /** Checked statuses used when mode is `selected`. Order follows the board. */
  selected: readonly KanbanBoardStatus[];
  /** When true, columns with zero matching cards are omitted from the board. */
  hideEmpty: boolean;
  /** `columns` = classic kanban lanes; `stream` = flat card list without column chrome. */
  layout: KanbanBoardLayout;
};

/** First-time focus set: active work, without the long-tail of triage/done noise. */
export const DEFAULT_KANBAN_FOCUS_STATUSES: readonly KanbanBoardStatus[] = [
  "todo",
  "ready",
  "running",
  "blocked",
  "review",
];

const STORAGE_KEY = "hermes-studio.kanban.column-visibility.v3";
const LEGACY_STORAGE_KEYS = [
  "hermes-office.kanban.column-visibility.v3",
  "hermes-studio.kanban.column-visibility.v2",
  "hermes-office.kanban.column-visibility.v2",
  "hermes-studio.kanban.column-visibility.v1",
  "hermes-office.kanban.column-visibility.v1",
] as const;

export function defaultKanbanColumnVisibility(): KanbanColumnVisibility {
  return {
    mode: "all",
    selected: [...DEFAULT_KANBAN_FOCUS_STATUSES],
    hideEmpty: true,
    layout: "stream",
  };
}

export function isKanbanBoardStatus(value: string): value is KanbanBoardStatus {
  return (KANBAN_BOARD_STATUSES as readonly string[]).includes(value);
}

/** Stable board order, de-duplicated, unknown ids dropped. */
export function sanitizeKanbanSelectedStatuses(
  values: readonly string[],
): KanbanBoardStatus[] {
  const wanted = new Set(values.filter(isKanbanBoardStatus));
  return KANBAN_BOARD_STATUSES.filter((status) => wanted.has(status));
}

export function parseKanbanColumnVisibility(value: unknown): KanbanColumnVisibility {
  const fallback = defaultKanbanColumnVisibility();
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  const mode = record.mode === "selected" ? "selected" : "all";
  const selected = Array.isArray(record.selected)
    ? sanitizeKanbanSelectedStatuses(record.selected.map(String))
    : [...fallback.selected];
  return {
    mode,
    selected: selected.length > 0 ? selected : [...fallback.selected],
    hideEmpty: record.hideEmpty === true,
    layout: record.layout === "stream" ? "stream" : "columns",
  };
}

export function loadKanbanColumnVisibility(): KanbanColumnVisibility {
  if (typeof localStorage === "undefined") return defaultKanbanColumnVisibility();
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      for (const key of LEGACY_STORAGE_KEYS) {
        raw = localStorage.getItem(key);
        if (raw) break;
      }
    }
    if (!raw) return defaultKanbanColumnVisibility();
    return parseKanbanColumnVisibility(JSON.parse(raw) as unknown);
  } catch {
    return defaultKanbanColumnVisibility();
  }
}

export function saveKanbanColumnVisibility(value: KanbanColumnVisibility): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      mode: value.mode,
      selected: sanitizeKanbanSelectedStatuses(value.selected),
      hideEmpty: value.hideEmpty === true,
      layout: value.layout === "stream" ? "stream" : "columns",
    }));
    for (const key of LEGACY_STORAGE_KEYS) localStorage.removeItem(key);
  } catch {
    // Preferences may be blocked; in-memory state still works for the session.
  }
}

/**
 * Columns to render. In `selected` mode only checked statuses appear, still in
 * board order. Empty selection falls back to the default focus set so the board
 * never becomes a blank void.
 */
export function visibleKanbanStatuses(
  visibility: KanbanColumnVisibility,
): readonly KanbanBoardStatus[] {
  if (visibility.mode !== "selected") return KANBAN_BOARD_STATUSES;
  const selected = sanitizeKanbanSelectedStatuses(visibility.selected);
  return selected.length > 0 ? selected : DEFAULT_KANBAN_FOCUS_STATUSES;
}

/**
 * Final columns to paint: selected statuses first, then optionally drop empties.
 * Counts come from the caller so team filters stay outside this pure helper.
 */
export function paintKanbanColumns<T extends { id: TaskStatus }>(
  candidates: readonly T[],
  visibility: KanbanColumnVisibility,
  itemCountFor: (columnId: TaskStatus) => number,
): T[] {
  const allowed = new Set<string>(visibleKanbanStatuses(visibility));
  return candidates.filter((column) => {
    if (!allowed.has(column.id)) return false;
    if (!visibility.hideEmpty) return true;
    return itemCountFor(column.id) > 0;
  });
}

export function toggleKanbanSelectedStatus(
  current: readonly KanbanBoardStatus[],
  status: KanbanBoardStatus,
): KanbanBoardStatus[] {
  const set = new Set(sanitizeKanbanSelectedStatuses(current));
  if (set.has(status)) set.delete(status);
  else set.add(status);
  return sanitizeKanbanSelectedStatuses([...set]);
}

/**
 * Empty columns collapse by default; a manual override (true/false) wins until toggled again.
 */
export function isKanbanColumnCollapsed(
  columnId: TaskStatus,
  itemCount: number,
  overrides: Partial<Record<TaskStatus, boolean>>,
): boolean {
  const override = overrides[columnId];
  if (override !== undefined) return override;
  return itemCount === 0;
}

export function requestTaskMove(taskId: string, value: string): Promise<void> {
  const status = KANBAN_WRITABLE_STATUSES.find((item) => item === value);
  return status ? moveTask(taskId, status) : Promise.resolve();
}
