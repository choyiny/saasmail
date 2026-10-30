import { useState } from "react";
import { Link } from "react-router-dom";
import {
  resetSpamFilter,
  setSpamFilter,
  type AdminInbox,
  type SpamFilterStatus,
} from "@/lib/api";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** An inbox's learning spam filter: on/off, progress, the junk rule, reset. */
export default function SpamFilterControls({
  inbox,
  hasJunkRule,
  onChange,
}: {
  inbox: AdminInbox;
  /** A rule already acts on this inbox's spam probability. */
  hasJunkRule: boolean;
  onChange: (filter: SpamFilterStatus) => void;
}) {
  // An inbox created in this session has no status from the server yet.
  const filter = inbox.spamFilter ?? {
    enabled: false,
    spamMessages: 0,
    hamMessages: 0,
    ready: false,
  };
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<SpamFilterStatus>, failure: string) {
    setBusy(true);
    try {
      onChange(await action());
    } catch (error) {
      showToast({
        kind: "error",
        message: failure,
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  const status = !filter.enabled
    ? "Off"
    : filter.ready
      ? "Scoring new mail"
      : `Learning — ${filter.spamMessages} of 20 junk, ${filter.hamMessages} of 20 not-junk examples`;

  return (
    <div className="mt-2 space-y-1.5" data-testid="spam-filter-controls">
      <label className="flex items-center gap-2 text-[11px] font-medium text-text-secondary">
        <button
          type="button"
          role="switch"
          aria-checked={filter.enabled}
          aria-label={`Learn from junk marks for ${inbox.email}`}
          disabled={busy}
          onClick={() =>
            void run(
              () => setSpamFilter(inbox.email, !filter.enabled),
              "Couldn’t change the learning filter",
            )
          }
          className={cn(
            "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-60",
            filter.enabled
              ? "bg-text-primary"
              : "bg-bg-muted ring-1 ring-border",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 h-4 w-4 rounded-full bg-card shadow-sm transition-transform",
              filter.enabled ? "translate-x-4" : "translate-x-0.5",
            )}
          />
        </button>
        Learn from junk marks
      </label>
      <p
        className="text-[11px] text-text-tertiary"
        data-testid="spam-filter-status"
      >
        {status}
      </p>
      <div className="flex flex-wrap gap-2 text-[11px]">
        {filter.enabled &&
          (hasJunkRule ? (
            <span className="text-text-tertiary">Junk rule in place</span>
          ) : (
            <Link
              to={`/automations?prefill=junk&inbox=${encodeURIComponent(inbox.email)}`}
              className="font-medium text-text-primary underline-offset-2 hover:underline"
            >
              Create the junk rule
            </Link>
          ))}
        {/* What it learned stays when it is off: reset is offered either way. */}
        {(filter.spamMessages > 0 || filter.hamMessages > 0) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  `Forget everything the filter learned for ${inbox.email}?`,
                )
              ) {
                return;
              }
              void run(
                () => resetSpamFilter(inbox.email),
                "Couldn’t reset the learning filter",
              );
            }}
            className="text-text-tertiary hover:text-red-600 disabled:opacity-60"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
