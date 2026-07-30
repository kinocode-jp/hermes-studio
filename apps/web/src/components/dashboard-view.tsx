import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { chatSessionTitle, t } from "../i18n";
import {
  activeDashboard,
  dashboardEffectiveSizes,
  dashboardRowLayout,
  MAX_DASHBOARD_PANELS,
  movePanel,
  resetActiveDashboardSizes,
  setActiveDashboardChatPanel,
  setActiveDashboardSizes,
  type DashboardPanel,
  type DashboardPanelKind,
  type DashboardSizes,
} from "../dashboard-layout";
import { addDashboardPanel, closeDashboardPanel, replaceDashboardPanel } from "../dashboard-actions";
import {
  DASHBOARD_PANEL_DRAG_TYPE,
  DASHBOARD_PANEL_KIND_DRAG_TYPE,
  DASHBOARD_SESSION_DRAG_TYPE,
  activateSidebarPanelPointerDrag,
  activateSidebarSessionPointerDrag,
  currentSidebarPanelPointerDrag,
  currentSidebarSessionPointerDrag,
  endSidebarPanelPointerDrag,
  endSidebarSessionPointerDrag,
  paneDropTargetAt,
  parseDashboardPanelKind,
} from "../dashboard-drag";
import { profileList, sessions } from "../store";
import { profileDisplayName } from "../profile-names";
import { ChatPane } from "./chat-pane";
import { KanbanBoard } from "./kanban-board";
import { OfficeScene } from "./office-scene";
import { TeamsPanel } from "./teams-panel";
import { ScheduledSessionsPanel } from "./scheduled-sessions-panel";
import { ProfilesPanel } from "./profiles-panel";
import { CloseIcon } from "./icons";

/** Minimum pane share of the resized axis. */
const MIN_FRACTION = 0.15;
/** Minimum rendered row height; below this the dashboard scrolls vertically. */
const MIN_ROW_PX = 240;
/** Movement before a sidebar click becomes a pointer drag. */
const SIDEBAR_DRAG_THRESHOLD_PX = 7;

/** Reject coordinates covered by fixed overlays such as the mobile profile sheet. */
function isVisibleDashboardPoint(host: HTMLElement, x: number, y: number): boolean {
  const rect = host.getBoundingClientRect();
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false;
  const hit = document.elementFromPoint(x, y);
  return hit === host || (hit instanceof Node && host.contains(hit));
}

type ResizeGesture = {
  pointerId: number;
  /** "col" adjusts two columns inside one row; "row" adjusts two rows. */
  axis: "col" | "row";
  row: number;
  /** Index of the first of the two adjacent tracks. */
  index: number;
  startCoordinate: number;
  /** Total px of the two adjacent tracks at gesture start. */
  spanPx: number;
  /** Fraction of the first track at gesture start (0..1 of the pair). */
  startShare: number;
  sizes: DashboardSizes;
};

export function panelKindLabel(kind: DashboardPanelKind): string {
  switch (kind) {
    case "chat": return t("dashboard.panel.chat");
    case "kanban": return t("nav.kanban");
    case "studio": return t("nav.office");
    case "teams": return t("nav.teams");
    case "scheduled": return t("nav.scheduled");
    case "profiles": return t("dashboard.panel.profiles");
  }
}

type DropTarget =
  | { mode: "insert"; index: number; anchorPanelId?: string; edge?: "before" | "after" }
  | { mode: "replace"; index: number; panelId: string };

