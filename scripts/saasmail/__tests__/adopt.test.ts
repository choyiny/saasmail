import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptFromCheckout } from "../adopt.ts";
import { adoptWorker, planAdoptWorker } from "../adopt-worker.ts";
import type { Ctx } from "../apply.ts";
import type { WorkerBinding } from "../cloudflare.ts";
import type { Io } from "../collect.ts";
import { installationIdOf, resourceNames } from "../names.ts";
import { packageSource } from "../source.ts";
import { UsageError } from "../status.ts";
import {
  newState,
  readState,
  writeState,
  type InstallState,
} from "../state.ts";
import {
  fakeCloudflare,
  fakePackage,
  fakeRunner,
  type FakeCloudflareSeed,
} from "./fakes.ts";

let root: string;
let checkout: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "saasmail-adopt-"));
  checkout = join(root, "repo");
  home = join(root, "home");
  mkdirSync(checkout, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const io = { print() {} } as unknown as Io;
const now = () => new Date("2026-10-17T12:00:00Z");

function seed(name: string, id: string): InstallState {
  const s: InstallState = {
    ...newState({
      installationId: id,
      accountId: "a".repeat(32),
      inputs: {
        name,
        hostname: null,
        workersDev: true,
        inboundDomains: [],
        provider: "none",
        sendDomains: [],
        cookiePrefix: "saasmail",
      },
      names: resourceNames(name),
      baseUrl: `https://${name}.me.workers.dev`,
    }),
    status: "installed",
  };
  writeState(join(checkout, ".saasmail"), s);
  return s;
}

const adopt = (name?: string) =>
  adoptFromCheckout({ checkout, home, name, io, now });

describe("adoptFromCheckout", () => {
  it("copies state and config, marks the checkout", async () => {
    const s = seed("acme", "acme-111111111111");
    writeFileSync(join(checkout, "wrangler.jsonc"), "// config\n{}\n");
    const r = await adopt();
    expect(r.slug).toBe(s.names.worker);
    expect(r.dir).toBe(join(home, s.names.worker));
    const moved = readState(r.dir, s.installationId)!;
    expect(moved.adoptedAt).toBe("2026-10-17T12:00:00.000Z");
    expect(moved.movedTo).toBeUndefined();
    expect(moved.ownershipNonce).toBe(s.ownershipNonce);
    expect(readFileSync(join(r.dir, "wrangler.jsonc"), "utf8")).toBe(
      "// config\n{}\n",
    );
    const stub = readState(join(checkout, ".saasmail"), s.installationId)!;
    expect(stub.movedTo).toBe(r.dir);
    // No lock files are left behind.
    expect(existsSync(join(r.dir, `${s.installationId}.lock`))).toBe(false);
    expect(
      existsSync(join(checkout, ".saasmail", `${s.installationId}.lock`)),
    ).toBe(false);
  });

  it("several checkout installs need --name", async () => {
    seed("acme", "acme-111111111111");
    seed("beta", "beta-222222222222");
    writeFileSync(join(checkout, "wrangler.jsonc"), "{}");
    await expect(adopt()).rejects.toThrow(UsageError);
    await expect(adopt()).rejects.toThrow(/acme, beta/);
    const r = await adopt("beta");
    expect(r.slug).toBe(resourceNames("beta").worker);
  });

  it("destination taken stops, checkout untouched", async () => {
    const s = seed("acme", "acme-111111111111");
    writeFileSync(join(checkout, "wrangler.jsonc"), "{}");
    const dest = join(home, s.names.worker);
    writeState(dest, { ...s, deployedVersion: "9.9.9" });
    const before = readFileSync(
      join(checkout, ".saasmail", `${s.installationId}.json`),
      "utf8",
    );
    await expect(adopt()).rejects.toThrow(`${dest} already has an install`);
    expect(
      readFileSync(
        join(checkout, ".saasmail", `${s.installationId}.json`),
        "utf8",
      ),
    ).toBe(before);
    expect(readState(dest, s.installationId)!.deployedVersion).toBe("9.9.9");
    expect(existsSync(join(dest, "wrangler.jsonc"))).toBe(false);
  });

  it("a failure leaves no destination behind", async () => {
    const s = seed("acme", "acme-111111111111");
    // No wrangler.jsonc in the checkout.
    await expect(adopt()).rejects.toThrow(/wrangler\.jsonc is missing/);
    expect(existsSync(join(home, s.names.worker))).toBe(false);
    expect(
      readState(join(checkout, ".saasmail"), s.installationId)!.movedTo,
    ).toBeUndefined();
  });

  it("an install that already moved is not adopted twice", async () => {
    seed("acme", "acme-111111111111");
    writeFileSync(join(checkout, "wrangler.jsonc"), "{}");
    await adopt();
    await expect(adopt()).rejects.toThrow(/already moved/);
  });

  it("files are 0600 and dir 0700", async () => {
    const s = seed("acme", "acme-111111111111");
    writeFileSync(join(checkout, "wrangler.jsonc"), "{}");
    const r = await adopt();
    const mode = (p: string) => statSync(p).mode & 0o777;
    expect(mode(r.dir)).toBe(0o700);
    expect(mode(join(r.dir, `${s.installationId}.json`))).toBe(0o600);
    expect(mode(join(r.dir, "wrangler.jsonc"))).toBe(0o600);
  });
});

// --- adopt --worker ---------------------------------------------------------------------------

const W_ACCOUNT = "b".repeat(32);
const W_BASE = "https://acme.me.workers.dev";

const BINDINGS: WorkerBinding[] = [
  { type: "d1", name: "DB", id: "d1-acme" },
  { type: "r2_bucket", name: "R2", bucket_name: "acme-files" },
  { type: "queue", name: "EMAIL_QUEUE", queue_name: "acme-queue" },
  {
    type: "workflow",
    name: "GMAIL_BACKFILL",
    workflow_name: "acme-backfill",
    class_name: "GmailBackfillWorkflow",
  },
  {
    type: "durable_object_namespace",
    name: "NOTIFICATIONS_HUB",
    class_name: "NotificationsHub",
  },
  { type: "assets", name: "ASSETS" },
  { type: "send_email", name: "EMAIL" },
  { type: "plain_text", name: "COOKIE_PREFIX", text: "acme" },
  { type: "plain_text", name: "VAPID_PUBLIC_KEY", text: "PUB" },
  { type: "plain_text", name: "VAPID_SUBJECT", text: "mailto:me@acme.dev" },
  { type: "plain_text", name: "BASE_URL", text: W_BASE },
  { type: "secret_text", name: "BETTER_AUTH_SECRET" },
  { type: "secret_text", name: "VAPID_PRIVATE_KEY" },
];

function workerSeed(
  over: Partial<FakeCloudflareSeed> = {},
  bindings: WorkerBinding[] = BINDINGS,
): FakeCloudflareSeed {
  return {
    accounts: [{ id: W_ACCOUNT, name: "Acme" }],
    subdomain: "me",
    workers: { acme: bindings },
    d1: [{ uuid: "d1-acme", name: "acme-database" }],
    r2: { "acme-files": {} },
    queues: [
      { id: "q-acme", name: "acme-queue", producers: [], consumers: [] },
    ],
    workflows: [{ name: "acme-backfill", scriptName: "acme" }],
    ...over,
  };
}

const without = (...names: string[]) =>
  BINDINGS.filter((b) => !names.includes(b.name));

const withVar = (name: string, text: string): WorkerBinding[] => [
  ...without(name),
  { type: "plain_text", name, text },
];

function workerHarness(
  o: {
    seed?: FakeCloudflareSeed;
    confirm?: boolean;
    wellKnown?: () => Response;
  } = {},
) {
  const pkgRoot = fakePackage(join(root, "pkg"), {
    version: "1.3.0",
    commit: "abc",
  });
  copyFileSync(
    new URL("../../../wrangler.jsonc.example", import.meta.url),
    join(pkgRoot, "wrangler.jsonc.example"),
  );
  const cf = fakeCloudflare(o.seed ?? workerSeed());
  const runner = fakeRunner({});
  const out: string[] = [];
  const confirms: string[] = [];
  const wio: Io = {
    tty: true,
    async prompt() {
      return null;
    },
    async select<T>(_m: string, options: { value: T }[]) {
      return options[0]!.value;
    },
    async confirm(m) {
      confirms.push(m);
      return o.confirm ?? true;
    },
    print(t) {
      out.push(t);
    },
  };
  const fetchImpl = (async () =>
    o.wellKnown?.() ?? new Response("nope", { status: 404 })) as typeof fetch;
  const ctx: Ctx = {
    cf,
    runner,
    io: wio,
    dir: join(root, "unused"),
    configDir: join(root, "unused"),
    source: packageSource(pkgRoot),
    fetchImpl,
    sleep: async () => {},
    now,
  };
  return { ctx, cf, runner, out, confirms, text: () => out.join("\n") };
}

const WRITES = [
  "createD1",
  "createR2",
  "createQueue",
  "putR2Object",
  "queryD1",
  "putCatchAllWorker",
  "enableEmailRoutingDns",
  "createSendingSubdomain",
];

describe("adoptWorker", () => {
  const dest = () => join(home, "acme");
  const run = (
    h: ReturnType<typeof workerHarness>,
    inputs: Parameters<typeof planAdoptWorker>[1]["inputs"] = {},
    over: { yes?: boolean; expectPlan?: string } = {},
  ) =>
    adoptWorker(h.ctx, {
      accountId: W_ACCOUNT,
      worker: "acme",
      inputs,
      yes: over.yes ?? true,
      expectPlan: over.expectPlan,
      home,
    });

  it("bindings mapped to adopted resources", async () => {
    const h = workerHarness();
    const s = await run(h);
    const id = installationIdOf(W_ACCOUNT, "acme", "workers.dev");
    expect(s.installationId).toBe(id);
    expect(s.status).toBe("installed");
    expect(s.adoptedAt).toBe("2026-10-17T12:00:00.000Z");
    expect(s.upgradedAt).toBeUndefined();
    expect(s.deployedConfigHash).toBeUndefined();
    expect(s.ownershipNonce).toMatch(/^[0-9a-f]{64}$/);
    expect(s.baseUrl).toBe(W_BASE);
    expect(s.inputs).toEqual({
      name: "acme",
      hostname: null,
      workersDev: true,
      inboundDomains: [],
      provider: "cloudflare",
      sendDomains: [],
      cookiePrefix: "acme",
    });
    expect(s.vapidSubject).toBe("mailto:me@acme.dev");
    expect(s.names).toEqual({
      worker: "acme",
      d1: "acme-database",
      attachments: "acme-files",
      queue: "acme-queue",
      workflow: "acme-backfill",
    });
    expect(
      s.resources.map((r) => [r.key, r.kind, r.name, r.id, r.ownership]),
    ).toEqual([
      ["d1", "d1", "acme-database", "d1-acme", "adopted"],
      ["attachments", "r2", "acme-files", "acme-files", "adopted"],
      ["queue", "queue", "acme-queue", "q-acme", "adopted"],
      ["workflow", "workflow", "acme-backfill", "acme-backfill", "adopted"],
      ["worker", "worker", "acme", "acme", "adopted"],
    ]);
    expect(readState(dest(), id)).toEqual(s);
    const config = readFileSync(join(dest(), "wrangler.jsonc"), "utf8");
    expect(config).toContain('"database_id": "d1-acme"');
    expect(config).toContain('"bucket_name": "acme-files"');
    expect(config).toContain(
      join(root, "pkg", "saasmail", "worker", "index.js"),
    );
    expect(statSync(join(dest(), "wrangler.jsonc")).mode & 0o777).toBe(0o600);
    expect(statSync(dest()).mode & 0o777).toBe(0o700);
  });

  it("missing bound resource stops", async () => {
    const h = workerHarness({ seed: workerSeed({ d1: [] }) });
    await expect(run(h)).rejects.toThrow(
      "Binding DB points to D1 d1-acme, which does not exist.",
    );
    expect(existsSync(home)).toBe(false);
  });

  it("unknown binding stops", async () => {
    const h = workerHarness({
      seed: workerSeed({}, [
        ...BINDINGS,
        { type: "kv_namespace", name: "CACHE", id: "kv1" },
      ]),
    });
    await expect(run(h)).rejects.toThrow("CACHE (kv_namespace)");
    expect(existsSync(home)).toBe(false);
  });

  it("worker not found stops", async () => {
    const h = workerHarness({ seed: workerSeed({ workers: {} }) });
    await expect(run(h)).rejects.toThrow(
      `No worker named acme on account ${W_ACCOUNT}`,
    );
  });

  it("existing secrets untouched", async () => {
    const h = workerHarness();
    await run(h);
    expect(h.runner.calls).toHaveLength(0);
    expect(h.cf.calls.filter((c) => WRITES.includes(c.method))).toEqual([]);
    expect(h.text()).toContain(
      "Secrets on the worker (names only): BETTER_AUTH_SECRET, VAPID_PRIVATE_KEY",
    );
  });

  it("vapid public key read from vars", async () => {
    const s = await run(workerHarness());
    expect(s.vapidPublicKey).toBe("PUB");
  });

  it("lost vapid pair stops", async () => {
    const h = workerHarness({
      seed: workerSeed({}, without("VAPID_PUBLIC_KEY")),
    });
    await expect(run(h)).rejects.toThrow(
      "VAPID_PRIVATE_KEY is set but its public key is unknown",
    );
    await expect(run(h)).rejects.toThrow(
      "For an adopted worker, set the VAPID_PUBLIC_KEY var on the worker instead.",
    );
    expect(existsSync(home)).toBe(false);
  });

  it("missing queue gets slug-derived name", async () => {
    const h = workerHarness({ seed: workerSeed({}, without("EMAIL_QUEUE")) });
    const s = await run(h);
    expect(s.names.queue).toBe("acme-sequence-emails");
    expect(s.resources.some((r) => r.key === "queue")).toBe(false);
    expect(h.text()).toContain(
      "queue     acme-sequence-emails: not bound; the first upgrade creates it",
    );
  });

  it("custom domain sets hostname", async () => {
    const h = workerHarness({
      seed: workerSeed(
        {
          workerDomains: [
            { hostname: "other.example.com", service: "other" },
            { hostname: "mail.example.com", service: "acme" },
          ],
        },
        withVar("BASE_URL", "https://mail.example.com"),
      ),
    });
    const s = await run(h);
    expect(s.inputs.hostname).toBe("mail.example.com");
    expect(s.inputs.workersDev).toBe(false);
    expect(s.baseUrl).toBe("https://mail.example.com");
    expect(s.installationId).toBe(
      installationIdOf(W_ACCOUNT, "acme", "mail.example.com"),
    );
  });

  it("report shows routing elsewhere", async () => {
    const h = workerHarness({
      seed: workerSeed({
        zones: [
          { id: "z1", name: "example.com", status: "active" },
          { id: "z2", name: "acme.dev", status: "active" },
        ],
        routing: {
          z1: { enabled: true, status: "ready" },
          z2: { enabled: true, status: "ready" },
        },
        catchAll: {
          z1: {
            enabled: true,
            actions: [{ type: "worker", value: ["other"] }],
          },
          z2: { enabled: true, actions: [{ type: "worker", value: ["acme"] }] },
        },
      }),
    });
    const p = await planAdoptWorker(h.ctx, {
      accountId: W_ACCOUNT,
      worker: "acme",
      inputs: { inboundDomains: ["example.com", "acme.dev", "nozone.org"] },
    });
    expect(p.report).toContain("  example.com  elsewhere");
    expect(p.report).toContain("  acme.dev  ok");
    expect(p.report).toContain(
      "  nozone.org  missing (no zone in this account)",
    );
    expect(p.digest).toMatch(/^[0-9a-f]{12}$/);
  });

  it("custom code is reported up front, not a stop", async () => {
    const h = workerHarness({
      wellKnown: () => Response.json({ version: "1.2.0" }),
    });
    const p = await planAdoptWorker(h.ctx, {
      accountId: W_ACCOUNT,
      worker: "acme",
      inputs: {},
    });
    expect(p.state.deployedVersion).toBe("1.2.0");
    expect(p.report).toContain("Running 1.2.0; this package 1.3.0 (upgrade)");

    const unknown = await planAdoptWorker(workerHarness().ctx, {
      accountId: W_ACCOUNT,
      worker: "acme",
      inputs: {},
    });
    expect(unknown.state.deployedVersion).toBeUndefined();
    expect(unknown.report.split("\n")[0]).toBe(
      "The first upgrade will need --replace-custom-code: the running version is unknown.",
    );
  });

  it("confirm declined writes nothing", async () => {
    const h = workerHarness({ confirm: false });
    await expect(run(h, {}, { yes: false })).rejects.toThrow(
      "Nothing was changed.",
    );
    expect(h.confirms).toEqual(["Adopt this install?"]);
    expect(existsSync(home)).toBe(false);
  });

  it("a matching --expect-plan applies without asking; a changed plan stops", async () => {
    const p = await planAdoptWorker(workerHarness().ctx, {
      accountId: W_ACCOUNT,
      worker: "acme",
      inputs: {},
    });
    const stale = workerHarness();
    await expect(
      run(stale, {}, { yes: false, expectPlan: "000000000000" }),
    ).rejects.toThrow("The plan changed since it was reviewed");
    expect(existsSync(home)).toBe(false);

    const h = workerHarness();
    await run(h, {}, { yes: false, expectPlan: p.digest });
    expect(h.confirms).toEqual([]);
    expect(existsSync(join(dest(), "wrangler.jsonc"))).toBe(true);
  });

  it("a destination holding an install stops before writing", async () => {
    const first = await run(workerHarness());
    const h = workerHarness();
    await expect(run(h)).rejects.toThrow(`${dest()} already has an install`);
    expect(readState(dest(), first.installationId)).toEqual(first);
  });
});

describe("adoptWorker: stops beyond the template mapping", () => {
  const plan = (h: ReturnType<typeof workerHarness>) =>
    planAdoptWorker(h.ctx, {
      accountId: W_ACCOUNT,
      worker: "acme",
      inputs: {},
    });

  it("BASE_URL on a host that is not the chosen one stops", async () => {
    const h = workerHarness({
      seed: workerSeed({}, withVar("BASE_URL", "https://x.example.com")),
    });
    await expect(plan(h)).rejects.toThrow(
      "BASE_URL is https://x.example.com, but the worker has no custom domain for it (adopt would record https://acme.me.workers.dev). Routes other than custom domains are not supported by adopt.",
    );
    const custom = workerHarness({
      seed: workerSeed({
        workerDomains: [{ hostname: "mail.example.com", service: "acme" }],
      }),
    });
    await expect(plan(custom)).rejects.toThrow(
      `BASE_URL is ${W_BASE}, but the worker has no custom domain for it`,
    );
  });

  it("the report shows the VAPID subject and key, so the digest binds them", async () => {
    const a = await plan(workerHarness());
    expect(a.report).toContain("  VAPID subject: mailto:me@acme.dev");
    expect(a.report).toContain("  VAPID public key: PUB…");
    const b = await plan(
      workerHarness({
        seed: workerSeed({}, withVar("VAPID_SUBJECT", "mailto:x@acme.dev")),
      }),
    );
    expect(b.digest).not.toBe(a.digest);
  });

  it("no DB binding stops", async () => {
    await expect(
      plan(workerHarness({ seed: workerSeed({}, without("DB")) })),
    ).rejects.toThrow("The worker has no D1 binding DB");
  });

  it("a template binding name with the wrong type stops as unknown", async () => {
    const h = workerHarness({
      seed: workerSeed({}, [
        ...without("DB"),
        { type: "kv_namespace", name: "DB", id: "kv1" },
      ]),
    });
    await expect(plan(h)).rejects.toThrow("DB (kv_namespace)");
  });

  it("a worker that already carries SAASMAIL_INSTALLATION stops", async () => {
    const h = workerHarness({
      seed: workerSeed(
        {},
        withVar("SAASMAIL_INSTALLATION", '{"installationId":"acme-1"}'),
      ),
    });
    await expect(plan(h)).rejects.toThrow("adopt --from <checkout>");
  });

  it("several custom domains with BASE_URL naming none stop", async () => {
    const h = workerHarness({
      seed: workerSeed({
        workerDomains: [
          { hostname: "a.example.com", service: "acme" },
          { hostname: "b.example.com", service: "acme" },
        ],
      }),
    });
    await expect(plan(h)).rejects.toThrow(
      "serves several custom domains (a.example.com, b.example.com)",
    );
  });

  it("a plain var named like a secret saasmail generates stops, value not shown", async () => {
    const h = workerHarness({
      seed: workerSeed(
        {},
        withVar("TOKEN_ENCRYPTION_KEY", "plain-held-key-0123456789"),
      ),
    });
    const err = await plan(h).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain(
      "Worker acme has vars the first upgrade would drop or change:",
    );
    expect(msg).toContain(
      "  TOKEN_ENCRYPTION_KEY  (value not shown) -> removed; the upgrade would generate a TOKEN_ENCRYPTION_KEY secret in its place",
    );
    expect(msg).not.toContain("plain-held-key-0123456789");
    expect(msg).toContain(
      "Change or remove them on the worker, then run adopt again. Nothing was changed.",
    );
  });

  it("a plain var the generated config does not set stops with its value", async () => {
    const h = workerHarness({
      seed: workerSeed({}, withVar("FEATURE_X", "on")),
    });
    await expect(plan(h)).rejects.toThrow(
      '  FEATURE_X  "on" -> removed (saasmail\'s config does not set it)',
    );
  });

  it("a var the generated config sets to another value stops with both values", async () => {
    const h = workerHarness({
      seed: workerSeed(
        {},
        withVar("TRUSTED_ORIGINS", `http://localhost:8080,${W_BASE}`),
      ),
    });
    await expect(plan(h)).rejects.toThrow(
      `  TRUSTED_ORIGINS  "http://localhost:8080,${W_BASE}" -> "${W_BASE}"`,
    );
  });

  it("every such var is listed in one stop, and adopt writes nothing", async () => {
    const h = workerHarness({
      seed: workerSeed({}, [
        ...without("COOKIE_PREFIX"),
        { type: "plain_text", name: "FEATURE_X", text: "on" },
        { type: "plain_text", name: "SETUP_CODE_HASH", text: "h" },
        { type: "plain_text", name: "TRUSTED_ORIGINS", text: "x" },
      ]),
    });
    const err = (await adoptWorker(h.ctx, {
      accountId: W_ACCOUNT,
      worker: "acme",
      inputs: {},
      yes: true,
      home,
    }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("  FEATURE_X ");
    expect(err.message).toContain("  SETUP_CODE_HASH ");
    expect(err.message).toContain("  TRUSTED_ORIGINS ");
    expect(existsSync(join(home, "acme"))).toBe(false);
    expect(h.cf.calls.filter((c) => WRITES.includes(c.method))).toEqual([]);
  });

  it("SAASMAIL_VERSION may change at the first upgrade; an equal var passes", async () => {
    const h = workerHarness({
      seed: workerSeed({}, [
        ...BINDINGS,
        { type: "plain_text", name: "SAASMAIL_VERSION", text: "0.9.0" },
        { type: "plain_text", name: "TRUSTED_ORIGINS", text: W_BASE },
      ]),
    });
    const p = await plan(h);
    expect(p.state.inputs.name).toBe("acme");
  });

  it("no custom domain and no workers.dev subdomain stops", async () => {
    const h = workerHarness({ seed: workerSeed({ subdomain: null }) });
    await expect(plan(h)).rejects.toThrow("no workers.dev subdomain");
  });
});
