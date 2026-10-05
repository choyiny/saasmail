import type {
  CampaignLinkStat,
  CampaignStats,
  CampaignTimeseriesPoint,
} from "@/lib/api";

function pct(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function Tile({
  label,
  value,
  sub,
  hint,
}: {
  label: string;
  value: string;
  sub?: string;
  hint?: string;
}) {
  return (
    <div className="rounded-[8px] bg-card p-4 ring-1 ring-border" title={hint}>
      <p className="text-[11px] uppercase tracking-wide text-text-tertiary">
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-text-primary">
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-text-tertiary">{sub}</p>}
    </div>
  );
}

export function CampaignStatsGrid({ stats }: { stats: CampaignStats }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      <Tile
        label="Sent"
        value={String(stats.delivered)}
        sub={`of ${stats.targeted} targeted`}
        hint="Delivered and targeted are shown separately so 'sent' never conflates the two."
      />
      <Tile
        label="~Opened"
        value={String(stats.uniqueOpeners)}
        sub={pct(stats.uniqueOpeners, stats.delivered)}
        hint="Approximate. Apple Mail Privacy Protection pre-fetches every tracking pixel, which inflates this."
      />
      <Tile
        label="~Clicked"
        value={String(stats.uniqueClicks)}
        sub={pct(stats.uniqueClicks, stats.delivered)}
        hint="Approximate. Some corporate proxies pre-fetch links. Clicks and unique clickers are the same number here by construction."
      />
      <Tile
        label="Unsubscribed"
        value={String(stats.unsubscribes)}
        sub={pct(stats.unsubscribes, stats.delivered)}
      />
      <Tile
        label="Bounces"
        value="—"
        hint="Requires bounce webhooks, which this version does not have."
      />
      <Tile
        label="Complaints"
        value="—"
        hint="Requires complaint webhooks, which this version does not have."
      />
    </div>
  );
}

/**
 * A 24-hour opens/clicks chart, drawn as inline SVG.
 *
 * Hand-drawn rather than pulling in a charting library: two series over a fixed
 * 24 buckets is not enough chart to justify the dependency, and the data is
 * already zero-filled server-side so there are no gaps to reason about.
 */
export function CampaignTimeseriesChart({
  data,
}: {
  data: CampaignTimeseriesPoint[];
}) {
  const width = 640;
  const height = 160;
  const pad = 24;
  const max = Math.max(1, ...data.flatMap((d) => [d.opens, d.clicks]));

  const path = (key: "opens" | "clicks") =>
    data
      .map((d, i) => {
        const x = pad + (i / Math.max(1, data.length - 1)) * (width - pad * 2);
        const y = height - pad - (d[key] / max) * (height - pad * 2);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  const empty = data.every((d) => d.opens === 0 && d.clicks === 0);

  return (
    <div className="rounded-[8px] bg-card p-4 ring-1 ring-border">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-wide text-text-tertiary">
          First 24 hours
        </p>
        <div className="flex items-center gap-3 text-[11px] text-text-tertiary">
          <span className="inline-flex items-center gap-1">
            <span
              className="inline-block h-0.5 w-3"
              style={{ background: "#7c5cfc" }}
            />
            opens
          </span>
          <span className="inline-flex items-center gap-1">
            <span
              className="inline-block h-0.5 w-3"
              style={{ background: "#15803d" }}
            />
            clicks
          </span>
        </div>
      </div>
      {empty ? (
        <p className="py-10 text-center text-xs text-text-tertiary">
          No opens or clicks recorded yet.
        </p>
      ) : (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full"
          role="img"
          aria-label="Opens and clicks over the first 24 hours"
        >
          <path
            d={path("opens")}
            fill="none"
            stroke="#7c5cfc"
            strokeWidth="2"
          />
          <path
            d={path("clicks")}
            fill="none"
            stroke="#15803d"
            strokeWidth="2"
          />
        </svg>
      )}
    </div>
  );
}

export function CampaignLinksTable({ links }: { links: CampaignLinkStat[] }) {
  if (links.length === 0) {
    return (
      <div className="rounded-[8px] bg-card p-8 text-center ring-1 ring-border">
        <p className="text-xs text-text-tertiary">
          This campaign has no tracked links.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
      <table className="w-full text-sm">
        <thead className="bg-bg-muted/50 text-left text-[11px] uppercase tracking-wide text-text-tertiary">
          <tr>
            <th className="px-4 py-2 font-medium">URL</th>
            <th className="px-4 py-2 font-medium">~Clicks</th>
            <th className="px-4 py-2 font-medium">Rate</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {links.map((l) => (
            <tr key={l.url}>
              <td className="max-w-0 truncate px-4 py-2.5 text-text-primary">
                <span title={l.url}>{l.url}</span>
              </td>
              <td className="px-4 py-2.5 tabular-nums text-text-secondary">
                {l.clicks}
              </td>
              <td className="px-4 py-2.5 tabular-nums text-text-tertiary">
                {(l.clickRate * 100).toFixed(1)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
