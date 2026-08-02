import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { createChatSocketAuthGuard } from "./chat-socket-auth.js";
import { HermesCommitUnconfirmedError, HermesProfileError, type HermesRuntimeSource } from "./hermes-backend.js";
import type { HermesChatRequest } from "./hermes-chat.js";
import { createDemoRuntimeStatus, createDemoSnapshot } from "./demo-state.js";
import type { OfficeAuth, OfficeAuthSession } from "./office-auth.js";
import { allowedCorsOrigin, createDesktopReadinessProof, createStudioServer, isLoopbackHost, makeOriginAllowlist } from "./server.js";

test("direct non-loopback listeners are always refused", () => {
  assert.throws(() => createStudioServer({ host: "0.0.0.0" }), /direct non-loopback bind/);
  assert.throws(
    () => createStudioServer({ host: "0.0.0.0", allowNonLoopback: true }),
    /trusted HTTPS reverse proxy/,
  );
  assert.throws(() =>
    createStudioServer({
      host: "0.0.0.0",
      allowNonLoopback: true,
      remoteToken: "r".repeat(32),
    }),
    /trusted HTTPS reverse proxy/,
  );
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("192.168.1.20"), false);
});

test("origin allowlist rejects wildcards and null origins", () => {
  assert.throws(() => makeOriginAllowlist(["*"]), /explicit, non-null/);
  assert.throws(() => makeOriginAllowlist(["null"]), /explicit, non-null/);
  assert.equal(
    makeOriginAllowlist(["https://office.example/"]).has("https://office.example"),
    true,
  );
});

test("allowedCorsOrigin resolves normalized inputs to canonical allowlist entries", () => {
  const allowlist = makeOriginAllowlist([
    "https://office.example",
    "http://localhost:4173",
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
  ]);

  assert.equal(allowedCorsOrigin("https://office.example/", allowlist), "https://office.example");
  assert.equal(allowedCorsOrigin("https://OFFICE.EXAMPLE/", allowlist), "https://office.example");
  assert.equal(allowedCorsOrigin("https://office.example:443/", allowlist), "https://office.example");
  assert.equal(allowedCorsOrigin("http://localhost:4173/", allowlist), "http://localhost:4173");
  assert.equal(allowedCorsOrigin("http://LOCALHOST:4173", allowlist), "http://localhost:4173");
  assert.equal(allowedCorsOrigin("tauri://localhost", allowlist), "tauri://localhost");
  assert.equal(allowedCorsOrigin("TAURI://Localhost", allowlist), "tauri://localhost");
  assert.equal(allowedCorsOrigin("TAURI://Localhost/", allowlist), "tauri://localhost");
  assert.equal(allowedCorsOrigin("HTTP://TAURI.Localhost", allowlist), "http://tauri.localhost");
  assert.equal(allowedCorsOrigin("https://TAURI.Localhost", allowlist), "https://tauri.localhost");
});

test("allowedCorsOrigin rejects disallowed and malformed origins", () => {
  const allowlist = makeOriginAllowlist(["https://office.example"]);

  assert.equal(allowedCorsOrigin("https://attacker.example", allowlist), undefined);
  assert.equal(allowedCorsOrigin("https://office.example.evil.com", allowlist), undefined);
  assert.equal(allowedCorsOrigin("https://office.example/path", allowlist), undefined);
  assert.equal(allowedCorsOrigin("https://user:pass@office.example", allowlist), undefined);
  assert.equal(allowedCorsOrigin("https://office.example?query", allowlist), undefined);
  assert.equal(allowedCorsOrigin("https://office.example#hash", allowlist), undefined);
  assert.equal(allowedCorsOrigin("*", allowlist), undefined);
  assert.equal(allowedCorsOrigin("null", allowlist), undefined);
  assert.equal(allowedCorsOrigin("", allowlist), undefined);
  assert.equal(allowedCorsOrigin("not a url", allowlist), undefined);
  assert.equal(allowedCorsOrigin("TAURI://Localhost/path", allowlist), undefined);
  assert.equal(allowedCorsOrigin("TAURI://Localhost?query", allowlist), undefined);
  assert.equal(allowedCorsOrigin("TAURI://Localhost#hash", allowlist), undefined);
});

