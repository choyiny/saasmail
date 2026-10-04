import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Download } from "lucide-react";
import {
  ApiError,
  deleteExport,
  exportDownloadUrl,
  fetchExports,
  fetchStats,
  startExport,
  type MailExport,
} from "@/lib/api";
import { onExportReady } from "@/lib/export-events";
import { formatBytes } from "@/lib/format-bytes";
import DataImports from "@/components/DataImports";

export { formatBytes };

/** How often the list refreshes while an export runs. */
const POLL_MS = 3_000;

function formatDay(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString([], {
    dateStyle: "medium",
  });
}

/** A date input's day, as Unix seconds at its local start or end. */
function daySeconds(value: string, end: boolean): number | null {
  if (!value) return null;
  const date = new Date(`${value}T${end ? "23:59:59" : "00:00:00"}`);
  return Number.isNaN(date.getTime())
    ? null
    : Math.floor(date.getTime() / 1000);
}

function statusLine(item: MailExport): string {
  const messages = `${item.processedMessages} ${item.processedMessages === 1 ? "message" : "messages"}`;
  switch (item.status) {
    case "running":
      return `Exporting… ${messages} so far`;
    case "completed":
      return `${messages} · ${formatBytes(item.bytes)}${item.expiresAt ? ` · until ${formatDay(item.expiresAt)}` : ""}`;
    case "failed":
      return `Failed${item.error ? `: ${item.error}` : ""}`;
    case "expired":
      return "Expired: the file was deleted after 7 days";
    default:
      return "Cancelled";
  }
}

/**
 * Settings → Data: export a mailbox you can read as an mbox file, and the
 * exports you asked for (all of them for admins).
 */
