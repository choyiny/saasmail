import { useEffect, useState } from "react";
import { Paperclip, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchJmapDraftPreview, type JmapDraftPreview } from "@/lib/api";
import { sanitizeEmailHtml } from "@/lib/sanitize-html";

function addressList(list: { email: string; name: string | null }[]): string {
  return list
    .map((entry) =>
      entry.name ? `${entry.name} <${entry.email}>` : entry.email,
    )
    .join(", ");
}

/**
 * A draft written in a mail client (JMAP), shown read-only: editing and
 * sending it stay in the mail client.
 */
export default function JmapDraftPreviewDialog({
  contextKey,
  subject,
  onClose,
  onDelete,
  onMissing,
}: {
  contextKey: string | null;
  /** The listed subject, shown while the draft loads. */
  subject?: string | null;
  onClose: () => void;
  onDelete: () => void;
  /** The draft is gone from the mail client (sent, deleted, trashed). */
  onMissing?: () => void;
}) {
  const [draft, setDraft] = useState<JmapDraftPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(null);
    setError(null);
    if (!contextKey) return;
    let cancelled = false;
    fetchJmapDraftPreview(contextKey)
      .then((result) => {
        if (!cancelled) setDraft(result);
      })
      .catch(() => {
        if (!cancelled) {
          setError("This draft is no longer available in your mail client.");
          onMissing?.();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [contextKey]);

  return (
    <Dialog
      open={contextKey !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <DialogContent className="max-w-2xl" data-testid="jmap-draft-preview">
        <DialogHeader>
          <DialogTitle>
            {(draft ? draft.subject : subject) || "(no subject)"}
          </DialogTitle>
          <DialogDescription>
            Written in a mail client. Edit or send it there; here it is
            read-only.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-text-tertiary">{error}</p>}
        {!draft && !error && (
          <p className="text-sm text-text-tertiary">Loading draft…</p>
        )}
        {draft && (
          <div className="space-y-3 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {draft.from && (
                <>
                  <dt className="text-text-tertiary">From</dt>
                  <dd>{addressList([draft.from])}</dd>
                </>
              )}
              <dt className="text-text-tertiary">To</dt>
              <dd>{addressList(draft.to) || "—"}</dd>
              {draft.cc.length > 0 && (
                <>
                  <dt className="text-text-tertiary">Cc</dt>
                  <dd>{addressList(draft.cc)}</dd>
                </>
              )}
              {draft.bcc.length > 0 && (
                <>
                  <dt className="text-text-tertiary">Bcc</dt>
                  <dd>{addressList(draft.bcc)}</dd>
                </>
              )}
            </dl>
            <div className="max-h-[50vh] overflow-y-auto rounded border border-border p-3">
              {draft.html ? (
                <div
                  className="prose prose-sm max-w-none"
                  data-testid="jmap-draft-preview-body"
                  // Sanitised: the HTML comes from a mail client.
                  dangerouslySetInnerHTML={{
                    __html: sanitizeEmailHtml(draft.html),
                  }}
                />
              ) : (
                <pre
                  className="whitespace-pre-wrap font-sans"
                  data-testid="jmap-draft-preview-body"
                >
                  {draft.text ?? ""}
                </pre>
              )}
            </div>
            {draft.attachments.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {draft.attachments.map((attachment, index) => (
                  <li
                    key={index}
                    className="inline-flex items-center gap-1 rounded-full bg-bg-muted px-2 py-0.5 text-xs text-text-secondary"
                  >
                    <Paperclip className="h-3 w-3" />
                    {attachment.name ?? attachment.type}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            data-testid="jmap-draft-preview-delete"
            onClick={onDelete}
            className="inline-flex items-center gap-1 rounded-[6px] px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-rose-50 hover:text-rose-600"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete draft
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-muted"
          >
            Close
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
