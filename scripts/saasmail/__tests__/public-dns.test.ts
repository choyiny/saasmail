import { describe, expect, it } from "vitest";
import { publicDns } from "../public-dns.ts";

type Answer = { name: string; type: number; data: string };

/** Answers per "<name> <type>"; absent = NOERROR with no answers. */
function doh(
  answers: Record<string, Answer[] | number>,
  seen: { url: URL; headers: Headers }[] = [],
) {
  return (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    seen.push({ url: u, headers: new Headers(init?.headers) });
    const a =
      answers[`${u.searchParams.get("name")} ${u.searchParams.get("type")}`];
    if (typeof a === "number") return Response.json({ Status: a });
    return Response.json({ Status: 0, Answer: a ?? [] });
  }) as unknown as typeof fetch;
}

const noSleep = { sleep: async () => {} };

describe("publicDns", () => {
  it("asks cloudflare-dns.com for JSON, one query per type, with no credentials", async () => {
    const seen: { url: URL; headers: Headers }[] = [];
    await publicDns(doh({}, seen), noSleep).records("mail.example.com");
    expect(seen.map((s) => s.url.searchParams.get("type"))).toEqual([
      "A",
      "AAAA",
      "CNAME",
      "MX",
      "TXT",
    ]);
    for (const s of seen) {
      expect(s.url.origin + s.url.pathname).toBe(
        "https://cloudflare-dns.com/dns-query",
      );
      expect(s.headers.get("accept")).toBe("application/dns-json");
      expect(s.headers.has("authorization")).toBe(false);
    }
  });

  it("keeps only records at the name: a CNAME's target records are not the name's", async () => {
    const cname = {
      name: "mail.example.com.",
      type: 5,
      data: "x.workers.dev.",
    };
    const target = { name: "x.workers.dev.", type: 1, data: "192.0.2.7" };
    const dns = publicDns(
      doh({
        "mail.example.com A": [cname, target],
        "mail.example.com CNAME": [cname],
      }),
      noSleep,
    );
    expect(await dns.records("mail.example.com")).toEqual([
      { type: "CNAME", content: "x.workers.dev." },
    ]);
  });

  it("MX content is the host; TXT keeps its quoted chunks; NXDOMAIN is no records", async () => {
    const dns = publicDns(
      doh({
        "example.com MX": [
          {
            name: "example.com.",
            type: 15,
            data: "10 route1.mx.cloudflare.net.",
          },
          { name: "example.com.", type: 15, data: "0 ." },
        ],
        "example.com TXT": [
          { name: "example.com.", type: 16, data: '"v=spf1 " "-all"' },
        ],
        "gone.example.com MX": 3,
      }),
      noSleep,
    );
    expect(await dns.mx("example.com")).toEqual([
      { content: "route1.mx.cloudflare.net.", priority: 10 },
      { content: ".", priority: 0 },
    ]);
    expect(await dns.records("example.com")).toEqual([
      { type: "MX", content: "route1.mx.cloudflare.net." },
      { type: "MX", content: "." },
      { type: "TXT", content: '"v=spf1 " "-all"' },
    ]);
    expect(await dns.mx("gone.example.com")).toEqual([]);
  });

  it("a failing resolver is retried, then an error naming the lookup", async () => {
    let n = 0;
    const flaky = (async () => {
      n++;
      return n < 3
        ? new Response("busy", { status: 503 })
        : Response.json({
            Status: 0,
            Answer: [
              { name: "example.com.", type: 15, data: "5 mx.example.net." },
            ],
          });
    }) as unknown as typeof fetch;
    expect(await publicDns(flaky, noSleep).mx("example.com")).toEqual([
      { content: "mx.example.net.", priority: 5 },
    ]);
    const servfail = publicDns(doh({ "example.com MX": 2 }), noSleep);
    await expect(servfail.mx("example.com")).rejects.toThrow(
      "Public DNS lookup of MX example.com failed: DNS status 2",
    );
  });
});
