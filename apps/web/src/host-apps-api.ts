import type { HostAppFailure, HostAppPhase, HostAppStatus } from "@hermes-studio/protocol";
import { officeFetchJson } from "./office-api";

export async function loadObsidianStatus(): Promise<HostAppStatus> {
  return parseHostAppStatus(await officeFetchJson<unknown>("/api/v1/host/apps/obsidian"));
}

export async function installObsidian(): Promise<HostAppStatus> {
  return parseHostAppStatus(await officeFetchJson<unknown>("/api/v1/host/apps/obsidian/install", { method: "POST" }));
}

function parseHostAppStatus(value: unknown): HostAppStatus {
  if (!value || typeof value !== "object") throw new Error("Host application status is incompatible.");
  const item = value as Partial<HostAppStatus>;
  const phases: readonly HostAppPhase[] = ["available", "installing", "installed", "blocked", "failed", "unsupported"];
  const failures: readonly HostAppFailure[] = ["homebrew_missing", "unsupported_platform", "install_failed", "install_timeout"];
  if (item.id !== "obsidian" || item.name !== "Obsidian"
    || !phases.includes(item.phase as HostAppPhase)
    || typeof item.installed !== "boolean"
    || typeof item.canInstall !== "boolean"
    || item.installMethod !== "homebrew-cask"
    || (item.failure !== undefined && !failures.includes(item.failure))) {
    throw new Error("Host application status is incompatible.");
  }
  return item as HostAppStatus;
}
