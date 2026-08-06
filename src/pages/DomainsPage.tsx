import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Globe,
  HelpCircle,
  Mail,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { fetchDomains } from "@/lib/api";
import type { DnsRecord, DnsState, Domain } from "@/lib/api";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { CodeBlock, SectionHeader } from "@/components/PageForm";
import { cn } from "@/lib/utils";

// Cloudflare resolves `:account` and `:zone` for whoever is signed in, so no ids of ours are needed.
const CLOUDFLARE_EMAIL_ROUTING =
  "https://dash.cloudflare.com/?to=/:account/email-service/routing";
const CLOUDFLARE_DNS_RECORDS =
  "https://dash.cloudflare.com/?to=/:account/:zone/dns/records";

type Tone = "success" | "warning" | "danger" | "muted";

const TONE_CHIP: Record<Tone, string> = {
  success: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  warning: "bg-amber-50 text-amber-700 ring-amber-200",
  danger: "bg-rose-50 text-rose-700 ring-rose-200",
  muted: "bg-bg-muted text-text-secondary ring-border",
};

// "unknown" is muted, never red: a resolver that did not answer accuses nobody.
function routingStatus(routing: DnsState): {
  label: string;
  tone: Tone;
  icon: React.ElementType;
} {
  if (routing === "cloudflare")
    return { label: "Receiving mail", tone: "success", icon: CheckCircle2 };
  if (routing === "elsewhere")
    return {
      label: "MX points elsewhere",
      tone: "warning",
      icon: AlertTriangle,
    };
  if (routing === "none")
    return { label: "No MX record", tone: "danger", icon: XCircle };
  return { label: "Couldn't check", tone: "muted", icon: HelpCircle };
}

function routingDetail(routing: DnsState, mx: string[]): string {
  if (routing === "cloudflare")
    return `Cloudflare accepts mail for this domain at ${mx.join(", ")}. Whether it then reaches this deployment is the Email Routing rule below, which DNS cannot show.`;
  if (routing === "elsewhere")
    return `Mail for this domain is delivered to ${mx.join(", ")}, not here, so nothing sent to it reaches this deployment.`;
  if (routing === "none")
    return "Nothing accepts mail for this domain, so every message sent to it bounces.";
  return "The DNS lookup did not finish, so this says nothing about the domain either way.";
}

function spfDetail(spf: DnsState): string {
  if (spf === "cloudflare")
    return "SPF authorises Cloudflare to send for this domain.";
  if (spf === "elsewhere") return "SPF exists but does not include Cloudflare.";
  if (spf === "none")
    return "No SPF record, so mail sent from here is likelier to be filtered.";
  return "The SPF lookup did not finish.";
}

function dkimDetail(dkim: DnsState): string {
  if (dkim === "cloudflare")
    return "Cloudflare's DKIM key is published, so outbound mail is signed.";
  if (dkim === "elsewhere")
    return "A DKIM record is there but is not the key Cloudflare expects.";
  if (dkim === "none") return "No DKIM record at Cloudflare's selector.";
  return "The DKIM lookup did not finish.";
}

export default function DomainsPage() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";
  const [domains, setDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    setError(null);
    try {
      setDomains(await fetchDomains());
    } catch {
      setError("Failed to load domains.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  // The endpoint is admin-only, so a member landing here would only collect a 403.
  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin]);

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return (
    <PageContainer>
      <PageHeader
        title="Domains"
        subtitle="Every domain this deployment handles mail for, with its MX, SPF and DKIM read live over DNS."
        action={
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-[8px] bg-text-primary px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-text-primary/90 disabled:opacity-60"
          >
            <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
            Check DNS again
          </button>
        }
      />

      <div className="max-w-4xl space-y-6">
        {error && (
          <div className="rounded-[8px] bg-rose-50/60 px-5 py-2 text-xs font-medium text-rose-700 ring-1 ring-rose-200">
            {error}
          </div>
        )}

        {loading ? (
          <p className="text-xs font-light text-text-tertiary">Loading…</p>
        ) : (
          <>
            {domains.map((domain) => (
              <DomainCard key={domain.domain} domain={domain} />
            ))}

            {!error && (
              <p className="text-xs font-light text-text-tertiary">
                {domains.length === 0
                  ? "No domains yet. One appears here as soon as an address under it receives mail or is set up as a sender."
                  : "Answers are cached for a minute, so a record you have just fixed can take that long to show up."}
              </p>
            )}

            <CloudflareSection />
          </>
        )}
      </div>
    </PageContainer>
  );
}

