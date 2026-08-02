import { signal } from "@preact/signals";
import { readBrandStorage, writeBrandStorage } from "./brand-storage";

const STORAGE_KEY = "hermes-studio:sidebar-profile-order:v1";

export const sidebarProfileOrder = signal<string[]>(readOrder());

export function setSidebarProfileOrder(order: readonly string[]): void {
  const next = sanitizeOrder(order);
  sidebarProfileOrder.value = next;
  writeOrder(next);
}

/** Move `profileId` to the position of `targetId` (insert before/after by index). */
export function moveSidebarProfile(profileId: string, targetId: string): void {
  if (!profileId || !targetId || profileId === targetId) return;
  const current = sidebarProfileOrder.value.filter((id) => id !== profileId);
  const targetIndex = current.indexOf(targetId);
  if (targetIndex < 0) {
    setSidebarProfileOrder([...current, profileId]);
    return;
  }
  const next = [...current];
  next.splice(targetIndex, 0, profileId);
  setSidebarProfileOrder(next);
}

/** Stable sort helper: known ids first in saved order, unknown ids keep relative order after. */
export function sortProfilesBySidebarOrder<T extends { id: string }>(profiles: readonly T[]): T[] {
  const order = sidebarProfileOrder.value;
  if (order.length === 0) return [...profiles];
  const rank = new Map(order.map((id, index) => [id, index]));
  return profiles
    .map((profile, index) => ({ profile, index, rank: rank.get(profile.id) }))
    .sort((a, b) => {
      if (a.rank === undefined && b.rank === undefined) return a.index - b.index;
      if (a.rank === undefined) return 1;
      if (b.rank === undefined) return -1;
      return a.rank - b.rank || a.index - b.index;
    })
    .map((entry) => entry.profile);
}

/** Keep saved order in sync with the live profile set without reordering unknown ids. */
export function reconcileSidebarProfileOrder(profileIds: readonly string[]): void {
  const known = new Set(profileIds);
  const preserved = sidebarProfileOrder.value.filter((id) => known.has(id));
  const missing = profileIds.filter((id) => !preserved.includes(id));
  const next = [...preserved, ...missing];
  if (sameOrder(next, sidebarProfileOrder.value)) return;
  setSidebarProfileOrder(next);
}

function sanitizeOrder(order: readonly string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of order) {
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  return next;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((id, index) => id === b[index]);
}

function readOrder(): string[] {
  try {
    const raw = readBrandStorage(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return sanitizeOrder(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return [];
  }
}

function writeOrder(order: readonly string[]): void {
  writeBrandStorage(STORAGE_KEY, JSON.stringify(order));
}
