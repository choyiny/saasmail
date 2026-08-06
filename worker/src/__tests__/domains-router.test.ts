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

type MissingRecord = {
  name: string;
  type: string;
  value: string | null;
  action: "add" | "replace";
  note: string | null;
};

type DomainRow = {
  domain: string;
  inboxCount: number;
  messageCount: number;
  dns: {
    routing: "cloudflare" | "elsewhere" | "none" | "unknown";
    mx: string[];
    spf: "cloudflare" | "elsewhere" | "none" | "unknown";
    spfRecord: string | null;
    dkim: "cloudflare" | "elsewhere" | "none" | "unknown";
    missingRecords: MissingRecord[];
  };
};

/** `fail` = the request throws; `servfail` = the resolver errors; `badbody` = headers land, body rejects mid-read. */
type Answers = Array<string | string[]> | "fail" | "servfail" | "badbody";

/** DKIM lives under its own name, so a zone answers three lookups, not two. */
type Zone = { mx: Answers; txt: Answers; dkim: Answers };

const DKIM_SELECTOR = "cf2024-1._domainkey";
const dkimName = (domain: string) => `${DKIM_SELECTOR}.${domain}`;
const DKIM_KEY =
  "v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtest";

/** Only the fields worth pinning — `note` is prose and asserted separately. */
const shape = (r: MissingRecord) => ({
  name: r.name,
  type: r.type,
  value: r.value,
  action: r.action,
});

/**
 * Stub the DoH resolver. Zones are keyed by domain; anything not listed throws,
 * so a test that reaches the network by accident fails loudly. A TXT answer
 * given as an array is emitted as several quoted chunks, the way DNS returns a
 * value over 255 characters.
 */
