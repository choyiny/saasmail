import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_LIST_WIDTH as MAX_WIDTH,
  MIN_LIST_WIDTH as MIN_WIDTH,
  clampListWidth,
  useDefaultLayoutSettings,
} from "@/lib/default-layout-settings";

/** Below this, the list collapses to "compact" mode (just avatars). */
export const COMPACT_THRESHOLD = 110;

/**
 * Resizable-sidebar state. Returns the current width (clamped), a
 * setter for programmatic updates, a boolean for "compact" mode (width
 * below COMPACT_THRESHOLD), and a `startDrag` handler to wire to a
 * resize handle's `onMouseDown` / `onTouchStart`.
 *
 * The width is an account setting (layoutSettings.default.listWidth), so
 * it follows the user to other devices. It is saved once, when a drag ends.
 */
export function useResizableSidebar() {
  const [settings, setLayout] = useDefaultLayoutSettings();
  const savedWidth = clampListWidth(settings.listWidth);
  const [width, setWidth] = useState<number>(savedWidth);
  // Follow the account value (it loads after the first paint, and may
  // change on another device) whenever we're not mid-drag.
  const draggingRef = useRef(false);
  useEffect(() => {
    if (!draggingRef.current) setWidth(savedWidth);
  }, [savedWidth]);
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const startDrag = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault();
      const x = "touches" in e ? e.touches[0].clientX : e.clientX;
      startXRef.current = x;
      startWidthRef.current = width;
      draggingRef.current = true;
      setDragging(true);
    },
    [width],
  );

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent | TouchEvent) {
      const x =
        "touches" in e
          ? (e as TouchEvent).touches[0].clientX
          : (e as MouseEvent).clientX;
      const delta = x - startXRef.current;
      const next = Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, startWidthRef.current + delta),
      );
      setWidth(next);
    }
    function onUp() {
      draggingRef.current = false;
      setDragging(false);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove);
    window.addEventListener("touchend", onUp);
    // Disable text selection during drag so the cursor feels right.
    const prev = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
      document.body.style.userSelect = prev;
      document.body.style.cursor = "";
    };
  }, [dragging]);

  // Save to the account once the drag ends.
  const wasDragging = useRef(false);
  useEffect(() => {
    if (dragging) {
      wasDragging.current = true;
      return;
    }
    if (!wasDragging.current) return;
    wasDragging.current = false;
    if (Math.round(width) !== savedWidth)
      setLayout({ listWidth: Math.round(width) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  return {
    width,
    setWidth,
    dragging,
    startDrag,
    isCompact: width < COMPACT_THRESHOLD,
  };
}
