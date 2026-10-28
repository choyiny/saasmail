import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  Ban,
  Check,
  ChevronDown,
  Clock,
  Forward,
  Inbox as InboxIcon,
  ListFilter as ListFilterIcon,
  Users,
  FolderInput,
  Mail,
  MailOpen,
  MoreHorizontal,
  Paperclip,
  PenLine,
  Pin,
  Reply,
  ReplyAll,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";
import { fetchGroupedPeople, type Email, type GroupedItem } from "@/lib/api";
import { itemKey, itemTitle } from "@/hooks/useMailList";
import { usePreferences } from "@/lib/preferences";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useNavigate } from "react-router-dom";
import { useOutlook } from "./context";
import Conversation, { sendConversationCommand } from "./Conversation";
import ComposeForm from "./ComposeForm";
import InlineReply, { type ReplyState } from "./InlineReply";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from "./Menu";
import { EmptyFolder, ShimmerRows, rowSubject, rowTitle } from "./MessageList";
import { useMailUi } from "./actions";
import ActionSheet from "./ActionSheet";
import { snoozePresets } from "@/hooks/useMailList";
import { SnoozeDialog, SnoozeMenuItems } from "./Snooze";
import {
  FILTER_LABELS,
  SWIPE_LABELS,
  formatMobileTime,
  swipeOutcome,
  type ListFilter,
  type SwipeAction,
} from "./lib";
import { useConversation, useIdentities } from "./useConversation";
import type { OutlookMail } from "./useOutlookMail";
import { Avatar, FlagGlyph, IconButton } from "./ui";

// ── Swipeable row ────────────────────────────────────────────────────────

const SWIPE_ICONS: Record<SwipeAction, React.ReactNode> = {
  archive: <Archive size={22} />,
  delete: <Trash2 size={22} />,
  flag: <FlagGlyph size={22} filled />,
  read: <MailOpen size={22} />,
  snooze: <Clock size={22} />,
  move: <FolderInput size={22} />,
  none: null,
};

