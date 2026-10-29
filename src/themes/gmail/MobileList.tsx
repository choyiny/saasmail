import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  EllipsisVertical,
  Inbox as InboxIcon,
  Mail,
  MailOpen,
  Menu as MenuIcon,
  Paperclip,
  Pencil,
  Pin,
  RotateCw,
  Clock,
  Star,
  Trash2,
  X,
} from "lucide-react";
import type { GroupedItem } from "@/lib/api";
import { itemKey, itemTitle } from "@/hooks/useMailList";
import { cn } from "@/lib/utils";
import { AccountAvatar } from "./GmailShell";
import { formatListDate, type GmailFolder } from "./lib";
import { inInboxView, type RowActions } from "./actions";
import type { SwipeAction } from "./state";
import { Avatar, GmMenu, GmMenuItem } from "./ui";

/* ── Swipeable row ─────────────────────────────────────────────────── */

const SWIPE_FRACTION = 0.33;

function MobileRow({
  item,
  folder,
  selected,
  selecting,
  act,
  onOpen,
  onToggleSelect,
  swipeLeft,
  swipeRight,
}: {
  item: GroupedItem;
  folder: GmailFolder;
  selected: boolean;
  selecting: boolean;
  act: RowActions;
  onOpen: (item: GroupedItem) => void;
  onToggleSelect: (item: GroupedItem) => void;
  swipeLeft: SwipeAction;
  swipeRight: SwipeAction;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [dx, setDx] = useState(0);
  const [leaving, setLeaving] = useState<0 | 1 | -1>(0);
  const gesture = useRef<{
    x: number;
    y: number;
    id: number;
    mode: "idle" | "swipe" | "scroll";
    moved: boolean;
  } | null>(null);
  const longPress = useRef<number | undefined>(undefined);
  const suppressClick = useRef(false);
  const unread = item.unreadCount > 0;
  const title = itemTitle(item);
  const inView = inInboxView(item);

  const actionFor = (dir: number): SwipeAction =>
    dir > 0 ? swipeRight : swipeLeft;
  /** Archive leaves the list; the others act and the row springs back. */
  const runSwipe = (a: SwipeAction) => {
    if (a === "archive") {
      if (inView) act.archive([item]);
      else act.moveToInbox([item]);
    } else if (a === "delete") act.requestDelete([item]);
    else if (a === "read") {
      if (unread) act.markRead([item]);
      else void act.markUnread([item]);
    } else if (a === "snooze") act.pickSnooze([item]);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    gesture.current = {
      x: e.clientX,
      y: e.clientY,
      id: e.pointerId,
      mode: "idle",
      moved: false,
    };
    window.clearTimeout(longPress.current);
    longPress.current = window.setTimeout(() => {
      const g = gesture.current;
      if (g && g.mode === "idle" && !g.moved) {
        suppressClick.current = true;
        navigator.vibrate?.(10);
        onToggleSelect(item);
      }
    }, 500);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const mx = e.clientX - g.x;
    const my = e.clientY - g.y;
    if (Math.abs(mx) > 6 || Math.abs(my) > 6) {
      g.moved = true;
      window.clearTimeout(longPress.current);
    }
    if (g.mode === "idle") {
      if (selecting) return;
      if (Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my) * 1.4) {
        g.mode = "swipe";
        rowRef.current?.setPointerCapture(e.pointerId);
      } else if (Math.abs(my) > 10) {
        g.mode = "scroll";
      }
    }
    if (g.mode === "swipe")
      setDx(
        actionFor(mx) === "none"
          ? Math.sign(mx) * Math.min(24, Math.abs(mx) / 4)
          : mx,
      );
  };

  const finish = (e: React.PointerEvent) => {
    window.clearTimeout(longPress.current);
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.mode !== "swipe") return;
    suppressClick.current = true;
    const width = rowRef.current?.offsetWidth ?? 360;
    const mx = e.clientX - g.x;
    const dir = mx > 0 ? 1 : -1;
    const a = actionFor(dir);
    if (a !== "none" && Math.abs(mx) > width * SWIPE_FRACTION) {
      if (a === "archive" || (a === "delete" && !item.trashedAt)) {
        setLeaving(dir);
        setDx(dir * width);
        window.setTimeout(() => runSwipe(a), 180);
      } else {
        setDx(0);
        runSwipe(a);
      }
    } else {
      setDx(0);
    }
  };

  useEffect(() => () => window.clearTimeout(longPress.current), []);

  const swiping = dx !== 0;
  const date =
    folder === "snoozed" && item.snoozedUntil
      ? formatListDate(item.snoozedUntil)
      : formatListDate(item.lastEmailAt);

  return (
    <div
      className="relative overflow-hidden"
      style={
        leaving
          ? {
              maxHeight: 0,
              transition: "max-height 0.2s ease 0.15s",
            }
          : { maxHeight: 200 }
      }
    >
      {swiping && (
        <div
          className="gm-m-swipe-bg"
          data-action={actionFor(dx)}
          style={{ justifyContent: dx > 0 ? "flex-start" : "flex-end" }}
          aria-hidden
        >
          {(() => {
            const a = actionFor(dx);
            if (a === "archive")
              return inView ? <Archive size={24} /> : <InboxIcon size={24} />;
            if (a === "delete") return <Trash2 size={24} />;
            if (a === "read")
              return unread ? <MailOpen size={24} /> : <Mail size={24} />;
            if (a === "snooze") return <Clock size={24} />;
            return null;
          })()}
        </div>
      )}
      <div
        ref={rowRef}
        className="gm-m-row"
        data-selected={selected ? "true" : undefined}
        data-testid="gmail-mrow"
        data-key={itemKey(item)}
        role="listitem"
        style={{
          transform: dx ? `translateX(${dx}px)` : undefined,
          transition: gesture.current ? "none" : "transform 0.18s ease",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={(e) => {
          window.clearTimeout(longPress.current);
          gesture.current = null;
          if (!leaving) setDx(0);
          void e;
        }}
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          if (selecting) onToggleSelect(item);
          else onOpen(item);
        }}
      >
        <button
          type="button"
          className="relative flex-none self-start rounded-full"
          aria-label={selected ? `Deselect ${title}` : `Select ${title}`}
          aria-pressed={selected}
          onClick={(e) => {
            e.stopPropagation();
            if (suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            onToggleSelect(item);
          }}
          data-testid="gmail-mrow-avatar"
        >
          {selected ? (
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-accent-foreground">
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
                <path
                  d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"
                  fill="currentColor"
                />
              </svg>
            </span>
          ) : (
            <Avatar
              name={
                item.type === "person" ? item.name : item.participants[0]?.name
              }
              email={
                item.type === "person"
                  ? item.email
                  : item.participants[0]?.email
              }
              size={40}
            />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-base",
                unread ? "font-bold text-text-primary" : "text-text-primary",
              )}
            >
              {folder === "sent" ? `To: ${title}` : title}
              {item.totalCount > 1 && (
                <span className="ml-1 text-sm font-normal text-text-secondary">
                  {item.totalCount}
                </span>
              )}
            </span>
            <span
              className={cn(
                "flex-none text-xs",
                unread ? "font-bold text-text-primary" : "text-text-secondary",
                folder === "snoozed" && "text-warning",
              )}
            >
              {date}
            </span>
          </div>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "truncate text-sm",
                  unread ? "font-bold text-text-primary" : "text-text-primary",
                )}
              >
                {item.pinned && (
                  <Pin
                    size={13}
                    className="mr-1 inline fill-current align-[-1px] text-warning"
                    aria-label="Pinned"
                  />
                )}
                {item.latestSubject || "(no subject)"}
              </p>
              <p className="truncate text-sm text-text-secondary">
                {item.hasAttachment > 0 && (
                  <Paperclip
                    size={13}
                    className="mr-1 inline align-[-1px]"
                    aria-label="Has attachment"
                  />
                )}
                {item.snippet || " "}
              </p>
            </div>
            <button
              type="button"
              className="-mr-2 -mt-1 flex h-9 w-9 flex-none items-center justify-center text-text-secondary"
              aria-label={item.starred ? "Starred" : "Not starred"}
              aria-pressed={item.starred}
              onClick={(e) => {
                e.stopPropagation();
                if (suppressClick.current) {
                  suppressClick.current = false;
                  return;
                }
                act.star([item]);
              }}
            >
              <Star
                size={20}
                className={item.starred ? "fill-current text-star" : undefined}
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Top bars ──────────────────────────────────────────────────────── */

