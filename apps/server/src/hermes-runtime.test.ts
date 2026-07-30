import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverHermesRuntime,
  isRecognizedHermesVersion,
  normalizeBaseUrl,
  probeHermesCli,
} from "./hermes-runtime.js";

test("ready status is validated and reduced to a secret-free DTO", async () => {
  const fixture = await statusServer({
    version: "0.18.2",
    release_date: "2026.7.7.2",
    config_version: 33,
    latest_config_version: 33,
    gateway_running: true,
    gateway_state: "running",
    active_sessions: 2,
    auth_required: true,
    auth_providers: ["nous"],
    access_token: "must-not-escape", // gitleaks:allow -- synthetic rejection fixture
    gateways: [{ port: 9119, secret: "must-not-escape" }], // gitleaks:allow -- synthetic rejection fixture
  });

  try {
    const result = await discoverHermesRuntime({ baseUrl: fixture.baseUrl, timeoutMs: 500 });
    assert.equal(result.state, "ready");
    assert.equal(result.runtime?.version, "0.18.2");
    assert.equal(result.runtime?.activeSessions, 2);
    assert.equal(result.cli.state, "not_configured");
    assert.equal(/token|secret|9119/.test(JSON.stringify(result)), false);
  } finally {
    await fixture.close();
  }
});

test("runtime display metadata is redacted before it reaches a public DTO", async () => {
  const secret = "dashboard-example-value-123456";
  const fixture = await statusServer({
    version: "0.18.2",
    release_date: `note: HERMES_DASHBOARD_SESSION_TOKEN=${secret}`,
    config_version: 1,
    latest_config_version: 1,
    gateway_running: true,
    gateway_state: `OPENAI_API_KEY=${secret}`,
    active_sessions: 1,
    auth_required: true,
    auth_providers: [`clientSecret=${secret}`],
  });
  try {
    const result = await discoverHermesRuntime({ baseUrl: fixture.baseUrl, timeoutMs: 500 });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes("[REDACTED]"), true);
  } finally {
    await fixture.close();
  }
});

test("reachable non-Hermes responses are incompatible", async () => {
  const fixture = await statusServer({ ok: true });
  try {
    const result = await discoverHermesRuntime({ baseUrl: fixture.baseUrl, timeoutMs: 500 });
    assert.equal(result.state, "incompatible");
    assert.equal(result.reason, "invalid_response");
  } finally {
    await fixture.close();
  }
});

test("Hermes API versions are not pinned to a specific release", async () => {
  const fixture = await statusServer({
    version: "0.19.0",
    release_date: "2026.8.1",
    config_version: 33,
    latest_config_version: 33,
    gateway_running: false,
    gateway_state: null,
    active_sessions: 0,
  });
  try {
    const result = await discoverHermesRuntime({ baseUrl: fixture.baseUrl, timeoutMs: 500 });
    assert.equal(result.state, "ready");
    assert.equal(result.reason, "ready");
    assert.equal(result.runtime?.version, "0.19.0");
  } finally {
    await fixture.close();
  }
});

test("malformed Hermes API versions still fail closed", async () => {
  const fixture = await statusServer({
    version: "development",
    release_date: "unknown",
    config_version: 33,
    latest_config_version: 33,
    gateway_running: false,
    gateway_state: null,
    active_sessions: 0,
  });
  try {
    const result = await discoverHermesRuntime({ baseUrl: fixture.baseUrl, timeoutMs: 500 });
    assert.equal(result.state, "incompatible");
    assert.equal(result.reason, "unsupported_version");
  } finally {
    await fixture.close();
  }
});

test("CLI invocation never passes executable text through a shell", async () => {
  const sentinel = join(tmpdir(), `hermes-studio-shell-${process.pid}-${Date.now()}`);
  const result = await probeHermesCli(`/missing/hermes;touch ${sentinel}`, 200);
  assert.equal(result.state, "unavailable");
  assert.equal(existsSync(sentinel), false);
});

test("CLI detection accepts a flushed version line before the helper exits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-cli-probe-"));
  const executable = join(directory, "fake-hermes.mjs");
  await writeFile(executable, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("Hermes Agent v0.19.0\\n");
  setInterval(() => undefined, 1_000);
}
`, "utf8");
  await chmod(executable, 0o755);
  try {
    const result = await probeHermesCli(executable, 200);
    assert.deepEqual(result, { state: "available", version: "0.19.0" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Hermes detection accepts any semantic version", () => {
  assert.equal(isRecognizedHermesVersion("0.18.0"), true);
  assert.equal(isRecognizedHermesVersion("0.18.99+local"), true);
  assert.equal(isRecognizedHermesVersion("0.17.9"), true);
  assert.equal(isRecognizedHermesVersion("0.19.0"), true);
  assert.equal(isRecognizedHermesVersion("1.0.0"), true);
  assert.equal(isRecognizedHermesVersion("not-a-version"), false);
});

test("base URL rejects credentials and non-origin paths", () => {
  assert.throws(() => normalizeBaseUrl("http://user:pass@127.0.0.1:9119"), /credentials/);
  assert.throws(() => normalizeBaseUrl("http://127.0.0.1:9119/dashboard"), /without a path/);
  assert.equal(normalizeBaseUrl("http://127.0.0.1:9119").origin, "http://127.0.0.1:9119");
});

async function statusServer(body: unknown): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}
