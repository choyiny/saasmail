import { useEffect, useState } from "react";
import {
  MoreHorizontal,
  Archive,
  ArrowLeft,
  Clock,
  Mail,
  MailOpen,
  Pin,
  Trash2,
} from "lucide-react";
import type { Email } from "@/lib/api";
import { itemTitle } from "@/hooks/useMailList";
import { cn } from "@/lib/utils";
import type { ComposePrefill } from "@/pages/ComposeModal";
import { useOutlook } from "./context";
import Conversation from "./Conversation";
import ComposeForm from "./ComposeForm";
import type { ReplyState } from "./InlineReply";
import { Menu, MenuContent, MenuTrigger } from "./Menu";
import RowMenu from "./RowMenu";
import { rowSubject } from "./MessageList";
import { SnoozeMenuItems } from "./Snooze";
import { useMailUi } from "./actions";
import { useConversation, useIdentities } from "./useConversation";
import type { OutlookMail } from "./useOutlookMail";
import { Avatar, FlagGlyph } from "./ui";

function EmptyReading() {
  return (
    <div className="ol-reading-empty">
      <div className="ol-envelope" aria-hidden>
        <Mail size={72} strokeWidth={1} />
        <span className="ol-envelope-dot" />
      </div>
      <p className="text-[16px] font-semibold text-text-primary">
        Select an item to read
      </p>
      <p className="text-[13px] text-text-secondary">Nothing is selected</p>
    </div>
  );
}

function MultiSelected({ mail }: { mail: OutlookMail }) {
  const ui = useMailUi();
  const items = mail.selectedItems;
  const onSnoozeCustom = () => ui.requestSnooze(items);
  const anyUnread = items.some((i) => i.unreadCount > 0);
  return (
    <div className="ol-reading-empty">
      <div className="ol-stack" aria-hidden>
        {items.slice(0, 3).map((it, i) => (
          <span
            key={i}
            className="ol-stack-card"
            style={{ ["--i" as string]: i }}
          >
            <Avatar name={itemTitle(it)} seed={itemTitle(it)} size={24} />
            <span className="truncate">{itemTitle(it)}</span>
          </span>
        ))}
      </div>
      <p className="text-[20px] font-semibold text-text-primary">
        {items.length} items selected
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <button
          type="button"
          className="ol-btn-outline"
          onClick={() => mail.ops.archive(items)}
        >
          <Archive size={16} aria-hidden /> Archive
        </button>
        <button
          type="button"
          className="ol-btn-outline"
          // In Deleted Items, Delete is permanent: admins only.
          disabled={mail.folder === "deleted" && !mail.canDeleteForever}
          onClick={() => void mail.ops.delete(items)}
        >
          <Trash2 size={16} aria-hidden /> Delete
        </button>
        <button
          type="button"
          className="ol-btn-outline"
          onClick={() => mail.ops.toggleRead(items)}
        >
          {anyUnread ? (
            <MailOpen size={16} aria-hidden />
          ) : (
            <Mail size={16} aria-hidden />
          )}
          {anyUnread ? "Mark as read" : "Mark as unread"}
        </button>
        <button
          type="button"
          className="ol-btn-outline"
          onClick={() => mail.ops.flag(items)}
        >
          <FlagGlyph size={16} /> Flag
        </button>
        <button
          type="button"
          className="ol-btn-outline"
          onClick={() => mail.ops.pin(items)}
        >
          <Pin size={16} aria-hidden /> Pin
        </button>
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="ol-btn-outline">
              <Clock size={16} aria-hidden /> Snooze
            </button>
          </MenuTrigger>
          <MenuContent>
            <SnoozeMenuItems
              onPick={(u) => mail.ops.snooze(items, u)}
              onCustom={onSnoozeCustom}
            />
          </MenuContent>
        </Menu>
      </div>
      <button
        type="button"
        className="ol-link text-[13px]"
        onClick={mail.clearSelection}
      >
        Clear selection
      </button>
    </div>
  );
}

