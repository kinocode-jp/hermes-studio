/**
 * Product brand helpers for Hermes Studio.
 *
 * Canonical env prefix: HERMES_STUDIO_*
 * Canonical state dir:  ~/.hermes-studio
 *
 * Deprecated HERMES_OFFICE_* and ~/.hermes-office remain as read fallbacks so
 * existing host configuration, enrolled devices, and on-disk state keep working.
 * Prefer the new names in docs and new installs.
 */
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STUDIO_DIR_NAME = ".hermes-studio";
/** @deprecated Legacy product state directory; migrated into STUDIO_DIR_NAME when safe. */
const LEGACY_DIR_NAME = ".hermes-office";

let cachedStateHome: string | undefined;

/**
 * Read HERMES_STUDIO_<suffix>, falling back to deprecated HERMES_OFFICE_<suffix>.
 * Empty strings are returned as-is when the preferred key is set.
 */
export function brandEnv(suffix: string, source: NodeJS.ProcessEnv = process.env): string | undefined {
  const studioKey = `HERMES_STUDIO_${suffix}`;
  const legacyKey = `HERMES_OFFICE_${suffix}`;
  if (Object.prototype.hasOwnProperty.call(source, studioKey)) {
    return source[studioKey];
  }
  if (Object.prototype.hasOwnProperty.call(source, legacyKey)) {
    return source[legacyKey];
  }
  return undefined;
}

/** True when the preferred or legacy env equals the string "true". */
export function brandEnvIsTrue(suffix: string, source: NodeJS.ProcessEnv = process.env): boolean {
  return brandEnv(suffix, source) === "true";
}

/**
 * Resolve the product state home directory.
 * When ~/.hermes-studio is missing and ~/.hermes-office exists, rename atomically
 * (same filesystem). If rename fails, keep using the legacy path so device
 * credentials and teams are not abandoned.
 */
export function brandStateHome(): string {
  if (cachedStateHome !== undefined) return cachedStateHome;
  const preferred = join(homedir(), STUDIO_DIR_NAME);
  const legacy = join(homedir(), LEGACY_DIR_NAME);
  if (existsSync(preferred)) {
    cachedStateHome = preferred;
    return preferred;
  }
  if (existsSync(legacy)) {
    try {
      renameSync(legacy, preferred);
      cachedStateHome = preferred;
      return preferred;
    } catch {
      // Cross-device rename or permission issues: keep serving the legacy tree.
      cachedStateHome = legacy;
      return legacy;
    }
  }
  cachedStateHome = preferred;
  return preferred;
}

/** Absolute path under the product state home (creates the directory when needed). */
export function brandStatePath(...segments: string[]): string {
  const home = brandStateHome();
  if (!existsSync(home)) {
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
    } catch {
      // Caller may still succeed if the path is overridden or already writable.
    }
  }
  return join(home, ...segments);
}

/** Test-only: clear the memoized state home (and optional env overrides). */
export function resetBrandStateHomeForTests(): void {
  cachedStateHome = undefined;
}
