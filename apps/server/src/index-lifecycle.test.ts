import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("SIGTERM during initial managed startup cleans the partially-created Hermes child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-initial-signal-"));
  const executable = join(directory, "fake-hermes.mjs");
  const childPath = join(directory, "child-pid");
  const stoppedPath = join(directory, "child-stopped");
  await writeFile(executable, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
if (process.argv.includes("--version")) {
  process.stdout.write("Hermes Agent v0.18.2\\n");
} else {
  const server = createServer((request, response) => {
    if (request.url !== "/api/status") { response.statusCode = 404; response.end(); }
  });
  process.on("SIGTERM", () => {
    writeFileSync(${JSON.stringify(stoppedPath)}, "stopped");
    process.exit(0);
  });
  // Publish the PID only after the shutdown handler is installed so the test
  // cannot signal the parent during the fixture's own initialization window.
  writeFileSync(${JSON.stringify(childPath)}, String(process.pid));
  server.listen(0, "127.0.0.1", () => {
    process.stdout.write("HERMES_DASHBOARD_READY port=" + server.address().port + "\\n");
  });
}
`, "utf8");
  await chmod(executable, 0o755);

  const office = spawn(process.execPath, [join(import.meta.dirname, "index.js")], {
    env: {
      ...process.env,
      HERMES_STUDIO_HERMES_MODE: "managed",
      HERMES_STUDIO_HERMES_EXECUTABLE: executable,
      HERMES_STUDIO_PORT: "0",
      HERMES_STUDIO_DEVICE_REGISTRY_PATH: join(directory, "devices.json"),
    },
    stdio: "ignore",
  });
  try {
    await waitForFile(childPath, 2_000);
    assert.equal(office.kill("SIGTERM"), true);
    const result = await waitForExit(office, 3_000);
    assert.equal(result.signal, null);
    assert.equal(result.code, 0);
    assert.equal(await readFile(stoppedPath, "utf8"), "stopped");
  } finally {
    if (office.exitCode === null && office.signalCode === null) office.kill("SIGKILL");
    try {
      await readFile(stoppedPath, "utf8");
    } catch {
      try {
        const pid = Number(await readFile(childPath, "utf8"));
        if (Number.isSafeInteger(pid)) process.kill(pid, "SIGKILL");
      } catch { /* The managed child was never created or is already gone. */ }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop parent pipe EOF shuts down the owned server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-parent-pipe-"));
  const office = spawn(process.execPath, [join(import.meta.dirname, "index.js")], {
    env: {
      ...process.env,
      HERMES_STUDIO_HERMES_MODE: "demo",
      HERMES_STUDIO_PORT: "0",
      HERMES_STUDIO_DESKTOP_PARENT_PIPE: "true",
      HERMES_STUDIO_DEVICE_REGISTRY_PATH: join(directory, "devices.json"),
      HERMES_STUDIO_TEAMS_PATH: join(directory, "teams.json"),
    },
    stdio: ["pipe", "ignore", "ignore"],
  });
  try {
    assert.ok(office.stdin);
    office.stdin.end();
    const result = await waitForExit(office, 3_000);
    assert.equal(result.signal, null);
    assert.equal(result.code, 0);
  } finally {
    if (office.exitCode === null && office.signalCode === null) office.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await readFile(path); return; } catch { /* Initialization is still in progress. */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("Timed out waiting for Office to shut down."));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once("exit", onExit);
  });
}
