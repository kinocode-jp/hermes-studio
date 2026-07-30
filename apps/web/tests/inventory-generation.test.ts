import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ChatSession, OfficeInventoryPagination, OfficeSnapshot, OfficeSnapshotProfile, OfficeSnapshotRequestIdentity, Profile } from "../src/domain.ts";
import { initializeInventory, loadMoreProfiles, loadMoreSessions, profileInventoryState, registerInventorySnapshotRefresh, sessionInventoryState } from "../src/inventory.ts";
import { defaultAvatarOrdinal } from "../src/avatar-preferences.ts";
import { characterHueRotation } from "../src/components/character-portrait.tsx";
import { locale, localizeRuntimeMessage, setLocale } from "../src/i18n.ts";
import { storedSessionClientId } from "../src/session-identity.ts";
import { chatComposerState, clearChatComposerState, setChatComposerAttachments, setChatComposerDraft } from "../src/chat-composer-state.ts";
import { activeSessionId, applyChatGatewayEvent, applyOfficeSnapshot, interruptSession, openSessionIds, profileList, registerChatRuntime, selectedProfileId, sessions } from "../src/store.ts";

test("a complete session generation upserts extras, prunes unseen rows, and releases an open target once", async () => {
  const browser = installBrowserGlobals();
  const serverUrl = "http://127.0.0.1:55201";
  const pages = [sessionPage([stored("p0", "keep", "Updated", "idle")], terminal(1))];
  globalThis.fetch = inventoryFetch(pages);
  const keepId = storedSessionClientId("p0", "keep");
  const deleteId = storedSessionClientId("p0", "delete");
  const released: string[] = [];
  const interrupted: string[] = [];
  profileList.value = [profile("p0")];
  sessions.value = [
    storedClient("p0", "keep", "Old", { status: "streaming", streamingMessageId: "kept", connectionState: "ready", historyState: "loaded", messages: [{ id: "kept", from: "agent", body: "local", at: "00:00", status: "streaming" }] }),
    storedClient("p0", "delete", "Delete", { connectionState: "ready" }),
    { id: "draft", profileId: "p0", title: "Draft", status: "ready", messages: [], remoteKind: "draft", connectionState: "ready", historyState: "unloaded" }
  ];
  openSessionIds.value = [keepId, deleteId];
  activeSessionId.value = deleteId;
  registerRuntime(released, interrupted);

  try {
    const firstRows = Array.from({ length: 100 }, (_, index) => stored("p0", `first-${index}`, `First ${index}`));
    const first = snapshot({ sessions: firstRows, sessionPage: continuing(100, "sessions-next") });
    applyOfficeSnapshot(first, serverUrl);
    initializeInventory(first, identity(serverUrl, 1));
    await loadMoreSessions();

    const keep = sessions.value.find((session) => session.id === keepId);
    assert.equal(keep?.title, "Updated");
    assert.equal(keep?.status, "streaming");
    assert.equal(keep?.messages[0]?.body, "local");
    assert.equal(keep?.connectionState, "ready");
    assert.equal(keep?.historyState, "loaded");
    assert.equal(sessions.value.some((session) => session.id === deleteId), false);
    assert.equal(sessions.value.some((session) => session.id === "draft"), true);
    assert.deepEqual(released, [deleteId]);
    assert.deepEqual(openSessionIds.value, [keepId]);
    assert.equal(activeSessionId.value, keepId);
    assert.equal(profileList.value[0]?.sessions, 102);
    const stopping = interruptSession(keepId);
    assert.deepEqual(interrupted, [keepId]);
    assert.equal(sessions.value.find((session) => session.id === keepId)?.interruptPending, true);
    assert.equal(await stopping, true);
    assert.equal(sessions.value.find((session) => session.id === keepId)?.status, "ready");
    assert.equal(sessions.value.find((session) => session.id === keepId)?.messages[0]?.status, "cancelled");

    const reuse = snapshot({ sessions: firstRows, sessionPage: continuing(100, "reuse-next"), sequence: 2 });
    applyOfficeSnapshot(reuse, serverUrl);
    initializeInventory(reuse, identity(serverUrl, 2));
    pages.push(sessionPage([stored("p0", "delete", "Reused")], terminal(1)));
    await loadMoreSessions();

    const reused = sessions.value.find((session) => session.id === deleteId);
    assert.equal(reused?.title, "Reused");
    assert.deepEqual(reused?.messages, []);
    assert.equal(reused?.connectionState, "disconnected");
    assert.deepEqual(released, [deleteId, keepId]);
  } finally {
    browser.restore();
  }
});

