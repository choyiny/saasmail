import { useEffect, useState } from "react";
import {
  fetchAdminInboxes,
  updateInboxSettings,
  type AdminInbox,
  type ThreadingMode,
} from "@/lib/api";

const POLL_MS = 5000;

/** What the confirmation says changing to `mode` does. */
export function conversationModeConsequences(mode: ThreadingMode): string {
  const lead =
    mode === "headers"
      ? "Group this inbox's mail by thread?\n\n• Replies form threads by their In-Reply-To and References headers, like a mail client. The inbox's mail is regrouped in the background."
      : "Group this inbox's mail by customer?\n\n• All mail with a person becomes one conversation again. The inbox's mail is regrouped in the background.";
  const scope =
    mode === "headers"
      ? "• Snoozes and assignments in this inbox are cleared: from now on they apply to a thread, not a customer."
      : "• Snoozes and assignments in this inbox are cleared: from now on they apply to the customer.";
  return `${lead}\n${scope}\n• Mail clients connected over JMAP resync everything once the regrouping finishes.`;
}

interface Props {
  inbox: AdminInbox;
  onChange: (
    next: Pick<AdminInbox, "threadingMode" | "threadBackfill">,
  ) => void;
}

/**
 * The inbox's conversation mode (SPEC-header-threading): by customer or by
 * thread. A change is confirmed, then regroups the inbox's mail in the
 * background; the control shows how far that got and offers a retry when it
 * stopped.
 */
export default function ConversationModeControl({ inbox, onChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backfill = inbox.threadBackfill;
  const running = backfill?.status === "running";
  const failed =
    backfill?.status === "failed" && backfill.mode === inbox.threadingMode;

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      fetchAdminInboxes()
        .then((rows) => {
          const row = rows.find((r) => r.email === inbox.email);
          if (row) {
            onChange({
              threadingMode: row.threadingMode,
              threadBackfill: row.threadBackfill,
            });
          }
        })
        .catch(() => {});
    }, POLL_MS);
    return () => clearInterval(timer);
    // onChange is a fresh closure each render; the poll only needs the inbox.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, inbox.email]);

  async function choose(mode: ThreadingMode, retry = false) {
    if (!retry && mode === inbox.threadingMode) return;
    if (!window.confirm(conversationModeConsequences(mode))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await updateInboxSettings(inbox.email, {
        threadingMode: mode,
      });
      onChange({
        threadingMode: res.threadingMode,
        threadBackfill: res.threadBackfill,
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not change the mode",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1.5 space-y-1">
      <label className="flex items-center gap-1.5 text-[11px] font-medium text-text-secondary">
        Conversations
        <select
          data-testid="inbox-threading-mode"
          aria-label={`Conversations of ${inbox.email}`}
          value={inbox.threadingMode}
          disabled={busy || running}
          onChange={(event) => void choose(event.target.value as ThreadingMode)}
          className="h-6 rounded-[5px] border border-border bg-card px-1 text-[11px] text-text-primary disabled:opacity-60"
        >
          <option value="relationship">By customer</option>
          <option value="headers">By thread</option>
        </select>
      </label>
      {running && (
        <p
          data-testid="inbox-threading-progress"
          className="text-[11px] font-light text-text-tertiary"
        >
          Regrouping… {backfill.processed.toLocaleString()} of{" "}
          {backfill.total.toLocaleString()}
        </p>
      )}
      {failed && (
        <p
          data-testid="inbox-threading-failed"
          className="text-[11px] text-destructive"
        >
          Regrouping stopped part-way.{" "}
          <button
            type="button"
            className="underline"
            disabled={busy}
            onClick={() => void choose(inbox.threadingMode, true)}
          >
            Retry
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="text-[11px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
