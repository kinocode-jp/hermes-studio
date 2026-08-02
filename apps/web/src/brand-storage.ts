/**
 * Browser storage keys for Hermes Studio, with dual-read of legacy Hermes Studio keys.
 *
 * New keys use the `hermes-studio` prefix. When a new key is missing, values are
 * read from the matching `hermes-office…` key and copied forward so display
 * prefs, locale, and layout survive the rebrand without wiping user data.
 *
 * Cookie names (`hermes_office_session` / `hermes_office_device`) and WebSocket
 * protocol ids stay on the old wire format by design — see office-auth / desktop-transport.
 */

const STUDIO_PREFIX = "hermes-studio";
const LEGACY_PREFIX = "hermes-office";

/** Map a canonical studio storage key to its pre-rebrand legacy key. */
export function legacyStorageKey(studioKey: string): string | undefined {
  if (!studioKey.startsWith(STUDIO_PREFIX)) return undefined;
  return `${LEGACY_PREFIX}${studioKey.slice(STUDIO_PREFIX.length)}`;
}

/** Read localStorage preferring the studio key; migrate from legacy when needed. */
export function readBrandStorage(studioKey: string): string | null {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const current = storage.getItem(studioKey);
    if (current !== null) return current;
    const legacy = legacyStorageKey(studioKey);
    if (legacy === undefined) return null;
    const old = storage.getItem(legacy);
    if (old === null) return null;
    try {
      storage.setItem(studioKey, old);
    } catch {
      // Quota / private mode: still return the legacy value for this session.
    }
    return old;
  } catch {
    return null;
  }
}

/** Write only the canonical studio key. */
export function writeBrandStorage(studioKey: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(studioKey, value);
  } catch {
    // Callers keep in-memory state when storage is blocked.
  }
}

/** Remove both studio and legacy keys when clearing a preference. */
export function removeBrandStorage(studioKey: string): void {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    storage.removeItem(studioKey);
    const legacy = legacyStorageKey(studioKey);
    if (legacy !== undefined) storage.removeItem(legacy);
  } catch {
    // ignore
  }
}
