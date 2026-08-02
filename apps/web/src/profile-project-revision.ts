import { signal } from "@preact/signals";

/** Invalidates the sidebar's aggregate view after a profile project mutation. */
export const profileProjectsRevision = signal(0);

export function notifyProfileProjectsChanged(): void {
  profileProjectsRevision.value += 1;
}
