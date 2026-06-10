import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Inbox,
  X,
  Search,
  LayoutList,
  LayoutGrid,
  PenSquare,
  ArrowUpDown,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  defaultDirectionFor,
  type InboxSort,
  type InboxSortSpec,
} from "@/lib/api";

export interface InboxFilters {
  recipient?: string;
  unread?: boolean;
  hasAttachment?: boolean;
}

export type InboxView = "list" | "table";

interface InboxOption {
  email: string;
  displayName?: string | null;
}

interface InboxToolbarProps {
  filters: InboxFilters;
  onFiltersChange: (next: InboxFilters) => void;
  inboxes: InboxOption[];
  search: string;
  onSearchChange: (q: string) => void;
  view: InboxView;
  onViewChange: (v: InboxView) => void;
  /** Active sort key + direction. The dropdown picks the key; clicking
   *  the active key flips direction. There's also an explicit asc/desc
   *  toggle button next to the dropdown for discoverability. */
  sortSpec: InboxSortSpec;
  onSortChange: (spec: InboxSortSpec) => void;
  /** Manually re-fetch the people list. Desktop-only button; mobile uses
   *  pull-to-refresh in the list itself. */
  onRefresh?: () => void;
  /** True while a refresh is in flight — spins the refresh icon. */
  refreshing?: boolean;
  /** Optional Compose button. Rendered to the right of the view toggle. */
  onCompose?: () => void;
}

const SORT_OPTIONS: Array<{ value: InboxSort; label: string }> = [
  { value: "recency", label: "Most recent" },
  { value: "unread", label: "Unread first" },
  { value: "inbox", label: "By inbox" },
  { value: "attachments", label: "Has attachments" },
];

function sortLabel(s: InboxSort): string {
  return SORT_OPTIONS.find((o) => o.value === s)?.label ?? "Most recent";
}

function inboxOptionLabel(o: InboxOption) {
  return o.displayName || o.email.split("@")[0] || o.email;
}

