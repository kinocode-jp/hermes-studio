import { signal } from "@preact/signals";
import { readBrandStorage, writeBrandStorage } from "./brand-storage";

const STORAGE_KEY = "hermes-studio:sidebar-project-order:v1";

export const sidebarProjectOrder = signal<string[]>(readOrder());

export function setSidebarProjectOrder(order: readonly string[]): void {
  const next = sanitizeOrder(order);
  sidebarProjectOrder.value = next;
  writeBrandStorage(STORAGE_KEY, JSON.stringify(next));
}

export function moveSidebarProject(projectId: string, targetId: string): void {
  if (!projectId || !targetId || projectId === targetId) return;
  const current = sidebarProjectOrder.value.filter((id) => id !== projectId);
  const targetIndex = current.indexOf(targetId);
  if (targetIndex < 0) {
    setSidebarProjectOrder([...current, projectId]);
    return;
  }
  const next = [...current];
  next.splice(targetIndex, 0, projectId);
  setSidebarProjectOrder(next);
}

export function sortProjectsBySidebarOrder<T extends { key: string }>(projects: readonly T[]): T[] {
  const rank = new Map(sidebarProjectOrder.value.map((id, index) => [id, index]));
  return projects
    .map((project, index) => ({ project, index, rank: rank.get(project.key) }))
    .sort((left, right) => {
      if (left.rank === undefined && right.rank === undefined) return left.index - right.index;
      if (left.rank === undefined) return 1;
      if (right.rank === undefined) return -1;
      return left.rank - right.rank || left.index - right.index;
    })
    .map((entry) => entry.project);
}

export function reconcileSidebarProjectOrder(projectIds: readonly string[]): void {
  const known = new Set(projectIds);
  const preserved = sidebarProjectOrder.value.filter((id) => known.has(id));
  const missing = projectIds.filter((id) => !preserved.includes(id));
  const next = [...preserved, ...missing];
  if (next.length === sidebarProjectOrder.value.length
    && next.every((id, index) => id === sidebarProjectOrder.value[index])) return;
  setSidebarProjectOrder(next);
}

function sanitizeOrder(order: readonly string[]): string[] {
  const seen = new Set<string>();
  return order.filter((id) => {
    if (typeof id !== "string" || !id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function readOrder(): string[] {
  try {
    const raw = readBrandStorage(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? sanitizeOrder(parsed.filter((item): item is string => typeof item === "string"))
      : [];
  } catch {
    return [];
  }
}
