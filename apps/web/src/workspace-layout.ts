import { signal } from "@preact/signals";

export const WORKSPACE_LAYOUT_STORAGE_KEY = "hermes-studio:workspace-layout:v1";
export const WORKSPACE_LAYOUT_VERSION = 1;
export const WORKSPACE_RATIO_MIN = 0.18;
export const WORKSPACE_RATIO_MAX = 0.72;
export const WORKSPACE_SEPARATOR_SIZE = 30;

export const workspacePlacements = ["top", "right", "bottom", "left"] as const;
export type WorkspacePlacement = (typeof workspacePlacements)[number];

export type WorkspaceLayoutPreferences = {
  version: typeof WORKSPACE_LAYOUT_VERSION;
  placement: WorkspacePlacement;
  ratio: number;
};

export type WorkspaceRatioBounds = { min: number; max: number };
export type WorkspacePaneMinimums = { main: number; chat: number };

export const WORKSPACE_HORIZONTAL_MINIMUMS: WorkspacePaneMinimums = { main: 400, chat: 280 };
export const WORKSPACE_VERTICAL_MINIMUMS: WorkspacePaneMinimums = { main: 240, chat: 240 };

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const defaultWorkspaceLayout: WorkspaceLayoutPreferences = {
  version: WORKSPACE_LAYOUT_VERSION,
  placement: "bottom",
  ratio: 0.38,
};

const initialWorkspaceLayout = readWorkspaceLayout();
export const workspacePlacement = signal<WorkspacePlacement>(initialWorkspaceLayout.placement);
export const workspaceRatio = signal(initialWorkspaceLayout.ratio);

export function normalizeWorkspaceLayout(value: unknown): WorkspaceLayoutPreferences {
  if (!isPlainObject(value)) return { ...defaultWorkspaceLayout };
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "placement,ratio,version") return { ...defaultWorkspaceLayout };
  if (value.version !== WORKSPACE_LAYOUT_VERSION || !isWorkspacePlacement(value.placement)) {
    return { ...defaultWorkspaceLayout };
  }
  if (typeof value.ratio !== "number" || !Number.isFinite(value.ratio)) return { ...defaultWorkspaceLayout };
  return { version: WORKSPACE_LAYOUT_VERSION, placement: value.placement, ratio: clampRatio(value.ratio) };
}

export function readWorkspaceLayout(storage: StorageLike | null = availableStorage()): WorkspaceLayoutPreferences {
  if (!storage) return { ...defaultWorkspaceLayout };
  try {
    const stored = storage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
    return stored === null ? { ...defaultWorkspaceLayout } : normalizeWorkspaceLayout(JSON.parse(stored));
  } catch {
    return { ...defaultWorkspaceLayout };
  }
}

export function setWorkspacePlacement(placement: WorkspacePlacement): void {
  workspacePlacement.value = placement;
  persistWorkspaceLayout();
}

export function setWorkspaceRatio(ratio: number): void {
  workspaceRatio.value = clampRatio(ratio);
  persistWorkspaceLayout();
}

