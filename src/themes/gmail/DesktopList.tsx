import { memo, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  FolderInput,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  EllipsisVertical,
  GripVertical,
  Inbox as InboxIcon,
  Mail,
  MailOpen,
  Paperclip,
  Pin,
  RotateCw,
  Star,
  Trash2,
} from "lucide-react";
import type { GroupedItem, MailCategory, Stats } from "@/lib/api";
import { CATEGORY_ICONS } from "./Nav";
import { itemKey, itemTitle } from "@/hooks/useMailList";
import { cn } from "@/lib/utils";
import {
  CATEGORIES,
  CATEGORY_LABELS,
  formatListDate,
  type GmailFolder,
} from "./lib";
import { canMoveToTab, inInboxView, type RowActions } from "./actions";
import { GmMenu, GmMenuItem, LabelChip, SnoozeMenu } from "./ui";

export type SelectPreset =
  | "all"
  | "none"
  | "read"
  | "unread"
  | "starred"
  | "unstarred";

interface ToolbarProps {
  items: GroupedItem[];
  selected: GroupedItem[];
  folder: GmailFolder;
  act: RowActions;
  onSelectPreset: (p: SelectPreset) => void;
  onRefresh: () => void;
  onMarkAllRead: () => void;
  range: string;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  compactRange?: boolean;
  /** "Select all N" is on: per-sender actions are hidden. */
  allMode?: boolean;
}

