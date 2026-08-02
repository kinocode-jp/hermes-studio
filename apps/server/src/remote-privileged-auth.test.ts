import assert from "node:assert/strict";
import test from "node:test";
import {
  isRemotePrivilegedOperation,
  OPERATION_POLICIES,
} from "@hermes-studio/protocol";
import { OfficeAuth } from "./office-auth.js";
import type { OfficeAuthSession } from "./office-auth.js";
import { routeSettingsHttp } from "./settings-http.js";
import { SecretTransferStore } from "./secret-transfer.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { HermesSettingsAdapter } from "./hermes-settings.js";

const REVISION = "a".repeat(43);

function session(partial: Partial<OfficeAuthSession["principal"]> & { id: string; tier: OfficeAuthSession["principal"]["tier"]; local: boolean }): OfficeAuthSession {
  return {
    principal: {
      id: partial.id,
      tier: partial.tier,
      local: partial.local,
      deviceName: partial.deviceName ?? partial.id,
    },
    csrfToken: "csrf-token-for-tests-xxxxxxxxxxxx",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

test("protocol policies make privileged ops owner remote-safe/readable", () => {
  assert.equal(OPERATION_POLICIES["privileged-config.read"].minimumTier, "owner");
  assert.equal(OPERATION_POLICIES["privileged-config.read"].boundary, "read-only");
  assert.equal(OPERATION_POLICIES["privileged-config.update"].minimumTier, "owner");
  assert.equal(OPERATION_POLICIES["privileged-config.update"].boundary, "remote-safe");
  assert.equal(OPERATION_POLICIES["secret.write"].minimumTier, "owner");
  assert.equal(OPERATION_POLICIES["secret.write"].boundary, "remote-safe");
  assert.equal(isRemotePrivilegedOperation("secret.write"), true);
  assert.equal(isRemotePrivilegedOperation("obsidian.vault.read"), true);
  assert.equal(isRemotePrivilegedOperation("state.read"), false);
});

test("remote privileged ops denied by default and allowed when flag enabled for owner only", () => {
  const remoteOwner = session({ id: "device-1", tier: "owner", local: false });
  const remoteOperator = session({ id: "device-2", tier: "operator", local: false });
  const remoteManager = session({ id: "device-3", tier: "manager", local: false });
  const localDesktop = session({ id: "local-desktop", tier: "owner", local: true });
  const localCookie = session({ id: "local-browser", tier: "owner", local: true });

  const off = new OfficeAuth({ remotePrivilegedEnabled: false });
  assert.equal(off.allowsPrivilegedSettings(remoteOwner), false);
  assert.equal(off.allowsPrivilegedSettings(localDesktop), true);
  assert.equal(off.allowsPrivilegedSettings(localCookie), true);
  assert.equal(off.authorizeSession(remoteOwner, "privileged-config.read").allowed, false);
  assert.equal(off.authorizeSession(remoteOwner, "secret.write").allowed, false);
  assert.equal(off.authorizeSession(remoteOwner, "host-app.install").allowed, false);
  assert.equal(off.authorizeSession(remoteOwner, "obsidian.vault.read").allowed, false);
  assert.equal(off.authorizeSession(remoteOwner, "hermes-agent.update").allowed, false);
  assert.equal(off.effectiveAccess(remoteOwner).allowedOperations.includes("secret.write"), false);

  const on = new OfficeAuth({ remotePrivilegedEnabled: true });
  assert.equal(on.allowsPrivilegedSettings(remoteOwner), true);
  assert.equal(on.allowsPrivilegedSettings(remoteOperator), false);
  assert.equal(on.allowsPrivilegedSettings(remoteManager), false);
  assert.equal(on.authorizeSession(remoteOwner, "privileged-config.update").allowed, true);
  assert.equal(on.authorizeSession(remoteOwner, "secret.write").allowed, true);
  assert.equal(on.authorizeSession(remoteOwner, "host-app.install").allowed, true);
  assert.equal(on.authorizeSession(remoteOwner, "obsidian.vault.read").allowed, true);
  assert.equal(on.authorizeSession(remoteOwner, "hermes-agent.update").allowed, true);
  assert.equal(on.authorizeSession(remoteOperator, "secret.write").allowed, false);
  assert.equal(on.authorizeSession(remoteManager, "secret.write").allowed, false);
  assert.equal(on.authorizeSession(remoteOperator, "host-app.install").allowed, false);
  assert.equal(on.authorizeSession(remoteOperator, "hermes-agent.update").allowed, false);
  assert.equal(on.authorizeSession(remoteManager, "host-app.install").allowed, false);
  assert.equal(on.authorizeSession(remoteManager, "hermes-agent.update").allowed, false);
  assert.equal(on.effectiveAccess(remoteOwner).allowedOperations.includes("privileged-config.read"), true);
  assert.equal(on.effectiveAccess(remoteOperator).allowedOperations.includes("secret.write"), false);
  assert.equal(on.effectiveAccess(remoteManager).allowedOperations.includes("secret.write"), false);
});

test("settings HTTP privileged routes respect privilegedOwnerSession not client headers", async (t) => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = <T>(method: string, value: T) => async (...args: unknown[]): Promise<T> => {
    calls.push({ method, args });
    return value;
  };
  const settings = {
    getPrivilegedProfileConfig: record("getPrivilegedProfileConfig", {
      profile: "coder",
      revision: REVISION,
      categories: [],
      fields: [],
      values: {},
      unsupportedCount: 0,
      secretFieldCount: 0,
    }),
    listProfileSecrets: record("listProfileSecrets", {
      profile: "coder",
      revision: REVISION,
      fields: [],
    }),
    writeProfileSecret: record("writeProfileSecret", {
      profile: "coder",
      revision: REVISION,
      fields: [],
    }),
  } as unknown as HermesSettingsAdapter;
  const secretTransfers = new SecretTransferStore({ ttlMs: 30_000, maxPending: 4 });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://office.local");
    const owner = url.searchParams.get("owner") === "1";
    const result = await routeSettingsHttp(
      request,
      url,
      {
        settings,
        secretTransfers,
        privilegedOwnerSession: owner,
      },
      16 * 1024,
    );
    response.writeHead(result.status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  assert.equal((await fetch(`${origin}/api/v1/profiles/coder/privileged-config`)).status, 403);
  assert.equal((await fetch(`${origin}/api/v1/profiles/coder/privileged-config?owner=1`)).status, 200);

  // Remote deposit: body value only; response never echoes secret.
  const deniedDeposit = await fetch(`${origin}/api/v1/secret-transfers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "remote-secret-value" }),
  });
  assert.equal(deniedDeposit.status, 403);

  const deposit = await fetch(`${origin}/api/v1/secret-transfers?owner=1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "remote-secret-value" }),
  });
  assert.equal(deposit.status, 200);
  const depositBody = await deposit.json() as { transferId: string; expiresAt: string };
  assert.equal(typeof depositBody.transferId, "string");
  assert.equal(JSON.stringify(depositBody).includes("remote-secret-value"), false);

  const consume = await fetch(`${origin}/api/v1/profiles/coder/secrets?owner=1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transferId: depositBody.transferId,
      key: "OPENAI_API_KEY",
      source: "env",
      expectedRevision: REVISION,
    }),
  });
  assert.equal(consume.status, 200);
  assert.equal(JSON.stringify(await consume.json()).includes("remote-secret-value"), false);

  const replay = await fetch(`${origin}/api/v1/profiles/coder/secrets?owner=1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transferId: depositBody.transferId,
      key: "OPENAI_API_KEY",
      source: "env",
    }),
  });
  assert.equal(replay.status, 404);

  const write = calls.find((call) => call.method === "writeProfileSecret");
  assert.ok(write);
  assert.equal((write!.args[1] as { value: string }).value, "remote-secret-value");
});
