import { useState } from "react";
import { Maximize2, Paperclip, Trash2 } from "lucide-react";
import type { Email } from "@/lib/api";

interface MessageBubbleProps {
  email: Email;
  senderEmail: string;
  onOpenHtml: (email: Email) => void;
  onMarkRead: (email: Email) => void;
  onReply: (emailId: string) => void;
  onDelete: (emailId: string) => void;
}

const MAX_LINES = 4;
const APPROX_CHARS_PER_LINE = 80;
const TRUNCATE_LENGTH = MAX_LINES * APPROX_CHARS_PER_LINE;

export default function MessageBubble({
  email,
  senderEmail,
  onOpenHtml,
  onMarkRead,
  onReply,
  onDelete,
}: MessageBubbleProps) {
  const [expanded, setExpanded] = useState(false);
  const isSent = email.type === "sent";
  const isUnread = email.type === "received" && email.isRead === 0;

  const text = email.bodyText || "";
  const isTruncated = text.length > TRUNCATE_LENGTH && !expanded;
  const displayText = isTruncated
    ? text.slice(0, TRUNCATE_LENGTH).trimEnd() + "..."
    : text;

  const senderName = isSent
    ? "You"
    : senderEmail;

  const toAddress = isSent
    ? email.toAddress || senderEmail
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
      className={`group px-4 sm:px-6 py-2 hover:bg-hover/50 transition-colors ${
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
            isUnread ? "font-semibold text-text-primary" : "font-medium text-text-secondary"
          }`}
        >
          {email.subject}
        </p>
      )}

      {/* Text body */}
      {displayText ? (
        <p className="whitespace-pre-wrap text-xs text-text-secondary leading-relaxed">
          {displayText}
        </p>
      ) : (
        <p className="text-xs text-text-tertiary italic">(no text content)</p>
      )}

      {/* Show more / less */}
      {text.length > TRUNCATE_LENGTH && (
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
              className="flex items-center gap-1 rounded border border-border-dark px-2 py-1 text-[10px] text-text-secondary hover:bg-hover"
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
        {email.type === "received" && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onReply(email.id);
            }}
            className="text-[11px] text-text-tertiary hover:text-text-secondary"
          >
            Reply
          </button>
        )}
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