test("CORS response header echoes the canonical allowlist entry, not the raw request origin", async () => {
  const server = createStudioServer({ port: 0, allowedOrigins: ["https://office.example"] });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${base}/api/v1/health`, {
      headers: { Origin: "https://OFFICE.EXAMPLE:443/" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://office.example");
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    assert.equal(response.headers.get("vary"), "Origin");
  } finally {
    await server.close();
  }
});

test("CORS header is omitted when no Origin is sent", async () => {
  const server = createStudioServer({ port: 0 });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${base}/api/v1/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(response.headers.get("access-control-allow-credentials"), null);
  } finally {
    await server.close();
  }
});

test("createStudioServer origin allowlist always includes remote and Tauri origins", async () => {
  const remoteOrigin = "https://office.tailnet.example";
  const server = createStudioServer({ port: 0, allowedOrigins: [remoteOrigin] });
  await server.listen();
  try {
    assert.equal(server.originAllowlist.has(remoteOrigin), true);
    assert.equal(server.originAllowlist.has("tauri://localhost"), true);
  } finally {
    await server.close();
  }
});

test("usage stats rejects suffixed and fractional day values", async () => {
  const desktopCapability = "u".repeat(64);
  const server = createStudioServer({ port: 0, desktopCapability });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const headers = {
    Origin: "tauri://localhost",
    "X-Hermes-Office-Desktop-Capability": desktopCapability,
  };

  try {
    for (const days of ["1junk", "1.5", "1e1", "0", "91"]) {
      const response = await fetch(`${base}/api/v1/stats/usage?days=${days}`, { headers });
      assert.equal(response.status, 400, days);
    }
  } finally {
    await server.close();
  }
});

test("snapshot is bounded, explicit, and does not expose secret-shaped fields", async () => {
  const server = createStudioServer({ port: 0 });
  const address = await server.listen();

  try {
    const base = `http://127.0.0.1:${address.port}`;
    const bootstrap = await fetch(`${base}/api/v1/auth/local`, {
      method: "POST",
      headers: { Origin: base },
    });
    assert.equal(bootstrap.status, 200);
    const cookie = bootstrap.headers.get("set-cookie") ?? "";
    const response = await fetch(`${base}/api/v1/snapshot`, {
      headers: { Origin: base, Cookie: cookie },
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(/password|api[_-]?key|access[_-]?token|refresh[_-]?token/i.test(body), false);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const access = (JSON.parse(body) as { capabilities: { access: { deviceId: string; tier: string; exposure: string; authentication: string } } }).capabilities.access;
    assert.deepEqual(access, {
      deviceId: "local-browser",
      tier: "owner",
      exposure: "loopback",
      authentication: "local-cookie",
      allowedOperations: [
        "state.read", "chat.session.create", "chat.session.archive", "chat.message.send", "chat.run.cancel",
        "chat.approval.permanent", "kanban.card.create", "kanban.card.update", "kanban.card.comment",
        "team.create", "team.update", "team.delete",
        "profile.create", "profile.update", "profile.delete", "memory.update", "skill.enable", "skill.install",
        "global-settings.update", "chat-model-preferences.update", "local-model-providers.sync", "profile-config.update", "privileged-config.read", "privileged-config.update", "host-app.install", "host-fs.read", "host-fs.open", "obsidian.vault.read", "hermes-agent.update",
        "runtime.start", "runtime.stop", "runtime.configure", "secret.write", "device.revoke", "audit.read",
      ],
    });

    const rejected = await fetch(`${base}/api/v1/snapshot`, {
      headers: { Origin: "https://attacker.example" },
    });
    assert.equal(rejected.status, 403);
  } finally {
    await server.close();
  }
});

test("launch-scoped desktop capability authenticates Tauri HTTP and WebSocket requests", async () => {
  const desktopCapability = "d".repeat(64);
  const server = createStudioServer({ port: 0, desktopCapability });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const origin = "tauri://localhost";

  try {
    const unauthenticated = await fetch(`${base}/api/v1/snapshot`, { headers: { Origin: origin } });
    assert.equal(unauthenticated.status, 401);

    const authenticated = await fetch(`${base}/api/v1/snapshot`, {
      headers: { Origin: origin, "X-Hermes-Office-Desktop-Capability": desktopCapability },
    });
    assert.equal(authenticated.status, 200);
    assert.equal((await authenticated.json() as { capabilities: { access: { authentication: string } } }).capabilities.access.authentication, "desktop-capability");

    for (const devOrigin of ["http://localhost:4173", "http://127.0.0.1:4173"]) {
      const wrongOrigin = await fetch(`${base}/api/v1/snapshot`, {
        headers: { Origin: devOrigin, "X-Hermes-Office-Desktop-Capability": desktopCapability },
      });
      assert.equal(wrongOrigin.status, 403);
      assert.equal((await fetch(`${base}/api/v1/auth/local`, {
        method: "POST",
        headers: { Origin: devOrigin },
      })).status, 403);
    }

    const preflight = await fetch(`${base}/api/v1/snapshot`, { method: "OPTIONS", headers: { Origin: origin } });
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /X-Hermes-Office-Desktop-Capability/);

    const websocket = new WebSocket(
      `${base.replace("http:", "ws:")}/api/v1/events`,
      ["hermes-office.v1", `hermes-office.desktop.${desktopCapability}`],
      { origin },
    );
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("desktop WebSocket timed out")), 2_000);
      websocket.once("open", () => { clearTimeout(timeout); resolve(); });
      websocket.once("error", reject);
    });
    assert.equal(websocket.protocol, "hermes-office.v1");
    websocket.close();
  } finally {
    await server.close();
  }
});

