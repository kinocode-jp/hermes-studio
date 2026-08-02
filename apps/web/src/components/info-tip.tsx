import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { t } from "../i18n";

type InfoTipProps = {
  text: string;
  /** Horizontal anchor of the bubble relative to the trigger. */
  align?: "start" | "center" | "end";
  /** Vertical side the bubble opens toward; use "bottom" near the top edge. */
  side?: "top" | "bottom";
};

type BubblePosition = {
  top: number;
  left: number;
  /** Resolved side after flipping for viewport edges; drives the pointer/arrow direction. */
  side: "top" | "bottom";
};

const BUBBLE_MARGIN = 8;
const VIEWPORT_PADDING = 10;
const BUBBLE_MAX_WIDTH = 300;

/**
 * Small info trigger that reveals its explanation on hover, focus, or tap.
 *
 * The bubble is portaled to document.body and positioned with `position: fixed`
 * from the trigger's live bounding rect, then clamped to the viewport. This
 * keeps it fully visible even inside scrollable/overflow-clipped containers
 * such as modals, side panels, or narrow columns, where a plain CSS-anchored
 * absolute bubble would otherwise be cut off.
 */
export function InfoTip({ text, align = "center", side = "top" }: InfoTipProps) {
  const bubbleId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [clickOpen, setClickOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [position, setPosition] = useState<BubblePosition | null>(null);
  // Click toggles a persistent open state; hover is a fine-pointer-only preview,
  // matching the previous CSS `:hover` convenience behavior.
  const open = clickOpen || hovered;

  useEffect(() => {
    if (!clickOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (rootRef.current?.contains(target) || bubbleRef.current?.contains(target))) return;
      setClickOpen(false);
      triggerRef.current?.blur();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [clickOpen]);

  // Recompute the fixed position whenever the bubble opens, on scroll/resize
  // anywhere in the document (captures scrollable ancestors too), and once
  // the bubble itself has rendered so its real measured width/height are used.
  useLayoutEffect(() => {
    if (!open) return;
    const recompute = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const triggerRect = trigger.getBoundingClientRect();
      const bubbleRect = bubbleRef.current?.getBoundingClientRect();
      const bubbleWidth = bubbleRect?.width ?? Math.min(BUBBLE_MAX_WIDTH, window.innerWidth * 0.72);
      const bubbleHeight = bubbleRect?.height ?? 0;

      let resolvedSide = side;
      const fitsAbove = triggerRect.top - BUBBLE_MARGIN - bubbleHeight >= VIEWPORT_PADDING;
      const fitsBelow = triggerRect.bottom + BUBBLE_MARGIN + bubbleHeight <= window.innerHeight - VIEWPORT_PADDING;
      // Flip to whichever side actually fits; prefer the requested side when both/neither fit.
      if (resolvedSide === "top" && !fitsAbove && fitsBelow) resolvedSide = "bottom";
      else if (resolvedSide === "bottom" && !fitsBelow && fitsAbove) resolvedSide = "top";

      const top = resolvedSide === "top"
        ? triggerRect.top - BUBBLE_MARGIN - bubbleHeight
        : triggerRect.bottom + BUBBLE_MARGIN;

      const anchorLeft = align === "start"
        ? triggerRect.left
        : align === "end"
          ? triggerRect.right - bubbleWidth
          : triggerRect.left + triggerRect.width / 2 - bubbleWidth / 2;

      const maxLeft = window.innerWidth - VIEWPORT_PADDING - bubbleWidth;
      const minLeft = VIEWPORT_PADDING;
      const left = Math.min(Math.max(anchorLeft, minLeft), Math.max(minLeft, maxLeft));
      const clampedTop = Math.min(Math.max(top, VIEWPORT_PADDING), window.innerHeight - VIEWPORT_PADDING - bubbleHeight);

      setPosition({ top: clampedTop, left, side: resolvedSide });
    };

    recompute();
    // A second pass after paint picks up the bubble's real measured size.
    const raf = requestAnimationFrame(recompute);
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
    };
  }, [open, align, side]);

  return (
    <span ref={rootRef} class={`info-tip info-tip--${align} info-tip--${side} ${open ? "is-open" : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        class="info-tip__trigger"
        aria-label={t("common.info")}
        aria-describedby={bubbleId}
        aria-expanded={open}
        onClick={(event) => setClickOpen((value) => {
          if (value) event.currentTarget.blur();
          return !value;
        })}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse" && matchMedia("(hover: hover) and (pointer: fine)").matches) setHovered(true);
        }}
        onPointerLeave={() => setHovered(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setClickOpen(false);
            setHovered(false);
            event.currentTarget.blur();
          }
        }}
      >i</button>
      {open && typeof document !== "undefined" && createPortal(
        <span
          ref={bubbleRef}
          role="tooltip"
          id={bubbleId}
          class={`info-tip__bubble info-tip__bubble--portal is-open ${position ? "is-positioned" : ""}`}
          style={position ? { top: `${position.top}px`, left: `${position.left}px` } : undefined}
          onClick={() => { setClickOpen(false); setHovered(false); }}
        >{text}</span>,
        document.body,
      )}
    </span>
  );
}
