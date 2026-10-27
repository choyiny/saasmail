import { useMemo } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Paperclip,
  CheckCheck,
  RefreshCw,
  Pin,
  Star,
  Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type GroupedItem,
  type GroupedPerson,
  type GroupedConversation,
} from "@/lib/api";
import GroupRow from "@/components/GroupRow";
import SwipeRow from "@/components/SwipeRow";
import {
  MailActionButtons,
  MailRowMenu,
  type MailActionHandlers,
} from "@/components/MailActions";
import { avatarColor, initials } from "@/lib/avatar";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";

interface PersonListProps {
  /** Mixed list of person + group rows from /api/people/grouped. */
  items: GroupedItem[];
  loading: boolean;
  total: number;
  pageSize: number;
  page: number;
  onPageChange: (page: number) => void;
  selectedPersonId: string | null;
  selectedConversationId: string | null;
  onSelectPerson: (person: GroupedPerson) => void;
  onSelectConversation: (conv: GroupedConversation) => void;
  /** Admins get the `person-kebab-menu` test id on the row menu. */
  isAdmin?: boolean;
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
  onMarkPersonRead?: (id: string) => void;
  onMarkConversationRead?: (id: string) => void;
  /**
   * Pull-to-refresh handler (mobile). When provided, pulling down from the top
   * of the list re-fetches it. May be async; the spinner waits on the promise.
   */
  onRefresh?: () => Promise<unknown> | void;
  /**
   * When true, person rows collapse to just the avatar + unread badge
   * — the same shape group rows use in compact mode. Driven by the
   * resizable sidebar dropping below COMPACT_THRESHOLD.
   */
  compact?: boolean;
  /**
   * Star / pin / archive / snooze / trash handlers for a row (InboxPage).
   * In Trash these are Restore and, for admins, Delete forever.
   */
  mailActions?: (item: GroupedItem) => MailActionHandlers;
  /** Shown when the list is empty (depends on the folder). */
  emptyMessage?: string;
}

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
    return date.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  if (diffH < 24 * 7) {
    return date.toLocaleDateString([], { weekday: "short" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function PersonList({
  items,
  loading,
  total,
  pageSize,
  page,
  onPageChange,
  selectedPersonId,
  selectedConversationId,
  onSelectPerson,
  onSelectConversation,
  isAdmin,
  selectedIds,
  onToggleSelected,
  onMarkPersonRead,
  onMarkConversationRead,
  onRefresh,
  compact = false,
  mailActions,
  emptyMessage,
}: PersonListProps) {
  // Mobile pull-to-refresh on the scrollable list. No-op when onRefresh isn't
  // provided (e.g. the handler is wired through from InboxPage).
  const {
    ref: scrollRef,
    pullDistance,
    refreshing,
    threshold,
  } = usePullToRefresh<HTMLDivElement>({ onRefresh });
  const pullActive = pullDistance > 0 || refreshing;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Quick predicates for the union mapping below.
  const persons = items.filter(
    (it): it is GroupedPerson => it.type === "person",
  );
  void persons; // eslint shut-up; we use it conceptually below

  const showingRange = useMemo(() => {
    if (total === 0) return "0";
    const start = (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    return `${start}-${end} of ${total}`;
  }, [total, page, pageSize]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header strip — count only; search lives in the page toolbar above.
          Hidden in compact mode, where it would be wider than the avatars. */}
      {!compact && (
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-4">
          <span className="font-label text-text-tertiary">Conversations</span>
          <span className="tabular text-xs text-text-tertiary">
            {showingRange}
          </span>
        </div>
      )}

      {/* Scrollable list — independent of the right pane */}
      <div
        ref={scrollRef}
        className="smooth-scroll relative min-h-0 flex-1 overflow-y-auto"
        style={onRefresh ? { overscrollBehaviorY: "contain" } : undefined}
      >
        {/* Pull-to-refresh indicator (mobile). */}
        {onRefresh && pullActive && (
          <div
            className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center"
            style={{
              height: pullDistance,
              opacity: Math.min(1, pullDistance / threshold),
            }}
          >
            <RefreshCw
              size={18}
              className={cn("text-text-tertiary", refreshing && "animate-spin")}
              style={
                refreshing
                  ? undefined
                  : {
                      transform: `rotate(${(pullDistance / threshold) * 270}deg)`,
                    }
              }
            />
          </div>
        )}
        <div
          style={{
            transform: pullActive ? `translateY(${pullDistance}px)` : undefined,
            transition:
              pullDistance === 0 ? "transform 0.2s ease-out" : undefined,
          }}
        >
          {loading && items.length === 0 ? (
            <ListSkeleton compact={compact} />
          ) : items.length === 0 ? (
            <div className="pt-empty py-20">
              <p className="font-medium text-text-primary">
                {emptyMessage ?? "No conversations here"}
              </p>
              <p className="text-[13px]">
                Try a different search, or wait for new mail.
              </p>
            </div>
          ) : (
            <ul
              className={cn(
                // Clear the phone's floating Compose button.
                "pb-24 sm:pb-0",
                loading && "opacity-60 transition-opacity",
              )}
            >
              {items.map((item) => {
                if (item.type === "group") {
                  return (
                    <GroupRow
                      key={`g_${item.id}`}
                      group={item}
                      isSelected={selectedConversationId === item.id}
                      onSelect={() => onSelectConversation(item)}
                      onMarkRead={onMarkConversationRead}
                      compact={compact}
                      actions={mailActions?.(item)}
                    />
                  );
                }
                const person = item;
                const isSelected = selectedPersonId === person.id;
                const isChecked = selectedIds?.has(person.id) ?? false;
                const selectionMode = selectedIds !== undefined;
                const anySelected = (selectedIds?.size ?? 0) > 0;
                const color = avatarColor(person.email);
                const display = person.name || person.email;
                const unread = person.unreadCount > 0;
                const handlers: MailActionHandlers = {
                  ...(mailActions?.(person) ?? {}),
                  ...(unread && onMarkPersonRead
                    ? { onMarkRead: () => onMarkPersonRead(person.id) }
                    : {}),
                };
                const hasMenu = !compact && Object.keys(handlers).length > 0;
                return (
                  <SwipeRow
                    key={person.id}
                    className="group border-b border-border-subtle"
                    innerClassName={cn(
                      "transition-colors",
                      isSelected
                        ? "bg-accent-subtle/70"
                        : isChecked
                          ? "bg-accent-subtle/40"
                          : "[@media(hover:hover)]:hover:bg-bg-subtle",
                    )}
                    onSwipeLeft={handlers.onArchive}
                    onSwipeRight={handlers.onToggleStar}
                    archived={!!person.archivedAt}
                    starred={person.starred}
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
                      data-testid="person-row"
                      data-person-id={person.id}
                      onClick={() => onSelectPerson(person)}
                      aria-current={isSelected ? "true" : undefined}
                      className={cn(
                        "flex w-full items-center gap-3 py-[calc(var(--sm-row-pad)+1px)] pl-4 pr-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50",
                        compact && "justify-center px-2",
                      )}
                    >
                      {/* Avatar slot. On hover (or while anything is
                          selected) the avatar turns into a checkbox. */}
                      <span className="relative flex h-9 w-9 shrink-0 items-center justify-center">
                        <span
                          className={cn(
                            "flex h-9 w-9 items-center justify-center rounded-full text-[12px] font-semibold",
                            selectionMode &&
                              !compact &&
                              (anySelected || isChecked
                                ? "hidden"
                                : "[@media(hover:hover)]:group-hover:hidden"),
                          )}
                          style={{ backgroundColor: color.bg, color: color.fg }}
                        >
                          {initials(person.name, person.email)}
                        </span>
                        {selectionMode && !compact && (
                          <span
                            role="checkbox"
                            aria-checked={isChecked}
                            aria-label={`Select ${display}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleSelected?.(person.id);
                            }}
                            className={cn(
                              "h-9 w-9 cursor-pointer items-center justify-center",
                              anySelected || isChecked
                                ? "flex"
                                : "hidden [@media(hover:hover)]:group-hover:flex",
                            )}
                          >
                            <span
                              className={cn(
                                "flex h-[18px] w-[18px] items-center justify-center rounded-[5px] border transition-colors",
                                isChecked
                                  ? "border-accent bg-accent text-accent-foreground"
                                  : "border-border-strong bg-card hover:border-text-tertiary",
                              )}
                            >
                              {isChecked && (
                                <svg
                                  className="h-3 w-3"
                                  viewBox="0 0 12 12"
                                  fill="none"
                                >
                                  <path
                                    d="M2.5 6.5L4.75 8.75L9.5 4"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  />
                                </svg>
                              )}
                            </span>
                          </span>
                        )}
                        {compact && unread && (
                          <span
                            className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9.5px] font-semibold text-accent-foreground ring-2 ring-card"
                            aria-label={`${person.unreadCount} unread`}
                          >
                            {person.unreadCount}
                          </span>
                        )}
                      </span>

                      {/* Two lines: who + when, then what. Counts and
                          inboxes live in the reading pane and Table view. */}
                      <div
                        className={cn("min-w-0 flex-1", compact && "hidden")}
                      >
                        <div className="flex items-baseline gap-2">
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate text-sm",
                              unread
                                ? "font-semibold text-text-primary"
                                : "font-medium text-text-primary",
                            )}
                          >
                            {display}
                            {person.name && (
                              <span className="ml-1.5 text-[13px] font-normal text-text-tertiary">
                                {person.email}
                              </span>
                            )}
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
                            {person.pinned && (
                              <Pin
                                size={12}
                                className="text-accent"
                                aria-label="Pinned"
                              />
                            )}
                            {person.snoozedUntil && (
                              <Clock
                                size={12}
                                className="text-warning"
                                aria-label="Snoozed"
                              />
                            )}
                            {person.starred && (
                              <Star
                                size={13}
                                className="fill-current text-star"
                                aria-label="Starred"
                              />
                            )}
                            <span className="tabular">
                              {formatTime(person.lastEmailAt)}
                            </span>
                          </span>
                        </div>

                        <div className="mt-0.5 flex items-center gap-2">
                          <p className="min-w-0 flex-1 truncate text-[13px] text-text-tertiary">
                            {person.latestSubject && (
                              <span
                                className={cn(
                                  unread
                                    ? "font-medium text-text-primary"
                                    : "text-text-secondary",
                                )}
                              >
                                {person.latestSubject}
                              </span>
                            )}
                            {person.latestSubject && person.snippet && (
                              <span aria-hidden> — </span>
                            )}
                            {person.snippet}
                            {!person.latestSubject && !person.snippet && (
                              <span>
                                {person.totalCount} email
                                {person.totalCount !== 1 ? "s" : ""}
                              </span>
                            )}
                          </p>
                          {person.hasAttachment === 1 && (
                            <Paperclip
                              size={12}
                              className="shrink-0 text-text-tertiary"
                              aria-label="Has attachment"
                            />
                          )}
                          {/* Click the unread badge to mark all read. */}
                          {unread && (
                            <span
                              role="button"
                              tabIndex={0}
                              data-testid="person-unread-badge"
                              title="Mark all as read (Shift+I)"
                              aria-label={`${person.unreadCount} unread. Mark all as read`}
                              onClick={(e) => {
                                e.stopPropagation();
                                onMarkPersonRead?.(person.id);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  onMarkPersonRead?.(person.id);
                                }
                              }}
                              className="group/badge tabular flex h-[18px] min-w-[18px] shrink-0 cursor-pointer items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-foreground transition-transform active:scale-95"
                            >
                              <span className="group-hover/badge:hidden">
                                {person.unreadCount}
                              </span>
                              <CheckCheck
                                size={12}
                                className="hidden group-hover/badge:block"
                              />
                            </span>
                          )}
                        </div>
                      </div>
                    </button>

                    {hasMenu && (
                      <div className="absolute bottom-1.5 right-2 flex items-center gap-0.5">
                        {/* Desktop hover bar */}
                        <div className="hidden rounded-lg bg-card/95 shadow-card ring-1 ring-border [@media(hover:hover)]:group-hover:flex [@media(hover:hover)]:group-has-[:focus-visible]:flex">
                          <MailActionButtons
                            compact
                            state={person}
                            handlers={handlers}
                          />
                          <MailRowMenu
                            state={person}
                            handlers={handlers}
                            testId={isAdmin ? "person-kebab-menu" : undefined}
                            personId={person.id}
                          />
                        </div>
                        {/* Touch: the menu, with a full-size hit area */}
                        <MailRowMenu
                          state={person}
                          handlers={handlers}
                          className="-mr-1.5 -mt-0.5 h-10 w-10 [@media(hover:hover)]:hidden"
                        />
                      </div>
                    )}
                  </SwipeRow>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {totalPages > 1 && (
        <div className="flex h-11 shrink-0 items-center justify-between border-t border-border px-3 max-sm:pr-[88px]">
          <button
            onClick={() => onPageChange(Math.max(1, page - 1))}
            disabled={page <= 1}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label="Previous page"
          >
            <ChevronLeft size={15} />
          </button>
          <span className="tabular text-xs text-text-tertiary">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label="Next page"
          >
            <ChevronRight size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function ListSkeleton({ compact }: { compact: boolean }) {
  return (
    <ul aria-label="Loading conversations" aria-busy="true">
      {Array.from({ length: 9 }).map((_, i) => (
        <li
          key={i}
          className="flex items-start gap-3 border-b border-border-subtle px-4 py-3"
        >
          <span className="pt-skel h-9 w-9 shrink-0 rounded-full" />
          {!compact && (
            <span className="flex flex-1 flex-col gap-2 pt-1">
              <span
                className="pt-skel h-3"
                style={{ width: `${55 + ((i * 17) % 30)}%` }}
              />
              <span
                className="pt-skel h-2.5"
                style={{ width: `${70 + ((i * 11) % 25)}%` }}
              />
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
