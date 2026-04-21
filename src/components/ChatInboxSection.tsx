import { useState, useMemo } from "react";
import { Inbox, Maximize2, Paperclip, Trash2 } from "lucide-react";
import type { Email } from "@/lib/api";
import type { ThreadInboxGroup } from "@/components/ThreadInboxSection";
import ChatQuickReply from "@/components/ChatQuickReply";

interface ChatInboxSectionProps {
  group: ThreadInboxGroup;
  personEmail: string;
  onOpenHtml: (email: Email) => void;
  onMarkRead: (email: Email) => void;
  onDelete: (emailId: string) => void;
  onSent: () => void;
}

const INITIAL_VISIBLE = 5;
const PAGE_SIZE = 20;
const BUBBLE_TRUNCATE_CHARS = 480; // ~6 lines

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

interface BubbleProps {
  email: Email;
  personEmail: string;
  onOpenHtml: (email: Email) => void;
  onMarkRead: (email: Email) => void;
  onDelete: (emailId: string) => void;
}

function Bubble({
  email,
  personEmail,
  onOpenHtml,
  onMarkRead,
  onDelete,
}: BubbleProps) {
  const [expanded, setExpanded] = useState(false);
  const isSent = email.type === "sent";
  const isUnread = email.type === "received" && email.isRead === 0;

  const text = useMemo(() => emailToText(email), [email]);
  const truncated = text.length > BUBBLE_TRUNCATE_CHARS && !expanded;
  const displayText = truncated
    ? text.slice(0, BUBBLE_TRUNCATE_CHARS).trimEnd() + "…"
    : text;

  const ts = new Date(email.timestamp * 1000);
  const stamp =
    ts.toLocaleDateString([], { month: "short", day: "numeric" }) +
    " " +
    ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const downloadable = (email.attachments ?? []).filter((a) => !a.contentId);

  function handleClick() {
    if (isUnread) onMarkRead(email);
  }

  return (
    <div
      data-testid="chat-bubble"
      className={`group flex flex-col px-4 sm:px-6 py-1 ${
        isSent ? "items-end" : "items-start"
      }`}
      onClick={handleClick}
      title={email.subject ?? undefined}
    >
      <div
        className={`max-w-[78%] rounded-2xl px-3 py-2 text-xs leading-relaxed ${
          isSent ? "bg-accent text-white" : "bg-bg-muted text-text-primary"
        } ${isUnread ? "ring-1 ring-accent" : ""}`}
      >
        {displayText ? (
          <p className="whitespace-pre-wrap">{displayText}</p>
        ) : (
          <p className="italic opacity-70">(no text content)</p>
        )}
        {text.length > BUBBLE_TRUNCATE_CHARS && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            className={`mt-1 text-[11px] underline ${
              isSent ? "text-white/80" : "text-accent"
            }`}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>

      {downloadable.length > 0 && (
        <div
          className={`mt-1 flex flex-wrap gap-1.5 max-w-[78%] ${
            isSent ? "justify-end" : "justify-start"
          }`}
        >
          {downloadable.map((att) => (
            <a
              key={att.id}
              href={`/api/attachments/${att.id}`}
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1 rounded border border-border bg-white px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-muted"
            >
              <Paperclip size={10} />
              {att.filename}
            </a>
          ))}
        </div>
      )}

      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-text-tertiary">
        <span>{stamp}</span>
        {email.bodyHtml && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenHtml(email);
            }}
            className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity hover:text-text-secondary"
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
            onDelete(email.id);
          }}
          className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity hover:text-red-400"
          title="Delete email"
        >
          <Trash2 size={10} />
        </button>
        {isUnread && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
      </div>
    </div>
  );
}

export default function ChatInboxSection({
  group,
  personEmail,
  onOpenHtml,
  onMarkRead,
  onDelete,
  onSent,
}: ChatInboxSectionProps) {
  // group.emails is newest-first. Chat displays chronological (oldest → newest)
  // with the most recent at the bottom.
  const chronological = useMemo(
    () => [...group.emails].reverse(),
    [group.emails],
  );
  const total = chronological.length;
  // Track the hidden-count (start index) instead of a visible-count so that
  // when new messages arrive (e.g. after sending a reply) they append to the
  // bottom without re-collapsing previously-visible earlier messages.
  const [hiddenCount, setHiddenCount] = useState(() =>
    Math.max(0, total - INITIAL_VISIBLE),
  );
  const start = Math.min(hiddenCount, Math.max(0, total - 1));
  const visibleEmails = chronological.slice(start);
  const effectiveHidden = start;

  // Latest received email — the target of the quick reply.
  // group.emails is newest-first, so .find returns the most recent received.
  const replyTarget = useMemo(
    () => group.emails.find((e) => e.type === "received") ?? null,
    [group.emails],
  );

  return (
    <section className="border-b-4 border-border-subtle flex flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-bg-subtle px-4 sm:px-6 py-2">
        <Inbox size={12} className="text-text-tertiary" />
        <span className="text-[11px] font-medium text-text-secondary">
          {group.inbox}
        </span>
        <span className="text-[11px] text-text-tertiary">
          · {total} email{total !== 1 ? "s" : ""} · chat mode
        </span>
      </div>

      <div className="flex flex-col py-2 gap-1">
        {effectiveHidden > 0 && (
          <div className="px-4 sm:px-6 py-1">
            <button
              type="button"
              onClick={() => setHiddenCount((h) => Math.max(0, h - PAGE_SIZE))}
              className="text-xs text-accent hover:underline"
            >
              Show {Math.min(PAGE_SIZE, effectiveHidden)} earlier message
              {Math.min(PAGE_SIZE, effectiveHidden) !== 1 ? "s" : ""}
            </button>
          </div>
        )}

        {visibleEmails.map((email) => (
          <Bubble
            key={email.id}
            email={email}
            personEmail={personEmail}
            onOpenHtml={onOpenHtml}
            onMarkRead={onMarkRead}
            onDelete={onDelete}
          />
        ))}
      </div>

      <ChatQuickReply
        inboxAddress={group.inbox}
        latestReceivedEmailId={replyTarget?.id ?? null}
        personEmail={personEmail}
        onSent={onSent}
      />
    </section>
  );
}
