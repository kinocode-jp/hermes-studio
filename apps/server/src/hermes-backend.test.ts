import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HermesBackend, HermesProfileError } from "./hermes-backend.js";

test("inventory reaches the 101st session and profile through bounded continuation pages", async () => {
  const sessionRows = Array.from({ length: 101 }, (_, index) => sessionRow(index));
  const profileRows = Array.from({ length: 101 }, (_, index) => profileRow(index));
  const offsets: number[] = [];
  const fixture = await startHermesFixture((request, response, url) => {
    if (url.pathname === "/api/profiles") return writeJson(response, { profiles: profileRows });
    if (url.pathname === "/api/profiles/sessions") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      offsets.push(offset);
      return writeJson(response, { sessions: sessionRows.slice(offset, offset + 100), total: sessionRows.length, limit: 100, offset, errors: [] });
    }
    return defaultFixtureRoute(request, response, url);
  });
  const backend = fixture.backend;
  try {
    assert.equal((await backend.start()).state, "ready");
    const snapshot = await backend.snapshot();
    assert.equal(snapshot.sessions.length, 100);
    assert.equal(snapshot.profiles.length, 100);
    assert.deepEqual(offsets, [0, 100]);
    assert.equal(snapshot.inventory.sessions.hasMore, true);
    assert.equal(snapshot.inventory.profiles.hasMore, true);
    const sessionsPage = await backend.inventoryPage("sessions", snapshot.inventory.sessions.nextCursor!, 100);
    const profilesPage = await backend.inventoryPage("profiles", snapshot.inventory.profiles.nextCursor!, 100);
    assert.deepEqual(sessionsPage.sessions.map((session) => session.id), ["session-100"]);
    assert.deepEqual(profilesPage.profiles.map((profile) => profile.id), ["profile-100"]);
  } finally {
    await backend.close();
    await fixture.close();
  }
});

test("session deletion uses Hermes bulk-delete with an explicit profile", async () => {
  const deletes: Array<{ method: string | undefined; path: string; body: string }> = [];
  const fixture = await startHermesFixture((request, response, url) => {
    if (url.pathname === "/api/status") return writeJson(response, { version: "0.18.2" });
    if (request.method === "POST" && url.pathname === "/api/sessions/bulk-delete") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        deletes.push({ method: request.method, path: url.pathname, body });
        writeJson(response, { ok: true, deleted: 2 });
      });
      return;
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/profiles/")) {
      response.writeHead(404);
      response.end();
      return;
    }
    return defaultFixtureRoute(request, response, url);
  });
  try {
    assert.equal((await fixture.backend.start()).state, "ready");
    await fixture.backend.deleteSessions("mamoswine", ["first-session", "missing-session"]);
    await assert.rejects(
      fixture.backend.deleteProfile("missing-profile"),
      (error: unknown) => error instanceof HermesProfileError && error.code === "not_found",
    );
    assert.deepEqual(deletes, [{
      method: "POST",
      path: "/api/sessions/bulk-delete",
      body: JSON.stringify({ ids: ["first-session", "missing-session"], profile: "mamoswine" }),
    }]);
  } finally {
    await fixture.backend.close();
    await fixture.close();
  }
});

test("session deletion rejects an invalid Hermes bulk acknowledgement", async () => {
  const fixture = await startHermesFixture((request, response, url) => {
    if (url.pathname === "/api/status") return writeJson(response, { version: "0.18.2" });
    if (request.method === "POST" && url.pathname === "/api/sessions/bulk-delete") {
      request.resume();
      request.on("end", () => writeJson(response, { ok: true, deleted: "one" }));
      return;
    }
    return defaultFixtureRoute(request, response, url);
  });
  try {
    assert.equal((await fixture.backend.start()).state, "ready");
    await assert.rejects(
      fixture.backend.deleteSession("default", "incomplete-session"),
      /did not confirm durable session deletion/,
    );
  } finally {
    await fixture.backend.close();
    await fixture.close();
  }
});

