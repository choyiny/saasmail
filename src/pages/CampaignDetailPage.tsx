import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AlertTriangle, ChevronLeft } from "lucide-react";
import {
  cancelCampaign,
  deleteCampaign,
  fetchCampaign,
  fetchCampaignLinks,
  fetchCampaignPreview,
  fetchCampaignTimeseries,
  retryCampaign,
  scheduleCampaign,
  sendCampaign,
  testSendCampaign,
  type CampaignDetail,
  type CampaignLinkStat,
  type CampaignTimeseriesPoint,
} from "@/lib/api";
import { PageContainer } from "@/components/PageHeader";
import {
  CampaignLinksTable,
  CampaignStatsGrid,
  CampaignTimeseriesChart,
} from "@/components/CampaignStatsCard";
import { STATUS_STYLE, statusLabel } from "./CampaignsPage";

/**
 * Statuses that mean "this needs a human to look at it".
 *
 * Each gets a banner rather than only a status chip: an overdue or stalled
 * campaign is a send that did not happen, and the only thing worse than one is
 * one nobody noticed.
 */
const BANNERS: Partial<Record<CampaignDetail["status"], string>> = {
  overdue:
    "This campaign was scheduled more than 24 hours ago and did not fire. It was held rather than sent, so nothing went out on a schedule everyone had forgotten. Send it now if it is still relevant.",
  stalled:
    "This campaign stopped part-way and has not moved in 24 hours. Retry re-attempts only the recoverable recipients — nobody who already received it will get it twice.",
  completed_with_failures:
    "The campaign finished, but some recipients were permanently rejected. Retry re-attempts only the recoverable ones.",
};

