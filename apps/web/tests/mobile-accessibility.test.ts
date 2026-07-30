import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ChatSession } from "../src/domain.ts";
import { createProfileSession } from "../src/components/profile-panel.tsx";
import { mobileChatTabPresentation } from "../src/components/chat-workspace.tsx";
import { mobileOverlayBackgroundElements } from "../src/components/use-mobile-overlay.ts";
import { locale, preferredBrowserLocale, setLocale } from "../src/i18n.ts";
import {
  clearMobileRoutes,
  closeMobileRoute,
  mobileRouteStack,
  openMobileInspector,
  openMobileWorkspace,
  resetMobileRouteStateForTests,
} from "../src/mobile-routes.ts";
import {
  activeSurface,
  activeSessionId,
  mobileInspectorOpen,
  mobileWorkspaceOpen,
  navigateToSurface,
  officeConnection,
  openSession,
  openSessionIds,
  profileList,
  selectProfile,
  selectedProfileId,
  settingsModalOpen,
  closeSettingsModal,
  sessions,
} from "../src/store.ts";

test("mobile tabs distinguish two sessions from one profile and select the requested session", () => {
  const previousLocale = locale.value;
  const officeUi = session("office-ui", "Office UI");
  const pwaShell = session("pwa-shell", "A deliberately long PWA shell release conversation title");
  const japanese = session("japanese", "外出先から操作するための長い日本語会話タイトル");
  const newChat = { ...session("new-chat", ""), titlePresentation: "new-chat" as const };
  try {
    setLocale("en");
    const first = mobileChatTabPresentation(officeUi, "Theo");
    const second = mobileChatTabPresentation(newChat, "Theo");
    assert.deepEqual(first, { profileName: "Theo", sessionTitle: "Office UI", accessibleLabel: "Theo — Office UI" });
    assert.deepEqual(second, { profileName: "Theo", sessionTitle: "New chat", accessibleLabel: "Theo — New chat" });
    assert.notEqual(first.accessibleLabel, second.accessibleLabel);
    const fourLabels = [officeUi, pwaShell, japanese, newChat]
      .map((item) => mobileChatTabPresentation(item, "Theo").accessibleLabel);
    assert.equal(new Set(fourLabels).size, 4);
    assert.ok(fourLabels[1]?.endsWith(pwaShell.title), "the accessible label must retain the full ellipsized title");

    setLocale("ja");
    assert.equal(mobileChatTabPresentation(newChat, "Theo").sessionTitle, "新しい会話");

    sessions.value = [officeUi, pwaShell, japanese, newChat];
    openSessionIds.value = sessions.value.map(({ id }) => id);
    openSession(officeUi.id);
    assert.equal(activeSessionId.value, officeUi.id);
    openSession(newChat.id);
    assert.equal(activeSessionId.value, newChat.id);
    assert.deepEqual(openSessionIds.value, [officeUi.id, pwaShell.id, japanese.id, newChat.id]);
  } finally {
    setLocale(previousLocale);
    sessions.value = [];
    openSessionIds.value = [];
    activeSessionId.value = "";
  }
});

