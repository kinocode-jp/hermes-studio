import { signal } from "@preact/signals";
import { isPhoneViewport } from "./viewport";

const STORAGE_KEY = "hermes-studio:sidebar-layout:v1";

export const SIDEBAR_MIN_WIDTH = 64;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 248;
export const SIDEBAR_ICON_THRESHOLD = 96;

export type SidebarMode = "cards" | "rows";

type SidebarPreferences = {
  width: number;
  mode: SidebarMode;
  tasksOpen: boolean;
  teamsOpen: boolean;
  profilesOpen: boolean;
  openProfileIds: string[];
  openProjectIds: string[];
};

const initial = readPreferences();

export const sidebarWidth = signal(initial.width);
export const sidebarMode = signal<SidebarMode>(initial.mode);
export const sidebarTasksOpen = signal(initial.tasksOpen);
export const sidebarTeamsOpen = signal(initial.teamsOpen);
export const sidebarProfilesOpen = signal(initial.profilesOpen);
export const sidebarOpenProfileIds = signal<string[]>(initial.openProfileIds);
export const sidebarOpenProjectIds = signal<string[]>(initial.openProjectIds);

export function previewSidebarWidth(width: number): void {
  sidebarWidth.value = clampSidebarWidth(width);
}

export function setSidebarWidth(width: number): void {
  previewSidebarWidth(width);
  persistPreferences();
}

export function setSidebarMode(mode: SidebarMode): void {
  sidebarMode.value = mode;
  persistPreferences();
}

export function setSidebarTasksOpen(open: boolean): void {
  sidebarTasksOpen.value = open;
  persistPreferences();
}

export function setSidebarTeamsOpen(open: boolean): void {
  sidebarTeamsOpen.value = open;
  persistPreferences();
}

export function setSidebarProfilesOpen(open: boolean): void {
  sidebarProfilesOpen.value = open;
  persistPreferences();
}

export function isSidebarProfileOpen(profileId: string): boolean {
  return sidebarOpenProfileIds.value.includes(profileId);
}

export function setSidebarProfileOpen(profileId: string, open: boolean): void {
  const key = profileId.trim();
  if (!key) return;
  const current = sidebarOpenProfileIds.value;
  const isOpen = current.includes(key);
  if (open === isOpen) return;
  sidebarOpenProfileIds.value = open
    ? [...current, key]
    : current.filter((id) => id !== key);
  persistPreferences();
}

export function toggleSidebarProfileOpen(profileId: string): void {
  setSidebarProfileOpen(profileId, !isSidebarProfileOpen(profileId));
}

export function isSidebarProjectOpen(projectId: string): boolean {
  return sidebarOpenProjectIds.value.includes(projectId);
}

export function toggleSidebarProjectOpen(projectId: string): void {
  const key = projectId.trim();
  if (!key) return;
  sidebarOpenProjectIds.value = sidebarOpenProjectIds.value.includes(key)
    ? sidebarOpenProjectIds.value.filter((id) => id !== key)
    : [...sidebarOpenProjectIds.value, key];
  persistPreferences();
}

export function isSidebarIconOnly(width = sidebarWidth.value): boolean {
  return width <= SIDEBAR_ICON_THRESHOLD;
}

function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

function readPreferences(): SidebarPreferences {
  const fallback: SidebarPreferences = {
    width: SIDEBAR_DEFAULT_WIDTH,
    mode: "cards",
    tasksOpen: true,
    teamsOpen: true,
    // On phones the profile sheet overlays the whole screen, so it starts closed.
    profilesOpen: !isPhoneViewport(),
    openProfileIds: [],
    openProjectIds: [],
  };
  if (typeof localStorage === "undefined") return fallback;
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<SidebarPreferences> | null;
    return {
      width: clampSidebarWidth(typeof parsed?.width === "number" ? parsed.width : fallback.width),
      mode: parsed?.mode === "rows" ? "rows" : fallback.mode,
      tasksOpen: typeof parsed?.tasksOpen === "boolean" ? parsed.tasksOpen : fallback.tasksOpen,
      teamsOpen: typeof parsed?.teamsOpen === "boolean" ? parsed.teamsOpen : fallback.teamsOpen,
      profilesOpen: typeof parsed?.profilesOpen === "boolean" ? parsed.profilesOpen : fallback.profilesOpen,
      openProfileIds: Array.isArray(parsed?.openProfileIds)
        ? parsed.openProfileIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        : fallback.openProfileIds,
      openProjectIds: Array.isArray(parsed?.openProjectIds)
        ? parsed.openProjectIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        : fallback.openProjectIds,
    };
  } catch {
    return fallback;
  }
}

function persistPreferences(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      width: sidebarWidth.value,
      mode: sidebarMode.value,
      tasksOpen: sidebarTasksOpen.value,
      teamsOpen: sidebarTeamsOpen.value,
      profilesOpen: sidebarProfilesOpen.value,
      openProfileIds: sidebarOpenProfileIds.value,
      openProjectIds: sidebarOpenProjectIds.value,
    } satisfies SidebarPreferences));
  } catch {
    // The sidebar remains usable when storage is unavailable.
  }
}
