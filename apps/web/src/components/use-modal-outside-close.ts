import type { JSX } from "preact";
import { useRef } from "preact/hooks";
import { shouldIgnoreModalOutsideClose } from "../app-modal-layout";

/**
 * Backdrop handlers for "click outside to close" modal layers.
 *
 * Releasing the mouse over the backdrop must only close the modal when the
 * press that produced it also started on the backdrop. Without this guard,
 * pressing inside the dialog (text selection, drags) and releasing outside
 * makes the browser target the synthetic click at the layer — the nearest
 * common ancestor of the press and release targets — which looks identical
 * to a genuine backdrop click (`event.target === event.currentTarget`).
 */
export function useModalOutsideClose(onClose: () => void) {
  const pressStartedOnLayer = useRef(false);

  // Record where the press began in the capture phase: dialogs stop
  // pointerdown propagation, so a bubble-phase listener on the layer would
  // never see presses that start inside the dialog.
  const onPointerDownCapture = (event: JSX.TargetedPointerEvent<HTMLElement>) => {
    pressStartedOnLayer.current = event.target === event.currentTarget;
  };

  const onPointerDown = (event: JSX.TargetedPointerEvent<HTMLElement>) => {
    if (shouldIgnoreModalOutsideClose()) return;
    if (event.target === event.currentTarget) onClose();
  };

  const onClick = (event: JSX.TargetedMouseEvent<HTMLElement>) => {
    if (shouldIgnoreModalOutsideClose()) return;
    if (event.target !== event.currentTarget) return;
    // Pointer-initiated clicks only close when the press began on the layer.
    // detail === 0 covers keyboard / assistive-technology clicks, which have
    // no preceding pointerdown.
    if (!pressStartedOnLayer.current && event.detail !== 0) return;
    onClose();
  };

  return { onPointerDownCapture, onPointerDown, onClick };
}