test("initial snapshots use the same non-regressing runtime status merge and accept completion", () => {
  const serverUrl = "http://127.0.0.1:55206";
  const clientId = storedSessionClientId("p0", "runtime");
  profileList.value = [profile("p0")];
  sessions.value = [storedClient("p0", "runtime", "Runtime", {
    status: "streaming", streamingMessageId: "agent-live", connectionState: "ready",
    messages: [{ id: "agent-live", from: "agent", body: "work", at: "00:00", status: "streaming" }]
  })];

  applyOfficeSnapshot(snapshot({ sessions: [stored("p0", "runtime", "Runtime", "idle")] }), serverUrl);
  assert.equal(sessions.value[0]?.status, "streaming");
  applyChatGatewayEvent(clientId, { type: "message.complete", liveSessionId: "live", payload: { messageId: "agent-live", text: "done" } });
  applyOfficeSnapshot(snapshot({ sessions: [stored("p0", "runtime", "Runtime", "idle")], sequence: 2 }), serverUrl);
  assert.equal(sessions.value[0]?.status, "ready");
  assert.equal(sessions.value[0]?.messages[0]?.status, "complete");
});

test("an authoritative initial snapshot clears composer data for a removed session", () => {
  const serverUrl = "http://127.0.0.1:55209";
  const removedId = storedSessionClientId("p0", "removed-composer");
  clearChatComposerState(removedId);
  profileList.value = [profile("p0")];
  sessions.value = [storedClient("p0", "removed-composer", "Removed")];
  setChatComposerDraft(removedId, "unsent text");
  setChatComposerAttachments(removedId, [{
    id: "inline-image",
    name: "image.png",
    mime: "image/png",
    size: 3,
    kind: "image",
    dataUrl: "data:image/png;base64,AAAA",
  }]);

  applyOfficeSnapshot(snapshot({ sessions: [] }), serverUrl);

  assert.equal(sessions.value.some((session) => session.id === removedId), false);
  assert.deepEqual(chatComposerState(removedId).value, { draft: "", attachments: [] });
  clearChatComposerState(removedId);
});

test("profile pages upsert server fields, preserve UI fields, and prune only at a complete terminal", async () => {
  const browser = installBrowserGlobals();
  const serverUrl = "http://127.0.0.1:55202";
  const pageOne = profilePage([
    { id: "update", name: "Updated", activity: "blocked", activeSessionCount: 7 },
    { id: "update", name: "Duplicate loses", activity: "idle", activeSessionCount: 0 }
  ], continuing(2, "profiles-final"));
  const pageTwo = profilePage([{ id: "new", name: "New", activity: "idle", activeSessionCount: 0 }], terminal(1));
  const pages = [pageOne, pageTwo];
  globalThis.fetch = inventoryFetch(pages);
  profileList.value = [
    profile("p0"),
    { ...profile("update"), name: "Old", role: "Custom role", color: "#123456", memoryNote: "custom", skills: ["local-skill"] },
    profile("delete"),
    { ...profile("draft-profile"), role: "Draft owner" }
  ];
  sessions.value = [{ id: "local-draft", profileId: "draft-profile", title: "Draft", status: "ready", messages: [], remoteKind: "draft" }];
  selectedProfileId.value = "delete";

  try {
    const firstProfiles = Array.from({ length: 100 }, (_, index) => ({ id: `p${index}`, name: `P${index}`, activity: "idle", activeSessionCount: 0 }));
    const first = snapshot({ profiles: firstProfiles, profilePage: continuing(100, "profiles-next") });
    applyOfficeSnapshot(first, serverUrl);
    initializeInventory(first, identity(serverUrl, 10));
    await loadMoreProfiles();

    const updatedBeforeTerminal = profileList.value.find((profile) => profile.id === "update");
    assert.equal(updatedBeforeTerminal?.name, "Updated");
    assert.equal(updatedBeforeTerminal?.status, "blocked");
    assert.equal(updatedBeforeTerminal?.sessions, 7);
    assert.equal(updatedBeforeTerminal?.role, "Custom role");
    assert.equal(updatedBeforeTerminal?.color, "#123456");
    assert.equal(updatedBeforeTerminal?.memoryNote, "custom");
    assert.deepEqual(updatedBeforeTerminal?.skills, ["local-skill"]);
    assert.equal(profileList.value.some((profile) => profile.id === "delete"), true);

    await loadMoreProfiles();
    assert.equal(profileList.value.length, 103);
    assert.deepEqual(profileList.value.slice(-3).map((profile) => profile.id), ["update", "draft-profile", "new"]);
    assert.equal(profileList.value.some((profile) => profile.id === "delete"), false);
    assert.equal(profileList.value.find((profile) => profile.id === "draft-profile")?.role, "Draft owner");
    assert.equal(sessions.value.some((session) => session.id === "local-draft"), true);
    assert.equal(selectedProfileId.value, "p0");
  } finally {
    browser.restore();
  }
});

