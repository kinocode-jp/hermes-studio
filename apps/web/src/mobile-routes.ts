import { mobileInspectorOpen, mobileWorkspaceOpen } from "./store-state";
import { PHONE_VIEWPORT_QUERY } from "./viewport";

/** Logical mobile route layers. Only the top layer is visible (mutually exclusive UI). */
export type MobileRoute = "workspace" | "inspector";

const HISTORY_FLAG = "hermesMobileOverlay";

/** Stack bottom → top. Top is the visible exclusive route. */
let routeStack: MobileRoute[] = [];
/** True when we own one browser history entry for the current overlay session. */
let historyArmed = false;
/** Suppress the next N popstate events (e.g. after programmatic history.back on clear). */
let ignorePopCount = 0;
let historyInstalled = false;

const COMPACT_VIEWPORT = "(max-width: 1279px)";

function matchesViewport(query: string): boolean {
  return typeof matchMedia === "function" && matchMedia(query).matches;
}

function shouldTrackHistory(route: MobileRoute): boolean {
  if (typeof history === "undefined" || typeof history.pushState !== "function") return false;
  return route === "workspace" ? matchesViewport(PHONE_VIEWPORT_QUERY) : matchesViewport(COMPACT_VIEWPORT);
}

function applyTopRoute(): void {
  const top = routeStack.at(-1);
  mobileWorkspaceOpen.value = top === "workspace";
  mobileInspectorOpen.value = top === "inspector";
}

function armHistoryIfNeeded(route: MobileRoute): void {
  if (historyArmed || !shouldTrackHistory(route)) return;
  history.pushState({ ...(history.state as object | null), [HISTORY_FLAG]: true }, "");
  historyArmed = true;
}

function disarmHistory(): void {
  if (!historyArmed || typeof history === "undefined" || typeof history.back !== "function") {
    historyArmed = false;
    return;
  }
  ignorePopCount += 1;
  historyArmed = false;
  history.back();
}

/**
 * Open the chat workspace as the only visible mobile route.
 * Replaces any open inspector (no stack under workspace).
 */
export function openMobileWorkspace(): void {
  routeStack = ["workspace"];
  applyTopRoute();
  armHistoryIfNeeded("workspace");
}

/**
 * Open the profile inspector as the only visible mobile route.
 * If the workspace is already open, stack the inspector on top so Back returns to the workspace.
 */
export function openMobileInspector(): void {
  const top = routeStack.at(-1);
  if (top === "inspector") {
    applyTopRoute();
    return;
  }
  if (top === "workspace" || mobileWorkspaceOpen.value) {
    if (top !== "workspace") routeStack = ["workspace"];
    routeStack.push("inspector");
    applyTopRoute();
    armHistoryIfNeeded("inspector");
    return;
  }
  routeStack = ["inspector"];
  applyTopRoute();
  armHistoryIfNeeded("inspector");
}

/**
 * Close the currently visible mobile route (same transition as Android/browser Back).
 * Inspector closes first when stacked over workspace; then workspace returns to Studio.
 */
export function closeMobileRoute(): void {
  reconcileStackFromSignals();
  if (routeStack.length === 0) return;

  if (historyArmed && shouldTrackHistory(routeStack.at(-1)!)) {
    history.back();
    return;
  }
  // Desktop / untracked viewport: pop locally. Drop a stale armed flag without history.back.
  historyArmed = false;
  popRouteLocally();
}

/** Close every mobile route and drop any owned history entry. */
export function clearMobileRoutes(): void {
  routeStack = [];
  mobileWorkspaceOpen.value = false;
  mobileInspectorOpen.value = false;
  if (historyArmed) disarmHistory();
}

/** Drop workspace from the stack without forcing the inspector closed (e.g. last chat closed). */
export function noteMobileWorkspaceClosed(): void {
  if (!mobileWorkspaceOpen.value && !routeStack.includes("workspace")) return;
  mobileWorkspaceOpen.value = false;
  const onlyWorkspace = routeStack.length === 1 && routeStack[0] === "workspace";
  routeStack = routeStack.filter((route) => route !== "workspace");
  if (routeStack.length === 0) {
    if (onlyWorkspace && historyArmed) disarmHistory();
    else historyArmed = false;
    return;
  }
  applyTopRoute();
}

export function mobileRouteStack(): readonly MobileRoute[] {
  return routeStack;
}

export function installMobileRouteHistory(): () => void {
  if (historyInstalled || typeof window === "undefined") return () => {};
  historyInstalled = true;
  const onPopState = (event: PopStateEvent) => {
    if (ignorePopCount > 0) {
      ignorePopCount -= 1;
      return;
    }
    const state = event.state as { [HISTORY_FLAG]?: boolean } | null;
    if (state?.[HISTORY_FLAG]) {
      // Forward navigation into a stale overlay marker: do not re-open closed routes.
      return;
    }
    // Back left our overlay session entry (or an intermediate re-arm).
    if (routeStack.length > 1) {
      routeStack.pop();
      applyTopRoute();
      // Keep one history entry so the next Back can leave Studio cleanly.
      historyArmed = false;
      armHistoryIfNeeded(routeStack.at(-1)!);
      return;
    }
    if (routeStack.length === 1) {
      routeStack = [];
      mobileWorkspaceOpen.value = false;
      mobileInspectorOpen.value = false;
      historyArmed = false;
      return;
    }
    historyArmed = false;
  };
  window.addEventListener("popstate", onPopState);
  return () => {
    window.removeEventListener("popstate", onPopState);
    historyInstalled = false;
  };
}

function reconcileStackFromSignals(): void {
  if (routeStack.length > 0) return;
  if (mobileInspectorOpen.value && mobileWorkspaceOpen.value) {
    // Legacy dual-open: inspector is on top (higher z-index); preserve return-to-workspace.
    routeStack = ["workspace", "inspector"];
    return;
  }
  if (mobileInspectorOpen.value) routeStack = ["inspector"];
  else if (mobileWorkspaceOpen.value) routeStack = ["workspace"];
}

function popRouteLocally(): void {
  routeStack.pop();
  if (routeStack.length === 0) {
    mobileWorkspaceOpen.value = false;
    mobileInspectorOpen.value = false;
    historyArmed = false;
    return;
  }
  applyTopRoute();
}

/** Test/helper reset — does not touch browser history. */
export function resetMobileRouteStateForTests(): void {
  routeStack = [];
  historyArmed = false;
  ignorePopCount = 0;
}