function DomainCard({ domain }: { domain: Domain }) {
  const { dns } = domain;
  const status = routingStatus(dns.routing);
  const StatusIcon = status.icon;

  // The worker already merged SPF and decided add-vs-replace; recomputing here put the merged SPF string into the DKIM row.
  const records = dns.missingRecords;

  // An empty `missingRecords` is not "all good" while any lookup is unknown.
  const unchecked =
    dns.routing === "unknown" ||
    dns.spf === "unknown" ||
    dns.dkim === "unknown";

  return (
    <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Globe size={14} className="shrink-0 text-text-tertiary" />
          <h2 className="text-sm font-semibold text-text-primary">
            {domain.domain}
          </h2>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1",
              TONE_CHIP[status.tone],
            )}
          >
            <StatusIcon size={10} />
            {status.label}
          </span>
        </div>

        <p className="mt-2 text-xs font-light text-text-secondary">
          {routingDetail(dns.routing, dns.mx)}
        </p>
        <p className="mt-1 text-xs font-light text-text-tertiary">
          {spfDetail(dns.spf)} {dkimDetail(dns.dkim)}
        </p>
        <p className="mt-1 text-xs font-light text-text-tertiary">
          {domain.inboxCount === 1 ? "1 inbox" : `${domain.inboxCount} inboxes`}{" "}
          ·{" "}
          {domain.messageCount === 0
            ? "nothing received yet"
            : `${domain.messageCount} received`}
        </p>
      </div>

      {records.length > 0 ? (
        <>
          <div className="border-b border-border px-5 py-4">
            <SectionHeader
              title="Records still needed"
              subtitle="Add these at your DNS provider — the values are ready to paste."
            />
            <div className="mt-3 space-y-4">
              {records.map((record) => (
                <RecordRow
                  key={`${record.type}:${record.name}:${record.value ?? "?"}`}
                  record={record}
                />
              ))}
            </div>

            {dns.routing === "elsewhere" && (
              <p className="mt-3 text-xs font-light text-amber-700">
                This domain already has MX records pointing at{" "}
                {dns.mx.join(", ")}. Adding these alongside them splits delivery
                between the two, so remove the old ones once Cloudflare is
                receiving.
              </p>
            )}
            {dns.spf === "elsewhere" && dns.spfRecord && (
              <p className="mt-2 text-xs font-light text-amber-700">
                Edit the TXT record this domain already has to read as above —
                the value shown already merges it. Adding a second breaks both:
                SPF allows only one record per name. The current one is{" "}
                <span className="font-mono">{dns.spfRecord}</span>.
              </p>
            )}
            {records.some((record) => record.type === "MX") && (
              <p className="mt-2 text-xs font-light text-text-tertiary">
                MX priorities are left to Cloudflare, which assigns them per
                zone, so there is nothing to enter for them.
              </p>
            )}
          </div>

          <ExternalRow
            label="Open DNS records in Cloudflare"
            detail={`Switch to ${domain.domain} if another zone opens`}
            url={CLOUDFLARE_DNS_RECORDS}
          />
        </>
      ) : (
        <p className="px-5 py-4 text-xs font-light text-text-tertiary">
          {unchecked
            ? "Nothing to add from what was read, but part of this lookup did not finish, so this is not an all-clear. Check again in a moment."
            : "Nothing left to add in DNS. Mail still only arrives once the Email Routing catch-all below is Active."}
        </p>
      )}
    </section>
  );
}

function RecordRow({ record }: { record: DnsRecord }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium text-text-tertiary">
        {record.action === "replace" ? "Replace" : "Add"} {record.type} ·{" "}
        <span className="font-mono">{record.name}</span>
        {record.type === "MX" ? " · priority auto" : ""}
      </p>
      {/* No copy button without a value: DKIM's key is generated per zone and arrives null. */}
      {record.value ? (
        <CodeBlock value={record.value} oneLine />
      ) : (
        <p className="rounded-[6px] border border-border bg-bg-subtle/60 p-3 text-[11px] font-light leading-relaxed text-text-secondary">
          {record.note ?? "Value provided by Cloudflare."}
        </p>
      )}
    </div>
  );
}

function CloudflareSection() {
  return (
    <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
      <div className="border-b border-border px-5 py-4">
        <SectionHeader
          icon={Mail}
          title="Cloudflare Email Routing"
          subtitle="DNS is only half of it — this is the half that gets missed."
        />
      </div>

      <ExternalRow
        label="Open Email Routing in Cloudflare"
        detail="Pick this deployment's domain, then Routing Rules"
        url={CLOUDFLARE_EMAIL_ROUTING}
      />

      <div className="space-y-2 border-t border-border px-5 py-4">
        <p className="text-xs font-light text-text-secondary">
          DNS only gets mail as far as Cloudflare. Email Routing then needs its
          catch-all rule Active with the action{" "}
          <span className="font-medium text-text-primary">
            Send to a Worker
          </span>
          , pointed at this deployment's Worker — until it is, every message
          bounces with 550 5.1.1 however correct the records above look.
        </p>
        <p className="text-xs font-light text-text-secondary">
          That last step is the one that gets missed: wrangler will not set a
          Worker as the catch-all action, so it can only be done in the
          dashboard.
        </p>
      </div>
    </section>
  );
}

function ExternalRow({
  label,
  detail,
  url,
}: {
  label: string;
  detail: string;
  url: string;
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-bg-muted"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-muted">
        <ArrowUpRight size={14} className="text-text-tertiary" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text-primary">
          {label}
        </span>
        <span className="block truncate text-xs font-light text-text-tertiary">
          {detail}
        </span>
      </span>
    </a>
  );
}
