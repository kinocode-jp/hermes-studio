import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  brandEnv,
  brandEnvIsTrue,
  brandStateHome,
  brandStatePath,
  resetBrandStateHomeForTests,
} from "./brand-env.js";

test("brandEnv prefers HERMES_STUDIO_ over deprecated HERMES_OFFICE_", () => {
  const source = {
    HERMES_STUDIO_REMOTE_TOKEN: "studio-token",
    HERMES_OFFICE_REMOTE_TOKEN: "office-token",
  } as NodeJS.ProcessEnv;
  assert.equal(brandEnv("REMOTE_TOKEN", source), "studio-token");
});

test("brandEnv falls back to HERMES_OFFICE_ when studio unset", () => {
  const source = {
    HERMES_OFFICE_REMOTE_TOKEN: "office-token",
  } as NodeJS.ProcessEnv;
  assert.equal(brandEnv("REMOTE_TOKEN", source), "office-token");
});

test("brandEnv treats empty studio value as set (no silent legacy override)", () => {
  const source = {
    HERMES_STUDIO_HOST: "",
    HERMES_OFFICE_HOST: "127.0.0.1",
  } as NodeJS.ProcessEnv;
  assert.equal(brandEnv("HOST", source), "");
});

test("brandEnvIsTrue only accepts the string true", () => {
  assert.equal(brandEnvIsTrue("REMOTE_PRIVILEGED", { HERMES_STUDIO_REMOTE_PRIVILEGED: "true" } as NodeJS.ProcessEnv), true);
  assert.equal(brandEnvIsTrue("REMOTE_PRIVILEGED", { HERMES_OFFICE_REMOTE_PRIVILEGED: "true" } as NodeJS.ProcessEnv), true);
  assert.equal(brandEnvIsTrue("REMOTE_PRIVILEGED", { HERMES_STUDIO_REMOTE_PRIVILEGED: "1" } as NodeJS.ProcessEnv), false);
});

test("brandStateHome migrates ~/.hermes-office to ~/.hermes-studio when preferred is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "hermes-studio-brand-state-"));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  resetBrandStateHomeForTests();
  try {
    const legacy = join(root, ".hermes-office");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "devices.json"), "{\"devices\":[]}\n", "utf8");
    const home = brandStateHome();
    assert.equal(home, join(root, ".hermes-studio"));
    assert.equal(await readFile(join(home, "devices.json"), "utf8"), "{\"devices\":[]}\n");
    assert.equal(brandStatePath("teams.json"), join(root, ".hermes-studio", "teams.json"));
  } finally {
    resetBrandStateHomeForTests();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