function stubResolver(zones: Record<string, Zone>) {
  const spy = vi.fn(async (input: Request | string) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const name = url.searchParams.get("name") ?? "";
    const qtype = url.searchParams.get("type") === "MX" ? "mx" : "txt";

    const isDkim = name.startsWith(`${DKIM_SELECTOR}.`);
    const zoneName = isDkim ? name.slice(DKIM_SELECTOR.length + 1) : name;
    const zone = zones[zoneName];
    if (!zone) throw new Error(`unstubbed DNS lookup: ${qtype} ${name}`);

    const answers = isDkim ? zone.dkim : zone[qtype];
    if (answers === "fail") throw new Error("resolver timeout");
    if (answers === "servfail") {
      return new Response(JSON.stringify({ Status: 2 }));
    }
    if (answers === "badbody") {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("connection reset mid-body"));
          },
        }),
      );
    }
    return new Response(
      JSON.stringify({
        Status: 0,
        Answer: answers.map((data) => ({
          name,
          type: qtype === "mx" && !isDkim ? 15 : 16,
          data:
            qtype === "mx" && !isDkim
              ? (data as string)
              : (Array.isArray(data) ? data : [data])
                  .map((chunk) => `"${chunk}"`)
                  .join(" "),
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
      "acme-derive.test": { mx: [], txt: [], dkim: [] },
      "other-derive.test": { mx: [], txt: [], dkim: [] },
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
      "counts.test": { mx: [], txt: [], dkim: [] },
      "quiet-counts.test": { mx: [], txt: [], dkim: [] },
    });

    const byDomain = Object.fromEntries(
      (await listDomains(apiKey)).map((d) => [d.domain, d]),
    );
    expect(byDomain["counts.test"].inboxCount).toBe(3);
    expect(byDomain["counts.test"].messageCount).toBe(3);
    expect(byDomain["quiet-counts.test"].inboxCount).toBe(1);
    expect(byDomain["quiet-counts.test"].messageCount).toBe(0);
  });

  it("reports every check green when MX, SPF and DKIM are all in place", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity("a@routed-cf.test");
    // Cloudflare hands out per-zone hostnames, not always route1/2/3.
    stubResolver({
      "routed-cf.test": {
        mx: ["13 amir.mx.cloudflare.net.", "86 linda.mx.cloudflare.net."],
        txt: ["v=spf1 include:_spf.mx.cloudflare.net ~all"],
        dkim: [DKIM_KEY],
      },
    });

    const [row] = await listDomains(apiKey);
    expect(row.dns.routing).toBe("cloudflare");
    expect(row.dns.mx).toEqual([
      "amir.mx.cloudflare.net",
      "linda.mx.cloudflare.net",
    ]);
    expect(row.dns.spf).toBe("cloudflare");
    expect(row.dns.dkim).toBe("cloudflare");
    expect(row.dns.missingRecords).toEqual([]);
  });

  it("reports routing=elsewhere and the records still needed", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity("a@routed-away.test");
    stubResolver({
      "routed-away.test": {
        mx: ["10 aspmx.l.google.com."],
        txt: ["v=spf1 include:_spf.google.com ~all"],
        dkim: [],
      },
    });

    const [row] = await listDomains(apiKey);
    expect(row.dns.routing).toBe("elsewhere");
    expect(row.dns.mx).toEqual(["aspmx.l.google.com"]);
    expect(row.dns.spf).toBe("elsewhere");
    expect(row.dns.spfRecord).toBe("v=spf1 include:_spf.google.com ~all");
    expect(row.dns.dkim).toBe("none");
    expect(row.dns.missingRecords.map(shape)).toEqual([
      // Mail cannot route to two providers at once, so these replace what is there.
      {
        name: "routed-away.test",
        type: "MX",
        value: "route1.mx.cloudflare.net",
        action: "replace",
      },
      {
        name: "routed-away.test",
        type: "MX",
        value: "route2.mx.cloudflare.net",
        action: "replace",
      },
      {
        name: "routed-away.test",
        type: "MX",
        value: "route3.mx.cloudflare.net",
        action: "replace",
      },
      {
        name: "routed-away.test",
        type: "TXT",
        value:
          "v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net ~all",
        action: "replace",
      },
      {
        name: "cf2024-1._domainkey.routed-away.test",
        type: "TXT",
        value: null,
        action: "add",
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
        dkim: [],
      },
    });

    const [row] = await listDomains(apiKey);
    expect(row.dns.routing).toBe("none");
    expect(row.dns.mx).toEqual([]);
    // A TXT record that isn't SPF must not read as one.
    expect(row.dns.spf).toBe("none");
    expect(row.dns.spfRecord).toBeNull();
    expect(row.dns.missingRecords.map(shape)).toEqual([
      {
        name: "routed-nowhere.test",
        type: "MX",
        value: "route1.mx.cloudflare.net",
        action: "add",
      },
      {
        name: "routed-nowhere.test",
        type: "MX",
        value: "route2.mx.cloudflare.net",
        action: "add",
      },
      {
        name: "routed-nowhere.test",
        type: "MX",
        value: "route3.mx.cloudflare.net",
        action: "add",
      },
      {
        name: "routed-nowhere.test",
        type: "TXT",
        value: "v=spf1 include:_spf.mx.cloudflare.net ~all",
        action: "add",
      },
      {
        name: "cf2024-1._domainkey.routed-nowhere.test",
        type: "TXT",
        value: null,
        action: "add",
      },
    ]);
  });

  it("reports unknown, not broken, when the resolver request fails", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity("a@resolver-down.test");
    stubResolver({
      "resolver-down.test": { mx: "fail", txt: "fail", dkim: "fail" },
    });

    const [row] = await listDomains(apiKey);
    expect(row.dns.routing).toBe("unknown");
    expect(row.dns.spf).toBe("unknown");
    expect(row.dns.dkim).toBe("unknown");
    // The operator is told nothing was checked, not that anything is missing.
    expect(row.dns.missingRecords).toEqual([]);
  });

  it("reports unknown when the resolver answers SERVFAIL", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity("a@resolver-servfail.test");
    stubResolver({
      "resolver-servfail.test": {
        mx: "servfail",
        txt: "servfail",
        dkim: "servfail",
      },
    });

    const [row] = await listDomains(apiKey);
    expect(row.dns.routing).toBe("unknown");
    expect(row.dns.spf).toBe("unknown");
    expect(row.dns.dkim).toBe("unknown");
    expect(row.dns.missingRecords).toEqual([]);
  });

  it("answers unknown, not 500, when the response body rejects mid-read", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity("a@body-cut.test");
    stubResolver({
      "body-cut.test": { mx: "badbody", txt: "badbody", dkim: "badbody" },
    });

    // A rejected body read used to escape the try/catch and take the endpoint
    // down through `Promise.all`, so the status assertion is the point here.
    const [row] = await listDomains(apiKey);
    expect(row.dns.routing).toBe("unknown");
    expect(row.dns.spf).toBe("unknown");
    expect(row.dns.dkim).toBe("unknown");
    expect(row.dns.missingRecords).toEqual([]);
  });

  it("keeps a failed TXT lookup from clouding a good MX answer", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity("a@half-resolved.test");
    stubResolver({
      "half-resolved.test": {
        mx: ["5 route1.mx.cloudflare.net."],
        txt: "fail",
        dkim: [DKIM_KEY],
      },
    });

    const [row] = await listDomains(apiKey);
    expect(row.dns.routing).toBe("cloudflare");
    expect(row.dns.spf).toBe("unknown");
    expect(row.dns.dkim).toBe("cloudflare");
    expect(row.dns.missingRecords).toEqual([]);
  });

  it("lets a resolved check report while another is still unknown", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity("a@partly-unknown.test");
    stubResolver({
      "partly-unknown.test": { mx: [], txt: "fail", dkim: [DKIM_KEY] },
    });

    const [row] = await listDomains(apiKey);
    expect(row.dns.routing).toBe("none");
    expect(row.dns.spf).toBe("unknown");
    // MX resolved and answered "nothing here", so its records stand; the failed
    // TXT lookup withholds only its own.
    expect(row.dns.missingRecords.map((r) => r.type)).toEqual([
      "MX",
      "MX",
      "MX",
    ]);
  });

  it("does not re-query the resolver on a refresh", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity("a@cached-zone.test");
    const spy = stubResolver({
      "cached-zone.test": {
        mx: ["5 route1.mx.cloudflare.net."],
        txt: ["v=spf1 include:_spf.mx.cloudflare.net ~all"],
        dkim: [DKIM_KEY],
      },
    });

    await listDomains(apiKey);
    await listDomains(apiKey);
    // One MX + one TXT + one DKIM lookup, not two of each.
    expect(spy.mock.calls).toHaveLength(3);
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

// Only one SPF record per name is legal. Telling an operator to add a second
// one breaks their outbound mail, so an existing record is always merged.
describe("domains router: SPF merge", () => {
  const cases = [
    {
      title: "splices the include in before the all mechanism",
      domain: "spf-merge-google.test",
      existing: "v=spf1 include:_spf.google.com ~all",
      merged:
        "v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net ~all",
    },
    {
      title: "leaves a hardfail qualifier alone",
      domain: "spf-merge-hardfail.test",
      existing: "v=spf1 -all",
      merged: "v=spf1 include:_spf.mx.cloudflare.net -all",
    },
    {
      title: "appends when the record has no all mechanism",
      domain: "spf-merge-noall.test",
      existing: "v=spf1 include:_spf.google.com",
      merged: "v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net",
    },
    {
      title: "keeps every existing mechanism and modifier",
      domain: "spf-merge-rich.test",
      existing: "v=spf1 ip4:198.51.100.0/24 a mx include:mail.example.com -all",
      merged:
        "v=spf1 ip4:198.51.100.0/24 a mx include:mail.example.com include:_spf.mx.cloudflare.net -all",
    },
  ];

  it.each(cases)("$title", async ({ domain, existing, merged }) => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity(`a@${domain}`);
    stubResolver({
      [domain]: {
        mx: ["5 route1.mx.cloudflare.net."],
        txt: [existing],
        dkim: [DKIM_KEY],
      },
    });

    const [row] = await listDomains(apiKey);
    expect(row.dns.spf).toBe("elsewhere");
    expect(row.dns.spfRecord).toBe(existing);
    expect(row.dns.missingRecords.map(shape)).toEqual([
      { name: domain, type: "TXT", value: merged, action: "replace" },
    ]);
  });

  it("emits nothing when the record already carries the include", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity("a@spf-already.test");
    stubResolver({
      "spf-already.test": {
        mx: ["5 route1.mx.cloudflare.net."],
        txt: [
          "v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all",
        ],
        dkim: [DKIM_KEY],
      },
    });

    const [row] = await listDomains(apiKey);
    expect(row.dns.spf).toBe("cloudflare");
    expect(row.dns.missingRecords).toEqual([]);
  });

  it("does not read a lookalike include as ours", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity("a@spf-lookalike.test");
    stubResolver({
      "spf-lookalike.test": {
        mx: ["5 route1.mx.cloudflare.net."],
        txt: ["v=spf1 include:_spf.mx.cloudflare.net.evil.example ~all"],
        dkim: [DKIM_KEY],
      },
    });

    const [row] = await listDomains(apiKey);
    expect(row.dns.spf).toBe("elsewhere");
    expect(row.dns.missingRecords.map(shape)).toEqual([
      {
        name: "spf-lookalike.test",
        type: "TXT",
        value:
          "v=spf1 include:_spf.mx.cloudflare.net.evil.example include:_spf.mx.cloudflare.net ~all",
        action: "replace",
      },
    ]);
  });

  it("reassembles a record the resolver split into chunks", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity("a@spf-chunked.test");
    stubResolver({
      "spf-chunked.test": {
        mx: ["5 route1.mx.cloudflare.net."],
        // Over 255 characters, DNS hands back several strings that join with nothing.
        txt: [["v=spf1 include:_spf.mx", ".cloudflare.net ~all"]],
        dkim: [DKIM_KEY],
      },
    });

    const [row] = await listDomains(apiKey);
    expect(row.dns.spfRecord).toBe(
      "v=spf1 include:_spf.mx.cloudflare.net ~all",
    );
    expect(row.dns.spf).toBe("cloudflare");
    expect(row.dns.missingRecords).toEqual([]);
  });
});