export function MobileSearchBar({
  value,
  onChange,
  onSubmit,
  onMenu,
  onAccount,
  inputRef,
  searching,
  onClear,
  onActivate,
}: {
  /** Open the full-screen search instead of typing in place. */
  onActivate?: () => void;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onMenu: () => void;
  onAccount: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  searching: boolean;
  onClear: () => void;
}) {
  return (
    <form
      role="search"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit();
        inputRef.current?.blur();
      }}
      className="mx-4 flex h-12 items-center rounded-full bg-bg-muted"
    >
      {searching ? (
        <button
          type="button"
          className="gm-icon-btn ml-1"
          style={{ width: 44, height: 44 }}
          aria-label="Back to inbox"
          onClick={onClear}
        >
          <ArrowLeft size={22} />
        </button>
      ) : (
        <button
          type="button"
          className="gm-icon-btn ml-1"
          style={{ width: 44, height: 44 }}
          aria-label="Open navigation drawer"
          onClick={onMenu}
          data-testid="gmail-m-menu"
        >
          <MenuIcon size={22} />
        </button>
      )}
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search in mail"
        aria-label="Search in mail"
        onFocus={onActivate}
        readOnly={!!onActivate}
        enterKeyHint="search"
        className="h-full min-w-0 flex-1 bg-transparent px-1 text-base text-text-primary outline-none placeholder:text-text-secondary"
        data-testid="gmail-m-search"
      />
      {value && (
        <button
          type="button"
          className="gm-icon-btn"
          aria-label="Clear search"
          onClick={onClear}
        >
          <X size={20} />
        </button>
      )}
      <button
        type="button"
        className="gm-icon-btn mr-1"
        style={{ width: 44, height: 44 }}
        aria-label="Account"
        onClick={onAccount}
      >
        <AccountAvatar />
      </button>
    </form>
  );
}

