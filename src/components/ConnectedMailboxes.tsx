import { useEffect, useState } from "react";
import ProviderSettingsPanel from "@/components/ProviderSettingsPanel";
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
  disconnectOutlookAccount,
  fetchGmailAccounts,
  fetchOutlookAccounts,
  startGmailConnect,
  startOutlookConnect,
  type GmailAccount,
} from "@/lib/api";
import { navigateExternal } from "@/lib/navigate-external";
// The worker writes these into `gmail_accounts.lastError`; this is the one
// place that reads them. Imported, not re-typed — the module is
// dependency-free and bundles for the browser, like `@worker/lib/interpolate`.
import {
  HISTORY_GAP_ERROR,
  MESSAGE_FAILED_PREFIX,
  NO_PERSONAL_INBOX_ERROR,
  SYNC_FAILED_PREFIX,
} from "@worker/lib/gmail/error-codes";

/** How often the backend cron sweeps every connected mailbox. */
const SYNC_INTERVAL_LABEL = "every hour";

type Provider = "google" | "microsoft";

/**
 * Everything that differs between the Google and Microsoft sections. The
 * rest — sync health, Reconnect, the import bar — is the same component.
 */
const PROVIDERS = {
  google: {
    /** The company, for "Connect a Google mailbox" and the settings panel. */
    label: "Google",
    /** The mail service, for what it "said" or "expired". */
    service: "Gmail",
    /** Query param the OAuth callback redirects back with, and test-id prefix. */
    key: "gmail",
    fetch: fetchGmailAccounts,
    disconnect: disconnectGmailAccount,
    startConnect: startGmailConnect,
    revokeHint: "remove it from third-party access in your Google account.",
  },
  microsoft: {
    label: "Microsoft",
    service: "Outlook",
    key: "outlook",
    fetch: fetchOutlookAccounts,
    disconnect: disconnectOutlookAccount,
    startConnect: startOutlookConnect,
    revokeHint:
      "remove saasmail under Apps at myaccount.microsoft.com, or in Microsoft Entra for a work account.",
  },
} as const;

/**
 * `lastError` values a fresh grant cannot fix, so Reconnect is not offered
 * for them. Offering an action that cannot help is worse than offering none:
 * the operator burns a consent round trip and the error comes straight back.
 *
 * A denylist rather than an allowlist, because the two sets differ in kind.
 * The auth codes are whatever Google puts in its `error` field, plus the
 * local `refresh_failed` fallback — open-ended, so a code we have never seen
 * should still get the affordance. The ones generated in this repo are a
 * closed list, and they are imported rather than re-typed so the two ends
 * cannot drift.
 */
const NON_AUTH_ERRORS = new Set<string>([
  HISTORY_GAP_ERROR,
  NO_PERSONAL_INBOX_ERROR,
]);

/**
 * The `sync_failed:` codes a fresh grant CAN fix: Gmail refusing the
 * credential itself. A 5xx, a rate limit or an unclassified throw are the
 * server's problem or ours, and the next hourly run is the answer —
 * reconnecting only re-seeds the cursor and loses mail.
 */
const RECONNECTABLE_SYNC_FAILURES = new Set<string>([
  `${SYNC_FAILED_PREFIX}http_401`,
  `${SYNC_FAILED_PREFIX}http_403`,
]);

function isReconnectable(lastError: string): boolean {
  if (NON_AUTH_ERRORS.has(lastError)) return false;
  if (lastError.startsWith(MESSAGE_FAILED_PREFIX)) return false;
  if (lastError.startsWith(SYNC_FAILED_PREFIX)) {
    return RECONNECTABLE_SYNC_FAILURES.has(lastError);
  }
  return true;
}

/** What to do instead, for the errors Reconnect cannot fix. */
function nonAuthGuidance(lastError: string, service: string): string {
  if (lastError === HISTORY_GAP_ERROR) {
    return `Sync re-seeded from the present after ${service} expired the history cursor. The next successful sync clears this.`;
  }
  if (lastError === NO_PERSONAL_INBOX_ERROR) {
    return "No inbox is mapped to this mailbox, so nothing can be routed. Map one below — reconnecting will not help.";
  }
  if (lastError.startsWith(SYNC_FAILED_PREFIX)) {
    return `The last sync could not run — nothing since has arrived. Sync retries ${SYNC_INTERVAL_LABEL}, and reconnecting will not help. ${service} said:`;
  }
  return "A message failed to sync. The cursor did not move, so the next run retries it — reconnecting will not help.";
}

