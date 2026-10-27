import { useMemo } from "react";
import {
  Paperclip,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Users,
  Pin,
  ArrowDown,
  ArrowUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { avatarColor, initials } from "@/lib/avatar";
import {
  MailActionButtons,
  StarToggle,
  type MailActionHandlers,
} from "@/components/MailActions";
import {
  defaultDirectionFor,
  type GroupedItem,
  type GroupedPerson,
  type GroupedConversation,
  type InboxAggregates,
  type InboxSort,
  type InboxSortSpec,
} from "@/lib/api";

interface PeopleTableProps {
  /** Mixed list — both person and group rows render in the table. */
  items: GroupedItem[];
  loading?: boolean;
  onSelectPerson: (person: GroupedPerson) => void;
  onSelectConversation?: (conv: GroupedConversation) => void;
  /** Selected person IDs (used for bulk-mark-read on persons). */
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
  /** Selected conversation IDs (parallel state for groups). */
  selectedConversationIds?: Set<string>;
  onToggleSelectedConversation?: (id: string) => void;
  /** Toggle "select all on page" — applies to both persons + groups. */
  onToggleSelectAll?: () => void;
  onMarkPersonRead?: (id: string) => void;
  onMarkConversationRead?: (id: string) => void;
  /** Active sort key + direction. Column headers act as toggles:
   *  click the active key → flip direction; click another key →
   *  switch to it with the natural default direction. */
  sortSpec?: InboxSortSpec;
  onSortChange?: (spec: InboxSortSpec) => void;
  /** Pagination — total rows in the filtered set, current page, and
   *  the page-size used by the parent to size each fetch. */
  total?: number;
  page?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  /** Aggregates over the *filtered* set so stat tiles show the truth
   *  about the whole result, not just the visible page. */
  aggregates?: InboxAggregates;
  /** Star / pin / archive / snooze handlers per row. */
  mailActions?: (item: GroupedItem) => MailActionHandlers;
}

/**
 * Clickable column-header label. Click toggles the sort direction
 * when its key is the active sort; clicking a different column
 * switches to that key with the natural default direction (recency/
 * unread/attachments → desc, inbox → asc). The arrow flips ↑/↓ to
 * match the active direction.
 */
function SortHeader({
  label,
  sortKey,
  active,
  onClick,
  align = "left",
}: {
  label: string;
  sortKey: InboxSort;
  active: InboxSortSpec | undefined;
  onClick: ((spec: InboxSortSpec) => void) | undefined;
  align?: "left" | "right";
}) {
  const isActive = active?.key === sortKey;
  const clickable = !!onClick;
  function handleClick() {
    if (!onClick) return;
    if (isActive && active) {
      onClick({
        key: sortKey,
        direction: active.direction === "asc" ? "desc" : "asc",
      });
    } else {
      onClick({ key: sortKey, direction: defaultDirectionFor(sortKey) });
    }
  }
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={clickable ? handleClick : undefined}
      className={cn(
        "inline-flex items-center gap-1 transition-colors",
        align === "right" && "flex-row-reverse",
        clickable && "cursor-pointer hover:text-text-primary",
        isActive && "text-text-primary",
        !clickable && "cursor-default",
      )}
      title={
        clickable
          ? isActive
            ? `Sort by ${label.toLowerCase()} — click to flip direction`
            : `Sort by ${label.toLowerCase()}`
          : undefined
      }
    >
      <span>{label}</span>
      {isActive && active.direction === "asc" ? (
        <ArrowUp size={11} className="shrink-0" aria-hidden />
      ) : isActive ? (
        <ArrowDown size={11} className="shrink-0" aria-hidden />
      ) : null}
    </button>
  );
}

function relTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffH = diffMs / 3_600_000;
  if (diffH < 1) return `${Math.max(1, Math.floor(diffMs / 60_000))}m ago`;
  if (diffH < 24) return `${Math.floor(diffH)}h ago`;
  const diffD = diffH / 24;
  if (diffD < 7) return `${Math.floor(diffD)}d ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

interface RowCheckboxProps {
  checked: boolean;
  onChange: () => void;
  ariaLabel: string;
}
function RowCheckbox({ checked, onChange, ariaLabel }: RowCheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
        checked
          ? "border-accent bg-accent text-accent-foreground"
          : "border-border-strong bg-card hover:border-text-tertiary",
      )}
    >
      {checked && (
        <svg
          className="h-3 w-3"
          viewBox="0 0 12 12"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
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
    </button>
  );
}

export default function PeopleTable({
  items,
  loading,
  onSelectPerson,
  onSelectConversation,
  selectedIds,
  onToggleSelected,
  selectedConversationIds,
  onToggleSelectedConversation,
  onToggleSelectAll,
  onMarkPersonRead,
  onMarkConversationRead,
  sortSpec,
  onSortChange,
  total,
  page,
  pageSize,
  onPageChange,
  aggregates,
  mailActions,
}: PeopleTableProps) {
  // Person rows used for the bulk-select header checkbox.
  // Group rows are still rendered, just not eligible for bulk selection
  // (groups have their own per-row mark-read button).
  const people = useMemo(
    () => items.filter((it): it is GroupedPerson => it.type === "person"),
    [items],
  );
  // Stats reflect the *whole filtered set* via server aggregates when
  // available — falling back to current-page counts only if the
  // parent didn't pass them. The fallback keeps this component
  // useful for callers that don't paginate.
  const stats = useMemo(() => {
    if (aggregates && typeof total === "number") {
      return {
        total,
        unread: aggregates.unreadRowCount,
        withAttachments: aggregates.attachmentRowCount,
        multiInbox: aggregates.multiInboxRowCount,
      };
    }
    let unread = 0;
    let withAttachments = 0;
    let multiInbox = 0;
    for (const it of items) {
      if (it.type === "group") {
        if (it.unreadCount > 0) unread++;
        if (it.hasAttachment === 1) withAttachments++;
        continue;
      }
      if (it.unreadCount > 0) unread++;
      if (it.hasAttachment === 1) withAttachments++;
      if (it.recipientCount > 1) multiInbox++;
    }
    return {
      total: items.length,
      unread,
      withAttachments,
      multiInbox,
    };
  }, [items, aggregates, total]);

  // "All on page" = all persons selected AND all groups selected. Same
  // header checkbox flips both sets via onToggleSelectAll.
  const groups = useMemo(
    () => items.filter((it): it is GroupedConversation => it.type === "group"),
    [items],
  );
  const allPersonsSelected =
    people.length === 0 ||
    (selectedIds !== undefined && people.every((p) => selectedIds.has(p.id)));
  const allGroupsSelected =
    groups.length === 0 ||
    (selectedConversationIds !== undefined &&
      groups.every((g) => selectedConversationIds.has(g.id)));
  const allOnPageSelected =
    items.length > 0 &&
    selectedIds !== undefined &&
    allPersonsSelected &&
    allGroupsSelected;

  const someOnPageSelected =
    selectedIds !== undefined &&
    (people.some((p) => selectedIds.has(p.id)) ||
      (selectedConversationIds !== undefined &&
        groups.some((g) => selectedConversationIds.has(g.id)))) &&
    !allOnPageSelected;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* Stats strip */}
      <div className="grid shrink-0 grid-cols-2 border-b border-border sm:grid-cols-4">
        <StatTile label="People" value={stats.total} />
        <StatTile label="Unread" value={stats.unread} accent />
        <StatTile label="Multi-inbox" value={stats.multiInbox} />
        <StatTile label="With attachments" value={stats.withAttachments} />
      </div>

      {/* Table */}
      <div className="smooth-scroll min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex flex-col gap-3 p-5" aria-busy="true">
            {Array.from({ length: 8 }).map((_, i) => (
              <span key={i} className="pt-skel h-8 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="pt-empty h-full">
            <p className="font-medium text-text-primary">
              No people match your filters
            </p>
            <p className="text-[13px]">
              Try clearing a filter or broadening your search.
            </p>
          </div>
        ) : (
          <table
            // Rows follow the density setting (--sm-row-pad), like the list.
            className="pt-table [&_tbody_td]:py-[var(--sm-row-pad)]"
          >
            <thead>
              <tr>
                {selectedIds !== undefined && (
                  <th className="w-10 !pr-0">
                    <RowCheckbox
                      checked={allOnPageSelected}
                      onChange={() => onToggleSelectAll?.()}
                      ariaLabel={
                        allOnPageSelected
                          ? "Deselect all on page"
                          : "Select all on page"
                      }
                    />
                    {someOnPageSelected && (
                      <span className="sr-only">Some selected</span>
                    )}
                  </th>
                )}
                {mailActions && (
                  <th className="w-8 !px-0">
                    <span className="sr-only">Starred</span>
                  </th>
                )}
                <th>Person</th>
                <th>
                  <SortHeader
                    label="Inboxes"
                    sortKey="inbox"
                    active={sortSpec}
                    onClick={onSortChange}
                  />
                </th>
                <th className="!text-right">
                  <SortHeader
                    label="Emails"
                    sortKey="attachments"
                    active={sortSpec}
                    onClick={onSortChange}
                    align="right"
                  />
                </th>
                <th className="!text-right">
                  <SortHeader
                    label="Unread"
                    sortKey="unread"
                    active={sortSpec}
                    onClick={onSortChange}
                    align="right"
                  />
                </th>
                <th className="!text-right">
                  <SortHeader
                    label="Last"
                    sortKey="recency"
                    active={sortSpec}
                    onClick={onSortChange}
                    align="right"
                  />
                </th>
                {mailActions && (
                  <th className="w-[148px]">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                if (item.type === "group") {
                  return (
                    <GroupTableRow
                      key={`g_${item.id}`}
                      group={item}
                      onSelect={() => onSelectConversation?.(item)}
                      onMarkRead={onMarkConversationRead}
                      hasCheckboxColumn={selectedIds !== undefined}
                      isSelected={
                        selectedConversationIds?.has(item.id) ?? false
                      }
                      onToggleSelected={onToggleSelectedConversation}
                      actions={mailActions?.(item)}
                    />
                  );
                }
                const person = item;
                const color = avatarColor(person.email);
                const isSelected = selectedIds?.has(person.id) ?? false;
                const actions = mailActions?.(person);
                return (
                  <tr
                    key={person.id}
                    onClick={() => onSelectPerson(person)}
                    className={cn(
                      "group cursor-pointer",
                      isSelected && "!bg-accent-subtle/60",
                    )}
                  >
                    {selectedIds !== undefined && (
                      <td className="w-10 !pr-0">
                        <RowCheckbox
                          checked={isSelected}
                          onChange={() => onToggleSelected?.(person.id)}
                          ariaLabel={`Select ${person.name || person.email}`}
                        />
                      </td>
                    )}
                    {actions && (
                      <td className="w-8 !px-0">
                        <StarToggle
                          starred={person.starred}
                          onToggle={actions.onToggleStar}
                          className="h-7 w-7"
                        />
                      </td>
                    )}
                    <td>
                      <div className="flex items-center gap-3">
                        <span
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
                          style={{
                            backgroundColor: color.bg,
                            color: color.fg,
                          }}
                        >
                          {initials(person.name, person.email)}
                        </span>
                        <div className="min-w-0">
                          <p
                            className={cn(
                              "flex items-center gap-1.5 truncate text-[13.5px] text-text-primary",
                              person.unreadCount > 0
                                ? "font-semibold"
                                : "font-medium",
                            )}
                          >
                            {person.pinned && (
                              <Pin
                                size={12}
                                className="shrink-0 text-accent"
                                aria-label="Pinned"
                              />
                            )}
                            <span className="truncate">
                              {person.name || person.email}
                            </span>
                          </p>
                          {person.name && (
                            <p className="truncate text-xs text-text-tertiary">
                              {person.email}
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {(person.recipients ?? []).slice(0, 3).map((r) => (
                          <span key={r} className="pt-chip" title={r}>
                            {r.split("@")[0]}
                          </span>
                        ))}
                        {(person.recipients?.length ?? 0) > 3 && (
                          <span className="inline-flex items-center px-1 text-xs text-text-tertiary">
                            +{(person.recipients?.length ?? 0) - 3}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="text-right">
                      <span className="inline-flex items-center gap-1.5 text-[13px] tabular-nums text-text-secondary">
                        {person.hasAttachment === 1 && (
                          <Paperclip
                            size={11}
                            className="text-text-tertiary"
                            aria-label="Has attachment"
                          />
                        )}
                        {person.totalCount}
                      </span>
                    </td>
                    <td className="text-right">
                      {person.unreadCount > 0 ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onMarkPersonRead?.(person.id);
                          }}
                          title="Mark all as read"
                          className="group/badge tabular inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-foreground"
                        >
                          <span className="group-hover/badge:hidden">
                            {person.unreadCount}
                          </span>
                          <CheckCheck
                            size={11}
                            className="hidden group-hover/badge:block"
                          />
                        </button>
                      ) : (
                        <span className="text-[13px] text-text-tertiary">
                          —
                        </span>
                      )}
                    </td>
                    <td className="text-right">
                      <span className="tabular text-[13px] text-text-tertiary">
                        {relTime(person.lastEmailAt)}
                      </span>
                    </td>
                    {actions && (
                      <td className="!py-0">
                        <MailActionButtons
                          state={person}
                          handlers={actions}
                          showStar={false}
                          className="justify-end opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                        />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination footer — only renders when the parent passes the
          paging plumbing in. Mirrors PersonList's footer so list and
          table view feel consistent. */}
      {typeof total === "number" &&
        typeof page === "number" &&
        typeof pageSize === "number" &&
        onPageChange && (
          <PageFooter
            total={total}
            page={page}
            pageSize={pageSize}
            onPageChange={onPageChange}
            visibleCount={items.length}
          />
        )}
    </div>
  );
}

interface PageFooterProps {
  total: number;
  page: number;
  pageSize: number;
  visibleCount: number;
  onPageChange: (page: number) => void;
}

function PageFooter({
  total,
  page,
  pageSize,
  visibleCount,
  onPageChange,
}: PageFooterProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = total === 0 ? 0 : Math.min(start + visibleCount - 1, total);
  return (
    <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-t border-border px-4">
      <span className="tabular text-xs text-text-tertiary">
        {total === 0
          ? "No results"
          : `Showing ${start}–${end} of ${total.toLocaleString()}`}
      </span>
      {totalPages > 1 && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => onPageChange(Math.max(1, page - 1))}
            disabled={page <= 1}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label="Previous page"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="tabular text-xs text-text-tertiary">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label="Next page"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

interface GroupTableRowProps {
  group: GroupedConversation;
  onSelect: () => void;
  onMarkRead?: (id: string) => void;
  hasCheckboxColumn: boolean;
  isSelected?: boolean;
  onToggleSelected?: (id: string) => void;
  actions?: MailActionHandlers;
}

/**
 * Table row for a group conversation. Avatar stack + comma-separated
 * names in the Person column; the conversation's inbox in the Inboxes
 * column. Bulk select skips groups (they have their own mark-read).
 */
function GroupTableRow({
  group,
  onSelect,
  onMarkRead,
  hasCheckboxColumn,
  isSelected = false,
  onToggleSelected,
  actions,
}: GroupTableRowProps) {
  const visible = group.participants.slice(0, 3);
  const overflow = Math.max(0, group.participants.length - visible.length);
  const AVATAR = 28;
  const OVERLAP = 10;
  const stackWidth =
    AVATAR +
    Math.max(0, visible.length + (overflow > 0 ? 1 : 0) - 1) *
      (AVATAR - OVERLAP);
  const namesLine = group.participants
    .map((p) => {
      if (p.name && p.name.trim()) return p.name.trim().split(/\s+/)[0];
      return p.email.split("@")[0];
    })
    .slice(0, 4)
    .join(", ");
  const namesOverflow =
    group.participants.length - Math.min(4, group.participants.length);

  return (
    <tr
      onClick={onSelect}
      className={cn(
        "group cursor-pointer",
        isSelected && "!bg-accent-subtle/60",
      )}
      data-testid="group-row"
      data-conversation-id={group.id}
    >
      {hasCheckboxColumn && (
        <td className="w-10 !pr-0">
          <RowCheckbox
            checked={isSelected}
            onChange={() => onToggleSelected?.(group.id)}
            ariaLabel={`Select group ${group.id}`}
          />
        </td>
      )}
      {actions && (
        <td className="w-8 !px-0">
          <StarToggle
            starred={group.starred}
            onToggle={actions.onToggleStar}
            className="h-7 w-7"
          />
        </td>
      )}
      <td>
        <div className="flex items-center gap-3">
          <span
            className="relative shrink-0"
            style={{ width: stackWidth, height: AVATAR }}
          >
            {visible.map((p, i) => {
              const color = avatarColor(p.email);
              return (
                <span
                  key={p.id}
                  title={p.name || p.email}
                  className="absolute flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold ring-2 ring-card"
                  style={{
                    backgroundColor: color.bg,
                    color: color.fg,
                    left: i * (AVATAR - OVERLAP),
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
                className="absolute flex h-7 w-7 items-center justify-center rounded-full bg-bg-muted text-[10px] font-semibold text-text-secondary ring-2 ring-card"
                style={{
                  left: visible.length * (AVATAR - OVERLAP),
                  top: 0,
                  zIndex: 10 - visible.length,
                }}
                title={`+${overflow} more participants`}
              >
                +{overflow}
              </span>
            )}
          </span>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate text-[13.5px] font-medium text-text-primary">
              <Users size={11} className="shrink-0 text-text-tertiary" />
              <span className="truncate">
                {namesLine}
                {namesOverflow > 0 ? `, +${namesOverflow}` : ""}
              </span>
            </p>
            <p className="truncate text-xs text-text-tertiary">
              {group.participants.length} participants
            </p>
          </div>
        </div>
      </td>
      <td>
        <span className="pt-chip" title={group.inbox}>
          {group.inbox.split("@")[0]}
        </span>
      </td>
      <td className="text-right">
        <span className="inline-flex items-center gap-1.5 text-[13px] tabular-nums text-text-secondary">
          {group.hasAttachment === 1 && (
            <Paperclip size={11} className="text-text-tertiary" />
          )}
          {group.totalCount}
        </span>
      </td>
      <td className="text-right">
        {group.unreadCount > 0 ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onMarkRead?.(group.id);
            }}
            title="Mark all as read"
            className="tabular inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-foreground"
          >
            {group.unreadCount}
          </button>
        ) : (
          <span className="text-[13px] text-text-tertiary">—</span>
        )}
      </td>
      <td className="text-right">
        <span className="tabular text-[13px] text-text-tertiary">
          {relTime(group.lastEmailAt)}
        </span>
      </td>
      {actions && (
        <td className="!py-0">
          <MailActionButtons
            state={group}
            handlers={actions}
            showStar={false}
            className="justify-end opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          />
        </td>
      )}
    </tr>
  );
}

interface StatTileProps {
  label: string;
  value: number;
  accent?: boolean;
}
function StatTile({ label, value, accent }: StatTileProps) {
  return (
    <div className="border-r border-border px-5 py-3.5 last:border-r-0 max-sm:[&:nth-child(2)]:border-r-0 max-sm:[&:nth-child(-n+2)]:border-b">
      <p className="font-label text-text-tertiary">{label}</p>
      <p
        className={cn(
          "tabular mt-1 text-[22px] font-semibold leading-tight tracking-[-0.02em] text-text-primary",
          accent && value > 0 && "text-accent",
        )}
      >
        {value.toLocaleString()}
      </p>
    </div>
  );
}
