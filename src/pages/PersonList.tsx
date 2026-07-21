import { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  Paperclip,
  MoreHorizontal,
  Trash2,
  CheckCheck,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  deletePerson,
  type GroupedItem,
  type GroupedPerson,
  type GroupedConversation,
} from "@/lib/api";
import GroupRow from "@/components/GroupRow";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";

interface PersonListProps {
  /** Mixed list of person + group rows from /api/people/grouped. */
  items: GroupedItem[];
  /** Replaces the items list (used for optimistic delete). */
  setItems: (items: GroupedItem[]) => void;
  loading: boolean;
  total: number;
  pageSize: number;
  page: number;
  onPageChange: (page: number) => void;
  selectedPersonId: string | null;
  selectedConversationId: string | null;
  onSelectPerson: (person: GroupedPerson) => void;
  onSelectConversation: (conv: GroupedConversation) => void;
  onPersonDeleted?: (personId: string) => void;
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
}

// Deterministic pastel-on-violet palette per person initial.
const AVATAR_PALETTE = [
  { bg: "rgba(124, 92, 252, 0.12)", fg: "#5b3ce6" },
  { bg: "rgba(34, 197, 94, 0.12)", fg: "#15803d" },
  { bg: "rgba(244, 114, 182, 0.14)", fg: "#be185d" },
  { bg: "rgba(251, 146, 60, 0.14)", fg: "#c2410c" },
  { bg: "rgba(56, 189, 248, 0.14)", fg: "#0369a1" },
  { bg: "rgba(168, 85, 247, 0.14)", fg: "#7e22ce" },
  { bg: "rgba(20, 184, 166, 0.14)", fg: "#0f766e" },
  { bg: "rgba(234, 179, 8, 0.16)", fg: "#a16207" },
];

function avatarColor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
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

function initials(name: string | null, email: string) {
  const source = name || email.split("@")[0];
  const parts = source.split(/[\s.\-_]+/).filter(Boolean);
  const letters = (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "");
  return letters.toUpperCase() || "?";
}

