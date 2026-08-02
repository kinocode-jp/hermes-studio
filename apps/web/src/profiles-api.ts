import { officeFetchJson, OfficeHttpError } from "./office-api";

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class ProfileCreateCommitUnconfirmedError extends Error {
  constructor() {
    super("Hermes may have created this profile; refresh before retrying.");
    this.name = "ProfileCreateCommitUnconfirmedError";
  }
}

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_PATTERN.test(name.trim());
}

/** Create a Hermes profile (cloned from default's config/skills). */
export async function createHermesProfile(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!isValidProfileName(trimmed)) throw new Error("Profile name is invalid.");
  try {
    await officeFetchJson<{ ok: true }>("/api/v1/profiles", {
      method: "POST",
      body: { name: trimmed, cloneFromDefault: true },
    });
  } catch (error) {
    // Profile create is not safely replayable after dispatch. The server uses
    // 409 only for an ambiguous create outcome; reconcile inventory instead.
    if (error instanceof OfficeHttpError && error.status === 409) {
      throw new ProfileCreateCommitUnconfirmedError();
    }
    throw error;
  }
}

/** Permanently delete a Hermes profile and its local state. */
export async function deleteHermesProfile(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!isValidProfileName(trimmed) || trimmed === "default") throw new Error("Profile name is invalid.");
  await officeFetchJson<{ ok: true }>(`/api/v1/profiles/${encodeURIComponent(trimmed)}`, { method: "DELETE" });
}