test("snapshot is read-only and preserves durable delegated and marker-like conversations", async () => {
  const mutations: string[] = [];
  const rows = [
    { ...sessionRow(0), id: "ordinary-session" },
    { ...sessionRow(1), id: "terminal-title", title: "Kanban Task Transition Recorded" },
    { ...sessionRow(2), id: "terminal-preview", title: "Worker completion", preview: "Kanban terminal transition recorded; this worker run is finished." },
    { ...sessionRow(3), id: "terminal-delegated", title: "Untitled session", conversation_kind: "delegated", delegation_task_id: "t_0123abcd" },
  ];
  const fixture = await startHermesFixture((request, response, url) => {
    if (url.pathname === "/api/profiles") return writeJson(response, { profiles: [profileRow(0)] });
    if (url.pathname === "/api/profiles/sessions") return writeJson(response, { sessions: rows, total: rows.length, errors: [] });
    if (url.pathname === "/api/plugins/kanban/board") return writeJson(response, { columns: [{ name: "done", tasks: [{ id: "t_0123abcd" }] }], latest_event_id: 0 });
    if (request.method !== "GET") {
      mutations.push(`${request.method ?? "UNKNOWN"} ${url.pathname}`);
      return writeJson(response, { ok: false });
    }
    return defaultFixtureRoute(request, response, url);
  });
  try {
    assert.equal((await fixture.backend.start()).state, "ready");
    const snapshot = await fixture.backend.snapshot();
    assert.deepEqual(snapshot.sessions.map((session) => session.id), rows.map((session) => session.id));
    assert.equal(snapshot.inventory.sessions.total, rows.length);
    assert.equal(snapshot.sessions.at(-1)?.conversationKind, "delegated");
    assert.deepEqual(mutations, []);
  } finally {
    await fixture.backend.close();
    await fixture.close();
  }
});

test("concurrent snapshots share one inventory collection and both cursors remain usable", async () => {
  const rows = Array.from({ length: 101 }, (_, index) => sessionRow(index));
  let profileRequests = 0;
  let sessionRequests = 0;
  let boardRequests = 0;
  const fixture = await startHermesFixture((request, response, url) => {
    if (url.pathname === "/api/profiles") {
      profileRequests += 1;
      setTimeout(() => writeJson(response, { profiles: [profileRow(0)] }), 20);
      return;
    }
    if (url.pathname === "/api/profiles/sessions") {
      sessionRequests += 1;
      const offset = Number(url.searchParams.get("offset") ?? 0);
      setTimeout(() => writeJson(response, { sessions: rows.slice(offset, offset + 100), total: rows.length, errors: [] }), 20);
      return;
    }
    if (url.pathname === "/api/plugins/kanban/board") {
      boardRequests += 1;
      setTimeout(() => writeJson(response, { columns: [], latest_event_id: 0 }), 60);
      return;
    }
    return defaultFixtureRoute(request, response, url);
  });
  try {
    assert.equal((await fixture.backend.start()).state, "ready");
    const [first, second] = await Promise.all([fixture.backend.snapshot(), fixture.backend.snapshot()]);
    assert.equal(profileRequests, 1);
    assert.equal(sessionRequests, 2);
    assert.equal(boardRequests, 1);
    assert.equal(first.inventory.sessions.nextCursor, second.inventory.sessions.nextCursor);
    assert.deepEqual((await fixture.backend.inventoryPage("sessions", first.inventory.sessions.nextCursor!, 100)).sessions.map((item) => item.id), ["session-100"]);
    assert.deepEqual((await fixture.backend.inventoryPage("sessions", second.inventory.sessions.nextCursor!, 100)).sessions.map((item) => item.id), ["session-100"]);
  } finally {
    await fixture.backend.close();
    await fixture.close();
  }
});

test("inventory preserves first-seen order, removes overlapping page duplicates, and reports the missing row", async () => {
  const first = Array.from({ length: 100 }, (_, index) => sessionRow(index));
  const offsets: number[] = [];
  const fixture = await startHermesFixture((request, response, url) => {
    if (url.pathname === "/api/profiles") return writeJson(response, { profiles: [profileRow(0)] });
    if (url.pathname === "/api/profiles/sessions") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      offsets.push(offset);
      const sessions = offset === 0 ? first : [sessionRow(99), sessionRow(100)];
      return writeJson(response, { sessions, total: 102, limit: 100, offset, errors: [] });
    }
    return defaultFixtureRoute(request, response, url);
  });
  try {
    assert.equal((await fixture.backend.start()).state, "ready");
    const snapshot = await fixture.backend.snapshot();
    const page = await fixture.backend.inventoryPage("sessions", snapshot.inventory.sessions.nextCursor!, 100);
    assert.deepEqual(offsets, [0, 100]);
    assert.deepEqual([...snapshot.sessions, ...page.sessions].map((session) => session.id), Array.from({ length: 101 }, (_, index) => `session-${index}`));
    assert.equal(page.pagination.available, 101);
    assert.equal(page.pagination.total, 102);
    assert.equal(page.pagination.truncated, true);
    assert.equal(page.pagination.partialFailures, 1);
  } finally {
    await fixture.backend.close();
    await fixture.close();
  }
});

