import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HermesProfileBackendPool } from "./hermes-profile-pool.js";

test("parallel profile starts never exceed the configured process slots", async () => {
  const fixture = await createFixture();
  const allowed = new Set(["one", "two", "three", "four", "five"]);
  const pool = new HermesProfileBackendPool({
    executable: fixture.executable,
    cwd: fixture.directory,
    maxBackends: 2,
    startTimeoutMs: 2_000,
    isKnownProfile: async (profile) => allowed.has(profile),
  });
  try {
    let activeLeases = 0;
    let maxActiveLeases = 0;
    await Promise.all([...allowed].map(async (profile) => {
      const lease = await pool.resolve(profile);
      activeLeases += 1;
      maxActiveLeases = Math.max(maxActiveLeases, activeLeases);
      try { await delay(50); }
      finally { activeLeases -= 1; lease.release(); }
    }));
    assert.ok(maxActiveLeases <= 2);
    const files = await readdir(fixture.directory);
    assert.equal(files.filter((file) => file.endsWith(".pid")).length, 2);
    const observed = await Promise.all(
      files.filter((file) => file.endsWith(".observed"))
        .map(async (file) => Number(await readFile(join(fixture.directory, file), "utf8"))),
    );
    assert.ok(Math.max(...observed) <= 2);

    await assert.rejects(pool.resolve("unknown"), /does not exist/);
    assert.equal((await readdir(fixture.directory)).includes("unknown.pid"), false);
  } finally {
    await pool.close();
    await fixture.close();
  }
});

test("failed and timed-out starts always release their process slot", async () => {
  const fixture = await createFixture();
  const pool = new HermesProfileBackendPool({
    executable: fixture.executable,
    cwd: fixture.directory,
    maxBackends: 1,
    startTimeoutMs: 1_000,
    isKnownProfile: async () => true,
  });
  try {
    await assert.rejects(pool.resolve("fail"), /exited before readiness/);
    await assert.rejects(pool.resolve("stall"), /startup timed out/);
    const lease = await pool.resolve("one");
    lease.release();
    const files = await readdir(fixture.directory);
    assert.deepEqual(files.filter((file) => file.endsWith(".pid")), ["one.pid"]);
  } finally {
    await pool.close();
    await fixture.close();
  }
});

test("profile output is drained after readiness without retaining it", async () => {
  const fixture = await createFixture();
  const pool = new HermesProfileBackendPool({
    executable: fixture.executable,
    cwd: fixture.directory,
    maxBackends: 1,
    startTimeoutMs: 2_000,
    isKnownProfile: async (profile) => profile === "drain-output",
  });
  try {
    const lease = await pool.resolve("drain-output");
    await waitForFile(join(fixture.directory, "drain-output.done"), 3_000);
    lease.release();
  } finally {
    await pool.close();
    await fixture.close();
  }
});

test("reusing a live profile backend does not repeat global profile validation", async () => {
  const fixture = await createFixture();
  let knownProfileChecks = 0;
  const pool = new HermesProfileBackendPool({
    executable: fixture.executable,
    cwd: fixture.directory,
    maxBackends: 1,
    startTimeoutMs: 2_000,
    isKnownProfile: async () => {
      knownProfileChecks += 1;
      return true;
    },
  });
  try {
    const first = await pool.resolve("one");
    first.release();
    const second = await pool.resolve("one");
    second.release();
    assert.equal(knownProfileChecks, 1);
  } finally {
    await pool.close();
    await fixture.close();
  }
});

test("an active lease is never evicted to serve another profile", async () => {
  const fixture = await createFixture();
  const pool = new HermesProfileBackendPool({
    executable: fixture.executable,
    cwd: fixture.directory,
    maxBackends: 1,
    startTimeoutMs: 2_000,
    isKnownProfile: async () => true,
  });
  try {
    const first = await pool.resolve("one");
    const firstAgain = await pool.resolve("one");
    const secondPending = pool.resolve("two");
    await delay(100);
    const whileLeased = await readdir(fixture.directory);
    assert.equal(whileLeased.includes("one.pid"), true);
    assert.equal(whileLeased.includes("two.pid"), false);

    first.release();
    await delay(100);
    const oneLeaseRemaining = await readdir(fixture.directory);
    assert.equal(oneLeaseRemaining.includes("one.pid"), true);
    assert.equal(oneLeaseRemaining.includes("two.pid"), false);
    firstAgain.release();
    const second = await secondPending;
    const afterRelease = await readdir(fixture.directory);
    assert.equal(afterRelease.includes("one.pid"), false);
    assert.equal(afterRelease.includes("two.pid"), true);
    second.release();
  } finally {
    await pool.close();
    await fixture.close();
  }
});

