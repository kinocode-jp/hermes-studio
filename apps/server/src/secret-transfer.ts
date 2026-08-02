/**
 * Bounded in-memory one-shot secret transfer store.
 *
 * Secret bytes are deposited by the desktop-native bridge (desktop capability),
 * never via ordinary browser JSON config DTOs. Each transfer is single-use,
 * TTL-bounded, capacity-bounded, and cleared after consume or expiry.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  SECRET_TRANSFER_ID_PATTERN,
  SECRET_TRANSFER_MAX_PENDING,
  SECRET_TRANSFER_MAX_VALUE_UTF8_BYTES,
  SECRET_TRANSFER_TTL_MS,
} from "@hermes-studio/protocol";

export class SecretTransferError extends Error {
  readonly code: "invalid_request" | "not_found" | "capacity" | "expired";
  constructor(code: SecretTransferError["code"], message: string) {
    super(message);
    this.name = "SecretTransferError";
    this.code = code;
  }
}

export interface SecretTransferDepositResult {
  transferId: string;
  expiresAt: string;
}

interface StoredTransfer {
  id: string;
  value: string;
  createdAtMs: number;
  expiresAtMs: number;
  consumed: boolean;
}

export class SecretTransferStore {
  readonly #pending = new Map<string, StoredTransfer>();
  readonly #ttlMs: number;
  readonly #maxPending: number;
  readonly #maxValueBytes: number;
  readonly #now: () => number;

  constructor(options: {
    ttlMs?: number;
    maxPending?: number;
    maxValueBytes?: number;
    now?: () => number;
  } = {}) {
    this.#ttlMs = clampInt(options.ttlMs ?? SECRET_TRANSFER_TTL_MS, 1_000, 120_000);
    this.#maxPending = clampInt(options.maxPending ?? SECRET_TRANSFER_MAX_PENDING, 1, 64);
    this.#maxValueBytes = clampInt(
      options.maxValueBytes ?? SECRET_TRANSFER_MAX_VALUE_UTF8_BYTES,
      1,
      64 * 1024,
    );
    this.#now = options.now ?? Date.now;
  }

  /** Deposit secret bytes. Returns transfer id only — never echoes the value. */
  deposit(value: unknown): SecretTransferDepositResult {
    this.#purgeExpired();
    if (typeof value !== "string") {
      throw new SecretTransferError("invalid_request", "Secret value must be a string.");
    }
    if (value.includes("\0")) {
      throw new SecretTransferError("invalid_request", "Secret value is invalid.");
    }
    if (Buffer.byteLength(value) > this.#maxValueBytes) {
      throw new SecretTransferError("invalid_request", "Secret value is too large.");
    }
    if (this.#pending.size >= this.#maxPending) {
      throw new SecretTransferError("capacity", "Too many pending secret transfers.");
    }
    const transferId = randomBytes(24).toString("base64url");
    if (!SECRET_TRANSFER_ID_PATTERN.test(transferId)) {
      throw new SecretTransferError("invalid_request", "Failed to allocate transfer id.");
    }
    const createdAtMs = this.#now();
    const expiresAtMs = createdAtMs + this.#ttlMs;
    this.#pending.set(transferId, {
      id: transferId,
      value,
      createdAtMs,
      expiresAtMs,
      consumed: false,
    });
    return {
      transferId,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  /**
   * Consume a transfer exactly once. Returns the secret string and clears storage.
   * Does not throw the secret in error messages.
   */
  consume(transferId: unknown): string {
    this.#purgeExpired();
    if (typeof transferId !== "string" || !SECRET_TRANSFER_ID_PATTERN.test(transferId)) {
      throw new SecretTransferError("invalid_request", "Secret transfer id is invalid.");
    }
    const stored = this.#pending.get(transferId);
    if (stored === undefined) {
      throw new SecretTransferError("not_found", "Secret transfer was not found or already used.");
    }
    if (stored.consumed || stored.expiresAtMs <= this.#now()) {
      this.#forget(transferId);
      throw new SecretTransferError("expired", "Secret transfer expired or was already used.");
    }
    // Constant-time id compare is not required for Map lookup, but reject
    // mismatched length early without leaking storage details.
    if (!safeIdEqual(stored.id, transferId)) {
      throw new SecretTransferError("not_found", "Secret transfer was not found or already used.");
    }
    stored.consumed = true;
    const value = stored.value;
    this.#forget(transferId);
    return value;
  }

  /** Test helper: number of pending transfers after purge. */
  size(): number {
    this.#purgeExpired();
    return this.#pending.size;
  }

  clear(): void {
    for (const id of [...this.#pending.keys()]) this.#forget(id);
  }

  #purgeExpired(): void {
    const now = this.#now();
    for (const [id, entry] of this.#pending) {
      if (entry.consumed || entry.expiresAtMs <= now) this.#forget(id);
    }
  }

  #forget(id: string): void {
    const entry = this.#pending.get(id);
    if (entry === undefined) return;
    // Best-effort overwrite of the string slot before drop (JS strings are
    // immutable; clear the reference so the value is not retained by the map).
    entry.value = "";
    entry.consumed = true;
    this.#pending.delete(id);
  }
}

function safeIdEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.byteLength !== b.byteLength) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
