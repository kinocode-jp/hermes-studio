import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createOfficeServer } from "./server.js";

const LOCAL_ORIGIN = "http://localhost:4173";
const REMOTE_ORIGIN = "https://office.tailnet.example";
const REMOTE_TOKEN = "correct-horse-battery-staple-remote-token"; // gitleaks:allow -- synthetic enrollment fixture

async function deviceLogin(
  base: string,
  token: string,
  deviceName = "Travel phone",
): Promise<Response> {
  return await fetch(`${base}/api/v1/auth/device`, {
    method: "POST",
    headers: {
      Origin: REMOTE_ORIGIN,
      "Content-Type": "application/json",
      "X-Forwarded-Proto": "https",
      "X-Forwarded-For": "100.64.0.10",
    },
    body: JSON.stringify({ token, deviceName }),
  });
}

async function renewDevice(base: string, cookie: string, client = "100.64.0.10"): Promise<Response> {
  return await fetch(`${base}/api/v1/auth/device/renew`, {
    method: "POST",
    headers: { Origin: REMOTE_ORIGIN, Cookie: cookie, "X-Forwarded-Proto": "https", "X-Forwarded-For": client },
  });
}

function responseCookies(response: Response): string {
  const raw = response.headers.get("set-cookie") ?? "";
  return [...raw.matchAll(/(?:^|,\s*)(hermes_office_(?:device|session))=([^;,\s]+)/g)]
    .map((match) => `${match[1]}=${match[2]}`)
    .join("; ");
}

test("remote origins cannot claim local bootstrap even through a loopback proxy", async () => {
  const server = createOfficeServer({
    port: 0,
    allowedOrigins: [LOCAL_ORIGIN, REMOTE_ORIGIN],
  });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const remote = await fetch(`${base}/api/v1/auth/local`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN },
    });
    assert.equal(remote.status, 403);

    const proxiedSpoof = await fetch(`${base}/api/v1/auth/local`, {
      method: "POST",
      headers: {
        Origin: LOCAL_ORIGIN,
        Host: "office.tailnet.example",
        "X-Forwarded-For": "100.64.0.10",
      },
    });
    assert.equal(proxiedSpoof.status, 403);

    const local = await fetch(`${base}/api/v1/auth/local`, {
      method: "POST",
      headers: { Origin: LOCAL_ORIGIN },
    });
    assert.equal(local.status, 200);
  } finally {
    await server.close();
  }
});

test("README remote configuration retains actual-loopback owner device revocation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-readme-remote-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createOfficeServer({
    port: 0,
    allowedOrigins: [REMOTE_ORIGIN],
    remoteToken: REMOTE_TOKEN,
    trustedProxyHops: 1,
    deviceRegistryPath: join(directory, "devices.json"),
  });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const remoteLogin = await deviceLogin(base, REMOTE_TOKEN);
    assert.equal(remoteLogin.status, 200);
    const remoteSession = await remoteLogin.json() as { principal: { id: string } };
    const remoteCookies = responseCookies(remoteLogin);

    const localLogin = await fetch(`${base}/api/v1/auth/local`, {
      method: "POST",
      headers: { Origin: base },
    });
    assert.equal(localLogin.status, 200);
    const localSession = await localLogin.json() as { csrfToken: string };
    const localCookie = (localLogin.headers.get("set-cookie") ?? "").split(";", 1)[0]!;

    const devices = await fetch(`${base}/api/v1/devices`, {
      headers: { Origin: base, Cookie: localCookie },
    });
    assert.equal(devices.status, 200);
    assert.equal((await devices.text()).includes(remoteSession.principal.id), true);

    const revoke = await fetch(`${base}/api/v1/devices/${encodeURIComponent(remoteSession.principal.id)}/revoke`, {
      method: "POST",
      headers: { Origin: base, Cookie: localCookie, "X-CSRF-Token": localSession.csrfToken },
    });
    assert.equal(revoke.status, 200);
    assert.equal((await renewDevice(base, remoteCookies)).status, 401);

    assert.equal((await fetch(`${base}/api/v1/auth/local`, {
      method: "POST",
      headers: { Origin: LOCAL_ORIGIN },
    })).status, 403);
  } finally {
    await server.close();
  }
});

