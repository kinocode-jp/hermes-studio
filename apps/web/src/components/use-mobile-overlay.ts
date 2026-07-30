import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { canRestoreModalFocus, hasOpenModal, isTopmostModal, lockBackgroundElements, registerModal } from "../modal-layer";

export const PHONE_OVERLAY_VIEWPORT = "(max-width: 768px)";
export const COMPACT_OVERLAY_VIEWPORT = "(max-width: 1279px)";
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

type MobileOverlayOptions = {
  kind: "modal" | "route";
  open: boolean;
  onClose(): void;
  viewport?: string;
  /** Keep the SP top/bottom chrome interactive while this overlay is open. */
  preserveMobileRouteChrome?: boolean;
};

type MobileOverlayKind = MobileOverlayOptions["kind"];

export function useMobileOverlay<T extends HTMLElement>({ kind, open, onClose, viewport = PHONE_OVERLAY_VIEWPORT, preserveMobileRouteChrome = false }: MobileOverlayOptions) {
  const [overlayElement, setOverlayElement] = useState<T | null>(null);
  const ref = useCallback((element: T | null) => setOverlayElement(element), []);
  const closeRef = useRef(onClose);
  const [mobileViewport, setMobileViewport] = useState(() => matchesViewport(viewport));
  closeRef.current = onClose;

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(viewport);
    const update = () => setMobileViewport(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [viewport]);

  const active = open && mobileViewport;
  useEffect(() => {
    const overlay = overlayElement;
    if (!active || !overlay) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const unregisterModal = kind === "modal" ? registerModal(overlay) : undefined;
    const overlayRoot = overlay.closest<HTMLElement>(".workspace-drawer") ?? overlay;
    const appShell = overlayRoot.closest<HTMLElement>(".app-shell");
    const background = appShell
      ? mobileOverlayBackgroundElements(overlayRoot, appShell, kind, preserveMobileRouteChrome)
      : [];
    const releaseBackground = lockBackgroundElements(background);

    let disposed = false;
    queueMicrotask(() => {
      if (disposed) return;
      const initial = overlay.querySelector<HTMLElement>("[data-mobile-overlay-initial-focus]")
        ?? focusableElements(overlay)[0]
        ?? overlay;
      initial.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (kind === "modal" ? !isTopmostModal(overlay) : hasOpenModal()) return;
      const nestedModal = event.target instanceof Element
        ? event.target.closest<HTMLElement>('[role="dialog"][aria-modal="true"]')
        : null;
      if (nestedModal && nestedModal !== overlay) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (kind !== "modal" || event.key !== "Tab") return;
      const focusable = focusableElements(overlay);
      if (focusable.length === 0) {
        event.preventDefault();
        overlay.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    overlay.addEventListener("keydown", handleKeyDown);

    return () => {
      disposed = true;
      unregisterModal?.();
      releaseBackground();
      overlay.removeEventListener("keydown", handleKeyDown);
      const shouldRestoreFocus = overlay.contains(document.activeElement);
      if (shouldRestoreFocus && canRestoreModalFocus(previousFocus)) previousFocus?.focus();
    };
  }, [active, kind, overlayElement, preserveMobileRouteChrome]);

  return { ref, active };
}

export function mobileOverlayBackgroundElements(
  overlayRoot: HTMLElement,
  appShell: HTMLElement,
  kind: MobileOverlayKind,
  preserveMobileRouteChrome = false,
): HTMLElement[] {
  const background: HTMLElement[] = [];
  let overlayBranch = overlayRoot;
  const keepRouteChrome = kind === "route" || preserveMobileRouteChrome;
  while (overlayBranch !== appShell) {
    const parent = overlayBranch.parentElement;
    if (!parent) return [];
    for (const sibling of parent.children) {
      if (!(sibling instanceof HTMLElement) || sibling === overlayBranch) continue;
      if (parent === appShell && keepRouteChrome && sibling.hasAttribute("data-mobile-route-chrome")) continue;
      background.push(sibling);
    }
    overlayBranch = parent;
  }
  return background;
}

function matchesViewport(viewport: string): boolean {
  return typeof matchMedia === "function" && matchMedia(viewport).matches;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}