test("mobile tabs number duplicate rendered titles by current pane order across locale changes", () => {
  const previousLocale = locale.value;
  const draftA = { ...session("draft-a", ""), titlePresentation: "new-chat" as const };
  const storedA = session("stored-a", "New chat");
  const draftB = { ...session("draft-b", ""), titlePresentation: "new-chat" as const };
  const storedB = session("stored-b", "New chat");
  const panes = [draftA, storedA, draftB, storedB];
  try {
    setLocale("en");
    const english = panes.map((item) => mobileChatTabPresentation(item, "Theo", panes));
    assert.deepEqual(english.map(({ sessionTitle }) => sessionTitle), [
      "New chat · 1", "New chat · 2", "New chat · 3", "New chat · 4"
    ]);
    assert.equal(new Set(english.map(({ accessibleLabel }) => accessibleLabel)).size, panes.length);

    setLocale("ja");
    const japanese = panes.map((item) => mobileChatTabPresentation(item, "Theo", panes));
    assert.deepEqual(japanese.map(({ sessionTitle }) => sessionTitle), [
      "新しい会話 · 1", "New chat · 1", "新しい会話 · 2", "New chat · 2"
    ]);
    assert.equal(new Set(japanese.map(({ accessibleLabel }) => accessibleLabel)).size, panes.length);

    const reordered = [storedB, draftB, storedA, draftA];
    assert.deepEqual(reordered.map((item) => mobileChatTabPresentation(item, "Theo", reordered).sessionTitle), [
      "New chat · 1", "新しい会話 · 1", "New chat · 2", "新しい会話 · 2"
    ]);

    sessions.value = panes;
    openSessionIds.value = panes.map(({ id }) => id);
    for (const item of panes) {
      openSession(item.id);
      assert.equal(activeSessionId.value, item.id);
    }
    assert.deepEqual(openSessionIds.value, panes.map(({ id }) => id));
  } finally {
    setLocale(previousLocale);
    sessions.value = [];
    openSessionIds.value = [];
    activeSessionId.value = "";
  }
});

test("mobile new chat opens its workspace only after session creation succeeds", () => {
  const previousConnection = officeConnection.value;
  const previousProfiles = profileList.value;
  const previousSessions = sessions.value;
  const previousOpenIds = openSessionIds.value;
  const previousActiveId = activeSessionId.value;
  const previousSelectedProfile = selectedProfileId.value;
  try {
    resetMobileRouteStateForTests();
    officeConnection.value = { ...previousConnection, state: "demo", source: "demo" };
    profileList.value = [{
      id: "theo", name: "Theo", role: "Engineering", status: "idle", color: "#087f70",
      sessions: 0, taskCount: 0, memoryBytes: 0, memoryNote: "", skills: [], inheritedSkills: [],
    }];
    sessions.value = [];
    openSessionIds.value = [];
    activeSessionId.value = "";
    openMobileInspector();

    assert.equal(createProfileSession("missing"), false);
    assert.equal(mobileInspectorOpen.value, true);
    assert.equal(mobileWorkspaceOpen.value, false);
    assert.deepEqual(sessions.value, []);

    assert.equal(createProfileSession("theo"), true);
    assert.equal(mobileInspectorOpen.value, false);
    assert.equal(mobileWorkspaceOpen.value, true);
    assert.equal(sessions.value.length, 1);
    assert.equal(activeSessionId.value, sessions.value[0]?.id);
    assert.deepEqual(openSessionIds.value, [sessions.value[0]?.id]);
  } finally {
    resetMobileRouteStateForTests();
    clearMobileRoutes();
    officeConnection.value = previousConnection;
    profileList.value = previousProfiles;
    sessions.value = previousSessions;
    openSessionIds.value = previousOpenIds;
    activeSessionId.value = previousActiveId;
    selectedProfileId.value = previousSelectedProfile;
  }
});

test("mobile primary navigation closes both overlays before revealing its surface", () => {
  const previousSurface = activeSurface.value;
  try {
    for (const surface of ["office", "kanban", "teams"] as const) {
      resetMobileRouteStateForTests();
      openMobileWorkspace();
      openMobileInspector();
      navigateToSurface(surface);
      assert.equal(activeSurface.value, surface);
      assert.equal(mobileInspectorOpen.value, false);
      assert.equal(mobileWorkspaceOpen.value, false);
      assert.deepEqual(mobileRouteStack(), []);
    }
    // Settings is a modal and must not replace the active dashboard surface.
    const dashboardSurface = activeSurface.value;
    resetMobileRouteStateForTests();
    openMobileWorkspace();
    navigateToSurface("settings");
    assert.equal(activeSurface.value, dashboardSurface);
    assert.equal(settingsModalOpen.value, true);
    assert.equal(mobileWorkspaceOpen.value, false);
    closeSettingsModal();

    // Legacy library nav folds into the same global Settings modal.
    resetMobileRouteStateForTests();
    openMobileWorkspace();
    navigateToSurface("library");
    assert.equal(activeSurface.value, dashboardSurface);
    assert.equal(settingsModalOpen.value, true);
    assert.equal(mobileWorkspaceOpen.value, false);
  } finally {
    closeSettingsModal();
    resetMobileRouteStateForTests();
    clearMobileRoutes();
    activeSurface.value = previousSurface;
  }
});

