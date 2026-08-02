import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StaticWebAssets } from "./static-web.js";

test("serves the app shell and immutable built assets", async () => {
  const root = await fixture();
  try {
    const assets = new StaticWebAssets(root);
    const shell = await assets.read("/");
    const script = await assets.read("/assets/app-123.js");
    const atlas = await assets.read("/characters/hermes-studio-character-atlas-v4.webp");
    const manifest = await assets.read("/manifest.webmanifest");
    assert.equal(shell?.body.toString(), "<main>Office</main>");
    assert.equal(shell?.cacheControl, "no-cache");
    assert.equal(script?.contentType, "text/javascript; charset=utf-8");
    assert.equal(atlas?.contentType, "image/webp");
    assert.equal(manifest?.contentType, "application/manifest+json; charset=utf-8");
    assert.match(script?.cacheControl ?? "", /immutable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("falls back for app routes but not missing assets", async () => {
  const root = await fixture();
  try {
    const assets = new StaticWebAssets(root);
    assert.equal((await assets.read("/settings"))?.body.toString(), "<main>Office</main>");
    assert.equal(await assets.read("/assets/missing.js"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects traversal, encoded traversal, and API paths", async () => {
  const root = await fixture();
  try {
    const assets = new StaticWebAssets(root);
    assert.equal(await assets.read("/../secret"), undefined);
    assert.equal(await assets.read("/%2e%2e/secret"), undefined);
    assert.equal(await assets.read("/.env"), undefined);
    assert.equal(await assets.read("/api"), undefined);
    assert.equal(await assets.read("/api/v1/snapshot"), undefined);
    assert.equal(await assets.read("/assets"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not follow a web-root symlink to files outside the configured directory", async () => {
  const root = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "hermes-studio-private-"));
  try {
    await writeFile(join(outside, "private.txt"), "private material");
    await symlink(join(outside, "private.txt"), join(root, "leak.txt"));
    const assets = new StaticWebAssets(root);
    assert.equal(await assets.read("/leak.txt"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hermes-studio-web-"));
  await mkdir(join(root, "assets"));
  await mkdir(join(root, "characters"));
  await writeFile(join(root, "index.html"), "<main>Office</main>");
  await writeFile(join(root, "assets/app-123.js"), "export {};");
  await writeFile(join(root, "characters/hermes-studio-character-atlas-v4.webp"), "webp");
  await writeFile(join(root, "manifest.webmanifest"), "{}");
  return root;
}
