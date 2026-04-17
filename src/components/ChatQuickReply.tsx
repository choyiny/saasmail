import { useState, useRef, useEffect } from "react";
import { replyToEmail } from "@/lib/api";

interface ChatQuickReplyProps {
  inboxAddress: string; // From address, fixed to this section's inbox
  latestReceivedEmailId: string | null; // What we reply to
  onSent: () => void; // Refetch + scroll
}

// Wrap user-entered plain text into the minimal HTML the existing reply route
// requires (it 400s without bodyHtml or templateSlug).
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function plainTextToHtml(text: string): string {
  const lines = text.split(/\r?\n/);
  return lines
    .map((line) =>
      line.length === 0 ? "<p>&nbsp;</p>" : `<p>${escapeHtml(line)}</p>`,
    )
    .join("");
}

export default function ChatQuickReply({
  inboxAddress,
  latestReceivedEmailId,
  onSent,
}: ChatQuickReplyProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow: set height to scrollHeight, clamped to ~6 lines (~ 132px).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    const max = 132;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [text]);

  const canSend = text.trim().length > 0 && !sending && !!latestReceivedEmailId;

  async function handleSend() {
    if (!canSend || !latestReceivedEmailId) return;
    setSending(true);
    setError(null);
    try {
      await replyToEmail(latestReceivedEmailId, {
        bodyHtml: plainTextToHtml(text),
        bodyText: text,
        fromAddress: inboxAddress,
      });
      setText("");
      onSent();
    } catch (e) {
      setError("Failed to send reply");
      console.error(e);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter inserts a newline (default). Cmd/Ctrl+Enter sends.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="border-t border-border bg-white px-4 py-2">
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={
            latestReceivedEmailId
              ? "Type a reply…"
              : "Waiting for a message to reply to."
          }
          disabled={!latestReceivedEmailId}
          className="flex-1 resize-none rounded-md border border-border bg-white px-2 py-1.5 text-xs text-text-primary outline-none focus:ring-1 focus:ring-accent disabled:bg-bg-muted disabled:text-text-tertiary"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
      <div className="mt-1 flex items-center justify-between">
        {error ? (
          <span className="text-xs text-destructive">{error}</span>
        ) : (
          <span className="text-[11px] text-text-tertiary">
            Plain text · sent from {inboxAddress} · ⌘/Ctrl+Enter to send
          </span>
        )}
      </div>
    </div>
  );
}