test("a complete snapshot compacts avatar slots to the current authoritative roster", () => {
  const serverUrl = "http://127.0.0.1:55208";
  const historical = Array.from({ length: 12 }, (_, index) => ({ id: `historical-${index}`, name: `Historical ${index}`, activity: "idle", activeSessionCount: 0 }));
  applyOfficeSnapshot(snapshot({ profiles: historical, sequence: 80 }), serverUrl);
  assert.deepEqual(historical.map(({ id }) => defaultAvatarOrdinal(id)), Array.from({ length: 12 }, (_, index) => index));

  const current = Array.from({ length: 6 }, (_, index) => ({ id: `current-${index}`, name: `Current ${index}`, activity: "idle", activeSessionCount: 0 }));
  applyOfficeSnapshot(snapshot({ profiles: current, sequence: 81 }), serverUrl);
  assert.deepEqual(current.map(({ id }) => defaultAvatarOrdinal(id)), [0, 1, 2, 3, 4, 5]);
  assert.equal(defaultAvatarOrdinal("historical-11"), 6, "a deleted slot is assigned anew only if observed again");
});

test("only a reliable terminal Profile continuation reconciles avatar slots", async () => {
  const browser = installBrowserGlobals();
  const serverUrl = "http://127.0.0.1:55209";
  const historical = Array.from({ length: 12 }, (_, index) => ({ id: `paged-old-${index}`, name: `Old ${index}`, activity: "idle", activeSessionCount: 0 }));
  applyOfficeSnapshot(snapshot({ profiles: historical, sequence: 90 }), serverUrl);
  const current = Array.from({ length: 6 }, (_, index) => ({ id: `paged-current-${index}`, name: `Current ${index}`, activity: "idle", activeSessionCount: 0 }));
  globalThis.fetch = inventoryFetch([profilePage(current.slice(3), terminal(3))]);

  try {
    const first = snapshot({ profiles: current.slice(0, 3), profilePage: continuing(3, "avatar-final"), sequence: 91 });
    applyOfficeSnapshot(first, serverUrl);
    initializeInventory(first, identity(serverUrl, 91));
    assert.equal(defaultAvatarOrdinal("paged-old-11"), 11, "non-terminal snapshots retain historical assignments");
    await loadMoreProfiles();
    assert.deepEqual(current.map(({ id }) => defaultAvatarOrdinal(id)), [0, 1, 2, 3, 4, 5]);
    assert.equal(defaultAvatarOrdinal("paged-old-11"), 6);
  } finally {
    browser.restore();
  }
});

