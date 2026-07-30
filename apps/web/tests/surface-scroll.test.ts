import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { rememberSurfaceScroll, restoreSurfaceScroll, type SurfaceScrollPosition } from "../src/surface-scroll.ts";
import type { Surface } from "../src/domain.ts";

test("main surfaces retain independent scroll positions instead of inheriting the previous screen", () => {
  const positions = new Map<Surface, SurfaceScrollPosition>();
  const stage = { scrollTop: 318, scrollLeft: 12 };

  rememberSurfaceScroll(positions, "office", stage);
  stage.scrollTop = 664;
  stage.scrollLeft = 0;
  rememberSurfaceScroll(positions, "settings", stage);

  restoreSurfaceScroll(positions, "office", stage);
  assert.deepEqual(stage, { scrollTop: 318, scrollLeft: 12 });
  restoreSurfaceScroll(positions, "settings", stage);
  assert.deepEqual(stage, { scrollTop: 664, scrollLeft: 0 });
  restoreSurfaceScroll(positions, "kanban", stage);
  assert.deepEqual(stage, { scrollTop: 0, scrollLeft: 0 });
});

test("dashboard panels own their scroll containers instead of sharing an active-surface offset", async () => {
  const [app, dashboard, chat, styles] = await Promise.all([
    readFile(new URL("../src/app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/dashboard-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/chat-pane.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /<DashboardView \/>/);
  assert.match(dashboard, /class="dashboard-panel-body"/);
  assert.match(styles, /\.dashboard-panel-body \{[^}]*overflow: auto/);
  assert.match(styles, /\.dashboard-view \{[^}]*overflow: hidden auto/);
  assert.match(chat, /class="message-list-content"/);
  assert.match(styles, /--chat-content-max-width: 720px/);
  assert.match(styles, /\.message-list-content \{[^}]*width: min\(100%, var\(--chat-content-max-width\)\)[^}]*margin-inline: auto/);
  assert.match(styles, /\.chat-suggestions,[\s\S]*\.composer \{[^}]*width: min\(100%, var\(--chat-content-max-width\)\)[^}]*margin-inline: auto/);
});
