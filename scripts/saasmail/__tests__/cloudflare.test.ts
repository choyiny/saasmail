import { describe, expect, it } from "vitest";
import { CloudflareError, restCloudflare } from "../cloudflare.ts";
import { fakeCloudflare } from "./fakes.ts";

type Call = { method: string; url: URL; body?: string };

function fakeFetch(respond: (call: Call, n: number) => Response): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const call = {
      method: init?.method ?? "GET",
      url: new URL(url),
      body: init?.body as string | undefined,
    };
    calls.push(call);
    return respond(call, calls.length);
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const ok = (result: unknown, info?: object) =>
  Response.json({ success: true, errors: [], result, result_info: info });
const noSleep = { sleep: async () => {} };

describe("restCloudflare", () => {
  it("turns an error envelope into CloudflareError", async () => {
    const { fetch } = fakeFetch(() =>
      Response.json(
        { success: false, errors: [{ code: 10000, message: "Auth" }] },
        { status: 403 },
      ),
    );
    const err = await restCloudflare("t", fetch, noSleep)
      .listD1("a")
      .catch((e) => e);
    expect(err).toBeInstanceOf(CloudflareError);
    expect(err.status).toBe(403);
    expect(err.codes).toEqual([10000]);
    expect(err.path).toContain("/d1/database");
    expect(err.message).not.toContain("Bearer");
  });

  it("listAccounts sends per_page=50; workers/domains, queues and sending subdomains send none", async () => {
    const acc = fakeFetch(() => ok([]));
    await restCloudflare("t", acc.fetch, noSleep).listAccounts();
    expect(acc.calls[0]!.url.searchParams.get("per_page")).toBe("50");
    const other = fakeFetch(() => ok([]));
    const cf = restCloudflare("t", other.fetch, noSleep);
    await cf.workerDomains("a");
    await cf.listQueues("a");
    await cf.listSendingSubdomains("z");
    expect(other.calls.map((c) => c.url.searchParams.has("per_page"))).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("listR2 follows result_info.cursor across two pages", async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.url.searchParams.get("cursor") === "c1"
        ? ok({ buckets: [{ name: "b2" }] }, {})
        : ok({ buckets: [{ name: "b1" }] }, { cursor: "c1" }),
    );
    expect(await restCloudflare("t", fetch, noSleep).listR2("a")).toEqual([
      "b1",
      "b2",
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.searchParams.get("per_page")).toBe("1000");
  });

  it("stops when the cursor repeats", async () => {
    const { fetch, calls } = fakeFetch(() =>
      ok({ buckets: [{ name: "b" }] }, { cursor: "same" }),
    );
    await restCloudflare("t", fetch, noSleep).listR2("a");
    expect(calls).toHaveLength(2);
  });

  it("concatenates pages", async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.url.searchParams.get("page") === null
        ? ok([{ uuid: "1", name: "a" }], { total_pages: 2 })
        : ok([{ uuid: "2", name: "b" }], { total_pages: 2 }),
    );
    const rows = await restCloudflare("t", fetch, noSleep).listD1("acc");
    expect(rows.map((r) => r.uuid)).toEqual(["1", "2"]);
    expect(calls).toHaveLength(2);
  });

  it("retries a GET once on 429, honouring Retry-After (capped)", async () => {
    const waits: number[] = [];
    const { fetch, calls } = fakeFetch((_, n) =>
      n === 1
        ? new Response("", { status: 429, headers: { "Retry-After": "99" } })
        : ok([{ id: "x", name: "X" }]),
    );
    const rows = await restCloudflare("t", fetch, {
      sleep: async (ms) => void waits.push(ms),
    }).listAccounts();
    expect(rows).toEqual([{ id: "x", name: "X" }]);
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([10_000]);
  });

  it("does not retry a POST on 500", async () => {
    const { fetch, calls } = fakeFetch(() =>
      Response.json(
        { success: false, errors: [{ code: 1, message: "boom" }] },
        { status: 500 },
      ),
    );
    await expect(
      restCloudflare("t", fetch, noSleep).createD1("a", "db"),
    ).rejects.toBeInstanceOf(CloudflareError);
    expect(calls).toHaveLength(1);
  });

  it("workersSubdomain: 404 -> null, else the subdomain", async () => {
    const miss = fakeFetch(() =>
      Response.json({ success: false, errors: [] }, { status: 404 }),
    );
    expect(
      await restCloudflare("t", miss.fetch, noSleep).workersSubdomain("a"),
    ).toBeNull();
    const hit = fakeFetch(() => ok({ subdomain: "me" }));
    expect(
      await restCloudflare("t", hit.fetch, noSleep).workersSubdomain("a"),
    ).toBe("me");
  });

  it("findZone walks labels upward and returns the first hit", async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.url.searchParams.get("name") === "example.com"
        ? ok([{ id: "z", name: "example.com", status: "active" }])
        : ok([]),
    );
    const z = await restCloudflare("t", fetch, noSleep).findZone(
      "a",
      "mail.a.example.com",
    );
    expect(z).toEqual({ id: "z", name: "example.com", status: "active" });
    expect(calls.map((c) => c.url.searchParams.get("name"))).toEqual([
      "mail.a.example.com",
      "a.example.com",
      "example.com",
    ]);
  });

  it("queryD1 sends sql and params and returns the first result set", async () => {
    const { fetch, calls } = fakeFetch(() =>
      ok([{ results: [{ n: 1 }] }, { results: [{ n: 2 }] }]),
    );
    const rows = await restCloudflare("t", fetch, noSleep).queryD1(
      "a",
      "db",
      "select ?",
      [1],
    );
    expect(rows).toEqual([{ n: 1 }]);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      sql: "select ?",
      params: [1],
    });
  });

  it("R2 objects are raw bodies; 404 -> null", async () => {
    const miss = fakeFetch(() => new Response("", { status: 404 }));
    expect(
      await restCloudflare("t", miss.fetch, noSleep).getR2Object(
        "a",
        "b",
        "k/x",
      ),
    ).toBeNull();
    const hit = fakeFetch(() => new Response("hello"));
    expect(
      await restCloudflare("t", hit.fetch, noSleep).getR2Object(
        "a",
        "b",
        "k/x",
      ),
    ).toBe("hello");
    expect(hit.calls[0]!.url.pathname).toMatch(/\/objects\/k\/x$/);
  });

  it("dnsRecords and mxRecords read public DNS, never the zone API, and send no token", async () => {
    const { fetch, calls } = fakeFetch((c) =>
      Response.json({
        Status: 0,
        Answer:
          c.url.searchParams.get("type") === "MX"
            ? [
                {
                  name: "example.com.",
                  type: 15,
                  data: "10 route1.mx.cloudflare.net.",
                },
              ]
            : [],
      }),
    );
    const cf = restCloudflare("secret-token", fetch, noSleep);
    expect(await cf.mxRecords("z1", "example.com")).toEqual([
      { content: "route1.mx.cloudflare.net.", priority: 10 },
    ]);
    expect(await cf.dnsRecords("z1", "example.com")).toEqual([
      { type: "MX", content: "route1.mx.cloudflare.net." },
    ]);
    expect(
      calls.every((c) => c.url.origin === "https://cloudflare-dns.com"),
    ).toBe(true);
  });

  it("workerRoutes lists the zone routes with their script", async () => {
    const { fetch, calls } = fakeFetch(() =>
      ok([
        { id: "r1", pattern: "mail.example.com/*", script: "other" },
        { id: "r2", pattern: "x.example.com/*" },
      ]),
    );
    expect(
      await restCloudflare("t", fetch, noSleep).workerRoutes("z1"),
    ).toEqual([
      { pattern: "mail.example.com/*", script: "other" },
      { pattern: "x.example.com/*", script: null },
    ]);
    expect(calls[0]!.url.pathname).toBe("/client/v4/zones/z1/workers/routes");
  });

  it("r2IsEmpty lists at most one object", async () => {
    const empty = fakeFetch(() => ok([]));
    expect(
      await restCloudflare("t", empty.fetch, noSleep).r2IsEmpty("a", "b"),
    ).toBe(true);
    expect(empty.calls[0]!.url.pathname).toBe(
      "/client/v4/accounts/a/r2/buckets/b/objects",
    );
    expect(empty.calls[0]!.url.searchParams.get("per_page")).toBe("1");
    const full = fakeFetch(() => ok([{ key: "x" }], { is_truncated: true }));
    expect(
      await restCloudflare("t", full.fetch, noSleep).r2IsEmpty("a", "b"),
    ).toBe(false);
    expect(full.calls).toHaveLength(1);
  });

  it("workerSettings returns all bindings", async () => {
    const bindings = [
      { type: "plain_text", name: "A", text: "1" },
      { type: "d1", name: "DB", id: "uuid-1" },
      { type: "secret_text", name: "S" },
      { type: "r2_bucket", name: "R2", bucket_name: "b" },
    ];
    const { fetch, calls } = fakeFetch(() => ok({ bindings }));
    expect(
      await restCloudflare("t", fetch, noSleep).workerSettings(
        "a",
        "my worker",
      ),
    ).toEqual({ bindings });
    expect(calls[0]!.url.pathname).toBe(
      "/client/v4/accounts/a/workers/scripts/my%20worker/settings",
    );
  });

  it("workerSettings: 404 is null", async () => {
    const miss = fakeFetch(() =>
      Response.json({ success: false, errors: [] }, { status: 404 }),
    );
    expect(
      await restCloudflare("t", miss.fetch, noSleep).workerSettings("a", "s"),
    ).toBeNull();
  });

  it("workerVars keeps only plain_text bindings; 404 -> null", async () => {
    const { fetch } = fakeFetch(() =>
      ok({
        bindings: [
          { type: "plain_text", name: "A", text: "1" },
          { type: "d1", name: "DB" },
        ],
      }),
    );
    expect(
      await restCloudflare("t", fetch, noSleep).workerVars("a", "s"),
    ).toEqual({ A: "1" });
    const miss = fakeFetch(() =>
      Response.json({ success: false, errors: [] }, { status: 404 }),
    );
    expect(
      await restCloudflare("t", miss.fetch, noSleep).workerVars("a", "s"),
    ).toBeNull();
  });
});

