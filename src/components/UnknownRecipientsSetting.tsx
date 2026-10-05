import { useEffect, useState } from "react";
import {
  fetchAdminSettings,
  fetchUnknownRecipients,
  updateAdminSettings,
} from "@/lib/api";

type AtRisk = { address: string; count: number }[];

/** Inboxes (admins): refuse mail to addresses that aren't inboxes. */
export default function UnknownRecipientsSetting() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Addresses with recent mail that would start bouncing, awaiting a yes.
  const [atRisk, setAtRisk] = useState<AtRisk | null>(null);

  useEffect(() => {
    fetchAdminSettings()
      .then((settings) => setOn(settings.rejectUnknownRecipients))
      .catch(() => setError("Could not load this setting."));
  }, []);

  async function save(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const settings = await updateAdminSettings({
        rejectUnknownRecipients: next,
      });
      setOn(settings.rejectUnknownRecipients);
      setAtRisk(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this setting.");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(next: boolean) {
    if (!next) return save(false);
    // Turning it on: say first which addresses that get mail would bounce.
    setBusy(true);
    setError(null);
    try {
      const { addresses } = await fetchUnknownRecipients();
      if (addresses.length > 0) {
        setAtRisk(addresses);
        return;
      }
    } catch {
      setError("Could not check which addresses would be refused.");
      return;
    } finally {
      setBusy(false);
    }
    await save(true);
  }

  return (
    <section className="mt-8 max-w-3xl rounded-[8px] bg-card p-5 ring-1 ring-border">
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={on === true}
          disabled={on === null || busy || atRisk !== null}
          onChange={(event) => void toggle(event.target.checked)}
          aria-describedby="unknown-recipients-hint"
        />
        <span className="text-sm font-medium text-text-primary">
          Reject mail to addresses that aren&apos;t inboxes
        </span>
      </label>
      <p
        id="unknown-recipients-hint"
        className="mt-1 pl-7 text-xs font-light text-text-secondary"
      >
        The sending server is told &quot;No such mailbox&quot; and nothing is
        stored. An inbox is an address with a sender identity or assigned
        members. Off, mail to any address under your routed domains is stored
        (catch-all).
      </p>
      {atRisk && (
        <div
          role="alertdialog"
          aria-labelledby="unknown-recipients-risk"
          className="mt-4 rounded-[6px] border border-warning-border bg-warning-bg p-3 text-xs text-warning-text"
        >
          <p id="unknown-recipients-risk" className="font-medium">
            These addresses received mail in the last 30 days and would start
            bouncing:
          </p>
          <ul
            className="mt-2 space-y-0.5"
            data-testid="unknown-recipients-list"
          >
            {atRisk.map((row) => (
              <li key={row.address}>
                {row.address}{" "}
                <span className="text-text-tertiary">
                  ({row.count} {row.count === 1 ? "message" : "messages"})
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2">
            To keep one, give it a sender identity or assign members to it
            above.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void save(true)}
              disabled={busy}
              className="rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-text-primary/90 disabled:opacity-60"
            >
              Turn on anyway
            </button>
            <button
              type="button"
              onClick={() => setAtRisk(null)}
              disabled={busy}
              className="rounded-[6px] border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