test("mobile profile selection only opens a route when chat workspace is requested", () => {
  const previousProfiles = profileList.value;
  const previousSessions = sessions.value;
  const previousOpenIds = openSessionIds.value;
  const previousActiveId = activeSessionId.value;
  const previousSelectedProfile = selectedProfileId.value;
  const previousConnection = officeConnection.value;
  try {
    resetMobileRouteStateForTests();
    officeConnection.value = { ...previousConnection, state: "demo", source: "demo" };
    profileList.value = [{
      id: "theo", name: "Theo", role: "Engineering", status: "idle", color: "#087f70",
      sessions: 0, taskCount: 0, memoryBytes: 0, memoryNote: "", skills: [], inheritedSkills: [],
    }];
    sessions.value = [];
    openSessionIds.value = [];
    activeSessionId.value = "";

    // Sidebar selection updates the profile without inventing a hidden route.
    selectProfile("theo", { openDetail: false });
    assert.equal(mobileInspectorOpen.value, false);
    assert.equal(mobileWorkspaceOpen.value, false);
    assert.deepEqual(mobileRouteStack(), []);

    // openWorkspace opens a fresh chat only — never the inspector. Existing
    // durable conversations require an explicit conversation-row selection.
    selectProfile("theo", { openWorkspace: true });
    assert.equal(mobileInspectorOpen.value, false);
    assert.equal(mobileWorkspaceOpen.value, true);
    assert.deepEqual(mobileRouteStack(), ["workspace"]);
    assert.equal(sessions.value.length, 1);

    sessions.value = [session("existing", "Existing chat")];
    openSessionIds.value = ["existing"];
    selectProfile("theo", { openWorkspace: true });
    assert.equal(mobileInspectorOpen.value, false);
    assert.equal(mobileWorkspaceOpen.value, true);
    assert.equal(sessions.value.length, 2);
    assert.notEqual(activeSessionId.value, "existing");
    assert.equal(sessions.value.find((item) => item.id === activeSessionId.value)?.titlePresentation, "new-chat");
    assert.deepEqual(mobileRouteStack(), ["workspace"]);
  } finally {
    resetMobileRouteStateForTests();
    clearMobileRoutes();
    officeConnection.value = previousConnection;
    profileList.value = previousProfiles;
    sessions.value = previousSessions;
    openSessionIds.value = previousOpenIds;
    activeSessionId.value = previousActiveId;
    selectedProfileId.value = previousSelectedProfile;
  }
});

test("mobile route stack closes workspace then inspector and restores workspace under inspector", () => {
  try {
    resetMobileRouteStateForTests();
    openMobileWorkspace();
    assert.deepEqual(mobileRouteStack(), ["workspace"]);
    assert.equal(mobileWorkspaceOpen.value, true);
    assert.equal(mobileInspectorOpen.value, false);

    openMobileInspector();
    assert.deepEqual(mobileRouteStack(), ["workspace", "inspector"]);
    assert.equal(mobileWorkspaceOpen.value, false);
    assert.equal(mobileInspectorOpen.value, true);

    closeMobileRoute();
    assert.deepEqual(mobileRouteStack(), ["workspace"]);
    assert.equal(mobileWorkspaceOpen.value, true);
    assert.equal(mobileInspectorOpen.value, false);

    closeMobileRoute();
    assert.deepEqual(mobileRouteStack(), []);
    assert.equal(mobileWorkspaceOpen.value, false);
    assert.equal(mobileInspectorOpen.value, false);

    openMobileInspector();
    closeMobileRoute();
    assert.deepEqual(mobileRouteStack(), []);
    assert.equal(mobileInspectorOpen.value, false);
  } finally {
    resetMobileRouteStateForTests();
    clearMobileRoutes();
  }
});

