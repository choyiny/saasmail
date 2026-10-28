import { useMemo } from "react";
import { BellOff, Clock } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { snoozePresets } from "@/hooks/useMailList";

/**
 * Keyboard snooze picker (the "b" shortcut). Number keys pick a preset;
 * arrows and Enter work too since every option is a button.
 */
export default function SnoozeDialog({
  open,
  onClose,
  onPick,
  snoozed,
  subject,
}: {
  open: boolean;
  onClose: () => void;
  /** Unix seconds, or null to wake the conversation. */
  onPick: (until: number | null) => void;
  /** Whether the target is already snoozed (adds "Unsnooze"). */
  snoozed?: boolean;
  /** What is being snoozed, e.g. a name or "3 conversations". */
  subject: string;
}) {
  // Recomputed per open so "Later today" is relative to now.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const presets = useMemo(() => snoozePresets(), [open]);
  const pick = (until: number | null) => {
    onPick(until);
    onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="max-w-sm gap-3 p-4"
        onKeyDown={(e) => {
          const n = Number(e.key);
          if (n >= 1 && n <= presets.length) {
            e.preventDefault();
            pick(presets[n - 1].until);
          } else if (e.key === "0" && snoozed) {
            e.preventDefault();
            pick(null);
          }
        }}
      >
        <div className="pr-6">
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <Clock size={15} className="text-text-secondary" aria-hidden />
            Snooze until…
          </DialogTitle>
          <DialogDescription className="mt-0.5 truncate text-[13px]">
            {subject} comes back to the inbox then.
          </DialogDescription>
        </div>
        <div className="flex flex-col gap-0.5" role="group">
          {presets.map((p, i) => (
            <button
              key={p.id}
              type="button"
              autoFocus={i === 0}
              onClick={() => pick(p.until)}
              className="flex h-10 items-center gap-3 rounded-lg px-2.5 text-left text-sm text-text-primary transition-colors hover:bg-bg-muted focus-visible:bg-bg-muted focus-visible:outline-none"
            >
              <kbd className="grid h-5 min-w-5 place-items-center rounded border border-border bg-bg-subtle font-sans text-[11px] text-text-secondary">
                {i + 1}
              </kbd>
              <span className="flex-1 font-medium">{p.label}</span>
              <span className="tabular text-xs text-text-tertiary">
                {new Date(p.until * 1000).toLocaleString([], {
                  weekday: "short",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            </button>
          ))}
          {snoozed && (
            <button
              type="button"
              onClick={() => pick(null)}
              className="flex h-10 items-center gap-3 rounded-lg px-2.5 text-left text-sm text-text-primary transition-colors hover:bg-bg-muted focus-visible:bg-bg-muted focus-visible:outline-none"
            >
              <kbd className="grid h-5 min-w-5 place-items-center rounded border border-border bg-bg-subtle font-sans text-[11px] text-text-secondary">
                0
              </kbd>
              <BellOff size={14} className="text-text-secondary" />
              <span className="flex-1 font-medium">Unsnooze</span>
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
