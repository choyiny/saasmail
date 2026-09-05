import { useCallback, useEffect, useRef, useState } from "react";
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
  updateCampaign,
  type CampaignDetail,
  type CampaignLinkStat,
  type CampaignTimeseriesPoint,
} from "@/lib/api";
import { PageContainer } from "@/components/PageHeader";
import BlockEditor from "@/components/blocks/BlockEditor";
import HtmlCodeEditor from "@/components/HtmlCodeEditor";
import type { BlockDocument } from "@worker/lib/blocks/schema";
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

  // Draft body editing. Held locally and saved explicitly rather than on every
  // keystroke: each save recompiles server-side, and a campaign is not a
  // document people expect to autosave mid-sentence.
  const [draftSubject, setDraftSubject] = useState("");
  const [draftJson, setDraftJson] = useState<BlockDocument | null>(null);
  const [draftHtml, setDraftHtml] = useState("");
  const [savingBody, setSavingBody] = useState(false);
  const [bodyError, setBodyError] = useState("");
  const [bodySaved, setBodySaved] = useState(false);
  const [series, setSeries] = useState<CampaignTimeseriesPoint[]>([]);
  const [links, setLinks] = useState<CampaignLinkStat[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  // The preview renders at the bottom of a long page, so on anything but a
  // tall screen "Preview" appeared to do nothing at all. Scroll it into view
  // when it opens rather than leaving the operator to guess there is
  // something below the fold.
  useEffect(() => {
    if (preview === null) return;
    previewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [preview]);
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
    setDraftSubject(c.subject);
    setDraftJson(c.bodyJson ?? null);
    setDraftHtml(c.bodyHtml ?? "");
    setSeries(t.data);
    setLinks(l.data);
  }, [id]);

  const saveBody = useCallback(async () => {
    if (!campaign) return;
    setSavingBody(true);
    setBodyError("");
    setBodySaved(false);
    try {
      // A block campaign never sends `bodyHtml` — the server compiles it, and
      // the API refuses a client-supplied one so the two cannot drift.
      await updateCampaign(campaign.id, {
        subject: draftSubject,
        ...(campaign.format === "block"
          ? { format: "block" as const, bodyJson: draftJson ?? undefined }
          : { bodyHtml: draftHtml }),
      });
      await load();
      setBodySaved(true);
    } catch {
      setBodyError("Could not save. Check the content and try again.");
    } finally {
      setSavingBody(false);
    }
  }, [campaign, draftSubject, draftJson, draftHtml, load]);

  /** Turn a blank campaign into a block campaign. Only offered while empty. */
  const useBlocks = useCallback(async () => {
    if (!campaign) return;
    setBodyError("");
    try {
      await updateCampaign(campaign.id, {
        format: "block",
        bodyJson: { version: 1, blocks: [] } as BlockDocument,
      });
      await load();
    } catch {
      setBodyError("Could not switch to blocks.");
    }
  }, [campaign, load]);

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
            {campaign.subject}
            {campaign.templateSlug ? ` · from ${campaign.templateSlug}` : ""}
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

      {isDraft && (
        <section className="mb-5 overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-text-primary">
                Content
              </h2>
              <p className="mt-0.5 text-xs font-light text-text-secondary">
                This campaign's own copy. Frozen when it sends.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {bodySaved && !savingBody && (
                <span className="text-[11px] text-text-tertiary">Saved</span>
              )}
              <button
                type="button"
                onClick={() => void saveBody()}
                disabled={savingBody}
                className="rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
              >
                {savingBody ? "Saving…" : "Save"}
              </button>
            </div>
          </div>

          {bodyError && (
            <p
              role="alert"
              className="border-b border-border bg-red-500/5 px-5 py-2 text-xs text-red-600 dark:text-red-400"
            >
              {bodyError}
            </p>
          )}

          <div className="border-b border-border px-5 py-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-text-secondary">
                Subject line
              </span>
              <input
                value={draftSubject}
                onChange={(e) => setDraftSubject(e.target.value)}
                className="w-full rounded-[6px] border border-border bg-card px-3 py-2 text-sm"
              />
            </label>
          </div>

          {campaign.format === "block" ? (
            <div className="flex min-h-[420px] flex-col">
              <BlockEditor value={draftJson} onChange={setDraftJson} />
            </div>
          ) : draftHtml.trim() === "" ? (
            /* A blank campaign has nothing to lose, so this is the one moment
               the choice is open — the server refuses html → block once there
               is content, because parsing it back would be lossy. */
            <div className="px-5 py-8 text-center">
              <p className="mb-3 text-sm text-text-secondary">
                How do you want to write this campaign?
              </p>
              <div className="flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => void useBlocks()}
                  className="rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-white"
                >
                  Use blocks
                </button>
                <button
                  type="button"
                  onClick={() => setDraftHtml("<p></p>")}
                  className="rounded-[6px] border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-muted"
                >
                  Write HTML
                </button>
              </div>
            </div>
          ) : (
            <div className="h-[420px]">
              <HtmlCodeEditor value={draftHtml} onChange={setDraftHtml} />
            </div>
          )}
        </section>
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
        <div ref={previewRef} className="mt-5 scroll-mt-4">
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