test("a complete empty roster retires old avatar slots before a mixed partial recovery", () => {
  const serverUrl = "http://127.0.0.1:55210";
  const historical = Array.from({ length: 12 }, (_, index) => ({ id: `empty-old-${index}`, name: `Old ${index}`, activity: "idle", activeSessionCount: 0 }));
  applyOfficeSnapshot(snapshot({ profiles: historical, sequence: 100 }), serverUrl);
  assert.deepEqual(historical.map(({ id }) => defaultAvatarOrdinal(id)), Array.from({ length: 12 }, (_, index) => index));

  applyOfficeSnapshot(snapshot({ profiles: [], sequence: 101 }), serverUrl);
  const mixed = [
    { id: "empty-new-a", name: "New A", activity: "idle", activeSessionCount: 0 },
    { id: historical[11]!.id, name: "Returned", activity: "idle", activeSessionCount: 0 },
    { id: "empty-new-b", name: "New B", activity: "idle", activeSessionCount: 0 },
  ];
  applyOfficeSnapshot(snapshot({
    profiles: mixed,
    profilePage: { returned: mixed.length, available: mixed.length, total: mixed.length, hasMore: false, truncated: true, partialFailures: 1 },
    sequence: 102,
  }), serverUrl);

  assert.deepEqual(mixed.map(({ id }) => defaultAvatarOrdinal(id)), [0, 1, 2]);
  assert.deepEqual(mixed.map(({ id }) => characterHueRotation(id)), [0, 0, 0]);
});

test("the explicit demo roster authoritatively resets live avatar hues", () => {
  const serverUrl = "http://127.0.0.1:55211";
  const live = Array.from({ length: 12 }, (_, index) => ({ id: `demo-old-${index}`, name: `Live ${index}`, activity: "idle", activeSessionCount: 0 }));
  try {
    applyOfficeSnapshot(snapshot({ profiles: live, sequence: 110 }), serverUrl);
    assert.equal(defaultAvatarOrdinal(live[11]!.id), 11);

    applyOfficeSnapshot(snapshot({ features: ["demo"], sequence: 111 }), serverUrl);
    assert.deepEqual(profileList.value.map(({ id }) => defaultAvatarOrdinal(id)), [0, 1, 2, 3]);
    assert.deepEqual(profileList.value.map(({ id }) => characterHueRotation(id)), [0, 0, 0, 0]);
  } finally {
    applyOfficeSnapshot(snapshot({ sequence: 112 }), serverUrl);
  }
});

test("partial terminal inventory preserves LKG until a later complete generation", async () => {
  const browser = installBrowserGlobals();
  const serverUrl = "http://127.0.0.1:55203";
  const pages = [
    profilePage([], { ...continuing(0, "partial-final"), truncated: true, partialFailures: 1 }),
    profilePage([], terminal(0)),
    profilePage([], terminal(0))
  ];
  globalThis.fetch = inventoryFetch(pages);
  profileList.value = [profile("p0"), profile("stale")];
  sessions.value = [];

  try {
    const partial = snapshot({ profiles: [{ id: "p0", name: "P0", activity: "idle", activeSessionCount: 0 }], profilePage: continuing(1, "partial-next") });
    applyOfficeSnapshot(partial, serverUrl);
    initializeInventory(partial, identity(serverUrl, 20));
    await loadMoreProfiles();
    await loadMoreProfiles();
    assert.equal(profileList.value.some((profile) => profile.id === "stale"), true);

    const recovered = snapshot({ profiles: [{ id: "p0", name: "P0", activity: "idle", activeSessionCount: 0 }], profilePage: continuing(1, "recovered-next"), sequence: 2 });
    applyOfficeSnapshot(recovered, serverUrl);
    initializeInventory(recovered, identity(serverUrl, 21));
    await loadMoreProfiles();
    assert.equal(profileList.value.some((profile) => profile.id === "stale"), false);
  } finally {
    browser.restore();
  }
});

