import { useRef, useState, type ReactNode } from "react";
import { Archive, ArchiveRestore, Star } from "lucide-react";
import { cn } from "@/lib/utils";

const TRIGGER = 84;
const MAX = 150;

/**
 * An inbox list row that can be swiped on touch screens: swipe left to
 * archive, right to star. Mouse and pen input are ignored, so desktop
 * rows behave exactly as before. Vertical scrolling stays native
 * (`touch-action: pan-y`); a swipe only engages once the finger has
 * clearly moved sideways.
 */
export default function SwipeRow({
  className,
  innerClassName,
  children,
  onSwipeLeft,
  onSwipeRight,
  archived,
  starred,
}: {
  className?: string;
  innerClassName?: string;
  children: ReactNode;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  archived?: boolean;
  starred?: boolean;
}) {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; lock: boolean | null } | null>(
    null,
  );
  const swiped = useRef(false);
  const enabled = !!(onSwipeLeft || onSwipeRight);

  const reset = () => {
    start.current = null;
    setDx(0);
  };

  return (
    <li
      className={cn("relative overflow-hidden", className)}
      style={enabled ? { touchAction: "pan-y" } : undefined}
      onPointerDown={(e) => {
        if (!enabled || e.pointerType !== "touch") return;
        swiped.current = false;
        start.current = { x: e.clientX, y: e.clientY, lock: null };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        const mx = e.clientX - s.x;
        const my = e.clientY - s.y;
        if (s.lock === null) {
          if (Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my) * 1.5)
            s.lock = true;
          else if (Math.abs(my) > 10) {
            reset();
            return;
          }
        }
        if (!s.lock) return;
        let next = Math.max(-MAX, Math.min(MAX, mx));
        if (next < 0 && !onSwipeLeft) next = 0;
        if (next > 0 && !onSwipeRight) next = 0;
        setDx(next);
      }}
      onPointerUp={() => {
        if (!start.current) return;
        if (start.current.lock) swiped.current = true;
        if (dx <= -TRIGGER) onSwipeLeft?.();
        else if (dx >= TRIGGER) onSwipeRight?.();
        reset();
      }}
      onPointerCancel={reset}
      onClickCapture={(e) => {
        // A swipe ends with a click on the row; don't open it.
        if (swiped.current) {
          swiped.current = false;
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      {dx !== 0 && (
        <div
          aria-hidden
          className={cn(
            "absolute inset-0 flex items-center px-6 text-[13px] font-medium",
            dx < 0
              ? "justify-end bg-success-subtle text-success"
              : "justify-start bg-warning-bg text-star",
          )}
        >
          <span
            className={cn(
              "flex items-center gap-2 transition-transform",
              Math.abs(dx) >= TRIGGER ? "scale-110" : "opacity-70",
            )}
          >
            {dx < 0 ? (
              archived ? (
                <>
                  <ArchiveRestore size={18} /> Move to inbox
                </>
              ) : (
                <>
                  <Archive size={18} /> Archive
                </>
              )
            ) : (
              <>
                <Star size={18} className={cn(!starred && "fill-current")} />
                {starred ? "Unstar" : "Star"}
              </>
            )}
          </span>
        </div>
      )}
      <div
        className={cn("relative bg-card", innerClassName)}
        style={{
          transform: dx ? `translateX(${dx}px)` : undefined,
          transition: dx === 0 ? "transform 0.18s var(--sm-ease)" : "none",
        }}
      >
        {children}
      </div>
    </li>
  );
}