test("one-time enrollment creates a revocable remote operator device without exposing credentials", async () => {
  const server = createOfficeServer({
    port: 0,
    allowedOrigins: [LOCAL_ORIGIN, REMOTE_ORIGIN],
    remoteToken: REMOTE_TOKEN,
    trustedProxyHops: 1,
  });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const insecure = await fetch(`${base}/api/v1/auth/device`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ token: REMOTE_TOKEN, deviceName: "Plaintext phone" }),
    });
    assert.equal(insecure.status, 403);

    const login = await deviceLogin(base, REMOTE_TOKEN);
    assert.equal(login.status, 200);
    const loginText = await login.text();
    assert.equal(loginText.includes(REMOTE_TOKEN), false);
    const session = JSON.parse(loginText) as {
      csrfToken: string;
      principal: { id: string; local: boolean; deviceName: string; tier: string };
    };
    assert.deepEqual(session.principal, {
      id: session.principal.id,
      local: false,
      deviceName: "Travel phone",
      tier: "operator",
    });
    const setCookies = login.headers.getSetCookie?.()
      ?? (login.headers.get("set-cookie") ?? "").split(/,(?=\s*hermes_office_)/).map((part) => part.trim());
    assert.equal(setCookies.length, 2);
    assert.match(setCookies[0]!, /^hermes_office_session=/);
    assert.match(setCookies[1]!, /^hermes_office_device=/);
    for (const cookieHeader of setCookies) {
      assert.match(cookieHeader, /HttpOnly/i);
      assert.match(cookieHeader, /Secure/i);
      assert.match(cookieHeader, /SameSite=Strict/i);
    }
    assert.match(setCookies[0]!, /Path=\//);
    assert.match(setCookies[1]!, /Path=\/api\/v1\/auth\/device/);
    const cookie = responseCookies(login);
    assert.match(cookie, /hermes_office_session=/);
    assert.match(cookie, /hermes_office_device=/);

    const audit = await fetch(`${base}/api/v1/audit`, {
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie },
    });
    assert.equal(audit.status, 403);
    const snapshot = await fetch(`${base}/api/v1/snapshot`, {
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie },
    });
    assert.equal(snapshot.status, 200);
    const access = (await snapshot.json() as {
      capabilities: { access: { deviceId: string; tier: string; exposure: string; authentication: string; allowedOperations: string[] } };
    }).capabilities.access;
    assert.deepEqual({ deviceId: access.deviceId, tier: access.tier, exposure: access.exposure, authentication: access.authentication }, {
      deviceId: session.principal.id,
      tier: "operator",
      exposure: "tailnet",
      authentication: "device-cookie",
    });
    assert.equal(access.allowedOperations.includes("chat.session.create"), true);
    assert.equal(access.allowedOperations.includes("chat-model-preferences.update"), true);
    assert.equal(access.allowedOperations.includes("local-model-providers.sync"), true);
    assert.equal(access.allowedOperations.includes("global-settings.update"), false);

    assert.equal((await fetch(`${base}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie },
    })).status, 403);
    assert.equal((await fetch(`${base}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
      body: "{}",
    })).status, 413);
    assert.equal((await fetch(`${base}/api/v1/audit`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie },
    })).status, 405);

    const events = new WebSocket(`${base.replace("http:", "ws:")}/api/v1/events`, {
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie },
    });
    const remoteRuntime = waitForTopic(events, "runtime.status");
    await once(events, "open");
    await remoteRuntime;
    const operatorAuditLeak = expectNoTopic(events, "access.changed", 100);
    const localLogin = await fetch(`${base}/api/v1/auth/local`, { method: "POST", headers: { Origin: LOCAL_ORIGIN } });
    assert.equal(localLogin.status, 200);
    assert.equal(await operatorAuditLeak, true);

    const localCookie = (localLogin.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
    const ownerEvents = new WebSocket(`${base.replace("http:", "ws:")}/api/v1/events`, {
      headers: { Origin: LOCAL_ORIGIN, Cookie: localCookie },
    });
    const ownerRuntime = waitForTopic(ownerEvents, "runtime.status");
    await once(ownerEvents, "open");
    await ownerRuntime;
    const ownerAudit = waitForTopic(ownerEvents, "access.changed");
    assert.equal((await fetch(`${base}/api/v1/auth/local`, { method: "POST", headers: { Origin: LOCAL_ORIGIN } })).status, 200);
    await ownerAudit;
    ownerEvents.close();
    const closed = once(events, "close");

    const logout = await fetch(`${base}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie, "X-CSRF-Token": session.csrfToken },
    });
    assert.equal(logout.status, 200);
    const logoutCookies = logout.headers.get("set-cookie") ?? "";
    assert.match(logoutCookies, /hermes_office_session=;[^,]*Path=\/;[^,]*Max-Age=0/i);
    assert.match(logoutCookies, /hermes_office_device=;[^,]*Path=\/api\/v1\/auth\/device;[^,]*Max-Age=0/i);
    await closed;
    assert.equal((await fetch(`${base}/api/v1/audit`, { headers: { Origin: REMOTE_ORIGIN, Cookie: cookie } })).status, 401);
    assert.equal((await fetch(`${base}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie, "X-CSRF-Token": session.csrfToken },
    })).status, 401);

    const renewal = await renewDevice(base, cookie);
    assert.equal(renewal.status, 401);

    const nextLogin = await deviceLogin(base, REMOTE_TOKEN, "Owner phone");
    assert.equal(nextLogin.status, 409);
  } finally {
    await server.close();
  }
});

