import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  fetchBackupManifest,
  fetchBackups,
  startBackupNow,
  updateBackupSettings,
  type BackupManifest,
  type BackupRun,
  type BackupsOverview,
} from "@/lib/api";
import { formatBytes } from "@/lib/format-bytes";

/** How often the list refreshes while a backup runs. */
const POLL_MS = 5_000;

function when(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function duration(run: BackupRun): string {
  if (!run.finishedAt) return "";
  const seconds = run.finishedAt - run.startedAt;
  return seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

function runLine(run: BackupRun): string {
  switch (run.status) {
    case "running":
      return `Backing up… ${run.tablesDone} of ${run.tablesTotal} tables`;
    case "completed":
      return run.prunedAt
        ? "Deleted by retention"
        : `${run.tablesDone} tables · ${run.rows} rows · ${formatBytes(run.bytes)} · ${duration(run)}`;
    default:
      return `Failed${run.error ? `: ${run.error}` : ""}`;
  }
}

/**
 * Settings → Data → Backups (admins): the daily backup's schedule and
 * retention, where it goes, "Back up now" and the runs.
 */
export default function DataBackups() {
  const [overview, setOverview] = useState<BackupsOverview | null>(null);
  const [hour, setHour] = useState("3");
  const [keepDays, setKeepDays] = useState("14");
  const [busy, setBusy] = useState<"save" | "toggle" | "run" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manifests, setManifests] = useState<
    Record<string, BackupManifest | "error">
  >({});

  const refresh = useCallback(async () => {
    try {
      const next = await fetchBackups();
      setOverview(next);
      return next;
    } catch (err) {
      setError(
        err instanceof Error
          ? `Backups could not be loaded: ${err.message}`
          : "Backups could not be loaded.",
      );
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh().then((next) => {
      if (!next) return;
      setHour(String(next.settings.hourUtc));
      setKeepDays(String(next.settings.keepDays));
    });
  }, [refresh]);

  const running =
    overview?.runs.some((run) => run.status === "running") ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, refresh]);

  async function onToggle() {
    if (!overview) return;
    setBusy("toggle");
    setError(null);
    try {
      await updateBackupSettings({ enabled: !overview.settings.enabled });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(null);
    }
  }

  async function onSave() {
    const hourValue = Number(hour);
    const keepValue = Number(keepDays);
    if (!Number.isInteger(hourValue) || hourValue < 0 || hourValue > 23) {
      setError("The hour is a whole number from 0 to 23 (UTC).");
      return;
    }
    if (!Number.isInteger(keepValue) || keepValue < 1 || keepValue > 365) {
      setError("Keep backups for 1 to 365 days.");
      return;
    }
    setBusy("save");
    setError(null);
    try {
      await updateBackupSettings({ hourUtc: hourValue, keepDays: keepValue });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(null);
    }
  }

  async function onRunNow() {
    setBusy("run");
    setError(null);
    try {
      await startBackupNow();
      await refresh();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "BACKUP_RUNNING"
          ? "A backup is already running."
          : err instanceof Error
            ? err.message
            : "The backup could not start.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function onShowManifest(run: BackupRun) {
    if (manifests[run.id] && manifests[run.id] !== "error") return;
    try {
      const manifest = await fetchBackupManifest(run.id);
      setManifests((current) => ({ ...current, [run.id]: manifest }));
    } catch {
      setManifests((current) => ({ ...current, [run.id]: "error" }));
    }
  }

  const fieldClass =
    "h-10 w-full rounded-[6px] border border-border bg-bg-subtle px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-text-primary/30";
  const labelClass =
    "text-xs font-medium uppercase tracking-wider text-text-tertiary";
  const settings = overview?.settings;

  return (
    <div
      className="rounded-[8px] bg-card p-5 ring-1 ring-border"
      data-testid="data-backups"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-text-primary">Backups</p>
          <p className="text-xs font-light text-text-secondary">
            A daily copy of the whole database (not the attachments, which are
            already in your bucket), as one compressed file per table that the
            restore script loads into a fresh instance. D1 Time Travel is the
            quick undo for the last 30 days; this is the copy you can take
            anywhere.
          </p>
          {settings && (
            <p
              className="text-xs text-text-secondary"
              data-testid="backup-schedule"
            >
              {settings.enabled
                ? `On: every day at ${String(settings.hourUtc).padStart(2, "0")}:00 UTC${settings.nextDue ? `, next ${when(settings.nextDue)}` : ""}.`
                : "Off."}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onToggle}
          disabled={!overview || busy !== null}
          className="shrink-0 rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy === "toggle"
            ? "Saving…"
            : settings?.enabled
              ? "Turn off"
              : "Turn on daily backups"}
        </button>
      </div>

      {overview && (
        <>
          <dl className="mt-4 grid gap-2 text-xs text-text-secondary sm:grid-cols-2">
            <div>
              <dt className={labelClass}>Where</dt>
              <dd className="mt-1">
                {overview.destination === "BACKUPS"
                  ? "The BACKUPS bucket"
                  : "The attachments bucket (R2), under backups/. A separate BACKUPS bucket is safer: see the docs."}
              </dd>
            </div>
            <div>
              <dt className={labelClass}>Encryption</dt>
              <dd className="mt-1">
                {overview.encryption === "configured"
                  ? "Encrypted with BACKUP_ENCRYPTION_KEY."
                  : overview.encryption === "invalid"
                    ? "BACKUP_ENCRYPTION_KEY is not 64 hex characters: backups cannot start."
                    : "Not configured: the files are plain. Set BACKUP_ENCRYPTION_KEY to encrypt them."}
              </dd>
            </div>
          </dl>

          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <label htmlFor="backup-hour" className={labelClass}>
                Hour (UTC)
              </label>
              <input
                id="backup-hour"
                type="number"
                min={0}
                max={23}
                value={hour}
                disabled={busy !== null}
                onChange={(e) => setHour(e.target.value)}
                className={fieldClass}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="backup-keep" className={labelClass}>
                Keep for (days)
              </label>
              <input
                id="backup-keep"
                type="number"
                min={1}
                max={365}
                value={keepDays}
                disabled={busy !== null}
                onChange={(e) => setKeepDays(e.target.value)}
                className={fieldClass}
              />
            </div>
            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={onSave}
                disabled={busy !== null}
                className="rounded-[6px] px-3 py-2 text-xs font-medium text-text-primary ring-1 ring-border hover:bg-bg-muted disabled:opacity-60"
              >
                {busy === "save" ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={onRunNow}
                disabled={busy !== null || running}
                className="rounded-[6px] px-3 py-2 text-xs font-medium text-text-primary ring-1 ring-border hover:bg-bg-muted disabled:opacity-60"
              >
                {busy === "run" ? "Starting…" : "Back up now"}
              </button>
            </div>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      )}

      {overview && overview.runs.length > 0 && (
        <div className="mt-5 border-t border-border/60 pt-4">
          <p className="text-xs font-medium uppercase tracking-wider text-text-tertiary">
            Runs
          </p>
          <ul className="mt-2 divide-y divide-border/60">
            {overview.runs.map((run) => (
              <li key={run.id} className="py-2" data-testid="backup-row">
                <p className="text-sm text-text-primary">
                  {when(run.startedAt)}
                  <span className="ml-2 text-xs font-light text-text-tertiary">
                    {run.manual ? "Back up now" : "Scheduled"}
                    {run.encrypted ? " · encrypted" : ""}
                  </span>
                </p>
                <p
                  className="text-xs font-light text-text-secondary"
                  data-testid="backup-status"
                >
                  {runLine(run)}
                </p>
                {run.status === "completed" && !run.prunedAt && (
                  <details
                    className="mt-1 text-xs text-text-secondary"
                    onToggle={(event) => {
                      if ((event.target as HTMLDetailsElement).open) {
                        void onShowManifest(run);
                      }
                    }}
                  >
                    <summary className="cursor-pointer text-text-tertiary">
                      Manifest · <code>{run.prefix}</code>
                    </summary>
                    {(() => {
                      const manifest = manifests[run.id];
                      if (manifest === "error") {
                        return (
                          <p className="mt-1 text-destructive">
                            The manifest could not be loaded.
                          </p>
                        );
                      }
                      if (!manifest) return <p className="mt-1">Loading…</p>;
                      return (
                        <ul className="mt-1 space-y-0.5">
                          <li>
                            Last migration:{" "}
                            {manifest.lastMigration ?? "unknown"}
                          </li>
                          {manifest.tables.map((table) => (
                            <li key={table.name}>
                              {table.name}: {table.rows} rows,{" "}
                              {formatBytes(table.bytes)}
                            </li>
                          ))}
                        </ul>
                      );
                    })()}
                  </details>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
