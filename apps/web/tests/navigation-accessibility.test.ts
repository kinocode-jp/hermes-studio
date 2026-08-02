import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { InspectorTab, Surface } from "../src/domain.ts";
import { inspectorTabIsSelected, surfaceAriaCurrent } from "../src/navigation-state.ts";

test("primary navigation exposes the current destination through state transitions", () => {
  let active: Surface = "office";
  assert.equal(surfaceAriaCurrent(active, "office"), "page");
  assert.equal(surfaceAriaCurrent(active, "kanban"), undefined);
  active = "kanban";
  assert.equal(surfaceAriaCurrent(active, "office"), undefined);
  assert.equal(surfaceAriaCurrent(active, "kanban"), "page");
});

test("Profile mode buttons expose their pressed state through state transitions", () => {
  let active: InspectorTab = "chat";
  assert.equal(inspectorTabIsSelected(active, "chat"), true);
  assert.equal(inspectorTabIsSelected(active, "skills"), false);
  active = "skills";
  assert.equal(inspectorTabIsSelected(active, "chat"), false);
  assert.equal(inspectorTabIsSelected(active, "skills"), true);
});

test("navigation components expose active dashboards, present panels, and profile modes", async () => {
  const [app, sideRail, profileSettings, scheduledSessions] = await Promise.all([
    readFile(new URL("../src/app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/side-rail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/profile-settings-modal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/scheduled-sessions-panel.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(sideRail, /aria-current=\{isActive \? "page" : undefined\}/);
  assert.match(sideRail, /const selected = phoneViewport \? mobileTabKind === item\.kind : present/);
  assert.match(sideRail, /aria-current=\{selected \? "page" : undefined\}/);
  assert.match(sideRail, /data-panel-kind=\{item\.kind\}/);
  assert.match(sideRail, /beginSidebarPanelPointerDrag\(event, item\.kind\)/);
  assert.match(sideRail, /consumeSidebarPanelClickSuppression\(item\.kind\)/);
  assert.match(sideRail, /activateOrAddPanelFromClick\(item\.kind\)/);
  assert.match(sideRail, /activeDashboard\.value\.panels\.length === 0/);
  assert.doesNotMatch(sideRail, /onClick=\{\(\) => \{\s*addDashboardPanel\(item\.kind\)/);
  assert.match(sideRail, /aria-keyshortcuts="Shift\+Enter"/);
  assert.match(sideRail, /addPanelFromKeyboard\(item\.kind\)/);
  assert.match(sideRail, /if \(result === "full"\)/);
  assert.match(sideRail, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(app, /activateDashboardContainingPanel\("studio"\)/);
  assert.doesNotMatch(app, /addDashboardPanel\("studio"\)/);
  assert.match(sideRail, /item\.kind === "kanban"\s*\? sidebarTasksOpen\.value/);
  assert.match(sideRail, /aria-expanded=\{hasDisclosure \? disclosureOpen : undefined\}/);
  assert.match(sideRail, /setSidebarTasksOpen\(!sidebarTasksOpen\.value\)/);
  assert.match(sideRail, /item\.kind === "kanban" && kanbanTaskTree/);
  assert.match(sideRail, /activateOrAddPanelFromClick\("kanban"\)\) focusKanbanTask\(task\.id\)/);
  assert.doesNotMatch(sideRail, /activateOrAddPanelFromClick\("kanban"\) && task\.assigneeId/);
  assert.match(sideRail, /task\.status !== "done" && task\.status !== "archived"/);
  assert.doesNotMatch(sideRail, /\.slice\(0, 12\)/);
  assert.match(scheduledSessions, /scheduled\.deleteAllConfirm/);
  assert.match(scheduledSessions, /scheduled\.deleteGroupConfirm/);
  assert.match(profileSettings, /role="dialog"/);
  assert.match(profileSettings, /aria-modal="true"/);
});
