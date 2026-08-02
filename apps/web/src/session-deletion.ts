export type SessionDeletionProgress = {
  completed: number;
  total: number;
  deleted: number;
  failed: number;
};

export type SessionDeletionBatchOptions<T> = {
  concurrency?: number;
  onDeleted?(item: T): void;
  onProgress?(progress: SessionDeletionProgress): void;
};

/** Run durable deletes with bounded parallelism while preserving result order. */
export async function runSessionDeletionBatch<T>(
  items: readonly T[],
  deleteOne: (item: T) => Promise<void>,
  options: SessionDeletionBatchOptions<T> = {},
): Promise<{ deleted: T[]; failed: T[] }> {
  if (items.length === 0) return { deleted: [], failed: [] };

  const requestedConcurrency = options.concurrency ?? 1;
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.min(items.length, Math.floor(requestedConcurrency)))
    : 1;
  const outcomes = new Array<"deleted" | "failed">(items.length);
  let cursor = 0;
  let completed = 0;
  let deleted = 0;
  let failed = 0;

  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index]!;
      try {
        await deleteOne(item);
        outcomes[index] = "deleted";
        deleted += 1;
        options.onDeleted?.(item);
      } catch {
        outcomes[index] = "failed";
        failed += 1;
      } finally {
        completed += 1;
        options.onProgress?.({ completed, total: items.length, deleted, failed });
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return {
    deleted: items.filter((_, index) => outcomes[index] === "deleted"),
    failed: items.filter((_, index) => outcomes[index] === "failed"),
  };
}