function IconBtn({
  label,
  children,
  onClick,
  disabled,
  testId,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className="gm-icon-btn"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

export function ListToolbar({
  items,
  selected,
  folder,
  act,
  onSelectPreset,
  onRefresh,
  onMarkAllRead,
  range,
  canPrev,
  canNext,
  onPrev,
  onNext,
  allMode,
}: ToolbarProps) {
  const n = selected.length;
  const all = n > 0 && n === items.length;
  const some = n > 0 && !all;
  const anyArchived = selected.some((s) => !inInboxView(s));
  const allStarred = n > 0 && selected.every((s) => s.starred);
  const allPinned = n > 0 && selected.every((s) => s.pinned);
  const anyUnread = selected.some((s) => s.unreadCount > 0);
  const inTrash = folder === "trash";
  const canDelete = !inTrash || selected.some((s) => s.type === "person");
  // In Trash, Delete means delete forever: admins only.
  const showDelete = !inTrash || act.canDeleteForever;
  const canMoveTab = canMoveToTab(selected);

  return (
    <div
      className="flex h-12 flex-none items-center gap-0.5 pl-2 pr-3"
      role="toolbar"
      aria-label="Mail actions"
    >
      <div className="flex items-center rounded-[4px] hover:bg-[var(--chrome-hover)]">
        <label className="flex h-10 w-8 cursor-pointer items-center justify-end">
          <input
            type="checkbox"
            className="gm-check"
            aria-label="Select all"
            checked={all}
            ref={(el) => {
              if (el) el.indeterminate = some;
            }}
            onChange={() => onSelectPreset(n > 0 ? "none" : "all")}
            data-testid="gmail-select-all"
          />
        </label>
        <GmMenu
          trigger={
            <button
              type="button"
              className="flex h-10 w-5 items-center justify-center text-text-secondary"
              aria-label="Select"
              title="Select"
            >
              <ChevronDown size={14} />
            </button>
          }
        >
          {(
            [
              ["all", "All"],
              ["none", "None"],
              ["read", "Read"],
              ["unread", "Unread"],
              ["starred", "Starred"],
              ["unstarred", "Unstarred"],
            ] as Array<[SelectPreset, string]>
          ).map(([p, l]) => (
            <GmMenuItem key={p} onSelect={() => onSelectPreset(p)}>
              {l}
            </GmMenuItem>
          ))}
        </GmMenu>
      </div>

      {n === 0 ? (
        <>
          <IconBtn label="Refresh" onClick={onRefresh} testId="gmail-refresh">
            <RotateCw size={20} />
          </IconBtn>
          <GmMenu
            trigger={
              <button
                type="button"
                className="gm-icon-btn"
                aria-label="More"
                title="More"
              >
                <EllipsisVertical size={20} />
              </button>
            }
          >
            <GmMenuItem icon={<MailOpen size={20} />} onSelect={onMarkAllRead}>
              Mark all as read
            </GmMenuItem>
          </GmMenu>
        </>
      ) : (
        <div className="flex items-center gap-0.5" data-testid="gmail-bulk-bar">
          {inTrash ? (
            <IconBtn
              label="Restore"
              onClick={() => act.restore(selected)}
              testId="gmail-bulk-restore"
            >
              <ArchiveRestore size={20} />
            </IconBtn>
          ) : anyArchived || folder === "archive" || folder === "snoozed" ? (
            <IconBtn
              label="Move to inbox"
              onClick={() => act.moveToInbox(selected)}
            >
              <InboxIcon size={20} />
            </IconBtn>
          ) : (
            <IconBtn
              label="Archive"
              onClick={() => act.archive(selected)}
              testId="gmail-bulk-archive"
            >
              <Archive size={20} />
            </IconBtn>
          )}
          {showDelete && (
            <IconBtn
              label={
                inTrash
                  ? canDelete
                    ? "Delete forever"
                    : "Group conversations stay in Trash"
                  : "Delete"
              }
              onClick={() => act.requestDelete(selected)}
              disabled={!canDelete}
              testId="gmail-bulk-delete"
            >
              <Trash2 size={20} />
            </IconBtn>
          )}
          <span className="mx-2 h-5 w-px bg-border" />
          {anyUnread ? (
            <IconBtn
              label="Mark as read"
              onClick={() => act.markRead(selected)}
            >
              <MailOpen size={20} />
            </IconBtn>
          ) : (
            <IconBtn
              label="Mark as unread"
              onClick={() => void act.markUnread(selected)}
            >
              <Mail size={20} />
            </IconBtn>
          )}
          <SnoozeMenu
            trigger={
              <button
                type="button"
                className="gm-icon-btn"
                aria-label="Snooze"
                title="Snooze"
              >
                <Clock size={20} />
              </button>
            }
            onSnooze={(until) => act.snooze(selected, until)}
            onPick={() => act.pickSnooze(selected)}
          />
          <span className="mx-2 h-5 w-px bg-border" />
          <IconBtn
            label={allStarred ? "Remove star" : "Add star"}
            onClick={() => act.star(selected, !allStarred)}
          >
            <Star
              size={20}
              className={allStarred ? "fill-current text-star" : undefined}
            />
          </IconBtn>
          <IconBtn
            label={allPinned ? "Unpin" : "Pin"}
            onClick={() => act.pin(selected, !allPinned)}
          >
            <Pin
              size={20}
              className={allPinned ? "fill-current text-accent" : undefined}
            />
          </IconBtn>
          <GmMenu
            trigger={
              <button
                type="button"
                className="gm-icon-btn"
                aria-label="More actions"
                title="More"
                data-testid="gmail-bulk-more"
              >
                <EllipsisVertical size={20} />
              </button>
            }
          >
            {anyUnread ? (
              <GmMenuItem
                icon={<Mail size={20} />}
                onSelect={() => void act.markUnread(selected)}
              >
                Mark as unread
              </GmMenuItem>
            ) : (
              <GmMenuItem
                icon={<MailOpen size={20} />}
                onSelect={() => act.markRead(selected)}
              >
                Mark as read
              </GmMenuItem>
            )}
            {!allMode &&
              canMoveTab &&
              (
                ["primary", "promotions", "social", "updates"] as MailCategory[]
              ).map((c) => (
                <GmMenuItem
                  key={c}
                  icon={<FolderInput size={20} />}
                  onSelect={() => act.moveToCategory(selected, c)}
                >
                  Move to {CATEGORY_LABELS[c]}
                </GmMenuItem>
              ))}
            <GmMenuItem
              icon={<InboxIcon size={20} />}
              onSelect={() => act.moveToInbox(selected)}
            >
              Move to inbox
            </GmMenuItem>
            <GmMenuItem
              icon={<Archive size={20} />}
              onSelect={() => act.archive(selected)}
            >
              Archive
            </GmMenuItem>
          </GmMenu>
        </div>
      )}

      <div className="flex-1" />
      <span className="mr-2 whitespace-nowrap text-xs text-text-secondary">
        {range}
      </span>
      <IconBtn label="Newer" onClick={onPrev} disabled={!canPrev}>
        <ChevronLeft size={20} />
      </IconBtn>
      <IconBtn label="Older" onClick={onNext} disabled={!canNext}>
        <ChevronRight size={20} />
      </IconBtn>
    </div>
  );
}

/* ── Row ───────────────────────────────────────────────────────────── */

interface RowProps {
  item: GroupedItem;
  folder: GmailFolder;
  selected: boolean;
  focused: boolean;
  showLabels: boolean;
  identities: Stats["senderIdentities"];
  act: RowActions;
  onOpen: (item: GroupedItem) => void;
  onToggleSelect: (item: GroupedItem, range: boolean) => void;
  onFocus: (item: GroupedItem) => void;
  onContextMenu: (e: React.MouseEvent, item: GroupedItem) => void;
  dragging?: boolean;
  onDragStart: (e: React.DragEvent, item: GroupedItem) => void;
  onDragEnd: () => void;
  narrow?: boolean;
}

function labelsOf(item: GroupedItem): string[] {
  return item.type === "person" ? item.recipients : [item.inbox];
}

export const MailRow = memo(function MailRow({
  item,
  folder,
  selected,
  focused,
  showLabels,
  identities,
  act,
  onOpen,
  onToggleSelect,
  onFocus,
  onContextMenu,
  dragging,
  onDragStart,
  onDragEnd,
  narrow,
}: RowProps) {
  const unread = item.unreadCount > 0;
  const title = itemTitle(item);
  const inView = inInboxView(item);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div
      role="row"
      tabIndex={focused ? 0 : -1}
      className="gm-row"
      data-unread={unread ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-focused={focused ? "true" : undefined}
      data-dragging={dragging ? "true" : undefined}
      data-testid="gmail-row"
      data-key={itemKey(item)}
      aria-selected={selected}
      aria-label={`${unread ? "Unread, " : ""}${title}, ${item.latestSubject ?? "no subject"}, ${formatListDate(item.lastEmailAt)}`}
      draggable
      onDragStart={(e) => onDragStart(e, item)}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(item)}
      onContextMenu={(e) => onContextMenu(e, item)}
      onFocus={() => onFocus(item)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter") {
          e.preventDefault();
          onOpen(item);
        }
        if (e.key === " ") {
          e.preventDefault();
          onToggleSelect(item, false);
        }
      }}
    >
      <span className="gm-grip" aria-hidden title="Drag to a folder">
        <GripVertical size={14} />
      </span>
      <label
        className="flex h-10 w-8 flex-none cursor-pointer items-center justify-center"
        onClick={stop}
      >
        <input
          type="checkbox"
          className="gm-check"
          checked={selected}
          aria-label={`Select ${title}`}
          onChange={() => {}}
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect(item, e.shiftKey);
          }}
        />
      </label>
      <button
        type="button"
        className="gm-icon-btn gm-xs flex-none"
        aria-label={item.starred ? "Starred" : "Not starred"}
        title={item.starred ? "Starred" : "Not starred"}
        aria-pressed={item.starred}
        onClick={(e) => {
          stop(e);
          act.star([item]);
        }}
        data-testid="gmail-row-star"
      >
        <Star
          size={18}
          className={item.starred ? "fill-current text-star" : undefined}
          strokeWidth={item.starred ? 1.5 : 2}
        />
      </button>
      <button
        type="button"
        className={cn(
          "gm-icon-btn gm-xs flex-none",
          !item.pinned &&
            "opacity-0 hover:opacity-100 focus-visible:opacity-100",
        )}
        aria-label={item.pinned ? "Pinned" : "Pin"}
        title={item.pinned ? "Pinned — click to unpin" : "Pin to top"}
        aria-pressed={item.pinned}
        onClick={(e) => {
          stop(e);
          act.pin([item]);
        }}
      >
        <Pin
          size={16}
          className={item.pinned ? "fill-current text-warning" : undefined}
        />
      </button>

      <div
        className={cn(
          "flex min-w-0 flex-none items-baseline gap-1 pl-1 pr-4",
          narrow ? "w-[140px]" : "w-[188px]",
        )}
      >
        <span className="truncate">
          {folder === "sent" ? `To: ${title}` : title}
        </span>
        {item.totalCount > 1 && (
          <span className="flex-none text-xs font-normal text-text-secondary">
            {item.totalCount}
          </span>
        )}
        {folder === "drafts" && (
          <span className="flex-none font-normal text-destructive">Draft</span>
        )}
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {showLabels &&
          labelsOf(item)
            .slice(0, 2)
            .map((addr) => (
              <LabelChip
                key={addr}
                address={addr}
                displayName={
                  identities.find((s) => s.email === addr)?.displayName
                }
                onClick={() => act.showLabel(addr)}
              />
            ))}
        <span className="min-w-0 truncate">
          <span>{item.latestSubject || "(no subject)"}</span>
          {item.snippet && (
            <span className="font-normal text-text-secondary">
              {" - "}
              {item.snippet}
            </span>
          )}
        </span>
      </div>

      {item.hasAttachment > 0 && (
        <Paperclip
          size={16}
          className="ml-2 flex-none text-text-secondary"
          aria-label="Has attachment"
        />
      )}

      <div className="gm-row-date ml-3 w-[72px] flex-none text-right text-xs">
        {folder === "snoozed" && item.snoozedUntil ? (
          <span className="text-warning" title="Snoozed until">
            {formatListDate(item.snoozedUntil)}
          </span>
        ) : (
          <span
            className={
              unread ? "font-bold text-text-primary" : "text-text-secondary"
            }
          >
            {formatListDate(item.lastEmailAt)}
          </span>
        )}
      </div>

      <div
        className="gm-row-actions ml-2 flex-none items-center"
        onClick={stop}
      >
        {item.trashedAt ? (
          <button
            type="button"
            className="gm-icon-btn gm-sm"
            aria-label="Restore"
            title="Restore"
            onClick={() => act.restore([item])}
            data-testid="gmail-row-restore"
          >
            <ArchiveRestore size={18} />
          </button>
        ) : inView ? (
          <button
            type="button"
            className="gm-icon-btn gm-sm"
            aria-label="Archive"
            title="Archive"
            onClick={() => act.archive([item])}
            data-testid="gmail-row-archive"
          >
            <Archive size={18} />
          </button>
        ) : (
          <button
            type="button"
            className="gm-icon-btn gm-sm"
            aria-label="Move to inbox"
            title="Move to inbox"
            onClick={() => act.moveToInbox([item])}
          >
            <InboxIcon size={18} />
          </button>
        )}
        {(!item.trashedAt || act.canDeleteForever) && (
          <button
            type="button"
            className="gm-icon-btn gm-sm"
            aria-label={item.trashedAt ? "Delete forever" : "Delete"}
            title={
              !item.trashedAt
                ? "Delete"
                : item.type === "person"
                  ? "Delete forever"
                  : "Group conversations stay in Trash"
            }
            disabled={!!item.trashedAt && item.type !== "person"}
            onClick={() => act.requestDelete([item])}
            data-testid="gmail-row-delete"
          >
            <Trash2 size={18} />
          </button>
        )}
        {unread ? (
          <button
            type="button"
            className="gm-icon-btn gm-sm"
            aria-label="Mark as read"
            title="Mark as read"
            onClick={() => act.markRead([item])}
          >
            <MailOpen size={18} />
          </button>
        ) : (
          <button
            type="button"
            className="gm-icon-btn gm-sm"
            aria-label="Mark as unread"
            title="Mark as unread"
            onClick={() => void act.markUnread([item])}
          >
            <Mail size={18} />
          </button>
        )}
        <SnoozeMenu
          align="end"
          trigger={
            <button
              type="button"
              className="gm-icon-btn gm-sm"
              aria-label="Snooze"
              title="Snooze"
            >
              <Clock size={18} />
            </button>
          }
          onSnooze={(until) => act.snooze([item], until)}
          onPick={() => act.pickSnooze([item])}
        />
      </div>
    </div>
  );
});

