import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  WORKSPACE_LAYOUT_STORAGE_KEY,
  clampWorkspaceRatio,
  defaultWorkspaceLayout,
  normalizeWorkspaceLayout,
  oppositePlacement,
  persistWorkspaceLayout,
  readWorkspaceLayout,
  resetWorkspaceLayout,
  workspaceRatioBounds,
  workspaceChatPrecedesSurface,
  workspaceSeparatorKeyShortcuts,
  workspaceResizeRatioFromDelta,
  workspacePointerIsOwner,
  workspacePlacement,
  workspaceRatio,
} from "../src/workspace-layout.ts";

test("workspace layout accepts only its exact versioned schema", () => {
  assert.deepEqual(normalizeWorkspaceLayout({ version: 1, placement: "left", ratio: 0.4 }), {
    version: 1, placement: "left", ratio: 0.4,
  });
  for (const invalid of [
    null,
    { version: 2, placement: "left", ratio: 0.4 },
    { version: 1, placement: "diagonal", ratio: 0.4 },
    { version: 1, placement: "left", ratio: "0.4" },
    { version: 1, placement: "left", ratio: 0.4, extra: true },
  ]) assert.deepEqual(normalizeWorkspaceLayout(invalid), defaultWorkspaceLayout);
  assert.equal(normalizeWorkspaceLayout({ version: 1, placement: "top", ratio: 9 }).ratio, 0.72);
});

test("workspace ratio respects both global limits and available pane size", () => {
  assert.deepEqual(workspaceRatioBounds("left", 1000, 700), { min: 0.28, max: 0.57 });
  assert.deepEqual(workspaceRatioBounds("right", 1000, 700, { main: 420, chat: 300 }), { min: 0.3, max: 0.55 });
  assert.deepEqual(workspaceRatioBounds("bottom", 1000, 600), { min: 0.4, max: 0.55 });
  assert.deepEqual(workspaceRatioBounds("bottom", 1000, 400), { min: 0.4625, max: 0.4625 });
  assert.equal(clampWorkspaceRatio(0.1, "left", 1000, 700), 0.28);
  assert.equal(clampWorkspaceRatio(0.9, "right", 1000, 700), 0.57);
  assert.equal(clampWorkspaceRatio(0.2, "bottom", 1000, 600), 0.4);
  assert.equal(oppositePlacement("top"), "bottom");
  assert.equal(oppositePlacement("left"), "right");
});

test("workspace ratio conflict minimizes asymmetric pane violations and remains finite", () => {
  const width708 = workspaceRatioBounds("left", 708, 700);
  assert.ok(Math.abs(width708.min - 279 / 708) < Number.EPSILON);
  assert.equal(width708.max, width708.min);
  assert.ok(Math.abs(width708.min * 708 - 279) < Number.EPSILON * 708, "chat and main each yield one pixel");
  assert.ok(Math.abs((708 - 30 - width708.max * 708) - 399) < Number.EPSILON * 708);

  const width709 = workspaceRatioBounds("right", 709, 700);
  assert.ok(Math.abs(width709.min - 279.5 / 709) < Number.EPSILON);
  assert.equal(width709.max, width709.min);
  assert.deepEqual(workspaceRatioBounds("left", 710, 700), { min: 280 / 710, max: 280 / 710 });

  assert.deepEqual(workspaceRatioBounds("bottom", 1000, 400), { min: 0.4625, max: 0.4625 });
  for (const width of [1, Number.MIN_VALUE]) {
    const extreme = workspaceRatioBounds("left", width, 700);
    assert.deepEqual(extreme, { min: 0.18, max: 0.18 });
    assert.equal(Number.isFinite(extreme.min), true);
  }
});

test("workspace DOM order follows dock direction without changing mobile overlay order", () => {
  assert.equal(workspaceChatPrecedesSurface("top", false, true), true);
  assert.equal(workspaceChatPrecedesSurface("left", false, true), true);
  assert.equal(workspaceChatPrecedesSurface("bottom", false, true), false);
  assert.equal(workspaceChatPrecedesSurface("right", false, true), false);
  for (const placement of ["top", "right", "bottom", "left"] as const) {
    assert.equal(workspaceChatPrecedesSurface(placement, true, true), false, "mobile always keeps main before its chat overlay");
    assert.equal(workspaceChatPrecedesSurface(placement, false, false), false, "an empty workspace keeps the compact main-first order");
  }
});

test("workspace separator advertises only resize keys for its current axis", () => {
  assert.equal(workspaceSeparatorKeyShortcuts("left"), "ArrowLeft ArrowRight Home End");
  assert.equal(workspaceSeparatorKeyShortcuts("right"), "ArrowLeft ArrowRight Home End");
  assert.equal(workspaceSeparatorKeyShortcuts("top"), "ArrowUp ArrowDown Home End");
  assert.equal(workspaceSeparatorKeyShortcuts("bottom"), "ArrowUp ArrowDown Home End");
});

