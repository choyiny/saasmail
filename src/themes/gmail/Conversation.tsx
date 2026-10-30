import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Clock,
  Code,
  ExternalLink,
  EllipsisVertical,
  Forward,
  Inbox as InboxIcon,
  Link2,
  Mail,
  Paperclip,
  Pin,
  Printer,
  Reply,
  ReplyAll,
  ShieldBan,
  Star,
  Tags,
  Trash2,
} from "lucide-react";
import {
  addBlock,
  deleteEmail,
  fetchConversationEmails,
  markEmailRead,
  fetchPersonEmails,
  type Email,
  type GroupedItem,
  type Stats,
} from "@/lib/api";
import { sanitizeEmailHtml } from "@/lib/sanitize-html";
import { useSession } from "@/lib/auth-client";
import { showToast } from "@/lib/toast";
import { copyMessageLink, messageDomId } from "@/lib/message-link";
import { onEmailSent } from "@/lib/email-events";
import { onInboxRefresh } from "@/lib/inbox-events";
import { itemTitle } from "@/hooks/useMailList";
import ReplyComposer from "@/components/ReplyComposer";
import DeliveryProblemBadge from "@/components/DeliveryProblemBadge";
import InjectionChip from "@/components/InjectionChip";
import EmailHtmlModal from "@/components/EmailHtmlModal";
import ImageAttachments, {
  splitAttachments,
} from "@/components/ImageAttachments";
import type { ComposePrefill } from "@/pages/ComposeModal";
import { cn } from "@/lib/utils";
import {
  CATEGORIES,
  CATEGORY_LABELS,
  cleanSubject,
  formatFullDate,
  formatListDate,
  relativeTime,
} from "./lib";
import {
  inInboxView,
  type ConversationHandle,
  type RowActions,
} from "./actions";
import { InlineComposer, type InlineMode } from "./InlineComposer";
import { useCommonSettings } from "./state";
import {
  Avatar,
  ConfirmDialog,
  GmMenu,
  GmMenuItem,
  GmMenuSep,
  LabelChip,
  SnoozeMenu,
} from "./ui";

/* ── helpers ───────────────────────────────────────────────────────── */

function inboxOf(e: Email): string | null {
  return (e.type === "received" ? e.recipient : e.fromAddress) ?? null;
}

function textOf(e: Email): string {
  if (e.bodyText) return e.bodyText;
  if (!e.bodyHtml) return "";
  return (
    new DOMParser().parseFromString(e.bodyHtml, "text/html").body.textContent ??
    ""
  );
}

