import { useEffect, useRef, useState } from "react";

interface UsePullToRefreshOptions {
  /** Called when the user pulls past the threshold and releases. May be async;
   *  the spinner stays until the returned promise settles. When omitted, the
   *  gesture is disabled entirely (no listeners are attached). */
  onRefresh?: () => Promise<unknown> | void;
  /** Pull distance (px) required to trigger a refresh. */
  threshold?: number;
  /** Max distance the indicator travels — pulling further has no extra effect. */
  maxPull?: number;
}

/**
 * Touch-driven pull-to-refresh for a scrollable container. Attach `ref` to the
 * element that scrolls. The pull is only armed when the container is already
 * scrolled to the top, so it never fights an in-progress scroll.
 *
 * The touch listeners are attached natively (not via React's onTouch* props)
 * because React registers touchmove as a *passive* listener — passive listeners
 * can't call preventDefault(), which we need to suppress the browser's own
 * overscroll / pull-to-refresh so ours can take over. Without this the native
 * gesture wins on mobile (Android Chrome reloads the page) and the custom pull
 * appears to do nothing.
 *
 * Touch-only by design — desktop never fires these events, so it's inert there.
 */
export function usePullToRefresh<T extends HTMLElement>({
  onRefresh,
  threshold = 70,
  maxPull = 110,
}: UsePullToRefreshOptions) {
  const ref = useRef<T | null>(null);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // Hold the latest callback so we can re-bind listeners only when the gesture
  // is enabled/disabled, not on every render where onRefresh's identity changes.
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const enabled = typeof onRefresh === "function";

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    // Gesture state kept in closures (not React state) so the move handler can
    // read/write it synchronously without stale-closure surprises.
    let startY: number | null = null;
    let distance = 0;
    let busy = false;

    const onTouchStart = (e: TouchEvent) => {
      // Only arm when resting at the top and not mid-refresh.
      if (el.scrollTop > 0 || busy) {
        startY = null;
        return;
      }
      startY = e.touches[0].clientY;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (startY === null || busy) return;
      // If the container scrolled away from the top mid-gesture, bail out so a
      // normal scroll wins.
      if (el.scrollTop > 0) {
        startY = null;
        distance = 0;
        setPullDistance(0);
        return;
      }
      const delta = e.touches[0].clientY - startY;
      if (delta <= 0) {
        distance = 0;
        setPullDistance(0);
        return;
      }
      // We're actively pulling the list down past its top edge — stop the
      // browser's native overscroll/refresh from stealing the gesture.
      e.preventDefault();
      // Rubber-band resistance so the pull feels heavier the further it goes.
      distance = Math.min(maxPull, delta * 0.5);
      setPullDistance(distance);
    };

    const onTouchEnd = () => {
      if (startY === null) return;
      startY = null;
      if (distance >= threshold) {
        busy = true;
        setRefreshing(true);
        // Hold the indicator at the threshold while the refresh runs.
        setPullDistance(threshold);
        Promise.resolve(onRefreshRef.current?.()).finally(() => {
          busy = false;
          distance = 0;
          setRefreshing(false);
          setPullDistance(0);
        });
      } else {
        distance = 0;
        setPullDistance(0);
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [enabled, threshold, maxPull]);

  return { ref, pullDistance, refreshing, threshold };
}
