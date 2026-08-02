import type { ChatPromptResult, ChatSteerResult } from "./chat-api";

const RPC_REJECTED = Symbol("rpc-rejected");
const RPC_COMMIT_UNCONFIRMED = Symbol("rpc-commit-unconfirmed");
const RPC_SESSION_IN_USE = Symbol("rpc-session-in-use");
const RPC_SESSION_LIMIT = Symbol("rpc-session-limit");

type ExplicitRpcRejection = Error & { [RPC_REJECTED]: true };
type CommitUnconfirmedRpcError = Error & { [RPC_COMMIT_UNCONFIRMED]: true };
type SessionInUseRpcError = Error & { [RPC_REJECTED]: true; [RPC_SESSION_IN_USE]: true };
type SessionLimitRpcError = Error & { [RPC_REJECTED]: true; [RPC_SESSION_LIMIT]: true };

export function explicitRpcRejection(message: string): ExplicitRpcRejection {
  return Object.assign(new Error(message), { [RPC_REJECTED]: true as const });
}

export function commitUnconfirmedRpcError(message: string): CommitUnconfirmedRpcError {
  return Object.assign(new Error(message), { [RPC_COMMIT_UNCONFIRMED]: true as const });
}

export function sessionInUseRpcError(message: string): SessionInUseRpcError {
  return Object.assign(new Error(message), { [RPC_REJECTED]: true as const, [RPC_SESSION_IN_USE]: true as const });
}

export function sessionLimitRpcError(message: string): SessionLimitRpcError {
  return Object.assign(new Error(message), { [RPC_REJECTED]: true as const, [RPC_SESSION_LIMIT]: true as const });
}

export function isExplicitRpcRejection(error: unknown): error is ExplicitRpcRejection {
  return typeof error === "object" && error !== null && RPC_REJECTED in error;
}

export function isCommitUnconfirmedRpcError(error: unknown): error is CommitUnconfirmedRpcError {
  return typeof error === "object" && error !== null && RPC_COMMIT_UNCONFIRMED in error;
}

export function isSessionInUseRpcError(error: unknown): error is SessionInUseRpcError {
  return typeof error === "object" && error !== null && RPC_SESSION_IN_USE in error;
}

export function isSessionLimitRpcError(error: unknown): error is SessionLimitRpcError {
  return typeof error === "object" && error !== null && RPC_SESSION_LIMIT in error;
}

export function isCommitUnconfirmedRpcFrame(error: Record<string, unknown>): boolean {
  const data = asRecord(error.data);
  return error.code === -32008 || data?.reason === "commit_unconfirmed";
}

export function normalizePromptResult(value: unknown): ChatPromptResult | undefined {
  const result = resultRecord(value);
  return result?.status === "streaming" ? { status: "accepted" } : undefined;
}

export function interruptResultWasAccepted(value: unknown): boolean {
  return resultRecord(value)?.status === "interrupted";
}

export function interactionResultWasAccepted(method: "approval.respond" | "clarify.respond", value: unknown): boolean {
  const result = resultRecord(value);
  return method === "approval.respond" ? result?.resolved === true : result?.status === "ok";
}

export function normalizeSteerResult(value: unknown): ChatSteerResult {
  const result = resultRecord(value);
  if (result?.status === "queued") return { status: "queued" };
  if (result?.status === "turn_ended") return { status: "turn-ended" };
  if (result?.status === "rejected") return { status: "rejected" };
  return { status: "invalid" };
}

function resultRecord(value: unknown): Record<string, unknown> | undefined {
  const outer = asRecord(value);
  return asRecord(outer?.value) ?? outer;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
