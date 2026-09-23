import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Mail,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import {
  disconnectGmailAccount,
  fetchGmailAccounts,
  startGmailConnect,
  type GmailAccount,
} from "@/lib/api";
import { navigateExternal } from "@/lib/navigate-external";

/** How often the backend cron sweeps every connected mailbox. */
const SYNC_INTERVAL_LABEL = "every 15 minutes";

/**
 * `lastError` values a fresh grant cannot fix, so Reconnect is not offered
 * for them. Offering an action that cannot help is worse than offering none:
 * the operator burns a consent round trip and the error comes straight back.
 *
 * A denylist rather than an allowlist, because the two sets differ in kind.
 * The auth codes are whatever Google puts in its `error` field, plus the
 * local `refresh_failed` fallback — open-ended, so a code we have never seen
 * should still get the affordance. These are generated in this repo and the
 * list is closed:
 *   - `history_gap`            (lib/gmail/sync.ts)
 *   - `no_personal_inbox`      (lib/gmail/sync.ts — inbox mapping)
 *   - `ambiguous_inbox_mapping` (same)
 *   - `message_failed:<id>`    (lib/gmail/sync.ts — one message threw)
 */
const NON_AUTH_ERRORS = new Set([
  "history_gap",
  "no_personal_inbox",
  "ambiguous_inbox_mapping",
]);
const MESSAGE_FAILED_PREFIX = "message_failed:";

function isReconnectable(lastError: string): boolean {
  if (NON_AUTH_ERRORS.has(lastError)) return false;
  if (lastError.startsWith(MESSAGE_FAILED_PREFIX)) return false;
  return true;
}

/** What to do instead, for the errors Reconnect cannot fix. */
function nonAuthGuidance(lastError: string): string {
  if (lastError === "history_gap") {
    return "Sync re-seeded from the present after Gmail expired the history cursor. The next successful sync clears this.";
  }
  if (lastError === "no_personal_inbox") {
    return "No inbox is mapped to this mailbox's personal mail, so nothing can be routed. Map one below — reconnecting will not help.";
  }
  if (lastError === "ambiguous_inbox_mapping") {
    return "More than one inbox is mapped to this mailbox's personal mail. Leave exactly one — reconnecting will not help.";
  }
  return "A message failed to sync. The cursor did not move, so the next run retries it — reconnecting will not help.";
}

/**
 * "N minutes ago" for a past timestamp in **unix seconds** — the unit the
 * worker writes (`nowSeconds` in worker/src/lib/gmail/sync.ts) and that
 * `GET /api/admin/gmail` returns verbatim. Treating it as milliseconds is not
 * a rounding error: it renders every live mailbox as "20698 days ago".
 * Deliberately coarse — the exact second is noise; what an admin wants is
 * "is this mailbox stale?".
 */