describe("restCloudflare: queues", () => {
  it("listQueues pages by page number and maps producers and consumers", async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.url.searchParams.get("page") === null
        ? ok(
            [
              {
                queue_id: "q1",
                queue_name: "saasmail-sequence-emails",
                producers: [
                  { type: "worker", script: "saasmail" },
                  { type: "r2_bucket", bucket_name: "b" },
                ],
                consumers: [{ type: "worker", script_name: "saasmail" }],
              },
            ],
            { total_pages: 2 },
          )
        : ok(
            [
              {
                queue_id: "q2",
                queue_name: "other",
                consumers: [
                  { type: "worker", script: "w2" },
                  { type: "worker", service: "w3" },
                  { type: "http_pull" },
                ],
              },
            ],
            { total_pages: 2 },
          ),
    );
    const qs = await restCloudflare("t", fetch, noSleep).listQueues("a");
    expect(calls[0]!.url.pathname).toBe("/client/v4/accounts/a/queues");
    expect(calls[1]!.url.searchParams.get("page")).toBe("2");
    expect(qs).toEqual([
      {
        id: "q1",
        name: "saasmail-sequence-emails",
        producers: [
          { type: "worker", script: "saasmail" },
          { type: "r2_bucket", script: null },
        ],
        consumers: [{ type: "worker", script: "saasmail" }],
      },
      {
        id: "q2",
        name: "other",
        producers: [],
        consumers: [
          { type: "worker", script: "w2" },
          { type: "worker", script: "w3" },
          { type: "http_pull", script: null },
        ],
      },
    ]);
  });

  it("createQueue posts queue_name once and returns the id", async () => {
    const { fetch, calls } = fakeFetch(() =>
      ok({ queue_id: "q9", queue_name: "n" }),
    );
    expect(
      await restCloudflare("t", fetch, noSleep).createQueue("a", "n"),
    ).toEqual({ id: "q9" });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/client/v4/accounts/a/queues");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ queue_name: "n" });
  });
});

