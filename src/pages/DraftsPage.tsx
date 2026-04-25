import { useState, useEffect } from "react";
import { fetchDrafts, sendDraft, deleteDraft, type Draft } from "@/lib/api";
import { sanitizeHtml } from "@/lib/sanitize-html";

export default function DraftsPage() {
  const [draftList, setDraftList] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  useEffect(() => {
    fetchDrafts()
      .then(setDraftList)
      .finally(() => setLoading(false));
  }, []);

  function formatTs(ts: number) {
    return new Date(ts * 1000).toLocaleString();
  }

  async function handleSend(id: string) {
    if (!confirm("Send this draft?")) return;
    setSendingId(id);
    try {
      await sendDraft(id);
      setDraftList((prev) => prev.filter((d) => d.id !== id));
    } catch {
      alert("Failed to send draft.");
    } finally {
      setSendingId(null);
    }
  }

  async function handleDiscard(id: string) {
    if (!confirm("Discard this draft?")) return;
    await deleteDraft(id);
    setDraftList((prev) => prev.filter((d) => d.id !== id));
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-6 text-sm font-semibold text-text-primary">Drafts</h1>

        {loading ? (
          <p className="text-xs text-text-tertiary">Loading...</p>
        ) : draftList.length === 0 ? (
          <p className="text-xs text-text-tertiary">
            No pending drafts. Agents with "Draft only" mode will place replies
            here for review.
          </p>
        ) : (
          <div className="space-y-2">
            {draftList.map((d) => (
              <div
                key={d.id}
                className="rounded-lg border border-border bg-white ring-1 ring-gray-200"
              >
                <div className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-xs font-medium text-text-primary">
                      {d.toAddress}
                    </p>
                    <p className="text-[11px] text-text-tertiary">
                      {d.subject} &middot; {d.fromAddress} &middot;{" "}
                      {formatTs(d.createdAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() =>
                        setPreviewId(previewId === d.id ? null : d.id)
                      }
                      className="rounded-md px-2.5 py-1 text-[11px] text-text-secondary hover:bg-bg-muted"
                    >
                      {previewId === d.id ? "Hide" : "Preview"}
                    </button>
                    <button
                      disabled={sendingId === d.id}
                      onClick={() => handleSend(d.id)}
                      className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                    >
                      {sendingId === d.id ? "Sending…" : "Send"}
                    </button>
                    <button
                      disabled={sendingId === d.id}
                      onClick={() => handleDiscard(d.id)}
                      className="rounded-md px-2.5 py-1 text-[11px] text-destructive hover:bg-bg-muted disabled:opacity-50"
                    >
                      Discard
                    </button>
                  </div>
                </div>
                {previewId === d.id && d.bodyHtml && (
                  <div
                    className="border-t border-border px-4 py-3 text-xs"
                    dangerouslySetInnerHTML={{
                      __html: sanitizeHtml(d.bodyHtml),
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
