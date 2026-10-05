import { useCallback, useEffect, useRef, useState } from "react";
import { useBranding } from "@/lib/branding";
import {
  fetchAdminSettings,
  fetchOutboxCount,
  fetchSendUsage,
  updateAdminSettings,
  type AdminSettings,
  type DailySendLimits,
  type SendChannel,
  type SendUsage,
} from "@/lib/api";
import { formatPausedSince } from "@/components/SendingPausedBanner";

const CHANNELS: { channel: SendChannel; label: string; hint: string }[] = [
  { channel: "web", label: "Web app", hint: "Composer, replies, chat" },
  { channel: "api", label: "API keys", hint: "The HTTP send routes" },
  { channel: "mcp", label: "MCP agents", hint: "Agent send tools" },
  { channel: "jmap", label: "JMAP clients", hint: "Mail apps" },
];

type LimitDrafts = Record<SendChannel, string>;

function toDrafts(limits: DailySendLimits): LimitDrafts {
  return {
    web: limits.web === null ? "" : String(limits.web),
    api: limits.api === null ? "" : String(limits.api),
    mcp: limits.mcp === null ? "" : String(limits.mcp),
    jmap: limits.jmap === null ? "" : String(limits.jmap),
  };
}

/** Blank is unlimited; anything else must be a whole number from 0. */
function parseDrafts(drafts: LimitDrafts): DailySendLimits | string {
  const limits = {} as DailySendLimits;
  for (const { channel, label } of CHANNELS) {
    const raw = drafts[channel].trim();
    if (raw === "") {
      limits[channel] = null;
      continue;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000) {
      return `${label}: enter a whole number from 0 to 1,000,000, or leave it blank for no limit.`;
    }
    limits[channel] = n;
  }
  return limits;
}