test("enrollment appends session cookie before durable device cookie so last-header retention can renew", async () => {
  const server = createOfficeServer({
    port: 0,
    allowedOrigins: [REMOTE_ORIGIN],
    remoteToken: REMOTE_TOKEN,
    trustedProxyHops: 1,
  });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const login = await deviceLogin(base, REMOTE_TOKEN);
    assert.equal(login.status, 200);
    const setCookies = login.headers.getSetCookie?.()
      ?? (login.headers.get("set-cookie") ?? "").split(/,(?=\s*hermes_office_)/).map((part) => part.trim());
    assert.equal(setCookies.length, 2);
    // First: short-lived session. Last: durable device credential.
    // Proxies/browsers that keep only the final Set-Cookie still retain renewability.
    assert.match(setCookies[0]!, /^hermes_office_session=/i);
    assert.match(setCookies[0]!, /Path=\//i);
    assert.match(setCookies[1]!, /^hermes_office_device=/i);
    assert.match(setCookies[1]!, /Path=\/api\/v1\/auth\/device/i);
    for (const header of setCookies) {
      assert.match(header, /HttpOnly/i);
      assert.match(header, /Secure/i);
      assert.match(header, /SameSite=Strict/i);
    }

    const deviceOnly = setCookies[1]!.split(";", 1)[0]!;
    assert.match(deviceOnly, /^hermes_office_device=/);
    const renewal = await renewDevice(base, deviceOnly);
    assert.equal(renewal.status, 200);
    const renewed = await renewal.json() as { csrfToken: string; principal: { local: boolean } };
    assert.equal(typeof renewed.csrfToken, "string");
    assert.equal(renewed.principal.local, false);
    assert.match(renewal.headers.get("set-cookie") ?? "", /hermes_office_session=/);

    const sessionCookie = responseCookies(renewal);
    const snapshot = await fetch(`${base}/api/v1/snapshot`, {
      headers: { Origin: REMOTE_ORIGIN, Cookie: sessionCookie },
    });
    assert.equal(snapshot.status, 200);
  } finally {
    await server.close();
  }
});

