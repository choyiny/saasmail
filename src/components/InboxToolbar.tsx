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
  Bot,
  Check,
  CheckCheck,
  Layers,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  defaultDirectionFor,
  type InboxSort,
  type InboxSortSpec,
  type MailCategory,
} from "@/lib/api";
import { CATEGORY_LABELS } from "@/components/MailActions";

export interface InboxFilters {
  recipient?: string;
  unread?: boolean;
  /** Only conversations where you've started a reply draft. */
  drafts?: boolean;
  /** Only contacts currently enrolled in a sequence. */
  sequenced?: boolean;
  /** Only one inbox tab (Primary, Promotions, Social, Updates). */
  category?: MailCategory;
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
  /** "Agent Plan" tab — a WebMCP agent's live plan, beside the filters. */
  agentPlanActive: boolean;
  onAgentPlanToggle: () => void;
  /** Heading shown at the start of the header row (e.g. "Inbox"). */
  title?: string;
  /** Optional count shown after the title. */
  count?: number;
  /**
   * "Mark all as read": every unread conversation in the current folder
   * and filters, on the server (not just the loaded page).
   */
  onMarkAllRead?: () => void;
  /** Unread conversations in the current folder + filters. */
  unreadCount?: number;
  markAllReadBusy?: boolean;
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
  agentPlanActive,
  onAgentPlanToggle,
  title,
  count,
  onMarkAllRead,
  unreadCount = 0,
  markAllReadBusy,
}: InboxToolbarProps) {
  const activeInbox = inboxes.find((i) => i.email === filters.recipient);
  const activeLabel = activeInbox
    ? inboxOptionLabel(activeInbox)
    : "All inboxes";
  const hasActiveFilters =
    !!filters.recipient ||
    !!filters.unread ||
    !!filters.drafts ||
    !!filters.sequenced ||
    !!filters.category;
  const markAll = onMarkAllRead ? (
    <MarkAllReadChip
      onClick={onMarkAllRead}
      busy={!!markAllReadBusy}
      unread={unreadCount}
    />
  ) : null;

  return (
    <div className="flex flex-col gap-3">
      {/* Row 1 — module header: title, view switch, actions. */}
      {title && (
        <div className="flex min-h-9 items-center gap-3">
          <h1 className="truncate text-[20px] font-semibold tracking-[-0.02em] text-text-primary sm:text-[22px]">
            {title}
          </h1>
          {count != null && count > 0 && (
            <span className="tabular hidden text-[13px] text-text-tertiary sm:inline">
              {count.toLocaleString()}
            </span>
          )}
          <div className="pt-seg ml-2 hidden sm:inline-flex" role="group">
            <ViewToggleButton
              icon={LayoutList}
              label="List"
              active={!agentPlanActive && view === "list"}
              onClick={() => onViewChange("list")}
            />
            <ViewToggleButton
              icon={LayoutGrid}
              label="Table"
              active={!agentPlanActive && view === "table"}
              onClick={() => onViewChange("table")}
            />
            <ViewToggleButton
              icon={Bot}
              label="Agent"
              active={agentPlanActive}
              onClick={onAgentPlanToggle}
            />
          </div>
          <div className="ml-auto flex items-center gap-2">
            {onRefresh && (
              <Button
                variant="outline"
                size="icon"
                onClick={onRefresh}
                disabled={refreshing}
                aria-label="Refresh"
                title="Refresh"
                className="hidden sm:inline-flex"
              >
                <RefreshCw className={cn(refreshing && "animate-spin")} />
              </Button>
            )}
            {onCompose && (
              <Button
                onClick={onCompose}
                className="hidden sm:inline-flex"
                title="New message (C)"
                aria-keyshortcuts="c"
              >
                <PenSquare />
                Compose
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Row 2 — search and filters. Scrolls sideways on phones. */}
      <div className="flex items-center gap-2">
        <div className="relative w-full min-w-0 flex-1 sm:max-w-[300px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
          <input
            data-testid="person-search-input"
            type="text"
            placeholder="Search people and mail"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            aria-keyshortcuts="/"
            onKeyDown={(e) => {
              // Esc leaves the field so j/k work again; Enter or ↓ jumps
              // to the first result.
              if (e.key === "Escape") {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === "Enter" || e.key === "ArrowDown") {
                const first = document.querySelector<HTMLElement>(
                  '[data-testid="person-row"],[data-testid="group-row"]',
                );
                if (first) {
                  e.preventDefault();
                  first.focus();
                }
              }
            }}
            className="peer h-9 w-full rounded-lg border border-border-strong bg-card pl-8 pr-8 text-sm text-text-primary shadow-card transition-[border-color,box-shadow] placeholder:text-text-tertiary hover:border-text-tertiary/60 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15"
          />
          {!search && (
            <kbd
              aria-hidden
              className="pointer-events-none absolute right-2 top-1/2 hidden h-5 min-w-5 -translate-y-1/2 place-items-center rounded border border-border bg-bg-subtle px-1 font-sans text-[11px] text-text-tertiary peer-focus:hidden sm:grid"
            >
              /
            </kbd>
          )}
          {search && (
            <button
              data-testid="person-search-clear"
              onClick={() => onSearchChange("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {!title && onCompose && (
          <Button onClick={onCompose} className="hidden sm:inline-flex">
            <PenSquare />
            Compose
          </Button>
        )}
        <div className="-mr-2 hidden min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pr-2 [scrollbar-width:none] sm:flex">
          <FilterRow
            filters={filters}
            onFiltersChange={onFiltersChange}
            inboxes={inboxes}
            activeLabel={activeLabel}
            hasActiveFilters={hasActiveFilters}
          />
          <span className="ml-auto" />
          {markAll}
          <SortControl sortSpec={sortSpec} onSortChange={onSortChange} />
        </div>
      </div>
      <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 [scrollbar-width:none] sm:hidden">
        <FilterRow
          filters={filters}
          onFiltersChange={onFiltersChange}
          inboxes={inboxes}
          activeLabel={activeLabel}
          hasActiveFilters={hasActiveFilters}
        />
        {markAll}
      </div>
    </div>
  );
}

function MarkAllReadChip({
  onClick,
  busy,
  unread,
}: {
  onClick: () => void;
  busy: boolean;
  unread: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || unread === 0}
      data-testid="folder-mark-all-read"
      title={
        unread === 0
          ? "Nothing unread here"
          : `Mark all ${unread.toLocaleString()} unread conversations here as read`
      }
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
    >
      {busy ? (
        <Loader2 size={13} className="animate-spin" />
      ) : (
        <CheckCheck size={13} />
      )}
      <span className="whitespace-nowrap">Mark all as read</span>
    </button>
  );
}

function FilterRow({
  filters,
  onFiltersChange,
  inboxes,
  activeLabel,
  hasActiveFilters,
}: {
  filters: InboxFilters;
  onFiltersChange: (next: InboxFilters) => void;
  inboxes: InboxOption[];
  activeLabel: string;
  hasActiveFilters: boolean;
}) {
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(chipClass(!!filters.recipient), "pr-2")}
          >
            <Inbox size={13} />
            <span className="max-w-[160px] truncate">{activeLabel}</span>
            <ChevronDown size={13} className="opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuItem
            onSelect={() =>
              onFiltersChange({ ...filters, recipient: undefined })
            }
          >
            <span className="flex-1">All inboxes</span>
            {!filters.recipient && <Check className="text-accent" />}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Inboxes</DropdownMenuLabel>
          {inboxes.length === 0 ? (
            <p className="px-2 py-1.5 text-[13px] text-text-tertiary">
              No inboxes available
            </p>
          ) : (
            inboxes.map((inbox) => {
              const active = filters.recipient === inbox.email;
              return (
                <DropdownMenuItem
                  key={inbox.email}
                  onSelect={() =>
                    onFiltersChange({ ...filters, recipient: inbox.email })
                  }
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{inboxOptionLabel(inbox)}</span>
                    <span className="truncate text-xs text-text-tertiary">
                      {inbox.email}
                    </span>
                  </span>
                  {active && <Check className="text-accent" />}
                </DropdownMenuItem>
              );
            })
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="filter-category"
            className={cn(chipClass(!!filters.category), "pr-2")}
          >
            <Layers size={13} />
            <span>
              {filters.category
                ? CATEGORY_LABELS[filters.category]
                : "All tabs"}
            </span>
            <ChevronDown size={13} className="opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem
            onSelect={() =>
              onFiltersChange({ ...filters, category: undefined })
            }
          >
            <span className="flex-1">All tabs</span>
            {!filters.category && <Check className="text-accent" />}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {(Object.keys(CATEGORY_LABELS) as MailCategory[]).map((c) => (
            <DropdownMenuItem
              key={c}
              onSelect={() => onFiltersChange({ ...filters, category: c })}
            >
              <span className="flex-1">{CATEGORY_LABELS[c]}</span>
              {filters.category === c && <Check className="text-accent" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <p className="px-2 py-1.5 text-xs leading-snug text-text-tertiary">
            Sorted by sender. Fix a sender with Move to tab in its menu.
          </p>
        </DropdownMenuContent>
      </DropdownMenu>

      <ToolbarToggle
        label="Unread"
        active={!!filters.unread}
        onClick={() => onFiltersChange({ ...filters, unread: !filters.unread })}
      />
      <ToolbarToggle
        label="Drafts"
        active={!!filters.drafts}
        onClick={() => onFiltersChange({ ...filters, drafts: !filters.drafts })}
      />
      <ToolbarToggle
        label="Sequenced"
        active={!!filters.sequenced}
        onClick={() =>
          onFiltersChange({
            ...filters,
            sequenced: !filters.sequenced,
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
              drafts: false,
              sequenced: false,
              category: undefined,
            })
          }
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[13px] font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
        >
          <X size={13} />
          Clear
        </button>
      )}
    </>
  );
}

function SortControl({
  sortSpec,
  onSortChange,
}: {
  sortSpec: InboxSortSpec;
  onSortChange: (spec: InboxSortSpec) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary data-[state=open]:bg-bg-muted"
            aria-label="Sort"
          >
            <ArrowUpDown size={13} />
            <span className="hidden md:inline">{sortLabel(sortSpec.key)}</span>
            <ChevronDown size={13} className="opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel>Sort by</DropdownMenuLabel>
          {SORT_OPTIONS.map((opt) => {
            const isActive = sortSpec.key === opt.value;
            return (
              <DropdownMenuItem
                key={opt.value}
                onSelect={() =>
                  onSortChange(
                    isActive
                      ? {
                          key: opt.value,
                          direction:
                            sortSpec.direction === "asc" ? "desc" : "asc",
                        }
                      : {
                          key: opt.value,
                          direction: defaultDirectionFor(opt.value),
                        },
                  )
                }
              >
                <span className="flex-1">{opt.label}</span>
                {isActive &&
                  (sortSpec.direction === "asc" ? <ArrowUp /> : <ArrowDown />)}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
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
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
      >
        {sortSpec.direction === "asc" ? (
          <ArrowUp size={13} />
        ) : (
          <ArrowDown size={13} />
        )}
      </button>
    </div>
  );
}

function chipClass(active: boolean) {
  return cn(
    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-medium transition-colors",
    active
      ? "border-accent-subtle bg-accent-subtle text-accent-subtle-fg"
      : "border-border bg-card text-text-secondary hover:border-border-strong hover:text-text-primary",
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
      aria-pressed={active}
      className={chipClass(active)}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full transition-colors",
          active ? "bg-accent" : "bg-border-strong",
        )}
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
      aria-pressed={active}
      className={cn(active && "on")}
    >
      <Icon size={14} />
      <span>{label}</span>
    </button>
  );
}