export default function DataExports({
  showImports = false,
}: {
  /** Admins: the Import mail card too. */
  showImports?: boolean;
}) {
  const [searchParams] = useSearchParams();
  const [inboxes, setInboxes] = useState<string[]>([]);
  const [inbox, setInbox] = useState(searchParams.get("export") ?? "");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [includeTrash, setIncludeTrash] = useState(false);
  const [includeCampaignSends, setIncludeCampaignSends] = useState(false);
  const [exports, setExports] = useState<MailExport[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement>(null);

  const refresh = useCallback(async () => {
    try {
      setExports(await fetchExports());
    } catch {
      // Keep the last list; the next poll tries again.
    }
  }, []);

  useEffect(() => {
    void refresh();
    fetchStats()
      .then((stats) => {
        const all = new Set([
          ...stats.recipients.map((email) => email.toLowerCase()),
          ...stats.senderIdentities.map((identity) =>
            identity.email.toLowerCase(),
          ),
        ]);
        const sorted = [...all].sort();
        setInboxes(sorted);
        setInbox((current) =>
          current && all.has(current.toLowerCase())
            ? current.toLowerCase()
            : (sorted[0] ?? ""),
        );
      })
      .catch(() => setInboxes([]));
    return onExportReady(() => void refresh());
  }, [refresh]);

  // Arriving from a link to #data (an inbox's Export, the ready notice).
  useEffect(() => {
    if (window.location.hash === "#data") {
      sectionRef.current?.scrollIntoView?.({ block: "start" });
    }
  }, []);

  const running = exports?.some((item) => item.status === "running") ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, refresh]);

  async function onStart() {
    setError(null);
    const fromSeconds = daySeconds(from, false);
    const toSeconds = daySeconds(to, true);
    if (fromSeconds !== null && toSeconds !== null && fromSeconds > toSeconds) {
      setError("The start date is after the end date.");
      return;
    }
    setBusy(true);
    try {
      await startExport({
        inbox,
        from: fromSeconds,
        to: toSeconds,
        includeTrash,
        includeCampaignSends,
      });
      await refresh();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "EXPORT_RUNNING"
          ? `An export of ${inbox} is already running.`
          : err instanceof Error
            ? err.message
            : "The export could not start.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(item: MailExport) {
    setError(null);
    try {
      await deleteExport(item.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete it.");
    }
  }

  const fieldClass =
    "h-10 w-full rounded-[6px] border border-border bg-bg-subtle px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-text-primary/30";
  const labelClass =
    "text-xs font-medium uppercase tracking-wider text-text-tertiary";

  return (
    <section
      id="data"
      ref={sectionRef}
      className="scroll-mt-6 space-y-3"
      data-testid="data-exports"
    >
      <h2 className="text-base font-semibold text-text-primary">Data</h2>

      <div className="rounded-[8px] bg-card p-5 ring-1 ring-border">
        <p className="text-sm font-medium text-text-primary">Export mailbox</p>
        <p className="mt-1 text-xs font-light text-text-secondary">
          One mbox file with the inbox's received and sent mail, oldest first,
          that Thunderbird, Apple Mail and most providers can import. Mail is
          exported as it arrived when saasmail kept the original. You get a
          notice when it is ready; the file is kept for 7 days.
        </p>

        {inboxes.length === 0 ? (
          <p className="mt-4 text-xs font-light text-text-secondary">
            You have no inboxes to export.
          </p>
        ) : (
          <>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <div className="space-y-1">
                <label htmlFor="export-inbox" className={labelClass}>
                  Inbox
                </label>
                <select
                  id="export-inbox"
                  value={inbox}
                  disabled={busy}
                  onChange={(e) => setInbox(e.target.value)}
                  className={fieldClass}
                >
                  {inboxes.map((email) => (
                    <option key={email} value={email}>
                      {email}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label htmlFor="export-from" className={labelClass}>
                  From (optional)
                </label>
                <input
                  id="export-from"
                  type="date"
                  value={from}
                  disabled={busy}
                  onChange={(e) => setFrom(e.target.value)}
                  className={fieldClass}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="export-to" className={labelClass}>
                  To (optional)
                </label>
                <input
                  id="export-to"
                  type="date"
                  value={to}
                  disabled={busy}
                  onChange={(e) => setTo(e.target.value)}
                  className={fieldClass}
                />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
              <label className="inline-flex items-center gap-2 text-xs text-text-secondary">
                <input
                  type="checkbox"
                  checked={includeTrash}
                  disabled={busy}
                  onChange={(e) => setIncludeTrash(e.target.checked)}
                />
                Include Trash
              </label>
              <label className="inline-flex items-center gap-2 text-xs text-text-secondary">
                <input
                  type="checkbox"
                  checked={includeCampaignSends}
                  disabled={busy}
                  onChange={(e) => setIncludeCampaignSends(e.target.checked)}
                />
                Include campaign sends
              </label>
            </div>
            <div className="mt-4">
              <button
                type="button"
                onClick={onStart}
                disabled={busy || !inbox}
                className="rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? "Starting…" : "Export"}
              </button>
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {error}
          </p>
        )}

        {exports && exports.length > 0 && (
          <div className="mt-5 border-t border-border/60 pt-4">
            <p className="text-xs font-medium uppercase tracking-wider text-text-tertiary">
              Exports
            </p>
            <ul className="mt-2 divide-y divide-border/60">
              {exports.map((item) => (
                <li
                  key={item.id}
                  data-testid="export-row"
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-text-primary">
                      {item.inbox}
                      <span className="ml-2 text-xs font-light text-text-tertiary">
                        {formatDay(item.createdAt)}
                      </span>
                    </p>
                    <p
                      className="text-xs font-light text-text-secondary"
                      data-testid="export-status"
                    >
                      {statusLine(item)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {item.status === "completed" && (
                      <a
                        href={exportDownloadUrl(item.id)}
                        download
                        className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1 text-xs font-medium text-text-primary ring-1 ring-border hover:bg-bg-muted"
                      >
                        <Download size={12} />
                        Download
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => onDelete(item)}
                      className="rounded-[6px] px-2 py-1 text-xs text-text-secondary hover:bg-bg-muted hover:text-text-primary"
                    >
                      {item.status === "running" ? "Cancel" : "Delete"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {showImports && <DataImports inboxes={inboxes} />}
    </section>
  );
}