export function DashboardView() {
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [mobile, setMobile] = useState(() => typeof matchMedia === "function" && matchMedia("(max-width: 768px)").matches);
  const gestureRef = useRef<ResizeGesture | null>(null);
  const hostRef = useRef<HTMLElement>(null);
  const dashboard = activeDashboard.value;
  const panels = dashboard.panels;
  const layout = dashboardRowLayout(panels.length);
  const sizes = dashboardEffectiveSizes(dashboard);

  useEffect(() => {
    const end = () => setDropTarget(null);
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
    };
  }, []);

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(max-width: 768px)");
    const sync = () => setMobile(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    setDropTarget(null);
  }, [panels.map((panel) => panel.id).join("|")]);

  const showNote = (text: string) => {
    setNote(text);
    window.setTimeout(() => setNote(null), 2200);
  };

  const resolveDropIndexAt = (x: number, y: number, host: HTMLElement): number => {
    const slots = [...host.querySelectorAll<HTMLElement>(".dashboard-panel")];
    if (slots.length === 0) return 0;
    for (let i = 0; i < slots.length; i += 1) {
      const rect = slots[i]!.getBoundingClientRect();
      if (y < rect.top) return i;
      if (y <= rect.bottom && x < rect.left + rect.width / 2) return i;
    }
    return slots.length;
  };

  const resolveDropTargetAt = (
    x: number,
    y: number,
    host: HTMLElement,
    external: boolean,
  ): DropTarget => {
    if (external) {
      const geometry = paneDropTargetAt(
        x,
        y,
        [...host.querySelectorAll<HTMLElement>(".dashboard-panel")].map((panel, index) => {
          const rect = panel.getBoundingClientRect();
          return { index, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
        }),
      );
      if (geometry?.mode === "replace") {
        const panel = panels[geometry.index];
        if (panel) return { ...geometry, panelId: panel.id };
      }
      if (geometry?.mode === "insert") {
        const anchorPanelId = panels[geometry.anchorIndex]?.id;
        return anchorPanelId
          ? { mode: "insert", index: geometry.index, anchorPanelId, edge: geometry.edge }
          : { mode: "insert", index: geometry.index };
      }
    }
    return { mode: "insert", index: resolveDropIndexAt(x, y, host) };
  };

  const resolveDropTarget = (event: DragEvent, host: HTMLElement, external: boolean): DropTarget =>
    resolveDropTargetAt(event.clientX, event.clientY, host, external);

  const placePanelKind = (kind: DashboardPanelKind, target: DropTarget): void => {
    const result = target.mode === "replace"
      ? replaceDashboardPanel(target.panelId, kind)
      : (() => {
          const existing = activeDashboard.value.panels.find((panel) => panel.kind === kind);
          if (existing) {
            movePanel(existing.id, target.index);
            return "focused" as const;
          }
          return addDashboardPanel(kind, { index: target.index });
        })();
    if (result === "full") showNote(t("dashboard.panelLimit", { count: MAX_DASHBOARD_PANELS }));
  };

  const placeSession = (sessionId: string, target: DropTarget): void => {
    if (!sessions.value.some((session) => session.id === sessionId)) return;
    if (target.mode === "replace") {
      const result = replaceDashboardPanel(target.panelId, "chat", { sessionId });
      if (result === "full") showNote(t("dashboard.panelLimit", { count: MAX_DASHBOARD_PANELS }));
      return;
    }
    const existing = panels.find((panel) => panel.kind === "chat" && panel.sessionId === sessionId);
    if (existing) {
      movePanel(existing.id, target.index);
      return;
    }
    const result = addDashboardPanel("chat", { sessionId, index: target.index });
    if (result === "full") {
      showNote(t("dashboard.panelLimit", { count: MAX_DASHBOARD_PANELS }));
    }
  };

  const panelStructureKey = panels.map((panel) => `${panel.id}:${panel.kind}:${panel.sessionId ?? ""}`).join("|");
  useEffect(() => {
    const pointerMove = (event: PointerEvent) => {
      const pending = currentSidebarPanelPointerDrag();
      if (!pending || pending.pointerId !== event.pointerId) return;
      const distance = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY);
      if (!pending.active && distance < SIDEBAR_DRAG_THRESHOLD_PX) return;
      const drag = activateSidebarPanelPointerDrag(event.pointerId);
      if (!drag) return;
      event.preventDefault();
      const host = hostRef.current;
      if (!host || !isVisibleDashboardPoint(host, event.clientX, event.clientY)) {
        setDropTarget(null);
        return;
      }
      setDropTarget(resolveDropTargetAt(event.clientX, event.clientY, host, true));
    };
    const pointerUp = (event: PointerEvent) => {
      const drag = currentSidebarPanelPointerDrag();
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (drag.active) {
        event.preventDefault();
        const host = hostRef.current;
        if (host && isVisibleDashboardPoint(host, event.clientX, event.clientY)) {
          placePanelKind(drag.kind, resolveDropTargetAt(event.clientX, event.clientY, host, true));
        }
      }
      endSidebarPanelPointerDrag(true);
      setDropTarget(null);
    };
    const pointerCancel = () => {
      endSidebarPanelPointerDrag(false);
      setDropTarget(null);
    };
    window.addEventListener("pointermove", pointerMove, { passive: false });
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerCancel);
    window.addEventListener("blur", pointerCancel);
    return () => {
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerCancel);
      window.removeEventListener("blur", pointerCancel);
    };
  }, [dashboard.id, panelStructureKey]);

  useEffect(() => {
    const pointerMove = (event: PointerEvent) => {
      const pending = currentSidebarSessionPointerDrag();
      if (!pending || pending.pointerId !== event.pointerId) return;
      const distance = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY);
      if (!pending.active && distance < SIDEBAR_DRAG_THRESHOLD_PX) return;
      const drag = activateSidebarSessionPointerDrag(event.pointerId);
      if (!drag) return;
      event.preventDefault();
      const host = hostRef.current;
      if (!host || !isVisibleDashboardPoint(host, event.clientX, event.clientY)) {
        setDropTarget(null);
        return;
      }
      setDropTarget(resolveDropTargetAt(event.clientX, event.clientY, host, true));
    };
    const pointerUp = (event: PointerEvent) => {
      const drag = currentSidebarSessionPointerDrag();
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (drag.active) {
        event.preventDefault();
        const host = hostRef.current;
        if (host && isVisibleDashboardPoint(host, event.clientX, event.clientY)) {
          placeSession(drag.sessionId, resolveDropTargetAt(event.clientX, event.clientY, host, true));
        }
      }
      endSidebarSessionPointerDrag(true);
      setDropTarget(null);
    };
    const pointerCancel = () => {
      endSidebarSessionPointerDrag(false);
      setDropTarget(null);
    };
    window.addEventListener("pointermove", pointerMove, { passive: false });
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerCancel);
    window.addEventListener("blur", pointerCancel);
    return () => {
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerCancel);
      window.removeEventListener("blur", pointerCancel);
    };
  }, [dashboard.id, panelStructureKey, sessions.value.map((session) => session.id).join("|")]);

  const onDragOver = (event: DragEvent) => {
    const types = event.dataTransfer?.types ? [...event.dataTransfer.types] : [];
    const internal = types.includes(DASHBOARD_PANEL_DRAG_TYPE);
    const external = types.includes(DASHBOARD_PANEL_KIND_DRAG_TYPE) || types.includes(DASHBOARD_SESSION_DRAG_TYPE);
    const relevant = internal || external;
    if (!relevant || !(event.currentTarget instanceof HTMLElement)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = internal ? "move" : "copy";
    const next = resolveDropTarget(event, event.currentTarget, external);
    setDropTarget((current) => {
      if (!current || current.mode !== next.mode || current.index !== next.index) return next;
      if (current.mode === "replace" && next.mode === "replace") {
        return current.panelId === next.panelId ? current : next;
      }
      if (current.mode === "insert" && next.mode === "insert") {
        return current.anchorPanelId === next.anchorPanelId && current.edge === next.edge ? current : next;
      }
      return next;
    });
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const host = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const types = event.dataTransfer?.types ? [...event.dataTransfer.types] : [];
    const external = types.includes(DASHBOARD_PANEL_KIND_DRAG_TYPE) || types.includes(DASHBOARD_SESSION_DRAG_TYPE);
    const target = host ? resolveDropTarget(event, host, external) : dropTarget ?? { mode: "insert", index: panels.length };
    const index = target.index;
    setDropTarget(null);
    const panelId = event.dataTransfer?.getData(DASHBOARD_PANEL_DRAG_TYPE);
    if (panelId) {
      movePanel(panelId, index);
      return;
    }

    const kind = parseDashboardPanelKind(event.dataTransfer?.getData(DASHBOARD_PANEL_KIND_DRAG_TYPE) ?? "");
    if (kind && kind !== "chat") {
      placePanelKind(kind, target);
      return;
    }

    const sessionId = event.dataTransfer?.getData(DASHBOARD_SESSION_DRAG_TYPE);
    if (sessionId) placeSession(sessionId, target);
  };

  const cloneSizes = (source: DashboardSizes): DashboardSizes => ({
    count: source.count,
    rowFr: [...source.rowFr],
    colFr: source.colFr.map((row) => [...row]),
  });

  const beginResize = (axis: "col" | "row", row: number, index: number) => (event: PointerEvent) => {
    if (mobile || event.button !== 0 || gestureRef.current || !hostRef.current) return;
    event.preventDefault();
    const host = hostRef.current;
    const current = dashboardEffectiveSizes(activeDashboard.value);
    let spanPx: number;
    let startShare: number;
    if (axis === "row") {
      const rowElements = [...host.querySelectorAll<HTMLElement>(".dashboard-row")];
      const first = rowElements[index]?.getBoundingClientRect();
      const second = rowElements[index + 1]?.getBoundingClientRect();
      if (!first || !second) return;
      spanPx = first.height + second.height;
      startShare = first.height / spanPx;
    } else {
      const rowElement = [...host.querySelectorAll<HTMLElement>(".dashboard-row")][row];
      const cells = rowElement ? [...rowElement.querySelectorAll<HTMLElement>(":scope > .dashboard-panel")] : [];
      const first = cells[index]?.getBoundingClientRect();
      const second = cells[index + 1]?.getBoundingClientRect();
      if (!first || !second) return;
      spanPx = first.width + second.width;
      startShare = first.width / spanPx;
    }
    if (!(event.currentTarget instanceof HTMLElement)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = {
      pointerId: event.pointerId,
      axis,
      row,
      index,
      startCoordinate: axis === "row" ? event.clientY : event.clientX,
      spanPx,
      startShare,
      sizes: cloneSizes(current),
    };
  };

  const moveResize = (event: PointerEvent) => {
    const gesture = gestureRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId || gesture.spanPx <= 0) return;
    const delta = (gesture.axis === "row" ? event.clientY : event.clientX) - gesture.startCoordinate;
    const share = Math.min(1 - MIN_FRACTION, Math.max(MIN_FRACTION, gesture.startShare + delta / gesture.spanPx));
    const next = cloneSizes(gesture.sizes);
    if (gesture.axis === "row") {
      const pair = gesture.sizes.rowFr[gesture.index]! + gesture.sizes.rowFr[gesture.index + 1]!;
      next.rowFr[gesture.index] = pair * share;
      next.rowFr[gesture.index + 1] = pair * (1 - share);
    } else {
      const rowFractions = gesture.sizes.colFr[gesture.row]!;
      const pair = rowFractions[gesture.index]! + rowFractions[gesture.index + 1]!;
      next.colFr[gesture.row]![gesture.index] = pair * share;
      next.colFr[gesture.row]![gesture.index + 1] = pair * (1 - share);
    }
    setActiveDashboardSizes(next);
  };

  const finishResize = (event: PointerEvent) => {
    const gesture = gestureRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    gestureRef.current = null;
    if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const resizeWithKeyboard = (axis: "col" | "row", row: number, index: number) => (event: KeyboardEvent) => {
    const current = dashboardEffectiveSizes(activeDashboard.value);
    const fractions = axis === "row" ? current.rowFr : current.colFr[row];
    const first = fractions?.[index];
    const second = fractions?.[index + 1];
    if (first === undefined || second === undefined) return;
    const pair = first + second;
    const currentShare = pair > 0 ? first / pair : 0.5;
    let nextShare: number | undefined;
    if (event.key === "Home") nextShare = MIN_FRACTION;
    else if (event.key === "End") nextShare = 1 - MIN_FRACTION;
    else if (event.key === (axis === "row" ? "ArrowUp" : "ArrowLeft")) nextShare = currentShare - 0.05;
    else if (event.key === (axis === "row" ? "ArrowDown" : "ArrowRight")) nextShare = currentShare + 0.05;
    if (nextShare === undefined) return;
    event.preventDefault();
    const share = Math.min(1 - MIN_FRACTION, Math.max(MIN_FRACTION, nextShare));
    const next = cloneSizes(current);
    if (axis === "row") {
      next.rowFr[index] = pair * share;
      next.rowFr[index + 1] = pair * (1 - share);
    } else {
      next.colFr[row]![index] = pair * share;
      next.colFr[row]![index + 1] = pair * (1 - share);
    }
    setActiveDashboardSizes(next);
  };

  const separatorProps = (axis: "col" | "row", row: number, index: number) => {
    const fractions = axis === "row" ? sizes.rowFr : sizes.colFr[row];
    const first = fractions?.[index] ?? 1;
    const second = fractions?.[index + 1] ?? 1;
    const valueNow = Math.round((first / (first + second)) * 100);
    return ({
    class: `dashboard-resize dashboard-resize--${axis}`,
    role: "separator" as const,
    tabIndex: 0,
    "aria-orientation": (axis === "col" ? "vertical" : "horizontal") as "vertical" | "horizontal",
    "aria-valuemin": Math.round(MIN_FRACTION * 100),
    "aria-valuemax": Math.round((1 - MIN_FRACTION) * 100),
    "aria-valuenow": valueNow,
    "aria-label": t("dashboard.resize"),
    title: t("dashboard.resizeTitle"),
    draggable: false,
    onPointerDown: beginResize(axis, row, index),
    onPointerMove: moveResize,
    onPointerUp: finishResize,
    onPointerCancel: finishResize,
    onLostPointerCapture: finishResize,
    onKeyDown: resizeWithKeyboard(axis, row, index),
    onDblClick: () => resetActiveDashboardSizes(),
    onDragStart: (event: DragEvent) => event.preventDefault(),
    });
  };

  if (panels.length === 0) {
    return (
      <section ref={hostRef} class="dashboard-view is-empty" onDragOver={onDragOver} onDrop={onDrop}>
        <div class="dashboard-empty-copy">
          <b>{t("dashboard.empty")}</b>
          <small>{t("dashboard.emptyHint")}</small>
        </div>
        {note && <p class="workspace-drop-note">{note}</p>}
      </section>
    );
  }

  // Split panels into rows following the fixed layout (1-3 / 2+2 / 3+2 / 3+3).
  const rows: { panels: DashboardPanel[]; offset: number }[] = [];
  {
    let cursor = 0;
    for (const columns of layout) {
      rows.push({ panels: panels.slice(cursor, cursor + columns), offset: cursor });
      cursor += columns;
    }
  }

  // Rows keep a readable minimum height; when they cannot fit (many rows on a
  // short viewport) the dashboard scrolls vertically instead of crushing panels.
  const rowTemplate = sizes.rowFr
    .map((fr) => `minmax(${MIN_ROW_PX}px, ${round(fr)}fr)`)
    .join(" 1px ");

  return (
    <section
      ref={hostRef}
      class={`dashboard-view panels-${Math.min(panels.length, MAX_DASHBOARD_PANELS)} ${dropTarget ? "is-dropping" : ""}`}
      aria-label={t("dashboard.aria")}
      style={mobile ? undefined : { gridTemplateRows: rowTemplate }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {note && <p class="workspace-drop-note">{note}</p>}
      {rows.flatMap((row, rowIndex) => {
        const columnTemplate = sizes.colFr[rowIndex]!
          .map((fr) => `minmax(0, ${round(fr)}fr)`)
          .join(" 1px ");
        const rendered = [(
          <div
            key={`row-${rowIndex}`}
            class="dashboard-row"
            style={mobile ? undefined : { gridTemplateColumns: columnTemplate }}
          >
            {row.panels.flatMap((panel, columnIndex) => {
              const globalIndex = row.offset + columnIndex;
              const cells = [(
                <DashboardPanelFrame
                  key={panel.id}
                  panel={panel}
                  showDropBefore={dropTarget?.mode === "insert" && (dropTarget.anchorPanelId
                    ? dropTarget.anchorPanelId === panel.id && dropTarget.edge === "before"
                    : dropTarget.index === globalIndex)}
                  showDropAfter={dropTarget?.mode === "insert" && (dropTarget.anchorPanelId
                    ? dropTarget.anchorPanelId === panel.id && dropTarget.edge === "after"
                    : dropTarget.index === panels.length && globalIndex === panels.length - 1)}
                  showDropReplace={dropTarget?.mode === "replace" && dropTarget.panelId === panel.id}
                  dropInsertLabel={dropTarget?.mode === "insert"
                    ? dropTarget.index === 0
                      ? t("dashboard.dropInsertStart")
                      : dropTarget.index === panels.length
                        ? t("dashboard.dropInsertEnd")
                        : t("dashboard.dropInsertBetween")
                    : ""}
                />
              )];
              if (!mobile && columnIndex < row.panels.length - 1) {
                cells.push(<div key={`col-sep-${rowIndex}-${columnIndex}`} {...separatorProps("col", rowIndex, columnIndex)} />);
              }
              return cells;
            })}
          </div>
        )];
        if (!mobile && rowIndex < rows.length - 1) {
          rendered.push(<div key={`row-sep-${rowIndex}`} {...separatorProps("row", 0, rowIndex)} />);
        }
        return rendered;
      })}
    </section>
  );
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function DashboardPanelFrame({ panel, showDropBefore, showDropAfter, showDropReplace, dropInsertLabel }: {
  panel: DashboardPanel;
  showDropBefore: boolean;
  showDropAfter: boolean;
  showDropReplace: boolean;
  dropInsertLabel: string;
}) {
  const title = panelTitle(panel);
  const delegated = panel.kind === "chat"
    && sessions.value.find((item) => item.id === panel.sessionId)?.conversationKind === "delegated";
  return (
    <article
      class={`dashboard-panel dashboard-panel--${panel.kind} ${showDropBefore ? "has-drop-before" : ""} ${showDropAfter ? "has-drop-after" : ""} ${showDropReplace ? "is-drop-replace" : ""}`}
      data-panel-id={panel.id}
      data-panel-kind={panel.kind}
      data-session-id={panel.kind === "chat" ? panel.sessionId : undefined}
    >
      {showDropBefore && <div class="workspace-drop-line" aria-hidden="true"><span>{dropInsertLabel}</span></div>}
      {showDropReplace && (
        <div class="dashboard-replace-drop" aria-hidden="true">
          <span>{t("dashboard.dropReplace")}</span>
          <small>{t("dashboard.dropReplaceHint")}</small>
        </div>
      )}
      <header
        class="dashboard-panel-head"
        draggable
        title={t("dashboard.dragPanel")}
        onDragStart={(event) => {
          event.stopPropagation();
          event.dataTransfer?.setData(DASHBOARD_PANEL_DRAG_TYPE, panel.id);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.classList.add("is-dragging");
        }}
        onDragEnd={(event) => {
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.classList.remove("is-dragging");
        }}
      >
        <b class="dashboard-panel-kind">{panelKindLabel(panel.kind)}</b>
        {title && (
          <span class="dashboard-panel-title">
            <span title={title}>{title}</span>
            {delegated && <em class="delegated-chat-badge">{t("profile.delegatedChat")}</em>}
          </span>
        )}
        <button
          class="icon-button dashboard-panel-close"
          type="button"
          draggable={false}
          aria-label={t("dashboard.closePanel", { label: panelKindLabel(panel.kind) })}
          title={t("dashboard.closePanel", { label: panelKindLabel(panel.kind) })}
          onPointerDown={(event) => event.stopPropagation()}
          onDragStart={(event) => event.preventDefault()}
          onClick={() => closeDashboardPanel(panel.id)}
        ><CloseIcon width={16} height={16} /></button>
      </header>
      <div
        class="dashboard-panel-body"
        onPointerDownCapture={() => {
          if (panel.kind === "chat") setActiveDashboardChatPanel(panel.id);
        }}
        onFocusCapture={() => {
          if (panel.kind === "chat") setActiveDashboardChatPanel(panel.id);
        }}
      >
        <PanelContent panel={panel} />
      </div>
      {showDropAfter && <div class="workspace-drop-line is-after" aria-hidden="true"><span>{dropInsertLabel}</span></div>}
    </article>
  );
}

function panelTitle(panel: DashboardPanel): string {
  if (panel.kind !== "chat" || !panel.sessionId) return "";
  const session = sessions.value.find((item) => item.id === panel.sessionId);
  if (!session) return "";
  const profile = profileList.value.find((item) => item.id === session.profileId);
  const name = profile ? profileDisplayName(profile) : session.profileId;
  return `${name} — ${chatSessionTitle(session)}`;
}

function PanelContent({ panel }: { panel: DashboardPanel }): ComponentChildren {
  if (panel.kind === "chat") {
    const session = sessions.value.find((item) => item.id === panel.sessionId);
    const profile = session ? profileList.value.find((item) => item.id === session.profileId) : undefined;
    if (!session || !profile) {
      return <p class="dashboard-panel-missing">{t("dashboard.chatMissing")}</p>;
    }
    return <ChatPane session={session} profile={profile} hideHeader activateWorkspaceOnPointerDown onClosePane={() => closeDashboardPanel(panel.id)} />;
  }
  if (panel.kind === "kanban") return <KanbanBoard hideTitle />;
  if (panel.kind === "studio") return <OfficeScene profiles={profileList.value} embedded />;
  if (panel.kind === "teams") return <TeamsPanel hideTitle />;
  if (panel.kind === "profiles") return <ProfilesPanel />;
  return <ScheduledSessionsPanel hideTitle />;
}
