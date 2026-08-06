/**
 * Live DNS status for a domain, read over DNS-over-HTTPS.
 *
 * Workers have no raw DNS, so this asks Cloudflare's resolver over HTTPS for the
 * three records Email Routing needs: MX, SPF, and the routing DKIM key. Every
 * failure path answers "unknown" rather than "misconfigured" — telling an
 * operator their DNS is broken when the resolver simply did not answer sends
 * them to edit records that were already correct.
 */

export type MxRouting = "cloudflare" | "elsewhere" | "none" | "unknown";
export type SpfState = "cloudflare" | "elsewhere" | "none" | "unknown";
export type DkimState = "cloudflare" | "elsewhere" | "none" | "unknown";

export interface DnsRecord {
  name: string;
  type: "MX" | "TXT";
  /** `null` when the value is per-zone and only Cloudflare can supply it. */
  value: string | null;
  /** "replace" means edit the record that is already there, never add a second. */
  action: "add" | "replace";
  note: string | null;
}

export interface DomainDns {
  routing: MxRouting;
  /** MX hosts actually observed, so "elsewhere" can say where. */
  mx: string[];
  spf: SpfState;
  spfRecord: string | null;
  dkim: DkimState;
  /** Records the operator still has to add. A check that answered "unknown" contributes none. */
  missingRecords: DnsRecord[];
}

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

// Answers live in `caches.default` for 60 seconds. A dashboard refresh reuses
// them instead of re-querying the resolver, and a record the operator has just
// fixed still shows up within the minute.
const CACHE_TTL_SECONDS = 60;

const CLOUDFLARE_MX_SUFFIX = ".mx.cloudflare.net";
const CLOUDFLARE_SPF_INCLUDE = "_spf.mx.cloudflare.net";
const CLOUDFLARE_MX_HOSTS = [
  "route1.mx.cloudflare.net",
  "route2.mx.cloudflare.net",
  "route3.mx.cloudflare.net",
];
const CLOUDFLARE_SPF_VALUE = `v=spf1 include:${CLOUDFLARE_SPF_INCLUDE} ~all`;
// Email Routing's own selector, not Email Sending's `cf-bounce._domainkey`.
const CLOUDFLARE_DKIM_SELECTOR = "cf2024-1._domainkey";
const DKIM_NOTE =
  "Copy this value from Email Routing → Settings in the Cloudflare dashboard — the public key is generated per domain.";
const MX_REPLACE_NOTE =
  "Email Routing needs these to be the only MX records on the domain; remove the existing ones.";

const RECORD_TYPE = { MX: 15, TXT: 16 } as const;
const DNS_NOERROR = 0;
const DNS_NXDOMAIN = 3;

interface DohAnswer {
  name: string;
  type: number;
  data: string;
}

interface DohResponse {
  Status: number;
  Answer?: DohAnswer[];
}

/** `null` means "could not check", which is never the same as "no records". */
async function query(
  domain: string,
  type: "MX" | "TXT",
): Promise<DohAnswer[] | null> {
  const key = new Request(
    `${DOH_ENDPOINT}?name=${encodeURIComponent(domain)}&type=${type}`,
    { headers: { Accept: "application/dns-json" } },
  );

  let body: string;
  // A body can reject after its headers arrived, so the reads stay in the catch.
  try {
    const cached = await caches.default.match(key);
    if (cached) {
      body = await cached.text();
    } else {
      const res = await fetch(key);
      if (!res.ok) return null;
      body = await res.text();
      await caches.default.put(
        key,
        new Response(body, {
          headers: {
            "Content-Type": "application/dns-json",
            "Cache-Control": `max-age=${CACHE_TTL_SECONDS}`,
          },
        }),
      );
    }
  } catch {
    return null;
  }

  let parsed: DohResponse;
  try {
    parsed = JSON.parse(body) as DohResponse;
  } catch {
    return null;
  }
  if (parsed.Status === DNS_NXDOMAIN) return [];
  if (parsed.Status !== DNS_NOERROR) return null;
  return (parsed.Answer ?? []).filter((a) => a.type === RECORD_TYPE[type]);
}

