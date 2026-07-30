import { readBrandStorage, writeBrandStorage } from "./brand-storage";

export const PROFILE_CHAT_MODAL_LAYOUTS_STORAGE_KEY = "hermes-studio:profile-chat-modal-layouts:v1";
const VERSION = 1;
const MAX_SAVED_PROFILES = 200;
/** Defensive storage bound, not a visible-pane limit. */
const MAX_SAVED_PANES_PER_PROFILE = 256;

export type ProfileChatModalLayout = {
  profileId: string;
  paneSessionIds: string[];
  activeSessionId: string;
};

export type ProfileChatModalLayouts = {
  version: typeof VERSION;
  layouts: ProfileChatModalLayout[];
};

const emptyLayouts = (): ProfileChatModalLayouts => ({ version: VERSION, layouts: [] });

export function normalizeProfileChatModalLayouts(value: unknown): ProfileChatModalLayouts {
  if (!value || typeof value !== "object") return emptyLayouts();
  const record = value as Record<string, unknown>;
  if (record.version !== VERSION || !Array.isArray(record.layouts)) return emptyLayouts();
  const layouts: ProfileChatModalLayout[] = [];
  for (const raw of record.layouts.slice(0, MAX_SAVED_PROFILES)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.profileId !== "string" || item.profileId.length === 0
      || !Array.isArray(item.paneSessionIds)) continue;
    const profileId = item.profileId.slice(0, 64);
    if (layouts.some((layout) => layout.profileId === profileId)) continue;
    const paneSessionIds: string[] = [];
    for (const rawSessionId of item.paneSessionIds) {
      if (typeof rawSessionId !== "string" || rawSessionId.length === 0) continue;
      const sessionId = rawSessionId.slice(0, 256);
      if (!paneSessionIds.includes(sessionId)) paneSessionIds.push(sessionId);
      if (paneSessionIds.length >= MAX_SAVED_PANES_PER_PROFILE) break;
    }
    if (paneSessionIds.length === 0) continue;
    const requestedActiveSessionId = typeof item.activeSessionId === "string"
      ? item.activeSessionId.slice(0, 256)
      : "";
    const activeSessionId = paneSessionIds.includes(requestedActiveSessionId)
      ? requestedActiveSessionId
      : paneSessionIds.at(-1)!;
    layouts.push({ profileId, paneSessionIds, activeSessionId });
  }
  return { version: VERSION, layouts };
}

function readLayouts(): ProfileChatModalLayouts {
  try {
    const raw = readBrandStorage(PROFILE_CHAT_MODAL_LAYOUTS_STORAGE_KEY);
    return raw ? normalizeProfileChatModalLayouts(JSON.parse(raw)) : emptyLayouts();
  } catch {
    return emptyLayouts();
  }
}

let savedLayouts = readLayouts();

export function savedProfileChatModalLayout(profileId: string): ProfileChatModalLayout | undefined {
  const normalizedProfileId = profileId.slice(0, 64);
  const layout = savedLayouts.layouts.find((item) => item.profileId === normalizedProfileId);
  return layout
    ? { ...layout, paneSessionIds: [...layout.paneSessionIds] }
    : undefined;
}

export function saveProfileChatModalLayout(
  profileId: string,
  paneSessionIds: readonly string[],
  activeSessionId: string,
): void {
  const normalizedProfileId = profileId.slice(0, 64);
  const normalized = normalizeProfileChatModalLayouts({
    version: VERSION,
    layouts: [{ profileId: normalizedProfileId, paneSessionIds, activeSessionId }],
  }).layouts[0];
  const retained = savedLayouts.layouts.filter((item) => item.profileId !== normalizedProfileId);
  savedLayouts = normalized
    ? { version: VERSION, layouts: [normalized, ...retained].slice(0, MAX_SAVED_PROFILES) }
    : { version: VERSION, layouts: retained };
  writeBrandStorage(PROFILE_CHAT_MODAL_LAYOUTS_STORAGE_KEY, JSON.stringify(savedLayouts));
}

/** Test helper for isolating the module-level persisted-layout cache. */
export function resetProfileChatModalLayoutsForTests(value?: ProfileChatModalLayouts): void {
  savedLayouts = value ? normalizeProfileChatModalLayouts(value) : emptyLayouts();
}