test("a failed continuation never prunes last-known-good extras", async () => {
  const browser = installBrowserGlobals();
  const serverUrl = "http://127.0.0.1:55205";
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/auth/local") return json({ csrfToken: "9123456789abcdef" });
    if (path === "/api/v1/inventory") return json({}, 500);
    return json({}, 404);
  };
  profileList.value = [profile("p0"), profile("lkg")];
  sessions.value = [];

  try {
    const failed = snapshot({ profiles: [{ id: "p0", name: "P0", activity: "idle", activeSessionCount: 0 }], profilePage: continuing(1, "failed-next") });
    applyOfficeSnapshot(failed, serverUrl);
    initializeInventory(failed, identity(serverUrl, 25));
    await loadMoreProfiles();
    assert.equal(profileList.value.some((profile) => profile.id === "lkg"), true);
  } finally {
    browser.restore();
  }
});

test("a deferred terminal from an older generation cannot prune the newer generation", async () => {
  const browser = installBrowserGlobals();
  const serverUrl = "http://127.0.0.1:55204";
  const oldPage = deferred<Response>();
  let inventoryCalls = 0;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/auth/local") return json({ csrfToken: "7123456789abcdef" });
    if (path === "/api/v1/inventory") {
      inventoryCalls += 1;
      return inventoryCalls === 1 ? await oldPage.promise : json(sessionPage([], terminal(0)));
    }
    return json({}, 404);
  };
  const staleId = storedSessionClientId("p0", "stale");
  profileList.value = [profile("p0")];
  sessions.value = [storedClient("p0", "stale", "Stale")];

  try {
    initializeInventory(snapshot({ sessionPage: continuing(0, "old-next") }), identity(serverUrl, 30));
    const oldLoad = loadMoreSessions();
    await until(() => inventoryCalls === 1);
    initializeInventory(snapshot({ sessionPage: continuing(0, "new-next"), sequence: 2 }), identity(serverUrl, 31));
    oldPage.resolve(json(sessionPage([], terminal(0))));
    await oldLoad;
    assert.equal(sessions.value.some((session) => session.id === staleId), true);

    await loadMoreSessions();
    assert.equal(sessions.value.some((session) => session.id === staleId), false);
  } finally {
    browser.restore();
  }
});

test("profile and session continuation errors localize at render time for every known failure", async () => {
  const browser = installBrowserGlobals();
  const previousLocale = locale.value;
  const [officeSceneSource, sideRailSource] = await Promise.all([
    readFile(new URL("../src/components/office-scene.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/side-rail.tsx", import.meta.url), "utf8")
  ]);
  assert.match(officeSceneSource, /localizeRuntimeMessage\(inventory\.error\)/);
  assert.match(sideRailSource, /localizeRuntimeMessage\(inventory\.error\)/);

  const cases = [
    { failure: "invalid" as const, ja: "Studio Serverの一覧ページに互換性がありません。", en: "The Studio Server returned an incompatible inventory page." },
    { failure: "snapshot" as const, ja: "Studio Serverの一覧を更新できませんでした。もう一度お試しください。", en: "Unable to refresh the Studio Server inventory. Try again." },
    { failure: "http" as const, ja: "Studio Serverから一覧を取得できませんでした（HTTP 503）。", en: "Unable to load the inventory from Studio Server (HTTP 503)." }
  ];
  try {
    let requestGeneration = 100;
    for (const kind of ["profiles", "sessions"] as const) {
      for (const current of cases) {
        const serverUrl = `http://127.0.0.1:${56000 + requestGeneration}`;
        globalThis.fetch = async (input) => {
          const path = new URL(String(input)).pathname;
          if (path === "/api/v1/auth/local") return json({ csrfToken: `${requestGeneration}23456789abcdef` });
          if (path !== "/api/v1/inventory") return json({}, 404);
          if (current.failure === "http") return json({}, 503);
          if (current.failure === "snapshot") return json({}, 409);
          return json({});
        };
        const first = snapshot({
          ...(kind === "profiles" ? { profilePage: continuing(1, `${kind}-next`) } : { sessionPage: continuing(0, `${kind}-next`) })
        });
        initializeInventory(first, identity(serverUrl, requestGeneration++));
        registerInventorySnapshotRefresh(current.failure === "snapshot" ? async () => undefined : undefined);
        await (kind === "profiles" ? loadMoreProfiles() : loadMoreSessions());
        const error = (kind === "profiles" ? profileInventoryState : sessionInventoryState).value.error;
        assert.ok(error, `${kind}/${current.failure} must retain a typed error`);
        setLocale("ja");
        assert.equal(localizeRuntimeMessage(error), current.ja);
        setLocale("en");
        assert.equal(localizeRuntimeMessage(error), current.en);
      }
    }
  } finally {
    registerInventorySnapshotRefresh(undefined);
    setLocale(previousLocale);
    browser.restore();
  }
});

