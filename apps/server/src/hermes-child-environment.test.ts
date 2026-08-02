import assert from "node:assert/strict";
import test from "node:test";
import { createHermesChildEnvironment } from "./hermes-child-environment.js";

test("Hermes child environment inherits only runtime essentials", () => {
  const environment = createHermesChildEnvironment(
    { sessionToken: "runtime-session", cwd: "/safe/workspace" },
    {
      HOME: "/Users/example", PATH: "/usr/bin:/bin", LANG: "ja_JP.UTF-8",
      HERMES_HOME: "/Users/example/.hermes",
      HERMES_STUDIO_REMOTE_TOKEN: "office-secret", // gitleaks:allow -- synthetic exclusion fixture
      HERMES_STUDIO_ALLOWED_ORIGINS: "https://office.example",
      HERMES_STUDIO_TRUSTED_PROXY_HOPS: "1",
      HERMES_STUDIO_DESKTOP_CAPABILITY: "desktop-secret",
      AWS_SECRET_ACCESS_KEY: "cloud-secret", OPENAI_API_KEY: "provider-secret", // gitleaks:allow -- synthetic exclusion fixtures
      GITHUB_TOKEN: "ci-secret", CI_JOB_TOKEN: "ci-secret", // gitleaks:allow -- synthetic exclusion fixtures
      SSH_AUTH_SOCK: "/tmp/agent.sock", NODE_OPTIONS: "--require=/tmp/inject.cjs",
    },
  );

  assert.deepEqual(environment, {
    HOME: "/Users/example", PATH: "/usr/bin:/bin", LANG: "ja_JP.UTF-8",
    HERMES_HOME: "/Users/example/.hermes",
    HERMES_DASHBOARD_SESSION_TOKEN: "runtime-session",
    HERMES_DESKTOP: "1", TERMINAL_CWD: "/safe/workspace",
  });

  const record = environment as Readonly<Record<string, string | undefined>>;
  assert.equal(record.HERMES_STUDIO_REMOTE_TOKEN, undefined);
  assert.equal(record.HERMES_STUDIO_ALLOWED_ORIGINS, undefined);
  assert.equal(record.HERMES_STUDIO_TRUSTED_PROXY_HOPS, undefined);
});

test("Hermes child environment rejects inherited NUL values", () => {
  const environment = createHermesChildEnvironment(
    { sessionToken: "runtime-session", cwd: "/safe/workspace" },
    { HOME: "/safe\0/injected", PATH: "/usr/bin" },
  );
  assert.equal(environment.HOME, undefined);
  assert.equal(environment.PATH, "/usr/bin");
});