/** MX data is `"<priority> <host>."` — we only care about the host. */
function mxHost(answer: DohAnswer): string {
  const host = answer.data.trim().split(/\s+/).pop() ?? "";
  return host.replace(/\.$/, "").toLowerCase();
}

/** A long TXT value arrives as several quoted strings that join with no separator; a real DKIM key always is one. */
function txtValue(answer: DohAnswer): string {
  const chunks = answer.data.match(/"[^"]*"/g);
  if (chunks === null) return answer.data.trim();
  return chunks.map((c) => c.slice(1, -1)).join("");
}

function spfTerms(record: string): string[] {
  return record.trim().split(/\s+/);
}

/** Matches the whole term, so `include:_spf.mx.cloudflare.net.example` does not read as ours. */
function isCloudflareInclude(term: string): boolean {
  return (
    term.toLowerCase().replace(/^[-~?+]/, "") ===
    `include:${CLOUDFLARE_SPF_INCLUDE}`
  );
}

const SPF_ALL = /^[-~?+]?all$/i;

/** Splices the include in before `all`; the qualifier stays as written, since `-all` → `~all` weakens a chosen policy. */
function mergeSpf(existing: string): string {
  const terms = spfTerms(existing);
  const allAt = terms.findIndex((t) => SPF_ALL.test(t));
  const include = `include:${CLOUDFLARE_SPF_INCLUDE}`;
  if (allAt === -1) terms.push(include);
  else terms.splice(allAt, 0, include);
  return terms.join(" ");
}

export async function lookupDomainDns(domain: string): Promise<DomainDns> {
  const dkimName = `${CLOUDFLARE_DKIM_SELECTOR}.${domain}`;
  const [mxAnswers, txtAnswers, dkimAnswers] = await Promise.all([
    query(domain, "MX"),
    query(domain, "TXT"),
    query(dkimName, "TXT"),
  ]);

  const mx = (mxAnswers ?? []).map(mxHost);
  const routing: MxRouting =
    mxAnswers === null
      ? "unknown"
      : mx.length === 0
        ? "none"
        : mx.some((h) => h.endsWith(CLOUDFLARE_MX_SUFFIX))
          ? "cloudflare"
          : "elsewhere";

  const spfRecord =
    txtAnswers
      ?.map(txtValue)
      .find((v) => v.toLowerCase().startsWith("v=spf1")) ?? null;
  const spf: SpfState =
    txtAnswers === null
      ? "unknown"
      : spfRecord === null
        ? "none"
        : spfTerms(spfRecord).some(isCloudflareInclude)
          ? "cloudflare"
          : "elsewhere";

  const dkimRecord =
    dkimAnswers
      ?.map(txtValue)
      .find((v) => v.toLowerCase().startsWith("v=dkim1")) ?? null;
  const dkim: DkimState =
    dkimAnswers === null
      ? "unknown"
      : dkimRecord === null
        ? dkimAnswers.length === 0
          ? "none"
          : "elsewhere"
        : // An empty `p=` is DKIM's revoked-key signal: present, but verifies nothing.
          /(^|;)\s*p=\s*(;|$)/.test(dkimRecord)
          ? "elsewhere"
          : "cloudflare";

  const missingRecords: DnsRecord[] = [];
  if (routing === "elsewhere" || routing === "none") {
    for (const value of CLOUDFLARE_MX_HOSTS) {
      missingRecords.push({
        name: domain,
        type: "MX",
        value,
        action: routing === "elsewhere" ? "replace" : "add",
        note: routing === "elsewhere" ? MX_REPLACE_NOTE : null,
      });
    }
  }
  if (spf === "none") {
    missingRecords.push({
      name: domain,
      type: "TXT",
      value: CLOUDFLARE_SPF_VALUE,
      action: "add",
      note: null,
    });
  } else if (spf === "elsewhere" && spfRecord !== null) {
    missingRecords.push({
      name: domain,
      type: "TXT",
      value: mergeSpf(spfRecord),
      action: "replace",
      note: null,
    });
  }
  if (dkim === "none" || dkim === "elsewhere") {
    missingRecords.push({
      name: dkimName,
      type: "TXT",
      value: null,
      action: dkim === "elsewhere" ? "replace" : "add",
      note: DKIM_NOTE,
    });
  }

  return { routing, mx, spf, spfRecord, dkim, missingRecords };
}
