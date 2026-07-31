import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStudioServer } from "./server.js";

const ORIGIN = "http://localhost:4173";

test("production web assets are public, HEAD-aware, cache-safe, and use a functional strict CSP", async () => {
  const root = await webFixture();
  const server = createStudioServer({ port: 0, staticWebRoot: root });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const shell = await fetch(`${base}/`);
    assert.equal(shell.status, 200);
    assert.equal(await shell.text(), "<main>Hermes Studio</main>");
    const csp = shell.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.doesNotMatch(csp, /default-src 'none'/);
    assert.equal(shell.headers.get("x-content-type-options"), "nosniff");

    const sameOriginLogin = await fetch(`${base}/api/v1/auth/local`, {
      method: "POST",
      headers: { Origin: base },
    });
    assert.equal(sameOriginLogin.status, 200);
    assert.match(sameOriginLogin.headers.get("set-cookie") ?? "", /HttpOnly/);

    const head = await fetch(`${base}/assets/app-123.js`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal(head.headers.get("content-length"), Buffer.byteLength("export {};").toString());
    assert.match(head.headers.get("cache-control") ?? "", /immutable/);

    const atlas = await fetch(`${base}/characters/hermes-studio-character-atlas-v4.webp`);
    assert.equal(atlas.headers.get("content-type"), "image/webp");
    assert.equal(atlas.headers.get("x-content-type-options"), "nosniff");
    const manifest = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(manifest.headers.get("content-type"), "application/manifest+json; charset=utf-8");
    assert.equal(manifest.headers.get("x-content-type-options"), "nosniff");

    const appRoute = await fetch(`${base}/settings`);
    assert.equal(await appRoute.text(), "<main>Hermes Studio</main>");
    const missingAsset = await fetch(`${base}/assets/missing.js`);
    assert.equal(missingAsset.status, 404);
    assert.equal((await missingAsset.text()).includes("Hermes Studio</main>"), false);

    const postNavigation = await fetch(`${base}/settings`, { method: "POST" });
    assert.equal(postNavigation.status, 405);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("API paths retain API routing and never receive the SPA shell", async () => {
  const root = await webFixture();
  const server = createStudioServer({ port: 0, staticWebRoot: root, allowedOrigins: [ORIGIN] });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const health = await fetch(`${base}/api/v1/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("content-type")?.startsWith("application/json"), true);

    const unauthenticated = await fetch(`${base}/api/v1/unknown`);
    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.text()).includes("Hermes Studio</main>"), false);

    const login = await fetch(`${base}/api/v1/auth/local`, {
      method: "POST",
      headers: { Origin: ORIGIN },
    });
    const cookie = login.headers.get("set-cookie") ?? "";
    const unknown = await fetch(`${base}/api/v1/unknown`, {
      headers: { Origin: ORIGIN, Cookie: cookie },
    });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.text()).includes("Hermes Studio</main>"), false);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function webFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hermes-studio-production-web-"));
  await mkdir(join(root, "assets"));
  await mkdir(join(root, "characters"));
  await writeFile(join(root, "index.html"), "<main>Hermes Studio</main>");
  await writeFile(join(root, "assets/app-123.js"), "export {};");
  await writeFile(join(root, "characters/hermes-studio-character-atlas-v4.webp"), "webp");
  await writeFile(join(root, "manifest.webmanifest"), "{}");
  return root;
}