describe("restCloudflare: Email Routing", () => {
  it("emailRouting reads settings; 404 -> null", async () => {
    const { fetch, calls } = fakeFetch(() =>
      ok({ id: "s", name: "example.com", enabled: true, status: "ready" }),
    );
    expect(
      await restCloudflare("t", fetch, noSleep).emailRouting("z1"),
    ).toEqual({ enabled: true, status: "ready" });
    expect(calls[0]!.url.pathname).toBe("/client/v4/zones/z1/email/routing");
    const miss = fakeFetch(() =>
      Response.json({ success: false, errors: [] }, { status: 404 }),
    );
    expect(
      await restCloudflare("t", miss.fetch, noSleep).emailRouting("z1"),
    ).toBeNull();
  });

  it("enableEmailRoutingDns POSTs once to /email/routing/dns", async () => {
    const { fetch, calls } = fakeFetch(() =>
      Response.json(
        { success: false, errors: [{ code: 1, message: "x" }] },
        { status: 500 },
      ),
    );
    await expect(
      restCloudflare("t", fetch, noSleep).enableEmailRoutingDns("z1"),
    ).rejects.toBeInstanceOf(CloudflareError);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe(
      "/client/v4/zones/z1/email/routing/dns",
    );
    const good = fakeFetch(() => ok({ enabled: true, status: "unconfigured" }));
    expect(
      await restCloudflare("t", good.fetch, noSleep).enableEmailRoutingDns(
        "z1",
      ),
    ).toEqual({ enabled: true, status: "unconfigured" });
    expect(JSON.parse(good.calls[0]!.body!)).toEqual({});
  });

  it("catchAll reads enabled, actions and matchers; 404 -> null", async () => {
    const { fetch, calls } = fakeFetch(() =>
      ok({
        id: "r",
        enabled: true,
        actions: [{ type: "worker", value: ["saasmail"] }],
        matchers: [{ type: "all" }],
      }),
    );
    expect(await restCloudflare("t", fetch, noSleep).catchAll("z1")).toEqual({
      enabled: true,
      actions: [{ type: "worker", value: ["saasmail"] }],
    });
    expect(calls[0]!.url.pathname).toBe(
      "/client/v4/zones/z1/email/routing/rules/catch_all",
    );
    const bare = fakeFetch(() => ok({ enabled: false }));
    expect(
      await restCloudflare("t", bare.fetch, noSleep).catchAll("z1"),
    ).toEqual({ enabled: false, actions: [] });
    const miss = fakeFetch(() =>
      Response.json({ success: false, errors: [] }, { status: 404 }),
    );
    expect(
      await restCloudflare("t", miss.fetch, noSleep).catchAll("z1"),
    ).toBeNull();
  });

  it("putCatchAllWorker PUTs the worker action once", async () => {
    const { fetch, calls } = fakeFetch(() => ok({}));
    await restCloudflare("t", fetch, noSleep).putCatchAllWorker(
      "z1",
      "saasmail",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url.pathname).toBe(
      "/client/v4/zones/z1/email/routing/rules/catch_all",
    );
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: ["saasmail"] }],
      enabled: true,
    });
  });
});

