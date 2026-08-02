import { signal } from "@preact/signals";
import { readBrandStorage, writeBrandStorage } from "./brand-storage";

const STORAGE_KEY = "hermes-studio:app-modal-sizes:v1";

export type AppModalKind =
  | "profile-chat"
  | "profile-settings"
  | "task-detail"
  | "task-create"
  | "teams-editor"
  | "avatar-picker"
  | "obsidian-graph"
  | "app-settings";

export type AppModalSize = {
  width: number;
  height: number;
};

export type AppModalSizeConstraints = {
  minWidth: number;
  minHeight: number;
  defaultWidth: number;
  defaultHeight: number;
};

const DEFAULTS: Record<AppModalKind, AppModalSizeConstraints> = {
  "profile-chat": { minWidth: 720, minHeight: 420, defaultWidth: 960, defaultHeight: 780 },
  "profile-settings": { minWidth: 720, minHeight: 480, defaultWidth: 960, defaultHeight: 820 },
  "task-detail": { minWidth: 640, minHeight: 480, defaultWidth: 1080, defaultHeight: 820 },
  "task-create": { minWidth: 420, minHeight: 320, defaultWidth: 560, defaultHeight: 420 },
  "teams-editor": { minWidth: 480, minHeight: 420, defaultWidth: 640, defaultHeight: 720 },
  "avatar-picker": { minWidth: 420, minHeight: 360, defaultWidth: 560, defaultHeight: 640 },
  "obsidian-graph": { minWidth: 760, minHeight: 520, defaultWidth: 1180, defaultHeight: 820 },
  "app-settings": { minWidth: 720, minHeight: 480, defaultWidth: 960, defaultHeight: 820 },
};

// Backward-compatible aliases used by the profile chat modal.
export const PROFILE_CHAT_MODAL_MIN_WIDTH = DEFAULTS["profile-chat"].minWidth;
export const PROFILE_CHAT_MODAL_MIN_HEIGHT = DEFAULTS["profile-chat"].minHeight;
export const PROFILE_CHAT_MODAL_DEFAULT_WIDTH = DEFAULTS["profile-chat"].defaultWidth;
export const PROFILE_CHAT_MODAL_DEFAULT_HEIGHT = DEFAULTS["profile-chat"].defaultHeight;
export type ProfileChatModalSize = AppModalSize;

type SizeMap = Partial<Record<AppModalKind, AppModalSize>>;

