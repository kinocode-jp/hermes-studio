/**
 * Dashboard-based workspace state.
 *
 * A dashboard is a user-named collection of panels (chat / kanban / studio /
 * teams / scheduled) shown together on one surface. Multiple dashboards can
 * exist; exactly one is active. The whole structure persists in localStorage
 * via brand-storage. On first run, an empty dashboard shell is created; the
 * runtime wiring attaches its default-profile draft chat once profiles load.
 */
import { computed, signal } from "@preact/signals";
import { readBrandStorage, writeBrandStorage } from "./brand-storage";

export const DASHBOARDS_STORAGE_KEY = "hermes-studio:dashboards:v1";
export const DASHBOARDS_VERSION = 1;

/** Panel kinds that can be placed on a dashboard. */
export const dashboardPanelKinds = ["chat", "kanban", "studio", "teams", "scheduled", "profiles"] as const;
export type DashboardPanelKind = (typeof dashboardPanelKinds)[number];

/** Only chat panels may appear more than once per dashboard. */
export const SINGLETON_PANEL_KINDS: readonly DashboardPanelKind[] = ["kanban", "studio", "teams", "scheduled", "profiles"];
export const MAX_DASHBOARD_PANELS = 12;
/** Matches MAX_OPEN_CHAT_SESSIONS in store-state (kept literal to avoid an import cycle). */
export const MAX_CHAT_PANELS = 4;
export const MAX_DASHBOARDS = 12;

export type DashboardPanel = {
  /** Stable panel identity used for keys, drag/drop, and close actions. */
  id: string;
  kind: DashboardPanelKind;
  /** Chat panels bind to one client session id. Unset for other kinds. */
  sessionId?: string | undefined;
};

/**
 * User-resized layout fractions. `count` is the panel count the sizes were
 * captured for; when the panel structure changes the sizes no longer apply
 * and the layout falls back to equal fractions.
 */
export type DashboardSizes = {
  count: number;
  /** Row height fractions, one per row. */
  rowFr: number[];
  /** Column width fractions, one array per row. */
  colFr: number[][];
};

export type Dashboard = {
  id: string;
  name: string;
  panels: DashboardPanel[];
  /** Once true, removing every panel must leave the dashboard empty. */
  defaultChatSeeded?: boolean | undefined;
  /** Optional; absent for dashboards saved before resizing existed. */
  sizes?: DashboardSizes | undefined;
};

export type DashboardsState = {
  version: typeof DASHBOARDS_VERSION;
  dashboards: Dashboard[];
  activeDashboardId: string;
};

type StorageReader = () => string | null;

function defaultState(): DashboardsState {
  const dashboard = createDefaultDashboard();
  return { version: DASHBOARDS_VERSION, dashboards: [dashboard], activeDashboardId: dashboard.id };
}

function createDefaultDashboard(): Dashboard {
  return { id: newDashboardId(), name: "", panels: [], defaultChatSeeded: false };
}

export function newDashboardId(): string {
  return `d_${randomToken()}`;
}

export function newPanelId(): string {
  return `p_${randomToken()}`;
}

function randomToken(): string {
  try {
    return crypto.randomUUID().slice(0, 13);
  } catch {
    return Math.random().toString(36).slice(2, 15);
  }
}