function MobileRow({
  item,
  mail,
  selecting,
  selected,
  onLongPress,
}: {
  item: GroupedItem;
  mail: OutlookMail;
  selecting: boolean;
  selected: boolean;
  onLongPress: (item: GroupedItem) => void;
}) {
  const [dx, setDx] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [animating, setAnimating] = useState(false);
  const g = useRef<{
    x: number;
    y: number;
    id: number;
    mode: "idle" | "swipe" | "scroll";
    moved: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    long: boolean;
  } | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);
  const unread = item.unreadCount > 0;
  const title = rowTitle(item);
  const inboxName =
    item.type === "group"
      ? mail.list.stats?.senderIdentities.find((s) => s.email === item.inbox)
          ?.displayName || item.inbox
      : null;
  const width = rowRef.current?.clientWidth ?? 390;
  const outcome = swipeOutcome(dx, width);

  const end = () => {
    const s = g.current;
    if (s?.timer) clearTimeout(s.timer);
    g.current = null;
  };

  const o = useOutlook();
  const ui = useMailUi();
  const side = dx > 0 ? "right" : "left";
  const action: SwipeAction = dx > 0 ? o.swipeRight : o.swipeLeft;
  const swipeLabel = (act: SwipeAction) =>
    act === "flag"
      ? item.starred
        ? "Unflag"
        : "Flag"
      : act === "read"
        ? unread
          ? "Read"
          : "Unread"
        : act === "move"
          ? "Move"
          : SWIPE_LABELS[act];

  /** Run a swipe action; actions that remove the row animate it out. */
  function runSwipe(act: SwipeAction) {
    const removes =
      act === "archive" || act === "delete"
        ? mail.folder !== "archive" || act === "delete"
        : false;
    if (removes && act === "archive") {
      setLeaving(true);
      setDx(width * (side === "right" ? 1 : -1));
      setTimeout(() => mail.ops.archive([item]), 180);
      return;
    }
    setDx(0);
    setTimeout(() => setAnimating(false), 200);
    switch (act) {
      case "delete":
        void mail.ops.delete([item]);
        return;
      case "archive":
        mail.ops.archive([item]);
        return;
      case "flag": {
        const v = !item.starred;
        mail.ops.flag([item], v);
        showToast({
          kind: "info",
          message: v ? "Flagged" : "Flag removed",
          action: {
            label: "Undo",
            onClick: (dismiss) => {
              dismiss();
              mail.ops.flag([item], !v);
            },
          },
        });
        return;
      }
      case "read":
        mail.ops.toggleRead([item]);
        return;
      case "snooze":
        ui.requestSnooze([item]);
        return;
      case "move":
        ui.requestMove([item]);
        return;
    }
  }

  function finishSwipe(finalDx: number) {
    const out = swipeOutcome(finalDx, width);
    setAnimating(true);
    const act =
      out === "right" ? o.swipeRight : out === "left" ? o.swipeLeft : "none";
    if (act === "none") {
      setDx(0);
      setTimeout(() => setAnimating(false), 200);
      return;
    }
    runSwipe(act);
  }

  return (
    <div
      className={cn("ol-m-swipe", leaving && "ol-m-swipe-leaving")}
      data-testid="ol-m-row"
      data-key={itemKey(item)}
    >
      {dx !== 0 && action !== "none" && (
        <div
          className={cn(
            "ol-m-swipe-bg",
            `ol-m-swipe-${action}`,
            outcome && "ol-m-swipe-armed",
          )}
          aria-hidden
        >
          <span
            className={cn(
              "flex items-center gap-2",
              side === "left" && "ml-auto flex-row-reverse",
            )}
          >
            {SWIPE_ICONS[action]}
            {swipeLabel(action)}
          </span>
        </div>
      )}
      <div
        ref={rowRef}
        role="option"
        aria-selected={selected}
        tabIndex={0}
        className={cn(
          "ol-m-row",
          unread && "ol-m-row-unread",
          selected && "ol-m-row-selected",
          animating && "ol-m-row-animate",
        )}
        style={{ transform: dx ? `translateX(${dx}px)` : undefined }}
        onPointerDown={(e) => {
          if (e.pointerType === "mouse" && e.button !== 0) return;
          const s = {
            x: e.clientX,
            y: e.clientY,
            id: e.pointerId,
            mode: "idle" as const,
            moved: false,
            long: false,
            timer: null as ReturnType<typeof setTimeout> | null,
          };
          s.timer = setTimeout(() => {
            if (g.current && !g.current.moved) {
              g.current.long = true;
              suppressClick.current = true;
              navigator.vibrate?.(10);
              onLongPress(item);
            }
          }, 480);
          g.current = s;
          setAnimating(false);
        }}
        onPointerMove={(e) => {
          const s = g.current;
          if (!s || s.id !== e.pointerId) return;
          const mx = e.clientX - s.x;
          const my = e.clientY - s.y;
          if (s.mode === "idle") {
            if (Math.abs(mx) > 8 || Math.abs(my) > 8) {
              s.moved = true;
              if (s.timer) clearTimeout(s.timer);
            }
            if (
              !selecting &&
              Math.abs(mx) > 12 &&
              Math.abs(mx) > Math.abs(my) * 1.3
            ) {
              s.mode = "swipe";
              try {
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              } catch {
                /* ignore */
              }
            } else if (Math.abs(my) > 10) {
              s.mode = "scroll";
            }
          }
          if (s.mode === "swipe") {
            e.preventDefault();
            setDx(mx);
          }
        }}
        onPointerUp={(e) => {
          const s = g.current;
          if (!s) return;
          if (s.mode === "swipe") {
            suppressClick.current = true;
            finishSwipe(e.clientX - s.x);
          }
          end();
        }}
        onPointerCancel={() => {
          if (g.current?.mode === "swipe") {
            setAnimating(true);
            setDx(0);
          }
          end();
        }}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          if (selecting) mail.toggleChecked(item);
          else mail.openItem(item);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") mail.openItem(item);
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span className={cn("ol-m-dot", unread && "ol-m-dot-on")} aria-hidden />
        <div className="relative shrink-0">
          {selecting ? (
            <span
              className={cn("ol-m-check", selected && "ol-m-check-on")}
              aria-hidden
            >
              {selected && <Check size={18} strokeWidth={3} />}
            </span>
          ) : item.type === "group" ? (
            <span
              className="ol-avatar ol-avatar-group"
              style={{ width: 40, height: 40 }}
              aria-hidden
            >
              <Users size={18} />
            </span>
          ) : (
            <Avatar name={title} seed={title} size={40} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[16px] text-text-primary",
                unread ? "font-semibold" : "font-normal",
              )}
            >
              {title}
            </span>
            <span
              className={cn(
                "shrink-0 text-[13px]",
                unread ? "font-semibold text-accent" : "text-text-secondary",
              )}
            >
              {formatMobileTime(item.lastEmailAt)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[14px]",
                unread
                  ? "font-semibold text-text-primary"
                  : "text-text-primary",
              )}
            >
              {rowSubject(item)}
            </span>
            <span className="flex shrink-0 items-center gap-1 text-text-secondary">
              {item.hasAttachment > 0 && (
                <Paperclip size={14} aria-label="Has attachments" />
              )}
              {item.pinned && (
                <Pin size={14} className="fill-current" aria-label="Pinned" />
              )}
              {item.starred && (
                <span className="text-star" aria-label="Flagged">
                  <FlagGlyph size={14} filled />
                </span>
              )}
            </span>
          </div>
          <p className="ol-m-preview">
            {item.type === "group" && (
              <span className="ol-row-inbox mr-1.5">{inboxName}</span>
            )}
            {item.snippet || "\u00a0"}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Full-screen search ───────────────────────────────────────────────────

