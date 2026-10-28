import { useState } from "react";
import { sanitizeEmailHtml } from "@/lib/sanitize-html";
import {
  AlertTriangle,
  Clock,
  Download,
  Link2,
  Maximize2,
  Paperclip,
  Trash2,
  UserPen,
} from "lucide-react";
import CcChips from "@/components/CcChips";
import ImageAttachments, {
  splitAttachments,
} from "@/components/ImageAttachments";
import { messageEmlUrl, type Email } from "@/lib/api";
import { copyMessageLink, messageDomId } from "@/lib/message-link";
import DeliveryBadge from "@/components/mail/DeliveryBadge";

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

const ACTION =
  "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary";

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
  const failedToSend = isSent && email.status === "failed";
  const retrying = isSent && email.status === "retrying";

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

  // Embedded (CID) images are already in the body. Image attachments get
  // thumbnails that open in the viewer; everything else is a download chip.
  const { images: imageAttachments, files: downloadableAttachments } =
    splitAttachments(email.attachments);

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
      className={`group scroll-mt-20 rounded-2xl border bg-card shadow-card transition-colors ${
        compact ? "px-3 py-2" : "px-4 py-3 sm:px-5 sm:py-4"
      } ${
        failedToSend
          ? "border-destructive/40"
          : retrying
            ? "border-warning-border"
            : isUnread
              ? "border-accent/40"
              : "border-border"
      }`}
      onClick={handleClick}
    >
      {/* Sender line with To: label */}
      <div className="mb-1 flex min-w-0 items-baseline gap-2">
        {isUnread && (
          <span
            className="h-2 w-2 shrink-0 self-center rounded-full bg-accent"
            aria-label="Unread"
          />
        )}
        <span className="shrink-0 text-sm font-semibold text-text-primary">
          {senderName}
        </span>
        <span className="min-w-0 truncate text-xs text-text-tertiary">
          To: {toAddress}
        </span>
        {failedToSend && (
          <span
            data-testid="message-failed-badge"
            title="This message was rejected by the email provider and was not delivered."
            className="pt-chip bad shrink-0"
          >
            <AlertTriangle size={10} />
            Failed to send
          </span>
        )}
        {retrying && (
          <span
            data-testid="message-retrying-badge"
            title="The email provider rejected this send; it will be retried automatically. See the Outbox for details."
            className="pt-chip warn shrink-0"
          >
            <Clock size={10} />
            Retrying
          </span>
        )}
        {isSent && (
          <DeliveryBadge status={email.status} sendAt={email.timestamp} />
        )}
        {isSent && email.campaignId && (
          <span
            data-testid="message-campaign-badge"
            title="Part of a newsletter campaign, not a message written to this person."
            className="inline-flex shrink-0 items-center rounded-[5px] bg-violet/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: "#7c5cfc" }}
          >
            Campaign
          </span>
        )}
        <span className="tabular ml-auto shrink-0 text-xs text-text-tertiary">
          {dateStr} {timeStr}
        </span>
      </div>

      {/* Subject */}
      {email.subject && (
        <p
          className={`mb-1 text-[13.5px] ${
            isUnread
              ? "font-semibold text-text-primary"
              : "font-medium text-text-primary"
          }`}
        >
          {email.subject}
        </p>
      )}

      {/* CC chips — internal contacts get a lime accent */}
      {email.cc && email.cc.length > 0 && (
        <div className="mb-2">
          <CcChips cc={email.cc} internalDomains={internalDomains} />
        </div>
      )}

      {/* Body */}
      {renderHtml && email.bodyHtml ? (
        <div
          className="email-surface mt-2 max-w-none overflow-x-auto rounded-lg px-3 py-2.5 text-sm leading-relaxed [&_img]:max-w-full"
          dangerouslySetInnerHTML={{
            __html: sanitizeEmailHtml(email.bodyHtml),
          }}
        />
      ) : displayText ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">
          {displayText}
        </p>
      ) : (
        <p className="text-[13px] italic text-text-tertiary">
          (no text content)
        </p>
      )}

      {/* Show more / less */}
      {!renderHtml && text.length > truncateLength && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
          className="mt-1 text-xs font-medium text-accent-subtle-fg hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}

      <ImageAttachments
        images={imageAttachments}
        size="sm"
        className="mt-1.5"
      />

      {/* Downloadable attachments */}
      {downloadableAttachments.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {downloadableAttachments.map((att) => (
            <a
              key={att.id}
              href={`/api/attachments/${att.id}`}
              onClick={(e) => e.stopPropagation()}
              className="pt-chip h-6 hover:bg-bg-muted"
            >
              <Paperclip size={12} />
              {att.filename}
            </a>
          ))}
        </div>
      )}

      {/* Action buttons */}
      <div className="mt-2 flex flex-wrap items-center gap-1 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100">
        {email.bodyHtml && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpenHtml(email);
            }}
            className={ACTION}
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
          className={ACTION}
        >
          Reply
        </button>
        <a
          href={messageEmlUrl(`${email.type}:${email.id}`)}
          download
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-1 text-[11px] text-text-tertiary hover:text-text-secondary"
          title="Download (.eml)"
        >
          <Download size={12} />
          .eml
        </a>
        {onReassign && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onReassign(email);
            }}
            data-testid="message-reassign"
            className={ACTION}
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
          className={ACTION}
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
          className={`${ACTION} hover:!text-destructive`}
          title="Delete email"
        >
          <Trash2 size={12} />
          Delete
        </button>
      </div>
    </div>
  );
}
