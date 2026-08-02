import assert from "node:assert/strict";
import test from "node:test";
import type { Operation } from "@hermes-studio/protocol";
import type { OfficeSnapshot } from "../src/domain.ts";
import { canMutateSettingsTab, settingsMutationAccess } from "../src/settings-access.ts";
import { preserveConcurrentDraft } from "../src/settings-draft.ts";

function snapshot(allowedOperations: Operation[], tier: "operator" | "manager" | "owner", exposure: "loopback" | "tailnet", authentication?: "local-cookie" | "device-cookie" | "desktop-capability"): OfficeSnapshot {
  return {
    generatedAt: "2026-07-16T00:00:00.000Z",
    sequence: 1,
    capabilities: {
      protocolVersion: 1,
      serverVersion: "0.2.0",
      runtime: { state: "ready" },
      access: {
        deviceId: "device-1",
        tier,
        exposure,
        authentication: authentication ?? (exposure === "loopback" ? "local-cookie" : "device-cookie"),
        allowedOperations,
      },
    },
    profiles: [],
    sessions: [],
    inventory: { profiles: emptyPage(), sessions: emptyPage() },
    boards: [],
  };
}

function emptyPage() { return { returned: 0, available: 0, total: 0, hasMore: false, truncated: false, partialFailures: 0 }; }

const PRIVILEGED_OPS: Operation[] = [
  "privileged-config.read",
  "privileged-config.update",
  "secret.write",
];

test("settings mutations fail closed for a remote operator snapshot", () => {
  const access = settingsMutationAccess(snapshot(
    ["state.read", "chat.session.create", "chat.message.send", "kanban.card.update"],
    "operator",
    "tailnet",
  ));

  assert.deepEqual(access, {
    global: false,
    skill: false,
    soul: false,
    project: false,
    memory: false,
    config: false,
    privileged: false,
    hostApps: false,
    hermesUpdate: false,
    obsidianVaults: false,
    localOwner: false,
    hostAdmin: false,
  });
  assert.equal(canMutateSettingsTab(access, "privileged"), false);
  // Project overview stays writable: its only editor is the device-local
  // display-name alias, which needs no server operation.
  assert.equal(canMutateSettingsTab(access, "project"), true);
});

test("privileged follows server allowedOperations for local owner and remote owner", () => {
  const localOwnerNoPriv = settingsMutationAccess(snapshot(
    ["state.read", "global-settings.update", "skill.enable", "profile.update", "memory.update", "profile-config.update"],
    "owner",
    "loopback",
    "local-cookie",
  ));
  assert.equal(localOwnerNoPriv.privileged, false);
  assert.equal(localOwnerNoPriv.localOwner, true);

  const localOwnerWithPriv = settingsMutationAccess(snapshot(
    [
      "state.read",
      "global-settings.update",
      "skill.enable",
      "profile.update",
      "memory.update",
      "profile-config.update",
      ...PRIVILEGED_OPS,
    ],
    "owner",
    "loopback",
    "local-cookie",
  ));
  assert.equal(localOwnerWithPriv.privileged, true);
  assert.equal(canMutateSettingsTab(localOwnerWithPriv, "privileged"), true);

  // Remote owner with privileged ops advertised (flag on + enrolled owner device).
  const remoteOwner = settingsMutationAccess(snapshot(
    ["state.read", ...PRIVILEGED_OPS],
    "owner",
    "tailnet",
    "device-cookie",
  ));
  assert.equal(remoteOwner.privileged, true);
  assert.equal(remoteOwner.hostApps, false);
  assert.equal(remoteOwner.obsidianVaults, false);
  assert.equal(remoteOwner.hostAdmin, false);
  assert.equal(canMutateSettingsTab(remoteOwner, "privileged"), true);

  // Remote owner without privileged ops (flag off) stays closed.
  const remoteOwnerNoFlag = settingsMutationAccess(snapshot(
    ["state.read", "chat.message.send"],
    "owner",
    "tailnet",
    "device-cookie",
  ));
  assert.equal(remoteOwnerNoFlag.privileged, false);
  assert.equal(remoteOwnerNoFlag.hostApps, false);

  const remoteOwnerWithHostApps = settingsMutationAccess(snapshot(
    ["state.read", ...PRIVILEGED_OPS, "host-app.install", "obsidian.vault.read"],
    "owner",
    "tailnet",
    "device-cookie",
  ));
  assert.equal(remoteOwnerWithHostApps.hostApps, true);
  assert.equal(remoteOwnerWithHostApps.obsidianVaults, true);

  const desktopOwner = settingsMutationAccess(snapshot(
    ["state.read", ...PRIVILEGED_OPS, "host-app.install", "obsidian.vault.read", "device.revoke", "audit.read"],
    "owner",
    "loopback",
    "desktop-capability",
  ));
  assert.equal(desktopOwner.privileged, true);
  assert.equal(desktopOwner.hostApps, true);
  assert.equal(desktopOwner.obsidianVaults, true);
  assert.equal(desktopOwner.hostAdmin, true);
});

test("settings mutations remain disabled until a validated snapshot exists", () => {
  assert.deepEqual(settingsMutationAccess(undefined), {
    global: false,
    skill: false,
    soul: false,
    project: false,
    memory: false,
    config: false,
    privileged: false,
    hostApps: false,
    hermesUpdate: false,
    obsidianVaults: false,
    localOwner: false,
    hostAdmin: false,
  });
});

test("late save responses normalize only the submitted draft and preserve newer input", () => {
  assert.equal(preserveConcurrentDraft("submitted", "submitted", "normalized"), "normalized");
  assert.equal(preserveConcurrentDraft("newer input", "submitted", "normalized"), "newer input");
  assert.equal(preserveConcurrentDraft(false, false, true), true);
  assert.equal(preserveConcurrentDraft(true, false, true), true);
});