describe("domains router: DKIM", () => {
  it("asks for the selector record with no value and says where to get it", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity("a@dkim-missing.test");
    stubResolver({
      "dkim-missing.test": {
        mx: ["5 route1.mx.cloudflare.net."],
        txt: ["v=spf1 include:_spf.mx.cloudflare.net ~all"],
        dkim: [],
      },
    });

    const [row] = await listDomains(apiKey);
    expect(row.dns.dkim).toBe("none");
    expect(row.dns.missingRecords).toHaveLength(1);

    const [record] = row.dns.missingRecords;
    expect(record.name).toBe(dkimName("dkim-missing.test"));
    expect(record.type).toBe("TXT");
    expect(record.action).toBe("add");
    // Cloudflare generates this key per zone — a guessed value is worse than none.
    expect(record.value).toBeNull();
    expect(record.note).toMatch(/dashboard/i);
  });

  it("treats a foreign TXT on the selector as a record to replace", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity("a@dkim-foreign.test");
    stubResolver({
      "dkim-foreign.test": {
        mx: ["5 route1.mx.cloudflare.net."],
        txt: ["v=spf1 include:_spf.mx.cloudflare.net ~all"],
        dkim: ["some-old-verification-token"],
      },
    });

    const [row] = await listDomains(apiKey);
    expect(row.dns.dkim).toBe("elsewhere");
    expect(row.dns.missingRecords.map(shape)).toEqual([
      {
        name: dkimName("dkim-foreign.test"),
        type: "TXT",
        value: null,
        action: "replace",
      },
    ]);
  });

  it("does not count a revoked key as configured", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity("a@dkim-revoked.test");
    stubResolver({
      "dkim-revoked.test": {
        mx: ["5 route1.mx.cloudflare.net."],
        txt: ["v=spf1 include:_spf.mx.cloudflare.net ~all"],
        // An empty `p=` is DKIM's revocation signal: the record is there and verifies nothing.
        dkim: ["v=DKIM1; h=sha256; k=rsa; p="],
      },
    });

    const [row] = await listDomains(apiKey);
    expect(row.dns.dkim).toBe("elsewhere");
    expect(row.dns.missingRecords).toHaveLength(1);
  });

  it("reports unknown when only the DKIM lookup fails", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await addIdentity("a@dkim-unknown.test");
    stubResolver({
      "dkim-unknown.test": {
        mx: ["5 route1.mx.cloudflare.net."],
        txt: ["v=spf1 include:_spf.mx.cloudflare.net ~all"],
        dkim: "fail",
      },
    });

    const [row] = await listDomains(apiKey);
    expect(row.dns.routing).toBe("cloudflare");
    expect(row.dns.spf).toBe("cloudflare");
    expect(row.dns.dkim).toBe("unknown");
    expect(row.dns.missingRecords).toEqual([]);
  });
});
