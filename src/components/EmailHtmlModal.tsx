import { sanitizeEmailHtml } from "@/lib/sanitize-html";
import { Paperclip } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Email } from "@/lib/api";

interface EmailHtmlModalProps {
  email: Email | null;
  open: boolean;
  onClose: () => void;
}

export default function EmailHtmlModal({
  email,
  open,
  onClose,
}: EmailHtmlModalProps) {
  if (!email) return null;

  const downloadableAttachments = (email.attachments ?? []).filter(
    (att) => !att.contentId,
  );

  const senderLabel =
    email.type === "sent"
      ? `You → ${email.toAddress}`
      : (email.fromAddress ?? email.recipient ?? "Unknown");

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-hidden border-border bg-white ring-1 ring-gray-200 p-0 text-text-primary">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle className="text-sm text-text-primary">
            {email.subject || "(no subject)"}
          </DialogTitle>
          <p className="text-xs text-text-secondary">{senderLabel}</p>
          <p className="text-[11px] text-text-tertiary">
            {new Date(email.timestamp * 1000).toLocaleString()}
          </p>
        </DialogHeader>
        {downloadableAttachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-b border-border px-6 py-3">
            {downloadableAttachments.map((att) => (
              <a
                key={att.id}
                href={`/api/attachments/${att.id}`}
                className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-muted"
              >
                <Paperclip size={10} />
                {att.filename}
              </a>
            ))}
          </div>
        )}
        <div
          className="overflow-auto"
          style={{ maxHeight: "calc(90vh - 120px)" }}
        >
          {email.bodyHtml ? (
            <div
              className="prose prose-sm max-w-none bg-white p-6 text-black"
              dangerouslySetInnerHTML={{
                __html: sanitizeEmailHtml(email.bodyHtml),
              }}
            />
          ) : (
            <pre className="whitespace-pre-wrap bg-white p-6 text-sm text-black">
              {email.bodyText || "(empty)"}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