function relativeTime(unixSeconds: number): string {
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - unixSeconds));
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

  // The OAuth callback redirects back here as /inboxes?gmail=connected|error.
  // Read the outcome into state, then strip the param, so the banner survives
  // for this visit but a refresh does not resurrect a stale one.
  const [searchParams, setSearchParams] = useSearchParams();
  const [connectResult, setConnectResult] = useState<
    "connected" | "error" | "wrong_account" | null
  >(null);
  // Which mailbox a refused reconnect was aimed at, and which one Google
  // actually granted. Naming both is the point of the message: without it the
  // operator cannot tell what went wrong or what to do differently.
  const [wrongAccount, setWrongAccount] = useState<{
    expected: string;
    granted: string;
  } | null>(null);
  // Failure of the consent-URL fetch itself, distinct from the callback's
  // `?gmail=error`: this one carries the server's own message.
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    const outcome = searchParams.get("gmail");
    if (
      outcome !== "connected" &&
      outcome !== "error" &&
      outcome !== "wrong_account"
    ) {
      return;
    }
    setConnectResult(outcome);
    if (outcome === "wrong_account") {
      setWrongAccount({
        expected: searchParams.get("gmail_expected") ?? "",
        granted: searchParams.get("gmail_granted") ?? "",
      });
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("gmail");
        next.delete("gmail_expected");
        next.delete("gmail_granted");
        return next;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams]);

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

  /**
   * The connect endpoint answers `{ authUrl }` with a 200 rather than
   * redirecting, so the consent flow only starts if we navigate ourselves.
   * A failure — 503 on an instance with no OAuth secrets being the one that
   * matters — is shown here instead of navigating anywhere.
   *
   * `reconnectFor` is the address of the mailbox a per-account **Reconnect**
   * belongs to. Without it the flow grants whichever Google account happens to
   * be signed in, and the callback upserts on the address it gets back — so a
   * reconnect aimed at one mailbox lands on another and resets *that* one's
   * sync cursor. Passing the address is what makes the grant targeted, and
   * what the callback refuses to write anything else against.
   */
  async function handleStartConnect(reconnectFor?: string) {
    if (connecting) return;
    setConnecting(true);
    setConnectResult(null);
    setConnectError(null);
    try {
      const { authUrl } = await startGmailConnect(reconnectFor);
      navigateExternal(authUrl);
    } catch (err) {
      setConnectError(
        err instanceof Error
          ? err.message
          : "Couldn't start the Google consent flow.",
      );
      setConnecting(false);
    }
    // On success the browser is leaving this page, so `connecting` stays true
    // and the button stays disabled until it does.
  }

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
        <button
          type="button"
          // Wrapped, not passed by reference: React would hand the click
          // event straight to `reconnectFor` and ask Google to pre-select a
          // mailbox called "[object Object]".
          onClick={() => handleStartConnect()}
          disabled={connecting}
          data-testid="gmail-connect-button"
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[6px] bg-text-primary px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-text-primary/90 disabled:opacity-50"
        >
          {connecting ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Plus size={14} />
          )}
          Connect a Google mailbox
        </button>
      </div>

      {(connectResult === "error" || connectError !== null) && (
        <div
          data-testid="gmail-connect-error"
          className="flex gap-2 rounded-[8px] bg-destructive/10 px-4 py-3 text-xs text-destructive ring-1 ring-destructive/20"
        >
          <AlertTriangle size={14} className="mt-px shrink-0" />
          {connectError !== null ? (
            <span>
              <span className="font-medium">
                Couldn&apos;t start the Google consent flow.
              </span>{" "}
              {connectError}
            </span>
          ) : (
            <span>
              <span className="font-medium">
                Couldn&apos;t connect that mailbox.
              </span>{" "}
              The connection did not complete, so nothing was added — try again.
              The reason is in the server log; it is deliberately not shown
              here, because the underlying error can carry the access token.
            </span>
          )}
        </div>
      )}

      {connectResult === "wrong_account" && wrongAccount !== null && (
        <div
          data-testid="gmail-wrong-account"
          className="flex gap-2 rounded-[8px] bg-destructive/10 px-4 py-3 text-xs text-destructive ring-1 ring-destructive/20"
        >
          <AlertTriangle size={14} className="mt-px shrink-0" />
          <span>
            <span className="font-medium">
              That was a different mailbox, so nothing was changed.
            </span>{" "}
            You were reconnecting{" "}
            <span className="font-mono">{wrongAccount.expected}</span>, but you
            granted access as{" "}
            <span className="font-mono">{wrongAccount.granted}</span>. Saving it
            would have replaced the wrong mailbox&apos;s credentials and skipped
            its unsynced mail, so it was refused. Sign in to Google as{" "}
            <span className="font-mono">{wrongAccount.expected}</span> — or pick
            it at Google&apos;s account chooser — and try again.
          </span>
        </div>
      )}

      {connectResult === "connected" && (
        <div
          data-testid="gmail-connect-success"
          className="flex gap-2 rounded-[8px] bg-emerald-500/10 px-4 py-3 text-xs text-emerald-700 ring-1 ring-emerald-500/20 dark:text-emerald-400"
        >
          <CheckCircle2 size={14} className="mt-px shrink-0" />
          <span>
            <span className="font-medium">Mailbox connected.</span> It is in the
            list below. The first sync runs within 15 minutes, and only mail
            that arrives from now on is pulled in.
          </span>
        </div>
      )}

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
                      {account.lastError !== null &&
                        isReconnectable(account.lastError) && (
                          <button
                            type="button"
                            onClick={() =>
                              handleStartConnect(account.emailAddress)
                            }
                            disabled={connecting}
                            data-testid={`gmail-reconnect-${account.id}`}
                            className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-border bg-card px-3 text-xs font-medium text-text-primary transition-colors hover:bg-black/[0.03] disabled:opacity-50"
                          >
                            {connecting ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <RefreshCw size={12} />
                            )}
                            Reconnect
                          </button>
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
                      This deletes the stored credentials for this mailbox and
                      stops it syncing. Mail already synced stays; nothing new
                      arrives. It does <span className="font-medium">not</span>{" "}
                      revoke saasmail&apos;s access at Google — to do that,
                      remove it from third-party access in your Google account.
                    </p>
                  )}

                  {account.lastError !== null && (
                    <div className="mt-2 rounded-[6px] bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      <span className="font-medium">
                        This mailbox has stopped syncing.
                      </span>{" "}
                      {isReconnectable(account.lastError)
                        ? "It will not resume until you reconnect it. Google said:"
                        : nonAuthGuidance(account.lastError)}{" "}
                      <span className="font-mono">{account.lastError}</span>
                    </div>
                  )}

                  {account.lastGapAt !== null && (
                    <div className="mt-2 flex gap-2 rounded-[6px] bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                      <AlertTriangle size={14} className="mt-px shrink-0" />
                      <span>
                        <span className="font-medium">
                          Sync gap {relativeTime(account.lastGapAt)}.
                        </span>{" "}
                        The sync cursor was re-seeded from the present — either
                        Gmail expired it, or this mailbox was reconnected. Mail
                        that arrived before that point and had not been fetched
                        yet was never synced and cannot be recovered here — it
                        is still in Gmail.
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