test("device renewal is session-aware, IP/device limited, and a limited burst does not rewrite the registry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-renew-limit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const deviceRegistryPath = join(directory, "devices.json");
  const server = createOfficeServer({
    port: 0,
    allowedOrigins: [REMOTE_ORIGIN],
    remoteToken: REMOTE_TOKEN,
    trustedProxyHops: 1,
    deviceRegistryPath,
  });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const login = await deviceLogin(base, REMOTE_TOKEN);
    assert.equal(login.status, 200);
    const cookies = responseCookies(login);
    const loginSession = await login.json() as { csrfToken: string; expiresAt: string };
    const registryBefore = await readFile(deviceRegistryPath, "utf8");

    const missingClient = await fetch(`${base}/api/v1/auth/device/renew`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookies, "X-Forwarded-Proto": "https" },
    });
    assert.equal(missingClient.status, 429);
    assert.equal(missingClient.headers.get("retry-after"), "60");

    const noOp = await renewDevice(base, cookies);
    assert.equal(noOp.status, 200);
    assert.equal(noOp.headers.get("set-cookie"), null);
    assert.deepEqual(await noOp.json(), loginSession);

    const sameIpBurst = await Promise.all(Array.from({ length: 7 }, () => renewDevice(base, cookies)));
    assert.equal(sameIpBurst.filter((response) => response.status === 200).length, 5);
    assert.equal(sameIpBurst.filter((response) => response.status === 429).length, 2);
    const otherIpBurst = await Promise.all(Array.from({ length: 5 }, (_, index) => renewDevice(base, cookies, `100.64.1.${index + 1}`)));
    assert.equal(otherIpBurst.filter((response) => response.status === 200).length, 2);
    assert.equal(otherIpBurst.filter((response) => response.status === 429).length, 3);
    for (const response of [...sameIpBurst, ...otherIpBurst]) {
      if (response.status === 429) assert.equal(response.headers.get("retry-after"), "60");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(await readFile(deviceRegistryPath, "utf8"), registryBefore);
  } finally { await server.close(); }
});

test("a debounced last-seen update is durable across an orderly restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-renew-durable-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const deviceRegistryPath = join(directory, "devices.json");
  const options = {
    port: 0,
    allowedOrigins: [REMOTE_ORIGIN],
    remoteToken: REMOTE_TOKEN,
    trustedProxyHops: 1,
    deviceRegistryPath,
  } as const;
  const enrolled = createOfficeServer(options);
  const enrolledAddress = await enrolled.listen();
  const login = await deviceLogin(`http://127.0.0.1:${enrolledAddress.port}`, REMOTE_TOKEN);
  assert.equal(login.status, 200);
  const deviceCookie = responseCookies(login).split("; ").find((cookie) => cookie.startsWith("hermes_office_device="))!;
  await enrolled.close();

  const oldLastSeen = "2000-01-01T00:00:00.000Z";
  const staleRegistry = JSON.parse(await readFile(deviceRegistryPath, "utf8")) as { devices: Array<Record<string, unknown>> };
  staleRegistry.devices[0]!.lastSeenAt = oldLastSeen;
  await writeFile(deviceRegistryPath, JSON.stringify(staleRegistry), { mode: 0o600 });
  const renewed = createOfficeServer(options);
  const renewedAddress = await renewed.listen();
  const renewedBase = `http://127.0.0.1:${renewedAddress.port}`;
  const renewal = await renewDevice(renewedBase, deviceCookie);
  assert.equal(renewal.status, 200);
  assert.match(renewal.headers.get("set-cookie") ?? "", /hermes_office_session=/);
  await renewed.close();

  const persisted = JSON.parse(await readFile(deviceRegistryPath, "utf8")) as { devices: Array<{ lastSeenAt?: string }> };
  assert.notEqual(persisted.devices[0]!.lastSeenAt, oldLastSeen);
  const restarted = createOfficeServer(options);
  const restartedAddress = await restarted.listen();
  const restartedBase = `http://127.0.0.1:${restartedAddress.port}`;
  try {
    const restartedRenewal = await renewDevice(restartedBase, deviceCookie);
    assert.equal(restartedRenewal.status, 200);
    const sessionCookie = responseCookies(restartedRenewal);
    const session = await restartedRenewal.json() as { csrfToken: string };
    assert.equal((await fetch(`${restartedBase}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, Cookie: `${deviceCookie}; ${sessionCookie}`, "X-CSRF-Token": session.csrfToken },
    })).status, 200);
  } finally { await restarted.close(); }

  const revokedRestart = createOfficeServer(options);
  const revokedRestartAddress = await revokedRestart.listen();
  try {
    assert.equal((await renewDevice(`http://127.0.0.1:${revokedRestartAddress.port}`, deviceCookie)).status, 401);
  } finally { await revokedRestart.close(); }
});

async function waitForTopic(websocket: WebSocket, topic: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`WebSocket topic ${topic} timed out.`)); }, 2_000);
    const onMessage = (data: WebSocket.RawData): void => {
      try {
        const value = JSON.parse(data.toString()) as { topic?: unknown };
        if (value.topic === topic) { cleanup(); resolve(); }
      } catch { /* Ignore unrelated malformed test frames. */ }
    };
    const cleanup = (): void => { clearTimeout(timer); websocket.off("message", onMessage); };
    websocket.on("message", onMessage);
  });
}