export function MobileSelectionBar({
  selected,
  folder,
  act,
  onClear,
}: {
  selected: GroupedItem[];
  folder: GmailFolder;
  act: RowActions;
  onClear: () => void;
}) {
  const anyUnread = selected.some((s) => s.unreadCount > 0);
  const anyOut =
    folder === "archive" ||
    folder === "snoozed" ||
    selected.some((s) => !inInboxView(s));
  const allStarred = selected.every((s) => s.starred);
  const allPinned = selected.every((s) => s.pinned);
  const inTrash = folder === "trash" || selected.some((s) => !!s.trashedAt);
  const canDelete = !inTrash || selected.some((s) => s.type === "person");
  const done = (fn: () => void) => () => {
    fn();
    onClear();
  };
  return (
    <div
      className="flex h-14 items-center gap-1 px-1"
      data-testid="gmail-m-selection"
    >
      <button
        type="button"
        className="gm-icon-btn"
        style={{ width: 48, height: 48 }}
        aria-label="Clear selection"
        onClick={onClear}
      >
        <X size={24} />
      </button>
      <span className="flex-1 text-[20px] font-medium">{selected.length}</span>
      {inTrash ? (
        <button
          type="button"
          className="gm-icon-btn"
          style={{ width: 48, height: 48 }}
          aria-label="Restore"
          onClick={done(() => act.restore(selected))}
        >
          <ArchiveRestore size={22} />
        </button>
      ) : anyOut ? (
        <button
          type="button"
          className="gm-icon-btn"
          style={{ width: 48, height: 48 }}
          aria-label="Move to inbox"
          onClick={done(() => act.moveToInbox(selected))}
        >
          <InboxIcon size={22} />
        </button>
      ) : (
        <button
          type="button"
          className="gm-icon-btn"
          style={{ width: 48, height: 48 }}
          aria-label="Archive"
          onClick={done(() => act.archive(selected))}
        >
          <Archive size={22} />
        </button>
      )}
      {/* In Trash, Delete means delete forever: admins only. */}
      {(!inTrash || act.canDeleteForever) && (
        <button
          type="button"
          className="gm-icon-btn"
          style={{ width: 48, height: 48 }}
          aria-label={inTrash ? "Delete forever" : "Delete"}
          disabled={!canDelete}
          onClick={() => act.requestDelete(selected, onClear)}
        >
          <Trash2 size={22} />
        </button>
      )}
      {anyUnread ? (
        <button
          type="button"
          className="gm-icon-btn"
          style={{ width: 48, height: 48 }}
          aria-label="Mark as read"
          onClick={done(() => act.markRead(selected))}
        >
          <MailOpen size={22} />
        </button>
      ) : (
        <button
          type="button"
          className="gm-icon-btn"
          style={{ width: 48, height: 48 }}
          aria-label="Mark as unread"
          onClick={done(() => void act.markUnread(selected))}
        >
          <Mail size={22} />
        </button>
      )}
      <GmMenu
        align="end"
        trigger={
          <button
            type="button"
            className="gm-icon-btn"
            style={{ width: 48, height: 48 }}
            aria-label="More"
          >
            <EllipsisVertical size={22} />
          </button>
        }
      >
        <GmMenuItem
          icon={<Clock size={20} />}
          onSelect={() => act.pickSnooze(selected, onClear)}
        >
          Snooze
        </GmMenuItem>
        <GmMenuItem
          icon={<Star size={20} />}
          onSelect={done(() => act.star(selected, !allStarred))}
        >
          {allStarred ? "Remove star" : "Add star"}
        </GmMenuItem>
        <GmMenuItem
          icon={<Pin size={20} />}
          onSelect={done(() => act.pin(selected, !allPinned))}
        >
          {allPinned ? "Unpin" : "Pin"}
        </GmMenuItem>
        {anyOut && (
          <GmMenuItem
            icon={<InboxIcon size={20} />}
            onSelect={done(() => act.moveToInbox(selected))}
          >
            Move to inbox
          </GmMenuItem>
        )}
      </GmMenu>
    </div>
  );
}

