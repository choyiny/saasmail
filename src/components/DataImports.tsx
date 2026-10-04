import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  completeImport,
  deleteImport,
  fetchImports,
  startImport,
  uploadImportPart,
  type MailImport,
} from "@/lib/api";
import { formatBytes } from "@/lib/format-bytes";
import { onImportDone } from "@/lib/export-events";

/** How often the list refreshes while an import runs. */
const POLL_MS = 3_000;
/** The largest file an import takes (5 GB). */
export const MAX_IMPORT_BYTES = 5 * 1000 * 1000 * 1000;
/** Tries per part before the upload gives up. */
const PART_ATTEMPTS = 3;
/** The wait before trying a part again, times the attempt. Mutable for tests. */
export const UPLOAD_TIMING = { retryMs: 1_000 };

class UploadCancelled extends Error {}

function statusLine(item: MailImport, uploadingHere: boolean): string {
  const counts = `${item.importedMessages} imported, ${item.skippedMessages} skipped`;
  switch (item.status) {
    case "uploading":
      return uploadingHere
        ? `Uploading… ${item.partsUploaded} of ${item.partsExpected} parts`
        : "Upload not finished";
    case "running": {
      const share =
        item.size > 0 ? Math.floor((item.bytesRead / item.size) * 100) : 0;
      return `Importing… ${share}% · ${counts}`;
    }
    case "completed":
      return counts;
    case "failed": {
      const last = item.notes[item.notes.length - 1];
      return `Failed${last ? `: ${last.reason}` : ""} · ${counts}`;
    }
    default:
      return counts;
  }
}

/**
 * Settings → Data → Import mail (admins): upload an mbox or .eml file into
 * an inbox, and the imports so far.
 */