describe("restCloudflare: Email Sending", () => {
  it("listSendingSubdomains maps tag to id", async () => {
    const { fetch, calls } = fakeFetch(() =>
      ok([{ tag: "t1", name: "example.com", enabled: true }]),
    );
    expect(
      await restCloudflare("t", fetch, noSleep).listSendingSubdomains("z1"),
    ).toEqual([{ id: "t1", name: "example.com", enabled: true }]);
    expect(calls[0]!.url.pathname).toBe(
      "/client/v4/zones/z1/email/sending/subdomains",
    );
  });

  it("createSendingSubdomain POSTs {name} once", async () => {
    const { fetch, calls } = fakeFetch(() =>
      ok({ tag: "t2", name: "mail.example.com", enabled: true }),
    );
    expect(
      await restCloudflare("t", fetch, noSleep).createSendingSubdomain(
        "z1",
        "mail.example.com",
      ),
    ).toEqual({ id: "t2", name: "mail.example.com", enabled: true });
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ name: "mail.example.com" });
  });

  it("sendingDns reads the subdomain's records", async () => {
    const { fetch, calls } = fakeFetch(() =>
      ok([
        {
          type: "TXT",
          name: "cf-bounce.example.com",
          content: "v=spf1",
          ttl: 1,
        },
        {
          type: "MX",
          name: "cf-bounce.example.com",
          content: "x",
          priority: 5,
        },
      ]),
    );
    expect(
      await restCloudflare("t", fetch, noSleep).sendingDns("z1", "t/1"),
    ).toEqual([
      { type: "TXT", name: "cf-bounce.example.com", content: "v=spf1" },
      {
        type: "MX",
        name: "cf-bounce.example.com",
        content: "x",
        priority: 5,
      },
    ]);
    expect(calls[0]!.url.pathname).toBe(
      "/client/v4/zones/z1/email/sending/subdomains/t%2F1/dns",
    );
  });
});