test("profiles mutations accept only the create body and reject body-bearing deletes", async () => {
  const desktopCapability = "p".repeat(64);
  const created: string[] = [];
  const deleted: string[] = [];
  const runtime = {
    status: createDemoRuntimeStatus,
    snapshot: async () => createDemoSnapshot(),
    close: async () => undefined,
    chat: () => { throw new Error("unused"); },
    kanban: () => { throw new Error("unused"); },
    createProfile: async (name: string) => { created.push(name); },
    deleteProfile: async (name: string) => { deleted.push(name); },
  } as unknown as HermesRuntimeSource;
  const server = createStudioServer({ port: 0, desktopCapability, runtimeSource: runtime });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const headers = {
    Origin: "tauri://localhost",
    "X-Hermes-Office-Desktop-Capability": desktopCapability,
    "Content-Type": "application/json",
  };

  try {
    const create = await fetch(`${base}/api/v1/profiles`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "coder" }),
    });
    assert.equal(create.status, 201);
    assert.deepEqual(created, ["coder"]);

    const rejectedDelete = await fetch(`${base}/api/v1/profiles/coder`, {
      method: "DELETE",
      headers,
      body: "{}",
    });
    assert.equal(rejectedDelete.status, 413);
    assert.equal(rejectedDelete.headers.get("connection"), "close");
    assert.deepEqual(deleted, []);

    const acceptedDelete = await fetch(`${base}/api/v1/profiles/coder`, {
      method: "DELETE",
      headers: {
        Origin: headers.Origin,
        "X-Hermes-Office-Desktop-Capability": desktopCapability,
      },
    });
    assert.equal(acceptedDelete.status, 200);
    assert.deepEqual(deleted, ["coder"]);
  } finally {
    await server.close();
  }
});

