import { useState, useMemo, useRef, useEffect, useLayoutEffect } from "react";
import {
  Inbox,
  Link2,
  Maximize2,
  Paperclip,
  Trash2,
  UserPen,
  ArrowDown,
  Check,
  CheckCheck,
} from "lucide-react";
import type { Email } from "@/lib/api";
import type { ThreadInboxGroup } from "@/components/ThreadInboxSection";
import ChatQuickReply from "@/components/ChatQuickReply";
import CcChips, { RosterDiffNotice } from "@/components/CcChips";
import { rosterOf, diffRosters } from "@/lib/roster";
import type { ComposePrefill } from "@/pages/ComposeModal";
import { sanitizeEmailHtml } from "@/lib/sanitize-html";
import { copyMessageLink, messageDomId } from "@/lib/message-link";
import {
  HIDE_SIGNATURES_EVENT,
  readHideSignatures,
  stripSignatureFromHtml,
  stripSignatureFromText,
} from "@/lib/signatures";

interface ChatInboxSectionProps {
  group: ThreadInboxGroup;
  personEmail: string;
  /** Domains we treat as "internal" for CC chip coloring. */
  internalDomains?: string[];
  /**
   * Per-bubble sender override — used in group conversations to label
   * each received bubble with the actual sender's name. Returns null
   * to fall back to the default behavior.
   */
  senderResolver?: (
    email: Email,
  ) => { email: string; name: string | null } | null;
  onOpenHtml: (email: Email) => void;
  onMarkRead: (email: Email) => void;
  onDelete: (emailId: string) => void;
  onReassign?: (email: Email) => void;
  onSent: () => void;
  /**
   * Optional handoff to the global compose drawer. When provided, the
   * sticky reply renders an "open in compose" button that fires this
   * callback with a prefilled context (from + to + cc + subject) so the
   * user can keep typing in the full editor — change sender identity,
   * add a teammate to CC, attach files, etc.
   */
  onOpenCompose?: (prefill?: ComposePrefill) => void;
}

const BUBBLE_TRUNCATE_CHARS = 480;

function emailToText(email: Email): string {
  if (email.bodyText) return email.bodyText;
  if (email.bodyHtml) {
    return (
      new DOMParser().parseFromString(email.bodyHtml, "text/html").body
        .textContent ?? ""
    );
  }
  return "";
}

/**
 * Heuristic: should we render an inline HTML preview card instead of dumping
 * the (often broken) plain-text fallback? True for marketing/transactional
 * emails that ship HTML-only or whose HTML is significantly richer than the
 * stripped-text fallback would be readable as.
 */
function shouldShowHtmlPreview(email: Email): boolean {
  const txt = email.bodyText?.trim() ?? "";
  const html = email.bodyHtml ?? "";
  if (!html) return false;
  if (!txt) return true;
  // Plain text exists but the HTML is significantly richer — render preview.
  const looksMarketingy = /<table|<style|class="/i.test(html);
  return looksMarketingy && html.length > 4000;
}

function dayLabel(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);
  const dDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (dDay.getTime() === today.getTime()) return "Today";
  if (dDay.getTime() === yesterday.getTime()) return "Yesterday";
  if (now.getTime() - dDay.getTime() < 6 * 86_400_000) {
    return d.toLocaleDateString([], { weekday: "long" });
  }
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

interface BubbleProps {
  email: Email;
  internalDomains?: string[];
  senderResolver?: (
    email: Email,
  ) => { email: string; name: string | null } | null;
  onOpenHtml: (email: Email) => void;
  onMarkRead: (email: Email) => void;
  onDelete: (emailId: string) => void;
  onReassign?: (email: Email) => void;
}