test("an upstream failure after the first page retains a clearly truncated usable inventory", async () => {
  const offsets: number[] = [];
  const fixture = await startHermesFixture((request, response, url) => {
    if (url.pathname === "/api/profiles") return writeJson(response, { profiles: [profileRow(0)] });
    if (url.pathname === "/api/profiles/sessions") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      offsets.push(offset);
      if (offset > 0) { response.writeHead(500); response.end(); return; }
      return writeJson(response, { sessions: Array.from({ length: 100 }, (_, index) => sessionRow(index)), total: 101, limit: 100, offset, errors: [] });
    }
    return defaultFixtureRoute(request, response, url);
  });
  try {
    assert.equal((await fixture.backend.start()).state, "ready");
    const snapshot = await fixture.backend.snapshot();
    assert.deepEqual(offsets, [0, 100]);
    assert.equal(snapshot.sessions.length, 100);
    assert.equal(snapshot.inventory.sessions.hasMore, false);
    assert.equal(snapshot.inventory.sessions.truncated, true);
    assert.equal(snapshot.inventory.sessions.partialFailures, 1);
  } finally {
    await fixture.backend.close();
    await fixture.close();
  }
});

test("profile failures, recovery, and authoritative empty inventory remain distinguishable", async () => {
  let mode: "healthy" | "500" | "timeout" | "invalid" | "empty" = "healthy";
  const fixture = await startHermesFixture((request, response, url) => {
    if (url.pathname === "/api/profiles") {
      if (mode === "500") { response.writeHead(500); response.end(); return; }
      if (mode === "timeout") return;
      if (mode === "invalid") return writeJson(response, { profiles: { invalid: true } });
      return writeJson(response, { profiles: mode === "empty" ? [] : [profileRow(0)] });
    }
    if (url.pathname === "/api/profiles/sessions") {
      return writeJson(response, { sessions: mode === "empty" ? [] : [sessionRow(0)], total: mode === "empty" ? 0 : 1, errors: [] });
    }
    return defaultFixtureRoute(request, response, url);
  }, 500);
  try {
    assert.equal((await fixture.backend.start()).state, "ready");
    assert.deepEqual((await fixture.backend.snapshot()).profiles.map((profile) => profile.id), ["profile-0"]);
    for (const failure of ["500", "timeout", "invalid"] as const) {
      mode = failure;
      const degraded = await fixture.backend.snapshot();
      assert.deepEqual(degraded.profiles, []);
      assert.equal(degraded.inventory.profiles.truncated, true);
      assert.equal(degraded.inventory.profiles.partialFailures, 1);
      assert.equal(degraded.inventory.profiles.available, 0);
      assert.equal(degraded.inventory.profiles.total, undefined);
      assert.equal(degraded.capabilities.runtime.state, "ready");
    }
    mode = "healthy";
    assert.deepEqual((await fixture.backend.snapshot()).profiles.map((profile) => profile.id), ["profile-0"]);
    mode = "empty";
    const empty = await fixture.backend.snapshot();
    assert.deepEqual(empty.profiles, []);
    assert.deepEqual(empty.sessions, []);
    assert.equal(empty.inventory.profiles.truncated, false);
    assert.equal(empty.inventory.profiles.partialFailures, 0);
    assert.equal(empty.inventory.profiles.total, 0);
  } finally {
    await fixture.backend.close();
    await fixture.close();
  }
});

test("session failures preserve a partial contract independently from healthy profiles", async () => {
  let mode: "healthy" | "500" | "timeout" | "invalid" | "empty" = "healthy";
  const fixture = await startHermesFixture((request, response, url) => {
    if (url.pathname === "/api/profiles") return writeJson(response, { profiles: [profileRow(0)] });
    if (url.pathname === "/api/profiles/sessions") {
      if (mode === "500") { response.writeHead(500); response.end(); return; }
      if (mode === "timeout") return;
      if (mode === "invalid") return writeJson(response, { sessions: { invalid: true }, total: 1, errors: [] });
      return writeJson(response, { sessions: mode === "empty" ? [] : [sessionRow(0)], total: mode === "empty" ? 0 : 1, errors: [] });
    }
    return defaultFixtureRoute(request, response, url);
  }, 500);
  try {
    assert.equal((await fixture.backend.start()).state, "ready");
    assert.deepEqual((await fixture.backend.snapshot()).sessions.map((session) => session.id), ["session-0"]);
    for (const failure of ["500", "timeout", "invalid"] as const) {
      mode = failure;
      const degraded = await fixture.backend.snapshot();
      assert.deepEqual(degraded.profiles.map((profile) => profile.id), ["profile-0"]);
      assert.deepEqual(degraded.sessions, []);
      assert.equal(degraded.inventory.sessions.truncated, true);
      assert.equal(degraded.inventory.sessions.partialFailures, 1);
      assert.equal(degraded.inventory.sessions.available, 0);
    }
    mode = "healthy";
    assert.deepEqual((await fixture.backend.snapshot()).sessions.map((session) => session.id), ["session-0"]);
    mode = "empty";
    const empty = await fixture.backend.snapshot();
    assert.deepEqual(empty.sessions, []);
    assert.equal(empty.inventory.sessions.truncated, false);
    assert.equal(empty.inventory.sessions.partialFailures, 0);
    assert.equal(empty.inventory.sessions.total, 0);
  } finally {
    await fixture.backend.close();
    await fixture.close();
  }
});

