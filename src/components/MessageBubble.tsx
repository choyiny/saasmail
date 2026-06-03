import { useState } from "react";
import { sanitizeEmailHtml } from "@/lib/sanitize-html";
import { Link2, Maximize2, Paperclip, Trash2, UserPen } from "lucide-react";
import CcChips from "@/components/CcChips";
import type { Email } from "@/lib/api";
import { copyMessageLink, messageDomId } from "@/lib/message-link";

interface MessageBubbleProps {
  email: Email;
  personEmail: string;
  /** Domains we treat as "internal" (matches our sender_identities). */
  internalDomains?: string[];
  /**
   * Per-bubble sender override — used when rendering a group conversation
   * where each bubble has a different sender. Returning `null` falls back
   * to the default ("You" for sent, `personEmail` for received).
   */
  senderResolver?: (
    email: Email,
  ) => { email: string; name: string | null } | null;
  onOpenHtml: (email: Email) => void;
  onMarkRead: (email: Email) => void;
  onReply: (emailId: string) => void;
  onDelete: (emailId: string) => void;
  /** Re-associate this received email with a different/new person. When
   *  omitted, the action is hidden (e.g. group-conversation views). */
  onReassign?: (email: Email) => void;
  compact?: boolean;
  renderHtml?: boolean;
}

const MAX_LINES = 4;
const APPROX_CHARS_PER_LINE = 80;
const TRUNCATE_LENGTH = MAX_LINES * APPROX_CHARS_PER_LINE;

export default function MessageBubble({
  email,
  personEmail,
  internalDomains = [],
  senderResolver,
  onOpenHtml,
  onMarkRead,
  onReply,
  onDelete,
  onReassign,
  compact = false,
  renderHtml = false,
}: MessageBubbleProps) {
  const override = senderResolver?.(email) ?? null;
  const [expanded, setExpanded] = useState(false);
  const isSent = email.type === "sent";
  const isUnread = email.type === "received" && email.isRead === 0;

  const text =
    email.bodyText ||
    (email.bodyHtml
      ? (new DOMParser().parseFromString(email.bodyHtml, "text/html").body
          .textContent ?? "")
      : "");
  const truncateLength = compact ? 160 : TRUNCATE_LENGTH;

  const isTruncated = text.length > truncateLength && !expanded;
  const displayText = isTruncated
    ? text.slice(0, truncateLength).trimEnd() + "..."
    : text;

  const senderName = isSent
    ? "You"
    : override
      ? override.name && override.name.trim()
        ? override.name
        : override.email
      : personEmail;

  const toAddress = isSent
    ? email.toAddress || personEmail
    : email.recipient || email.fromAddress || "";

  const timestamp = new Date(email.timestamp * 1000);
  const timeStr = timestamp.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const dateStr = timestamp.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });

  // Filter to non-inline attachments only
  const downloadableAttachments = (email.attachments ?? []).filter(
    (att) => !att.contentId,
  );

  function handleClick() {
    if (isUnread) {
      onMarkRead(email);
    }
  }

  return (
    <div
      id={messageDomId(email.id)}
      data-testid="thread-message"
      data-email-id={email.id}
      className={`group ${compact ? "px-3 py-1.5" : "px-4 sm:px-6 py-2"} hover:bg-bg-muted/50 transition-colors scroll-mt-20 ${
        isUnread ? "bg-accent/5" : ""
      }`}
      onClick={handleClick}
    >
      {/* Sender line with To: label */}
      <div className="flex items-baseline gap-2 mb-0.5 min-w-0">
        <span
          className={`text-xs font-semibold shrink-0 ${
            isUnread ? "text-accent" : "text-text-primary"
          }`}
        >
          {senderName}
        </span>
        <span className="text-[11px] text-text-tertiary truncate min-w-0">
          To: {toAddress}
        </span>
        <span className="text-[10px] text-text-tertiary shrink-0 ml-auto">
          {dateStr} {timeStr}
        </span>
        {isUnread && (
          <span className="h-1.5 w-1.5 rounded-full bg-accent shrink-0" />
        )}
      </div>

      {/* Subject */}
      {email.subject && (
        <p
          className={`text-xs mb-0.5 ${
            isUnread
              ? "font-semibold text-text-primary"
              : "font-medium text-text-secondary"
          }`}
        >
          {email.subject}
        </p>
      )}

      {/* CC chips — internal contacts get a lime accent */}
      {email.cc && email.cc.length > 0 && (
        <div className="mb-1">
          <CcChips cc={email.cc} internalDomains={internalDomains} />
        </div>
      )}

      {/* Body */}
      {renderHtml && email.bodyHtml ? (
        <div
          className="prose prose-sm max-w-none text-xs text-text-secondary leading-relaxed"
          dangerouslySetInnerHTML={{
            __html: sanitizeEmailHtml(email.bodyHtml),
          }}
        />
      ) : displayText ? (
        <p className="whitespace-pre-wrap text-xs text-text-secondary leading-relaxed">
          {displayText}
        </p>
      ) : (
        <p className="text-xs text-text-tertiary italic">(no text content)</p>
      )}

      {/* Show more / less */}
      {!renderHtml && text.length > truncateLength && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
          className="mt-1 text-[11px] text-accent hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}

      {/* Downloadable attachments */}
      {downloadableAttachments.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {downloadableAttachments.map((att) => (
            <a
              key={att.id}
              href={`/api/attachments/${att.id}`}
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-muted"
            >
              <Paperclip size={10} />
              {att.filename}
            </a>
          ))}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-3 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {email.bodyHtml && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpenHtml(email);
            }}
            className="flex items-center gap-1 text-[11px] text-text-tertiary hover:text-text-secondary"
            title="View full email"
          >
            <Maximize2 size={12} />
            View
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onReply(email.id);
          }}
          className="text-[11px] text-text-tertiary hover:text-text-secondary"
        >
          Reply
        </button>
        {!isSent && onReassign && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onReassign(email);
            }}
            data-testid="message-reassign"
            className="flex items-center gap-1 text-[11px] text-text-tertiary hover:text-text-secondary"
            title="Reassign to another person"
          >
            <UserPen size={12} />
            Reassign
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            void copyMessageLink(email.id);
          }}
          data-testid="message-copy-link"
          className="flex items-center gap-1 text-[11px] text-text-tertiary hover:text-text-secondary"
          title="Copy link to this message"
        >
          <Link2 size={12} />
          Copy link
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(email.id);
          }}
          className="flex items-center gap-1 text-[11px] text-text-tertiary hover:text-red-400"
          title="Delete email"
        >
          <Trash2 size={12} />
          Delete
        </button>
      </div>
    </div>
  );
}
