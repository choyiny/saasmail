import { useState, useEffect } from "react";
import {
  fetchStats,
  fetchSenderIdentities,
  upsertSenderIdentity,
  deleteSenderIdentity,
} from "@/lib/api";
import type { SenderIdentity } from "@/lib/api";

interface IdentityRow {
  email: string;
  displayName: string;
  saved: boolean;
  saving: boolean;
  feedback: string | null;
}

export default function SenderIdentitiesSettings() {
  const [rows, setRows] = useState<IdentityRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([fetchStats(), fetchSenderIdentities()])
      .then(([stats, identities]) => {
        const identityMap = new Map<string, SenderIdentity>();
        for (const id of identities) {
          identityMap.set(id.email, id);
        }

        setRows(
          stats.recipients.map((email) => {
            const existing = identityMap.get(email);
            return {
              email,
              displayName: existing?.displayName ?? "",
              saved: !!existing,
              saving: false,
              feedback: null,
            };
          }),
        );
      })
      .finally(() => setLoading(false));
  }, []);

  function updateRow(email: string, updates: Partial<IdentityRow>) {
    setRows((prev) =>
      prev.map((r) => (r.email === email ? { ...r, ...updates } : r)),
    );
  }

  async function handleSave(email: string, displayName: string) {
    if (!displayName.trim()) return;
    updateRow(email, { saving: true, feedback: null });
    try {
      await upsertSenderIdentity(email, displayName.trim());
      updateRow(email, {
        saving: false,
        saved: true,
        feedback: "Saved",
        displayName: displayName.trim(),
      });
      setTimeout(() => updateRow(email, { feedback: null }), 2000);
    } catch {
      updateRow(email, { saving: false, feedback: "Error saving" });
    }
  }

  async function handleClear(email: string) {
    updateRow(email, { saving: true, feedback: null });
    try {
      await deleteSenderIdentity(email);
      updateRow(email, {
        saving: false,
        saved: false,
        displayName: "",
        feedback: "Cleared",
      });
      setTimeout(() => updateRow(email, { feedback: null }), 2000);
    } catch {
      updateRow(email, { saving: false, feedback: "Error clearing" });
    }
  }

  if (loading) {
    return <p className="text-xs text-text-tertiary">Loading...</p>;
  }

  if (rows.length === 0) {
    return (
      <p className="text-xs text-text-tertiary">
        No recipient addresses found.
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h2 className="mb-1 text-sm font-semibold text-text-primary">
        Sender Display Names
      </h2>
      <p className="mb-4 text-xs text-text-secondary">
        Set a display name for each email address. This name will appear as the
        "From" name when sending emails.
      </p>

      <div className="space-y-3">
        {rows.map((row) => (
          <div
            key={row.email}
            className="rounded-lg border border-border-dark bg-card px-4 py-3"
          >
            <p className="mb-2 text-xs font-medium text-text-primary">
              {row.email}
            </p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={row.displayName}
                onChange={(e) =>
                  updateRow(row.email, { displayName: e.target.value })
                }
                placeholder="Display name"
                className="h-8 flex-1 rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <button
                onClick={() => handleSave(row.email, row.displayName)}
                disabled={row.saving || !row.displayName.trim()}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                Save
              </button>
              {row.saved && (
                <button
                  onClick={() => handleClear(row.email)}
                  disabled={row.saving}
                  className="rounded-md border border-border-dark px-3 py-1.5 text-xs text-text-secondary hover:bg-hover hover:text-text-primary disabled:opacity-50"
                >
                  Clear
                </button>
              )}
            </div>
            {row.feedback && (
              <p
                className={`mt-1.5 text-[11px] ${
                  row.feedback.startsWith("Error")
                    ? "text-destructive"
                    : "text-text-tertiary"
                }`}
              >
                {row.feedback}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