test("out-of-range session timestamps degrade only session inventory and recover without becoming authoritative empty", async () => {
  let mode: "healthy" | "malformed" | "empty" = "healthy";
  const fixture = await startHermesFixture((request, response, url) => {
    if (url.pathname === "/api/profiles") return writeJson(response, { profiles: mode === "empty" ? [] : [profileRow(0)] });
    if (url.pathname === "/api/profiles/sessions") {
      const rows = mode === "empty" ? [] : mode === "malformed" ? [{ ...sessionRow(0), started_at: 1e20, last_active: -1 }] : [sessionRow(0)];
      return writeJson(response, { sessions: rows, total: rows.length, errors: [] });
    }
    return defaultFixtureRoute(request, response, url);
  });
  try {
    assert.equal((await fixture.backend.start()).state, "ready");
    assert.deepEqual((await fixture.backend.snapshot()).sessions.map((session) => session.id), ["session-0"]);
    mode = "malformed";
    const degraded = await fixture.backend.snapshot();
    assert.deepEqual(degraded.profiles.map((profile) => profile.id), ["profile-0"]);
    assert.deepEqual(degraded.sessions, []);
    assert.equal(degraded.inventory.profiles.partialFailures, 0);
    assert.equal(degraded.inventory.sessions.total, 1);
    assert.equal(degraded.inventory.sessions.truncated, true);
    assert.equal(degraded.inventory.sessions.partialFailures, 1);
    assert.equal(degraded.capabilities.runtime.state, "ready");
    mode = "healthy";
    assert.deepEqual((await fixture.backend.snapshot()).sessions.map((session) => session.id), ["session-0"]);
    mode = "empty";
    const empty = await fixture.backend.snapshot();
    assert.deepEqual(empty.profiles, []);
    assert.deepEqual(empty.sessions, []);
    assert.equal(empty.inventory.profiles.truncated, false);
    assert.equal(empty.inventory.sessions.truncated, false);
    assert.equal(empty.inventory.profiles.total, 0);
    assert.equal(empty.inventory.sessions.total, 0);
  } finally {
    await fixture.backend.close();
    await fixture.close();
  }
});

for (const scenario of ["404", "500", "timeout", "mapping"] as const) {
  test(`a Kanban ${scenario} failure preserves healthy profile and session inventory`, async () => {
    let boardRequests = 0;
    const fixture = await startHermesFixture((request, response, url) => {
      if (url.pathname === "/api/profiles") return writeJson(response, { profiles: [profileRow(0)] });
      if (url.pathname === "/api/profiles/sessions") {
        return writeJson(response, { sessions: [sessionRow(0)], total: 1, limit: 100, offset: 0, errors: [] });
      }
      if (url.pathname === "/api/plugins/kanban/board") {
        boardRequests += 1;
        if (scenario === "404" || scenario === "500") {
          response.writeHead(Number(scenario));
          response.end();
        } else if (scenario === "mapping") {
          writeJson(response, { columns: [{ tasks: { invalid: true } }], latest_event_id: 1 });
        }
        return;
      }
      return defaultFixtureRoute(request, response, url);
    });
    try {
      assert.equal((await fixture.backend.start()).state, "ready");
      const snapshots = await Promise.all([fixture.backend.snapshot(), fixture.backend.snapshot()]);
      assert.equal(boardRequests, 1, "concurrent snapshots retain single-flight collection on board failure");
      for (const snapshot of snapshots) {
        assert.equal(snapshot.capabilities.runtime.state, "ready");
        assert.deepEqual(snapshot.profiles.map((profile) => profile.id), ["profile-0"]);
        assert.deepEqual(snapshot.sessions.map((session) => session.id), ["session-0"]);
        assert.equal(snapshot.inventory.profiles.partialFailures, 0);
        assert.equal(snapshot.inventory.sessions.partialFailures, 0);
        assert.deepEqual(snapshot.boards, [{ id: "hermes-kanban", name: "Hermes Kanban", cardCount: 0, revision: 0 }]);
      }
    } finally {
      await fixture.backend.close();
      await fixture.close();
    }
  });
}

