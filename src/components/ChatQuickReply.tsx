import { beginSend, finishSend, sendKeyProblem } from "@/lib/send-key";
import { useState, useRef, useEffect } from "react";
import { Maximize2 } from "lucide-react";
import {
  replyToEmail,
  sendEmail,
  fetchDraft,
  deleteDraft,
  saveDraft,
  type CcEntry,
} from "@/lib/api";
import { sendWithUndo } from "@/lib/undo-send";
import { useCommonSettings } from "@/lib/default-layout-settings";
import { showToast } from "@/lib/toast";
import { dispatchEmailSent } from "@/lib/email-events";
import { serverErrorMessage } from "@/lib/error-message";
import AttachmentPicker from "@/components/AttachmentPicker";
import SendingPausedNotice from "@/components/SendingPausedNotice";
import AttachmentChips from "@/components/AttachmentChips";
import ReplyToHint from "@/components/ReplyToHint";

const ATTACHMENT_CAP_BYTES = 25 * 1024 * 1024;

interface ChatQuickReplyProps {
  inboxAddress: string; // From address, fixed to this section's inbox
  latestReceivedEmailId: string | null; // What we reply to; if null, send as new email
  personEmail: string; // Recipient address when no reply target exists
  /**
   * CC list to carry over from the original message — chat bubbles
   * default to "reply-all" semantics so group conversations stay
   * group conversations. Should already be filtered to exclude this
   * section's own inbox address. Ignored when there's no reply target.
   */
  replyCc?: CcEntry[];
  /**
   * Every address a reply to the target reaches when it follows its Reply-To
   * (the first is To, the others are copied); empty when replies simply go to
   * the sender. The reply follows it unless the user chooses the sender.
   */
  replyRecipients?: CcEntry[];
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

// Flatten a draft's HTML body to the plain text this textarea holds. Mirrors
// the DOMParser approach used elsewhere for chat bubbles.
function htmlToPlainText(html: string): string {
  return (
    new DOMParser().parseFromString(html, "text/html").body.textContent ?? ""
  );
}

export default function ChatQuickReply({
  inboxAddress,
  latestReceivedEmailId,
  personEmail,
  replyCc,
  replyRecipients = [],
  onSent,
  onOpenCompose,
}: ChatQuickReplyProps) {
  const [text, setText] = useState("");
  const [replyToSender, setReplyToSender] = useState(false);
  // The choice belongs to one reply target; a new message starts over.
  useEffect(() => {
    setReplyToSender(false);
  }, [latestReceivedEmailId]);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // Which reply target we've already restored a saved draft for, so we fetch
  // once per email and never clobber text the user is typing.
  const restoredForRef = useRef<string | null>(null);
  const [{ undoSendSeconds }] = useCommonSettings();
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Surface a saved reply draft (e.g. one a WebMCP agent drafted, or a reply
  // the user started in the full composer) so it's visible right here instead
  // of only in the full editor.
  useEffect(() => {
    const id = latestReceivedEmailId;
    if (!id || restoredForRef.current === id) return;
    restoredForRef.current = id;
    let cancelled = false;
    fetchDraft(`reply:${id}`)
      .then((draft) => {
        if (cancelled || !draft) return;
        const restored =
          draft.bodyText ?? htmlToPlainText(draft.bodyHtml ?? "");
        if (!restored.trim()) return;
        // Don't overwrite anything the user has already started typing.
        setText((cur) => (cur.trim().length > 0 ? cur : restored));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [latestReceivedEmailId]);

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

  // The box clears as soon as a message is sent, so a new one can be
  // written (and sent) while the last is still in its undo window.
  const canSend = text.trim().length > 0 && !overCap;
  const followsReplyTo = replyRecipients.length > 0 && !replyToSender;

  // One key per message typed here: every attempt sends it, a sent message
  // forgets it. A reply shares its key with the full reply composer for the
  // same message, so retrying there after a lost answer is still recognised.
  const sendContext = latestReceivedEmailId
    ? `send:reply:${latestReceivedEmailId}`
    : `send:quick:${inboxAddress}:${personEmail}`;

  function handleSend() {
    if (!canSend) return;
    setError(null);
    const sentText = text;
    const sentFiles = files;
    const replyId = latestReceivedEmailId;
    const filesPayload =
      sentFiles.length > 0
        ? { files: sentFiles.map((file) => ({ file })) }
        : {};
    // Pressing Send freezes the message and claims its key; the pending
    // send owns the key until it goes out or is undone.
    const context = sendContext;
    const idempotencyKey = beginSend(context);
    const recipient = followsReplyTo ? "reply_to" : "sender";
    const send = async () => {
      if (replyId) {
        // Default to reply-all semantics for the chat bubble: carry the
        // original CC roster (already filtered by the parent to exclude
        // our own inbox) so group conversations don't silently collapse
        // to a 1:1. Users who want plain "reply" open the full composer.
        await replyToEmail(replyId, {
          bodyHtml: plainTextToHtml(sentText),
          bodyText: sentText,
          fromAddress: inboxAddress,
          ...(replyCc && replyCc.length > 0 ? { cc: replyCc } : {}),
          ...filesPayload,
          // Always the target this box showed: with no hint on screen the
          // reply goes to the sender, never to a Reply-To the user didn't see.
          recipient,
          idempotencyKey,
        });
      } else {
        await sendEmail({
          to: personEmail,
          fromAddress: inboxAddress,
          subject: "(no subject)",
          bodyHtml: plainTextToHtml(sentText),
          bodyText: sentText,
          ...filesPayload,
          idempotencyKey,
        });
      }
    };
    // Put the message back in the box (Undo, or a failed send). If the user
    // has typed something new meanwhile, keep both.
    const restore = () => {
      setText((cur) => (cur.trim() ? `${sentText}\n${cur}` : sentText));
      setFiles((cur) => [...sentFiles, ...cur]);
    };

    // The box clears at once; the message waits out the undo window.
    setText("");
    setFiles([]);
    sendWithUndo({
      seconds: undoSendSeconds,
      label: "Sending…",
      send,
      onUndo: () => {
        finishSend(context, idempotencyKey, "undone");
        if (mountedRef.current) {
          restore();
          requestAnimationFrame(() => ref.current?.focus());
        } else if (replyId) {
          // The conversation was closed meanwhile: keep it as a draft.
          saveDraft({
            contextKey: `reply:${replyId}`,
            fromAddress: inboxAddress,
            bodyHtml: plainTextToHtml(sentText),
            bodyText: sentText,
            replyToEmailId: replyId,
          })
            .then(() =>
              showToast({
                kind: "info",
                message: "Reply not sent",
                description: "It's saved as a draft on that conversation.",
              }),
            )
            .catch(() => {});
        }
      },
      onSent: () => {
        finishSend(context, idempotencyKey, "sent");
        // The reply went out — discard any saved draft for it so it doesn't
        // reappear in this box (or the Drafts filter) next time.
        if (replyId) {
          restoredForRef.current = replyId;
          deleteDraft(`reply:${replyId}`).catch(() => {});
        }
        dispatchEmailSent({
          fromAddress: inboxAddress,
          to: personEmail,
          origin: "chat-quick-reply",
        });
        if (!mountedRef.current) return;
        onSent();
      },
      onError: (e) => {
        // The message goes back to the box with the same key, so sending it
        // again cannot send it twice.
        finishSend(context, idempotencyKey, "failed");
        const keyProblem = sendKeyProblem(e, context);
        console.error(e);
        if (!mountedRef.current) return;
        restore();
        // Prefer what the server said — a Gmail reply it refused was *not*
        // queued and has to be sent again, which the generic string hides.
        setError(
          keyProblem ?? serverErrorMessage(e) ?? "Failed to send message",
        );
      },
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter inserts a newline (default). Cmd/Ctrl+Enter sends.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div
      className="border-t border-border bg-card px-3 pt-3 sm:px-5"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      {latestReceivedEmailId && replyRecipients.length > 0 && (
        <ReplyToHint
          recipients={replyRecipients}
          toSender={replyToSender}
          onToggle={setReplyToSender}
          className="mb-2"
        />
      )}
      <SendingPausedNotice className="mb-2" />
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
      <div className="flex items-end gap-1 rounded-xl border border-border-strong bg-card p-1.5 shadow-card transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/15">
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
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
          >
            <Maximize2 size={14} />
          </button>
        )}
        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          className="inline-flex h-8 shrink-0 items-center rounded-lg bg-accent px-3.5 text-[13px] font-medium text-accent-foreground shadow-card transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send
        </button>
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        {error ? (
          <span className="text-xs text-destructive">{error}</span>
        ) : (
          <span className="text-xs text-text-tertiary">
            Sending from <span className="font-medium">{inboxAddress}</span>
            {/* No keyboard on touch screens: skip the shortcut hint. */}
            <span className="[@media(hover:none)]:hidden">
              {" · "}⌘/Ctrl + Enter to send
            </span>
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
