import { Send, Inbox as InboxIcon, AlertTriangle, Clock } from "lucide-react";
import { sanitizeEmailHtml } from "@/lib/sanitize-html";
import type { Email } from "@/lib/api";
import { cn } from "@/lib/utils";

interface ThreadMessageProps {
  email: Email;
  /** Slightly de-emphasize this message — used for older context items. */
  muted?: boolean;
  /** Use the card surface for the focal message in a thread. */
  highlight?: boolean;
}

/**
 * Compact summary card for a single message inside a thread context
 * panel — used by ReplyComposer's "Replying to" panel and by
 * EmailHtmlModal's "Show earlier in thread" expansion. The body
 * renders sanitized HTML when present, otherwise the plain-text
 * fallback.
 */
export default function ThreadMessage({
  email,
  muted,
  highlight,
}: ThreadMessageProps) {
  const isSent = email.type === "sent";
  const failedToSend = isSent && email.status === "failed";
  const retrying = isSent && email.status === "retrying";
  const sender = isSent
    ? `you (${email.fromAddress ?? "—"})`
    : (email.fromAddress ?? "Unknown");
  const recipient = isSent ? email.toAddress : email.recipient;
  const ts = new Date(email.timestamp * 1000);
  const fullStamp = `${ts.toLocaleDateString([], { month: "short", day: "numeric" })} · ${ts.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;

  return (
    <div
      className={cn(
        "px-4 py-3",
        highlight ? "bg-card" : "bg-transparent",
        muted && "opacity-90",
      )}
    >
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px]">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider",
            failedToSend
              ? "bg-red-500/10 text-red-500"
              : retrying
                ? "bg-amber-500/10 text-amber-600"
                : isSent
                  ? "bg-bg-muted text-text-secondary"
                  : "bg-violet/10 text-violet",
          )}
          data-testid={retrying ? "message-retrying-badge" : undefined}
          title={
            retrying
              ? "The email provider rejected this send; it will be retried automatically. See the Outbox for details."
              : undefined
          }
          style={!isSent ? { color: "#7c5cfc" } : undefined}
        >
          {failedToSend ? (
            <>
              <AlertTriangle size={9} />
              Failed to send
            </>
          ) : retrying ? (
            <>
              <Clock size={9} />
              Retrying
            </>
          ) : isSent ? (
            <>
              <Send size={9} />
              Sent
            </>
          ) : (
            <>
              <InboxIcon size={9} />
              Received
            </>
          )}
        </span>
        <span className="truncate font-medium text-text-primary">{sender}</span>
        {recipient && (
          <span className="truncate text-text-tertiary">→ {recipient}</span>
        )}
        <span className="ml-auto shrink-0 text-text-tertiary">{fullStamp}</span>
      </div>
      {email.bodyHtml ? (
        <div
          className={cn(
            "prose prose-sm max-w-none text-[13px] leading-relaxed [&_p]:my-1.5",
            highlight ? "text-text-primary" : "text-text-secondary",
          )}
          dangerouslySetInnerHTML={{
            __html: sanitizeEmailHtml(email.bodyHtml),
          }}
        />
      ) : (
        <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-text-secondary">
          {email.bodyText || "(no text)"}
        </pre>
      )}
    </div>
  );
}