/** Settings → Sending (admins): the outbound pause and the daily limits. */
export default function SendingSettings() {
  const { outboundPaused, refresh: refreshBranding } = useBranding();
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [held, setHeld] = useState(0);
  const [usage, setUsage] = useState<SendUsage | null>(null);
  const [drafts, setDrafts] = useState<LimitDrafts | null>(null);
  const [busy, setBusy] = useState<"pause" | "limits" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [loaded, count, today] = await Promise.all([
        fetchAdminSettings(),
        fetchOutboxCount(),
        fetchSendUsage(),
      ]);
      setSettings(loaded);
      setDrafts(toDrafts(loaded.dailySendLimits));
      setHeld(count.held);
      setUsage(today);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not load sending settings.",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Paused or resumed elsewhere (the banner, another admin): reload.
  const firstPauseState = useRef(true);
  useEffect(() => {
    if (firstPauseState.current) {
      firstPauseState.current = false;
      return;
    }
    void load();
  }, [outboundPaused, load]);

  async function togglePause() {
    if (!settings) return;
    setBusy("pause");
    setError(null);
    setSuccess(null);
    try {
      const next = await updateAdminSettings({
        outboundPaused: !settings.outboundPaused,
      });
      setSettings(next);
      setSuccess(
        next.outboundPaused
          ? "Outbound sending is paused. New messages are queued."
          : "Sending resumed. Queued messages are going out now.",
      );
      await refreshBranding();
      const count = await fetchOutboxCount().catch(() => null);
      if (count) setHeld(count.held);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the pause.");
    } finally {
      setBusy(null);
    }
  }

  async function saveLimits() {
    if (!drafts) return;
    const parsed = parseDrafts(drafts);
    setError(null);
    setSuccess(null);
    if (typeof parsed === "string") {
      setError(parsed);
      return;
    }
    setBusy("limits");
    try {
      const next = await updateAdminSettings({ dailySendLimits: parsed });
      setSettings(next);
      setDrafts(toDrafts(next.dailySendLimits));
      setSuccess("Daily limits saved.");
      const today = await fetchSendUsage().catch(() => null);
      if (today) setUsage(today);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the limits.");
    } finally {
      setBusy(null);
    }
  }

  const pause = settings?.outboundPause ?? null;

  return (
    <section className="space-y-3" data-testid="sending-settings">
      <h2 className="text-base font-semibold text-text-primary">Sending</h2>

      <div className="rounded-[8px] bg-card p-5 ring-1 ring-border">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium text-text-primary">
              Pause outbound sending
            </p>
            <p className="text-xs font-light text-text-secondary">
              Stops all outgoing mail without losing any: every message is
              recorded and queued, and goes out when you resume.
            </p>
            {settings && (
              <p
                className="text-xs text-text-secondary"
                data-testid="sending-pause-status"
              >
                {settings.outboundPaused
                  ? `Paused${pause && pause.since > 0 ? ` since ${formatPausedSince(pause.since)}` : ""}${pause?.byLabel ? ` by ${pause.byLabel}` : ""}. ${held} ${held === 1 ? "message" : "messages"} held.`
                  : "Sending is running."}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={togglePause}
            disabled={!settings || busy !== null}
            className="shrink-0 rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy === "pause"
              ? "Saving…"
              : settings?.outboundPaused
                ? "Resume sending"
                : "Pause sending"}
          </button>
        </div>
      </div>

      <div className="rounded-[8px] bg-card p-5 ring-1 ring-border">
        <p className="text-sm font-medium text-text-primary">
          Daily send limits
        </p>
        <p className="mt-1 text-xs font-light text-text-secondary">
          Messages each person may send per UTC day through each channel. Blank:
          no limit. 0: the channel can't send. Campaigns and sequences are not
          counted.
        </p>
        {drafts && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {CHANNELS.map(({ channel, label, hint }) => (
              <div key={channel} className="space-y-1">
                <label
                  htmlFor={`send-limit-${channel}`}
                  className="text-xs font-medium uppercase tracking-wider text-text-tertiary"
                >
                  {label}
                </label>
                <input
                  id={`send-limit-${channel}`}
                  aria-describedby={`send-limit-${channel}-hint`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  placeholder="No limit"
                  value={drafts[channel]}
                  disabled={busy !== null}
                  onChange={(e) =>
                    setDrafts({ ...drafts, [channel]: e.target.value })
                  }
                  className="h-10 w-full rounded-[6px] border border-border bg-bg-subtle px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-text-primary/30"
                />
                <p
                  id={`send-limit-${channel}-hint`}
                  className="text-[11px] font-light text-text-tertiary"
                >
                  {hint}
                </p>
              </div>
            ))}
          </div>
        )}
        <div className="mt-4">
          <button
            type="button"
            onClick={saveLimits}
            disabled={!drafts || busy !== null}
            className="rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy === "limits" ? "Saving…" : "Save limits"}
          </button>
        </div>

        {usage && (
          <div className="mt-5 border-t border-border/60 pt-4">
            <p className="text-xs font-medium uppercase tracking-wider text-text-tertiary">
              Counted today ({usage.day} UTC)
            </p>
            {usage.usage.length === 0 ? (
              <p className="mt-2 text-xs font-light text-text-secondary">
                Nothing counted yet. Only channels with a limit are counted.
              </p>
            ) : (
              <table className="mt-2 w-full text-left text-xs">
                <thead className="text-text-tertiary">
                  <tr>
                    <th className="py-1 font-medium">Person</th>
                    <th className="py-1 font-medium">Channel</th>
                    <th className="py-1 text-right font-medium">Sent</th>
                  </tr>
                </thead>
                <tbody className="text-text-secondary">
                  {usage.usage.map((row) => {
                    const limit = usage.limits[row.channel as SendChannel];
                    return (
                      <tr
                        key={`${row.userId}:${row.channel}`}
                        className="border-t border-border/40"
                      >
                        <td className="max-w-[16rem] truncate py-1.5">
                          {row.email ?? row.userId}
                        </td>
                        <td className="py-1.5">
                          {CHANNELS.find((c) => c.channel === row.channel)
                            ?.label ?? row.channel}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {row.count}
                          {limit !== null && limit !== undefined
                            ? ` / ${limit}`
                            : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {error && (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p
          role="status"
          className="text-xs text-emerald-600"
          data-testid="sending-success"
        >
          {success}
        </p>
      )}
    </section>
  );
}
