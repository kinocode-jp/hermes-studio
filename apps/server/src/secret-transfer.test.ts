import assert from "node:assert/strict";
import test from "node:test";
import { SecretTransferError, SecretTransferStore } from "./secret-transfer.js";

test("secret transfer is single-use and never re-consumable", () => {
  const store = new SecretTransferStore({ ttlMs: 30_000, maxPending: 4 });
  const deposited = store.deposit("super-secret-value");
  assert.equal(typeof deposited.transferId, "string");
  assert.equal(store.size(), 1);
  const value = store.consume(deposited.transferId);
  assert.equal(value, "super-secret-value");
  assert.equal(store.size(), 0);
  assert.throws(() => store.consume(deposited.transferId), (error: unknown) => {
    assert.ok(error instanceof SecretTransferError);
    assert.equal(error.code, "not_found");
    assert.equal(error.message.includes("super-secret-value"), false);
    return true;
  });
});

test("secret transfer expires by TTL", () => {
  let now = 1_000;
  const store = new SecretTransferStore({ ttlMs: 1_000, maxPending: 4, now: () => now });
  const deposited = store.deposit("ttl-secret");
  now = 2_001;
  assert.throws(() => store.consume(deposited.transferId), (error: unknown) => {
    assert.ok(error instanceof SecretTransferError);
    assert.ok(error.code === "expired" || error.code === "not_found");
    assert.equal(error.message.includes("ttl-secret"), false);
    return true;
  });
  assert.equal(store.size(), 0);
});

test("secret transfer enforces capacity and rejects invalid values", () => {
  const store = new SecretTransferStore({ ttlMs: 30_000, maxPending: 2, maxValueBytes: 8 });
  store.deposit("a");
  store.deposit("b");
  assert.throws(() => store.deposit("c"), (error: unknown) => {
    assert.ok(error instanceof SecretTransferError);
    assert.equal(error.code, "capacity");
    return true;
  });
  assert.throws(() => store.deposit("too-long-value"), (error: unknown) => {
    assert.ok(error instanceof SecretTransferError);
    assert.equal(error.code, "invalid_request");
    return true;
  });
  assert.throws(() => store.deposit("a\0b"), (error: unknown) => {
    assert.ok(error instanceof SecretTransferError);
    assert.equal(error.code, "invalid_request");
    return true;
  });
  assert.throws(() => store.deposit(1 as unknown as string), (error: unknown) => {
    assert.ok(error instanceof SecretTransferError);
    assert.equal(error.code, "invalid_request");
    return true;
  });
  assert.throws(() => store.consume("not-a-valid-id"), (error: unknown) => {
    assert.ok(error instanceof SecretTransferError);
    assert.equal(error.code, "invalid_request");
    return true;
  });
});

test("empty-string deposit is allowed for secret clear transfers", () => {
  const store = new SecretTransferStore({ ttlMs: 30_000, maxPending: 4 });
  const deposited = store.deposit("");
  assert.equal(store.consume(deposited.transferId), "");
  assert.equal(store.size(), 0);
});
