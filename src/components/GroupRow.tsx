import { Clock, Paperclip, Pin, Star, Users } from "lucide-react";
import SwipeRow from "@/components/SwipeRow";
import { cn } from "@/lib/utils";
import type { GroupedConversation } from "@/lib/api";
import { avatarColor, initials } from "@/lib/avatar";
import {
  MailActionButtons,
  MailRowMenu,
  type MailActionHandlers,
} from "@/components/MailActions";

function formatTime(ts: number) {
  const date = new Date(ts * 1000);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffH = diffMs / 3_600_000;
  if (diffH < 1) {
    const m = Math.max(1, Math.floor(diffMs / 60_000));
    return `${m}m`;
  }
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  if (diffH < 24 * 7) {
    return date.toLocaleDateString([], { weekday: "short" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function groupLabel(participants: GroupedConversation["participants"]): string {
  if (participants.length === 0) return "Group conversation";
  const names = participants.map((p) => {
    if (p.name && p.name.trim()) return p.name.trim().split(/\s+/)[0];
    return p.email.split("@")[0];
  });
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

interface GroupRowProps {
  group: GroupedConversation;
  isSelected: boolean;
  onSelect: () => void;
  onMarkRead?: (id: string) => void;
  /** Star / pin / archive / snooze handlers (InboxPage). */
  actions?: MailActionHandlers;
}

/**
 * Inbox sidebar row for a multi-participant thread. Renders overlapping
 * avatar circles for the external participants, a comma-separated name
 * list, and the same meta line as PersonList rows (count + time + unread
 * badge). Internal CCs aren't surfaced here — they're scoped to the
 * thread but don't define its identity.
 */
export default function GroupRow({
  group,
  isSelected,
  onSelect,
  onMarkRead,
  /**
   * Compact mode — when the sidebar is dragged narrow, just the avatar
   * stack + unread badge. Hides the name list and meta.
   */
  compact = false,
  actions,
}: GroupRowProps & { compact?: boolean }) {
  const display = groupLabel(group.participants);
  // Show up to 3 avatars in a horizontal stack (each shifted left of the
  // next), with a "+N" pill if the group is bigger. Each circle has a
  // ring matching the row's hover state so the stack reads as one shape.
  const MAX_AVATARS = 3;
  const visible = group.participants.slice(0, MAX_AVATARS);
  const overflow = Math.max(0, group.participants.length - visible.length);
  const AVATAR_SIZE = 32; // h-8 / w-8
  const OVERLAP = 12; // each subsequent avatar starts 10px left → 18px showing
  // Total width of the stack: first avatar full + (n-1) showing OVERLAP each.
  const stackWidth =
    AVATAR_SIZE +
    Math.max(0, visible.length + (overflow > 0 ? 1 : 0) - 1) *
      (AVATAR_SIZE - OVERLAP);

  const unread = group.unreadCount > 0;
  const handlers: MailActionHandlers = {
    ...(actions ?? {}),
    ...(unread && onMarkRead ? { onMarkRead: () => onMarkRead(group.id) } : {}),
  };
  const hasMenu = !compact && !!actions;

  return (
    <SwipeRow
      className="group border-b border-border-subtle"
      innerClassName={cn(
        "transition-colors",
        isSelected
          ? "bg-accent-subtle/70"
          : "[@media(hover:hover)]:hover:bg-bg-subtle",
      )}
      onSwipeLeft={actions?.onArchive}
      onSwipeRight={actions?.onToggleStar}
      archived={!!group.archivedAt}
      starred={group.starred}
    >
      {isSelected && (
        <span
          className="absolute inset-y-0 left-0 w-[3px] bg-accent"
          aria-hidden
        />
      )}
      {unread && !compact && (
        <span
          className="absolute left-[6px] top-[calc(var(--sm-row-pad)+19px)] h-1.5 w-1.5 rounded-full bg-accent"
          aria-hidden
        />
      )}

      <button
        data-testid="group-row"
        data-conversation-id={group.id}
        onClick={onSelect}
        aria-current={isSelected ? "true" : undefined}
        className={cn(
          "flex w-full items-center gap-3 py-[calc(var(--sm-row-pad)+1px)] pl-4 pr-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50",
          compact && "justify-center px-2",
        )}
      >
        {/* Horizontally stacked avatars. */}
        <span
          className="relative shrink-0"
          style={{ width: stackWidth, height: AVATAR_SIZE }}
        >
          {visible.map((p, i) => {
            const color = avatarColor(p.email);
            return (
              <span
                key={p.id}
                title={p.name || p.email}
                className="absolute flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-semibold ring-2 ring-card"
                style={{
                  backgroundColor: color.bg,
                  color: color.fg,
                  left: i * (AVATAR_SIZE - OVERLAP),
                  top: 0,
                  zIndex: 10 - i,
                }}
              >
                {initials(p.name, p.email)}
              </span>
            );
          })}
          {overflow > 0 && (
            <span
              className="absolute flex h-8 w-8 items-center justify-center rounded-full bg-bg-muted text-[11px] font-semibold text-text-secondary ring-2 ring-card"
              style={{
                left: visible.length * (AVATAR_SIZE - OVERLAP),
                top: 0,
                zIndex: 10 - visible.length,
              }}
              title={`+${overflow} more participants`}
            >
              +{overflow}
            </span>
          )}
        </span>

        {!compact && (
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm text-text-primary",
                  unread ? "font-semibold" : "font-medium",
                )}
              >
                <Users size={13} className="shrink-0 text-text-tertiary" />
                <span className="truncate">{display}</span>
              </span>
              <span
                className={cn(
                  "flex shrink-0 items-center gap-1.5 text-xs transition-opacity",
                  unread
                    ? "font-semibold text-accent-subtle-fg"
                    : "text-text-tertiary",
                  hasMenu &&
                    "[@media(hover:hover)]:group-hover:opacity-0 [@media(hover:none)]:mr-8",
                )}
              >
                {group.pinned && (
                  <Pin size={12} className="text-accent" aria-label="Pinned" />
                )}
                {group.snoozedUntil && (
                  <Clock
                    size={12}
                    className="text-warning"
                    aria-label="Snoozed"
                  />
                )}
                {group.starred && (
                  <Star
                    size={13}
                    className="fill-current text-star"
                    aria-label="Starred"
                  />
                )}
                <span className="tabular">{formatTime(group.lastEmailAt)}</span>
              </span>
            </div>

            <div className="mt-0.5 flex items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-[13px] text-text-tertiary">
                <span className="mr-1.5 inline-flex h-[17px] items-center rounded bg-bg-muted px-1 align-[1px] text-[11px] font-medium text-text-secondary">
                  {group.inbox.split("@")[0]}
                </span>
                {group.latestSubject && (
                  <span
                    className={cn(
                      unread
                        ? "font-medium text-text-primary"
                        : "text-text-secondary",
                    )}
                  >
                    {group.latestSubject}
                  </span>
                )}
                {group.latestSubject && group.snippet && (
                  <span aria-hidden> — </span>
                )}
                {group.snippet}
              </p>
              {group.hasAttachment === 1 && (
                <Paperclip
                  size={12}
                  className="shrink-0 text-text-tertiary"
                  aria-label="Has attachment"
                />
              )}
              {unread && (
                <span
                  role="button"
                  tabIndex={0}
                  title="Mark all as read (Shift+I)"
                  aria-label={`${group.unreadCount} unread. Mark all as read`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onMarkRead?.(group.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      onMarkRead?.(group.id);
                    }
                  }}
                  className="tabular flex h-[18px] min-w-[18px] shrink-0 cursor-pointer items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-foreground"
                >
                  {group.unreadCount}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Compact mode: just the unread badge, anchored to the avatar stack. */}
        {compact && unread && (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9.5px] font-semibold text-accent-foreground">
            {group.unreadCount}
          </span>
        )}
      </button>

      {hasMenu && (
        <div className="absolute bottom-1.5 right-2 flex items-center gap-0.5">
          <div className="hidden rounded-lg bg-card/95 shadow-card ring-1 ring-border [@media(hover:hover)]:group-hover:flex [@media(hover:hover)]:group-has-[:focus-visible]:flex">
            <MailActionButtons compact state={group} handlers={handlers} />
            <MailRowMenu state={group} handlers={handlers} />
          </div>
          <MailRowMenu
            state={group}
            handlers={handlers}
            className="-mr-1.5 -mt-0.5 h-10 w-10 [@media(hover:hover)]:hidden"
          />
        </div>
      )}
    </SwipeRow>
  );
}