export function SkeletonRows({ count = 12 }: { count?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading mail">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 border-b border-border-subtle px-4"
          style={{ height: "var(--gm-row-h)" }}
        >
          <span className="gm-skel h-4 w-4" />
          <span className="gm-skel h-4 w-4 rounded-full" />
          <span className="gm-skel h-3 w-36" />
          <span
            className="gm-skel h-3 flex-1"
            style={{ maxWidth: `${50 + ((i * 37) % 40)}%` }}
          />
          <span className="gm-skel ml-auto h-3 w-12" />
        </div>
      ))}
    </div>
  );
}

/* ── Inbox tabs ────────────────────────────────────────────────────── */

export function CategoryTabs({
  active,
  counts,
  onSelect,
}: {
  active: MailCategory;
  counts: Partial<Record<MailCategory, number>>;
  onSelect: (c: MailCategory) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Inbox categories"
      className="flex h-14 flex-none border-b border-border"
      data-testid="gmail-tabs"
    >
      {CATEGORIES.map((c) => {
        const Icon = CATEGORY_ICONS[c];
        const n = c === "primary" ? 0 : (counts[c] ?? 0);
        const on = c === active;
        return (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={on}
            className="gm-tab"
            data-cat={c}
            data-active={on ? "true" : undefined}
            onClick={() => onSelect(c)}
            title={
              n > 0
                ? `${CATEGORY_LABELS[c]}: ${n} new since you last opened this tab`
                : CATEGORY_LABELS[c]
            }
            data-testid={`gmail-tab-${c}`}
          >
            <Icon size={20} className="gm-tab-icon" />
            <span className="truncate">{CATEGORY_LABELS[c]}</span>
            {n > 0 && (
              <span className="gm-tab-badge">{n > 99 ? "99+" : n} new</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ── "Select all N conversations" banner ───────────────────────────── */

export function SelectAllBanner({
  pageCount,
  total,
  where,
  allSelected,
  loading,
  onSelectAll,
  onClear,
}: {
  pageCount: number;
  total: number;
  where: string;
  allSelected: boolean;
  loading: boolean;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  return (
    <div
      className="flex h-10 flex-none items-center justify-center gap-2 border-b border-border bg-bg-subtle px-4 text-sm"
      role="status"
      data-testid="gmail-select-all-banner"
    >
      {allSelected ? (
        <>
          <span>
            All <b>{total.toLocaleString()}</b> conversations in {where} are
            selected.
          </span>
          <button
            type="button"
            className="font-medium text-accent hover:underline"
            onClick={onClear}
          >
            Clear selection
          </button>
        </>
      ) : (
        <>
          <span>
            All <b>{pageCount}</b> conversations on this page are selected.
          </span>
          <button
            type="button"
            className="font-medium text-accent hover:underline disabled:opacity-60"
            onClick={onSelectAll}
            disabled={loading}
            data-testid="gmail-select-all-pages"
          >
            {loading
              ? "Selecting…"
              : `Select all ${total.toLocaleString()} conversations in ${where}`}
          </button>
        </>
      )}
    </div>
  );
}
