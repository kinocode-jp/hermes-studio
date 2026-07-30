import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { homebrewChildEnvironment, validatedLocalExecutable } from "./host-apps.js";

test("Homebrew receives only the explicit non-secret environment allowlist", () => {
  const env = homebrewChildEnvironment({
    HOME: "/Users/example",
    LANG: "en_US.UTF-8",
    HERMES_STUDIO_REMOTE_TOKEN: "must-not-be-forwarded",
    HOMEBREW_GITHUB_API_TOKEN: "must-not-be-forwarded",
    NODE_OPTIONS: "--require unexpected-module",
  });

  assert.equal(env.HOME, "/Users/example");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.match(env.PATH ?? "", /^\/opt\/homebrew\/bin:/);
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH"]);
});

test("local executable validation canonicalizes links and rejects unsafe modes", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "hermes-studio-host-app-"));
  try {
    const executable = join(directory, "brew");
    const link = join(directory, "brew-link");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    symlinkSync(executable, link);
    assert.equal(validatedLocalExecutable(link), realpathSync(executable));

    chmodSync(executable, 0o777);
    assert.equal(validatedLocalExecutable(link), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
