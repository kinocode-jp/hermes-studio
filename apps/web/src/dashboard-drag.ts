import { dashboardPanelKinds, type DashboardPanelKind } from "./dashboard-layout";

/** Registered panel id used when reordering panels already on the dashboard. */
export const DASHBOARD_PANEL_DRAG_TYPE = "application/x-hermes-panel";

/** Panel kind used when dragging a navigation item from the sidebar. */
export const DASHBOARD_PANEL_KIND_DRAG_TYPE = "application/x-hermes-panel-kind";

/** Chat session id used when dragging a conversation from the sidebar. */
export const DASHBOARD_SESSION_DRAG_TYPE = "application/x-hermes-session";

export type HorizontalDropEdge = "before" | "after";

export type PaneDropRect = {
  index: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
};

export type PaneDropGeometry =
  | { mode: "insert"; index: number; anchorIndex: number; edge: HorizontalDropEdge }
  | { mode: "replace"; index: number };

/**
 * Resolve only left/right insertion zones. Dashboard and modal panes are
 * stored in row-major order, so treating a top/bottom edge as index +/- 1 can
 * place the item in a different column from the pointer.
 */
export function horizontalDropEdge(
  x: number,
  rect: Pick<DOMRect, "left" | "right" | "width">,
  options?: { maxPx?: number; fraction?: number },
): HorizontalDropEdge | undefined {
  const edge = Math.min(options?.maxPx ?? 36, rect.width * (options?.fraction ?? 0.18));
  const fromLeft = x - rect.left;
  const fromRight = rect.right - x;
  if (fromLeft <= edge && fromLeft <= fromRight) return "before";
  if (fromRight <= edge) return "after";
  return undefined;
}

/**
 * Resolve an external pane drop from rendered pane geometry.
 *
 * Every pane is split into equal horizontal thirds: left inserts before,
 * center replaces, and right inserts after. Real gaps still insert between
 * panes. The nearest visual row is used for multi-row layouts.
 */
export function paneDropTargetAt(
  x: number,
  y: number,
  rects: readonly PaneDropRect[],
): PaneDropGeometry | undefined {
  if (rects.length === 0) return undefined;

  const anchor = rects.reduce((nearest, rect) =>
    verticalDistance(y, rect) < verticalDistance(y, nearest) ? rect : nearest);
  const row = rects
    .filter((rect) => Math.min(anchor.bottom, rect.bottom) > Math.max(anchor.top, rect.top))
    .sort((left, right) => left.left - right.left);
  const candidate = row.find((rect) => x >= rect.left && x <= rect.right);

  if (candidate) {
    const width = Math.max(0, candidate.width || candidate.right - candidate.left);
    const third = width / 3;
    if (x <= candidate.left + third) {
      return { mode: "insert", index: candidate.index, anchorIndex: candidate.index, edge: "before" };
    }
    if (x >= candidate.right - third) {
      return { mode: "insert", index: candidate.index + 1, anchorIndex: candidate.index, edge: "after" };
    }
    return { mode: "replace", index: candidate.index };
  }

  const first = row[0]!;
  if (x < first.left) return { mode: "insert", index: first.index, anchorIndex: first.index, edge: "before" };
  for (let index = 1; index < row.length; index += 1) {
    const previous = row[index - 1]!;
    const next = row[index]!;
    if (x > previous.right && x < next.left) {
      return { mode: "insert", index: next.index, anchorIndex: next.index, edge: "before" };
    }
  }
  const last = row.at(-1)!;
  return { mode: "insert", index: last.index + 1, anchorIndex: last.index, edge: "after" };
}

function verticalDistance(y: number, rect: Pick<PaneDropRect, "top" | "bottom">): number {
  if (y < rect.top) return rect.top - y;
  if (y > rect.bottom) return y - rect.bottom;
  return 0;
}

export type SidebarPanelPointerDrag = {
  pointerId: number;
  kind: DashboardPanelKind;
  startX: number;
  startY: number;
  active: boolean;
  sourceElement?: HTMLElement | undefined;
};

