import { useState, useRef, useEffect } from "react";
import { Maximize2 } from "lucide-react";
import { replyToEmail, sendEmail } from "@/lib/api";
import { dispatchEmailSent } from "@/lib/email-events";
import AttachmentPicker from "@/components/AttachmentPicker";
import AttachmentChips from "@/components/AttachmentChips";

const ATTACHMENT_CAP_BYTES = 25 * 1024 * 1024;

interface ChatQuickReplyProps {
  inboxAddress: string; // From address, fixed to this section's inbox
  latestReceivedEmailId: string | null; // What we reply to; if null, send as new email
  personEmail: string; // Recipient address when no reply target exists
  onSent: () => void; // Refetch + scroll
  /**
   * Optional handoff to the global compose drawer. When provided, the
   * reply box renders an "open in compose" affordance — for replies
   * that need the full editor (different sender identity, CC a
   * teammate, attachments, custom subject).
   */
  onOpenCompose?: () => void;
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
  personEmail,
  onSent,
  onOpenCompose,
}: ChatQuickReplyProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const totalAttachmentBytes = files.reduce((s, f) => s + f.size, 0);
  const overCap = totalAttachmentBytes > ATTACHMENT_CAP_BYTES;

  // Auto-grow: set height to scrollHeight, clamped to ~6 lines (~ 132px).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    const max = 132;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [text]);

  const canSend = text.trim().length > 0 && !sending && !overCap;

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      if (latestReceivedEmailId) {
        await replyToEmail(latestReceivedEmailId, {
          bodyHtml: plainTextToHtml(text),
          bodyText: text,
          fromAddress: inboxAddress,
          ...(files.length > 0
            ? { files: files.map((file) => ({ file })) }
            : {}),
        });
      } else {
        await sendEmail({
          to: personEmail,
          fromAddress: inboxAddress,
          subject: "(no subject)",
          bodyHtml: plainTextToHtml(text),
          bodyText: text,
          ...(files.length > 0
            ? { files: files.map((file) => ({ file })) }
            : {}),
        });
      }
      dispatchEmailSent({
        fromAddress: inboxAddress,
        to: personEmail,
        origin: "chat-quick-reply",
      });
      setText("");
      setFiles([]);
      onSent();
    } catch (e) {
      setError("Failed to send message");
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
    <div className="border-t border-border bg-card px-4 py-3 sm:px-6">
      {files.length > 0 && (
        <div className="mb-2">
          <AttachmentChips
            files={files}
            capBytes={ATTACHMENT_CAP_BYTES}
            onRemove={(idx) =>
              setFiles((prev) => prev.filter((_, i) => i !== idx))
            }
          />
        </div>
      )}
      <div className="flex items-end gap-2 rounded-[10px] bg-bg-subtle/60 p-2 ring-1 ring-border focus-within:ring-2 focus-within:ring-text-primary/15">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={
            latestReceivedEmailId ? "Type a reply…" : "Type a message…"
          }
          className="flex-1 resize-none border-0 bg-transparent px-2 py-1.5 text-sm text-text-primary outline-none placeholder:text-text-tertiary disabled:text-text-tertiary"
        />
        <AttachmentPicker
          onFilesAdded={(added) => setFiles((prev) => [...prev, ...added])}
        />
        {onOpenCompose && (
          <button
            type="button"
            onClick={onOpenCompose}
            title="Open in full compose (change sender, add CC, attachments…)"
            aria-label="Open in full compose"
            className="shrink-0 rounded-[8px] p-2 text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
          >
            <Maximize2 size={14} />
          </button>
        )}
        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          className="shrink-0 rounded-[8px] bg-text-primary px-3.5 py-2 text-xs font-medium text-white shadow-sm transition-colors hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        {error ? (
          <span className="text-xs text-destructive">{error}</span>
        ) : (
          <span className="text-[11px] font-light text-text-tertiary">
            Sending from <span className="font-medium">{inboxAddress}</span> ·
            ⌘/Ctrl + Enter to send
            {onOpenCompose && (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={onOpenCompose}
                  className="font-medium text-text-secondary underline-offset-2 hover:text-text-primary hover:underline"
                >
                  open in compose
                </button>
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