/** Normalize an untrusted stored value into a valid DashboardsState, or undefined. */
export function normalizeDashboardsState(value: unknown): DashboardsState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== DASHBOARDS_VERSION || !Array.isArray(record.dashboards)) return undefined;
  const dashboards: Dashboard[] = [];
  for (const raw of record.dashboards.slice(0, MAX_DASHBOARDS)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || item.id.length === 0 || typeof item.name !== "string") continue;
    if (dashboards.some((existing) => existing.id === item.id)) continue;
    const panels: DashboardPanel[] = [];
    if (Array.isArray(item.panels)) {
      for (const rawPanel of item.panels) {
        if (!rawPanel || typeof rawPanel !== "object") continue;
        const panel = rawPanel as Record<string, unknown>;
        if (typeof panel.id !== "string" || panel.id.length === 0) continue;
        if (!dashboardPanelKinds.includes(panel.kind as DashboardPanelKind)) continue;
        const kind = panel.kind as DashboardPanelKind;
        if (panels.some((existing) => existing.id === panel.id)) continue;
        if (SINGLETON_PANEL_KINDS.includes(kind) && panels.some((existing) => existing.kind === kind)) continue;
        const sessionId = typeof panel.sessionId === "string" && panel.sessionId.length > 0
          ? panel.sessionId.slice(0, 256)
          : undefined;
        if (kind === "chat" && sessionId === undefined) continue;
        if (kind === "chat" && panels.some((existing) => existing.kind === "chat" && existing.sessionId === sessionId)) continue;
        if (kind === "chat" && panels.filter((existing) => existing.kind === "chat").length >= MAX_CHAT_PANELS) continue;
        if (panels.length >= MAX_DASHBOARD_PANELS) break;
        panels.push({ id: panel.id.slice(0, 64), kind, ...(kind === "chat" ? { sessionId } : {}) });
      }
    }
    const sizes = normalizeSizes(item.sizes, panels.length);
    // Empty dashboards saved before this flag existed receive the default chat
    // once after upgrading. An explicit true survives later user deletion.
    const defaultChatSeeded = typeof item.defaultChatSeeded === "boolean"
      ? item.defaultChatSeeded
      : panels.length > 0;
    dashboards.push({
      id: item.id.slice(0, 64),
      name: item.name.slice(0, 80),
      panels,
      defaultChatSeeded,
      ...(sizes ? { sizes } : {}),
    });
  }
  if (dashboards.length === 0) return undefined;
  const activeDashboardId = typeof record.activeDashboardId === "string"
    && dashboards.some((dashboard) => dashboard.id === record.activeDashboardId)
    ? record.activeDashboardId
    : dashboards[0]!.id;
  return { version: DASHBOARDS_VERSION, dashboards, activeDashboardId };
}

/** First-run dashboard shell. Its default chat is attached after profiles load. */
export function migrateLegacyNavigation(): DashboardsState {
  return defaultState();
}

type DashboardsReadResult = {
  state: DashboardsState;
  needsInitialDefaultChat: boolean;
};

function readDashboardsStateResult(read: StorageReader): DashboardsReadResult {
  try {
    const raw = read();
    if (raw !== null) {
      const normalized = normalizeDashboardsState(JSON.parse(raw));
      if (normalized) {
        const active = normalized.dashboards.find((dashboard) => dashboard.id === normalized.activeDashboardId);
        return { state: normalized, needsInitialDefaultChat: active?.defaultChatSeeded !== true };
      }
    }
  } catch {
    // Fall through to a fresh dashboard.
  }
  return { state: migrateLegacyNavigation(), needsInitialDefaultChat: true };
}

export function readDashboardsState(read: StorageReader = () => readBrandStorage(DASHBOARDS_STORAGE_KEY)): DashboardsState {
  return readDashboardsStateResult(read).state;
}

const initialRead = readDashboardsStateResult(() => readBrandStorage(DASHBOARDS_STORAGE_KEY));
const initial = initialRead.state;

/** True when the active dashboard still needs its one-time default chat seed. */
export const initialDashboardNeedsDefaultChat = initialRead.needsInitialDefaultChat;

export const dashboards = signal<Dashboard[]>(initial.dashboards);
export const activeDashboardId = signal<string>(initial.activeDashboardId);

export const activeDashboard = computed<Dashboard>(() =>
  dashboards.value.find((dashboard) => dashboard.id === activeDashboardId.value)
  ?? dashboards.value[0]
  ?? createDefaultDashboard(),
);

export function persistDashboards(): void {
  const state: DashboardsState = {
    version: DASHBOARDS_VERSION,
    dashboards: dashboards.value,
    activeDashboardId: activeDashboardId.value,
  };
  writeBrandStorage(DASHBOARDS_STORAGE_KEY, JSON.stringify(state));
}

