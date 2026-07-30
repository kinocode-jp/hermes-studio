import assert from "node:assert/strict";
import test from "node:test";
import { runSessionDeletionBatch } from "../src/session-deletion.ts";

test("session deletion uses bounded parallelism and reports each completion", async () => {
  const items = Array.from({ length: 9 }, (_, index) => index);
  const progress: number[] = [];
  let active = 0;
  let peak = 0;
  const result = await runSessionDeletionBatch(items, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
  }, {
    concurrency: 4,
    onProgress: (value) => progress.push(value.completed),
  });

  assert.equal(peak, 4);
  assert.deepEqual(progress, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(result.deleted, items);
  assert.deepEqual(result.failed, []);
});

test("session deletion continues after failures and preserves result order", async () => {
  const deletedImmediately: number[] = [];
  const result = await runSessionDeletionBatch([1, 2, 3, 4], async (item) => {
    if (item === 2 || item === 4) throw new Error("delete failed");
  }, {
    concurrency: 2,
    onDeleted: (item) => deletedImmediately.push(item),
  });

  assert.deepEqual(result.deleted, [1, 3]);
  assert.deepEqual(result.failed, [2, 4]);
  assert.deepEqual(deletedImmediately.sort(), [1, 3]);
});