test("profile creation reports an unconfirmed upstream commit without inviting a blind retry", async () => {
  const desktopCapability = "u".repeat(64);
  const runtime = {
    status: createDemoRuntimeStatus,
    snapshot: async () => createDemoSnapshot(),
    close: async () => undefined,
    chat: () => { throw new Error("unused"); },
    kanban: () => { throw new Error("unused"); },
    createProfile: async () => { throw new HermesCommitUnconfirmedError("private detail"); },
  } as unknown as HermesRuntimeSource;
  const server = createStudioServer({ port: 0, desktopCapability, runtimeSource: runtime });
  const address = await server.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/profiles`, {
      method: "POST",
      headers: {
        Origin: "tauri://localhost",
        "X-Hermes-Office-Desktop-Capability": desktopCapability,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "maybe-created" }),
    });
    assert.equal(response.status, 409);
    const body = await response.json() as { code?: string; message?: string; retryable?: boolean };
    assert.deepEqual(body, {
      code: "commit_unconfirmed",
      message: "Hermes may have created this profile; refresh the profile list before retrying.",
      retryable: false,
    });
    assert.equal(JSON.stringify(body).includes("private detail"), false);
  } finally {
    await server.close();
  }
});

test("profile mutations expose only typed, stable public errors", async () => {
  const desktopCapability = "p".repeat(64);
  const runtime = {
    status: createDemoRuntimeStatus,
    snapshot: async () => createDemoSnapshot(),
    close: async () => undefined,
    chat: () => { throw new Error("unused"); },
    kanban: () => { throw new Error("unused"); },
    createProfile: async () => { throw new Error("invalid private path /Users/example/.hermes"); },
    deleteProfile: async () => { throw new HermesProfileError("not_found"); },
  } as unknown as HermesRuntimeSource;
  const server = createStudioServer({ port: 0, desktopCapability, runtimeSource: runtime });
  const address = await server.listen();
  const headers = {
    Origin: "tauri://localhost",
    "X-Hermes-Office-Desktop-Capability": desktopCapability,
  };
  try {
    const create = await fetch(`http://127.0.0.1:${address.port}/api/v1/profiles`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "coder" }),
    });
    assert.equal(create.status, 502);
    assert.equal((await create.text()).includes("/Users/example"), false);

    const remove = await fetch(`http://127.0.0.1:${address.port}/api/v1/profiles/coder`, {
      method: "DELETE",
      headers,
    });
    assert.equal(remove.status, 404);
    assert.deepEqual(await remove.json(), {
      code: "not_found",
      message: "Hermes profile was not found.",
      retryable: false,
    });
  } finally {
    await server.close();
  }
});