/**
 * A `?gmail_expected=` / `?gmail_granted=` value the wrong-account banner is
 * willing to print, or null.
 *
 * These come from the query string, so they are whatever the URL says — and
 * the banner they land in is a red notice that reads as a verdict from the
 * server. React escapes the text, so this is not an injection; it is simply
 * that an admin-facing message must not be dictated by a link. One `@`, no
 * whitespace, and RFC 5321's 254-character ceiling is all an address needs.
 */
function mailboxParam(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > 254) return null;
  if (value.split("@").length !== 2) return null;
  if (/\s/.test(value)) return null;
  return value;
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
 * Where this mailbox came from: when it was added, and who last authorised
 * it. A mailbox reads someone else's mail, so an operator looking at one they
 * did not set up needs the row to answer that.
 *
 * The two halves are deliberately worded as different facts, because they
 * are: `createdAt` is the first connection and never moves, while
 * `connectedBy` is re-stamped on every reconnect and so names whoever last
 * replaced the credentials.
 *
 * Degrades rather than disappears — a row connected before the server
 * recorded this says only when, and a deleted admin is named as such rather
 * than printed as a user id nobody can resolve.
 */
function connectedByLabel(account: GmailAccount): string {
  const added = `Added ${relativeTime(account.createdAt)}`;
  if (account.connectedBy === null) return added;
  const who = account.connectedBy.name ?? "a deleted user";
  return `${added} · last connected by ${who}`;
}

interface ConnectedMailboxesProps {
  /** Which provider's mailboxes this section lists. Google by default. */
  provider?: Provider;
  /**
   * Called when the set of connected mailboxes has changed, so the rest of
   * the page can re-read it. Optional: this section works standalone.
   */
  onMailboxesChanged?: () => void;
}

/**
 * Admin section listing the Google mailboxes connected over OAuth, with
 * their sync health, plus connect/disconnect.
 *
 * Every piece of state here is invisible everywhere else in the product, so
 * it is stated plainly rather than reassuringly: a broken grant means the
 * mailbox has stopped syncing, and a history gap means mail is gone for good.
 */
