import { ArrowLeft, FileText, Trash2 } from "lucide-react";
import type { DraftListItem } from "@/lib/api";

function compactTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

interface MailDraftListProps {
  visible: boolean;
  drafts: DraftListItem[];
  loading: boolean;
  onBackToFolders: () => void;
  onOpenDraft: (draft: DraftListItem) => void;
  onDeleteDraft: (draft: DraftListItem) => void;
}

export default function MailDraftList({
  visible,
  drafts,
  loading,
  onBackToFolders,
  onOpenDraft,
  onDeleteDraft,
}: MailDraftListProps) {
  return (
    <section
      className={`${visible ? "flex" : "hidden"} min-w-0 flex-1 flex-col border-r border-border md:flex`}
    >
      <div className="flex items-center gap-2 border-b border-border p-3">
        <button
          type="button"
          onClick={onBackToFolders}
          className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1 text-xs text-text-secondary hover:bg-bg-muted md:hidden"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Folders
        </button>
        <h1 className="text-sm font-semibold text-text-primary">Drafts</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <p className="p-4 text-sm text-text-tertiary">Loading drafts…</p>
        ) : drafts.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            <FileText className="h-6 w-6 text-text-tertiary" />
            <p className="text-sm text-text-tertiary">No drafts here.</p>
          </div>
        ) : (
          drafts.map((draft) => (
            <div
              key={draft.id}
              data-testid="mail-draft-row"
              data-draft-context={draft.contextKey}
              className="flex items-start gap-2 border-b border-border px-3 py-3 hover:bg-bg-subtle"
            >
              <button
                type="button"
                onClick={() => onOpenDraft(draft)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-primary">
                    {draft.toAddress
                      ? `To: ${draft.toAddress}`
                      : "No recipient"}
                  </span>
                  <time className="shrink-0 text-[10px] text-text-tertiary">
                    {compactTime(draft.updatedAt)}
                  </time>
                </div>
                <p className="mt-1 truncate text-sm text-text-primary">
                  {draft.subject || "(no subject)"}
                </p>
              </button>
              <button
                type="button"
                aria-label={`Delete draft ${draft.subject || "(no subject)"}`}
                data-testid="mail-delete-draft"
                onClick={() => onDeleteDraft(draft)}
                className="rounded p-1 text-text-tertiary hover:bg-bg-muted hover:text-text-primary"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
