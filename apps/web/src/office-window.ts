import { signal } from "@preact/signals";

const STORAGE_KEY = "hermes-studio:office-window:v1";
/** Includes pre-rebrand keys and the older overview-open flag. */
const LEGACY_STORAGE_KEYS = [
  "hermes-office:office-window:v1",
  "hermes-studio.office-overview-open",
  "hermes-office.office-overview-open",
] as const;

export const officeWindowOpen = signal(readOfficeWindowOpen());

export function setOfficeWindowOpen(open: boolean): void {
  officeWindowOpen.value = open;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(open));
  } catch {
    // The window remains usable when storage is unavailable.
  }
}

function readOfficeWindowOpen(): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    const current = localStorage.getItem(STORAGE_KEY);
    if (current !== null) return current !== "false";
    for (const key of LEGACY_STORAGE_KEYS) {
      const legacy = localStorage.getItem(key);
      if (legacy !== null) {
        try { localStorage.setItem(STORAGE_KEY, legacy); } catch { /* best-effort migrate */ }
        return legacy !== "false";
      }
    }
    return true;
  } catch {
    return true;
  }
}
