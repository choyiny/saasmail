import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { senderIdentities } from "../db/sender-identities.schema";

type DomainRow = {
  domain: string;
  inboxCount: number;
  messageCount: number;
  dns: {
    routing: "cloudflare" | "elsewhere" | "none" | "unknown";
    mx: string[];
    spf: "cloudflare" | "elsewhere" | "none" | "unknown";
    spfRecord: string | null;
    missingRecords: Array<{ name: string; type: string; value: string }>;
  };
};

/** `fail` = the request throws (timeout); `servfail` = the resolver answers an error. */
type Answers = string[] | "fail" | "servfail";

/**
 * Stub the DoH resolver. Zones are keyed by domain; anything not listed throws,
 * so a test that reaches the network by accident fails loudly.
 */
function stubResolver(zones: Record<string, { mx: Answers; txt: Answers }>) {
  const spy = vi.fn(async (input: Request | string) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const name = url.searchParams.get("name") ?? "";
    const type = url.searchParams.get("type") === "MX" ? "mx" : "txt";
    const zone = zones[name];
    if (!zone) throw new Error(`unstubbed DNS lookup: ${type} ${name}`);

    const answers = zone[type];
    if (answers === "fail") throw new Error("resolver timeout");
    if (answers === "servfail") {
      return new Response(JSON.stringify({ Status: 2 }));
    }
    return new Response(
      JSON.stringify({
        Status: 0,
        Answer: answers.map((data) => ({
          name,
          type: type === "mx" ? 15 : 16,
          data: type === "mx" ? data : `"${data}"`,
        })),
      }),
    );
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

async function listDomains(apiKey: string): Promise<DomainRow[]> {
  const res = await authFetch("/api/domains", { apiKey });
  expect(res.status).toBe(200);
  return (await res.json()) as DomainRow[];
}

async function addIdentity(email: string) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(senderIdentities)
    .values({ email, createdAt: now, updatedAt: now });
}

beforeEach(async () => {
  await applyMigrations();
  await cleanDb();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Resolver answers are cached in `caches.default`, which outlives `cleanDb()`,
// so every test below owns a distinct set of domains.
describe("domains router", () => {
  it("derives domains from both sources, deduped and case-folded", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await createTestPerson();
    await createTestEmail({
      id: "e1",
      messageId: "m1@t",
      recipient: "Sales@Acme-Derive.test",
    });
    await createTestEmail({
      id: "e2",
      messageId: "m2@t",
      recipient: "sales@acme-derive.test",
    });
    await addIdentity("billing@ACME-DERIVE.test");
    await addIdentity("hello@Other-Derive.test");

    stubResolver({
      "acme-derive.test": { mx: [], txt: [] },
      "other-derive.test": { mx: [], txt: [] },
    });

    const body = await listDomains(apiKey);
    expect(body.map((d) => d.domain)).toEqual([
      "acme-derive.test",
      "other-derive.test",
    ]);
  });

  it("counts inboxes and received messages per domain", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await createTestPerson();
    await createTestEmail({
      id: "e1",
      messageId: "m1@t",
      recipient: "a@counts.test",
    });
    await createTestEmail({
      id: "e2",
      messageId: "m2@t",
      recipient: "A@Counts.test",
    });
    await createTestEmail({
      id: "e3",
      messageId: "m3@t",
      recipient: "b@counts.test",
    });
    // Identity with no mail yet — an inbox that exists but has received nothing.
    await addIdentity("c@counts.test");
    await addIdentity("only@quiet-counts.test");

    stubResolver({
      "counts.test": { mx: [], txt: [] },
      "quiet-counts.test": { mx: [], txt: [] },
    });

    const byDomain = Object.fromEntries(
      (await listDomains(apiKey)).map((d) => [d.domain, d]),
    );
    expect(byDomain["counts.test"].inboxCount).toBe(3);
    expect(byDomain["counts.test"].messageCount).toBe(3);
    expect(byDomain["quiet-counts.test"].inboxCount).toBe(1);
    expect(byDomain["quiet-counts.test"].messageCount).toBe(0);
  });

  it("reports routing=cloudflare when MX points at mx.cloudflare.net", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity("a@routed-cf.test");
    // Cloudflare hands out per-zone hostnames, not always route1/2/3.
    stubResolver({
      "routed-cf.test": {
        mx: ["13 amir.mx.cloudflare.net.", "86 linda.mx.cloudflare.net."],
        txt: ["v=spf1 include:_spf.mx.cloudflare.net ~all"],
      },
    });

    const [row] = await listDomains(apiKey);
    expect(row.dns.routing).toBe("cloudflare");
    expect(row.dns.mx).toEqual([
      "amir.mx.cloudflare.net",
      "linda.mx.cloudflare.net",
    ]);
    expect(row.dns.spf).toBe("cloudflare");
    expect(row.dns.missingRecords).toEqual([]);
  });

  it("reports routing=elsewhere and the records still needed", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity("a@routed-away.test");
    stubResolver({
      "routed-away.test": {
        mx: ["10 aspmx.l.google.com."],
        txt: ["v=spf1 include:_spf.google.com ~all"],
      },
    });

    const [row] = await listDomains(apiKey);
    expect(row.dns.routing).toBe("elsewhere");
    expect(row.dns.mx).toEqual(["aspmx.l.google.com"]);
    expect(row.dns.spf).toBe("elsewhere");
    expect(row.dns.spfRecord).toBe("v=spf1 include:_spf.google.com ~all");
    expect(row.dns.missingRecords).toEqual([
      {
        name: "routed-away.test",
        type: "MX",
        value: "route1.mx.cloudflare.net",
      },
      {
        name: "routed-away.test",
        type: "MX",
        value: "route2.mx.cloudflare.net",
      },
      {
        name: "routed-away.test",
        type: "MX",
        value: "route3.mx.cloudflare.net",
      },
      {
        name: "routed-away.test",
        type: "TXT",
        value: "v=spf1 include:_spf.mx.cloudflare.net ~all",
      },
    ]);
  });

  it("reports routing=none when the domain has no MX record", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity("a@routed-nowhere.test");
    stubResolver({
      "routed-nowhere.test": {
        mx: [],
        txt: ["google-site-verification=abc123"],
      },
    });

    const [row] = await listDomains(apiKey);
    expect(row.dns.routing).toBe("none");
    expect(row.dns.mx).toEqual([]);
    // A TXT record that isn't SPF must not read as one.
    expect(row.dns.spf).toBe("none");
    expect(row.dns.spfRecord).toBeNull();
    expect(row.dns.missingRecords).toHaveLength(4);
  });

  it("reports unknown, not broken, when the resolver request fails", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity("a@resolver-down.test");
    stubResolver({ "resolver-down.test": { mx: "fail", txt: "fail" } });

    const [row] = await listDomains(apiKey);
    expect(row.dns.routing).toBe("unknown");
    expect(row.dns.spf).toBe("unknown");
    // The operator is told nothing was checked, not that anything is missing.
    expect(row.dns.missingRecords).toEqual([]);
  });

  it("reports unknown when the resolver answers SERVFAIL", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity("a@resolver-servfail.test");
    stubResolver({
      "resolver-servfail.test": { mx: "servfail", txt: "servfail" },
    });

    const [row] = await listDomains(apiKey);
    expect(row.dns.routing).toBe("unknown");
    expect(row.dns.spf).toBe("unknown");
    expect(row.dns.missingRecords).toEqual([]);
  });

  it("keeps a failed TXT lookup from clouding a good MX answer", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity("a@half-resolved.test");
    stubResolver({
      "half-resolved.test": {
        mx: ["5 route1.mx.cloudflare.net."],
        txt: "fail",
      },
    });

    const [row] = await listDomains(apiKey);
    expect(row.dns.routing).toBe("cloudflare");
    expect(row.dns.spf).toBe("unknown");
    expect(row.dns.missingRecords).toEqual([]);
  });

  it("does not re-query the resolver on a refresh", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity("a@cached-zone.test");
    const spy = stubResolver({
      "cached-zone.test": {
        mx: ["5 route1.mx.cloudflare.net."],
        txt: ["v=spf1 include:_spf.mx.cloudflare.net ~all"],
      },
    });

    await listDomains(apiKey);
    await listDomains(apiKey);
    // One MX + one TXT lookup, not two of each.
    expect(spy.mock.calls).toHaveLength(2);
  });

  it("returns 403 to a non-admin caller", async () => {
    const { apiKey } = await createTestUser({
      id: "u-mem",
      role: "member",
      email: "m@x.com",
    });
    await addIdentity("a@forbidden-zone.test");
    stubResolver({});

    const res = await authFetch("/api/domains", { apiKey });
    expect(res.status).toBe(403);
  });
});