let sidebarPanelPointerDrag: SidebarPanelPointerDrag | null = null;
let suppressedClick: { kind: DashboardPanelKind; until: number } | null = null;

export type SidebarSessionPointerDrag = {
  pointerId: number;
  sessionId: string;
  startX: number;
  startY: number;
  active: boolean;
  sourceElement?: HTMLElement | undefined;
};

let sidebarSessionPointerDrag: SidebarSessionPointerDrag | null = null;
let suppressedSessionClick: { sessionId: string; until: number } | null = null;

export function beginSidebarPanelPointerDrag(event: PointerEvent, kind: DashboardPanelKind): void {
  if (event.button !== 0 || event.altKey || event.metaKey || event.ctrlKey) return;
  sidebarPanelPointerDrag = {
    pointerId: event.pointerId,
    kind,
    startX: event.clientX,
    startY: event.clientY,
    active: false,
    sourceElement: event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined,
  };
}

export function currentSidebarPanelPointerDrag(): SidebarPanelPointerDrag | null {
  return sidebarPanelPointerDrag;
}

export function activateSidebarPanelPointerDrag(pointerId: number): SidebarPanelPointerDrag | null {
  if (!sidebarPanelPointerDrag || sidebarPanelPointerDrag.pointerId !== pointerId) return null;
  if (!sidebarPanelPointerDrag.active) {
    sidebarPanelPointerDrag.active = true;
    sidebarPanelPointerDrag.sourceElement?.classList.add("is-pointer-dragging");
  }
  return sidebarPanelPointerDrag;
}

export function endSidebarPanelPointerDrag(suppressClick = false): void {
  const drag = sidebarPanelPointerDrag;
  if (!drag) return;
  drag.sourceElement?.classList.remove("is-pointer-dragging");
  if (suppressClick && drag.active) {
    suppressedClick = { kind: drag.kind, until: Date.now() + 600 };
  }
  sidebarPanelPointerDrag = null;
}

export function consumeSidebarPanelClickSuppression(kind: DashboardPanelKind): boolean {
  if (!suppressedClick || suppressedClick.kind !== kind || suppressedClick.until < Date.now()) return false;
  suppressedClick = null;
  return true;
}

export function beginSidebarSessionPointerDrag(event: PointerEvent, sessionId: string): void {
  if (event.button !== 0 || event.altKey || event.metaKey || event.ctrlKey) return;
  sidebarSessionPointerDrag = {
    pointerId: event.pointerId,
    sessionId,
    startX: event.clientX,
    startY: event.clientY,
    active: false,
    sourceElement: event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined,
  };
}

export function currentSidebarSessionPointerDrag(): SidebarSessionPointerDrag | null {
  return sidebarSessionPointerDrag;
}

export function activateSidebarSessionPointerDrag(pointerId: number): SidebarSessionPointerDrag | null {
  if (!sidebarSessionPointerDrag || sidebarSessionPointerDrag.pointerId !== pointerId) return null;
  if (!sidebarSessionPointerDrag.active) {
    sidebarSessionPointerDrag.active = true;
    sidebarSessionPointerDrag.sourceElement?.classList.add("is-pointer-dragging");
  }
  return sidebarSessionPointerDrag;
}

export function endSidebarSessionPointerDrag(suppressClick = false): void {
  const drag = sidebarSessionPointerDrag;
  if (!drag) return;
  drag.sourceElement?.classList.remove("is-pointer-dragging");
  if (suppressClick && drag.active) {
    suppressedSessionClick = { sessionId: drag.sessionId, until: Date.now() + 600 };
  }
  sidebarSessionPointerDrag = null;
}

export function consumeSidebarSessionClickSuppression(sessionId: string): boolean {
  if (!suppressedSessionClick || suppressedSessionClick.sessionId !== sessionId || suppressedSessionClick.until < Date.now()) return false;
  suppressedSessionClick = null;
  return true;
}

export function parseDashboardPanelKind(value: string): DashboardPanelKind | undefined {
  return dashboardPanelKinds.includes(value as DashboardPanelKind)
    ? value as DashboardPanelKind
    : undefined;
}
