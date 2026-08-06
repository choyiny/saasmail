/**
 * Live DNS status for a domain, read over DNS-over-HTTPS.
 *
 * Workers have no raw DNS, so this asks Cloudflare's resolver over HTTPS and
 * reads the MX and SPF records back. Every failure path answers "unknown"
 * rather than "misconfigured": a resolver timeout says nothing about the zone,
 * and telling an operator their DNS is broken when it is not sends them to
 * edit records that were already correct.
 */

export type MxRouting = "cloudflare" | "elsewhere" | "none" | "unknown";
export type SpfState = "cloudflare" | "elsewhere" | "none" | "unknown";

export interface DnsRecord {
  name: string;
  type: "MX" | "TXT";
  value: string;
}

export interface DomainDns {
  routing: MxRouting;
  /** MX hosts actually observed, so "elsewhere" can say where. */
  mx: string[];
  spf: SpfState;
  spfRecord: string | null;
  /** Records the operator still has to add. Empty while anything is unknown. */
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
  const cached = await caches.default.match(key);
  if (cached) {
    body = await cached.text();
  } else {
    let res: Response;
    try {
      res = await fetch(key);
    } catch {
      return null;
    }
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

/** A long TXT value arrives as several quoted strings that concatenate. */
function txtValue(answer: DohAnswer): string {
  return answer.data.replace(/"/g, "").trim();
}

export async function lookupDomainDns(domain: string): Promise<DomainDns> {
  const [mxAnswers, txtAnswers] = await Promise.all([
    query(domain, "MX"),
    query(domain, "TXT"),
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
        : spfRecord.toLowerCase().includes(CLOUDFLARE_SPF_INCLUDE)
          ? "cloudflare"
          : "elsewhere";

  const missingRecords: DnsRecord[] = [];
  if (routing === "elsewhere" || routing === "none") {
    for (const value of CLOUDFLARE_MX_HOSTS) {
      missingRecords.push({ name: domain, type: "MX", value });
    }
  }
  if (spf === "elsewhere" || spf === "none") {
    missingRecords.push({
      name: domain,
      type: "TXT",
      value: CLOUDFLARE_SPF_VALUE,
    });
  }

  return { routing, mx, spf, spfRecord, missingRecords };
}