function snippetOf(e: Email) {
  return textOf(e).replace(/\s+/g, " ").trim().slice(0, 200);
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface Party {
  name: string | null;
  email: string;
}

/** Print messages in a clean window, like Gmail's "Print all". */
function printEmails(list: Email[], subject: string) {
  const w = window.open("", "_blank", "width=820,height=900");
  if (!w) return;
  const parts = list
    .map((e) => {
      const who =
        e.type === "sent"
          ? `${e.fromAddress ?? ""} → ${e.toAddress ?? ""}`
          : `${e.fromAddress ?? ""} → ${e.recipient ?? ""}`;
      const body = e.bodyHtml
        ? sanitizeEmailHtml(e.bodyHtml)
        : `<pre>${escapeHtml(e.bodyText ?? "")}</pre>`;
      return `<section><div class="h"><b>${escapeHtml(who)}</b><span>${escapeHtml(
        formatFullDate(e.timestamp),
      )}</span></div><div class="s">${escapeHtml(e.subject ?? "")}</div>${body}</section>`;
    })
    .join("");
  w.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(
      subject,
    )}</title><style>body{font:14px/1.5 Roboto,Arial,sans-serif;color:#202124;margin:32px}h1{font-size:20px;font-weight:400;border-bottom:1px solid #ccc;padding-bottom:8px}section{border-bottom:1px solid #e0e0e0;padding:12px 0}.h{display:flex;justify-content:space-between;font-size:13px}.s{color:#5f6368;font-size:12px;margin-bottom:8px}img{max-width:100%}pre{white-space:pre-wrap;font:inherit}</style></head><body><h1>${escapeHtml(
      subject,
    )}</h1>${parts}</body></html>`,
  );
  w.document.close();
  w.focus();
  window.setTimeout(() => w.print(), 300);
}

/* ── Message card ──────────────────────────────────────────────────── */

function MessageCard({
  email,
  sender,
  expanded,
  onToggle,
  onReply,
  onReplyAll,
  onForward,
  onViewOriginal,
  onDelete,
  onMarkUnreadFrom,
  mobile,
  cursor,
}: {
  email: Email;
  sender: Party;
  expanded: boolean;
  onToggle: () => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onViewOriginal: () => void;
  onDelete: () => void;
  onMarkUnreadFrom: () => void;
  mobile: boolean;
  /** Keyboard message cursor (n / p). */
  cursor?: boolean;
}) {
  const isSent = email.type === "sent";
  const unread = email.type === "received" && email.isRead === 0;
  const to = isSent ? email.toAddress : email.recipient;
  const rel = relativeTime(email.timestamp);
  const { images, files } = splitAttachments(email.attachments);
  const html = useMemo(
    () => (expanded && email.bodyHtml ? sanitizeEmailHtml(email.bodyHtml) : ""),
    [expanded, email.bodyHtml],
  );
  const pad = mobile ? "px-4" : "pl-4 pr-6";

  if (!expanded) {
    return (
      <div
        id={messageDomId(email.id)}
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className={cn(
          "flex cursor-pointer items-start gap-3 border-t border-border py-3 hover:bg-bg-subtle",
          pad,
        )}
        data-testid="gmail-message-collapsed"
        data-cursor={cursor ? "true" : undefined}
      >
        <Avatar name={sender.name} email={sender.email} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                "truncate text-sm",
                unread ? "font-bold" : "font-medium",
              )}
            >
              {isSent ? "me" : sender.name || sender.email}
            </span>
            <span className="ml-auto flex-none text-xs text-text-secondary">
              {formatListDate(email.timestamp)}
            </span>
          </div>
          <p className="truncate text-sm text-text-secondary">
            {snippetOf(email) || "(no content)"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <article
      id={messageDomId(email.id)}
      className={cn("scroll-mt-4 border-t border-border pb-4 pt-4", pad)}
      data-testid="gmail-message"
      data-email-id={email.id}
      data-cursor={cursor ? "true" : undefined}
      tabIndex={-1}
    >
      <div className="flex items-start gap-3">
        <Avatar name={sender.name} email={sender.email} size={40} />
        <div className="min-w-0 flex-1">
          <div
            className="flex cursor-pointer items-start gap-2"
            onClick={onToggle}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-1">
                <span className="text-sm font-bold">
                  {sender.name || sender.email}
                </span>
                {sender.name && !mobile && (
                  <span className="truncate text-xs text-text-secondary">
                    &lt;{sender.email}&gt;
                  </span>
                )}
                {isSent && email.status === "failed" && (
                  <span className="ml-1 rounded-[4px] bg-destructive-subtle px-1.5 text-xs text-destructive">
                    Failed to send
                  </span>
                )}
                {isSent && (email.deliveryProblems?.length ?? 0) > 0 && (
                  <span className="ml-1">
                    <DeliveryProblemBadge
                      problems={email.deliveryProblems}
                      recipientCount={1 + email.cc.length}
                    />
                  </span>
                )}
                {isSent && email.status === "retrying" && (
                  <span className="ml-1 rounded-[4px] bg-warning-bg px-1.5 text-xs text-warning">
                    Retrying
                  </span>
                )}
                {!isSent && email.injectionVerdict === "flagged" && (
                  <span className="ml-1">
                    <InjectionChip verdict={email.injectionVerdict} />
                  </span>
                )}
              </div>
              <div className="truncate text-xs text-text-secondary">
                to {isSent ? to || "—" : `${to ?? "me"}`}
                {email.cc?.length
                  ? `, cc: ${email.cc.map((c) => c.name || c.email).join(", ")}`
                  : ""}
              </div>
            </div>
            <div className="flex flex-none items-center gap-0.5">
              <span
                className="mr-1 whitespace-nowrap text-xs text-text-secondary"
                title={formatFullDate(email.timestamp)}
              >
                {mobile
                  ? formatListDate(email.timestamp)
                  : `${formatFullDate(email.timestamp)}${rel ? ` (${rel})` : ""}`}
              </span>
              {!mobile && (
                <button
                  type="button"
                  className="gm-icon-btn gm-sm"
                  aria-label="Reply"
                  title="Reply"
                  onClick={(e) => {
                    e.stopPropagation();
                    onReply();
                  }}
                >
                  <Reply size={20} />
                </button>
              )}
              <span onClick={(e) => e.stopPropagation()}>
                <GmMenu
                  align="end"
                  trigger={
                    <button
                      type="button"
                      className="gm-icon-btn gm-sm"
                      aria-label="More message options"
                      title="More"
                    >
                      <EllipsisVertical size={20} />
                    </button>
                  }
                >
                  <GmMenuItem icon={<Reply size={20} />} onSelect={onReply}>
                    Reply
                  </GmMenuItem>
                  <GmMenuItem
                    icon={<ReplyAll size={20} />}
                    onSelect={onReplyAll}
                  >
                    Reply all
                  </GmMenuItem>
                  <GmMenuItem icon={<Forward size={20} />} onSelect={onForward}>
                    Forward
                  </GmMenuItem>
                  <GmMenuSep />
                  <GmMenuItem icon={<Trash2 size={20} />} onSelect={onDelete}>
                    Delete this message
                  </GmMenuItem>
                  {email.type === "received" && (
                    <GmMenuItem
                      icon={<Mail size={20} />}
                      onSelect={onMarkUnreadFrom}
                    >
                      Mark unread from here
                    </GmMenuItem>
                  )}
                  <GmMenuItem
                    icon={<Printer size={20} />}
                    onSelect={() => printEmails([email], email.subject ?? "")}
                  >
                    Print
                  </GmMenuItem>
                  <GmMenuItem
                    icon={<Code size={20} />}
                    onSelect={onViewOriginal}
                  >
                    Message details
                  </GmMenuItem>
                  <GmMenuItem
                    icon={<Link2 size={20} />}
                    onSelect={() => void copyMessageLink(email.id)}
                  >
                    Copy link to message
                  </GmMenuItem>
                </GmMenu>
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className={cn("mt-3", !mobile && "pl-[52px]")}>
        {email.bodyHtml ? (
          <div
            className="gm-msg-body"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <div className="gm-msg-body whitespace-pre-wrap">
            {email.bodyText || "(no content)"}
          </div>
        )}

        {(images.length > 0 || files.length > 0) && (
          <div className="mt-4 border-t border-border pt-3">
            <p className="mb-2 text-sm font-medium">
              {images.length + files.length} attachment
              {images.length + files.length === 1 ? "" : "s"}
            </p>
            <ImageAttachments images={images} />
            {files.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {files.map((att) => (
                  <a
                    key={att.id}
                    href={`/api/attachments/${att.id}`}
                    className="flex h-10 max-w-[240px] items-center gap-2 rounded-[8px] border border-border px-3 text-sm hover:bg-bg-subtle"
                    title={`Download ${att.filename}`}
                  >
                    <Paperclip
                      size={16}
                      className="flex-none text-destructive"
                    />
                    <span className="truncate">{att.filename}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

/* ── Conversation view ─────────────────────────────────────────────── */

interface Props {
  item: GroupedItem;
  stats: Stats | null;
  act: RowActions;
  onBack: () => void;
  onCompose: (prefill?: ComposePrefill) => void;
  /** "3 of 230" + older/newer. */
  position?: { index: number; total: number };
  onPrev?: () => void;
  onNext?: () => void;
  mobile: boolean;
  /** In the right-hand reading pane: no Back button. */
  pane?: boolean;
  handleRef?: MutableRefObject<ConversationHandle | null>;
  /** Called after any change that should reload the list. */
  onChanged: () => void;
  /** Message id from a #m= deep link to expand and scroll to. */
  focusMessageId?: string | null;
  /** Start a reply / forward once loaded (from the row menu). */
  initialAction?: InlineMode | null;
  onActionDone?: () => void;
  /** "Back to Inbox" etc. */
  backLabel?: string;
  onOpenNewWindow?: () => void;
}

export default function Conversation({
  item,
  stats,
  act,
  onBack,
  onCompose,
  position,
  onPrev,
  onNext,
  mobile,
  pane,
  handleRef,
  onChanged,
  focusMessageId,
  initialAction,
  onActionDone,
  backLabel = "Back to list",
  onOpenNewWindow,
}: Props) {
  const { data: session } = useSession();
  const [common] = useCommonSettings();
  const me = session?.user;
  const [emails, setEmails] = useState<Email[] | null>(null);
  const [participants, setParticipants] = useState<Party[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [replyTo, setReplyTo] = useState<{
    id: string;
    all: boolean;
  } | null>(null);
  const [original, setOriginal] = useState<Email | null>(null);
  const [inline, setInline] = useState<{
    mode: InlineMode;
    targetId: string;
  } | null>(null);
  const [msgCursor, setMsgCursor] = useState(-1);
  const [deleting, setDeleting] = useState<Email | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const markedRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      if (item.type === "person") {
        const res = await fetchPersonEmails(item.id, { limit: 200 });
        return { emails: res.emails, participants: [] as Party[] };
      }
      const res = await fetchConversationEmails(item.id);
      return {
        emails: res.emails,
        participants: res.conversation.participants.map((p) => ({
          name: p.name,
          email: p.email,
        })),
      };
    } catch (e) {
      throw e instanceof Error ? e : new Error("Could not load conversation");
    }
  }, [item.type, item.id]);

  // A refetch started for one conversation must not land on another
  // (a reply would then target the wrong person's email).
  const currentKey = useRef("");
  currentKey.current = `${item.type}:${item.id}`;
  const refetch = useCallback(() => {
    const startedFor = currentKey.current;
    load()
      .then((r) => {
        if (startedFor !== currentKey.current) return;
        setEmails([...r.emails].sort((a, b) => a.timestamp - b.timestamp));
        setParticipants(r.participants);
      })
      .catch(() => {});
  }, [load]);

  // Initial load for this conversation.
  useEffect(() => {
    let cancelled = false;
    setEmails(null);
    setError(null);
    setShowAll(false);
    setReplyTo(null);
    setInline(null);
    setMsgCursor(-1);
    load()
      .then((r) => {
        if (cancelled) return;
        const sorted = [...r.emails].sort((a, b) => a.timestamp - b.timestamp);
        setEmails(sorted);
        setParticipants(r.participants);
        const open = new Set<string>();
        const last = sorted[sorted.length - 1];
        if (last) open.add(last.id);
        for (const e of sorted)
          if (e.type === "received" && e.isRead === 0) open.add(e.id);
        if (focusMessageId) open.add(focusMessageId);
        setExpanded(open);
        scrollRef.current?.scrollTo({ top: 0 });
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [load, focusMessageId]);

  // Opening a conversation marks it read (once per open).
  useEffect(() => {
    const key = `${item.type}:${item.id}`;
    if (markedRef.current === key) return;
    if (item.unreadCount > 0) {
      markedRef.current = key;
      act.markRead([item]);
    }
  }, [item, act]);

  // Scroll to a deep-linked message.
  useEffect(() => {
    if (!focusMessageId || !emails) return;
    const el = document.getElementById(messageDomId(focusMessageId));
    el?.scrollIntoView({ block: "start" });
  }, [focusMessageId, emails]);

  // Replies sent elsewhere (or here) reload the thread.
  useEffect(() => onEmailSent(() => refetch()), [refetch]);
  useEffect(() => onInboxRefresh(() => refetch()), [refetch]);

  const identities = stats?.senderIdentities ?? [];
  const internalDomains = useMemo(() => {
    const set = new Set<string>();
    for (const s of identities) {
      const at = s.email.lastIndexOf("@");
      if (at >= 0) set.add(s.email.slice(at + 1).toLowerCase());
    }
    return Array.from(set);
  }, [identities]);

  const senderOf = useCallback(
    (e: Email): Party => {
      if (e.type === "sent") {
        const id = identities.find((s) => s.email === e.fromAddress);
        return {
          name: id?.displayName || me?.name || null,
          email: e.fromAddress ?? me?.email ?? "",
        };
      }
      const addr = e.fromAddress ?? "";
      if (item.type === "person") {
        return { name: item.name, email: addr || item.email };
      }
      const p = participants.find(
        (x) => x.email.toLowerCase() === addr.toLowerCase(),
      );
      return { name: p?.name ?? null, email: addr };
    },
    [identities, me, item, participants],
  );

  const inboxes = useMemo(() => {
    const s = new Set<string>();
    for (const e of emails ?? []) {
      const ib = inboxOf(e);
      if (ib) s.add(ib);
    }
    if (item.type === "group") s.add(item.inbox);
    return Array.from(s);
  }, [emails, item]);

  const latest = emails?.[emails.length - 1] ?? null;
  const subject = cleanSubject(
    [...(emails ?? [])].reverse().find((e) => e.subject)?.subject ??
      item.latestSubject,
  );

  const counterpart = (target: Email) => {
    if (item.type === "person") return { name: item.name, email: item.email };
    const addr =
      target.type === "received" ? target.fromAddress : target.toAddress;
    return { name: senderOf(target).name, email: addr ?? "" };
  };

  const startReply = (target: Email | null, all = false) => {
    if (!target) return;
    if (mobile) setReplyTo({ id: target.id, all });
    else setInline({ mode: all ? "replyAll" : "reply", targetId: target.id });
  };

  const forwardHtmlFor = (target: Email) => {
    const s = senderOf(target);
    const header =
      `<p></p><p>---------- Forwarded message ---------<br>` +
      `From: ${escapeHtml(s.name ? `${s.name} <${s.email}>` : s.email)}<br>` +
      `Date: ${escapeHtml(formatFullDate(target.timestamp))}<br>` +
      `Subject: ${escapeHtml(target.subject ?? "")}<br>` +
      `To: ${escapeHtml((target.type === "sent" ? target.toAddress : target.recipient) ?? "")}</p>`;
    const body = target.bodyHtml
      ? sanitizeEmailHtml(target.bodyHtml)
      : `<p>${escapeHtml(target.bodyText ?? "").replace(/\n/g, "<br>")}</p>`;
    return `${header}${body}`;
  };

  const forward = (target: Email | null) => {
    if (!target) return;
    if (!mobile) {
      setInline({ mode: "forward", targetId: target.id });
      return;
    }
    const s = senderOf(target);
    const header =
      `<br><br><div>---------- Forwarded message ---------<br>` +
      `From: ${escapeHtml(s.name ? `${s.name} <${s.email}>` : s.email)}<br>` +
      `Date: ${escapeHtml(formatFullDate(target.timestamp))}<br>` +
      `Subject: ${escapeHtml(target.subject ?? "")}<br>` +
      `To: ${escapeHtml((target.type === "sent" ? target.toAddress : target.recipient) ?? "")}<br><br></div>`;
    const body = target.bodyHtml
      ? sanitizeEmailHtml(target.bodyHtml)
      : `<p>${escapeHtml(target.bodyText ?? "").replace(/\n/g, "<br>")}</p>`;
    onCompose({
      from: inboxOf(target) ?? undefined,
      subject: `Fwd: ${cleanSubject(target.subject ?? subject)}`,
      bodyHtml: `${header}${body}`,
    });
  };

  const latestReceived =
    [...(emails ?? [])].reverse().find((e) => e.type === "received") ?? null;
  const replyTarget = latestReceived ?? latest;
  const hasCc = !!replyTarget?.cc?.length;

  const expandAll = () => {
    setShowAll(true);
    setExpanded(new Set((emails ?? []).map((e) => e.id)));
  };
  const collapseAll = () => {
    setExpanded(new Set());
  };
  const allExpanded =
    !!emails?.length && emails.every((e) => expanded.has(e.id));

  const moveMsg = (delta: number) => {
    const list = emails ?? [];
    if (!list.length) return;
    setShowAll(true);
    const next = Math.min(
      list.length - 1,
      Math.max(0, (msgCursor < 0 ? list.length - 1 : msgCursor) + delta),
    );
    setMsgCursor(next);
    requestAnimationFrame(() => {
      const el = document.getElementById(messageDomId(list[next].id));
      el?.scrollIntoView({ block: "nearest" });
      el?.focus({ preventScroll: true });
    });
  };

  // Row menu "Reply / Reply all / Forward" opens the conversation and
  // starts the action once the messages are here.
  const actionDone = useRef(false);
  useEffect(() => {
    if (!initialAction || !emails || actionDone.current) return;
    actionDone.current = true;
    if (initialAction === "forward") forward(latest);
    else startReply(replyTarget, initialAction === "replyAll");
    onActionDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAction, emails]);

  const deleteMessage = async (e: Email) => {
    try {
      await deleteEmail(e.id);
      showToast({ kind: "success", message: "Message deleted forever" });
      if ((emails?.length ?? 0) <= 1) {
        onChanged();
        onBack();
        return;
      }
      refetch();
      onChanged();
    } catch (err) {
      showToast({
        kind: "error",
        message: err instanceof Error ? err.message : "Could not delete",
      });
    }
  };

  const markUnreadFrom = async (e: Email) => {
    const targets = (emails ?? []).filter(
      (x) => x.type === "received" && x.timestamp >= e.timestamp,
    );
    try {
      await Promise.all(targets.map((x) => markEmailRead(x.id, false)));
      showToast({ kind: "info", message: "Marked unread from here" });
      onChanged();
      onBack();
    } catch (err) {
      showToast({
        kind: "error",
        message: err instanceof Error ? err.message : "Could not mark unread",
      });
    }
  };

  if (handleRef) {
    handleRef.current = {
      reply: () => startReply(replyTarget),
      replyAll: () => startReply(replyTarget, true),
      forward: () => forward(latest),
      expandAll,
      collapseAll,
      nextMessage: () => moveMsg(1),
      prevMessage: () => moveMsg(-1),
    };
  }

  const blockSender = async () => {
    const addr =
      item.type === "person" ? item.email : latestReceived?.fromAddress;
    if (!addr) return;
    try {
      await addBlock({ type: "email", value: addr });
      showToast({ kind: "success", message: `Blocked ${addr}` });
    } catch (e) {
      showToast({
        kind: "error",
        message: e instanceof Error ? e.message : "Could not block sender",
      });
    }
  };

  const inView = inInboxView(item);
  const trashed = !!item.trashedAt;
  // Delete moves to Trash; inside Trash only people can be deleted forever.
  const canDelete = !trashed || item.type === "person";
  // Delete forever is admin-only (it removes the person for the whole team).
  const showDelete = !trashed || act.canDeleteForever;
  const deleteLabel = !trashed
    ? "Delete"
    : canDelete
      ? "Delete forever"
      : "Group conversations stay in Trash";

  /* ── toolbar ── */
  const tb = (
    label: string,
    icon: ReactNode,
    onClick: () => void,
    opts?: { disabled?: boolean; testId?: string },
  ) => (
    <button
      type="button"
      className="gm-icon-btn"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={opts?.disabled}
      data-testid={opts?.testId}
    >
      {icon}
    </button>
  );

  const moreMenu = (
    <GmMenu
      align="end"
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
      {mobile && (
        <>
          <GmMenuItem
            icon={<Clock size={20} />}
            onSelect={() => act.pickSnooze([item])}
          >
            Snooze
          </GmMenuItem>
          <GmMenuItem
            icon={<Star size={20} />}
            onSelect={() => act.star([item])}
          >
            {item.starred ? "Remove star" : "Add star"}
          </GmMenuItem>
          {!inView && (
            <GmMenuItem
              icon={<InboxIcon size={20} />}
              onSelect={() => {
                act.moveToInbox([item]);
              }}
            >
              Move to inbox
            </GmMenuItem>
          )}
        </>
      )}
      <GmMenuItem icon={<Pin size={20} />} onSelect={() => act.pin([item])}>
        {item.pinned ? "Unpin" : "Pin"}
      </GmMenuItem>
      <GmMenuItem icon={<Forward size={20} />} onSelect={() => forward(latest)}>
        Forward
      </GmMenuItem>
      {/* Category overrides only apply to person rows. */}
      {item.type === "person" && (
        <>
          <GmMenuSep />
          {CATEGORIES.filter((c) => c !== item.category).map((c) => (
            <GmMenuItem
              key={c}
              icon={<Tags size={20} />}
              onSelect={() => act.moveToCategory([item], c)}
            >
              Move to {CATEGORY_LABELS[c]}
            </GmMenuItem>
          ))}
        </>
      )}
      <GmMenuSep />
      <GmMenuItem
        icon={<ShieldBan size={20} />}
        onSelect={() => void blockSender()}
      >
        Block sender
      </GmMenuItem>
      <GmMenuItem
        icon={<Code size={20} />}
        onSelect={() => latest && setOriginal(latest)}
        disabled={!latest}
      >
        Message details
      </GmMenuItem>
    </GmMenu>
  );

  const toolbar = mobile ? (
    <div className="flex h-14 flex-none items-center gap-1 px-1 pt-[env(safe-area-inset-top)]">
      {tb("Back", <ArrowLeft size={24} />, onBack, { testId: "gmail-back" })}
      <div className="flex-1" />
      {trashed
        ? tb("Restore", <ArchiveRestore size={22} />, () => act.restore([item]))
        : inView
          ? tb("Archive", <Archive size={22} />, () => act.archive([item]))
          : tb("Move to inbox", <InboxIcon size={22} />, () =>
              act.moveToInbox([item]),
            )}
      {showDelete &&
        tb(deleteLabel, <Trash2 size={22} />, () => act.requestDelete([item]), {
          disabled: !canDelete,
        })}
      {tb("Mark as unread", <Mail size={22} />, () => {
        void act.markUnread([item]).then(onBack);
      })}
      {moreMenu}
    </div>
  ) : (
    <div className="flex h-12 flex-none items-center gap-1 px-2">
      {!pane &&
        tb(backLabel, <ArrowLeft size={20} />, onBack, {
          testId: "gmail-back",
        })}
      <span className="mx-1" />
      {trashed
        ? tb(
            "Restore",
            <ArchiveRestore size={20} />,
            () => act.restore([item]),
            {
              testId: "gmail-conv-restore",
            },
          )
        : inView
          ? tb("Archive", <Archive size={20} />, () => act.archive([item]), {
              testId: "gmail-conv-archive",
            })
          : tb("Move to inbox", <InboxIcon size={20} />, () =>
              act.moveToInbox([item]),
            )}
      {showDelete &&
        tb(deleteLabel, <Trash2 size={20} />, () => act.requestDelete([item]), {
          disabled: !canDelete,
        })}
      <span className="mx-1 h-5 w-px bg-border" />
      {tb("Mark as unread", <Mail size={20} />, () => {
        void act.markUnread([item]).then(onBack);
      })}
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
        onSnooze={(until) => act.snooze([item], until)}
        onPick={() => act.pickSnooze([item])}
      />
      <span className="mx-1 h-5 w-px bg-border" />
      {tb(
        item.starred ? "Starred" : "Not starred",
        <Star
          size={20}
          className={item.starred ? "fill-current text-star" : undefined}
        />,
        () => act.star([item]),
      )}
      {moreMenu}
      <div className="flex-1" />
      {position && (
        <span className="mr-1 text-xs text-text-secondary">
          {position.index.toLocaleString()} of {position.total.toLocaleString()}
        </span>
      )}
      {tb("Newer", <ChevronLeft size={20} />, () => onPrev?.(), {
        disabled: !onPrev,
      })}
      {tb("Older", <ChevronRight size={20} />, () => onNext?.(), {
        disabled: !onNext,
      })}
    </div>
  );

  /* ── message list with Gmail's collapsed middle ── */
  const list = emails ?? [];
  const collapseMiddle = !showAll && list.length > 4;
  const visible: Array<Email | { strip: number }> = collapseMiddle
    ? [list[0], { strip: list.length - 3 }, ...list.slice(-2)]
    : list;

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const labelChips = inboxes.map((ib) => {
    const id = identities.find((s) => s.email === ib);
    return <LabelChip key={ib} address={ib} displayName={id?.displayName} />;
  });

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="gmail-conversation"
    >
      {toolbar}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            "flex flex-wrap items-center gap-2 pb-3 pt-4",
            mobile ? "px-4" : "pl-[68px] pr-6",
          )}
        >
          <h2
            className={cn(
              "min-w-0 font-normal text-text-primary",
              mobile ? "text-[22px] leading-7" : "text-[22px] leading-8",
            )}
            data-testid="gmail-conversation-subject"
          >
            {subject}
          </h2>
          {labelChips}
          {!mobile && (
            <div className="ml-auto flex flex-none items-center gap-0.5">
              <button
                type="button"
                className="gm-icon-btn gm-sm"
                aria-label={allExpanded ? "Collapse all" : "Expand all"}
                title={allExpanded ? "Collapse all (:)" : "Expand all (;)"}
                onClick={allExpanded ? collapseAll : expandAll}
                data-testid="gmail-expand-all"
              >
                {allExpanded ? (
                  <ChevronsDownUp size={18} />
                ) : (
                  <ChevronsUpDown size={18} />
                )}
              </button>
              <button
                type="button"
                className="gm-icon-btn gm-sm"
                aria-label="Print all"
                title="Print all"
                onClick={() => printEmails(emails ?? [], subject)}
                data-testid="gmail-print"
              >
                <Printer size={18} />
              </button>
              {onOpenNewWindow && (
                <button
                  type="button"
                  className="gm-icon-btn gm-sm"
                  aria-label="In new window"
                  title="In new window"
                  onClick={onOpenNewWindow}
                >
                  <ExternalLink size={18} />
                </button>
              )}
            </div>
          )}
          {mobile && (
            <button
              type="button"
              className="gm-icon-btn ml-auto"
              aria-label={item.starred ? "Starred" : "Not starred"}
              onClick={() => act.star([item])}
            >
              <Star
                size={22}
                className={item.starred ? "fill-current text-star" : undefined}
              />
            </button>
          )}
        </div>
        {!mobile && item.type === "group" && (
          <p className="-mt-2 mb-2 pl-[68px] text-xs text-text-secondary">
            {itemTitle(item)}
          </p>
        )}

        {error && (
          <div className="px-6 py-10 text-center text-sm text-text-secondary">
            {error}
          </div>
        )}
        {!emails && !error && (
          <div className="space-y-4 px-6 py-4">
            {[0, 1].map((i) => (
              <div key={i} className="flex gap-3">
                <span className="gm-skel h-10 w-10 rounded-full" />
                <div className="flex-1 space-y-2">
                  <div className="gm-skel h-3 w-1/3" />
                  <div className="gm-skel h-3 w-2/3" />
                  <div className="gm-skel h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        )}

        {visible.map((v) =>
          "strip" in v ? (
            <button
              key="strip"
              type="button"
              onClick={() => setShowAll(true)}
              className="relative my-1 flex h-8 w-full items-center"
              aria-label={`Show ${v.strip} older messages`}
              title={`${v.strip} older messages`}
              data-testid="gmail-older-strip"
            >
              <span className="absolute inset-x-0 top-[13px] h-[5px] border-y border-border" />
              <span className="relative z-[1] ml-4 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-card text-xs font-medium text-text-secondary hover:bg-bg-subtle">
                {v.strip}
              </span>
            </button>
          ) : (
            <MessageCard
              key={v.id}
              email={v}
              sender={senderOf(v)}
              expanded={expanded.has(v.id)}
              onToggle={() => toggle(v.id)}
              onReply={() => startReply(v)}
              onReplyAll={() => startReply(v, true)}
              onForward={() => forward(v)}
              onViewOriginal={() => setOriginal(v)}
              onDelete={() => setDeleting(v)}
              onMarkUnreadFrom={() => void markUnreadFrom(v)}
              mobile={mobile}
              cursor={msgCursor >= 0 && list[msgCursor]?.id === v.id}
            />
          ),
        )}

        {inline &&
          !mobile &&
          (() => {
            const target =
              list.find((e) => e.id === inline.targetId) ?? replyTarget;
            if (!target) return null;
            const party = counterpart(target);
            return (
              <div className="border-t border-border py-4 pl-4 pr-6">
                <InlineComposer
                  key={`${target.id}:${inline.mode === "forward" ? "f" : "r"}`}
                  mode={inline.mode}
                  target={target}
                  party={party}
                  inboxes={inboxes}
                  identities={identities}
                  internalDomains={internalDomains}
                  subject={cleanSubject(target.subject ?? subject)}
                  forwardHtml={forwardHtmlFor(target)}
                  meName={me?.name}
                  meEmail={me?.email}
                  onModeChange={(m) =>
                    setInline({ mode: m, targetId: target.id })
                  }
                  onClose={() => setInline(null)}
                  onReopen={() =>
                    setInline({ mode: inline.mode, targetId: target.id })
                  }
                  undoSeconds={common.undoSendSeconds}
                  onSent={() => {
                    refetch();
                    onChanged();
                  }}
                  onPopOut={(cur) => {
                    setInline(null);
                    if (inline.mode === "forward") {
                      onCompose({
                        from: inboxOf(target) ?? undefined,
                        to: cur.to || undefined,
                        cc: cur.cc,
                        subject: `Fwd: ${cleanSubject(target.subject ?? subject)}`,
                        bodyHtml: cur.bodyHtml,
                      });
                    } else {
                      setReplyTo({
                        id: target.id,
                        all: inline.mode === "replyAll",
                      });
                    }
                  }}
                />
              </div>
            );
          })()}

        {emails && emails.length > 0 && !mobile && !inline && (
          <div className="flex flex-wrap gap-3 border-t border-border py-5 pl-[68px] pr-6">
            <button
              type="button"
              className="gm-pill-btn"
              onClick={() => startReply(replyTarget)}
              data-testid="gmail-reply"
            >
              <Reply size={20} /> Reply
            </button>
            {hasCc && (
              <button
                type="button"
                className="gm-pill-btn"
                onClick={() => startReply(replyTarget, true)}
              >
                <ReplyAll size={20} /> Reply all
              </button>
            )}
            <button
              type="button"
              className="gm-pill-btn"
              onClick={() => forward(latest)}
            >
              <Forward size={20} /> Forward
            </button>
          </div>
        )}
        {mobile && <div className="h-24" />}
      </div>

      {mobile && emails && emails.length > 0 && (
        <div className="flex flex-none gap-2 border-t border-border bg-card px-4 pb-[calc(12px+env(safe-area-inset-bottom))] pt-3">
          <button
            type="button"
            className="gm-pill-btn gm-compact"
            onClick={() => startReply(replyTarget)}
            data-testid="gmail-reply"
          >
            <Reply size={20} /> Reply
          </button>
          {hasCc && (
            <button
              type="button"
              className="gm-pill-btn gm-compact"
              onClick={() => startReply(replyTarget, true)}
            >
              <ReplyAll size={20} /> Reply all
            </button>
          )}
          <button
            type="button"
            className="gm-pill-btn gm-compact"
            onClick={() => forward(latest)}
          >
            <Forward size={20} /> Forward
          </button>
        </div>
      )}

      {replyTo &&
        (() => {
          const target = list.find((e) => e.id === replyTo.id) ?? replyTarget;
          if (!target) return null;
          const party = counterpart(target);
          const ib = inboxOf(target);
          return (
            <ReplyComposer
              key={`${target.id}:${replyTo.all}`}
              emailId={target.id}
              replyAll={replyTo.all}
              personName={party.name}
              personEmail={party.email}
              recipients={ib ? [ib] : inboxes}
              senderIdentities={identities}
              internalDomains={internalDomains}
              onClose={() => setReplyTo(null)}
              onSent={() => {
                refetch();
                onChanged();
              }}
            />
          );
        })()}

      <ConfirmDialog
        open={!!deleting}
        title="Delete this message forever?"
        body="This permanently deletes the message and its attachments. There is no trash, so this can't be undone."
        confirmLabel="Delete forever"
        onConfirm={() => deleting && void deleteMessage(deleting)}
        onClose={() => setDeleting(null)}
      />

      <EmailHtmlModal
        email={original}
        open={original !== null}
        onClose={() => setOriginal(null)}
        onUpdated={refetch}
      />
    </div>
  );
}
