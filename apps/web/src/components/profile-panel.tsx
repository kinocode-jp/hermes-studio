import { createSession, openMobileWorkspace } from "../store";

/** Create a chat session for the profile and surface the mobile workspace when needed. */
export function createProfileSession(profileId: string): boolean {
  const sessionId = createSession(profileId);
  if (sessionId === undefined) return false;
  openMobileWorkspace();
  return true;
}
