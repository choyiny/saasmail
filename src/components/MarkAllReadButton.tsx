import { CheckCheck } from "lucide-react";

interface MarkAllReadButtonProps {
  /** Number of unread received emails in scope. Renders nothing at 0. */
  unreadCount: number;
  /**
   * What "all" covers, for the tooltip — e.g. `support@example.com` on a
   * person's inbox tab, or the conversation's inbox on a group thread.
   * The button label stays the same either way; only the tooltip narrows it.
   */
  scopeLabel: string;
  onMarkAllRead: () => void;
}

/**
 * The single mark-all-read affordance. Both thread surfaces (a person's
 * inbox tab and a group conversation) render this in the same slot — the
 * trailing end of the header row — so the control doesn't move depending
 * on which kind of thread is open.
 */
export default function MarkAllReadButton({
  unreadCount,
  scopeLabel,
  onMarkAllRead,
}: MarkAllReadButtonProps) {
  if (unreadCount <= 0) return null;

  return (
    <button
      type="button"
      data-testid="mark-all-read"
      onClick={onMarkAllRead}
      title={`Mark all ${unreadCount} unread in ${scopeLabel} as read`}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-[6px] border border-border bg-card px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
    >
      <CheckCheck size={13} />
      Mark all read
      <span className="ml-0.5 rounded-full bg-text-primary/[0.06] px-1.5 text-[10px] font-bold tabular-nums text-text-secondary">
        {unreadCount}
      </span>
    </button>
  );
}
