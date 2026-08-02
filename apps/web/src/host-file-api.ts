import { officeFetchJson } from "./office-api";

export type HostFileAction = "open" | "reveal";

/** Execute an explicit local-owner file gesture on the Studio host. */
export async function runHostFileAction(path: string, action: HostFileAction): Promise<void> {
  if (!isAbsoluteMediaPath(path)) throw new Error("An absolute media path is required.");
  const response = await officeFetchJson<unknown>("/api/v1/host/fs/open", {
    method: "POST",
    body: { path, action },
  });
  if (response === null || typeof response !== "object" || (response as { ok?: unknown }).ok !== true) {
    throw new Error("The Studio Server returned an invalid local file response.");
  }
}

export function isAbsoluteMediaPath(path: string): boolean {
  return path.length > 1
    && path.length <= 8 * 1024
    && !/[\u0000-\u001f\u007f]/.test(path)
    && (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\"));
}