export default function ConnectedMailboxes({
  provider = "google",
  onMailboxesChanged,
}: ConnectedMailboxesProps = {}) {
  const ui = PROVIDERS[provider];
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
    "connected" | "error" | "wrong_account" | "wrong_admin" | null
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
    const outcome = searchParams.get(ui.key);
    if (
      outcome !== "connected" &&
      outcome !== "error" &&
      outcome !== "wrong_account" &&
      outcome !== "wrong_admin"
    ) {
      return;
    }
    if (outcome === "wrong_account") {
      const expected = mailboxParam(searchParams.get(`${ui.key}_expected`));
      const granted = mailboxParam(searchParams.get(`${ui.key}_granted`));
      // The callback always sends both, and both are addresses. Anything
      // else means the URL was hand-made, and a red admin banner must not
      // read back whatever a link put in it — nor say "you were reconnecting
      // , but you granted access as ." Fall back to the generic failure.
      if (expected === null || granted === null) {
        setConnectResult("error");
      } else {
        setConnectResult(outcome);
        setWrongAccount({ expected, granted });
      }
    } else {
      setConnectResult(outcome);
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(ui.key);
        next.delete(`${ui.key}_expected`);
        next.delete(`${ui.key}_granted`);
        return next;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams, ui.key]);

  useEffect(() => {
    let cancelled = false;
    ui.fetch()
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
  }, [ui]);

  // While an import is under way, refresh the list so its bar moves. Quietly:
  // a failed refresh keeps the last good rows rather than flashing an error.
  const importing = accounts.some((a) => a.backfill.status !== "done");
  useEffect(() => {
    if (!importing) return;
    const timer = setInterval(() => {
      ui.fetch()
        .then(setAccounts)
        .catch(() => {});
    }, BACKFILL_POLL_MS);
    return () => clearInterval(timer);
  }, [importing, ui]);

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
      const { authUrl } = await ui.startConnect(reconnectFor);
      navigateExternal(authUrl);
    } catch (err) {
      setConnectError(
        err instanceof Error
          ? err.message
          : `Couldn't start the ${ui.label} consent flow.`,
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
      await ui.disconnect(account.id);
      setAccounts((prev) => prev.filter((a) => a.id !== account.id));
      setConfirmingId(null);
      // Disconnecting also unmaps every inbox that read from this mailbox,
      // server-side, so the table below is now out of date in two ways.
      onMailboxesChanged?.();
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
    <section
      className="mb-6 space-y-3"
      data-testid={
        provider === "google"
          ? "connected-mailboxes"
          : `connected-mailboxes-${provider}`
      }
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text-primary">
            Connected {ui.label} mailboxes
          </h2>
          <p className="mt-0.5 text-xs text-text-tertiary">
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
          data-testid={`${ui.key}-connect-button`}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-4 text-sm font-medium text-accent-foreground shadow-card transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {connecting ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Plus size={14} />
          )}
          Connect a {ui.label} mailbox
        </button>
      </div>

      <ProviderSettingsPanel provider={provider} />

      {(connectResult === "error" || connectError !== null) && (
        <div
          data-testid={`${ui.key}-connect-error`}
          className="flex gap-2 rounded-lg bg-destructive-subtle px-4 py-3 text-xs text-destructive ring-1 ring-destructive/25"
        >
          <AlertTriangle size={14} className="mt-px shrink-0" />
          {connectError !== null ? (
            <span>
              <span className="font-medium">
                Couldn&apos;t start the {ui.label} consent flow.
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
          data-testid={`${ui.key}-wrong-account`}
          className="flex gap-2 rounded-lg bg-destructive-subtle px-4 py-3 text-xs text-destructive ring-1 ring-destructive/25"
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
            its unsynced mail, so it was refused. Sign in to {ui.label} as{" "}
            <span className="font-mono">{wrongAccount.expected}</span> — or pick
            it at {ui.label}&apos;s account chooser — and try again.
          </span>
        </div>
      )}

      {connectResult === "wrong_admin" && (
        <div
          data-testid={`${ui.key}-wrong-admin`}
          className="flex gap-2 rounded-lg bg-destructive-subtle px-4 py-3 text-xs text-destructive ring-1 ring-destructive/25"
        >
          <AlertTriangle size={14} className="mt-px shrink-0" />
          <span>
            <span className="font-medium">
              That consent flow belongs to a different administrator, so nothing
              was changed.
            </span>{" "}
            A connection is tied to the admin who started it. Start it again
            from this account — the button above — and finish it in this
            browser.
          </span>
        </div>
      )}

      {connectResult === "connected" && (
        <div
          data-testid={`${ui.key}-connect-success`}
          className="flex gap-2 rounded-lg bg-success-subtle px-4 py-3 text-xs text-success ring-1 ring-success/25"
        >
          <CheckCircle2 size={14} className="mt-px shrink-0" />
          <span>
            <span className="font-medium">Mailbox connected.</span> It is in the
            list below. The first sync runs within the hour, and only mail that
            arrives from now on is pulled in.
          </span>
        </div>
      )}

      {loading && <p className="text-sm text-text-tertiary">Loading…</p>}

      {!loading && loadError && (
        <div
          data-testid={`${ui.key}-load-error`}
          className="rounded-2xl bg-card p-4 text-sm text-destructive border border-border shadow-card"
        >
          Couldn&apos;t load the connected mailboxes ({loadError}). This is not
          the same as having none connected — reload before changing anything.
        </div>
      )}

      {!loading && !loadError && accounts.length === 0 && (
        <div
          data-testid={`${ui.key}-empty-state`}
          className="rounded-2xl bg-card p-10 text-center border border-border shadow-card"
        >
          <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent-subtle">
            <Mail size={20} className="text-text-secondary" />
          </span>
          <p className="mb-1 text-sm font-medium text-text-primary">
            No {ui.label} mailbox connected
          </p>
          <p className="mx-auto max-w-lg text-xs text-text-tertiary">
            Connecting a mailbox lets saasmail read its mail and send as that
            address. New mail syncs going forward, and the last year is imported
            once in the background.
          </p>
        </div>
      )}

      {!loading && !loadError && accounts.length > 0 && (
        <div className="overflow-hidden rounded-2xl bg-card border border-border shadow-card">
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
                  data-testid={`${ui.key}-account-${account.id}`}
                  className="px-4 py-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-text-primary">
                        {account.emailAddress}
                      </div>
                      <div
                        data-testid={`${ui.key}-synced-${account.id}`}
                        className="mt-0.5 text-xs text-text-tertiary"
                      >
                        {account.lastSyncedAt === null
                          ? "Not synced yet — the first sync runs within the hour."
                          : `Synced ${relativeTime(account.lastSyncedAt)}`}
                      </div>
                      <div
                        data-testid={`${ui.key}-provenance-${account.id}`}
                        className="mt-0.5 text-xs text-text-tertiary"
                      >
                        {connectedByLabel(account)}
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
                            data-testid={`${ui.key}-reconnect-${account.id}`}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs font-medium text-text-primary transition-colors hover:bg-bg-subtle disabled:opacity-50"
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
                            data-testid={`${ui.key}-confirm-disconnect-${account.id}`}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-destructive px-3 text-xs font-medium text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
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
                            data-testid={`${ui.key}-cancel-disconnect-${account.id}`}
                            className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-text-tertiary transition-colors hover:bg-bg-subtle hover:text-text-primary disabled:opacity-50"
                          >
                            <X size={12} />
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmingId(account.id)}
                          data-testid={`${ui.key}-disconnect-${account.id}`}
                          className="inline-flex h-8 items-center rounded-lg border border-border bg-card px-3 text-xs font-medium text-text-primary transition-colors hover:bg-bg-subtle"
                        >
                          Disconnect
                        </button>
                      )}
                    </div>
                  </div>

                  {confirming && (
                    <p className="mt-2 text-xs text-text-tertiary">
                      This deletes the stored credentials for this mailbox and
                      stops it syncing. Mail already synced stays; nothing new
                      arrives. It does <span className="font-medium">not</span>{" "}
                      revoke saasmail&apos;s access at {ui.label} — to do that,{" "}
                      {ui.revokeHint}
                    </p>
                  )}

                  {account.lastError !== null && (
                    <div className="mt-2 rounded-lg bg-destructive-subtle px-3 py-2 text-xs text-destructive">
                      <span className="font-medium">
                        This mailbox has stopped syncing.
                      </span>{" "}
                      {isReconnectable(account.lastError)
                        ? `It will not resume until you reconnect it. ${ui.label} said:`
                        : nonAuthGuidance(account.lastError, ui.service)}{" "}
                      <span className="font-mono">{account.lastError}</span>
                    </div>
                  )}

                  <BackfillProgress
                    testIdPrefix={ui.key}
                    account={account}
                    importingNow={
                      accounts.find(
                        (a) =>
                          a.id !== account.id &&
                          a.backfill.status === "running",
                      ) ?? null
                    }
                  />

                  {account.lastGapAt !== null && (
                    <div className="mt-2 flex gap-2 rounded-lg bg-warning-bg px-3 py-2 text-xs text-warning">
                      <AlertTriangle size={14} className="mt-px shrink-0" />
                      <span>
                        <span className="font-medium">
                          Sync gap {relativeTime(account.lastGapAt)}.
                        </span>{" "}
                        The sync cursor was re-seeded from the present — either
                        {` ${ui.service} `}expired it, or this mailbox was
                        reconnected. Mail that arrived before that point and had
                        not been fetched yet was never synced and cannot be
                        recovered here — it is still in {ui.service}.
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

/** How often the list refreshes while an import is under way. */
export const BACKFILL_POLL_MS = 10_000;

function shortDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * The one-year import's state for one mailbox: a bar while it runs, measured
 * by how far back in time it has reached (it walks newest first), and a
 * line saying so before and after. Imports run one mailbox at a time, so a
 * pending one names the mailbox it is waiting for.
 */
function BackfillProgress({
  testIdPrefix,
  account,
  importingNow,
}: {
  testIdPrefix: string;
  account: GmailAccount;
  /** Another mailbox whose import currently has the turn, if any. */
  importingNow: GmailAccount | null;
}) {
  const { backfill } = account;
  const testId = `${testIdPrefix}-backfill-${account.id}`;

  if (backfill.status === "done") {
    return (
      <p className="mt-2 text-xs text-text-tertiary" data-testid={testId}>
        Imported the last year ({backfill.count.toLocaleString()} messages).
      </p>
    );
  }

  if (backfill.status === "pending") {
    return (
      <p className="mt-2 text-xs text-text-tertiary" data-testid={testId}>
        {importingNow
          ? `Importing the last year starts after ${importingNow.emailAddress} finishes — one mailbox at a time.`
          : "Importing the last year starts shortly."}
      </p>
    );
  }

  const pct = Math.floor(backfill.progress * 100);
  return (
    <div className="mt-2" data-testid={testId}>
      <div className="mb-1 flex items-baseline justify-between gap-3 text-xs text-text-tertiary">
        <span>
          Importing the last year
          {backfill.reachedAt !== null && (
            <> — back to {shortDate(backfill.reachedAt)}</>
          )}
          {" · "}
          {backfill.count.toLocaleString()} messages
        </span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-bg-muted"
        role="progressbar"
        aria-label={`Importing ${account.emailAddress}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