function commit(next: Dashboard[], nextActiveId?: string): void {
  dashboards.value = next;
  if (nextActiveId !== undefined) activeDashboardId.value = nextActiveId;
  if (!next.some((dashboard) => dashboard.id === activeDashboardId.value)) {
    activeDashboardId.value = next[0]?.id ?? "";
  }
  persistDashboards();
}

/** Display name for a dashboard; unnamed dashboards get a positional fallback elsewhere. */
export function dashboardIndex(dashboardId: string): number {
  return dashboards.value.findIndex((dashboard) => dashboard.id === dashboardId);
}

export function switchDashboard(dashboardId: string): void {
  if (!dashboards.value.some((dashboard) => dashboard.id === dashboardId)) return;
  if (activeDashboardId.value === dashboardId) return;
  activeDashboardId.value = dashboardId;
  persistDashboards();
}

/** Find the dashboard that already presents a panel, preferring the active one. */
export function dashboardContainingPanel(
  kind: DashboardPanelKind,
  options?: { sessionId?: string },
): Dashboard | undefined {
  const matches = (dashboard: Dashboard): boolean => dashboard.panels.some((panel) =>
    panel.kind === kind && (kind !== "chat" || panel.sessionId === options?.sessionId),
  );
  const active = dashboards.value.find((dashboard) => dashboard.id === activeDashboardId.value);
  return active && matches(active) ? active : dashboards.value.find(matches);
}

export function createDashboard(name = ""): string | undefined {
  if (dashboards.value.length >= MAX_DASHBOARDS) return undefined;
  const dashboard: Dashboard = {
    id: newDashboardId(),
    name: name.trim().slice(0, 80),
    panels: [],
    defaultChatSeeded: false,
  };
  // Dashboard activation owns the chat-session handoff. Keep this pure state
  // mutation from making the new dashboard active before that handoff runs.
  commit([...dashboards.value, dashboard]);
  return dashboard.id;
}

export function renameDashboard(dashboardId: string, name: string): void {
  commit(dashboards.value.map((dashboard) =>
    dashboard.id === dashboardId ? { ...dashboard, name: name.trim().slice(0, 80) } : dashboard,
  ));
}

export function deleteDashboard(dashboardId: string): void {
  const remaining = dashboards.value.filter((dashboard) => dashboard.id !== dashboardId);
  if (remaining.length === 0) {
    const fallback = createDefaultDashboard();
    commit([fallback], fallback.id);
    return;
  }
  commit(remaining);
}

/** True when the active dashboard already holds this singleton kind. */
export function activeDashboardHasKind(kind: DashboardPanelKind): boolean {
  return activeDashboard.value.panels.some((panel) => panel.kind === kind);
}

export type AddPanelResult = "added" | "focused" | "full" | "duplicate-session";

/**
 * Add a panel to the active dashboard. Singleton kinds focus the existing
 * panel instead of duplicating. Chat panels require a session id and reject
 * duplicates of the same session.
 */
export function addPanelToActiveDashboard(kind: DashboardPanelKind, options?: { sessionId?: string; index?: number }): AddPanelResult {
  const dashboard = activeDashboard.value;
  if (SINGLETON_PANEL_KINDS.includes(kind) && dashboard.panels.some((panel) => panel.kind === kind)) {
    return "focused";
  }
  if (kind === "chat") {
    const sessionId = options?.sessionId;
    if (!sessionId) return "full";
    if (dashboard.panels.some((panel) => panel.kind === "chat" && panel.sessionId === sessionId)) {
      return "duplicate-session";
    }
    if (dashboard.panels.filter((panel) => panel.kind === "chat").length >= MAX_CHAT_PANELS) return "full";
  }
  if (dashboard.panels.length >= MAX_DASHBOARD_PANELS) return "full";
  const panel: DashboardPanel = {
    id: newPanelId(),
    kind,
    ...(kind === "chat" ? { sessionId: options?.sessionId } : {}),
  };
  const panels = [...dashboard.panels];
  const insertAt = typeof options?.index === "number"
    ? Math.max(0, Math.min(panels.length, Math.floor(options.index)))
    : panels.length;
  panels.splice(insertAt, 0, panel);
  commit(dashboards.value.map((item) => item.id === dashboard.id ? replaceDashboardPanels(item, panels) : item));
  return "added";
}

