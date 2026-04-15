import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import TiptapEditor from "@/components/TiptapEditor";
import { sendEmail, replyToEmail, fetchEmail } from "@/lib/api";

interface ComposeModalProps {
  open: boolean;
  onClose: () => void;
  replyToEmailId: string | null;
}

export default function ComposeModal({
  open,
  onClose,
  replyToEmailId,
}: ComposeModalProps) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const isReply = replyToEmailId !== null;

  useEffect(() => {
    if (!open) {
      setTo("");
      setSubject("");
      setBodyHtml("");
      setError("");
      return;
    }
    if (replyToEmailId) {
      fetchEmail(replyToEmailId).then((email) => {
        setSubject(
          email.subject?.startsWith("Re: ")
            ? email.subject
            : `Re: ${email.subject || ""}`,
        );
      });
    }
  }, [open, replyToEmailId]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError("");
    try {
      if (isReply) {
        await replyToEmail(replyToEmailId!, { bodyHtml });
      } else {
        await sendEmail({ to, subject, bodyHtml });
      }
      onClose();
    } catch {
      setError("Failed to send email");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="border-border-dark bg-card text-text-primary sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-text-primary">
            {isReply ? "Reply" : "Compose"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSend} className="space-y-3">
          {!isReply && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-text-secondary">
                To
              </label>
              <input
                type="email"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                required
                className="h-8 w-full rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
          )}
          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">
              Subject
            </label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              required={!isReply}
              disabled={isReply}
              className="h-8 w-full rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">
              Message
            </label>
            <TiptapEditor content={bodyHtml} onUpdate={setBodyHtml} />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-xs text-text-secondary hover:bg-hover hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={sending}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {sending ? "Sending..." : "Send"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
