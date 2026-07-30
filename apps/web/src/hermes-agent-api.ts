import type {
  HermesAgentUpdateFailure,
  HermesAgentUpdatePhase,
  HermesAgentUpdateStatus,
} from "@hermes-studio/protocol";
import { officeFetchJson } from "./office-api";

export async function loadHermesAgentUpdateStatus(options: { force?: boolean } = {}): Promise<HermesAgentUpdateStatus> {
  const path = options.force
    ? "/api/v1/host/hermes-agent/check"
    : "/api/v1/host/hermes-agent";
  return parseStatus(await officeFetchJson<unknown>(path, options.force ? { method: "POST" } : {}));
}

export async function startHermesAgentUpdate(): Promise<HermesAgentUpdateStatus> {
  return parseStatus(await officeFetchJson<unknown>("/api/v1/host/hermes-agent/update", { method: "POST" }));
}

function parseStatus(value: unknown): HermesAgentUpdateStatus {
  if (!value || typeof value !== "object") throw new Error("Hermes Agent update status is incompatible.");
  const item = value as Partial<HermesAgentUpdateStatus>;
  const phases: readonly HermesAgentUpdatePhase[] = [
    "checking", "up_to_date", "available", "updating", "updated", "blocked", "failed", "unsupported",
  ];
  const failures: readonly HermesAgentUpdateFailure[] = [
    "executable_missing", "check_failed", "update_failed", "update_timeout", "unsupported_install",
  ];
  if (
    !phases.includes(item.phase as HermesAgentUpdatePhase)
    || typeof item.canUpdate !== "boolean"
    || item.updateMethod !== "hermes-update"
    || (item.currentVersion !== undefined && typeof item.currentVersion !== "string")
    || (item.failure !== undefined && !failures.includes(item.failure))
  ) {
    throw new Error("Hermes Agent update status is incompatible.");
  }
  return item as HermesAgentUpdateStatus;
}
