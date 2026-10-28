// Reads DNS records from public DNS (Cloudflare's DNS over HTTPS, JSON API) instead of the zone's
// records API: `wrangler login` cannot grant `dns_records:read`, and these reads must work with it.
// What resolvers answer is what the internet sees; records created moments ago may not show yet.

const DOH = "https://cloudflare-dns.com/dns-query";

/** The record types read: what a custom domain conflicts with, and what mail checks compare. */
const TYPES = { A: 1, AAAA: 28, CNAME: 5, MX: 15, TXT: 16 } as const;
type RecordType = keyof typeof TYPES;
const NAMES = new Map<number, RecordType>(
  Object.entries(TYPES).map(([k, v]) => [v, k as RecordType]),
);

export interface PublicDnsOptions {
  /** Injectable so tests never wait. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface PublicDns {
  /** Records at exactly `name` (A, AAAA, CNAME, MX, TXT); MX content is the host, without priority. */
  records(name: string): Promise<{ type: string; content: string }[]>;
  mx(name: string): Promise<{ content: string; priority: number | null }[]>;
}

const bare = (name: string) => name.trim().replace(/\.$/, "").toLowerCase();

export function publicDns(
  fetchImpl: typeof fetch = fetch,
  options: PublicDnsOptions = {},
): PublicDns {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = options.timeoutMs ?? 10_000;

  /** One query; NXDOMAIN and NOERROR without answers are no records. Retries twice on failure. */
  async function query(
    name: string,
    type: RecordType,
  ): Promise<{ type: RecordType; data: string }[]> {
    const url = `${DOH}?name=${encodeURIComponent(name)}&type=${type}`;
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(500 * attempt);
      try {
        const res = await fetchImpl(url, {
          headers: { accept: "application/dns-json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as {
          Status?: number;
          Answer?: { name?: string; type?: number; data?: string }[];
        };
        if (body.Status === 3) return [];
        if (body.Status !== 0) throw new Error(`DNS status ${body.Status}`);
        // Only records at the name itself: a CNAME answer is followed by its target's records.
        return (body.Answer ?? []).flatMap((a) => {
          const t = NAMES.get(a.type ?? -1);
          return t && bare(a.name ?? "") === bare(name) && a.data !== undefined
            ? [{ type: t, data: a.data }]
            : [];
        });
      } catch (e) {
        last = e;
      }
    }
    throw new Error(
      `Public DNS lookup of ${type} ${name} failed: ${last instanceof Error ? last.message : String(last)}`,
    );
  }

  /** "10 route1.mx.cloudflare.net." -> host and priority. */
  const parseMx = (data: string) => {
    const [pri, ...host] = data.trim().split(/\s+/);
    const priority = Number(pri);
    return Number.isInteger(priority)
      ? { content: host.join(" "), priority }
      : { content: data.trim(), priority: null };
  };

  return {
    async records(name) {
      const seen = new Set<string>();
      const out: { type: string; content: string }[] = [];
      for (const type of Object.keys(TYPES) as RecordType[]) {
        for (const r of await query(name, type)) {
          const content = r.type === "MX" ? parseMx(r.data).content : r.data;
          const key = `${r.type} ${content}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ type: r.type, content });
        }
      }
      return out;
    },
    async mx(name) {
      return (await query(name, "MX"))
        .filter((r) => r.type === "MX")
        .map((r) => parseMx(r.data));
    },
  };
}
