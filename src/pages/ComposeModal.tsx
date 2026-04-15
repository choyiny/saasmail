import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const isReply = replyToEmailId !== null;

  useEffect(() => {
    if (!open) {
      setTo("");
      setSubject("");
      setBody("");
      setError("");
      return;
    }
    if (replyToEmailId) {
      fetchEmail(replyToEmailId).then((email) => {
        setSubject(
          email.subject?.startsWith("Re: ")
            ? email.subject
            : `Re: ${email.subject || ""}`
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
        await replyToEmail(replyToEmailId!, {
          bodyHtml: `<p>${body.replace(/\n/g, "<br/>")}</p>`,
          bodyText: body,
        });
      } else {
        await sendEmail({
          to,
          subject,
          bodyHtml: `<p>${body.replace(/\n/g, "<br/>")}</p>`,
          bodyText: body,
        });
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isReply ? "Reply" : "Compose"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSend} className="space-y-4">
          {!isReply && (
            <div className="space-y-2">
              <Label htmlFor="to">To</Label>
              <Input
                id="to"
                type="email"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                required
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="subject">Subject</Label>
            <Input
              id="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              required={!isReply}
              disabled={isReply}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="body">Message</Label>
            <Textarea
              id="body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              required
            />
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={sending}>
              {sending ? "Sending..." : "Send"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
