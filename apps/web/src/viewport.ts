/**
 * Phone navigation also applies to compact touch-first foldables. Their inner
 * display or desktop-site viewport can be much wider than the legacy 768px
 * breakpoint even though a desktop sidebar is not usable as primary navigation.
 */
export const PHONE_VIEWPORT_QUERY = "(max-width: 768px), (max-width: 1400px) and (any-pointer: coarse)";

export function isPhoneViewport(): boolean {
  return typeof matchMedia === "function" && matchMedia(PHONE_VIEWPORT_QUERY).matches;
}