test("session resource rejects and drains bodies before method dispatch", async () => {
  const desktopCapability = "s".repeat(64);
  const server = createStudioServer({ port: 0, desktopCapability });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const headers = {
    Origin: "tauri://localhost",
    "X-Hermes-Office-Desktop-Capability": desktopCapability,
    "Content-Type": "application/json",
  };

  try {
    const bodyRejected = await fetch(`${base}/api/v1/sessions/stored`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(bodyRejected.status, 413);
    assert.equal(bodyRejected.headers.get("connection"), "close");

    const methodRejected = await fetch(`${base}/api/v1/sessions/stored`, {
      method: "POST",
      headers: {
        Origin: headers.Origin,
        "X-Hermes-Office-Desktop-Capability": desktopCapability,
      },
    });
    assert.equal(methodRejected.status, 405);
    assert.equal(methodRejected.headers.get("allow"), "DELETE");
  } finally {
    await server.close();
  }
});

test("session delete never reflects arbitrary runtime diagnostics", async () => {
  const desktopCapability = "d".repeat(64);
  const runtime = {
    status: createDemoRuntimeStatus,
    snapshot: async () => createDemoSnapshot(),
    close: async () => undefined,
    chat: () => { throw new Error("unused"); },
    kanban: () => { throw new Error("unused"); },
    deleteSession: async () => { throw new Error("invalid path /Users/private/session-token"); },
  } as unknown as HermesRuntimeSource;
  const server = createStudioServer({ port: 0, desktopCapability, runtimeSource: runtime });
  const address = await server.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/sessions/stored`, {
      method: "DELETE",
      headers: {
        Origin: "tauri://localhost",
        "X-Hermes-Office-Desktop-Capability": desktopCapability,
      },
    });
    assert.equal(response.status, 502);
    const body = await response.text();
    assert.equal(body.includes("/Users/private"), false);
    assert.equal(body.includes("session-token"), false);
    assert.equal(body.includes("Hermes rejected the session delete request."), true);
  } finally {
    await server.close();
  }
});

test("desktop readiness proof is loopback-only, strict, secret-free, and unavailable without a capability", async () => {
  const desktopCapability = "readiness-secret-".repeat(4);
  const nonce = "ab".repeat(32);
  const query = `nonce=${nonce}&domain=hermes-office-desktop-readiness&version=1`;
  const server = createStudioServer({ port: 0, desktopCapability });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${base}/api/v1/health/desktop-proof?${query}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const responseText = await response.text();
    assert.equal(responseText.includes(desktopCapability), false);
    const body = JSON.parse(responseText) as { proof: string };
    assert.deepEqual(Object.keys(body), ["proof"]);
    assert.equal(body.proof, createHmac("sha256", desktopCapability)
      .update(`hermes-office-desktop-readiness\n1\n${nonce}`, "utf8").digest("hex"));

    const rejectedUrls = [
      `${base}/api/v1/health/desktop-proof?nonce=${"AB".repeat(32)}&domain=hermes-office-desktop-readiness&version=1`,
      `${base}/api/v1/health/desktop-proof?nonce=${"ab".repeat(31)}&domain=hermes-office-desktop-readiness&version=1`,
      `${base}/api/v1/health/desktop-proof?${query}&extra=1`,
      `${base}/api/v1/health/desktop-proof?domain=hermes-office-desktop-readiness&version=1&nonce=${nonce}`,
      `${base}/api/v1/health/desktop-proof?nonce=%61${nonce.slice(1)}&domain=hermes-office-desktop-readiness&version=1`,
      `${base}/api/v1/health/desktop-proof?nonce=${nonce}&domain=wrong&version=1`,
      `${base}/api/v1/health/desktop-proof?nonce=${nonce}&domain=hermes-office-desktop-readiness&version=2`,
    ];
    for (const url of rejectedUrls) assert.equal((await fetch(url)).status, 404);
    assert.equal((await fetch(`${base}/api/v1/health/desktop-proof?${query}`, {
      headers: { Origin: "tauri://localhost" },
    })).status, 404);
    assert.equal((await fetch(`${base}/api/v1/health/desktop-proof?${query}`, {
      headers: { "X-Forwarded-For": "203.0.113.9" },
    })).status, 404);
    assert.equal((await fetch(`${base}/api/v1/health/desktop-proof?${query}`, {
      headers: { "X-Hermes-Office-Desktop-Capability": desktopCapability },
    })).status, 404);
    assert.equal((await fetch(`${base}/api/v1/health/desktop-proof?${query}`, { method: "POST" })).status, 404);
  } finally {
    await server.close();
  }

  const publicServer = createStudioServer({ port: 0 });
  const publicAddress = await publicServer.listen();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${publicAddress.port}/api/v1/health/desktop-proof?${query}`)).status, 404);
  } finally {
    await publicServer.close();
  }
});

test("desktop readiness proof is deterministic, nonce-bound, domain-separated, and never returns the key", () => {
  const capability = "capability-that-must-not-appear".repeat(2);
  const nonce = "01".repeat(32);
  const proof = createDesktopReadinessProof(capability, nonce);
  assert.equal(proof, createDesktopReadinessProof(capability, nonce));
  assert.notEqual(proof, createDesktopReadinessProof(capability, "02".repeat(32)));
  assert.notEqual(proof, createDesktopReadinessProof("wrong-capability-key", nonce));
  assert.notEqual(proof, createHmac("sha256", capability).update(nonce).digest("hex"));
  assert.equal(proof.includes(capability), false);
  assert.match(proof, /^[0-9a-f]{64}$/);
});

test("desktop capability chat socket accepts its first client frame after a delay", async () => {
  const desktopCapability = "f".repeat(64);
  const runtime = {
    status: createDemoRuntimeStatus,
    snapshot: async () => createDemoSnapshot(),
    close: async () => undefined,
    kanban: () => { throw new Error("unused"); },
    chat: () => ({
      inspectHistory: async ({ sessionId }: { sessionId: string }) => ({ sessionId, total: 0 }),
      fetchHistory: async () => { throw new Error("unused"); },
      connect: async () => ({
        closed: false,
        close: async () => undefined,
        request: async (request: HermesChatRequest) => request.method === "session.create"
          ? { method: request.method, value: { liveSessionId: "live-desktop", storedSessionId: "stored-desktop", running: false, status: "idle" } }
          : { method: request.method, value: { status: "ok" } },
      }),
    }),
  } as unknown as HermesRuntimeSource;
  const server = createStudioServer({ port: 0, desktopCapability, runtimeSource: runtime });
  const address = await server.listen();
  const websocket = new WebSocket(
    `ws://127.0.0.1:${address.port}/api/v1/chat`,
    ["hermes-office.v1", `hermes-office.desktop.${desktopCapability}`],
    { origin: "tauri://localhost" },
  );

  try {
    await waitForJsonFrame(websocket, (frame) => frame.method === "office.ready");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const response = waitForJsonFrame(websocket, (frame) => frame.id === 1);
    websocket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.create", params: { profile: "default" } }));
    assert.equal((await response).error, undefined);
    assert.equal(websocket.readyState, WebSocket.OPEN);
  } finally {
    websocket.terminate();
    await server.close();
  }
});

