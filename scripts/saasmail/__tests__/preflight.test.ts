import { describe, expect, it } from "vitest";
import { CloudflareError } from "../cloudflare.ts";
import { preflight } from "../preflight.ts";
import { fakeCloudflare, fakeRunner } from "./fakes.ts";

const runner = () => fakeRunner({});
const zone = (id: string, name: string, status = "active") => ({
  id,
  name,
  status,
});

const input = {
  accountId: "acc",
  hostname: null,
  workersDev: true,
  workerName: "saasmail",
  inboundDomains: ["mail.example.com"],
  sendDomains: ["mail.example.com"],
  provider: "cloudflare",
};
const seed = {
  subdomain: "me",
  zones: [zone("z1", "mail.example.com")],
};

describe("preflight", () => {
  it("passes and returns the workers.dev URL and zone ids", async () => {
    const r = await preflight(fakeCloudflare(seed), runner(), input);
    expect(r.failures).toEqual([]);
    expect(r.baseUrl).toBe("https://saasmail.me.workers.dev");
    expect(r.zoneIds).toEqual({ "mail.example.com": "z1" });
  });

  it("accepts Cloudflare's own MX records (any case, trailing dot)", async () => {
    const cf = fakeCloudflare({
      ...seed,
      dnsRecords: {
        z1: [
          {
            name: "mail.example.com",
            type: "MX",
            content: "ROUTE1.mx.cloudflare.net.",
          },
          {
            name: "mail.example.com",
            type: "MX",
            content: "route2.mx.cloudflare.net",
          },
        ],
      },
    });
    expect((await preflight(cf, runner(), input)).failures).toEqual([]);
  });

  it("not on Workers Paid -> plan failure with the plans link", async () => {
    const cf = fakeCloudflare(seed);
    cf.failNext(
      "listQueues",
      new CloudflareError("You need the Workers Paid plan", 403, [10000], "/q"),
    );
    const r = await preflight(cf, runner(), input);
    expect(r.failures.map((f) => f.check)).toEqual(["plan"]);
    expect(r.failures[0]!.fix).toContain(
      "https://dash.cloudflare.com/?to=/:account/workers/plans",
    );
  });

  it("a 500 mentioning plan is a generic failure, not the Paid message", async () => {
    const cf = fakeCloudflare(seed);
    cf.failNext(
      "listQueues",
      new CloudflareError("plan service down", 500, [], "/q"),
    );
    const r = await preflight(cf, runner(), input);
    expect(r.failures.map((f) => f.check)).toEqual(["plan"]);
    expect(r.failures[0]!.message).toContain("Could not check");
  });

  it("403 Authentication error on queues -> token", async () => {
    const cf = fakeCloudflare(seed);
    cf.failNext(
      "listQueues",
      new CloudflareError("Authentication error", 403, [10000], "/q"),
    );
    const r = await preflight(cf, runner(), input);
    expect(r.failures.map((f) => f.check)).toEqual(["token"]);
  });

  it("a null MX is rendered as null MX", async () => {
    const cf = fakeCloudflare({
      ...seed,
      dnsRecords: {
        z1: [
          { name: "mail.example.com", type: "MX", content: ".", priority: 0 },
        ],
      },
    });
    const r = await preflight(cf, runner(), input);
    expect(r.failures[0]!.message).toContain('null MX (".")');
  });

  it("401/403 on several checks -> one token failure", async () => {
    const cf = fakeCloudflare(seed);
    cf.failNext("listQueues", new CloudflareError("no", 403, [9109], "/q"));
    cf.failNext("listR2", new CloudflareError("no", 401, [], "/r"));
    const r = await preflight(cf, runner(), input);
    expect(r.failures.map((f) => f.check)).toEqual(["token"]);
  });

  it("R2 not enabled (10042)", async () => {
    const cf = fakeCloudflare(seed);
    cf.failNext("listR2", new CloudflareError("no", 400, [10042], "/r"));
    const r = await preflight(cf, runner(), input);
    expect(r.failures.map((f) => f.check)).toEqual(["r2"]);
  });

  it("unexpected errors become that check's failure; all checks still run", async () => {
    const cf = fakeCloudflare({ subdomain: null, zones: [] });
    cf.failNext("listR2", new Error("boom"));
    const r = await preflight(cf, runner(), input);
    expect(r.failures.map((f) => f.check).sort()).toEqual([
      "r2",
      "workers-dev",
      "zone",
      "zone",
    ]);
  });

  it("inbound domain with Google MX -> mx failure naming the records", async () => {
    const cf = fakeCloudflare({
      ...seed,
      dnsRecords: {
        z1: [
          {
            name: "mail.example.com",
            type: "MX",
            content: "aspmx.l.google.com",
            priority: 1,
          },
        ],
      },
    });
    const r = await preflight(cf, runner(), input);
    expect(r.failures.map((f) => f.check)).toEqual(["mx"]);
    expect(r.failures[0]!.message).toContain("aspmx.l.google.com");
    expect(r.failures[0]!.message).toContain("take over");
    expect(r.failures[0]!.fix).toContain("remove those MX records yourself");
  });

  it("inbound zone missing or inactive -> zone failure", async () => {
    const missing = await preflight(
      fakeCloudflare({ subdomain: "me" }),
      runner(),
      {
        ...input,
        sendDomains: [],
      },
    );
    expect(missing.failures.map((f) => f.check)).toEqual(["zone"]);
    expect(missing.zoneIds["mail.example.com"]).toBeNull();
    const pending = await preflight(
      fakeCloudflare({
        subdomain: "me",
        zones: [zone("z1", "mail.example.com", "pending")],
      }),
      runner(),
      { ...input, sendDomains: [] },
    );
    expect(pending.failures[0]!.message).toContain("pending");
  });

  it("an inbound domain below a parent zone is not its own zone", async () => {
    const cf = fakeCloudflare({
      subdomain: "me",
      zones: [zone("z0", "example.com")],
    });
    const r = await preflight(cf, runner(), { ...input, sendDomains: [] });
    expect(r.failures.map((f) => f.check)).toEqual(["zone"]);
    expect(r.failures[0]!.message).toBe(
      "`mail.example.com` is under zone `example.com`; Email Routing's catch-all is zone-wide, so the inbound domain must be its own zone (add mail.example.com as a zone, or use example.com).",
    );
  });

  it("send domain: parent zone is enough; missing -> failure; skipped for other providers", async () => {
    const cf = fakeCloudflare({
      ...seed,
      zones: [...seed.zones, zone("z9", "corp.com")],
    });
    const ok = await preflight(cf, runner(), {
      ...input,
      sendDomains: ["x.corp.com"],
    });
    expect(ok.failures).toEqual([]);
    expect(ok.zoneIds["x.corp.com"]).toBe("z9");
    const bad = await preflight(cf, runner(), {
      ...input,
      sendDomains: ["x.nope.com"],
    });
    expect(bad.failures.map((f) => f.check)).toEqual(["zone"]);
    const other = await preflight(cf, runner(), {
      ...input,
      provider: "resend",
      sendDomains: ["x.nope.com"],
    });
    expect(other.failures).toEqual([]);
  });

  it("send domain: a zone that is not active -> zone failure naming the status", async () => {
    const cf = fakeCloudflare({
      ...seed,
      zones: [...seed.zones, zone("z9", "corp.com", "pending")],
    });
    const r = await preflight(cf, runner(), {
      ...input,
      sendDomains: ["x.corp.com"],
    });
    expect(r.failures.map((f) => f.check)).toEqual(["zone"]);
    expect(r.failures[0]!.message).toContain("pending");
    expect(r.zoneIds["x.corp.com"]).toBe("z9");
  });

  it("--workers-dev without a subdomain -> workers-dev failure", async () => {
    const r = await preflight(
      fakeCloudflare({ zones: seed.zones }),
      runner(),
      input,
    );
    expect(r.failures.map((f) => f.check)).toEqual(["workers-dev"]);
    expect(r.baseUrl).toBeNull();
  });

  describe("UI hostname", () => {
    const ui = { ...input, workersDev: false, hostname: "app.example.com" };
    const base = {
      subdomain: "me",
      zones: [zone("z1", "mail.example.com"), zone("z2", "example.com")],
    };

    it("passes on a clean hostname", async () => {
      const r = await preflight(fakeCloudflare(base), runner(), ui);
      expect(r.failures).toEqual([]);
      expect(r.baseUrl).toBe("https://app.example.com");
      expect(r.zoneIds["app.example.com"]).toBe("z2");
    });

    it("stops on existing DNS records", async () => {
      const cf = fakeCloudflare({
        ...base,
        dnsRecords: {
          z2: [{ name: "app.example.com", type: "A", content: "1.2.3.4" }],
        },
      });
      const r = await preflight(cf, runner(), ui);
      expect(r.failures.map((f) => f.check)).toEqual(["zone"]);
      expect(r.failures[0]!.message).toContain("1.2.3.4");
    });

    it("stops on a foreign route", async () => {
      const cf = fakeCloudflare({
        ...base,
        routes: { z2: [{ pattern: "app.example.com/*", script: "other" }] },
      });
      const r = await preflight(cf, runner(), ui);
      expect(r.failures[0]!.message).toContain("other");
    });

    it("stops on a foreign custom domain; own custom domain resumes", async () => {
      const foreign = fakeCloudflare({
        ...base,
        workerDomains: [{ hostname: "app.example.com", service: "other" }],
      });
      expect((await preflight(foreign, runner(), ui)).failures).toHaveLength(1);
      const own = fakeCloudflare({
        ...base,
        workerDomains: [{ hostname: "app.example.com", service: "saasmail" }],
        dnsRecords: {
          z2: [{ name: "app.example.com", type: "AAAA", content: "100::" }],
        },
      });
      expect((await preflight(own, runner(), ui)).failures).toEqual([]);
    });
  });
});
