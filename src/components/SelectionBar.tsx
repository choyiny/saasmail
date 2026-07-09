import { CheckCheck, X, Loader2, ShieldBan } from "lucide-react";
import { cn } from "@/lib/utils";

interface SelectionBarProps {
  count: number;
  busy?: boolean;
  onMarkRead: () => void;
  onBlock?: () => void;
  onClear: () => void;
  className?: string;
}

/**
 * Floating bar that appears above the inbox card when one or more people
 * are selected. Hosts bulk actions (mark read, clear). Sticky-positioned
 * via the parent so it doesn't shift content.
 */
export default function SelectionBar({
  count,
  busy,
  onMarkRead,
  onBlock,
  onClear,
  className,
}: SelectionBarProps) {
  if (count === 0) return null;
  return (
    <div
      data-testid="selection-bar"
      className={cn(
        "flex items-center gap-2 rounded-[8px] bg-text-primary px-3 py-2 text-sm text-white shadow-lg ring-1 ring-text-primary/20",
        className,
      )}
    >
      <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-white/15 px-2 text-xs font-bold tabular-nums">
        {count}
      </span>
      <span className="font-medium">selected</span>

      <span className="mx-1 h-4 w-px bg-white/15" aria-hidden />

      <button
        type="button"
        onClick={onMarkRead}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-[6px] bg-white/[0.08] px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/[0.14] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <CheckCheck size={12} />
        )}
        Mark as read
      </button>

      {onBlock && (
        <button
          type="button"
          onClick={onBlock}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-[6px] bg-white/[0.08] px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/[0.14] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ShieldBan size={12} />
          Block
        </button>
      )}

      <button
        type="button"
        onClick={onClear}
        className="ml-auto inline-flex items-center gap-1 rounded-[6px] px-2 py-1.5 text-xs font-medium text-white/70 transition-colors hover:bg-white/[0.08] hover:text-white"
        aria-label="Clear selection"
      >
        <X size={12} />
        Clear
      </button>
    </div>
  );
}
