import { useCallback, useRef, useState } from "react";

interface UsePullToRefreshOptions {
  /** Called when the user pulls past the threshold and releases. May be async;
   *  the spinner stays until the returned promise settles. */
  onRefresh: () => Promise<unknown> | void;
  /** Pull distance (px) required to trigger a refresh. */
  threshold?: number;
  /** Max distance the indicator travels — pulling further has no extra effect. */
  maxPull?: number;
}

/**
 * Touch-driven pull-to-refresh for a scrollable container. Attach `ref` to the
 * element that scrolls and spread `handlers` onto the same element. The pull is
 * only armed when the container is already scrolled to the top, so it never
 * fights an in-progress scroll.
 *
 * Touch-only by design — desktop never fires these events, so it's inert there.
 */
export function usePullToRefresh<T extends HTMLElement>({
  onRefresh,
  threshold = 70,
  maxPull = 110,
}: UsePullToRefreshOptions) {
  const ref = useRef<T | null>(null);
  const startY = useRef<number | null>(null);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const el = ref.current;
      // Only arm when resting at the top and not mid-refresh.
      if (!el || el.scrollTop > 0 || refreshing) {
        startY.current = null;
        return;
      }
      startY.current = e.touches[0].clientY;
    },
    [refreshing],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (startY.current === null || refreshing) return;
      const el = ref.current;
      if (!el) return;
      // If the container scrolled away from the top mid-gesture, bail out so a
      // normal scroll wins.
      if (el.scrollTop > 0) {
        startY.current = null;
        setPullDistance(0);
        return;
      }
      const delta = e.touches[0].clientY - startY.current;
      if (delta <= 0) {
        setPullDistance(0);
        return;
      }
      // Rubber-band resistance so the pull feels heavier the further it goes.
      setPullDistance(Math.min(maxPull, delta * 0.5));
    },
    [maxPull, refreshing],
  );

  const onTouchEnd = useCallback(() => {
    if (startY.current === null) return;
    startY.current = null;
    if (pullDistance >= threshold) {
      setRefreshing(true);
      // Hold the indicator at the threshold while the refresh runs.
      setPullDistance(threshold);
      Promise.resolve(onRefresh()).finally(() => {
        setRefreshing(false);
        setPullDistance(0);
      });
    } else {
      setPullDistance(0);
    }
  }, [pullDistance, threshold, onRefresh]);

  return {
    ref,
    pullDistance,
    refreshing,
    threshold,
    /** Spread onto the same element that `ref` is attached to. */
    handlers: { onTouchStart, onTouchMove, onTouchEnd },
  };
}