export default function ReadingPane({
  mail,
  onBack,
}: {
  mail: OutlookMail;
  /** Shown when the reading pane replaces the list (pane "off"). */
  onBack?: () => void;
}) {
  const o = useOutlook();
  const item = mail.selected.size > 1 ? null : mail.openedItem;
  const conv = useConversation(item, mail.label);
  const { senderIdentities } = useIdentities();
  const [replyState, setReplyState] = useState<ReplyState | null>(null);

  // Outlook marks a message read when you select it. The conversation it
  // opens by itself when a folder loads stays unread until you act on it.
  const autoOpened = !!item && mail.autoKey === `${item.type}:${item.id}`;
  useEffect(() => {
    if (item && item.unreadCount > 0 && !autoOpened) {
      const t = setTimeout(() => mail.ops.markRead([item]), 600);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.type, item?.id, autoOpened]);

  if (o.compose) {
    return (
      <div className="ol-reading">
        <ComposeForm
          key={o.compose.id}
          prefill={o.compose.prefill}
          initialFiles={o.compose.files}
          initialError={o.compose.error}
          onReopen={(p, x) => o.openCompose(p, x)}
          onClose={o.closeCompose}
          variant="pane"
        />
      </div>
    );
  }
  if (mail.selected.size > 1) {
    return (
      <div className="ol-reading">
        <MultiSelected mail={mail} />
      </div>
    );
  }
  if (!item) {
    return (
      <div className="ol-reading">
        {mail.openKey ? (
          <div className="p-6">
            <span className="ol-shimmer block h-5 w-1/2" />
          </div>
        ) : (
          <EmptyReading />
        )}
      </div>
    );
  }

  const subject = conv.emails[0]?.subject?.trim() || rowSubject(item);
  const inboxes =
    item.type === "person"
      ? mail.label
        ? [mail.label]
        : item.recipients
      : [item.inbox];
  const nameOf = (addr: string) =>
    senderIdentities.find((s) => s.email === addr)?.displayName || addr;

  return (
    <div className="ol-reading">
      <div className="ol-reading-head">
        {onBack && (
          <button
            type="button"
            className="ol-icon-btn mr-1"
            aria-label="Back to list"
            onClick={onBack}
          >
            <ArrowLeft size={18} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="ol-subject">{subject}</h1>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {inboxes.slice(0, 4).map((r) => (
              <span key={r} className="ol-cat" title={r}>
                {nameOf(r)}
              </span>
            ))}
            {item.snoozedUntil && (
              <span className="ol-cat ol-cat-warn">
                <Clock size={12} aria-hidden /> Snoozed until{" "}
                {new Date(item.snoozedUntil * 1000).toLocaleString([], {
                  weekday: "short",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            )}
            {item.archivedAt && <span className="ol-cat">Archived</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            className={cn("ol-icon-btn", item.starred && "text-star")}
            aria-label={item.starred ? "Unflag" : "Flag"}
            title={item.starred ? "Unflag" : "Flag"}
            onClick={() => mail.ops.flag([item])}
          >
            <FlagGlyph size={18} filled={item.starred} />
          </button>
          <button
            type="button"
            className={cn("ol-icon-btn", item.pinned && "text-accent")}
            aria-label={item.pinned ? "Unpin" : "Pin"}
            title={item.pinned ? "Unpin" : "Pin"}
            onClick={() => mail.ops.pin([item])}
          >
            <Pin
              size={18}
              className={item.pinned ? "fill-current" : undefined}
            />
          </button>
          <Menu>
            <MenuTrigger asChild>
              <button
                type="button"
                className="ol-icon-btn"
                aria-label="More actions"
                title="More actions"
              >
                <MoreHorizontal size={18} />
              </button>
            </MenuTrigger>
            <MenuContent align="end">
              <RowMenu items={[item]} mail={mail} />
            </MenuContent>
          </Menu>
        </div>
      </div>
      <div className="ol-reading-scroll">
        <Conversation
          item={item}
          emails={conv.emails}
          setEmails={conv.setEmails}
          loading={conv.loading}
          error={conv.error}
          reload={() => void conv.reload(true)}
          conversationView={o.conversationView}
          onCompose={(p: ComposePrefill) => o.openCompose(p)}
          onBlock={() => void mail.ops.block(item)}
          replyState={replyState}
          setReplyState={setReplyState}
        />
      </div>
    </div>
  );
}