test("chat socket guard keeps its upgrade lease as an absolute expiry", () => {
  const expired: OfficeAuthSession = {
    principal: { id: "local-desktop", tier: "owner", local: true, deviceName: "Local desktop" },
    csrfToken: "c".repeat(32),
    expiresAt: new Date(Date.now() - 1).toISOString(),
  };
  const auth = {
    authenticate: () => ({ ...expired, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  } as unknown as OfficeAuth;
  const guard = createChatSocketAuthGuard(auth, {} as IncomingMessage, expired);

  assert.equal(guard.isActive(), false, "a regenerated desktop lease cannot extend the socket's upgrade deadline");
});

test("desktop development origin is explicit and cannot be widened to a remote site", async () => {
  const desktopCapability = "e".repeat(64);
  assert.throws(
    () => createStudioServer({ desktopCapability, desktopOrigins: ["https://office.example"] }),
    /trusted local origins/,
  );
  const server = createStudioServer({
    port: 0,
    desktopCapability,
    allowedOrigins: ["http://localhost:4173"],
    desktopOrigins: ["http://localhost:4173"],
  });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/api/v1/snapshot`, {
      headers: {
        Origin: "http://localhost:4173",
        "X-Hermes-Office-Desktop-Capability": desktopCapability,
      },
    })).status, 200);
    assert.equal((await fetch(`${base}/api/v1/auth/local`, {
      method: "POST",
      headers: { Origin: "http://localhost:4173" },
    })).status, 200);
    assert.equal((await fetch(`${base}/api/v1/snapshot`, {
      headers: {
        Origin: "tauri://localhost",
        "X-Hermes-Office-Desktop-Capability": desktopCapability,
      },
    })).status, 403);
  } finally {
    await server.close();
  }
});

test("remote origins augment the actual listener origin without trusting unrelated local sites", async () => {
  const remoteOrigin = "https://office.tailnet.example";
  const server = createStudioServer({ port: 0, allowedOrigins: [remoteOrigin] });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(server.originAllowlist.has(remoteOrigin), true);
    assert.equal(server.originAllowlist.has(base), true);
    assert.equal(server.originAllowlist.has(`http://localhost:${address.port}`), true);
    assert.equal((await fetch(`${base}/api/v1/auth/local`, {
      method: "POST",
      headers: { Origin: base },
    })).status, 200);
    for (const deniedOrigin of ["https://attacker.example", "http://localhost:4173", "http://127.0.0.1:4173"]) {
      assert.equal((await fetch(`${base}/api/v1/auth/local`, {
        method: "POST",
        headers: { Origin: deniedOrigin },
      })).status, 403);
    }
  } finally {
    await server.close();
  }
});

async function waitForJsonFrame(
  websocket: WebSocket,
  predicate: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error("WebSocket frame timed out.")); }, 2_000);
    const onMessage = (data: WebSocket.RawData): void => {
      try {
        const frame = JSON.parse(data.toString()) as unknown;
        if (typeof frame === "object" && frame !== null && !Array.isArray(frame) && predicate(frame as Record<string, unknown>)) {
          cleanup(); resolve(frame as Record<string, unknown>);
        }
      } catch { /* Ignore unrelated malformed frames. */ }
    };
    const onError = (): void => { cleanup(); reject(new Error("WebSocket failed.")); };
    const cleanup = (): void => { clearTimeout(timeout); websocket.off("message", onMessage); websocket.off("error", onError); };
    websocket.on("message", onMessage);
    websocket.on("error", onError);
  });
}
