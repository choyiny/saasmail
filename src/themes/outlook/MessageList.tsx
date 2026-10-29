import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArrowDownUp,
  CalendarSearch,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Filter,
  Mail,
  MailOpen,
  Paperclip,
  Pin,
  Trash2,
  Undo2,
  Users,
} from "lucide-react";
import {
  fetchConversationEmails,
  fetchPersonEmails,
  type Email,
  type GroupedItem,
} from "@/lib/api";
import { itemKey, itemTitle } from "@/hooks/useMailList";
import { cn } from "@/lib/utils";
import {
  FILTER_LABELS,
  SORT_LABELS,
  ARRANGE_OPTIONS,
  type ArrangeBy,
  formatListTime,
  groupParticipants,
  type ListFilter,
  type ListSort,
} from "./lib";
import type { OutlookMail } from "./useOutlookMail";
import { useOutlook, type QuickAction } from "./context";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  PointMenu,
} from "./Menu";
import RowMenu from "./RowMenu";
import { ROW_DRAG_TYPE } from "./FolderList";
import { Avatar, FlagGlyph, IconButton } from "./ui";

export function rowSubject(item: GroupedItem): string {
  return item.latestSubject?.trim() || "(No subject)";
}

/** Sender line for a row: the person, or every participant for a group. */
export function rowTitle(item: GroupedItem): string {
  return item.type === "person" ? itemTitle(item) : groupParticipants(item);
}

export function ShimmerRows({
  count = 8,
  mobile,
}: {
  count?: number;
  mobile?: boolean;
}) {
  return (
    <div aria-busy aria-label="Loading messages">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className={cn("ol-row ol-row-shimmer", mobile && "ol-m-row")}
        >
          <span
            className={cn(
              "ol-shimmer rounded-full",
              mobile ? "h-10 w-10" : "h-8 w-8",
            )}
          />
          <span className="flex flex-1 flex-col gap-2">
            <span className="ol-shimmer h-3 w-2/5" />
            <span className="ol-shimmer h-3 w-3/4" />
            <span className="ol-shimmer h-3 w-1/2" />
          </span>
        </div>
      ))}
    </div>
  );
}

export function EmptyFolder({
  title,
  q,
  other,
}: {
  title: string;
  q?: string;
  other?: boolean;
}) {
  return (
    <div className="ol-empty">
      <div className="ol-empty-art" aria-hidden>
        <span className="ol-empty-sun" />
        <span className="ol-empty-hill" />
      </div>
      <p className="text-[16px] font-semibold text-text-primary">
        {q ? "We didn't find anything" : "All caught up"}
      </p>
      <p className="max-w-[280px] text-[13px] text-text-secondary">
        {q
          ? `No results for “${q}”. Try other words, or use the refiners above.`
          : other
            ? "Newsletters, promotions and automated updates land here, out of your way."
            : title === "Deleted Items"
              ? "Nothing in Deleted Items. Deleted conversations wait here until you restore them or empty the folder."
              : title === "Inbox"
                ? "Nothing new here. Enjoy the quiet."
                : `Nothing in ${title}.`}
      </p>
    </div>
  );
}