test("an explicitly missing status route remains incompatible", async () => {
  const fixture = await startHermesFixture((_request, response, url) => {
    if (url.pathname === "/api/status") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "route not found" }));
      return;
    }
    return defaultFixtureRoute(_request, response, url);
  });
  try {
    assert.equal((await fixture.backend.start()).state, "incompatible");
    const snapshot = await fixture.backend.snapshot();
    assert.equal(snapshot.capabilities.runtime.state, "incompatible");
    assert.deepEqual(snapshot.profiles, []);
    assert.deepEqual(snapshot.sessions, []);
    assert.equal(snapshot.inventory.profiles.truncated, true);
    assert.equal(snapshot.inventory.profiles.partialFailures, 1);
    assert.equal(snapshot.inventory.sessions.truncated, true);
    assert.equal(snapshot.inventory.sessions.partialFailures, 1);
  } finally {
    await fixture.backend.close();
    await fixture.close();
  }
});

test("managed backend drains output beyond pipe capacity after readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-backend-"));
  const executable = join(directory, "fake-hermes.mjs");
  const donePath = join(directory, "output-drained.done");
  await writeFile(executable, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
if (process.argv.includes("--version")) {
  process.stdout.write("Hermes Agent v0.18.2\\n");
  process.exit(0);
}
const server = createServer((request, response) => {
  if (request.url === "/api/status") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ version: "0.18.2" }));
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  process.stdout.write("HERMES_DASHBOARD_READY port=" + address.port + "\\n");
  const flood = async (stream) => {
    const chunk = "x".repeat(16 * 1024);
    for (let written = 0; written < 2 * 1024 * 1024; written += chunk.length) {
      if (!stream.write(chunk)) await new Promise((resolve) => stream.once("drain", resolve));
    }
  };
  await flood(process.stdout);
  await flood(process.stderr);
  writeFileSync(${JSON.stringify(donePath)}, "done");
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
`, "utf8");
  await chmod(executable, 0o755);

  const backend = new HermesBackend({
    executable,
    startTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    globalSettingsPath: join(directory, "global-settings.json"),
  });
  try {
    assert.equal((await backend.start()).state, "ready");
    await waitForFile(donePath, 3_000);
  } finally {
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const transientStatus of [408, 425, 429]) {
  test(`initial managed start retries a transient ${transientStatus} status probe and succeeds`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "hermes-studio-initial-transient-"));
    const executable = join(directory, "fake-hermes.mjs");
    const countPath = join(directory, "serve-count.txt");
    const crashPath = join(directory, "unused-crash");
    await writeManagedRecoveryFixture(executable, countPath, crashPath, false, 1, transientStatus);
    const backend = new HermesBackend({
      executable, startTimeoutMs: 2_000, requestTimeoutMs: 500,
      globalSettingsPath: join(directory, "global-settings.json"),
    });
    try {
      assert.equal((await backend.start()).state, "ready");
      assert.equal((await readFile(countPath, "utf8")).trim(), "2", "the transient first child is replaced exactly once");
    } finally {
      await backend.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("initial managed CLI probe failure starts background recovery instead of staying incompatible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-initial-cli-recovery-"));
  const executable = join(directory, "fake-hermes.mjs");
  const probePath = join(directory, "probe-count.txt");
  const servePath = join(directory, "serve-count.txt");
  await writeFile(executable, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
if (process.argv.includes("--version")) {
  const current = existsSync(${JSON.stringify(probePath)}) ? Number(readFileSync(${JSON.stringify(probePath)}, "utf8")) : 0;
  writeFileSync(${JSON.stringify(probePath)}, String(current + 1));
  process.exit(1);
}
const current = existsSync(${JSON.stringify(servePath)}) ? Number(readFileSync(${JSON.stringify(servePath)}, "utf8")) : 0;
writeFileSync(${JSON.stringify(servePath)}, String(current + 1));
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/api/status") response.end(JSON.stringify({ version: "0.19.0" }));
  else if (request.url === "/api/profiles") response.end(JSON.stringify({ profiles: [{ name: "recovered" }] }));
  else if (request.url?.startsWith("/api/profiles/sessions")) response.end(JSON.stringify({ sessions: [], total: 0, errors: [] }));
  else if (request.url === "/api/plugins/kanban/board") response.end(JSON.stringify({ columns: [], latest_event_id: 0 }));
  else { response.statusCode = 404; response.end(); }
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write("HERMES_BACKEND_READY port=" + server.address().port + "\\n");
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`, "utf8");
  await chmod(executable, 0o755);
  const backend = new HermesBackend({
    executable,
    startTimeoutMs: 1_000,
    requestTimeoutMs: 500,
    managedRestartAttempts: 1,
    managedRestartBackoffMs: 10,
    globalSettingsPath: join(directory, "global-settings.json"),
  });
  try {
    assert.equal((await backend.start()).state, "unreachable");
    await waitForCondition(() => backend.status().state === "ready", 2_000);
    assert.equal((await readFile(probePath, "utf8")).trim(), "2");
    assert.equal((await readFile(servePath, "utf8")).trim(), "1");
    assert.deepEqual((await backend.snapshot()).profiles.map((profile) => profile.id), ["recovered"]);
  } finally {
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed backend invalidates a crashed generation, recovers once, and never respawns during shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-recovery-"));
  const executable = join(directory, "fake-hermes.mjs");
  const countPath = join(directory, "serve-count.txt");
  const crashPath = join(directory, "crash-first");
  await writeManagedRecoveryFixture(executable, countPath, crashPath, false);
  const backend = new HermesBackend({
    executable, startTimeoutMs: 2_000, requestTimeoutMs: 500,
    managedRestartAttempts: 2, managedRestartBackoffMs: 20,
    globalSettingsPath: join(directory, "global-settings.json"),
  });
  const states: string[] = [];
  backend.onStatusChange((status) => states.push(status.state));
  try {
    assert.equal(backend.settings(), backend.settings(), "HTTP requests share one mutation queue for this runtime");
    assert.equal((await backend.start()).state, "ready");
    assert.deepEqual((await backend.snapshot()).profiles.map((profile) => profile.id), ["generation-1"]);
    await writeFile(crashPath, "crash", "utf8");
    await waitForCondition(() => states.includes("unreachable"), 2_000);
    assert.throws(() => backend.chat(), /not ready/i, "the dead origin and token are not reusable while recovering");
    await waitForCondition(() => backend.status().state === "ready", 3_000);
    assert.deepEqual((await backend.snapshot()).profiles.map((profile) => profile.id), ["generation-2"]);
    assert.equal((await readFile(countPath, "utf8")).trim(), "2");
    const unreachable = states.indexOf("unreachable");
    const restarting = states.indexOf("starting", unreachable);
    assert.equal(restarting > unreachable, true);
    assert.equal(states.indexOf("ready", restarting) > restarting, true);
    await backend.close();
    const countAtClose = await readFile(countPath, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await readFile(countPath, "utf8"), countAtClose);
    assert.equal(backend.status().state, "stopped");
  } finally {
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed recovery retries a transient 503 status probe and reconnects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-recovery-transient-"));
  const executable = join(directory, "fake-hermes.mjs");
  const countPath = join(directory, "serve-count.txt");
  const crashPath = join(directory, "crash-first");
  await writeManagedRecoveryFixture(executable, countPath, crashPath, false, 2, 503);
  const backend = new HermesBackend({
    executable, startTimeoutMs: 2_000, requestTimeoutMs: 500,
    managedRestartAttempts: 2, managedRestartBackoffMs: 10,
    globalSettingsPath: join(directory, "global-settings.json"),
  });
  try {
    assert.equal((await backend.start()).state, "ready");
    await writeFile(crashPath, "crash", "utf8");
    await waitForCondition(async () => backend.status().state === "ready"
      && Number.parseInt((await readFile(countPath, "utf8")).trim(), 10) === 3, 4_000);
    assert.deepEqual((await backend.snapshot()).profiles.map((profile) => profile.id), ["generation-3"]);
  } finally {
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("initial start is single-flight and close prevents a delayed CLI probe from spawning Hermes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-start-close-"));
  const executable = join(directory, "fake-hermes.mjs");
  const probePath = join(directory, "probe-started");
  const servePath = join(directory, "serve-started");
  await writeFile(executable, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  writeFileSync(${JSON.stringify(probePath)}, "started");
  setTimeout(() => process.stdout.write("Hermes Agent v0.18.2\\n"), 300);
} else {
  writeFileSync(${JSON.stringify(servePath)}, "unexpected");
  setInterval(() => undefined, 1_000);
}
`, "utf8");
  await chmod(executable, 0o755);
  const backend = new HermesBackend({
    executable,
    startTimeoutMs: 1_000,
    globalSettingsPath: join(directory, "global-settings.json"),
  });
  try {
    const first = backend.start();
    const second = backend.start();
    assert.equal(first, second, "concurrent initial starts share one lifecycle flight");
    await waitForFile(probePath, 1_000);
    const closing = backend.close();
    await Promise.all([first, second, closing]);
    assert.equal(backend.status().state, "stopped");
    await assert.rejects(readFile(servePath), /ENOENT/, "shutdown observed after probe must fence the spawn boundary");
  } finally {
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an older managed snapshot cannot overwrite a recovered generation when completion order reverses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-snapshot-generation-"));
  const executable = join(directory, "fake-hermes.mjs");
  const countPath = join(directory, "serve-count.txt");
  const crashPath = join(directory, "crash-first");
  const requestPath = join(directory, "generation-1-requested");
  const releasePath = join(directory, "release-generation-1");
  const stopPath = join(directory, "stop-workers");
  await writeSnapshotGenerationFixture(executable, countPath, crashPath, requestPath, releasePath, stopPath);
  const backend = new HermesBackend({
    executable, startTimeoutMs: 2_000, requestTimeoutMs: 1_000,
    managedRestartAttempts: 2, managedRestartBackoffMs: 10,
    globalSettingsPath: join(directory, "global-settings.json"),
  });
  const states: string[] = [];
  backend.onStatusChange((status) => states.push(status.state));
  try {
    assert.equal((await backend.start()).state, "ready");
    const oldSnapshot = backend.snapshot();
    await waitForFile(requestPath, 2_000);
    await writeFile(crashPath, "crash", "utf8");
    await waitForCondition(() => states.includes("unreachable"), 2_000);
    await waitForCondition(() => backend.status().state === "ready" && states.includes("unreachable"), 3_000);
    const recovered = await backend.snapshot();
    assert.deepEqual(recovered.profiles.map((profile) => profile.id), ["generation-2"]);

    await writeFile(releasePath, "release", "utf8");
    const stale = await oldSnapshot;
    assert.deepEqual(stale.profiles, [], "the stale generation is returned as unavailable instead of becoming authoritative");
    assert.equal(backend.status().state, "ready");
    assert.deepEqual((await backend.snapshot()).profiles.map((profile) => profile.id), ["generation-2"]);
  } finally {
    await writeFile(stopPath, "stop", "utf8").catch(() => undefined);
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed recovery stops after its configured attempt bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-recovery-bound-"));
  const executable = join(directory, "fake-hermes.mjs");
  const countPath = join(directory, "serve-count.txt");
  const crashPath = join(directory, "crash-first");
  await writeManagedRecoveryFixture(executable, countPath, crashPath, true);
  const backend = new HermesBackend({
    executable, startTimeoutMs: 1_000, requestTimeoutMs: 500,
    managedRestartAttempts: 2, managedRestartBackoffMs: 10,
    globalSettingsPath: join(directory, "global-settings.json"),
  });
  try {
    assert.equal((await backend.start()).state, "ready");
    await writeFile(crashPath, "crash", "utf8");
    await waitForCondition(() => backend.status().state === "error", 4_000);
    assert.equal((await readFile(countPath, "utf8")).trim(), "3", "one initial child plus exactly two recovery attempts");
  } finally {
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await readFile(path); return; } catch { /* Not written yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForCondition(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for managed backend state.");
}

async function writeManagedRecoveryFixture(
  executable: string,
  countPath: string,
  crashPath: string,
  failRecovery: boolean,
  transientStatusGeneration?: number,
  transientStatus = 503,
): Promise<void> {
  await writeFile(executable, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
if (process.argv.includes("--version")) {
  process.stdout.write("Hermes Agent v0.18.2\\n");
  process.exit(0);
}
const countPath = ${JSON.stringify(countPath)};
const crashPath = ${JSON.stringify(crashPath)};
const generation = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 1;
writeFileSync(countPath, String(generation));
if (${JSON.stringify(failRecovery)} && generation > 1) process.exit(1);
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/api/status" && generation === ${JSON.stringify(transientStatusGeneration ?? null)}) {
    response.statusCode = ${JSON.stringify(transientStatus)};
    response.end(JSON.stringify({ error: "temporary status failure" }));
  }
  else if (request.url === "/api/status") response.end(JSON.stringify({ version: "0.18.2" }));
  else if (request.url === "/api/profiles") response.end(JSON.stringify({ profiles: [{ name: "generation-" + generation }] }));
  else if (request.url?.startsWith("/api/profiles/sessions")) response.end(JSON.stringify({ sessions: [], total: 0, errors: [] }));
  else if (request.url === "/api/plugins/kanban/board") response.end(JSON.stringify({ columns: [], latest_event_id: 0 }));
  else { response.statusCode = 404; response.end(); }
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write("HERMES_DASHBOARD_READY port=" + server.address().port + "\\n");
});
const watcher = setInterval(() => {
  if (generation === 1 && existsSync(crashPath)) server.close(() => process.exit(1));
}, 10);
process.on("SIGTERM", () => { clearInterval(watcher); server.close(() => process.exit(0)); });
`, "utf8");
  await chmod(executable, 0o755);
}