test("capacity timeout does not consume a slot and recovers after release", async () => {
  const fixture = await createFixture();
  const pool = new HermesProfileBackendPool({
    executable: fixture.executable,
    cwd: fixture.directory,
    maxBackends: 1,
    startTimeoutMs: 1_000,
    isKnownProfile: async () => true,
  });
  try {
    const first = await pool.resolve("one");
    await assert.rejects(
      pool.resolve("two"),
      (error: unknown) => error instanceof Error && error.message.includes("capacity is busy"),
    );
    assert.equal((await readdir(fixture.directory)).includes("one.pid"), true);
    first.release();
    const second = await pool.resolve("two");
    second.release();
  } finally {
    await pool.close();
    await fixture.close();
  }
});

test("an expired capacity waiter never starts a profile after capacity is released", async () => {
  const fixture = await createFixture();
  const pool = new HermesProfileBackendPool({
    executable: fixture.executable,
    cwd: fixture.directory,
    maxBackends: 1,
    startTimeoutMs: 2_000,
    isKnownProfile: async () => true,
  });
  try {
    const first = await pool.resolve("one");
    await assert.rejects(
      pool.resolve("expired", { deadlineMs: Date.now() + 50 }),
      /acquisition timed out/,
    );
    first.release();
    await delay(100);
    assert.equal((await readdir(fixture.directory)).includes("expired.pid"), false);

    const next = await pool.resolve("two");
    next.release();
  } finally {
    await pool.close();
    await fixture.close();
  }
});

test("close wakes capacity waiters and stops leased processes", async () => {
  const fixture = await createFixture();
  const pool = new HermesProfileBackendPool({
    executable: fixture.executable,
    cwd: fixture.directory,
    maxBackends: 1,
    startTimeoutMs: 2_000,
    isKnownProfile: async () => true,
  });
  try {
    const first = await pool.resolve("one");
    const pending = pool.resolve("two");
    const pendingRejection = assert.rejects(pending, /closed/);
    await delay(100);
    await pool.close();
    await pendingRejection;
    first.release();
    assert.equal((await readdir(fixture.directory)).some((file) => file.endsWith(".pid")), false);
  } finally {
    await pool.close();
    await fixture.close();
  }
});

async function createFixture(): Promise<{
  directory: string;
  executable: string;
  close(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-profile-pool-"));
  const executable = join(directory, "fake-hermes.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const index = process.argv.indexOf("--profile");
const profile = process.argv[index + 1];
const directory = process.cwd();
const pidFile = join(directory, profile + ".pid");
writeFileSync(pidFile, String(process.pid));
const live = readdirSync(directory).filter((file) => file.endsWith(".pid")).length;
writeFileSync(join(directory, profile + ".observed"), String(live));
const stop = () => { try { rmSync(pidFile); } catch {} process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
if (profile === "fail") stop();
if (profile === "stall") {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
process.stdout.write("HERMES_DASHBOARD_READY port=12345\\n");
if (profile === "drain-output") {
  const flood = async (stream) => {
    const chunk = "x".repeat(16 * 1024);
    for (let written = 0; written < 2 * 1024 * 1024; written += chunk.length) {
      if (!stream.write(chunk)) await new Promise((resolve) => stream.once("drain", resolve));
    }
  };
  await flood(process.stdout);
  await flood(process.stderr);
  writeFileSync(join(directory, profile + ".done"), "done");
}
setInterval(() => {}, 1000);
`, "utf8");
  await chmod(executable, 0o755);
  return { directory, executable, close: async () => await rm(directory, { recursive: true, force: true }) };
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await readFile(path); return; } catch { /* Not written yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