async function expectNoTopic(websocket: WebSocket, topic: string, durationMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const onMessage = (data: WebSocket.RawData): void => {
      try {
        const value = JSON.parse(data.toString()) as { topic?: unknown };
        if (value.topic === topic) { cleanup(); resolve(false); }
      } catch { /* Ignore unrelated malformed test frames. */ }
    };
    const timer = setTimeout(() => { cleanup(); resolve(true); }, durationMs);
    const cleanup = (): void => { clearTimeout(timer); websocket.off("message", onMessage); };
    websocket.on("message", onMessage);
  });
}

test("device authentication is disabled by default, bounded, strict, and rate limited", async () => {
  const disabledServer = createOfficeServer({ port: 0, allowedOrigins: [REMOTE_ORIGIN] });
  const disabledAddress = await disabledServer.listen();
  const disabledBase = `http://127.0.0.1:${disabledAddress.port}`;
  try {
    assert.equal((await deviceLogin(disabledBase, REMOTE_TOKEN)).status, 404);
  } finally {
    await disabledServer.close();
  }

  const server = createOfficeServer({
    port: 0,
    allowedOrigins: [REMOTE_ORIGIN],
    remoteToken: REMOTE_TOKEN,
    trustedProxyHops: 1,
    maxJsonBytes: 4 * 1024,
  });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const unknownField = await fetch(`${base}/api/v1/auth/device`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, "Content-Type": "application/json", "X-Forwarded-Proto": "https", "X-Forwarded-For": "100.64.0.10" },
      body: JSON.stringify({ token: REMOTE_TOKEN, deviceName: "Phone", extra: true }),
    });
    assert.equal(unknownField.status, 400);

    const oversized = await fetch(`${base}/api/v1/auth/device`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, "Content-Type": "application/json", "X-Forwarded-Proto": "https", "X-Forwarded-For": "100.64.0.10" },
      body: JSON.stringify({ token: "x".repeat(5_000), deviceName: "Phone" }),
    });
    assert.equal(oversized.status, 413);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rejected = await deviceLogin(base, `wrong-${"x".repeat(32)}-${attempt}`);
      assert.equal(rejected.status, 401);
      assert.equal((await rejected.text()).includes(`wrong-`), false);
    }
    const limited = await deviceLogin(base, `wrong-${"y".repeat(32)}`);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
  } finally {
    await server.close();
  }
});

