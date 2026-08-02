import assert from "node:assert/strict";
import test from "node:test";
import type { OfficeSnapshot } from "../src/domain.ts";
import { mergeInventoryPage } from "../src/inventory.ts";
import { storedSessionClientId } from "../src/session-identity.ts";
import { applyOfficeSnapshot, getOpenChatTargets, openSession, openSessionIds, profileList, sessions } from "../src/store.ts";

test("a stored session loaded after the snapshot page remains selectable and resumable", () => {
  profileList.value = [{ id: "profile-0", name: "Profile 0", role: "", status: "idle", color: "#64b7a7", sessions: 100, taskCount: 0, memoryBytes: 0, memoryNote: "", skills: [], inheritedSkills: [] }];
  sessions.value = Array.from({ length: 100 }, (_, index) => ({ id: `session-${index}`, storedSessionId: `session-${index}`, profileId: "profile-0", title: `Session ${index}`, status: "ready" as const, messages: [], remoteKind: "stored" as const }));

  mergeInventoryPage({
    kind: "sessions",
    profiles: [],
    sessions: [{ id: "session-100", profileId: "profile-0", title: "Session 100", activity: "idle" }],
    pagination: { returned: 1, available: 101, total: 101, hasMore: false, truncated: false, partialFailures: 0 },
  });
  const clientId = storedSessionClientId("profile-0", "session-100");
  openSession(clientId);

  assert.equal(sessions.value.at(-1)?.title, "Session 100");
  assert.deepEqual(getOpenChatTargets().at(-1), { clientSessionId: clientId, profileId: "profile-0", storedSessionId: "session-100" });
});

test("Kanban worker terminal markers do not add a conversation or profile session count", () => {
  sessions.value = [];
  openSessionIds.value = [];
  profileList.value = [];

  applyOfficeSnapshot(snapshotWithSessions([
    stored("p1", "real-chat"),
    { id: "worker-terminal", profileId: "p1", title: "Kanban terminal transition recorded; this worker run is finished.", activity: "idle" },
  ]), "http://127.0.0.1:4317");

  assert.deepEqual(sessions.value.map((session) => session.storedSessionId), ["real-chat"]);
  assert.equal(profileList.value.find((profile) => profile.id === "p1")?.sessions, 1);
});

test("an authoritative inventory row clears a promoted draft title presentation", () => {
  sessions.value = [{
    id: "draft-client", storedSessionId: "stored-draft", liveSessionId: "live-draft", profileId: "profile-0",
    title: "", titlePresentation: "new-chat", status: "ready", messages: [], remoteKind: "stored",
  }];
  mergeInventoryPage(sessionPage([{ id: "stored-draft", profileId: "profile-0", title: "正式タイトル", activity: "idle" }]));
  assert.equal(sessions.value[0]?.id, "draft-client");
  assert.equal(sessions.value[0]?.title, "正式タイトル");
  assert.equal(sessions.value[0]?.titlePresentation, undefined);
});

test("same raw session IDs in one continuation page keep distinct profile-scoped identities", () => {
  sessions.value = [];
  openSessionIds.value = [];
  profileList.value = [profile("p1"), profile("p2")];
  mergeInventoryPage(sessionPage([stored("p1", "shared-id"), stored("p2", "shared-id")]));

  const firstId = storedSessionClientId("p1", "shared-id");
  const secondId = storedSessionClientId("p2", "shared-id");
  assert.deepEqual(sessions.value.map((session) => session.id), [firstId, secondId]);
  openSession(secondId);
  assert.deepEqual(getOpenChatTargets().at(-1), { clientSessionId: secondId, profileId: "p2", storedSessionId: "shared-id" });
});