describe("fakeCloudflare", () => {
  it("seeds state, logs calls and supports failNext", async () => {
    const cf = fakeCloudflare({
      r2: { b: { k: "v" } },
      d1: [{ uuid: "u", name: "db" }],
    });
    expect(await cf.getR2Object("a", "b", "k")).toBe("v");
    await cf.putR2Object("a", "b", "k2", "w");
    expect(await cf.getR2Object("a", "b", "k2")).toBe("w");
    expect(await cf.listR2("a")).toEqual(["b"]);
    cf.failNext("createD1", new CloudflareError("x", 500, [], "/p"));
    await expect(cf.createD1("a", "n")).rejects.toBeInstanceOf(CloudflareError);
    expect((await cf.createD1("a", "n")).uuid).toBeTruthy();
    expect(cf.calls.map((c) => c.method)).toContain("putR2Object");
    expect((await cf.listD1("a")).map((d) => d.name)).toEqual(["db", "n"]);
  });

  it("models queues, routing and sending per zone", async () => {
    const cf = fakeCloudflare({
      queues: [{ id: "q1", name: "old", producers: [], consumers: [] }],
      routing: { z1: { enabled: false, status: "unconfigured" } },
      catchAll: { z1: { enabled: false, actions: [{ type: "drop" }] } },
      dnsRecords: {
        z1: [
          {
            name: "example.com",
            type: "MX",
            content: "mx.other.net",
            priority: 1,
          },
          { name: "example.com", type: "A", content: "192.0.2.1" },
        ],
      },
      sending: {
        z1: [{ id: "s1", name: "example.com", enabled: true }],
      },
      sendingDns: { s1: [{ type: "TXT", name: "x", content: "y" }] },
    });
    expect((await cf.createQueue("a", "new")).id).toBeTruthy();
    expect((await cf.listQueues("a")).map((q) => q.name)).toEqual([
      "old",
      "new",
    ]);
    expect(await cf.mxRecords("z1", "example.com")).toEqual([
      { content: "mx.other.net", priority: 1 },
    ]);
    expect(await cf.emailRouting("z2")).toBeNull();
    expect(await cf.enableEmailRoutingDns("z1")).toEqual({
      enabled: true,
      status: "ready",
    });
    expect(await cf.emailRouting("z1")).toEqual({
      enabled: true,
      status: "ready",
    });
    await cf.putCatchAllWorker("z1", "saasmail");
    expect(await cf.catchAll("z1")).toEqual({
      enabled: true,
      actions: [{ type: "worker", value: ["saasmail"] }],
    });
    const sub = await cf.createSendingSubdomain("z1", "mail.example.com");
    expect((await cf.listSendingSubdomains("z1")).map((x) => x.name)).toEqual([
      "example.com",
      "mail.example.com",
    ]);
    expect(await cf.sendingDns("z1", "s1")).toEqual([
      { type: "TXT", name: "x", content: "y" },
    ]);
    expect(await cf.sendingDns("z1", sub.id)).toEqual([]);
  });
});
