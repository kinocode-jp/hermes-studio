import { signal } from "@preact/signals";
import type { SettingsTab, Surface } from "./domain";

const STORAGE_KEY = "hermes-studio:ui-nav:v1";
const VERSION = 1;

const SURFACES: readonly Surface[] = ["office", "kanban", "teams", "library", "settings", "scheduled"];
const SETTINGS_TABS: readonly SettingsTab[] = ["global", "project", "skills", "soul", "memory", "config", "privileged", "host"];

export type UiNavPreferences = {
  version: typeof VERSION;
  surface: Surface;
  settingsTab: SettingsTab;
  selectedProfileId: string;
};

const defaults: UiNavPreferences = {
  version: VERSION,
  surface: "office",
  settingsTab: "global",
  selectedProfileId: "",
};

const initial = readUiNavPreferences();

export const restoredActiveSurface = initial.surface;
export const restoredSettingsTab = initial.settingsTab;
export const restoredSelectedProfileId = initial.selectedProfileId;

/** Signal used only to force re-read after external reset (tests). */
export const uiNavRevision = signal(0);

export function readUiNavPreferences(storage: Pick<Storage, "getItem"> | null = availableStorage()): UiNavPreferences {
  if (!storage) return { ...defaults };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return { ...defaults };
    return normalizeUiNavPreferences(JSON.parse(raw));
  } catch {
    return { ...defaults };
  }
}

export function normalizeUiNavPreferences(value: unknown): UiNavPreferences {
  if (!value || typeof value !== "object") return { ...defaults };
  const record = value as Record<string, unknown>;
  if (record.version !== VERSION) return { ...defaults };
  let surface = SURFACES.includes(record.surface as Surface) ? (record.surface as Surface) : defaults.surface;
  let settingsTab = SETTINGS_TABS.includes(record.settingsTab as SettingsTab)
    ? (record.settingsTab as SettingsTab)
    : defaults.settingsTab;
  // "library" was a mislabeled global-settings entry.
  if (surface === "library") {
    surface = "office";
    settingsTab = "global";
  }
  // Settings is a header modal now, not a restorable main surface.
  if (surface === "settings") {
    surface = "office";
  }
  // Settings modal only hosts global/host; profile tabs open from each profile modal.
  if (settingsTab !== "global" && settingsTab !== "host") {
    settingsTab = "global";
  }
  const selectedProfileId = typeof record.selectedProfileId === "string"
    ? record.selectedProfileId.slice(0, 64)
    : "";
  return { version: VERSION, surface, settingsTab, selectedProfileId };
}

export function persistUiNavPreferences(input: {
  surface: Surface;
  settingsTab: SettingsTab;
  selectedProfileId: string;
}, storage: Pick<Storage, "setItem"> | null = availableStorage()): boolean {
  if (!storage) return false;
  try {
    const payload: UiNavPreferences = {
      version: VERSION,
      surface: input.surface,
      settingsTab: input.settingsTab,
      selectedProfileId: input.selectedProfileId.trim().slice(0, 64),
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function availableStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