export function resetWorkspaceLayout(storage: StorageLike | null = availableStorage()): boolean {
  workspacePlacement.value = defaultWorkspaceLayout.placement;
  workspaceRatio.value = defaultWorkspaceLayout.ratio;
  if (!storage) return false;
  try {
    storage.removeItem(WORKSPACE_LAYOUT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function persistWorkspaceLayout(storage: StorageLike | null = availableStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify({
      version: WORKSPACE_LAYOUT_VERSION,
      placement: workspacePlacement.value,
      ratio: workspaceRatio.value,
    } satisfies WorkspaceLayoutPreferences));
    return true;
  } catch {
    return false;
  }
}

export function clampWorkspaceRatio(
  ratio: number,
  placement: WorkspacePlacement,
  width: number,
  height: number,
  minimums: WorkspacePaneMinimums = defaultPaneMinimums(placement),
): number {
  const bounds = workspaceRatioBounds(placement, width, height, minimums);
  return Math.min(bounds.max, Math.max(bounds.min, clampRatio(ratio)));
}

export function workspaceRatioBounds(
  placement: WorkspacePlacement,
  width: number,
  height: number,
  minimums: WorkspacePaneMinimums = defaultPaneMinimums(placement),
  separatorSize = WORKSPACE_SEPARATOR_SIZE,
): WorkspaceRatioBounds {
  const available = placement === "left" || placement === "right" ? width : height;
  if (!Number.isFinite(available) || available <= 0) {
    return { min: WORKSPACE_RATIO_MIN, max: WORKSPACE_RATIO_MAX };
  }
  const defaults = defaultPaneMinimums(placement);
  const mainMinimum = validMinimum(minimums.main, defaults.main);
  const chatMinimum = validMinimum(minimums.chat, defaults.chat);
  const separator = Number.isFinite(separatorSize) && separatorSize >= 0 ? separatorSize : WORKSPACE_SEPARATOR_SIZE;
  const minimum = chatMinimum / available;
  const maximum = (available - separator - mainMinimum) / available;
  const boundedMinimum = Math.max(WORKSPACE_RATIO_MIN, minimum);
  const boundedMaximum = Math.min(WORKSPACE_RATIO_MAX, maximum);
  if (boundedMinimum > boundedMaximum) {
    const midpoint = minimum / 2 + maximum / 2;
    const finiteMidpoint = Number.isFinite(midpoint)
      ? midpoint
      : maximum < WORKSPACE_RATIO_MIN ? WORKSPACE_RATIO_MIN
      : minimum > WORKSPACE_RATIO_MAX ? WORKSPACE_RATIO_MAX
      : (WORKSPACE_RATIO_MIN + WORKSPACE_RATIO_MAX) / 2;
    const compromise = Math.min(WORKSPACE_RATIO_MAX, Math.max(WORKSPACE_RATIO_MIN, finiteMidpoint));
    return { min: compromise, max: compromise };
  }
  return { min: boundedMinimum, max: boundedMaximum };
}

function defaultPaneMinimums(placement: WorkspacePlacement): WorkspacePaneMinimums {
  return placement === "left" || placement === "right"
    ? WORKSPACE_HORIZONTAL_MINIMUMS
    : WORKSPACE_VERTICAL_MINIMUMS;
}

function validMinimum(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function oppositePlacement(placement: WorkspacePlacement): WorkspacePlacement {
  if (placement === "top") return "bottom";
  if (placement === "right") return "left";
  if (placement === "bottom") return "top";
  return "right";
}

export function workspaceChatPrecedesSurface(
  placement: WorkspacePlacement,
  mobile: boolean,
  hasChats: boolean,
): boolean {
  return hasChats && !mobile && (placement === "top" || placement === "left");
}

export function workspaceSeparatorKeyShortcuts(placement: WorkspacePlacement): string {
  return placement === "left" || placement === "right"
    ? "ArrowLeft ArrowRight Home End"
    : "ArrowUp ArrowDown Home End";
}

export function workspaceResizeRatioFromDelta(
  startRatio: number,
  startCoordinate: number,
  currentCoordinate: number,
  placement: WorkspacePlacement,
  axisSize: number,
): number {
  if (!Number.isFinite(axisSize) || axisSize <= 0) return startRatio;
  const direction = placement === "left" || placement === "top" ? 1 : -1;
  return startRatio + direction * (currentCoordinate - startCoordinate) / axisSize;
}

export function workspacePointerIsOwner(ownerPointerId: number | null, eventPointerId: number): boolean {
  return ownerPointerId !== null && ownerPointerId === eventPointerId;
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return defaultWorkspaceLayout.ratio;
  return Math.min(WORKSPACE_RATIO_MAX, Math.max(WORKSPACE_RATIO_MIN, ratio));
}

function isWorkspacePlacement(value: unknown): value is WorkspacePlacement {
  return typeof value === "string" && (workspacePlacements as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function availableStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