/** The messages inside a conversation, shown under an expanded row. */
function ExpandedMessages({
  item,
  mail,
}: {
  item: GroupedItem;
  mail: OutlookMail;
}) {
  const [emails, setEmails] = useState<Email[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load =
      item.type === "person"
        ? fetchPersonEmails(item.id, { recipient: mail.label, limit: 25 }).then(
            (r) => r.emails,
          )
        : fetchConversationEmails(item.id).then((r) => r.emails);
    load
      .then((list) => {
        if (!cancelled)
          setEmails([...list].sort((a, b) => b.timestamp - a.timestamp));
      })
      .catch(() => !cancelled && setEmails([]));
    return () => {
      cancelled = true;
    };
  }, [item.type, item.id, mail.label]);

  if (!emails)
    return (
      <div className="ol-sub-row" aria-busy>
        <span className="ol-shimmer h-3 w-2/3" />
      </div>
    );
  return (
    <div role="group" aria-label="Messages in this conversation">
      {emails.map((m) => {
        const unread = m.type === "received" && m.isRead === 0;
        const who =
          m.type === "sent"
            ? `You (${m.fromAddress ?? ""})`
            : item.type === "person"
              ? itemTitle(item)
              : (item.participants.find(
                  (p) =>
                    p.email.toLowerCase() ===
                    (m.fromAddress ?? "").toLowerCase(),
                )?.name ?? m.fromAddress);
        return (
          <button
            key={m.id}
            type="button"
            className={cn("ol-sub-row", unread && "ol-sub-row-unread")}
            onClick={() => {
              mail.openItem(item);
              window.setTimeout(() => {
                window.location.hash = `m=${m.id}`;
              }, 0);
            }}
          >
            <span className="min-w-0 flex-1 truncate text-left">
              <span
                className={cn("text-text-primary", unread && "font-semibold")}
              >
                {who}
              </span>
              <span className="text-text-secondary">
                {" "}
                ·{" "}
                {(m.bodyText ?? "").replace(/\s+/g, " ").slice(0, 90) ||
                  m.subject}
              </span>
            </span>
            <span className="shrink-0 text-[12px] text-text-secondary">
              {formatListTime(m.timestamp)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Row({
  item,
  mail,
  selected,
  focused,
  onMenu,
  onDragRows,
}: {
  item: GroupedItem;
  mail: OutlookMail;
  selected: boolean;
  focused: boolean;
  onMenu: (item: GroupedItem, x: number, y: number) => void;
  onDragRows: (rows: GroupedItem[]) => void;
}) {
  const o = useOutlook();
  const unread = item.unreadCount > 0;
  const title = rowTitle(item);
  const key = itemKey(item);
  const ref = useRef<HTMLDivElement>(null);
  const multi = mail.checkMode || mail.selected.size > 1;
  const isGroup = item.type === "group";
  const inTrash = mail.folder === "deleted";
  const canExpand = item.totalCount > 1;
  const expanded = canExpand && mail.expanded.has(key);
  const identities = new Map(
    (mail.list.stats?.senderIdentities ?? []).map((s) => [
      s.email,
      s.displayName,
    ]),
  );
  const inboxName = isGroup ? identities.get(item.inbox) || item.inbox : null;

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);
  // Keyboard focus follows the cursor row (arrow keys, F6).
  useEffect(() => {
    if (focused && document.activeElement?.closest?.(".ol-list-scroll"))
      ref.current?.focus({ preventScroll: true });
  }, [focused]);

  const quick = (a: QuickAction) => {
    switch (a) {
      case "delete":
        // In Deleted Items this is permanent: admins only, people only.
        if (inTrash && (!mail.canDeleteForever || isGroup)) return null;
        return (
          <IconButton
            key={a}
            label={inTrash ? "Delete forever" : "Delete"}
            size="sm"
            onClick={() => void mail.ops.delete([item])}
          >
            <Trash2 size={16} />
          </IconButton>
        );
      case "archive":
        return inTrash ? (
          <IconButton
            key={a}
            label="Restore"
            size="sm"
            onClick={() => mail.ops.restore([item])}
          >
            <Undo2 size={16} />
          </IconButton>
        ) : (
          <IconButton
            key={a}
            label="Archive"
            size="sm"
            onClick={() => mail.ops.archive([item])}
          >
            <Archive size={16} />
          </IconButton>
        );
      case "flag":
        return (
          <IconButton
            key={a}
            label={item.starred ? "Clear flag" : "Flag this message"}
            size="sm"
            onClick={() => mail.ops.flag([item])}
            className={item.starred ? "ol-qa-on" : undefined}
          >
            <FlagGlyph size={16} filled={item.starred} />
          </IconButton>
        );
      case "pin":
        return (
          <IconButton
            key={a}
            label={item.pinned ? "Unpin" : "Pin this message"}
            size="sm"
            onClick={() => mail.ops.pin([item])}
            className={item.pinned ? "ol-qa-on" : undefined}
          >
            <Pin
              size={16}
              className={item.pinned ? "fill-current" : undefined}
            />
          </IconButton>
        );
      case "read":
        return (
          <IconButton
            key={a}
            label={unread ? "Mark as read" : "Mark as unread"}
            size="sm"
            onClick={() => mail.ops.toggleRead([item])}
          >
            {unread ? <MailOpen size={16} /> : <Mail size={16} />}
          </IconButton>
        );
    }
  };

  return (
    <>
      <div
        ref={ref}
        role="option"
        aria-selected={selected}
        aria-expanded={canExpand ? expanded : undefined}
        aria-label={`${unread ? "Unread. " : ""}${isGroup ? "Group conversation with " : ""}${title}. ${rowSubject(item)}`}
        tabIndex={focused ? 0 : -1}
        data-key={key}
        data-testid="ol-row"
        draggable
        className={cn(
          "ol-row group",
          unread && "ol-row-unread",
          selected && "ol-row-selected",
          multi && "ol-row-multi",
          focused && "ol-row-cursor",
        )}
        onClick={(e) => mail.clickRow(item, e)}
        onFocus={() => {
          if (mail.cursorKey !== key) mail.setCursorKey(key);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(item, e.clientX, e.clientY);
        }}
        onKeyDown={(e) => {
          if (e.key === " ") {
            e.preventDefault();
            mail.toggleChecked(item);
          } else if (
            e.key === "ContextMenu" ||
            (e.shiftKey && e.key === "F10")
          ) {
            e.preventDefault();
            const r = ref.current!.getBoundingClientRect();
            onMenu(item, r.left + 40, r.top + 24);
          } else if (canExpand && e.key === "ArrowRight") {
            e.preventDefault();
            if (!expanded) mail.toggleExpanded(key);
          } else if (canExpand && e.key === "ArrowLeft") {
            e.preventDefault();
            if (expanded) mail.toggleExpanded(key);
          }
        }}
        onDragStart={(e) => {
          const rows = mail.actionRows(item);
          onDragRows(rows);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData(ROW_DRAG_TYPE, rows.map(itemKey).join("\n"));
          e.dataTransfer.setData("text/plain", rows.map(rowSubject).join("\n"));
          const ghost = document.createElement("div");
          ghost.className = "ol-drag-ghost";
          ghost.textContent =
            rows.length === 1 ? rowSubject(rows[0]) : `${rows.length} items`;
          document.body.appendChild(ghost);
          e.dataTransfer.setDragImage(ghost, 16, 16);
          window.setTimeout(() => ghost.remove(), 0);
        }}
      >
        {canExpand ? (
          <button
            type="button"
            className="ol-row-chev"
            aria-label={
              expanded ? "Collapse conversation" : "Expand conversation"
            }
            onClick={(e) => {
              e.stopPropagation();
              mail.toggleExpanded(key);
            }}
            tabIndex={-1}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="ol-row-chev" aria-hidden />
        )}
        <div className="ol-row-avatar">
          {isGroup ? (
            <span className="ol-avatar ol-avatar-group" aria-hidden>
              <Users size={16} />
            </span>
          ) : (
            <Avatar name={title} seed={title} size={32} />
          )}
          <button
            type="button"
            role="checkbox"
            aria-checked={selected && multi}
            aria-label={`Select ${title}`}
            className="ol-row-check"
            onClick={(e) => {
              e.stopPropagation();
              mail.toggleChecked(item);
            }}
          >
            {selected && multi && <Check size={14} strokeWidth={3} />}
          </button>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[14px] text-text-primary",
                unread && "font-semibold",
              )}
              title={title}
            >
              {title}
            </span>
            <span className="ol-row-icons">
              {item.hasAttachment > 0 && (
                <Paperclip size={14} aria-label="Has attachments" />
              )}
              {item.pinned && (
                <Pin size={14} className="fill-current" aria-label="Pinned" />
              )}
              {item.starred && (
                <span aria-label="Flagged" className="text-star">
                  <FlagGlyph size={14} filled />
                </span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[13px]",
                unread ? "font-semibold text-accent" : "text-text-primary",
              )}
            >
              {rowSubject(item)}
            </span>
            <span
              className={cn(
                "ol-row-time shrink-0 text-[12px]",
                unread ? "font-semibold text-accent" : "text-text-secondary",
              )}
            >
              {formatListTime(item.lastEmailAt)}
            </span>
          </div>
          <div className="ol-row-preview flex items-center gap-1.5 text-[13px] text-text-secondary">
            {inboxName && <span className="ol-row-inbox">{inboxName}</span>}
            <span className="min-w-0 truncate">{item.snippet || " "}</span>
          </div>
        </div>
        {o.quickActions.length > 0 && (
          <div
            className="ol-row-hover"
            onClick={(e) => e.stopPropagation()}
            role="toolbar"
            aria-label="Quick actions"
          >
            {o.quickActions.map(quick)}
          </div>
        )}
      </div>
      {expanded && <ExpandedMessages item={item} mail={mail} />}
    </>
  );
}

export default function MessageList({
  mail,
  onDragRows,
}: {
  mail: OutlookMail;
  onDragRows: (rows: GroupedItem[]) => void;
}) {
  const o = useOutlook();
  const { list, groups } = mail;
  const sentinel = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusKey =
    mail.cursorKey ?? mail.openKey ?? [...mail.selected][0] ?? null;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => setCollapsed(new Set()), [mail.folder, mail.label, mail.q]);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    rows: GroupedItem[];
  } | null>(null);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !mail.hasMore) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void mail.loadMore();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [mail.hasMore, mail.loadMore, mail]);

  const empty = !list.loading && !list.error && mail.visible.length === 0;

  const jumpTo = (label: string) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-group="${CSS.escape(label)}"]`,
    );
    el?.scrollIntoView({ block: "start" });
  };

  return (
    <section className="ol-list" aria-label="Message list">
      <div className="ol-list-head">
        <div className="flex min-w-0 items-center gap-1">
          <IconButton
            label={mail.checkMode ? "Exit selection mode" : "Select"}
            size="sm"
            aria-pressed={mail.checkMode}
            className={mail.checkMode ? "text-accent" : undefined}
            onClick={() => {
              if (mail.checkMode) mail.clearSelection();
              else mail.setCheckMode(true);
            }}
          >
            <CheckSquare size={16} />
          </IconButton>
          {mail.showFocusTabs ? (
            <div className="ol-pivot" role="tablist" aria-label="Focused Inbox">
              {(["focused", "other"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={mail.focusTab === t}
                  className={cn(
                    "ol-pivot-tab",
                    mail.focusTab === t && "ol-pivot-on",
                  )}
                  onClick={() => mail.setFocusTab(t)}
                >
                  {t === "focused" ? "Focused" : "Other"}
                  {t === "other" && mail.otherUnreadCount > 0 && (
                    <span
                      className="ol-pivot-count"
                      aria-label={`${mail.otherUnreadCount} unread`}
                    >
                      {mail.otherUnreadCount}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <h2
              className="truncate text-[16px] font-semibold text-text-primary"
              title={mail.folderTitle}
            >
              {mail.folderTitle}
            </h2>
          )}
          {mail.selected.size > 1 && (
            <span className="shrink-0 text-[12px] text-text-secondary">
              · {mail.selected.size} selected
            </span>
          )}
        </div>
        <div className="flex items-center">
          <Menu>
            <MenuTrigger asChild>
              <IconButton label="Jump to" size="sm">
                <CalendarSearch size={16} />
              </IconButton>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuLabel>Jump to</MenuLabel>
              {groups.map((g) => (
                <MenuItem
                  key={g.label}
                  onSelect={() => jumpTo(g.label)}
                  shortcut={String(g.items.length)}
                >
                  {g.label}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
          <Menu>
            <MenuTrigger asChild>
              <IconButton
                label={`Filter: ${FILTER_LABELS[mail.filter]}`}
                size="sm"
                className={mail.filter !== "all" ? "text-accent" : undefined}
              >
                <Filter size={16} />
              </IconButton>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuLabel>Filter</MenuLabel>
              <MenuRadioGroup
                value={mail.filter}
                onValueChange={(v) => mail.setFilter(v as ListFilter)}
              >
                {(Object.keys(FILTER_LABELS) as ListFilter[]).map((f) => (
                  <MenuRadioItem key={f} value={f}>
                    {FILTER_LABELS[f]}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuContent>
          </Menu>
          <Menu>
            <MenuTrigger asChild>
              <IconButton label="Sort and view options" size="sm">
                <ArrowDownUp size={16} />
              </IconButton>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuLabel>Arrange by</MenuLabel>
              <MenuRadioGroup
                value={mail.sort}
                onValueChange={(v) => mail.setSort(v as ArrangeBy)}
              >
                {ARRANGE_OPTIONS.map((s) => (
                  <MenuRadioItem key={s} value={s}>
                    {SORT_LABELS[s]}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuContent>
          </Menu>
        </div>
      </div>
      {mail.filter !== "all" && (
        <div className="ol-filter-chip-row">
          <button
            type="button"
            className="ol-filter-chip"
            onClick={() => mail.setFilter("all")}
            aria-label={`Clear filter ${FILTER_LABELS[mail.filter]}`}
          >
            {FILTER_LABELS[mail.filter]} ×
          </button>
        </div>
      )}
      {mail.showFocusTabs &&
        mail.focusTab === "focused" &&
        mail.otherNewCount > 0 && (
          <button
            type="button"
            className="ol-other-hint"
            onClick={() => mail.setFocusTab("other")}
          >
            <span className="text-text-secondary">Other:</span>{" "}
            {mail.otherNewCount} new message
            {mail.otherNewCount === 1 ? "" : "s"} since you last looked
          </button>
        )}

      <div
        ref={scrollRef}
        className="ol-list-scroll"
        role="listbox"
        aria-label={mail.folderTitle}
        aria-multiselectable
        tabIndex={focusKey ? -1 : 0}
        onFocus={(e) => {
          // Tabbing into an empty selection lands on the first row.
          if (e.target === e.currentTarget && !focusKey && mail.order[0])
            mail.setCursorKey(mail.order[0]);
        }}
      >
        {list.loading && mail.allItems.length === 0 ? (
          <ShimmerRows />
        ) : list.error ? (
          <div className="ol-empty">
            <p className="text-[14px] text-text-secondary">{list.error}</p>
            <button
              type="button"
              className="ol-btn-outline"
              onClick={list.refresh}
            >
              Try again
            </button>
          </div>
        ) : empty ? (
          <EmptyFolder
            title={mail.folderTitle}
            q={mail.q}
            other={mail.showFocusTabs && mail.focusTab === "other"}
          />
        ) : (
          groups.map((g) => (
            <div
              key={g.label}
              role="group"
              aria-label={g.label}
              data-group={g.label}
            >
              <button
                type="button"
                className="ol-group-head"
                aria-expanded={!collapsed.has(g.label)}
                onClick={() =>
                  setCollapsed((c) => {
                    const n = new Set(c);
                    if (n.has(g.label)) n.delete(g.label);
                    else n.add(g.label);
                    return n;
                  })
                }
              >
                <ChevronRight
                  size={14}
                  aria-hidden
                  className={cn(
                    "ol-chev",
                    !collapsed.has(g.label) && "ol-chev-open",
                  )}
                />
                {g.label}
              </button>
              {(collapsed.has(g.label) ? [] : g.items).map((it) => {
                const k = itemKey(it);
                return (
                  <Row
                    key={k}
                    item={it}
                    mail={mail}
                    selected={mail.selected.has(k) || mail.openKey === k}
                    focused={focusKey === k}
                    onMenu={(row, x, y) =>
                      setMenu({ x, y, rows: mail.actionRows(row) })
                    }
                    onDragRows={onDragRows}
                  />
                );
              })}
            </div>
          ))
        )}
        {mail.hasMore && (
          <div ref={sentinel} className="flex justify-center py-3">
            <button
              type="button"
              className="ol-link text-[13px]"
              onClick={() => void mail.loadMore()}
            >
              {list.loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>
      <PointMenu
        point={menu}
        onClose={() => setMenu(null)}
        label="Message actions"
      >
        {menu && <RowMenu items={menu.rows} mail={mail} />}
      </PointMenu>
    </section>
  );
}