export default function DataImports({ inboxes }: { inboxes: string[] }) {
  const [file, setFile] = useState<File | null>(null);
  const [inbox, setInbox] = useState("");
  const [direction, setDirection] = useState<"strict" | "all_received">(
    "strict",
  );
  const [createFolders, setCreateFolders] = useState(true);
  const [imports, setImports] = useState<MailImport[] | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setImports(await fetchImports());
    } catch {
      // Keep the last list; the next poll tries again.
    }
  }, []);

  useEffect(() => {
    void refresh();
    return onImportDone(() => void refresh());
  }, [refresh]);

  useEffect(() => {
    setInbox((current) =>
      current && inboxes.includes(current) ? current : (inboxes[0] ?? ""),
    );
  }, [inboxes]);

  const running = imports?.some((item) => item.status === "running") ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, refresh]);

  async function onImport() {
    if (!file) return;
    setError(null);
    if (file.size === 0) {
      setError("That file is empty.");
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      setError("A file can be at most 5 GB.");
      return;
    }
    setProgress(0);
    cancelled.current = false;
    let created: MailImport | null = null;
    try {
      created = await startImport({
        inbox,
        filename: file.name,
        size: file.size,
        direction,
        createFoldersFromLabels: createFolders,
      });
      setUploadingId(created.id);
      await refresh();
      for (let n = 1; n <= created.partsExpected; n++) {
        if (cancelled.current) throw new UploadCancelled();
        const part = file.slice(
          (n - 1) * created.partSize,
          n * created.partSize,
        );
        for (let attempt = 1; ; attempt++) {
          try {
            await uploadImportPart(created.id, n, part);
            break;
          } catch (err) {
            // The server refused it (cancelled elsewhere, a wrong size):
            // sending the same part again cannot help.
            const refused =
              err instanceof ApiError && err.status >= 400 && err.status < 500;
            if (refused || attempt >= PART_ATTEMPTS) throw err;
            await new Promise((resolve) =>
              setTimeout(resolve, UPLOAD_TIMING.retryMs * attempt),
            );
            if (cancelled.current) throw new UploadCancelled();
          }
        }
        setProgress(n / created.partsExpected);
      }
      await completeImport(created.id);
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
    } catch (err) {
      if (err instanceof UploadCancelled) {
        if (created) await deleteImport(created.id).catch(() => {});
      } else {
        setError(
          err instanceof Error
            ? err.message
            : "The file could not be uploaded.",
        );
      }
    } finally {
      setProgress(null);
      setUploadingId(null);
      await refresh();
    }
  }

  async function onDelete(item: MailImport) {
    setError(null);
    try {
      await deleteImport(item.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete it.");
    }
  }

  const busy = progress !== null;
  const fieldClass =
    "h-10 w-full rounded-[6px] border border-border bg-bg-subtle px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-text-primary/30";
  const labelClass =
    "text-xs font-medium uppercase tracking-wider text-text-tertiary";

  return (
    <div
      className="rounded-[8px] bg-card p-5 ring-1 ring-border"
      data-testid="data-imports"
    >
      <p className="text-sm font-medium text-text-primary">Import mail</p>
      <p className="mt-1 text-xs font-light text-text-secondary">
        Bring old mail into an inbox from an mbox file (Gmail Takeout,
        Thunderbird, Apple Mail, Fastmail) or a single .eml, up to 5 GB.
        Imported mail is history: it arrives read, with no rules, notifications,
        webhooks or forwards, and a message already in the inbox is skipped.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="import-file" className={labelClass}>
            File
          </label>
          <input
            id="import-file"
            ref={fileInput}
            type="file"
            accept=".mbox,.mbx,.eml,application/mbox,message/rfc822"
            disabled={busy}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-xs text-text-secondary file:mr-3 file:rounded-[6px] file:border-0 file:bg-bg-muted file:px-3 file:py-2 file:text-xs file:text-text-primary"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="import-inbox" className={labelClass}>
            Into inbox
          </label>
          <select
            id="import-inbox"
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
      </div>

      <fieldset className="mt-4 space-y-2" disabled={busy}>
        <legend className={labelClass}>Which messages</legend>
        <label className="flex items-start gap-2 text-xs text-text-secondary">
          <input
            type="radio"
            name="import-direction"
            checked={direction === "strict"}
            onChange={() => setDirection("strict")}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium text-text-primary">
              Only mail to or from this inbox
            </span>{" "}
            (recommended). Mail from the inbox becomes Sent; mail addressed to
            it becomes received; anything else is skipped.
          </span>
        </label>
        <label className="flex items-start gap-2 text-xs text-text-secondary">
          <input
            type="radio"
            name="import-direction"
            checked={direction === "all_received"}
            onChange={() => setDirection("all_received")}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium text-text-primary">
              Everything as received
            </span>
            . Every message not from the inbox is stored as received by it,
            whoever it was addressed to: for mail from an address that no longer
            exists.
          </span>
        </label>
      </fieldset>

      <label className="mt-3 inline-flex items-center gap-2 text-xs text-text-secondary">
        <input
          type="checkbox"
          checked={createFolders}
          disabled={busy}
          onChange={(e) => setCreateFolders(e.target.checked)}
        />
        Create folders from labels
      </label>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={onImport}
          disabled={busy || !file || !inbox}
          className="rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Uploading…" : "Import"}
        </button>
        {progress !== null && (
          <button
            type="button"
            onClick={() => {
              cancelled.current = true;
            }}
            className="rounded-[6px] px-2 py-1 text-xs text-text-secondary hover:bg-bg-muted hover:text-text-primary"
          >
            Cancel upload
          </button>
        )}
        {progress !== null && (
          <div
            role="progressbar"
            aria-label="Upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            className="h-1.5 w-48 overflow-hidden rounded-full bg-bg-muted"
          >
            <div
              className="h-full bg-text-primary transition-all"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      )}

      {imports && imports.length > 0 && (
        <div className="mt-5 border-t border-border/60 pt-4">
          <p className="text-xs font-medium uppercase tracking-wider text-text-tertiary">
            Imports
          </p>
          <ul className="mt-2 divide-y divide-border/60">
            {imports.map((item) => (
              <li key={item.id} data-testid="import-row" className="py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-text-primary">
                      {item.filename}
                      <span className="ml-2 text-xs font-light text-text-tertiary">
                        into {item.inbox} · {formatBytes(item.size)}
                      </span>
                    </p>
                    <p
                      className="text-xs font-light text-text-secondary"
                      data-testid="import-status"
                    >
                      {statusLine(item, item.id === uploadingId)}
                    </p>
                  </div>
                  {item.id !== uploadingId && (
                    <button
                      type="button"
                      onClick={() => onDelete(item)}
                      className="rounded-[6px] px-2 py-1 text-xs text-text-secondary hover:bg-bg-muted hover:text-text-primary"
                    >
                      {item.status === "running" || item.status === "uploading"
                        ? "Cancel"
                        : "Delete"}
                    </button>
                  )}
                </div>
                {item.notes.length > 0 && (
                  <details className="mt-1 text-xs text-text-secondary">
                    <summary className="cursor-pointer text-text-tertiary">
                      {item.notes.length}{" "}
                      {item.notes.length === 1 ? "note" : "notes"}
                    </summary>
                    <ul className="mt-1 space-y-0.5">
                      {item.notes.map((entry, index) => (
                        <li key={index}>
                          Message {entry.row}: {entry.reason}
                        </li>
                      ))}
                    </ul>
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
