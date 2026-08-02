import assert from "node:assert/strict";
import test from "node:test";
import type { ProfileSummary } from "@hermes-studio/protocol";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import { HermesInventoryCache } from "./hermes-inventory.js";
import { routeInventoryHttp } from "./inventory-http.js";

test("Office inventory route keeps active generations across snapshots and expires them explicitly", async () => {
  let now = 1_000;
  const cache = new HermesInventoryCache({ ttlMs: 500, maxGenerations: 2, now: () => now });
  const first = cache.replace({
    profiles: Array.from({ length: 101 }, (_, index) => profile(index)),
    sessions: [],
    profilesState: { total: 101, truncated: false, partialFailures: 0 },
    sessionsState: { total: 0, truncated: false, partialFailures: 0 },
  });
  const source = { inventoryPage: async (kind: "profiles" | "sessions", cursor: string, limit: number) => cache.page(kind, cursor, limit) } as unknown as HermesRuntimeSource;
  const cursor = first.metadata.profiles.nextCursor!;
  const valid = await routeInventoryHttp(source, new URL(`http://office.local/api/v1/inventory?kind=profiles&limit=100&cursor=${cursor}`));
  assert.equal(valid.status, 200);
  assert.deepEqual((valid.body as { profiles: ProfileSummary[] }).profiles.map((item) => item.id), ["profile-100"]);

  const ambiguous = await routeInventoryHttp(source, new URL(`http://office.local/api/v1/inventory?kind=profiles&kind=sessions&cursor=${cursor}`));
  assert.equal(ambiguous.status, 400);
  cache.replace({ profiles: [], sessions: [], profilesState: { total: 0, truncated: false, partialFailures: 0 }, sessionsState: { total: 0, truncated: false, partialFailures: 0 } });
  const stillValid = await routeInventoryHttp(source, new URL(`http://office.local/api/v1/inventory?kind=profiles&cursor=${cursor}`));
  assert.equal(stillValid.status, 200);
  now += 501;
  const stale = await routeInventoryHttp(source, new URL(`http://office.local/api/v1/inventory?kind=profiles&cursor=${cursor}`));
  assert.equal(stale.status, 409);
});

test("identical snapshots reuse one cursor generation without consuming the generation bound", async () => {
  const cache = new HermesInventoryCache({ maxGenerations: 1 });
  const inventory = {
    profiles: Array.from({ length: 101 }, (_, index) => profile(index)),
    sessions: [],
    profilesState: { total: 101, truncated: false, partialFailures: 0 },
    sessionsState: { total: 0, truncated: false, partialFailures: 0 },
  };
  const first = cache.replace(inventory);
  const second = cache.replace(inventory);
  assert.equal(second.metadata.profiles.nextCursor, first.metadata.profiles.nextCursor);
  assert.deepEqual(cache.page("profiles", first.metadata.profiles.nextCursor!, 100).profiles.map((item) => item.id), ["profile-100"]);
});

function profile(index: number): ProfileSummary {
  return { id: `profile-${index}`, name: `Profile ${index}`, avatarKey: `profile-${index}`, activity: "idle", activeSessionCount: 0, inheritedSkillCount: 0, ownSkillCount: 0, revision: 1 };
}
