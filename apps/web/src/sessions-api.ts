import { officeFetchJson } from "./office-api";

export async function deleteStoredSession(
  profileId: string,
  storedSessionId: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const profile = profileId.trim();
  const sessionId = storedSessionId.trim();
  if (!profile || !sessionId) throw new Error("Session identity is incomplete.");
  await officeFetchJson<{ ok: true }>(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}?profile=${encodeURIComponent(profile)}`,
    { method: "DELETE", ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) },
  );
}

export async function deleteStoredSessions(
  profileId: string,
  storedSessionIds: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const profile = profileId.trim();
  const sessionIds = [...new Set(storedSessionIds.map((id) => id.trim()).filter(Boolean))];
  if (!profile || sessionIds.length === 0 || sessionIds.length > 500) {
    throw new Error("Session delete batch is invalid.");
  }
  await officeFetchJson<{ ok: true }>("/api/v1/sessions/bulk-delete", {
    method: "POST",
    body: { profile, sessionIds },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}