export default function InboxToolbar({
  filters,
  onFiltersChange,
  inboxes,
  search,
  onSearchChange,
  view,
  onViewChange,
  sortSpec,
  onSortChange,
  onRefresh,
  refreshing,
  onCompose,
}: InboxToolbarProps) {
  const [inboxOpen, setInboxOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const sortWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!inboxOpen) return;
    function close(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setInboxOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [inboxOpen]);

  useEffect(() => {
    if (!sortOpen) return;
    function close(e: MouseEvent) {
      if (!sortWrapRef.current?.contains(e.target as Node)) setSortOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [sortOpen]);

  const activeInbox = inboxes.find((i) => i.email === filters.recipient);
  const activeLabel = activeInbox
    ? inboxOptionLabel(activeInbox)
    : "All inboxes";
  const hasActiveFilters =
    !!filters.recipient || !!filters.unread || !!filters.hasAttachment;

  return (
    <div className="flex flex-wrap items-center gap-1 rounded-[8px] bg-card p-1 ring-1 ring-border">
      {/* Search — borderless inside the unified bar. On mobile takes full
          width, on desktop sits inline with filters. */}
      <div className="relative w-full min-w-[160px] flex-1 sm:w-auto sm:max-w-[220px]">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
        <input
          data-testid="person-search-input"
          type="text"
          placeholder="Search..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="h-9 w-full rounded-[6px] border-0 bg-transparent pl-7 pr-7 text-base text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-text-primary/15 sm:h-7 sm:text-sm"
        />
        {search && (
          <button
            data-testid="person-search-clear"
            onClick={() => onSearchChange("")}
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full p-1 text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5 sm:h-3 sm:w-3" />
          </button>
        )}
      </div>

      {/* Vertical divider — desktop only */}
      <span className="mx-0.5 hidden h-5 w-px bg-border sm:block" aria-hidden />

      {/* Inbox dropdown — ghost button inside bar */}
      <div ref={wrapRef} className="relative">
        <ToolbarButton
          active={!!filters.recipient}
          onClick={() => setInboxOpen((v) => !v)}
        >
          <Inbox size={12} />
          {activeLabel}
          <ChevronDown size={12} className="opacity-60" />
        </ToolbarButton>
        {inboxOpen && (
          <div className="absolute left-0 top-full z-30 mt-1.5 w-56 overflow-hidden rounded-[8px] border border-border bg-card py-1 shadow-lg">
            <button
              type="button"
              onClick={() => {
                onFiltersChange({ ...filters, recipient: undefined });
                setInboxOpen(false);
              }}
              className={cn(
                "flex w-full items-center justify-between px-3 py-2 text-xs transition-colors hover:bg-bg-muted",
                !filters.recipient && "bg-bg-subtle font-medium",
              )}
            >
              <span>All inboxes</span>
              {!filters.recipient && (
                <span className="text-[10px] font-bold uppercase tracking-wider text-text-tertiary">
                  active
                </span>
              )}
            </button>
            <div className="my-1 h-px bg-border" />
            {inboxes.length === 0 ? (
              <p className="px-3 py-2 text-xs font-light text-text-tertiary">
                No inboxes available
              </p>
            ) : (
              inboxes.map((inbox) => {
                const active = filters.recipient === inbox.email;
                return (
                  <button
                    key={inbox.email}
                    type="button"
                    onClick={() => {
                      onFiltersChange({ ...filters, recipient: inbox.email });
                      setInboxOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-2 text-xs transition-colors hover:bg-bg-muted",
                      active && "bg-bg-subtle font-medium",
                    )}
                  >
                    <div className="flex min-w-0 flex-col items-start">
                      <span className="truncate text-text-primary">
                        {inboxOptionLabel(inbox)}
                      </span>
                      <span className="truncate text-[10px] font-light text-text-tertiary">
                        {inbox.email}
                      </span>
                    </div>
                    {active && (
                      <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-text-tertiary">
                        active
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      <ToolbarToggle
        label="Unread"
        active={!!filters.unread}
        onClick={() => onFiltersChange({ ...filters, unread: !filters.unread })}
      />
      <ToolbarToggle
        label="Attachments"
        active={!!filters.hasAttachment}
        onClick={() =>
          onFiltersChange({
            ...filters,
            hasAttachment: !filters.hasAttachment,
          })
        }
      />

      {hasActiveFilters && (
        <button
          type="button"
          onClick={() =>
            onFiltersChange({
              recipient: undefined,
              unread: false,
              hasAttachment: false,
            })
          }
          className="inline-flex h-7 items-center gap-1 rounded-[5px] px-1.5 text-xs font-medium text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
        >
          <X size={11} />
          Clear
        </button>
      )}

      <span className="ml-auto" />

      {/* Sort dropdown — applies to both list + table views. The
          dropdown picks the *key*; the icon button next to it flips
          the direction. Clicking the active key in the dropdown also
          flips direction so users have two paths. */}
      <div
        ref={sortWrapRef}
        className="relative hidden sm:flex sm:items-center sm:gap-0.5"
      >
        <button
          type="button"
          onClick={() => setSortOpen((v) => !v)}
          className="inline-flex h-7 items-center gap-1 rounded-[5px] px-2 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
          aria-label="Sort"
        >
          <ArrowUpDown size={11} />
          <span className="hidden md:inline">{sortLabel(sortSpec.key)}</span>
          <ChevronDown size={11} className="opacity-60" />
        </button>
        {/* Explicit direction toggle — visible always so the current
            direction is obvious without opening the dropdown. */}
        <button
          type="button"
          onClick={() =>
            onSortChange({
              key: sortSpec.key,
              direction: sortSpec.direction === "asc" ? "desc" : "asc",
            })
          }
          aria-label={
            sortSpec.direction === "asc" ? "Sort descending" : "Sort ascending"
          }
          title={`Currently ${sortSpec.direction === "asc" ? "ascending" : "descending"}. Click to flip.`}
          className="inline-flex h-7 w-7 items-center justify-center rounded-[5px] text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
        >
          {sortSpec.direction === "asc" ? (
            <ArrowUp size={11} />
          ) : (
            <ArrowDown size={11} />
          )}
        </button>
        {sortOpen && (
          <div className="absolute right-0 top-full z-30 mt-1.5 w-48 overflow-hidden rounded-[8px] border border-border bg-card py-1 shadow-lg">
            {SORT_OPTIONS.map((opt) => {
              const isActive = sortSpec.key === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    if (isActive) {
                      onSortChange({
                        key: opt.value,
                        direction:
                          sortSpec.direction === "asc" ? "desc" : "asc",
                      });
                    } else {
                      onSortChange({
                        key: opt.value,
                        direction: defaultDirectionFor(opt.value),
                      });
                    }
                    setSortOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 px-3 py-2 text-xs transition-colors hover:bg-bg-muted",
                    isActive && "bg-bg-subtle font-medium",
                  )}
                >
                  <span>{opt.label}</span>
                  {isActive && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
                      {sortSpec.direction === "asc" ? (
                        <ArrowUp size={10} />
                      ) : (
                        <ArrowDown size={10} />
                      )}
                      {sortSpec.direction === "asc" ? "asc" : "desc"}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Refresh — desktop only. Mobile refreshes via pull-to-refresh on the
          list itself, so the button would be redundant there. */}
      {onRefresh && (
        <>
          <span
            className="mx-0.5 hidden h-4 w-px bg-border sm:block"
            aria-hidden
          />
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh"
            title="Refresh"
            className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-[5px] text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:opacity-60 sm:inline-flex"
          >
            <RefreshCw size={13} className={cn(refreshing && "animate-spin")} />
          </button>
        </>
      )}

      {/* View toggle — pinned to the right edge. Hidden on mobile (the
          table view is unusable at narrow widths). */}
      <span className="mx-0.5 hidden h-4 w-px bg-border sm:block" aria-hidden />
      <div className="hidden h-7 rounded-[5px] bg-bg-muted/70 p-0.5 sm:inline-flex">
        <ViewToggleButton
          icon={LayoutList}
          label="List"
          active={view === "list"}
          onClick={() => onViewChange("list")}
        />
        <ViewToggleButton
          icon={LayoutGrid}
          label="Table"
          active={view === "table"}
          onClick={() => onViewChange("table")}
        />
      </div>

      {/* Compose — anchored at the far right of the unified bar. Hidden on
          mobile (the floating FAB takes over there). */}
      {onCompose && (
        <>
          <span
            className="mx-0.5 hidden h-4 w-px bg-border sm:block"
            aria-hidden
          />
          <button
            onClick={onCompose}
            className="hidden h-7 shrink-0 items-center gap-1.5 rounded-[5px] bg-text-primary px-2.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-text-primary/90 sm:inline-flex"
          >
            <PenSquare className="h-3.5 w-3.5" />
            Compose
          </button>
        </>
      )}
    </div>
  );
}

interface ToolbarButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}
function ToolbarButton({ active, onClick, children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-[5px] px-2 text-xs font-medium transition-colors",
        active
          ? "bg-text-primary/[0.06] text-text-primary"
          : "text-text-secondary hover:bg-bg-muted hover:text-text-primary",
      )}
    >
      {children}
    </button>
  );
}

interface ToolbarToggleProps {
  label: string;
  active: boolean;
  onClick: () => void;
}
function ToolbarToggle({ label, active, onClick }: ToolbarToggleProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-[5px] px-2 text-xs font-medium transition-colors",
        active
          ? "bg-text-primary/[0.06] text-text-primary"
          : "text-text-secondary hover:bg-bg-muted hover:text-text-primary",
      )}
    >
      <span
        className="h-1.5 w-1.5 rounded-full transition-colors"
        style={{ backgroundColor: active ? "#7c5cfc" : "rgba(0,0,0,0.18)" }}
        aria-hidden
      />
      {label}
    </button>
  );
}

interface ViewToggleButtonProps {
  icon: React.ElementType;
  label: string;
  active: boolean;
  onClick: () => void;
}
function ViewToggleButton({
  icon: Icon,
  label,
  active,
  onClick,
}: ViewToggleButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${label} view`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[5px] px-2.5 text-xs font-medium transition-all",
        active
          ? "bg-card text-text-primary shadow-sm ring-1 ring-border/60"
          : "text-text-secondary hover:text-text-primary",
      )}
    >
      <Icon size={13} />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
