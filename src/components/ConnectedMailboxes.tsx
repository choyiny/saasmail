import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Mail, Plus, RefreshCw, X } from "lucide-react";
import {
  disconnectGmailAccount,
  fetchGmailAccounts,
  gmailConnectUrl,
  type GmailAccount,
} from "@/lib/api";

/** How often the backend cron sweeps every connected mailbox. */
const SYNC_INTERVAL_LABEL = "every 15 minutes";

/**
 * "N minutes ago" for a past epoch-ms timestamp. Deliberately coarse — the
 * exact second is noise; what an admin wants is "is this mailbox stale?".
 */
function relativeTime(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 45) return "just now";
  const plural = (n: number, unit: string) =>
    `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return plural(hours, "hour");
  return plural(Math.round(hours / 24), "day");
}

/**
 * Admin section listing the Google mailboxes connected over OAuth, with
 * their sync health, plus connect/disconnect.
 *
 * Every piece of state here is invisible everywhere else in the product, so
 * it is stated plainly rather than reassuringly: a broken grant means the
 * mailbox has stopped syncing, and a history gap means mail is gone for good.
 */
export default function ConnectedMailboxes() {
  const [accounts, setAccounts] = useState<GmailAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Id of the account whose Disconnect is armed (inline confirm — a native
  // window.confirm blocks both jsdom and the browser automation).
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchGmailAccounts()
      .then((rows) => {
        if (!cancelled) setAccounts(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(
            err instanceof Error
              ? err.message
              : "Failed to load connected mailboxes",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleDisconnect(account: GmailAccount) {
    setDisconnectingId(account.id);
    setDisconnectError(null);
    try {
      await disconnectGmailAccount(account.id);
      setAccounts((prev) => prev.filter((a) => a.id !== account.id));
      setConfirmingId(null);
    } catch (err) {
      setDisconnectError(
        err instanceof Error
          ? err.message
          : `Couldn't disconnect ${account.emailAddress}.`,
      );
    } finally {
      setDisconnectingId(null);
    }
  }

  return (
    <section className="mb-6 space-y-3" data-testid="connected-mailboxes">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text-primary">
            Connected Google mailboxes
          </h2>
          <p className="mt-0.5 text-xs font-light text-text-tertiary">
            Mail is pulled from each connected mailbox {SYNC_INTERVAL_LABEL}, so
            a freshly connected mailbox can look idle for a quarter of an hour.
          </p>
        </div>
        <a
          href={gmailConnectUrl()}
          data-testid="gmail-connect-button"
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[6px] bg-text-primary px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-text-primary/90"
        >
          <Plus size={14} />
          Connect a Google mailbox
        </a>
      </div>

      {loading && (
        <p className="text-sm font-light text-text-tertiary">Loading…</p>
      )}

      {!loading && loadError && (
        <div
          data-testid="gmail-load-error"
          className="rounded-[8px] bg-card p-4 text-sm text-destructive ring-1 ring-border"
        >
          Couldn&apos;t load the connected mailboxes ({loadError}). This is not
          the same as having none connected — reload before changing anything.
        </div>
      )}

      {!loading && !loadError && accounts.length === 0 && (
        <div
          data-testid="gmail-empty-state"
          className="rounded-[8px] bg-card p-10 text-center ring-1 ring-border"
        >
          <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-violet/10">
            <Mail size={20} style={{ color: "#7c5cfc" }} />
          </span>
          <p className="mb-1 text-sm font-medium text-text-primary">
            No Google mailbox connected
          </p>
          <p className="mx-auto max-w-lg text-xs font-light text-text-tertiary">
            Connecting a mailbox lets saasmail read its new mail and send as
            that address. It does not backfill: mail already in Gmail is never
            pulled in, so the timeline starts empty and fills going forward.
          </p>
        </div>
      )}

      {!loading && !loadError && accounts.length > 0 && (
        <div className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
          {disconnectError && (
            <div className="border-b border-border px-4 py-2 text-xs text-destructive">
              {disconnectError}
            </div>
          )}
          <ul className="divide-y divide-border">
            {accounts.map((account) => {
              const confirming = confirmingId === account.id;
              const busy = disconnectingId === account.id;
              return (
                <li
                  key={account.id}
                  data-testid={`gmail-account-${account.id}`}
                  className="px-4 py-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-text-primary">
                        {account.emailAddress}
                      </div>
                      <div className="mt-0.5 text-xs font-light text-text-tertiary">
                        {account.lastSyncedAt === null
                          ? "Not synced yet — the first sync runs within 15 minutes."
                          : `Synced ${relativeTime(account.lastSyncedAt)}`}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {account.lastError && (
                        <a
                          href={gmailConnectUrl()}
                          data-testid={`gmail-reconnect-${account.id}`}
                          className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-border bg-card px-3 text-xs font-medium text-text-primary transition-colors hover:bg-black/[0.03]"
                        >
                          <RefreshCw size={12} />
                          Reconnect
                        </a>
                      )}
                      {confirming ? (
                        <>
                          <button
                            type="button"
                            onClick={() => handleDisconnect(account)}
                            disabled={busy}
                            data-testid={`gmail-confirm-disconnect-${account.id}`}
                            className="inline-flex h-8 items-center gap-1.5 rounded-[6px] bg-destructive px-3 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                          >
                            {busy && (
                              <Loader2 size={12} className="animate-spin" />
                            )}
                            Yes, disconnect
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmingId(null)}
                            disabled={busy}
                            data-testid={`gmail-cancel-disconnect-${account.id}`}
                            className="inline-flex h-8 items-center gap-1 rounded-[6px] px-2 text-xs font-medium text-text-tertiary transition-colors hover:bg-black/[0.03] hover:text-text-primary disabled:opacity-50"
                          >
                            <X size={12} />
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmingId(account.id)}
                          data-testid={`gmail-disconnect-${account.id}`}
                          className="inline-flex h-8 items-center rounded-[6px] border border-border bg-card px-3 text-xs font-medium text-text-primary transition-colors hover:bg-black/[0.03]"
                        >
                          Disconnect
                        </button>
                      )}
                    </div>
                  </div>

                  {confirming && (
                    <p className="mt-2 text-xs font-light text-text-tertiary">
                      Disconnecting stops this mailbox syncing and revokes
                      saasmail&apos;s access. Mail already synced stays; nothing
                      new arrives.
                    </p>
                  )}

                  {account.lastError && (
                    <div className="mt-2 rounded-[6px] bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      <span className="font-medium">
                        This mailbox has stopped syncing.
                      </span>{" "}
                      It will not resume until you reconnect it. Google said:{" "}
                      {account.lastError}
                    </div>
                  )}

                  {account.lastGapAt !== null && (
                    <div className="mt-2 flex gap-2 rounded-[6px] bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                      <AlertTriangle size={14} className="mt-px shrink-0" />
                      <span>
                        <span className="font-medium">
                          Sync gap {relativeTime(account.lastGapAt)}.
                        </span>{" "}
                        Gmail expired the history cursor, so sync re-seeded from
                        the present. Mail that arrived during that window was
                        never synced and cannot be recovered here — it is still
                        in Gmail.
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