export default function PersonList({
  items,
  setItems,
  loading,
  total,
  pageSize,
  page,
  onPageChange,
  selectedPersonId,
  selectedConversationId,
  onSelectPerson,
  onSelectConversation,
  onPersonDeleted,
  isAdmin,
  selectedIds,
  onToggleSelected,
  onMarkPersonRead,
  onMarkConversationRead,
  onRefresh,
  compact = false,
}: PersonListProps) {
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(
    null,
  );
  const menuRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    if (!menuOpenId) return;
    function handleClose(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenId(null);
      }
    }
    document.addEventListener("mousedown", handleClose);
    document.addEventListener("scroll", () => setMenuOpenId(null), true);
    return () => {
      document.removeEventListener("mousedown", handleClose);
      document.removeEventListener("scroll", () => setMenuOpenId(null), true);
    };
  }, [menuOpenId]);

  async function handleDeletePerson(person: GroupedPerson) {
    setMenuOpenId(null);
    if (
      !confirm(
        `Permanently delete ${person.name || person.email} and all ${person.totalCount} email${person.totalCount !== 1 ? "s" : ""}? This cannot be undone.`,
      )
    )
      return;
    await deletePerson(person.id);
    setItems(
      items.filter((it) => !(it.type === "person" && it.id === person.id)),
    );
    onPersonDeleted?.(person.id);
  }

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
          In compact mode the strip would be wider than the visible avatars,
          so we hide it to keep the column tidy. */}
      {!compact && (
        <div className="flex shrink-0 items-center justify-between border-b border-border bg-bg-subtle/70 px-4 py-2.5 backdrop-blur-sm">
          <span className="text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
            People
          </span>
          <span className="text-[11px] tabular-nums text-text-tertiary">
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
        {/* Pull-to-refresh indicator (mobile). Sits above the list; the list
            content slides down to reveal it as the user pulls. */}
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
          {loading ? (
            <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center">
              <p className="text-sm font-light text-text-tertiary">Loading…</p>
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
              <p className="text-sm font-medium text-text-primary">
                No people found
              </p>
              <p className="text-xs font-light text-text-tertiary">
                Try a different search, or wait for new mail.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
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
                    />
                  );
                }
                const person = item;
                const isSelected = selectedPersonId === person.id;
                const isChecked = selectedIds?.has(person.id) ?? false;
                const selectionMode = selectedIds !== undefined;
                const anySelected = (selectedIds?.size ?? 0) > 0;
                const menuOpen = menuOpenId === person.id;
                const color = avatarColor(person.email);
                const display = person.name || person.email;
                return (
                  <li
                    key={person.id}
                    className={cn(
                      "group relative transition-colors",
                      isSelected
                        ? "bg-text-primary/[0.04]"
                        : isChecked
                          ? "bg-violet/[0.04]"
                          : "hover:bg-text-primary/[0.025]",
                    )}
                  >
                    {isSelected && (
                      <span
                        className="absolute inset-y-2 left-0 w-0.5 rounded-full"
                        style={{ backgroundColor: "#7c5cfc" }}
                        aria-hidden
                      />
                    )}

                    <button
                      data-testid="person-row"
                      data-person-id={person.id}
                      onClick={() => onSelectPerson(person)}
                      className={cn(
                        "flex w-full items-start gap-2.5 px-3 py-2.5 text-left active:bg-text-primary/[0.04] sm:py-2",
                        compact &&
                          "items-center justify-center px-2 py-2 sm:py-1.5",
                      )}
                    >
                      {/* Selection checkbox — appears on hover or when any selected.
                        Clicking it toggles selection without opening the person. */}
                      {selectionMode && (
                        <span
                          role="checkbox"
                          aria-checked={isChecked}
                          aria-label={`Select ${display}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleSelected?.(person.id);
                          }}
                          className={cn(
                            "mt-1.5 flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border transition-all",
                            isChecked
                              ? "border-text-primary bg-text-primary text-white opacity-100"
                              : anySelected
                                ? "border-border bg-card opacity-100 hover:border-text-primary/40"
                                : "border-border bg-card opacity-0 group-hover:opacity-100",
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
                      )}

                      {/* Avatar — hidden behind checkbox when hovering in selection mode */}
                      <span
                        className={cn(
                          "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tracking-tight",
                          selectionMode &&
                            (anySelected || isChecked) &&
                            "hidden sm:flex",
                        )}
                        style={{ backgroundColor: color.bg, color: color.fg }}
                      >
                        {initials(person.name, person.email)}
                        {/* In compact mode, the unread badge is anchored to the avatar */}
                        {compact && person.unreadCount > 0 && (
                          <span
                            className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white ring-2 ring-bg-subtle"
                            style={{ backgroundColor: "#7c5cfc" }}
                            aria-label={`${person.unreadCount} unread`}
                          >
                            {person.unreadCount}
                          </span>
                        )}
                      </span>

                      <div
                        className={cn("min-w-0 flex-1", compact && "hidden")}
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <span
                            className={cn(
                              "truncate text-sm",
                              person.unreadCount > 0
                                ? "font-semibold text-text-primary"
                                : "font-medium text-text-primary",
                            )}
                          >
                            {display}
                            {person.name && (
                              <span className="ml-1.5 font-light text-text-tertiary">
                                {person.email}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 text-[11px] font-light text-text-tertiary">
                            {formatTime(person.lastEmailAt)}
                          </span>
                        </div>

                        <div className="mt-0.5 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
                            <span>
                              {person.totalCount} email
                              {person.totalCount !== 1 ? "s" : ""}
                            </span>
                            {person.recipientCount > 1 && (
                              <>
                                <span className="text-text-tertiary/40">·</span>
                                <span>{person.recipientCount} inboxes</span>
                              </>
                            )}
                            {person.hasAttachment === 1 && (
                              <Paperclip
                                size={10}
                                className="text-text-tertiary"
                                aria-label="Has attachment"
                              />
                            )}
                          </div>

                          {/* Click unread badge to mark all read for this person.
                            Larger tap target on mobile (h-6 vs h-5). */}
                          {person.unreadCount > 0 && (
                            <span
                              role="button"
                              tabIndex={0}
                              data-testid="person-unread-badge"
                              title="Tap to mark all as read"
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
                              className="group/badge flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-full px-2 text-[11px] font-bold text-white transition-all active:scale-95 sm:h-5 sm:min-w-5 sm:px-1.5 sm:text-[10px] sm:hover:scale-110"
                              style={{ backgroundColor: "#7c5cfc" }}
                            >
                              <span className="group-hover/badge:hidden">
                                {person.unreadCount}
                              </span>
                              <CheckCheck
                                size={11}
                                className="hidden group-hover/badge:block"
                              />
                            </span>
                          )}
                        </div>
                      </div>
                    </button>

                    {isAdmin && !compact && (
                      <button
                        data-testid="person-kebab-menu"
                        data-person-id={person.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (menuOpen) {
                            setMenuOpenId(null);
                          } else {
                            const rect =
                              e.currentTarget.getBoundingClientRect();
                            setMenuPos({
                              top: rect.bottom + 4,
                              right: window.innerWidth - rect.right,
                            });
                            setMenuOpenId(person.id);
                          }
                        }}
                        className={cn(
                          "absolute right-2 top-3 rounded p-1 text-text-tertiary transition-opacity hover:bg-bg-subtle hover:text-text-secondary",
                          menuOpen
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100",
                        )}
                        aria-label="Person actions"
                      >
                        <MoreHorizontal size={14} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {menuOpenId &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            style={{ top: menuPos.top, right: menuPos.right }}
            className="fixed z-50 w-44 rounded-[8px] border border-border bg-card py-1 shadow-lg"
          >
            <button
              data-testid="person-delete-button"
              onClick={(e) => {
                e.stopPropagation();
                const person = items.find(
                  (it): it is GroupedPerson =>
                    it.type === "person" && it.id === menuOpenId,
                );
                if (person) handleDeletePerson(person);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-xs text-red-600 transition-colors hover:bg-red-50"
            >
              <Trash2 size={12} />
              Delete person
            </button>
          </div>,
          document.body,
        )}

      {totalPages > 1 && (
        <div className="flex shrink-0 items-center justify-between border-t border-border bg-bg-subtle/40 px-4 py-2.5">
          <button
            onClick={() => onPageChange(Math.max(1, page - 1))}
            disabled={page <= 1}
            className="flex h-7 w-7 items-center justify-center rounded-[8px] text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label="Previous page"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-[11px] font-medium text-text-tertiary">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages}
            className="flex h-7 w-7 items-center justify-center rounded-[8px] text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label="Next page"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