export default function CampaignDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [series, setSeries] = useState<CampaignTimeseriesPoint[]>([]);
  const [links, setLinks] = useState<CampaignLinkStat[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scheduleAt, setScheduleAt] = useState("");

  const load = useCallback(async () => {
    const [c, t, l] = await Promise.all([
      fetchCampaign(id),
      fetchCampaignTimeseries(id).catch(() => ({ data: [] })),
      fetchCampaignLinks(id).catch(() => ({ data: [] })),
    ]);
    setCampaign(c);
    setSeries(t.data);
    setLinks(l.data);
  }, [id]);

  useEffect(() => {
    load()
      .catch(() => setCampaign(null))
      .finally(() => setLoading(false));
  }, [load]);

  // A campaign in flight changes underneath the page; anything terminal does
  // not, so polling stops rather than running forever on a finished send.
  useEffect(() => {
    if (!campaign) return;
    if (!["preparing", "sending"].includes(campaign.status)) return;
    const timer = setInterval(() => void load().catch(() => {}), 30_000);
    return () => clearInterval(timer);
  }, [campaign, load]);

  async function act(fn: () => Promise<unknown>, failure: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <PageContainer>
        <p className="text-sm font-light text-text-tertiary">Loading…</p>
      </PageContainer>
    );
  }

  if (!campaign) {
    return (
      <PageContainer>
        <p className="text-sm text-text-tertiary">
          This campaign doesn't exist, or you don't have access to it.
        </p>
      </PageContainer>
    );
  }

  const isDraft = campaign.status === "draft";
  const canSend = ["draft", "scheduled", "overdue"].includes(campaign.status);
  const canCancel = [
    "draft",
    "scheduled",
    "overdue",
    "preparing",
    "sending",
  ].includes(campaign.status);
  const canRetry = ["stalled", "completed_with_failures"].includes(
    campaign.status,
  );
  const banner = BANNERS[campaign.status];

  return (
    <PageContainer>
      <Link
        to="/campaigns"
        className="mb-4 inline-flex items-center gap-1 text-xs font-medium text-text-tertiary hover:text-text-primary"
      >
        <ChevronLeft size={12} />
        Campaigns
      </Link>

      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-text-primary">
              {campaign.name}
            </h1>
            <span
              data-testid="campaign-status"
              className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLE[campaign.status]}`}
            >
              {statusLabel(campaign.status)}
            </span>
          </div>
          <p className="mt-1 text-sm font-light text-text-tertiary">
            {campaign.subject} · template {campaign.templateSlug}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() =>
              act(async () => {
                const p = await fetchCampaignPreview(id);
                setPreview(p.html);
              }, "Could not render a preview.")
            }
            disabled={busy}
            className="rounded-[6px] px-3 py-2 text-xs font-medium text-text-secondary ring-1 ring-border hover:bg-bg-muted disabled:opacity-50"
          >
            Preview
          </button>
          {canSend && (
            <button
              onClick={() =>
                act(() => testSendCampaign(id), "Could not send the test copy.")
              }
              disabled={busy}
              className="rounded-[6px] px-3 py-2 text-xs font-medium text-text-secondary ring-1 ring-border hover:bg-bg-muted disabled:opacity-50"
            >
              Test send
            </button>
          )}
          {canSend && (
            <button
              data-testid="campaign-send"
              onClick={() => {
                if (
                  !confirm(
                    `Send "${campaign.name}" to every subscribed member of its list? This cannot be undone once it starts.`,
                  )
                ) {
                  return;
                }
                void act(() => sendCampaign(id), "Could not start the send.");
              }}
              disabled={busy}
              className="rounded-[6px] bg-text-primary px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
            >
              Send now
            </button>
          )}
          {canRetry && (
            <button
              onClick={() =>
                act(() => retryCampaign(id), "Could not retry the campaign.")
              }
              disabled={busy}
              className="rounded-[6px] bg-text-primary px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
            >
              Retry failures
            </button>
          )}
          {canCancel && (
            <button
              onClick={() =>
                act(() => cancelCampaign(id), "Could not cancel the campaign.")
              }
              disabled={busy}
              className="rounded-[6px] px-3 py-2 text-xs font-medium text-text-secondary ring-1 ring-border hover:bg-bg-muted disabled:opacity-50"
            >
              Cancel
            </button>
          )}
          {isDraft && (
            <button
              onClick={() => {
                if (!confirm("Delete this draft?")) return;
                void act(async () => {
                  await deleteCampaign(id);
                  navigate("/campaigns");
                }, "Could not delete the campaign.");
              }}
              disabled={busy}
              className="rounded-[6px] px-3 py-2 text-xs font-medium text-red-600 ring-1 ring-border hover:bg-red-500/5 disabled:opacity-50"
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {banner && (
        <div className="mb-4 flex items-start gap-2 rounded-[8px] bg-amber-500/10 p-3 text-xs text-amber-800">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <p>{banner}</p>
        </div>
      )}

      {error && <p className="mb-4 text-xs text-red-600">{error}</p>}

      {(isDraft || campaign.status === "scheduled") && (
        <div className="mb-5 flex flex-wrap items-end gap-2 rounded-[8px] bg-card p-3 ring-1 ring-border">
          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-wide text-text-tertiary">
              Schedule for
            </span>
            <input
              type="datetime-local"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
              className="rounded-[6px] border border-border bg-card px-3 py-2 text-sm"
            />
          </label>
          <button
            disabled={busy || scheduleAt === ""}
            onClick={() =>
              act(
                () =>
                  scheduleCampaign(
                    id,
                    Math.floor(new Date(scheduleAt).getTime() / 1000),
                  ),
                "Could not schedule. A time in the past is refused — a mistyped date should not send a list.",
              )
            }
            className="rounded-[6px] px-3 py-2 text-xs font-medium text-text-secondary ring-1 ring-border hover:bg-bg-muted disabled:opacity-50"
          >
            Schedule
          </button>
          {campaign.scheduledAt && (
            <p className="text-xs text-text-tertiary">
              Currently scheduled for{" "}
              {new Date(campaign.scheduledAt * 1000).toLocaleString()}
            </p>
          )}
        </div>
      )}

      <div className="space-y-5">
        <CampaignStatsGrid stats={campaign.stats} />
        <CampaignTimeseriesChart data={series} />
        <div>
          <p className="mb-2 text-[11px] uppercase tracking-wide text-text-tertiary">
            Links
          </p>
          <CampaignLinksTable links={links} />
        </div>
      </div>

      {preview !== null && (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] uppercase tracking-wide text-text-tertiary">
              Preview
            </p>
            <button
              onClick={() => setPreview(null)}
              className="text-xs text-text-tertiary hover:text-text-primary"
            >
              Close
            </button>
          </div>
          {/* Rendered in a sandboxed frame: this is operator-authored HTML, but
              it is still a whole document being injected into the admin app. */}
          <iframe
            title="Campaign preview"
            sandbox=""
            srcDoc={preview}
            className="h-[600px] w-full rounded-[8px] bg-white ring-1 ring-border"
          />
        </div>
      )}
    </PageContainer>
  );
}