test("same raw session IDs arriving on different pages remain independently addressable", () => {
  sessions.value = [];
  openSessionIds.value = [];
  profileList.value = [profile("p1"), profile("p2")];
  mergeInventoryPage(sessionPage([stored("p1", "shared-id")]));
  mergeInventoryPage(sessionPage([stored("p2", "shared-id")]));

  const firstId = storedSessionClientId("p1", "shared-id");
  const secondId = storedSessionClientId("p2", "shared-id");
  assert.deepEqual(sessions.value.map((session) => session.id), [firstId, secondId]);
  openSession(firstId);
  openSession(secondId);
  // Live leases prioritize the most recently selected pane while retaining
  // both profile-scoped identities for the same raw Hermes session ID.
  assert.deepEqual(getOpenChatTargets(), [
    { clientSessionId: secondId, profileId: "p2", storedSessionId: "shared-id" },
    { clientSessionId: firstId, profileId: "p1", storedSessionId: "shared-id" },
  ]);
});

test("initial snapshot and refresh preserve each profile-scoped session independently", () => {
  sessions.value = [];
  openSessionIds.value = [];
  applyOfficeSnapshot(snapshotWithSessions([stored("p1", "shared-id"), stored("p2", "shared-id")]), "http://127.0.0.1:4317");
  const firstId = storedSessionClientId("p1", "shared-id");
  const secondId = storedSessionClientId("p2", "shared-id");
  sessions.value = sessions.value.map((session) => ({ ...session, messages: [{ id: `message-${session.profileId}`, from: "agent", body: session.profileId, at: "00:00" }] }));
  openSession(secondId);

  applyOfficeSnapshot(snapshotWithSessions([stored("p2", "shared-id"), stored("p1", "shared-id")]), "http://127.0.0.1:4317");
  assert.deepEqual(sessions.value.map((session) => session.id), [secondId, firstId]);
  assert.equal(sessions.value.find((session) => session.id === firstId)?.messages[0]?.body, "p1");
  assert.equal(sessions.value.find((session) => session.id === secondId)?.messages[0]?.body, "p2");
  assert.deepEqual(getOpenChatTargets(), [{ clientSessionId: secondId, profileId: "p2", storedSessionId: "shared-id" }]);
});

test("a profile loaded after the snapshot page is added once in upstream order", () => {
  profileList.value = [];
  mergeInventoryPage({
    kind: "profiles",
    profiles: [
      { id: "profile-100", name: "Profile 100", activity: "idle", activeSessionCount: 0 },
      { id: "profile-101", name: "Profile 101", activity: "offline", activeSessionCount: 0 },
      { id: "profile-100", name: "duplicate", activity: "idle", activeSessionCount: 0 },
    ],
    sessions: [],
    pagination: { returned: 3, available: 102, total: 102, hasMore: false, truncated: false, partialFailures: 0 },
  });
  assert.deepEqual(profileList.value.map((profile) => profile.id), ["profile-100", "profile-101"]);
});

function profile(id: string) {
  return { id, name: id, role: "", status: "idle" as const, color: "#64b7a7", sessions: 0, taskCount: 0, memoryBytes: 0, memoryNote: "", skills: [], inheritedSkills: [] };
}

function stored(profileId: string, id: string) {
  return { id, profileId, title: `${profileId} session`, activity: "idle" as const };
}

function sessionPage(rows: OfficeSnapshot["sessions"]) {
  return { kind: "sessions" as const, profiles: [], sessions: rows, pagination: { returned: rows.length, available: rows.length, total: rows.length, hasMore: false, truncated: false, partialFailures: 0 } };
}

function snapshotWithSessions(rows: OfficeSnapshot["sessions"]): OfficeSnapshot {
  return {
    generatedAt: new Date(0).toISOString(), sequence: 1,
    capabilities: { protocolVersion: 1, serverVersion: "test", runtime: { state: "ready", adapterVersion: "test" }, access: { deviceId: "local-test", tier: "owner", exposure: "loopback", authentication: "local-cookie", allowedOperations: ["state.read"] }, features: ["chat", "profiles"] },
    profiles: [{ id: "p1", name: "p1", activity: "idle", activeSessionCount: 1 }, { id: "p2", name: "p2", activity: "idle", activeSessionCount: 1 }],
    sessions: rows,
    inventory: { profiles: { returned: 2, available: 2, total: 2, hasMore: false, truncated: false, partialFailures: 0 }, sessions: { returned: rows.length, available: rows.length, total: rows.length, hasMore: false, truncated: false, partialFailures: 0 } },
    boards: [],
  };
}