test("device registry survives restart and token rotation replaces its generation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-devices-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const deviceRegistryPath = join(directory, "devices.json");
  const options = {
    port: 0,
    allowedOrigins: [REMOTE_ORIGIN],
    remoteToken: REMOTE_TOKEN,
    trustedProxyHops: 1,
    deviceRegistryPath,
  } as const;
  const first = createOfficeServer(options);
  const firstAddress = await first.listen();
  const firstLogin = await deviceLogin(`http://127.0.0.1:${firstAddress.port}`, REMOTE_TOKEN);
  assert.equal(firstLogin.status, 200);
  const firstCookies = responseCookies(firstLogin);
  await first.close();

  const second = createOfficeServer(options);
  const secondAddress = await second.listen();
  const secondBase = `http://127.0.0.1:${secondAddress.port}`;
  assert.equal((await deviceLogin(secondBase, REMOTE_TOKEN, "Second phone")).status, 409);
  assert.equal((await renewDevice(secondBase, firstCookies)).status, 200);
  await second.close();

  const rotatedToken = "replacement-enrollment-token-with-32-characters";
  const rotated = createOfficeServer({ ...options, remoteToken: rotatedToken });
  const rotatedAddress = await rotated.listen();
  const rotatedBase = `http://127.0.0.1:${rotatedAddress.port}`;
  let rotatedCookies = "";
  try {
    assert.equal((await renewDevice(rotatedBase, firstCookies)).status, 401);
    const replacementLogin = await deviceLogin(rotatedBase, rotatedToken, "Replacement phone");
    assert.equal(replacementLogin.status, 200);
    rotatedCookies = responseCookies(replacementLogin);
  } finally { await rotated.close(); }

  const rotatedRestart = createOfficeServer({ ...options, remoteToken: rotatedToken });
  const rotatedRestartAddress = await rotatedRestart.listen();
  const rotatedRestartBase = `http://127.0.0.1:${rotatedRestartAddress.port}`;
  try {
    assert.equal((await deviceLogin(rotatedRestartBase, rotatedToken, "Another phone")).status, 409);
    assert.equal((await renewDevice(rotatedRestartBase, rotatedCookies)).status, 200);
  } finally { await rotatedRestart.close(); }
});

test("device registry rejects every invalid enrollment-consumed representation and inconsistency", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-devices-schema-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const deviceRegistryPath = join(directory, "devices.json");
  const options = {
    port: 0,
    allowedOrigins: [REMOTE_ORIGIN],
    remoteToken: REMOTE_TOKEN,
    trustedProxyHops: 1,
    deviceRegistryPath,
  } as const;
  const enrolled = createOfficeServer(options);
  const enrolledAddress = await enrolled.listen();
  const enrollment = await deviceLogin(`http://127.0.0.1:${enrolledAddress.port}`, REMOTE_TOKEN);
  assert.equal(enrollment.status, 200);
  const enrolledCookies = responseCookies(enrollment);
  await enrolled.close();
  const valid = JSON.parse(await readFile(deviceRegistryPath, "utf8")) as Record<string, unknown>;
  const validDevices = Array.isArray(valid.devices) ? valid.devices : [];
  const invalidRegistries: unknown[] = [
    { ...valid, enrollmentConsumed: undefined },
    { ...valid, enrollmentConsumed: null },
    { ...valid, enrollmentConsumed: "true" },
    { ...valid, enrollmentConsumed: false },
    { ...valid, devices: [...validDevices, { id: "invalid-device" }] },
    { ...valid, devices: [...validDevices, ...validDevices] },
    { ...valid, devices: Array.from({ length: 33 }, () => validDevices[0]) },
  ];

  for (const invalid of invalidRegistries) {
    await writeFile(deviceRegistryPath, JSON.stringify(invalid), { mode: 0o600 });
    const server = createOfficeServer(options);
    const address = await server.listen();
    const base = `http://127.0.0.1:${address.port}`;
    try {
      assert.equal((await renewDevice(base, enrolledCookies)).status, 401);
      assert.equal((await deviceLogin(base, REMOTE_TOKEN)).status, 409);
    } finally { await server.close(); }
  }
});