test("mobile route and modal overlays expose consistent focus, inert, and navigation semantics", async () => {
  const [app, rail, settings, profileChat, overlay, outsideClose, main, routes] = await Promise.all([
    readFile(new URL("../src/app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/side-rail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/settings-modal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/profile-chat-modal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/use-mobile-overlay.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/components/use-modal-outside-close.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/mobile-routes.ts", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(rail, /onClick=\{\(\) => \{\s*addDashboardPanel\(item\.kind\)/);
  assert.match(rail, /aria-keyshortcuts="Shift\+Enter"/);
  assert.match(rail, /event\.key !== "Enter" \|\| !event\.shiftKey/);
  assert.match(rail, /addPanelFromKeyboard\(item\.kind\)/);
  assert.match(rail, /if \(result === "full"\)/);
  assert.match(rail, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(rail, /activateOrAddPanelFromClick\(item\.kind\)/);
  assert.match(rail, /activateMobileChatTab\(defaultProfile\.id\)/);
  assert.match(rail, /activateDashboardContainingPanel\("chat", \{ sessionId \}\)/);
  assert.match(rail, /addDashboardPanel\("chat", \{ sessionId \}\)/);
  assert.match(rail, /item\.dataset\.sessionId === sessionId/);
  assert.match(rail, /if \(event\.pointerType === "mouse"\) beginSidebarSessionPointerDrag/);
  assert.match(rail, /if \(phoneViewport\) setMobileTabKind\("chat"\)/);
  assert.match(rail, /if \(phoneViewport\) revealMobilePanel\("chat", sessionId\)/);
  assert.match(rail, /if \(phoneViewport && !hasSessions\) closeMobileProfiles\(\)/);
  assert.match(rail, /if \(iconOnly && !phoneViewport\)/);
  assert.match(rail, /activeSessionId\.value[\s\S]*sidebar\.currentChatOpen[\s\S]*sidebar\.defaultChatStart/);
  assert.match(app, /data-mobile-route-chrome/);
  assert.match(rail, /data-mobile-route-chrome/);
  assert.match(app, /<SettingsModal \/>/);
  assert.match(app, /<ProfileChatModal \/>/);
  assert.match(profileChat, /if \(openPaneIds\.includes\(session\.id\)\)/);
  assert.match(profileChat, /setProfileChatModalActivePane\(session\.id\)/);
  assert.match(profileChat, /profileChatModalActivePaneId\.value === session\.id/);
  assert.match(profileChat, /replaceProfileChatModalPane\(target\.sessionId, sessionId\)/);
  assert.match(profileChat, /MODAL_SESSION_DRAG_THRESHOLD_PX/);
  assert.match(profileChat, /window\.addEventListener\("blur", clearPointerDrag\)/);
  assert.doesNotMatch(profileChat, /aria-keyshortcuts="Shift\+Enter"/);
  assert.doesNotMatch(profileChat, /onAdd\(\)/);
  assert.match(profileChat, /profile-chat-drop-note" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(profileChat, /profile\.newChatUnavailable/);
  assert.match(profileChat, /disabled=\{!canCreateChat\}/);
  assert.match(profileChat, /if \(openPaneIds\.length > 0\) return;[\s\S]*createSession\(profile\.id, \{ workspace: false \}\)/);
  assert.match(app, /activateDashboardContainingPanel\("studio"\)/);
  assert.doesNotMatch(app, /addDashboardPanel\("studio"\)/);
  for (const modal of [settings, profileChat]) {
    assert.match(modal, /kind: "modal"/);
    assert.match(modal, /viewport: "\(min-width: 0px\)"/);
    assert.match(modal, /role="dialog"/);
    assert.match(modal, /aria-modal="true"/);
    assert.match(modal, /data-mobile-overlay-initial-focus/);
    assert.match(modal, /useModalOutsideClose/);
  }
  assert.match(overlay, /COMPACT_OVERLAY_VIEWPORT = "\(max-width: 1279px\)"/);
  assert.match(overlay, /PHONE_OVERLAY_VIEWPORT = "\(max-width: 768px\)"/);
  assert.match(overlay, /mobileOverlayBackgroundElements\(overlayRoot, appShell, kind, preserveMobileRouteChrome\)/);
  assert.match(overlay, /while \(overlayBranch !== appShell\)/);
  assert.match(overlay, /parent === appShell && keepRouteChrome/);
  assert.match(overlay, /lockBackgroundElements\(background\)/);
  assert.match(overlay, /event\.key === "Escape"/);
  assert.match(overlay, /kind !== "modal" \|\| event\.key !== "Tab"/);
  assert.match(overlay, /canRestoreModalFocus\(previousFocus\)/);
  assert.match(outsideClose, /pressStartedOnLayer\.current = event\.target === event\.currentTarget/);
  assert.match(outsideClose, /event\.detail !== 0/);
  assert.match(main, /installMobileRouteHistory\(\)/);
  assert.match(routes, /openMobileWorkspace/);
  assert.match(routes, /openMobileInspector/);
  assert.match(routes, /closeMobileRoute/);
  assert.match(routes, /history\.pushState/);
  assert.match(routes, /popstate/);
});

test("nested mobile workspace locks every sibling branch without inerting its own ancestors", () => {
  const previousHTMLElement = globalThis.HTMLElement;
  class FakeElement {
    parentElement: FakeElement | null;
    children: FakeElement[] = [];
    private attributes = new Set<string>();
    constructor(readonly name: string, parent: FakeElement | null = null) {
      this.parentElement = parent;
      parent?.children.push(this);
    }
    hasAttribute(name: string): boolean { return this.attributes.has(name); }
    mark(name: string): this { this.attributes.add(name); return this; }
  }
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: FakeElement });
  try {
    const shell = new FakeElement("shell");
    const topbar = new FakeElement("topbar", shell).mark("data-mobile-route-chrome");
    const rail = new FakeElement("rail", shell).mark("data-mobile-route-chrome");
    const host = new FakeElement("workspace-host", shell);
    const profile = new FakeElement("profile", shell);
    new FakeElement("surface", host);
    new FakeElement("separator", host);
    new FakeElement("dock-controls", host);
    const chatBranch = new FakeElement("chat-branch", host);
    new FakeElement("live-region", host);
    const drawer = new FakeElement("drawer", chatBranch);

    const routeBackground = mobileOverlayBackgroundElements(
      drawer as unknown as HTMLElement,
      shell as unknown as HTMLElement,
      "route",
    ) as unknown as FakeElement[];
    assert.deepEqual(routeBackground.map(({ name }) => name), ["surface", "separator", "dock-controls", "live-region", "profile"]);
    for (const activeBranch of [drawer, chatBranch, host, topbar, rail]) {
      assert.equal(routeBackground.includes(activeBranch), false, `${activeBranch.name} must remain outside the inert set`);
    }

    const modalBackground = mobileOverlayBackgroundElements(
      profile as unknown as HTMLElement,
      shell as unknown as HTMLElement,
      "modal",
    ) as unknown as FakeElement[];
    assert.deepEqual(modalBackground.map(({ name }) => name), ["topbar", "rail", "workspace-host"]);
  } finally {
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
  }
});

test("first-run locale follows the browser and login exposes an unauthenticated language switch", async () => {
  assert.equal(preferredBrowserLocale({ language: "en-US", languages: ["en-US", "ja-JP"] }), "en");
  assert.equal(preferredBrowserLocale({ language: "en-US", languages: ["en-US"] }), "en");
  assert.equal(preferredBrowserLocale({ language: "ja-JP", languages: ["ja-JP"] }), "ja");
  assert.equal(preferredBrowserLocale({ language: "fr-FR", languages: ["fr-FR"] }), "en");
  const login = await readFile(new URL("../src/components/device-login.tsx", import.meta.url), "utf8");
  assert.match(login, /class="dl-lang"/);
  assert.match(login, /setLocale\(locale\.value === "ja" \? "en" : "ja"\)/);
});

test("operation evidence uses one deduplicated live status outside its non-live timeline entries", async () => {
  const chat = await readFile(new URL("../src/components/chat-pane.tsx", import.meta.url), "utf8");
  assert.match(chat, /nextOperationAnnouncement\(operationEvidence, announcedOperationKey\.current\)/);
  assert.match(chat, /role=\{announcedOperation && isUrgentOperation\(announcedOperation\) \? "alert" : "status"\}/);
  assert.match(chat, /aria-live=\{announcedOperation && isUrgentOperation\(announcedOperation\) \? "assertive" : "polite"\}/);
  assert.match(chat, /aria-atomic="true"/);
  assert.match(chat, /aria-live="off"/);
});

test("delegated conversations remain identified inside dashboard chat panels", async () => {
  const dashboard = await readFile(new URL("../src/components/dashboard-view.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /conversationKind === "delegated"/);
  assert.match(dashboard, /delegated-chat-badge/);
  assert.match(dashboard, /profile\.delegatedChat/);
  assert.match(dashboard, /document\.elementFromPoint\(x, y\)/);
  assert.match(dashboard, /isVisibleDashboardPoint\(host, event\.clientX, event\.clientY\)/);
});

test("mobile tab and Kanban CSS preserve scrolling, focus, scaled text, and touch targets", async () => {
  const [workspace, styles, appearance, liveSettings, audit] = await Promise.all([
    readFile(new URL("../src/components/chat-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/appearance.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/live-settings.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/access-audit.css", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /aria-label=\{tab\.accessibleLabel\}/);
  assert.match(workspace, /<span>\{tab\.profileName\}<\/span>[\s\S]*<small title=\{tab\.sessionTitle\}>/);
  assert.match(styles, /\.mobile-chat-tabs \{[^}]*overflow-x: auto/);
  assert.match(styles, /\.mobile-chat-tabs button:focus-visible \{[^}]*outline: 2px solid/);
  assert.match(styles, /\.mobile-chat-tabs button \{[^}]*clamp\(148px, 48vw, 220px\)/);
  assert.match(styles, /\.side-rail\[data-mobile-profiles-open="true"\] \.sidebar-session \{[^}]*touch-action: pan-y/);
  assert.match(styles, /\.side-rail\[data-mobile-profiles-open="true"\] \.sidebar-session > i \{[^}]*touch-action: none/);
  assert.match(styles, /\.user-instruction-body\.is-collapsed \{[^}]*max-height: calc\(1\.65em \* 10\)/);
  assert.match(styles, /\.user-instruction:hover \.user-instruction-utilities,[\s\S]*opacity: 1/);
  assert.match(styles, /@media \(hover: none\) \{[\s\S]*\.user-instruction-copy \{[^}]*var\(--target-mobile, 44px\)/);

  assert.match(styles, /--text-xs: calc\(12px \* var\(--font-scale, 1\)\)/);
  assert.match(styles, /--text-sm: calc\(13px \* var\(--font-scale, 1\)\)/);
  assert.match(styles, /--text-md: calc\(14px \* var\(--font-scale, 1\)\)/);
  assert.match(styles, /\.task-assignee-select, \.task-status-select \{[^}]*var\(--text-xs\)/);
  assert.match(styles, /\.dl-lang \{[^}]*min-height: var\(--target-mobile, 44px\)[^}]*var\(--text-label, 14px\)/);

  const mobileTargets = selectorsUsing(appearance, "min-height: var(--target-mobile)");
  for (const selector of [".task-assignee-select select", ".task-status-select select", ".task-card footer button", ".task-comments-error button", ".task-comment-form input", ".task-comment-form button", ".kanban-unconfirmed button"]) {
    assert.match(mobileTargets, new RegExp(escapeRegExp(selector)), `${selector} must use the mobile touch target`);
  }
  assert.match(styles, /\.task-assignee-select, \.task-status-select \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /\.task-comment-list header \{[^}]*flex-wrap: wrap/);
  assert.match(styles, /\.task-comment-form \{[^}]*minmax\(var\(--target-mobile\), max-content\)/);

  for (const selector of [".live-settings__tabs button", ".skill-line p", ".settings-ledger textarea", ".memory-gauge-metrics > span", ".settings-field"]) {
    assert.match(declarationsForSelector(liveSettings, selector), /var\(--ls-text-|var\(--font-scale\)/, `${selector} must follow the selected font scale`);
  }
  for (const selector of [".access-audit__title p", ".access-audit__current strong", ".access-audit__rail li", ".access-audit__message", ".access-audit__logout-copy p"]) {
    assert.match(declarationsForSelector(audit, selector), /var\(--font-scale\)|var\(--text-/, `${selector} must follow the selected font scale`);
  }
});

test("small phones preserve scaled primary navigation, safe areas, and touch targets", async () => {
  const [app, styles, appearance] = await Promise.all([
    readFile(new URL("../src/app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/appearance.css", import.meta.url), "utf8"),
  ]);

  const mobileShell = declarationsForSelector(styles, ".app-shell.has-open-workspace");
  assert.match(mobileShell, /84px \+ env\(safe-area-inset-bottom\)/);
  assert.match(styles, /\.side-rail button \{[^}]*min-height: 68px[^}]*overflow-wrap: anywhere/);
  assert.match(styles, /@media \(max-width: 359px\) \{\s*\.brand > span:last-child \{ display: none; \}/);
  assert.match(styles, /\.brand > span:last-child \{[^}]*overflow: hidden/);
  assert.match(styles, /\.brand \{[^}]*min-width: var\(--target-mobile\)[^}]*min-height: var\(--target-mobile\)/);
  assert.match(styles, /\.workspace-drawer \{[^}]*safe-area-inset-top[^}]*safe-area-inset-bottom/);
  assert.match(styles, /\.info-tip__trigger \{[^}]*min-height: var\(--target-mobile\) !important/);
  assert.match(appearance, /\.compact-inspector-button,[\s\S]*\.user-button,[\s\S]*min-height: var\(--target-mobile\)/);

  const mobileTargets = selectorsUsing(appearance, "min-height: var(--target-mobile)");
  for (const selector of [".side-rail button", ".mobile-close", ".panel-tabs button", ".profile-live-route button", ".new-chat-button", ".session-list button", ".avatar-picker header > button", ".avatar-picker-actions button", ".appearance-trigger", ".language-button", ".compact-inspector-button", ".user-button"]) {
    assert.match(mobileTargets, new RegExp(escapeRegExp(selector)), `${selector} must keep a mobile touch target`);
  }
  assert.match(appearance, /\.mobile-close,[\s\S]*\.avatar-picker header > button \{ min-width: var\(--target-mobile\); \}/);
  // Remote logout lives in DeviceAdmin only — never a topbar one-tap control.
  assert.doesNotMatch(app, /logoutRemoteDevice/);
  assert.doesNotMatch(app, /user-button/);
  assert.doesNotMatch(app, /class="user-button"/);
  assert.doesNotMatch(app, /<button[^>]*>KO<\/button>/);

  const deviceAdmin = await readFile(new URL("../src/components/device-admin.tsx", import.meta.url), "utf8");
  assert.match(deviceAdmin, /logoutRemoteDevice/);
  assert.match(deviceAdmin, /isLocalOfficeClient/);
  assert.match(deviceAdmin, /hostAdmin\.logoutConfirm/);
  assert.match(deviceAdmin, /location\.reload\(\)/);

  const audit = await readFile(new URL("../src/components/access-audit.css", import.meta.url), "utf8");
  assert.match(audit, /\.access-audit__logout-action \{[\s\S]*min-height: var\(--target-mobile/);
  assert.match(audit, /@media \(max-width: 400px\) \{[\s\S]*\.access-audit__gate \{ grid-template-columns: auto minmax\(0, 1fr\); \}/);
  assert.match(audit, /\.access-audit__gate > button \{[^}]*width: 100%[^}]*min-height: var\(--target-mobile\)/);
});

test("compact Profile overlays keep 44px controls through 768, 1024, and 1279px", async () => {
  const appearance = await readFile(new URL("../src/appearance.css", import.meta.url), "utf8");
  const compactRule = appearance.match(/@media \(max-width: (1279)px\) \{([\s\S]*?)\n\}\n\n@media \(max-width: 768px\)/);
  assert.ok(compactRule, "compact touch-target rules must precede the phone-only rules");
  const maxWidth = Number(compactRule[1]);
  for (const viewport of [768, 1024, 1279]) {
    assert.ok(viewport <= maxWidth, `${viewport}px must receive compact touch targets`);
  }
  const compactTargets = selectorsUsing(compactRule[2] ?? "", "min-height: var(--target-mobile)");
  for (const selector of [".mobile-close", ".panel-tabs button", ".profile-live-route button", ".new-chat-button", ".session-list button", ".avatar-picker header > button", ".avatar-picker-actions button"]) {
    assert.match(compactTargets, new RegExp(escapeRegExp(selector)), `${selector} must keep a compact-overlay touch target`);
  }
  const compactSquareTargets = selectorsUsing(compactRule[2] ?? "", "min-width: var(--target-mobile)");
  for (const selector of [".mobile-close", ".avatar-picker header > button"]) {
    assert.match(compactSquareTargets, new RegExp(escapeRegExp(selector)), `${selector} must remain at least 44px wide`);
  }
});

test("information triggers remain siblings of headings used as accessible names", async () => {
  const sources = await Promise.all([
    "office-scene.tsx",
    "avatar-picker.tsx",
    "profile-panel.tsx",
    "access-audit.tsx",
    "appearance-settings.tsx",
    "live-settings.tsx",
  ].map((file) => readFile(new URL(`../src/components/${file}`, import.meta.url), "utf8")));

  for (const source of sources) {
    assert.doesNotMatch(source, /<(h[1-3])\b[^>]*>(?:(?!<\/\1>)[\s\S])*<InfoTip/);
  }
  assert.match(sources[0] ?? "", /<h1 id="office-title">\{t\("office\.title"\)\}<\/h1>\s*<InfoTip/);
  assert.match(sources[1] ?? "", /<h3 id="avatar-picker-title">[\s\S]*?<\/h3>\s*<InfoTip/);
  assert.match(sources[4] ?? "", /<h3 id="font-heading">\{t\("appearance\.textSize"\)\}<\/h3>\s*<InfoTip/);
});

function session(id: string, title: string): ChatSession {
  return { id, profileId: "theo", title, status: "ready", messages: [], remoteKind: "demo" };
}

function selectorsUsing(css: string, declaration: string): string {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[2]?.includes(declaration))
    .map((match) => match[1]?.trim())
    .join("\n");
}

function declarationsForSelector(css: string, selector: string): string {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1]?.split(",").some((candidate) => candidate.trim() === selector))
    .map((match) => match[2]?.trim())
    .join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
