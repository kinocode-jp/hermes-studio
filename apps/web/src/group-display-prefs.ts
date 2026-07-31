import { signal } from "@preact/signals";

const SIDEBAR_KEY = "hermes-studio:sidebar-group-mode:v1";
const OFFICE_KEY = "hermes-studio:office-group-mode:v1";

/** Flat Profiles list vs team-grouped roster. Default is Profiles. */
export type GroupDisplayMode = "profiles" | "teams";

const VALID: readonly GroupDisplayMode[] = ["profiles", "teams"];

export const sidebarGroupMode = signal<GroupDisplayMode>(readMode(SIDEBAR_KEY));
export const officeGroupMode = signal<GroupDisplayMode>(readMode(OFFICE_KEY));

export function setSidebarGroupMode(mode: GroupDisplayMode): void {
  if (!VALID.includes(mode)) return;
  sidebarGroupMode.value = mode;
  persistMode(SIDEBAR_KEY, mode);
}

export function setOfficeGroupMode(mode: GroupDisplayMode): void {
  if (!VALID.includes(mode)) return;
  officeGroupMode.value = mode;
  persistMode(OFFICE_KEY, mode);
}

/** Parse a stored preference string; unknown/legacy values fall back to Profiles. */
export function parseGroupDisplayMode(value: unknown): GroupDisplayMode {
  return value === "teams" ? "teams" : "profiles";
}

function readMode(key: string): GroupDisplayMode {
  if (typeof localStorage === "undefined") return "profiles";
  try {
    return parseGroupDisplayMode(localStorage.getItem(key));
  } catch {
    return "profiles";
  }
}

function persistMode(key: string, mode: GroupDisplayMode): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, mode);
  } catch {
    // Preferences are best-effort.
  }
}
