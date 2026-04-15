import { useState } from "react";
import { Maximize2, Paperclip } from "lucide-react";
import type { Email } from "@/lib/api";

interface MessageBubbleProps {
  email: Email;
  senderEmail: string;
  onOpenHtml: (email: Email) => void;
  onMarkRead: (email: Email) => void;
  onReply: (emailId: string) => void;
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
}: MessageBubbleProps) {
  const [expanded, setExpanded] = useState(false);
  const isSent = email.type === "sent";
  const isUnread = email.type === "received" && email.isRead === 0;

  const text = email.bodyText || "";
  const isTruncated = text.length > TRUNCATE_LENGTH && !expanded;
  const displayText = isTruncated
    ? text.slice(0, TRUNCATE_LENGTH).trimEnd() + "..."
    : text;

  const attribution = isSent
    ? `You${email.fromAddress ? ` (${email.fromAddress})` : ""}`
    : senderEmail;

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

  function handleBubbleClick() {
    if (isUnread) {
      onMarkRead(email);
    }
  }

  return (
    <div
      className={`flex ${isSent ? "justify-end" : "justify-start"} px-4 py-1.5`}
    >
      <div
        className={`group relative max-w-[75%] rounded-xl px-4 py-2.5 ${
          isSent
            ? "bg-accent/20 text-text-primary"
            : isUnread
              ? "bg-card border border-accent/30 text-text-primary"
              : "bg-card text-text-primary"
        }`}
        onClick={handleBubbleClick}
      >
        {/* Attribution + time */}
        <div className="mb-1 flex items-center gap-2">
          <span
            className={`text-[11px] ${isUnread ? "font-semibold text-accent" : "text-text-tertiary"}`}
          >
            {attribution}
          </span>
          <span className="text-[10px] text-text-tertiary">
            {dateStr} {timeStr}
          </span>
          {isUnread && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
        </div>

        {/* Subject */}
        {email.subject && (
          <p
            className={`mb-1 text-xs ${isUnread ? "font-semibold" : "font-medium"} text-text-primary`}
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
          <div className="mt-2 flex flex-wrap gap-1.5">
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

        {/* Expand icon (full HTML preview) */}
        {email.bodyHtml && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpenHtml(email);
            }}
            className="absolute right-2 top-2 rounded p-1 text-text-tertiary opacity-0 transition-opacity hover:bg-hover hover:text-text-secondary group-hover:opacity-100"
            title="View full email"
          >
            <Maximize2 size={14} />
          </button>
        )}

        {/* Reply button for received emails */}
        {email.type === "received" && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onReply(email.id);
            }}
            className="mt-2 text-[11px] text-text-tertiary hover:text-text-secondary"
          >
            Reply
          </button>
        )}
      </div>
    </div>
  );
}
