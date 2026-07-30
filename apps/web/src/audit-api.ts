import { officeFetchJson } from "./office-api";
import type { Operation } from "@hermes-studio/protocol";

type AuthenticationAuditOperation = "auth.local" | "auth.device" | "auth.logout";
export type AccessAuditOperation = AuthenticationAuditOperation | Operation;
export type AccessAuditOutcome = "allowed" | "denied" | "rate_limited";

export type AccessAuditEntry = {
  occurredAt: string;
  operation: AccessAuditOperation;
  outcome: AccessAuditOutcome;
  deviceName: string | null;
  local: boolean;
};

export type AccessAuditSnapshot = {
  records: AccessAuditEntry[];
  currentAccess: { deviceName: string | null; local: boolean } | null;
};

const MAX_AUDIT_RECORDS = 256;
const PROTOCOL_AUDIT_OPERATIONS: Record<Operation, true> = {
  "state.read": true, "chat.session.create": true, "chat.session.archive": true,
  "chat.message.send": true, "chat.run.cancel": true, "chat.approval.permanent": true,
  "kanban.card.create": true, "kanban.card.update": true, "kanban.card.comment": true,
  "profile.create": true, "profile.update": true, "profile.delete": true,
  "team.create": true, "team.update": true, "team.delete": true,
  "memory.update": true, "skill.enable": true, "skill.install": true,
  "global-settings.update": true, "chat-model-preferences.update": true, "local-model-providers.sync": true, "profile-config.update": true,
  "privileged-config.read": true, "privileged-config.update": true,
  "host-app.install": true,
  "host-fs.read": true, "host-fs.open": true, "obsidian.vault.read": true, "hermes-agent.update": true,
  "runtime.start": true, "runtime.stop": true,
  "runtime.configure": true, "secret.write": true, "device.revoke": true, "audit.read": true,
};
const SUPPORTED_AUDIT_OPERATIONS: ReadonlySet<string> = new Set([
  "auth.local", "auth.device", "auth.logout", ...Object.keys(PROTOCOL_AUDIT_OPERATIONS),
]);
const auditListeners = new Set<() => void>();

export async function fetchAccessAudit(): Promise<AccessAuditSnapshot> {
  const response = await officeFetchJson<unknown>("/api/v1/audit");
  return parseAccessAuditResponse(response);
}

export function subscribeAccessAudit(listener: () => void): () => void {
  auditListeners.add(listener);
  return () => auditListeners.delete(listener);
}

export function notifyAccessAuditChanged(): void {
  for (const listener of auditListeners) {
    try {
      listener();
    } catch {
      // One settings surface must not prevent the others from refreshing.
    }
  }
}

export function shouldRefreshAccessAudit(payload: unknown): boolean {
  if (!isRecord(payload) || !isRecord(payload.audit)) return true;
  return payload.audit.operation !== "audit.read";
}

export function parseAccessAuditResponse(value: unknown): AccessAuditSnapshot {
  if (!isRecord(value) || !Array.isArray(value.records) || value.records.length > MAX_AUDIT_RECORDS) {
    throw new Error("監査ログの応答形式が正しくありません。");
  }

  const chronological = value.records.flatMap((candidate): AccessAuditEntry[] => {
    if (!isRecord(candidate)) return [];
    const operation = safeOperation(candidate.operation);
    const outcome = safeOutcome(candidate.outcome);
    const occurredAt = safeTimestamp(candidate.occurredAt);
    const deviceName = safeDeviceName(candidate.deviceName);
    if (operation === undefined || outcome === undefined || occurredAt === undefined || deviceName === undefined || typeof candidate.local !== "boolean") {
      return [];
    }
    return [{ occurredAt, operation, outcome, deviceName, local: candidate.local }];
  });

  const currentRecord = [...chronological].reverse().find((record) => record.operation === "audit.read" && record.outcome === "allowed");
  return {
    records: chronological.reverse(),
    currentAccess: currentRecord === undefined
      ? null
      : {
          deviceName: currentRecord.deviceName,
          local: currentRecord.local,
        },
  };
}

function safeOperation(value: unknown): AccessAuditOperation | undefined {
  return typeof value === "string" && SUPPORTED_AUDIT_OPERATIONS.has(value)
    ? value as AccessAuditOperation
    : undefined;
}

function safeOutcome(value: unknown): AccessAuditOutcome | undefined {
  return value === "allowed" || value === "denied" || value === "rate_limited" ? value : undefined;
}

function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

function safeDeviceName(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 64 || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