function MobileSearch({ mail }: { mail: OutlookMail }) {
  const o = useOutlook();
  const navigate = useNavigate();
  const [q, setQ] = useState(mail.parsed.text);
  const [chips, setChips] = useState<{
    unread: boolean;
    flagged: boolean;
    files: boolean;
  }>({
    unread: false,
    flagged: false,
    files: false,
  });
  const [hits, setHits] = useState<GroupedItem[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(
      () =>
        fetchGroupedPeople({
          folder: chips.flagged ? "starred" : q.trim() ? "all" : "inbox",
          q: q.trim() || undefined,
          unread: chips.unread || undefined,
          hasAttachment: chips.files || undefined,
          limit: 20,
        })
          .then((r) => !cancelled && setHits(r.data))
          .catch(() => !cancelled && setHits([])),
      q.trim() ? 200 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, chips]);

  const searching = !!q.trim() || chips.unread || chips.flagged || chips.files;
  const people = (hits ?? []).filter((h) => h.type === "person").slice(0, 4);
  const submitQuery = () => {
    const parts = [q.trim()];
    if (chips.unread) parts.push("isread:no");
    if (chips.flagged) parts.push("isflagged:yes");
    if (chips.files) parts.push("hasattachments:yes");
    const full = parts.filter(Boolean).join(" ");
    o.setMobileSearchOpen(false);
    navigate(full ? `/?q=${encodeURIComponent(full)}` : "/");
  };
  const open = (h: GroupedItem) => {
    o.setMobileSearchOpen(false);
    navigate(`/?open=${h.type}:${encodeURIComponent(h.id)}`);
  };

  return (
    <div className="ol-m-sheet ol-m-search" role="dialog" aria-label="Search">
      <form
        className="ol-m-search-bar"
        onSubmit={(e) => {
          e.preventDefault();
          submitQuery();
        }}
      >
        <div className="ol-m-search-field">
          <Search size={18} aria-hidden className="text-text-secondary" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search mail and people"
            aria-label="Search mail and people"
            enterKeyHint="search"
            className="min-w-0 flex-1 bg-transparent text-[16px] text-text-primary outline-none placeholder:text-text-secondary"
          />
          {q && (
            <button
              type="button"
              aria-label="Clear"
              onClick={() => setQ("")}
              className="text-text-secondary"
            >
              <X size={18} />
            </button>
          )}
        </div>
        <button
          type="button"
          className="ol-link text-[16px]"
          onClick={() => o.setMobileSearchOpen(false)}
        >
          Cancel
        </button>
      </form>
      <div className="ol-m-chips" role="toolbar" aria-label="Filters">
        {(
          [
            ["unread", "Unread", <MailOpen key="u" size={14} />],
            ["flagged", "Flagged", <FlagGlyph key="f" size={14} />],
            ["files", "Attachments", <Paperclip key="a" size={14} />],
          ] as const
        ).map(([k, label, icon]) => (
          <button
            key={k}
            type="button"
            aria-pressed={chips[k]}
            className={cn("ol-m-chip", chips[k] && "ol-m-chip-on")}
            onClick={() => setChips((c) => ({ ...c, [k]: !c[k] }))}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {searching && people.length > 0 && (
          <>
            <div className="ol-m-section-label">People</div>
            <div className="ol-m-people">
              {people.map((h) => (
                <button
                  key={itemKey(h)}
                  type="button"
                  className="ol-m-person"
                  onClick={() =>
                    h.type === "person"
                      ? (o.setMobileSearchOpen(false),
                        navigate(
                          `/?q=${encodeURIComponent(`from:${h.email}`)}`,
                        ))
                      : open(h)
                  }
                >
                  <Avatar name={itemTitle(h)} seed={itemTitle(h)} size={48} />
                  <span className="w-full truncate text-[13px] text-text-primary">
                    {itemTitle(h).split(" ")[0]}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
        <div className="ol-m-section-label">
          {searching ? "Top results" : "Recent"}
        </div>
        {hits === null && <ShimmerRows mobile count={3} />}
        {hits?.length === 0 && (
          <p className="px-4 py-6 text-center text-[15px] text-text-secondary">
            No results
          </p>
        )}
        {hits?.map((h) => (
          <button
            key={itemKey(h)}
            type="button"
            className="ol-m-hit"
            onClick={() => open(h)}
          >
            <Avatar name={rowTitle(h)} seed={rowTitle(h)} size={40} />
            <span className="min-w-0 flex-1 text-left">
              <span
                className={cn(
                  "block truncate text-[16px] text-text-primary",
                  h.unreadCount > 0 && "font-semibold",
                )}
              >
                {rowTitle(h)}
              </span>
              <span className="block truncate text-[14px] text-text-secondary">
                {rowSubject(h)}
              </span>
            </span>
            <span className="shrink-0 self-start pt-1 text-[12px] text-text-secondary">
              {formatMobileTime(h.lastEmailAt)}
            </span>
          </button>
        ))}
        {searching && (
          <button type="button" className="ol-m-hit" onClick={submitQuery}>
            <span className="flex h-10 w-10 items-center justify-center text-accent">
              <Search size={20} />
            </span>
            <span className="text-[16px] text-accent">See all results</span>
          </button>
        )}
      </div>
    </div>
  );
}

// ── Full-screen conversation ─────────────────────────────────────────────

function MobileConversation({
  mail,
  item,
}: {
  mail: OutlookMail;
  item: GroupedItem;
}) {
  const o = useOutlook();
  const ui = useMailUi();
  const [sheet, setSheet] = useState<null | "actions" | "reply" | "snooze">(
    null,
  );
  const conv = useConversation(item, mail.label);
  const [replyState, setReplyState] = useState<ReplyState | null>(null);
  const { senderIdentities } = useIdentities();
  const subject = conv.emails[0]?.subject?.trim() || rowSubject(item);
  const unread = item.unreadCount > 0;
  const counterpart =
    item.type === "person"
      ? item.name
        ? `${item.name} <${item.email}>`
        : item.email
      : item.participants.map((p) => p.name || p.email).join(", ");
  const inbox =
    item.type === "person" ? (mail.label ?? item.recipients[0]) : item.inbox;
  const inboxName =
    senderIdentities.find((s) => s.email === inbox)?.displayName || inbox;

  useEffect(() => {
    if (item.unreadCount > 0) mail.ops.markRead([item]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.type, item.id]);

  const back = () => mail.openItem(null);

  return (
    <div className="ol-m-conv">
      <header className="ol-m-conv-head">
        <IconButton label="Back" size="lg" onClick={back}>
          <ArrowLeft size={22} />
        </IconButton>
        <div className="flex-1" />
        <IconButton
          label="Archive"
          size="lg"
          onClick={() => mail.ops.archive([item])}
        >
          <Archive size={21} />
        </IconButton>
        <IconButton
          label="Delete"
          size="lg"
          onClick={() => void mail.ops.delete([item])}
        >
          <Trash2 size={21} />
        </IconButton>
        <IconButton
          label="More actions"
          size="lg"
          onClick={() => setSheet("actions")}
        >
          <MoreHorizontal size={22} />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pb-2 pt-1">
          <h1 className="text-[22px] font-semibold leading-tight text-text-primary">
            {subject}
          </h1>
          {inbox && (
            <span className="ol-cat mt-2 inline-flex">{inboxName}</span>
          )}
        </div>
        <Conversation
          item={item}
          emails={conv.emails}
          setEmails={conv.setEmails}
          loading={conv.loading}
          error={conv.error}
          reload={() => void conv.reload(true)}
          conversationView={o.conversationView}
          onCompose={(p) => o.openCompose(p)}
          onBlock={() => void mail.ops.block(item)}
          variant="mobile"
          replyState={null}
          setReplyState={setReplyState}
        />
      </div>
      <div className="ol-m-replybar">
        <button
          type="button"
          className="ol-m-reply-pill"
          onClick={() => sendConversationCommand("reply")}
          disabled={conv.emails.length === 0}
        >
          <Reply size={18} aria-hidden /> Reply
        </button>
        <IconButton
          label="More reply options"
          size="lg"
          disabled={conv.emails.length === 0}
          onClick={() => setSheet("reply")}
        >
          <MoreHorizontal size={20} />
        </IconButton>
      </div>
      <ActionSheet
        open={sheet === "actions"}
        onOpenChange={(v) => !v && setSheet(null)}
        title={subject}
        actions={[
          {
            id: "flag",
            label: item.starred ? "Unflag" : "Flag",
            icon: <FlagGlyph size={20} filled={item.starred} />,
            onSelect: () => mail.ops.flag([item]),
          },
          {
            id: "snooze",
            label: "Snooze",
            icon: <Clock size={20} />,
            onSelect: () => setTimeout(() => setSheet("snooze"), 50),
          },
          {
            id: "move",
            label: "Move to folder",
            icon: <FolderInput size={20} />,
            onSelect: () => ui.requestMove([item]),
          },
          {
            id: "read",
            label: unread ? "Mark as read" : "Mark as unread",
            icon: unread ? <MailOpen size={20} /> : <Mail size={20} />,
            onSelect: () => {
              mail.ops.toggleRead([item]);
              if (!unread) back();
            },
          },
          {
            id: "pin",
            label: item.pinned ? "Unpin" : "Pin",
            icon: <Pin size={20} />,
            onSelect: () => mail.ops.pin([item]),
          },
          {
            id: "archive",
            label: "Archive",
            icon: <Archive size={20} />,
            onSelect: () => mail.ops.archive([item]),
          },
          {
            id: "inbox",
            label: "Move to Inbox",
            icon: <InboxIcon size={20} />,
            hidden: !(mail.folder === "archive" || item.snoozedUntil),
            onSelect: () => mail.ops.moveToInbox([item]),
          },
          {
            id: "block",
            label: "Block sender",
            icon: <Ban size={20} />,
            hidden: item.type !== "person",
            onSelect: () => void mail.ops.block(item),
          },
          {
            id: "focus",
            label: "Always move to Focused",
            icon: <InboxIcon size={20} />,
            hidden: item.type !== "person",
            onSelect: () => void mail.ops.setFocus([item], "focused"),
          },
          {
            id: "other",
            label: "Always move to Other",
            icon: <InboxIcon size={20} />,
            hidden: item.type !== "person",
            onSelect: () => void mail.ops.setFocus([item], "other"),
          },
          {
            id: "restore",
            label: "Restore",
            icon: <InboxIcon size={20} />,
            hidden: mail.folder !== "deleted",
            onSelect: () => mail.ops.restore([item]),
          },
          {
            id: "delete",
            label: mail.folder === "deleted" ? "Delete forever" : "Delete",
            icon: <Trash2 size={20} />,
            danger: true,
            // In Deleted Items, Delete is permanent: admins only.
            hidden:
              mail.folder === "deleted" &&
              (!mail.canDeleteForever || item.type !== "person"),
            onSelect: () => void mail.ops.delete([item]),
          },
        ]}
      />
      <ActionSheet
        open={sheet === "snooze"}
        onOpenChange={(v) => !v && setSheet(null)}
        title="Snooze until"
        actions={[
          ...snoozePresets().map((p) => ({
            id: p.id,
            label: `${p.label} · ${new Date(p.until * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`,
            icon: <Clock size={20} />,
            onSelect: () => mail.ops.snooze([item], p.until),
          })),
          {
            id: "custom",
            label: "Choose a date",
            icon: <Clock size={20} />,
            onSelect: () => ui.requestSnooze([item]),
          },
        ]}
      />
      <ActionSheet
        open={sheet === "reply"}
        onOpenChange={(v) => !v && setSheet(null)}
        actions={[
          {
            id: "reply",
            label: "Reply",
            icon: <Reply size={20} />,
            onSelect: () => sendConversationCommand("reply"),
          },
          {
            id: "replyAll",
            label: "Reply all",
            icon: <ReplyAll size={20} />,
            onSelect: () => sendConversationCommand("replyAll"),
          },
          {
            id: "forward",
            label: "Forward",
            icon: <Forward size={20} />,
            onSelect: () => sendConversationCommand("forward"),
          },
        ]}
      />
      {replyState && (
        <InlineReply
          key={`${replyState.email.id}:${replyState.mode}:${replyState.initial ? "again" : ""}`}
          email={replyState.email}
          mode={replyState.mode}
          initial={replyState.initial}
          itemKey={`${item.type}:${item.id}`}
          counterpart={counterpart}
          onClose={() => setReplyState(null)}
          onSent={() => void conv.reload(true)}
          variant="mobile"
        />
      )}
    </div>
  );
}

// ── Mobile mail ─────────────────────────────────────────────────────────

export default function MobileMail({ mail }: { mail: OutlookMail }) {
  const o = useOutlook();
  const { data: session } = useSession();
  const { density } = usePreferences();
  const { senderIdentities } = useIdentities();
  const [moreOpen, setMoreOpen] = useState(false);
  const ui = useMailUi();
  const [selecting, setSelecting] = useState(false);
  const userName = session?.user?.name || session?.user?.email || "";
  const navigate = useNavigate();

  const item = mail.openedItem;
  const open = !!mail.openKey;
  const composing = !!o.compose;

  useEffect(() => {
    o.setHideTabBar(open || composing || selecting);
    return () => o.setHideTabBar(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, composing, selecting]);

  useEffect(() => {
    if (selecting && mail.selected.size === 0) setSelecting(false);
  }, [selecting, mail.selected.size]);

  // Leaving selection mode clears it.
  const exitSelect = () => {
    setSelecting(false);
    mail.setSelected(new Set());
  };

  const pull = usePullToRefresh<HTMLDivElement>({
    onRefresh: () =>
      new Promise<void>((resolve) => {
        mail.list.refresh();
        setTimeout(resolve, 700);
      }),
  });

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !mail.hasMore) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) mail.loadMore();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [mail.hasMore, mail.loadMore, mail]);

  const title = mail.label
    ? senderIdentities.find((s) => s.email === mail.label)?.displayName ||
      mail.label
    : mail.folderTitle;
  const rows = mail.visible;
  const selectedItems = useMemo(
    () => rows.filter((r) => mail.selected.has(itemKey(r))),
    [rows, mail.selected],
  );
  const anyUnread = selectedItems.some((i) => i.unreadCount > 0);
  const otherUnread = mail.otherUnreadCount;

  const act = (fn: () => void) => {
    fn();
    exitSelect();
  };

  return (
    <div className={cn("ol-m-mail", density === "compact" && "ol-compact")}>
      {selecting ? (
        <header className="ol-m-header ol-m-header-select">
          <IconButton label="Cancel selection" size="lg" onClick={exitSelect}>
            <X size={22} />
          </IconButton>
          <h1 className="ol-m-title">{mail.selected.size} selected</h1>
          <button
            type="button"
            className="ol-link px-2 text-[15px]"
            onClick={() => mail.setSelected(new Set(rows.map(itemKey)))}
          >
            Select all
          </button>
        </header>
      ) : (
        <header className="ol-m-header">
          <button
            type="button"
            className="ol-m-avatar-btn"
            aria-label="Open folders and settings"
            onClick={() => o.setDrawerOpen(true)}
          >
            <Avatar name={userName} seed={userName} size={32} />
          </button>
          <h1 className="ol-m-title">{title}</h1>
          <IconButton
            label="Search"
            size="lg"
            className="ol-m-header-btn"
            onClick={() => o.setMobileSearchOpen(true)}
          >
            <Search size={22} />
          </IconButton>
        </header>
      )}

      <div className="ol-m-toolbar">
        {mail.q ? (
          <button
            type="button"
            className="ol-filter-chip"
            onClick={() => navigate("/")}
            aria-label="Clear search"
          >
            “{mail.q}” ×
          </button>
        ) : mail.showFocusTabs ? (
          <div className="ol-m-seg" role="tablist" aria-label="Focused inbox">
            {(["focused", "other"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={mail.focusTab === t}
                className={cn(
                  "ol-m-seg-btn",
                  mail.focusTab === t && "ol-m-seg-on",
                )}
                onClick={() => mail.setFocusTab(t)}
              >
                {t === "focused" ? "Focused" : "Other"}
                {t === "other" &&
                  otherUnread > 0 &&
                  mail.focusTab !== "other" && (
                    <span
                      className="ol-m-seg-dot"
                      aria-label={`${otherUnread} unread`}
                    />
                  )}
              </button>
            ))}
          </div>
        ) : (
          <span />
        )}
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "ol-m-filter",
                mail.filter !== "all" && "ol-m-filter-on",
              )}
              aria-label={`Filter: ${FILTER_LABELS[mail.filter]}`}
            >
              <ListFilterIcon size={18} aria-hidden />
              {mail.filter === "all"
                ? "Filter"
                : mail.filter === "files"
                  ? "Attachments"
                  : FILTER_LABELS[mail.filter]}
            </button>
          </MenuTrigger>
          <MenuContent align="end" className="ol-menu-touch">
            <MenuRadioGroup
              value={mail.filter}
              onValueChange={(v) => mail.setFilter(v as ListFilter)}
            >
              <MenuRadioItem value="all">All</MenuRadioItem>
              <MenuRadioItem value="unread">Unread</MenuRadioItem>
              <MenuRadioItem value="flagged">Flagged</MenuRadioItem>
              <MenuRadioItem value="files">Attachments</MenuRadioItem>
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
      </div>

      <div
        ref={pull.ref}
        className="ol-m-scroll"
        role="listbox"
        aria-label={title}
        aria-multiselectable={selecting}
      >
        {(pull.pullDistance > 0 || pull.refreshing) && (
          <div
            className="ol-m-ptr"
            style={{ height: pull.refreshing ? 48 : pull.pullDistance }}
          >
            <span
              className={cn(
                "ol-m-ptr-spin",
                pull.refreshing && "ol-m-ptr-spinning",
              )}
              style={{
                transform: `rotate(${pull.pullDistance * 3}deg)`,
                opacity: Math.min(1, pull.pullDistance / pull.threshold),
              }}
            />
          </div>
        )}
        {mail.list.loading && mail.allItems.length === 0 ? (
          <ShimmerRows mobile count={9} />
        ) : mail.list.error ? (
          <div className="ol-empty">
            <p className="text-[15px] text-text-secondary">{mail.list.error}</p>
            <button
              type="button"
              className="ol-btn-outline"
              onClick={mail.list.refresh}
            >
              Try again
            </button>
          </div>
        ) : rows.length === 0 ? (
          <EmptyFolder
            title={
              mail.showFocusTabs && mail.focusTab === "other" ? "Other" : title
            }
            q={mail.q}
          />
        ) : (
          rows.map((it) => (
            <MobileRow
              key={itemKey(it)}
              item={it}
              mail={mail}
              selecting={selecting}
              selected={mail.selected.has(itemKey(it))}
              onLongPress={(row) => {
                setSelecting(true);
                mail.setSelected(new Set([itemKey(row)]));
              }}
            />
          ))
        )}
        {mail.hasMore && (
          <div ref={sentinel} className="flex justify-center py-4">
            <span
              className="ol-m-ptr-spin ol-m-ptr-spinning"
              aria-label="Loading more"
            />
          </div>
        )}
        <div className="h-24" aria-hidden />
      </div>

      {!selecting && !open && !composing && (
        <button
          type="button"
          className="ol-fab"
          aria-label="New mail"
          onClick={() => o.openCompose(null)}
          data-testid="ol-fab"
        >
          <PenLine size={24} />
        </button>
      )}

      {selecting && (
        <nav className="ol-m-actionbar" aria-label="Selection actions">
          <button
            type="button"
            disabled={!selectedItems.length}
            onClick={() => act(() => mail.ops.archive(selectedItems))}
          >
            <Archive size={22} aria-hidden />
            Archive
          </button>
          <button
            type="button"
            disabled={
              !selectedItems.length ||
              // In Deleted Items, Delete is permanent: admins only.
              (mail.folder === "deleted" && !mail.canDeleteForever)
            }
            onClick={() => act(() => void mail.ops.delete(selectedItems))}
          >
            <Trash2 size={22} aria-hidden />
            Delete
          </button>
          <button
            type="button"
            disabled={!selectedItems.length}
            onClick={() => act(() => mail.ops.toggleRead(selectedItems))}
          >
            {anyUnread ? (
              <MailOpen size={22} aria-hidden />
            ) : (
              <Mail size={22} aria-hidden />
            )}
            {anyUnread ? "Read" : "Unread"}
          </button>
          <button
            type="button"
            disabled={!selectedItems.length}
            onClick={() => act(() => mail.ops.flag(selectedItems))}
          >
            <FlagGlyph size={22} />
            Flag
          </button>
          <button
            type="button"
            disabled={!selectedItems.length}
            onClick={() => setMoreOpen(true)}
          >
            <MoreHorizontal size={22} aria-hidden />
            More
          </button>
        </nav>
      )}

      {open && item && <MobileConversation mail={mail} item={item} />}
      {open && !item && (
        <div className="ol-m-conv">
          <header className="ol-m-conv-head">
            <IconButton
              label="Back"
              size="lg"
              onClick={() => mail.openItem(null)}
            >
              <ArrowLeft size={22} />
            </IconButton>
          </header>
          <ShimmerRows mobile count={3} />
        </div>
      )}
      {o.mobileSearchOpen && <MobileSearch mail={mail} />}
      {o.compose && (
        <ComposeForm
          key={o.compose.id}
          prefill={o.compose.prefill}
          initialFiles={o.compose.files}
          initialError={o.compose.error}
          onReopen={(p, x) => o.openCompose(p, x)}
          onClose={o.closeCompose}
          variant="mobile"
        />
      )}
      <ActionSheet
        open={moreOpen}
        onOpenChange={setMoreOpen}
        title={`${selectedItems.length} selected`}
        actions={[
          {
            id: "pin",
            label: "Pin",
            icon: <Pin size={20} />,
            onSelect: () => act(() => mail.ops.pin(selectedItems)),
          },
          {
            id: "snooze",
            label: "Snooze",
            icon: <Clock size={20} />,
            onSelect: () => {
              ui.requestSnooze(selectedItems);
              exitSelect();
            },
          },
          {
            id: "move",
            label: "Move to folder",
            icon: <FolderInput size={20} />,
            onSelect: () => {
              ui.requestMove(selectedItems);
              exitSelect();
            },
          },
          {
            id: "inbox",
            label: "Move to Inbox",
            icon: <InboxIcon size={20} />,
            onSelect: () => act(() => mail.ops.moveToInbox(selectedItems)),
          },
        ]}
      />
    </div>
  );
}