async function writeSnapshotGenerationFixture(
  executable: string,
  countPath: string,
  crashPath: string,
  requestPath: string,
  releasePath: string,
  stopPath: string,
): Promise<void> {
  await writeFile(executable, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
if (process.argv.includes("--version")) {
  process.stdout.write("Hermes Agent v0.18.2\\n");
} else if (process.argv[2] === "worker") {
  const generation = Number(process.argv[3]);
  const portPath = process.argv[4];
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/status") response.end(JSON.stringify({ version: "0.18.2" }));
    else if (request.url === "/api/profiles") {
      if (generation !== 1 || existsSync(${JSON.stringify(releasePath)})) {
        response.end(JSON.stringify({ profiles: [{ name: "generation-" + generation }] }));
      } else {
        writeFileSync(${JSON.stringify(requestPath)}, "requested");
        const release = setInterval(() => {
          if (!existsSync(${JSON.stringify(releasePath)})) return;
          clearInterval(release);
          response.end(JSON.stringify({ profiles: [{ name: "generation-1" }] }));
        }, 5);
      }
    } else if (request.url?.startsWith("/api/profiles/sessions")) response.end(JSON.stringify({ sessions: [], total: 0, errors: [] }));
    else if (request.url === "/api/plugins/kanban/board") response.end(JSON.stringify({ columns: [], latest_event_id: generation }));
    else { response.statusCode = 404; response.end(); }
  });
  server.listen(0, "127.0.0.1", () => writeFileSync(portPath, String(server.address().port)));
  const stop = setInterval(() => {
    if (existsSync(${JSON.stringify(stopPath)})) process.exit(0);
  }, 10);
  process.on("SIGTERM", () => { clearInterval(stop); process.exit(0); });
} else {
  const generation = existsSync(${JSON.stringify(countPath)}) ? Number(readFileSync(${JSON.stringify(countPath)}, "utf8")) + 1 : 1;
  writeFileSync(${JSON.stringify(countPath)}, String(generation));
  const portPath = ${JSON.stringify(join(countPath, ".."))} + "/worker-port-" + generation;
  const worker = spawn(process.execPath, [process.argv[1], "worker", String(generation), portPath], { stdio: "ignore" });
  const ready = setInterval(() => {
    if (!existsSync(portPath)) return;
    clearInterval(ready);
    process.stdout.write("HERMES_DASHBOARD_READY port=" + readFileSync(portPath, "utf8") + "\\n");
  }, 5);
  const crash = setInterval(() => {
    if (generation === 1 && existsSync(${JSON.stringify(crashPath)})) process.exit(1);
  }, 5);
  process.on("SIGTERM", () => {
    clearInterval(ready); clearInterval(crash);
    if (worker.exitCode !== null || worker.signalCode !== null) process.exit(0);
    worker.once("exit", () => process.exit(0));
    if (!worker.kill("SIGTERM")) process.exit(0);
  });
}
`, "utf8");
  await chmod(executable, 0o755);
}

async function startHermesFixture(handler: (request: IncomingMessage, response: ServerResponse, url: URL) => void, requestTimeoutMs = 2_000): Promise<{ backend: HermesBackend; close(): Promise<void> }> {
  const server = createServer((request, response) => handler(request, response, new URL(request.url ?? "/", "http://fixture.local")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    backend: new HermesBackend({
      baseUrl: `http://127.0.0.1:${address.port}`,
      sessionToken: "fixture-session-token-0123456789", // gitleaks:allow -- synthetic test credential
      requestTimeoutMs,
      resolveProfileBackend: async () => ({
        baseUrl: `http://127.0.0.1:${address.port}`,
        sessionToken: "fixture-profile-token-0123456789", // gitleaks:allow -- synthetic test credential
        release: () => undefined,
      }),
    }),
    close: async () => await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function defaultFixtureRoute(_request: IncomingMessage, response: ServerResponse, url: URL): void {
  if (url.pathname === "/api/status") { writeJson(response, { version: "0.18.2" }); return; }
  if (url.pathname === "/api/plugins/kanban/board") { writeJson(response, { columns: [], latest_event_id: 0 }); return; }
  response.writeHead(404);
  response.end();
}

function profileRow(index: number): Record<string, unknown> {
  return { name: `profile-${index}`, gateway_running: false, skill_count: index };
}

function sessionRow(index: number): Record<string, unknown> {
  return { id: `session-${index}`, profile: "profile-0", title: `Session ${index}`, is_active: false, started_at: 1_700_000_000 - index, last_active: 1_700_000_000 - index };
}

function writeJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