function snapshot(options: {
  profiles?: OfficeSnapshotProfile[];
  sessions?: OfficeSnapshot["sessions"];
  profilePage?: OfficeInventoryPagination;
  sessionPage?: OfficeInventoryPagination;
  sequence?: number;
  features?: OfficeSnapshot["capabilities"]["features"];
} = {}): OfficeSnapshot {
  const profiles = options.profiles ?? [{ id: "p0", name: "P0", activity: "idle", activeSessionCount: 0 }];
  const storedSessions = options.sessions ?? [];
  return {
    generatedAt: new Date(options.sequence ?? 1).toISOString(), sequence: options.sequence ?? 1,
    capabilities: { protocolVersion: 1, serverVersion: "test", runtime: { state: "ready", adapterVersion: "test" }, access: { deviceId: "local", tier: "owner", exposure: "loopback", authentication: "local-cookie", allowedOperations: ["state.read"] }, features: options.features ?? ["chat", "profiles"] },
    profiles, sessions: storedSessions,
    inventory: { profiles: options.profilePage ?? terminal(profiles.length), sessions: options.sessionPage ?? terminal(storedSessions.length) },
    boards: []
  };
}

function profile(id: string): Profile {
  return { id, name: id, role: "", status: "idle", color: "#64b7a7", sessions: 0, taskCount: 0, memoryBytes: 0, memoryNote: "", skills: [], inheritedSkills: [] };
}

function stored(profileId: string, id: string, title = id, activity = "idle") {
  return { id, profileId, title, activity };
}

function storedClient(profileId: string, id: string, title: string, extra: Partial<ChatSession> = {}): ChatSession {
  return { id: storedSessionClientId(profileId, id), storedSessionId: id, profileId, title, status: "ready", messages: [], remoteKind: "stored", connectionState: "disconnected", historyState: "unloaded", ...extra };
}

function profilePage(rows: OfficeSnapshotProfile[], pagination: OfficeInventoryPagination) {
  return { kind: "profiles" as const, profiles: rows, sessions: [], pagination };
}

function sessionPage(rows: OfficeSnapshot["sessions"], pagination: OfficeInventoryPagination) {
  return { kind: "sessions" as const, profiles: [], sessions: rows, pagination };
}

function terminal(returned: number): OfficeInventoryPagination {
  return { returned, available: returned, total: returned, hasMore: false, truncated: false, partialFailures: 0 };
}

function continuing(returned: number, nextCursor: string): OfficeInventoryPagination {
  return { returned, available: returned + 1, total: returned + 1, hasMore: true, truncated: false, partialFailures: 0, nextCursor };
}

function identity(serverUrl: string, requestGeneration: number): OfficeSnapshotRequestIdentity {
  return { serverUrl, connectionGeneration: 1, requestGeneration };
}

function inventoryFetch(pages: unknown[]): typeof fetch {
  return async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/auth/local") return json({ csrfToken: "8123456789abcdef" });
    if (path === "/api/v1/inventory") return json(pages.shift() ?? {});
    return json({}, 404);
  };
}

function registerRuntime(released: string[], interrupted: string[] = []): void {
  registerChatRuntime({
    ensureSession() {},
    releaseSession(sessionId) { released.push(sessionId); },
    submitPrompt() {}, async steer() { return { status: "queued" }; }, interrupt(sessionId) { interrupted.push(sessionId); },
    async respondClarify() {}, async respondApproval() {}
  });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("request did not reach expected state");
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function installBrowserGlobals(): { restore(): void } {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalLocation = globalThis.location;
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1" } });
  return { restore() {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, "location", { configurable: true, value: originalLocation });
  } };
}
