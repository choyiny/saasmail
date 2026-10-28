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
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-card px-3 text-[13px] font-medium text-text-primary shadow-card ring-1 ring-inset ring-border-strong transition-colors hover:bg-bg-subtle"
    >
      <CheckCheck size={14} className="text-text-secondary" />
      Mark all read
      <span className="tabular ml-0.5 rounded-full bg-accent-subtle px-1.5 text-[11px] font-semibold text-accent-subtle-fg">
        {unreadCount}
      </span>
    </button>
  );
}