export type ReplacePanelResult = "replaced" | "focused" | "full" | "missing";

/**
 * Replace one active-dashboard panel in place. If the replacement is already
 * present elsewhere on the same dashboard, its old pane is removed so the
 * singleton/session uniqueness rules remain intact.
 */
export function replacePanelInActiveDashboard(
  panelId: string,
  kind: DashboardPanelKind,
  options?: { sessionId?: string },
): ReplacePanelResult {
  const dashboard = activeDashboard.value;
  const target = dashboard.panels.find((panel) => panel.id === panelId);
  if (!target) return "missing";
  const sessionId = kind === "chat" ? options?.sessionId : undefined;
  if (kind === "chat" && !sessionId) return "missing";
  if (target.kind === kind && (kind !== "chat" || target.sessionId === sessionId)) return "focused";

  const duplicate = dashboard.panels.find((panel) => panel.id !== panelId
    && panel.kind === kind
    && (kind !== "chat" || panel.sessionId === sessionId));
  const retained = dashboard.panels.filter((panel) => panel.id !== duplicate?.id);
  const existingChatCount = retained.filter((panel) => panel.kind === "chat" && panel.id !== panelId).length;
  if (kind === "chat" && existingChatCount >= MAX_CHAT_PANELS) return "full";

  const replacement: DashboardPanel = {
    id: target.id,
    kind,
    ...(kind === "chat" ? { sessionId } : {}),
  };
  const panels = retained.map((panel) => panel.id === panelId ? replacement : panel);
  commit(dashboards.value.map((item) => item.id === dashboard.id ? replaceDashboardPanels(item, panels) : item));
  return "replaced";
}

export function removePanel(panelId: string): DashboardPanel | undefined {
  const dashboard = activeDashboard.value;
  const removed = dashboard.panels.find((panel) => panel.id === panelId);
  if (!removed) return undefined;
  commit(dashboards.value.map((item) =>
    item.id === dashboard.id
      ? replaceDashboardPanels(item, item.panels.filter((panel) => panel.id !== panelId))
      : item,
  ));
  return removed;
}

/** Move a panel within the active dashboard to a visual insert index. */
export function movePanel(panelId: string, index: number): void {
  const dashboard = activeDashboard.value;
  const from = dashboard.panels.findIndex((panel) => panel.id === panelId);
  if (from < 0) return;
  let desired = Math.max(0, Math.min(dashboard.panels.length, Math.floor(index)));
  if (from < desired) desired -= 1;
  const panels = dashboard.panels.filter((panel) => panel.id !== panelId);
  panels.splice(Math.max(0, Math.min(panels.length, desired)), 0, dashboard.panels[from]!);
  commit(dashboards.value.map((item) => item.id === dashboard.id ? replaceDashboardPanels(item, panels) : item));
}

/** Persist user-dragged sizes for the active dashboard. */
export function setActiveDashboardSizes(sizes: DashboardSizes): void {
  const dashboard = activeDashboard.value;
  if (!sizesMatchLayout(sizes, dashboard.panels.length, dashboardRowLayout(dashboard.panels.length))) return;
  commit(dashboards.value.map((item) => item.id === dashboard.id ? { ...item, sizes } : item));
}

/** Drop stored sizes so the active dashboard returns to equal fractions. */
export function resetActiveDashboardSizes(): void {
  const dashboard = activeDashboard.value;
  if (!dashboard.sizes) return;
  commit(dashboards.value.map((item) => {
    if (item.id !== dashboard.id) return item;
    const { sizes: _sizes, ...rest } = item;
    return rest;
  }));
}