test("malformed device registry fails closed without reopening enrollment", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-devices-corrupt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const deviceRegistryPath = join(directory, "devices.json");
  await writeFile(deviceRegistryPath, "{not-json", { mode: 0o600 });
  const server = createOfficeServer({
    port: 0,
    allowedOrigins: [REMOTE_ORIGIN],
    remoteToken: REMOTE_TOKEN,
    trustedProxyHops: 1,
    deviceRegistryPath,
  });
  const address = await server.listen();
  try {
    assert.equal((await deviceLogin(`http://127.0.0.1:${address.port}`, REMOTE_TOKEN)).status, 409);
  } finally { await server.close(); }
});

test("host remote status is desktop-capability-only, secret-free, and blocks local browser or remote devices", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-studio-host-remote-"));
  const deviceRegistryPath = join(directory, "devices.json");
  const desktopCapability = "d".repeat(64);
  const server = createOfficeServer({
    port: 0,
    allowedOrigins: [LOCAL_ORIGIN, REMOTE_ORIGIN],
    remoteToken: REMOTE_TOKEN,
    trustedProxyHops: 1,
    desktopCapability,
    deviceRegistryPath,
  });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const localLogin = await fetch(`${base}/api/v1/auth/local`, {
      method: "POST",
      headers: { Origin: LOCAL_ORIGIN },
    });
    assert.equal(localLogin.status, 200);
    const localCookie = (localLogin.headers.get("set-cookie") ?? "").split(";", 1)[0]!;

    const localBrowserStatus = await fetch(`${base}/api/v1/host/remote`, {
      headers: { Origin: LOCAL_ORIGIN, Cookie: localCookie },
    });
    assert.equal(localBrowserStatus.status, 403);

    const desktopStatus = await fetch(`${base}/api/v1/host/remote`, {
      headers: {
        Origin: "tauri://localhost",
        Host: "localhost:4317",
        "X-Hermes-Office-Desktop-Capability": desktopCapability,
      },
    });
    assert.equal(desktopStatus.status, 200);
    const body = await desktopStatus.json() as Record<string, unknown>;
    assert.equal(body.enabled, true);
    assert.deepEqual(body.origins, [REMOTE_ORIGIN]);
    assert.equal(body.trustedProxyHops, 1);
    assert.equal((body.origins as string[]).every((origin) => origin.startsWith("https://")), true);
    assert.ok(Array.isArray(body.devices));
    assert.equal(JSON.stringify(body).includes(REMOTE_TOKEN), false);

    const deviceLogin = await fetch(`${base}/api/v1/auth/device`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, "Content-Type": "application/json", "X-Forwarded-Proto": "https", "X-Forwarded-For": "100.64.0.10" },
      body: JSON.stringify({ token: REMOTE_TOKEN, deviceName: "Travel phone" }),
    });
    assert.equal(deviceLogin.status, 200);
    const deviceCookie = responseCookies(deviceLogin);

    const remoteStatus = await fetch(`${base}/api/v1/host/remote`, {
      headers: { Origin: REMOTE_ORIGIN, Cookie: deviceCookie, "X-Forwarded-Proto": "https", "X-Forwarded-For": "100.64.0.10" },
    });
    assert.equal(remoteStatus.status, 403);
  } finally { await server.close(); }
});

test("invalid remote origins are rejected at server construction", () => {
  let error: Error | undefined;
  try {
    createOfficeServer({
      port: 0,
      allowedOrigins: [REMOTE_ORIGIN, "http://not-allowed.example", "https://allowed.tailnet.ts.net/path", "https://user:pass@allowed.tailnet.ts.net"],
      remoteToken: REMOTE_TOKEN,
      trustedProxyHops: 1,
    });
  } catch (caught) { error = caught as Error; }
  assert.ok(error);
  assert.equal(error.message.includes("user:pass"), false, "error must not echo userinfo");
});