/* ── List body ─────────────────────────────────────────────────────── */

export function MobileRows({
  items,
  folder,
  selectedKeys,
  act,
  onOpen,
  onToggleSelect,
  swipeLeft,
  swipeRight,
}: {
  swipeLeft: SwipeAction;
  swipeRight: SwipeAction;
  items: GroupedItem[];
  folder: GmailFolder;
  selectedKeys: Set<string>;
  act: RowActions;
  onOpen: (item: GroupedItem) => void;
  onToggleSelect: (item: GroupedItem) => void;
}) {
  const selecting = selectedKeys.size > 0;
  return (
    <div role="list">
      {items.map((it) => (
        <MobileRow
          key={itemKey(it)}
          item={it}
          folder={folder}
          selected={selectedKeys.has(itemKey(it))}
          selecting={selecting}
          act={act}
          onOpen={onOpen}
          onToggleSelect={onToggleSelect}
          swipeLeft={swipeLeft}
          swipeRight={swipeRight}
        />
      ))}
    </div>
  );
}

export function MobileSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading mail">
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className="flex gap-4 px-4 py-3">
          <span className="gm-skel h-10 w-10 flex-none rounded-full" />
          <div className="flex-1 space-y-2 pt-1">
            <div className="gm-skel h-3 w-1/3" />
            <div className="gm-skel h-3 w-3/4" />
            <div className="gm-skel h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ComposeFab({
  extended,
  onClick,
}: {
  extended: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="gm-compose gm-fab"
      data-collapsed={extended ? undefined : "true"}
      onClick={onClick}
      aria-label="Compose"
      data-testid="gmail-fab"
    >
      <Pencil size={22} />
      {extended && <span>Compose</span>}
    </button>
  );
}

export function PullIndicator({
  distance,
  refreshing,
  threshold,
}: {
  distance: number;
  refreshing: boolean;
  threshold: number;
}) {
  if (distance <= 0 && !refreshing) return null;
  const p = Math.min(1, distance / threshold);
  return (
    <div
      className="pointer-events-none absolute left-1/2 top-2 z-20 flex h-10 w-10 -translate-x-1/2 items-center justify-center rounded-full bg-card text-accent shadow-raised"
      style={{
        transform: `translate(-50%, ${Math.min(distance, 90) - 20}px)`,
        opacity: refreshing ? 1 : p,
      }}
      aria-hidden
    >
      <RotateCw
        size={20}
        className={refreshing ? "animate-spin" : undefined}
        style={refreshing ? undefined : { transform: `rotate(${p * 270}deg)` }}
      />
    </div>
  );
}
