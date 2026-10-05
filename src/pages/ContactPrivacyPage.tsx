import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { eraseContact, exportContact, type ContactExport } from "@/lib/api";
import PageHeader, { PageContainer } from "@/components/PageHeader";

function formatDate(ts: number | null): string {
  return ts ? new Date(ts * 1000).toLocaleString() : "—";
}

/**
 * Subject-access and erasure for newsletter data.
 *
 * Deliberately a lookup rather than a browsable list: this page exists to
 * answer a request about one named person, and a searchable roster of every
 * subscriber's history is a bigger surface than the job needs.
 */
export default function ContactPrivacyPage() {
  const [email, setEmail] = useState("");
  const [record, setRecord] = useState<ContactExport | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    setRecord(null);
    try {
      setRecord(await exportContact(email.trim()));
    } catch {
      setStatus("Nothing is held for that address.");
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!record) return;
    const blob = new Blob([JSON.stringify(record, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${record.email}-newsletter-data.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleErase() {
    if (!record) return;
    if (
      !confirm(
        `Erase ${record.email}? The address is replaced with a one-way pseudonym everywhere it appears. The delivery and consent rows themselves are kept — they are the evidence that a suppression or a consent happened — and this cannot be reversed.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const result = await eraseContact(record.email);
      setStatus(
        `Erased. Rewrote ${result.contacts} contact, ${result.memberships} membership, ${result.events} event and ${result.recipients} delivery rows; deleted ${result.attempts} signup attempts.`,
      );
      setRecord(null);
      setEmail("");
    } catch {
      setStatus("Could not erase that address.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="Contact data"
        subtitle="Answer a subject-access request, or erase an address from the newsletter tables."
      />

      <div className="max-w-3xl space-y-5">
        <form onSubmit={handleLookup} className="flex items-end gap-2">
          <label className="flex-1">
            <span className="mb-1 block text-xs font-medium text-text-secondary">
              Email address
            </span>
            <input
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="subscriber@example.com"
              className="w-full rounded-[6px] border border-border bg-card px-3 py-2 text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="rounded-[8px] bg-text-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "Looking up…" : "Look up"}
          </button>
        </form>

        {status && <p className="text-xs text-text-secondary">{status}</p>}

        {record && (
          <div className="space-y-4">
            <div className="rounded-[8px] bg-card p-4 ring-1 ring-border">
              <p className="text-sm font-medium text-text-primary">
                {record.email}
              </p>
              <p className="mt-1 text-xs text-text-tertiary">
                {record.contact
                  ? `Contact since ${formatDate(record.contact.createdAt)}`
                  : "No contact row — memberships only"}{" "}
                · {record.memberships.length} membership
                {record.memberships.length === 1 ? "" : "s"} ·{" "}
                {record.events.length} engagement event
                {record.events.length === 1 ? "" : "s"}
              </p>
            </div>

            {record.memberships.length > 0 && (
              <div className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
                <table className="w-full text-sm">
                  <thead className="bg-bg-muted/50 text-left text-[11px] uppercase tracking-wide text-text-tertiary">
                    <tr>
                      <th className="px-4 py-2 font-medium">List</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium">Consent</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {record.memberships.map((m) => (
                      <tr key={m.id}>
                        <td className="px-4 py-2.5 text-text-primary">
                          {m.listName ?? m.listId}
                        </td>
                        <td className="px-4 py-2.5 text-text-secondary">
                          {m.status}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-text-tertiary">
                          {m.consentSource} · {formatDate(m.consentAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                onClick={download}
                className="rounded-[6px] px-3 py-2 text-xs font-medium text-text-secondary ring-1 ring-border hover:bg-bg-muted"
              >
                Download JSON
              </button>
              <button
                onClick={handleErase}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-[6px] px-3 py-2 text-xs font-medium text-red-600 ring-1 ring-border hover:bg-red-500/5 disabled:opacity-50"
              >
                <ShieldAlert size={12} />
                Erase this address
              </button>
            </div>
          </div>
        )}
      </div>
    </PageContainer>
  );
}