function readAll(): SizeMap {
  try {
    const raw = readBrandStorage(STORAGE_KEY);
    if (!raw) {
      // migrate legacy chat-only key if present
      const legacy = readBrandStorage("hermes-studio:profile-chat-modal-size:v1");
      if (legacy) {
        const parsed = JSON.parse(legacy) as Partial<AppModalSize>;
        if (typeof parsed.width === "number" && typeof parsed.height === "number") {
          const migrated: SizeMap = { "profile-chat": clampAppModalSize("profile-chat", parsed as AppModalSize) };
          writeBrandStorage(STORAGE_KEY, JSON.stringify(migrated));
          return migrated;
        }
      }
      return {};
    }
    const parsed = JSON.parse(raw) as SizeMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(map: SizeMap): void {
  writeBrandStorage(STORAGE_KEY, JSON.stringify(map));
}

const initial = readAll();
export const appModalSizes = signal<SizeMap>(initial);

// Keep old signal shape for existing chat modal code.
export const profileChatModalSize = signal<AppModalSize>(
  initial["profile-chat"] ?? {
    width: PROFILE_CHAT_MODAL_DEFAULT_WIDTH,
    height: PROFILE_CHAT_MODAL_DEFAULT_HEIGHT,
  },
);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function appModalMaxSize(kind: AppModalKind = "profile-chat"): AppModalSize {
  const conf = DEFAULTS[kind];
  if (typeof window === "undefined") {
    return { width: Math.max(conf.defaultWidth, 1200), height: Math.max(conf.defaultHeight, 900) };
  }
  const mobile = window.innerWidth <= 767;
  return {
    width: Math.max(0, mobile ? window.innerWidth : window.innerWidth - 48),
    height: Math.max(0, mobile ? window.innerHeight : Math.floor(window.innerHeight * 0.92)),
  };
}

export function clampAppModalSize(kind: AppModalKind, size: AppModalSize): AppModalSize {
  const conf = DEFAULTS[kind];
  const max = appModalMaxSize(kind);
  // On narrow/short viewports, the viewport is the hard constraint. Desktop
  // minimums must never push an inline modal size beyond the visible screen.
  const minWidth = Math.min(conf.minWidth, max.width);
  const minHeight = Math.min(conf.minHeight, max.height);
  return {
    width: clamp(Math.round(size.width), minWidth, max.width),
    height: clamp(Math.round(size.height), minHeight, max.height),
  };
}

export function getAppModalSize(kind: AppModalKind): AppModalSize {
  const conf = DEFAULTS[kind];
  const current = appModalSizes.value[kind];
  return clampAppModalSize(kind, current ?? { width: conf.defaultWidth, height: conf.defaultHeight });
}

export function setAppModalSize(kind: AppModalKind, size: AppModalSize): void {
  const next = clampAppModalSize(kind, size);
  const map = { ...appModalSizes.value, [kind]: next };
  appModalSizes.value = map;
  writeAll(map);
  if (kind === "profile-chat") profileChatModalSize.value = next;
}

export function previewAppModalSize(kind: AppModalKind, size: AppModalSize): void {
  const next = clampAppModalSize(kind, size);
  appModalSizes.value = { ...appModalSizes.value, [kind]: next };
  if (kind === "profile-chat") profileChatModalSize.value = next;
}

// Legacy wrappers for profile chat.
export function setProfileChatModalSize(size: AppModalSize): void {
  setAppModalSize("profile-chat", size);
}
export function previewProfileChatModalSize(size: AppModalSize): void {
  previewAppModalSize("profile-chat", size);
}
export function clampProfileChatModalSize(size: AppModalSize): AppModalSize {
  return clampAppModalSize("profile-chat", size);
}
export function profileChatModalMaxSize(): AppModalSize {
  return appModalMaxSize("profile-chat");
}

export type ModalResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const MODAL_RESIZE_HANDLES: Array<{ edge: ModalResizeEdge; className: string }> = [
  { edge: "n", className: "is-n" },
  { edge: "s", className: "is-s" },
  { edge: "e", className: "is-e" },
  { edge: "w", className: "is-w" },
  { edge: "ne", className: "is-ne" },
  { edge: "nw", className: "is-nw" },
  { edge: "se", className: "is-se" },
  { edge: "sw", className: "is-sw" },
];


let activeModalResizeCount = 0;
let suppressOutsideCloseUntil = 0;

export function isAppModalResizing(): boolean {
  return activeModalResizeCount > 0 || Date.now() < suppressOutsideCloseUntil;
}

export function shouldIgnoreModalOutsideClose(): boolean {
  return isAppModalResizing();
}

function beginActiveModalResize(): void {
  activeModalResizeCount += 1;
}

function endActiveModalResize(): void {
  activeModalResizeCount = Math.max(0, activeModalResizeCount - 1);
  // Swallow the synthetic click/pointerup that lands on the scrim after a drag.
  suppressOutsideCloseUntil = Date.now() + 250;
}

export function markAppModalResizeStart(): void {
  beginActiveModalResize();
}

export function markAppModalResizeEnd(): void {
  endActiveModalResize();
}

export function createModalResizeHandlers(kind: AppModalKind) {
  let pointerId: number | null = null;
  let origin: { x: number; y: number; width: number; height: number; edge: ModalResizeEdge } | null = null;
  let stop: (() => void) | null = null;

  const begin = (edge: ModalResizeEdge) => (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const size = getAppModalSize(kind);
    pointerId = event.pointerId;
    origin = { x: event.clientX, y: event.clientY, width: size.width, height: size.height, edge };
    beginActiveModalResize();
    const onMove = (moveEvent: PointerEvent) => {
      if (pointerId !== moveEvent.pointerId || !origin) return;
      moveEvent.preventDefault();
      moveEvent.stopPropagation();
      const dx = moveEvent.clientX - origin.x;
      const dy = moveEvent.clientY - origin.y;
      let width = origin.width;
      let height = origin.height;
      if (origin.edge === "e" || origin.edge === "ne" || origin.edge === "se") width = origin.width + dx;
      if (origin.edge === "w" || origin.edge === "nw" || origin.edge === "sw") width = origin.width - dx;
      if (origin.edge === "s" || origin.edge === "se" || origin.edge === "sw") height = origin.height + dy;
      if (origin.edge === "n" || origin.edge === "ne" || origin.edge === "nw") height = origin.height - dy;
      previewAppModalSize(kind, { width, height });
    };
    const finish = (upEvent?: Event) => {
      if (pointerId === null && origin === null) return;
      upEvent?.preventDefault();
      upEvent?.stopPropagation();
      pointerId = null;
      origin = null;
      setAppModalSize(kind, getAppModalSize(kind));
      endActiveModalResize();
      stop?.();
      stop = null;
    };
    const onUp = (upEvent: PointerEvent) => {
      if (pointerId !== upEvent.pointerId) return;
      finish(upEvent);
    };
    const onClick = (clickEvent: MouseEvent) => {
      // After a drag, the browser may synthesize a click on whatever is under the cursor (often the scrim).
      if (!shouldIgnoreModalOutsideClose()) return;
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
    };
    stop?.();
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    window.addEventListener("click", onClick, true);
    stop = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      window.removeEventListener("click", onClick, true);
    };
  };

  const dispose = () => {
    if (pointerId !== null || origin !== null) endActiveModalResize();
    stop?.();
    stop = null;
    pointerId = null;
    origin = null;
  };

  return { begin, dispose, handles: MODAL_RESIZE_HANDLES };
}
