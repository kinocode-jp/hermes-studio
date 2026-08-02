import assert from "node:assert/strict";
import test from "node:test";
import {
  depositSecretTransfer,
  desktopCapabilityHeader,
  isTauriAssetLocation,
  shouldUseDesktopCapability,
} from "../src/desktop-transport.ts";

test("desktop transport is limited to Tauri asset origins", () => {
  assert.equal(isTauriAssetLocation({ protocol: "tauri:", hostname: "localhost" } as Location), true);
  assert.equal(isTauriAssetLocation({ protocol: "https:", hostname: "tauri.localhost" } as Location), true);
  assert.equal(isTauriAssetLocation({ protocol: "http:", hostname: "localhost" } as Location), false);
  assert.equal(isTauriAssetLocation({ protocol: "https:", hostname: "office.example" } as Location), false);
});

test("Tauri dev uses IPC capability while a normal localhost browser keeps cookie auth", () => {
  const devLocation = { protocol: "http:", hostname: "localhost" } as Location;
  assert.equal(shouldUseDesktopCapability(devLocation, true), true);
  assert.equal(shouldUseDesktopCapability(devLocation, false), false);
});

test("attached loopback Office on 127.0.0.1 never uses desktop capability even with Tauri bridge", () => {
  const attached = { protocol: "http:", hostname: "127.0.0.1" } as Location;
  assert.equal(shouldUseDesktopCapability(attached, true), false);
  assert.equal(shouldUseDesktopCapability(attached, false), false);
});

test("desktop capability is sent only through its dedicated header", () => {
  assert.deepEqual(desktopCapabilityHeader(undefined), {});
  assert.deepEqual(desktopCapabilityHeader("a".repeat(64)), {
    "X-Hermes-Office-Desktop-Capability": "a".repeat(64),
  });
});

test("secret deposit is refused outside the Tauri desktop capability surface", async () => {
  const previous = globalThis.location;
  // jsdom/node test harness: deposit requires packaged desktop IPC path.
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { protocol: "http:", hostname: "127.0.0.1" },
  });
  try {
    await assert.rejects(() => depositSecretTransfer("never-in-browser-fetch"), /packaged Hermes Studio desktop|desktop bridge/);
  } finally {
    Object.defineProperty(globalThis, "location", { configurable: true, value: previous });
  }
});