/** Drop chat panels whose sessions no longer exist (across every dashboard). */
export function reconcileChatPanels(liveSessionIds: ReadonlySet<string>): void {
  let changed = false;
  const next = dashboards.value.map((dashboard) => {
    const panels = dashboard.panels.filter((panel) =>
      panel.kind !== "chat" || (panel.sessionId !== undefined && liveSessionIds.has(panel.sessionId)),
    );
    if (panels.length === dashboard.panels.length) return dashboard;
    changed = true;
    return replaceDashboardPanels(dashboard, panels);
  });
  if (changed) commit(next);
}

/**
 * Replace panel membership/order and invalidate position-based resize data.
 * DashboardSizes has no panel-id signature, so retaining it across structural
 * changes can later apply old fractions to unrelated panels.
 */
export function replaceDashboardPanels(dashboard: Dashboard, panels: DashboardPanel[]): Dashboard {
  const defaultChatSeeded = dashboard.defaultChatSeeded === true || panels.length > 0;
  const unchanged = dashboard.panels.length === panels.length
    && dashboard.panels.every((panel, index) => panel.id === panels[index]?.id);
  if (unchanged) return { ...dashboard, panels, defaultChatSeeded };
  const { sizes: _staleSizes, ...rest } = dashboard;
  return { ...rest, panels, defaultChatSeeded };
}

/** Chat session ids currently placed on the active dashboard, in panel order. */
export const activeDashboardChatSessionIds = computed<string[]>(() =>
  activeDashboard.value.panels
    .filter((panel) => panel.kind === "chat" && panel.sessionId !== undefined)
    .map((panel) => panel.sessionId!),
);

/** Test helper: reset module-level one-shot flags and state. */
export function resetDashboardStateForTests(state?: DashboardsState): void {
  const next = state ?? defaultState();
  dashboards.value = next.dashboards;
  activeDashboardId.value = next.activeDashboardId;
}
/**
 * Panels per row for a given panel count. Up to 4 per row, balanced rows:
 * 1-3 one row, 4=[2,2], 5=[3,2], 6=[3,3], 7=[4,3], 8=[4,4],
 * 9=[3,3,3], 10=[4,3,3], 11=[4,4,3], 12=[4,4,4].
 */
export function dashboardRowLayout(count: number): number[] {
  if (count <= 0) return [];
  if (count <= 3) return [count];
  if (count === 4) return [2, 2];
  if (count === 5) return [3, 2];
  if (count === 6) return [3, 3];
  const rows = Math.ceil(count / 4);
  const base = Math.floor(count / rows);
  const remainder = count % rows;
  // `remainder` leading rows get one extra panel (e.g. 10 -> [4,3,3]).
  return Array.from({ length: rows }, (_unused, index) => base + (index < remainder ? 1 : 0));
}

/** Sizes for rendering: stored fractions when they match the layout, else equal fractions. */
export function dashboardEffectiveSizes(dashboard: Dashboard): DashboardSizes {
  const layout = dashboardRowLayout(dashboard.panels.length);
  const stored = dashboard.sizes;
  if (stored && sizesMatchLayout(stored, dashboard.panels.length, layout)) return stored;
  return {
    count: dashboard.panels.length,
    rowFr: layout.map(() => 1),
    colFr: layout.map((cols) => Array.from({ length: cols }, () => 1)),
  };
}

function sizesMatchLayout(sizes: DashboardSizes, count: number, layout: number[]): boolean {
  return sizes.count === count
    && sizes.rowFr.length === layout.length
    && sizes.colFr.length === layout.length
    && sizes.colFr.every((row, index) => row.length === layout[index])
    && sizes.rowFr.every(isValidFraction)
    && sizes.colFr.every((row) => row.every(isValidFraction));
}

function isValidFraction(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100;
}

function normalizeSizes(value: unknown, count: number): DashboardSizes | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.count !== "number" || !Array.isArray(record.rowFr) || !Array.isArray(record.colFr)) return undefined;
  const candidate: DashboardSizes = {
    count: record.count,
    rowFr: record.rowFr as number[],
    colFr: record.colFr as number[][],
  };
  if (!Array.isArray(candidate.colFr) || !candidate.colFr.every((row) => Array.isArray(row))) return undefined;
  return sizesMatchLayout(candidate, count, dashboardRowLayout(count)) ? candidate : undefined;
}