test("workspace pointer resize uses gesture delta without separator offset jumps", () => {
  const approximately = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < Number.EPSILON);
  approximately(workspaceResizeRatioFromDelta(0.4, 100, 110, "left", 1000), 0.41);
  approximately(workspaceResizeRatioFromDelta(0.4, 100, 110, "right", 1000), 0.39);
  approximately(workspaceResizeRatioFromDelta(0.4, 100, 110, "top", 500), 0.42);
  approximately(workspaceResizeRatioFromDelta(0.4, 100, 110, "bottom", 500), 0.38);
  assert.equal(
    workspaceResizeRatioFromDelta(0.4, 10, 30, "left", 1000),
    workspaceResizeRatioFromDelta(0.4, 200, 220, "left", 1000),
    "only pointer delta affects the result",
  );
  assert.equal(workspaceResizeRatioFromDelta(0.4, 100, 100, "left", 1000), 0.4);
  assert.equal(workspaceResizeRatioFromDelta(0.4, 100, 200, "left", 0), 0.4);
});

test("workspace pointer ownership rejects unrelated and missing owners", () => {
  assert.equal(workspacePointerIsOwner(7, 7), true);
  assert.equal(workspacePointerIsOwner(7, 8), false);
  assert.equal(workspacePointerIsOwner(null, 7), false);
});

test("workspace preferences persist, reset, and fail safely when storage is blocked", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  workspacePlacement.value = "right";
  workspaceRatio.value = 0.42;
  assert.equal(persistWorkspaceLayout(storage), true);
  assert.deepEqual(readWorkspaceLayout(storage), { version: 1, placement: "right", ratio: 0.42 });
  assert.ok(values.has(WORKSPACE_LAYOUT_STORAGE_KEY));
  assert.equal(resetWorkspaceLayout(storage), true);
  assert.deepEqual({ placement: workspacePlacement.value, ratio: workspaceRatio.value }, {
    placement: defaultWorkspaceLayout.placement,
    ratio: defaultWorkspaceLayout.ratio,
  });
  assert.equal(values.has(WORKSPACE_LAYOUT_STORAGE_KEY), false);

  const blocked = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  };
  assert.deepEqual(readWorkspaceLayout(blocked), defaultWorkspaceLayout);
  assert.equal(persistWorkspaceLayout(blocked), false);
  assert.equal(resetWorkspaceLayout(blocked), false);
});

test("dashboard interaction contract exposes pointer, keyboard, drag, and mobile controls", async () => {
  const [component, styles, kanban] = await Promise.all([
    readFile(new URL("../src/components/dashboard-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/kanban-board.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(component, /role: "separator" as const/);
  assert.match(component, /tabIndex: 0/);
  assert.match(component, /"aria-valuemin": Math\.round\(MIN_FRACTION \* 100\)/);
  assert.match(component, /"aria-valuemax": Math\.round\(\(1 - MIN_FRACTION\) \* 100\)/);
  assert.match(component, /"aria-valuenow": valueNow/);
  assert.match(component, /onPointerDown: beginResize\(axis, row, index\)/);
  assert.match(component, /onPointerMove: moveResize/);
  assert.match(component, /onKeyDown: resizeWithKeyboard\(axis, row, index\)/);
  assert.match(component, /event\.key === "Home"/);
  assert.match(component, /event\.key === "End"/);
  assert.match(component, /event\.key === \(axis === "row" \? "ArrowUp" : "ArrowLeft"\)/);
  assert.match(component, /event\.key === \(axis === "row" \? "ArrowDown" : "ArrowRight"\)/);
  assert.match(component, /setPointerCapture\(event\.pointerId\)/);
  assert.match(component, /hasPointerCapture\(event\.pointerId\)/);
  assert.match(component, /releasePointerCapture\(event\.pointerId\)/);
  assert.match(component, /setActiveDashboardSizes\(next\)/);
  assert.match(component, /resetActiveDashboardSizes\(\)/);
  assert.match(component, /draggable/);
  assert.match(component, /movePanel\(panelId, index\)/);
  assert.match(component, /addDashboardPanel\("chat", \{ sessionId, index: target\.index \}\)/);
  assert.match(component, /replaceDashboardPanel\(target\.panelId, kind\)/);
  assert.match(component, /replaceDashboardPanel\(target\.panelId, "chat", \{ sessionId \}\)/);
  assert.match(component, /showDropReplace/);
  assert.match(component, /SIDEBAR_DRAG_THRESHOLD_PX/);
  assert.match(component, /activateSidebarPanelPointerDrag\(event\.pointerId\)/);
  assert.match(component, /paneDropTargetAt\(/);
  assert.match(styles, /\.dashboard-replace-drop \{/);
  assert.match(component, /dashboard\.dropInsertBetween/);
  assert.match(component, /dashboard\.dropReplaceHint/);
  assert.match(kanban, /if \(!taskId\) return;\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);
  assert.match(component, /minmax\(\$\{MIN_ROW_PX\}px, \$\{round\(fr\)\}fr\)/);
  assert.match(styles, /\.dashboard-view \{[^}]*overflow: hidden auto/);
  assert.match(styles, /\.dashboard-resize \{[^}]*touch-action: none/);
  assert.match(styles, /@media \(max-width: 768px\)[\s\S]*\.dashboard-resize \{ display: none; \}/);
});