function Bubble({
  email,
  internalDomains = [],
  senderResolver,
  onOpenHtml,
  onMarkRead,
  onDelete,
  onReassign,
}: BubbleProps) {
  // Resolve the sender label for received bubbles. In a group conversation,
  // each received bubble is from a different person; senderResolver lets
  // the parent supply per-message identity. Falls back to nothing for 1-on-1.
  const senderOverride = senderResolver?.(email) ?? null;
  const [expanded, setExpanded] = useState(false);
  const isSent = email.type === "sent";
  const isUnread = email.type === "received" && email.isRead === 0;

  // Subscribe to the local "Hide signatures in chat" preference. When on,
  // we strip the trailing signature block from each bubble's body so the
  // chat feed stays scannable. Updates instantly on toggle thanks to a
  // custom event from `lib/signatures.ts`.
  const [hideSignatures, setHideSignatures] = useState(() =>
    readHideSignatures(),
  );
  useEffect(() => {
    function refresh() {
      setHideSignatures(readHideSignatures());
    }
    window.addEventListener(HIDE_SIGNATURES_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(HIDE_SIGNATURES_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  // Apply the strip to a per-bubble copy of the email so downstream useMemos
  // operate on the pruned text/html rather than the raw originals.
  const visibleEmail = useMemo<Email>(() => {
    if (!hideSignatures) return email;
    return {
      ...email,
      bodyText: email.bodyText ? stripSignatureFromText(email.bodyText) : null,
      bodyHtml: email.bodyHtml ? stripSignatureFromHtml(email.bodyHtml) : null,
    };
  }, [email, hideSignatures]);

  const text = useMemo(() => emailToText(visibleEmail), [visibleEmail]);
  const showHtmlPreview = useMemo(
    () => shouldShowHtmlPreview(visibleEmail),
    [visibleEmail],
  );
  const sanitizedHtml = useMemo(
    () =>
      showHtmlPreview ? sanitizeEmailHtml(visibleEmail.bodyHtml ?? "") : "",
    [showHtmlPreview, visibleEmail.bodyHtml],
  );
  const truncated = text.length > BUBBLE_TRUNCATE_CHARS && !expanded;
  const displayText = truncated
    ? text.slice(0, BUBBLE_TRUNCATE_CHARS).trimEnd() + "…"
    : text;

  const ts = new Date(email.timestamp * 1000);
  const stamp = ts.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  const downloadable = (email.attachments ?? []).filter((a) => !a.contentId);

  function handleClick() {
    if (isUnread) onMarkRead(email);
  }

  // Sender label: only shown on received bubbles in group conversations
  // (i.e. when senderOverride is supplied). Keeps 1-on-1 chats clean.
  const senderLabel =
    !isSent && senderOverride
      ? senderOverride.name && senderOverride.name.trim()
        ? senderOverride.name
        : senderOverride.email
      : null;

  return (
    <div
      id={messageDomId(email.id)}
      data-testid="chat-bubble"
      data-email-id={email.id}
      className={`group flex flex-col px-4 py-1 sm:px-6 scroll-mt-20 ${
        isSent ? "items-end" : "items-start"
      }`}
      onClick={handleClick}
      title={email.subject ?? undefined}
    >
      {senderLabel && (
        <span
          className="mb-0.5 max-w-[85%] truncate px-2 text-[10px] font-medium uppercase tracking-wider text-text-tertiary sm:max-w-[78%]"
          title={senderOverride?.email}
        >
          {senderLabel}
        </span>
      )}
      {showHtmlPreview ? (
        <div
          data-testid="chat-html-preview"
          className={`relative w-full max-w-[85%] overflow-hidden rounded-2xl bg-white text-left text-text-primary shadow-sm ring-1 ring-border sm:max-w-[78%] ${
            isUnread ? "outline outline-2 outline-violet/40" : ""
          }`}
        >
          {/* Sanitized inline preview. Images render at their natural
              size, constrained only by the bubble width so aspect ratio
              is preserved — capping height made hero/inline images
              unreadably small. */}
          <div
            className="prose prose-sm relative max-w-none px-4 py-3 text-xs text-text-secondary [&_*]:max-w-full [&_a]:pointer-events-none [&_img]:h-auto [&_img]:max-w-full [&_table]:!w-full [&_table]:!table-fixed"
            dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
          />
        </div>
      ) : (
        <div
          className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm sm:max-w-[78%] ${
            isSent
              ? "bg-text-primary text-white"
              : "bg-white text-text-primary ring-1 ring-border"
          } ${isUnread ? "outline outline-2 outline-violet/40" : ""}`}
        >
          {displayText ? (
            <p className="whitespace-pre-wrap break-words">{displayText}</p>
          ) : (
            <p className="italic opacity-60">(no text content)</p>
          )}
          {text.length > BUBBLE_TRUNCATE_CHARS && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(!expanded);
              }}
              className={`mt-1.5 text-xs font-medium underline-offset-2 hover:underline ${
                isSent ? "text-white/85" : "text-text-secondary"
              }`}
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}

      {/* CC chips — sit just below the bubble */}
      {email.cc && email.cc.length > 0 && (
        <div
          className={`mt-1 flex max-w-[85%] sm:max-w-[78%] ${
            isSent ? "justify-end" : "justify-start"
          }`}
        >
          <CcChips
            cc={email.cc}
            internalDomains={internalDomains}
            variant="compact"
          />
        </div>
      )}

      {downloadable.length > 0 && (
        <div
          className={`mt-1.5 flex max-w-[85%] flex-wrap gap-1.5 sm:max-w-[78%] ${
            isSent ? "justify-end" : "justify-start"
          }`}
        >
          {downloadable.map((att) => (
            <a
              key={att.id}
              href={`/api/attachments/${att.id}`}
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1 rounded-[6px] border border-border bg-card px-2 py-1 text-[11px] text-text-secondary transition-colors hover:bg-bg-muted"
            >
              <Paperclip size={11} />
              {att.filename}
            </a>
          ))}
        </div>
      )}

      <div
        className={`mt-1 flex items-center gap-2 text-[10px] text-text-tertiary ${isSent ? "flex-row-reverse" : ""}`}
      >
        <span>{stamp}</span>
        {isSent &&
          (email.deliveredAt ? (
            <CheckCheck size={11} className="text-text-tertiary" />
          ) : (
            <Check size={11} className="text-text-tertiary" />
          ))}
        {email.bodyHtml && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenHtml(email);
            }}
            className="flex items-center gap-1 hover:text-text-secondary"
            title="View original"
          >
            <Maximize2 size={10} />
            View original
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void copyMessageLink(email.id);
          }}
          data-testid="message-copy-link"
          className="flex items-center gap-1 opacity-0 transition-opacity hover:text-text-secondary group-hover:opacity-100"
          title="Copy link to this message"
        >
          <Link2 size={10} />
        </button>
        {!isSent && onReassign && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onReassign(email);
            }}
            data-testid="message-reassign"
            className="flex items-center gap-1 opacity-0 transition-opacity hover:text-text-secondary group-hover:opacity-100"
            title="Reassign to another person"
          >
            <UserPen size={10} />
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(email.id);
          }}
          className="flex items-center gap-1 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
          title="Delete email"
        >
          <Trash2 size={10} />
        </button>
        {isUnread && !isSent && (
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: "#7c5cfc" }}
          />
        )}
      </div>
    </div>
  );
}

interface DaySeparatorProps {
  label: string;
}
function DaySeparator({ label }: DaySeparatorProps) {
  return (
    <div className="flex items-center gap-2 px-6 py-3">
      <span className="h-px flex-1 bg-border" />
      <span className="rounded-full bg-bg-muted px-3 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
        {label}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

export default function ChatInboxSection({
  group,
  personEmail: _personEmail,
  internalDomains = [],
  senderResolver,
  onOpenHtml,
  onMarkRead,
  onDelete,
  onReassign,
  onSent,
  onOpenCompose,
}: ChatInboxSectionProps) {
  // Chronological order — oldest at top, newest at bottom.
  const chronological = useMemo(
    () => [...group.emails].reverse(),
    [group.emails],
  );

  // Group items by day for separators, and emit roster-diff notices
  // between consecutive messages where the *full* participant set
  // changes — not just CC. Diffing CC alone produces false positives
  // because the sender of a given message naturally isn't in their
  // own CC, so every speaker rotation looked like "X removed · Y added".
  const items = useMemo(() => {
    const out: Array<
      | { kind: "day"; key: string; label: string }
      | {
          kind: "roster";
          key: string;
          prev: Email["cc"];
          next: Email["cc"];
        }
      | { kind: "msg"; email: Email }
    > = [];
    let lastDay = "";
    let lastEmail: Email | null = null;
    let lastRoster: Email["cc"] = [];
    for (const email of chronological) {
      const label = dayLabel(email.timestamp);
      if (label !== lastDay) {
        out.push({ kind: "day", key: `day-${label}-${email.id}`, label });
        lastDay = label;
      }
      const nextRoster = rosterOf(email, senderResolver);
      if (lastEmail) {
        const { joined, left } = diffRosters(lastRoster, nextRoster);
        if (joined.length || left.length) {
          out.push({
            kind: "roster",
            key: `roster-${lastEmail.id}-${email.id}`,
            prev: lastRoster,
            next: nextRoster,
          });
        }
      }
      out.push({ kind: "msg", email });
      lastEmail = email;
      lastRoster = nextRoster;
    }
    return out;
  }, [chronological, senderResolver]);

  const replyTarget = useMemo(
    () => group.emails.find((e) => e.type === "received") ?? null,
    [group.emails],
  );

  // CC carried into the inline reply so chat-bubble sends default to
  // "reply-all" — matches the full ReplyComposer's behavior. Strip our
  // own inbox so we don't CC ourselves.
  const replyCc = useMemo(() => {
    const ownInbox = group.inbox.toLowerCase();
    return (replyTarget?.cc ?? []).filter(
      (c) => c.email.toLowerCase() !== ownInbox,
    );
  }, [replyTarget, group.inbox]);

  // Build the seed values for the full compose drawer. We pull the most
  // recent received email's recipient list so switching to compose
  // carries the original CC roster + subject through (minus our own
  // inbox, which is "us" and would be redundant on the To/Cc lines).
  const handleOpenInCompose = onOpenCompose
    ? () => {
        const sender = replyTarget
          ? (senderResolver?.(replyTarget) ?? null)
          : null;
        const to =
          sender?.email ?? replyTarget?.fromAddress ?? _personEmail ?? "";
        const cc = replyCc;
        const baseSubject = replyTarget?.subject ?? "";
        const subject =
          baseSubject && !/^re:\s/i.test(baseSubject)
            ? `Re: ${baseSubject}`
            : baseSubject;
        onOpenCompose({
          from: group.inbox,
          to,
          cc,
          subject,
        });
      }
    : undefined;

  // Scroll state for the messages pane
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasNewBelow, setHasNewBelow] = useState(false);
  const previousMsgIdsRef = useRef<Set<string>>(new Set());

  function scrollToBottom(behavior: ScrollBehavior = "smooth") {
    bottomRef.current?.scrollIntoView({ block: "end", behavior });
    setHasNewBelow(false);
    setIsAtBottom(true);
  }

  useLayoutEffect(() => {
    // Initial mount: jump to latest without animation
    scrollToBottom("auto");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const ids = new Set(chronological.map((e) => e.id));
    const prev = previousMsgIdsRef.current;
    let hasNew = false;
    for (const id of ids) {
      if (!prev.has(id)) {
        hasNew = true;
        break;
      }
    }
    previousMsgIdsRef.current = ids;
    if (!hasNew) return;
    if (isAtBottom) {
      // User is already at bottom: keep them pinned to latest.
      requestAnimationFrame(() => scrollToBottom("smooth"));
    } else {
      // User scrolled up: surface a "new message" indicator instead.
      setHasNewBelow(true);
    }
  }, [chronological, isAtBottom]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 24;
    setIsAtBottom(atBottom);
    if (atBottom) setHasNewBelow(false);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-subtle/40">
      {/* Inbox header — sticky at top of section. Slim, just the address. */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-card/80 px-3 py-1.5 backdrop-blur-sm">
        <Inbox size={11} className="text-text-tertiary" />
        <span className="text-xs font-medium text-text-secondary">
          {group.inbox}
        </span>
      </div>

      {/* Scrollable messages area */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Top fade — hints at scrollable content above */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-bg-subtle/60 to-transparent"
          aria-hidden
        />

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="smooth-scroll flex-1 overflow-y-auto py-2"
        >
          {items.map((item) =>
            item.kind === "day" ? (
              <DaySeparator key={item.key} label={item.label} />
            ) : item.kind === "roster" ? (
              <RosterDiffNotice
                key={item.key}
                prev={item.prev ?? []}
                next={item.next ?? []}
                internalDomains={internalDomains}
              />
            ) : (
              <Bubble
                key={item.email.id}
                email={item.email}
                internalDomains={internalDomains}
                senderResolver={senderResolver}
                onOpenHtml={onOpenHtml}
                onMarkRead={onMarkRead}
                onDelete={onDelete}
                onReassign={onReassign}
              />
            ),
          )}
          <div ref={bottomRef} className="h-2" />
        </div>

        {/* Bottom fade — hints at scrollable content below */}
        {!isAtBottom && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-12 bg-gradient-to-t from-bg-subtle/70 to-transparent"
            aria-hidden
          />
        )}

        {/* Floating "Jump to latest" pill */}
        {!isAtBottom && (
          <button
            type="button"
            onClick={() => scrollToBottom("smooth")}
            className={`absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium shadow-lg transition-all ${
              hasNewBelow
                ? "bg-text-primary text-white"
                : "bg-card text-text-primary ring-1 ring-border"
            }`}
          >
            <ArrowDown size={12} />
            {hasNewBelow ? "New messages" : "Jump to latest"}
          </button>
        )}
      </div>

      {/* Sticky reply at the bottom of the section */}
      <div className="shrink-0">
        <ChatQuickReply
          inboxAddress={group.inbox}
          latestReceivedEmailId={replyTarget?.id ?? null}
          personEmail={_personEmail}
          replyCc={replyCc}
          onSent={onSent}
          onOpenCompose={handleOpenInCompose}
        />
      </div>
    </div>
  );
}
