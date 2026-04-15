import DOMPurify from "dompurify";
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

  const senderLabel =
    email.type === "sent"
      ? `You → ${email.toAddress}`
      : (email.fromAddress ?? email.recipient ?? "Unknown");

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-hidden border-border-dark bg-card p-0 text-text-primary">
        <DialogHeader className="border-b border-border-dark px-6 py-4">
          <DialogTitle className="text-sm text-text-primary">
            {email.subject || "(no subject)"}
          </DialogTitle>
          <p className="text-xs text-text-secondary">{senderLabel}</p>
          <p className="text-[11px] text-text-tertiary">
            {new Date(email.timestamp * 1000).toLocaleString()}
          </p>
        </DialogHeader>
        <div
          className="overflow-auto"
          style={{ maxHeight: "calc(90vh - 120px)" }}
        >
          {email.bodyHtml ? (
            <div
              className="prose prose-sm max-w-none bg-white p-6 text-black"
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(email.bodyHtml, {
                  ADD_TAGS: ["style"],
                  ADD_ATTR: ["target"],
                }),
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
