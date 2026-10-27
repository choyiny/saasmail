import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { install, resumeInstalled, verify, type Ctx } from "../apply.ts";
import { renderConfig } from "../apply-steps.ts";
import type { Queue, SendingDnsRecord } from "../cloudflare.ts";
import type { Io } from "../collect.ts";
import { resourceNames } from "../names.ts";
import { checkoutSource, packageSource } from "../source.ts";
import { R2_MARKER_KEY } from "../observe.ts";
import type { RunResult } from "../runner.ts";
import { setupCodeHash } from "../secrets.ts";
import {
  newState,
  readState,
  type InstallState,
  type Provider,
} from "../state.ts";
import {
  fakeCloudflare,
  fakePackage,
  fakeRunner,
  type FakeCloudflareSeed,
} from "./fakes.ts";

const ACCOUNT = "a".repeat(32);
const VERSION = "abcdef123456";
const BASE = "https://acme.me.workers.dev";
const ID = "acme-1a2b3c4d5e6f";
const ZONE = { id: "z-example", name: "example.com", status: "active" };
const ZONE2 = { id: "z-other", name: "other.org", status: "active" };
const RESUME = "yarn saasmail install --resume --name acme";

const SENDING_DNS: SendingDnsRecord[] = [
  {
    type: "MX",
    name: "cf-bounce.example.com",
    content: "route1.mx.cloudflare.net",
    priority: 10,
  },
  {
    type: "TXT",
    name: "cf-bounce.example.com",
    content: "v=spf1 include:_spf.mx.cloudflare.net ~all",
  },
  { type: "TXT", name: "_dmarc.example.com", content: "v=DMARC1; p=none" },
];

let root: string;
let cwd: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "saasmail-apply-"));
  cwd = join(root, "repo");
  dir = join(cwd, ".saasmail");
  mkdirSync(join(cwd, "migrations"), { recursive: true });
  copyFileSync(
    new URL("../../../wrangler.jsonc.example", import.meta.url),
    join(cwd, "wrangler.jsonc.example"),
  );
  writeFileSync(
    join(cwd, "migrations", "0000_init.sql"),
    "CREATE TABLE a (x);",
  );
  writeFileSync(
    join(cwd, "migrations", "0001_more.sql"),
    "CREATE TABLE b (y);",
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function freshState(over: Partial<InstallState["inputs"]> = {}): InstallState {
  const s = newState({
    installationId: ID,
    accountId: ACCOUNT,
    inputs: {
      name: "acme",
      hostname: null,
      workersDev: true,
      inboundDomains: ["example.com"],
      provider: "cloudflare",
      sendDomains: ["example.com"],
      cookiePrefix: "acme",
      ...over,
    },
    names: resourceNames("acme"),
    baseUrl: BASE,
  });
  return { ...s, ownershipNonce: "n".repeat(64) };
}

function marker(s: InstallState, key: string): string {
  return JSON.stringify({
    installationId: s.installationId,
    ownershipNonce: s.ownershipNonce,
    key,
  });
}

const installationVar = (s: InstallState) =>
  JSON.stringify({
    installationId: s.installationId,
    ownershipNonce: s.ownershipNonce,
  });

const boundQueue = (s: InstallState, id = "q-existing"): Queue => ({
  id,
  name: s.names.queue,
  producers: [{ type: "worker", script: s.names.worker }],
  consumers: [{ type: "worker", script: s.names.worker }],
});

/** State of a finished install whose resources the fake also holds. */
function installedFixture(over: Partial<InstallState["inputs"]> = {}): {
  s: InstallState;
  seed: FakeCloudflareSeed;
} {
  const s = freshState(over);
  const res = (
    key: string,
    kind: "d1" | "r2" | "queue" | "worker" | "workflow",
    name: string,
    id = name,
  ) => ({
    key,
    kind,
    name,
    id,
    ownership: "created" as const,
    state: "ready" as const,
  });
  const done: InstallState = {
    ...s,
    status: "installed",
    resources: [
      res("d1", "d1", "acme-db", "d1-existing"),
      res("attachments", "r2", "acme-attachments"),
      res("queue", "queue", "acme-sequence-emails", "q-existing"),
      res("worker", "worker", "acme"),
      res("workflow", "workflow", "acme-gmail-backfill"),
    ],
    steps: [
      "provision-intent:d1",
      "provision-intent:attachments",
      "provision-intent:queue",
      "deploy:1",
      "setup-code:1",
      "routing:example.com",
      "sending:example.com",
    ].map((key) => ({ key, at: "2026-10-16T00:00:00.000Z" })),
    skipped: [],
    vapidPublicKey: "PUBKEY",
  };
  return {
    s: done,
    seed: {
      d1: [{ uuid: "d1-existing", name: "acme-db" }],
      r2: {
        "acme-attachments": { [R2_MARKER_KEY]: marker(done, "attachments") },
      },
      queues: [boundQueue(done)],
      workflows: [{ name: "acme-gmail-backfill", scriptName: "acme" }],
      workerVars: {
        acme: {
          SAASMAIL_INSTALLATION: installationVar(done),
          VAPID_PUBLIC_KEY: "PUBKEY",
        },
      },
      zones: [ZONE, ZONE2],
      routing: { [ZONE.id]: { enabled: true, status: "ready" } },
      catchAll: {
        [ZONE.id]: {
          enabled: true,
          actions: [{ type: "worker", value: ["acme"] }],
        },
      },
      sending: {
        [ZONE.id]: [{ id: "sub-existing", name: "example.com", enabled: true }],
      },
      sendingDns: { "example.com": SENDING_DNS },
      dnsRecords: { [ZONE.id]: SENDING_DNS },
    },
  };
}

/** The installed state as last deployed at `version` from this checkout. */
function pinned(h: { ctx: Ctx }, s: InstallState, version = VERSION) {
  return {
    ...s,
    deployedConfigHash: renderConfig(h.ctx, s, version).hash,
    deployedVersion: version,
  };
}

/** What a later run sees in Cloudflare after an earlier run deployed. */
function carryOver(
  cf: ReturnType<typeof fakeCloudflare>,
  s: InstallState,
  base: FakeCloudflareSeed = {},
): FakeCloudflareSeed {
  return {
    ...base,
    d1: cf.state.d1.map(({ uuid, name }) => ({ uuid, name })),
    r2: cf.state.r2,
    queues: cf.state.queues.map((q) =>
      q.name === s.names.queue ? boundQueue(s, q.id) : q,
    ),
    workflows: [{ name: s.names.workflow, scriptName: s.names.worker }],
    workerVars: {
      [s.names.worker]: {
        SAASMAIL_INSTALLATION: installationVar(s),
        VAPID_PUBLIC_KEY: s.vapidPublicKey ?? "",
      },
    },
    routing: cf.state.routing,
    catchAll: cf.state.catchAll,
    sending: cf.state.sending,
  };
}

type Deploy = {
  args: string[];
  secrets: Record<string, string> | null;
  /** Cloudflare calls made before this deploy ran. */
  cfBefore: string[];
};

function harness(
  opts: {
    seed?: FakeCloudflareSeed;
    version?: string;
    secretList?: RunResult;
    deploy?: RunResult;
    wellKnown?: () => Response | Promise<Response>;
    setupStatus?: { setupRequired: boolean; codeRequired: boolean };
    /** The first this-many setup status reads fail (the site unreachable). */
    setupStatusFailures?: number;
    tty?: boolean;
    confirm?: boolean;
    /** Run from an npm package (fakePackage) instead of the checkout. */
    pkg?: boolean;
  } = {},
) {
  const cf = fakeCloudflare({
    zones: [ZONE, ZONE2],
    sendingDns: { "example.com": SENDING_DNS },
    ...opts.seed,
  });
  const deploys: Deploy[] = [];
  const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
  let source = checkoutSource(cwd);
  let configDir = cwd;
  if (opts.pkg) {
    const pkgRoot = fakePackage(join(root, "pkg"), {
      version: "1.0.0",
      commit: "c".repeat(40),
    });
    mkdirSync(join(pkgRoot, "migrations"), { recursive: true });
    copyFileSync(
      join(cwd, "wrangler.jsonc.example"),
      join(pkgRoot, "wrangler.jsonc.example"),
    );
    copyFileSync(
      join(cwd, "migrations", "0000_init.sql"),
      join(pkgRoot, "migrations", "0000_init.sql"),
    );
    source = packageSource(pkgRoot);
    configDir = join(root, "home", "acme");
    mkdirSync(configDir, { recursive: true });
  }
  // Both sources reach wrangler through one handler: yarn as `-s [wrangler] …`, a package as `<bin> …`.
  const wrangler = (args: string[]) => {
    const a = args.slice(1);
    if (a[0] === "wrangler") a.shift();
    return a;
  };
  const handle = (args: string[]): RunResult => {
    const w = wrangler(args);
    if (w[0] === "deploy") {
      const i = args.indexOf("--secrets-file");
      deploys.push({
        args,
        secrets:
          i >= 0
            ? (JSON.parse(readFileSync(args[i + 1], "utf8")) as Record<
                string,
                string
              >)
            : null,
        cfBefore: cf.calls.map((c) => c.method),
      });
      return opts.deploy ?? ok();
    }
    if (w[0] === "secret") {
      return opts.secretList ?? { code: 1, stdout: "", stderr: "not found" };
    }
    if (w[0] === "d1") return ok();
    throw new Error(`unexpected wrangler ${args.join(" ")}`);
  };
  const runner = fakeRunner({
    "git rev-parse": () => ok(`${opts.version ?? VERSION}\n`),
    "git status": () => ok(""),
    yarn: handle,
    [process.execPath]: handle,
  });
  const printed: string[] = [];
  const confirms: { msg: string; initial: boolean }[] = [];
  const io: Io = {
    tty: opts.tty ?? false,
    async prompt() {
      return null;
    },
    async select() {
      throw new Error("no select");
    },
    async confirm(msg, initial) {
      confirms.push({ msg, initial });
      return opts.confirm ?? true;
    },
    print(t) {
      printed.push(t);
    },
  };
  const fetched: string[] = [];
  let setupFailuresLeft = opts.setupStatusFailures ?? 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    fetched.push(url);
    if (url === `${BASE}/.well-known/saasmail`) {
      if (opts.wellKnown) return opts.wellKnown();
      return Response.json({
        installationId: ID,
        version: opts.version ?? (opts.pkg ? "1.0.0" : VERSION),
        schemaDigest: "x",
      });
    }
    if (url === `${BASE}/api/setup/status`) {
      if (setupFailuresLeft > 0) {
        setupFailuresLeft--;
        throw new TypeError("fetch failed");
      }
      return Response.json(
        opts.setupStatus ?? { setupRequired: true, codeRequired: true },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const slept: number[] = [];
  const ctx: Ctx = {
    cf,
    runner,
    io,
    dir,
    source,
    configDir,
    fetchImpl,
    sleep: async (ms) => {
      slept.push(ms);
    },
    now: () => new Date("2026-10-17T00:00:00Z"),
  };
  const count = (m: string) => cf.calls.filter((c) => c.method === m).length;
  return { ctx, cf, runner, deploys, printed, fetched, slept, count, confirms };
}

const noOptional = { yes: true, optional: {} };
const readConfig = () =>
  parse(readFileSync(join(cwd, "wrangler.jsonc"), "utf8")) as {
    vars: Record<string, string>;
  };

describe("install", () => {
  it("package source runs wrangler directly", async () => {
    const h = harness({ pkg: true });
    await install(h.ctx, { state: freshState(), ...noOptional });

    const wranglerCalls = h.runner.calls.filter(
      (c) => c.cmd === process.execPath,
    );
    expect(wranglerCalls.length).toBeGreaterThanOrEqual(3);
    const tail = ["--config", join(h.ctx.configDir, "wrangler.jsonc")];
    for (const c of wranglerCalls) {
      if (c.args.includes("deploy")) {
        expect(c.args.join(" ")).toContain(tail.join(" "));
      } else {
        expect(c.args.slice(-2)).toEqual(tail);
      }
    }
    expect(wranglerCalls.some((c) => c.args.includes("deploy"))).toBe(true);
    expect(wranglerCalls.some((c) => c.args.includes("migrations"))).toBe(true);
    expect(
      h.runner.calls.some((c) => c.cmd === "yarn" || c.cmd === "git"),
    ).toBe(false);
    expect(existsSync(join(h.ctx.configDir, "wrangler.jsonc"))).toBe(true);
    expect(
      readFileSync(join(h.ctx.configDir, "wrangler.jsonc"), "utf8").split(
        "\n",
      )[0],
    ).toContain("Edit inputs with npx saasmail@1.0.0 install, not by hand.");
  });

  it("fresh install creates everything once, deploys once, routes, onboards sending, verifies", async () => {
    const h = harness();
    const out = await install(h.ctx, { state: freshState(), ...noOptional });

    expect(h.count("createD1")).toBe(1);
    expect(h.count("createR2")).toBe(1);
    expect(h.count("createQueue")).toBe(1);
    expect(
      JSON.parse(h.cf.state.r2["acme-attachments"][R2_MARKER_KEY]),
    ).toEqual({
      installationId: ID,
      ownershipNonce: out.ownershipNonce,
      key: "attachments",
    });

    // Migrations, then the D1 marker row.
    expect(
      h.runner.calls.some(
        (c) =>
          c.cmd === "yarn" &&
          c.args.join(" ") === "-s wrangler d1 migrations apply DB --remote",
      ),
    ).toBe(true);
    const insert = h.cf.calls.find(
      (c) =>
        c.method === "queryD1" &&
        String(c.args[2]).includes("INSERT OR REPLACE INTO install_state"),
    );
    expect(insert?.args[3]).toEqual([
      ID,
      out.ownershipNonce,
      VERSION,
      expect.stringContaining("schemaDigest"),
      Date.parse("2026-10-17T00:00:00Z"),
    ]);

    // One deploy, with every generated secret in a secrets file.
    expect(h.deploys).toHaveLength(1);
    expect(h.deploys[0].args).toContain("--secrets-file");
    const secrets = h.deploys[0].secrets!;
    expect(Object.keys(secrets).sort()).toEqual([
      "BETTER_AUTH_SECRET",
      "SETUP_CODE_HASH",
      "TOKEN_ENCRYPTION_KEY",
      "UNSUBSCRIBE_SECRET",
      "VAPID_PRIVATE_KEY",
    ]);
    expect(secrets.BETTER_AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets.UNSUBSCRIBE_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(secrets.TOKEN_ENCRYPTION_KEY, "base64")).toHaveLength(
      32,
    );
    // The public key is in the state and the deployed config, never empty.
    expect(out.vapidPublicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(readConfig().vars.VAPID_PUBLIC_KEY).toBe(out.vapidPublicKey);
    expect(readConfig().vars.SAASMAIL_VERSION).toBe(VERSION);

    // Routing and sending come after the deploy (the catch-all names the worker).
    expect(h.deploys[0].cfBefore).not.toContain("enableEmailRoutingDns");
    expect(h.deploys[0].cfBefore).not.toContain("putCatchAllWorker");
    expect(h.deploys[0].cfBefore).not.toContain("createSendingSubdomain");
    expect(
      h.cf.calls.find((c) => c.method === "putCatchAllWorker")?.args,
    ).toEqual([ZONE.id, "acme"]);
    expect(h.count("enableEmailRoutingDns")).toBe(1);
    expect(h.cf.state.sending[ZONE.id].map((x) => x.name)).toEqual([
      "example.com",
    ]);

    expect(out.status).toBe("installed");
    expect(readState(dir, ID)?.status).toBe("installed");
    expect(out.resources.map((r) => r.key).sort()).toEqual([
      "attachments",
      "d1",
      "queue",
      "worker",
      "workflow",
    ]);
    for (const k of ["deploy:1", "routing:example.com", "sending:example.com"])
      expect(out.steps.map((x) => x.key)).toContain(k);
    expect(h.fetched).toContain(`${BASE}/.well-known/saasmail`);

    const summary = h.printed.join("\n");
    const code = /Setup code: (\S+)/.exec(summary)?.[1];
    expect(code).toBeTruthy();
    expect(setupCodeHash(code!)).toBe(secrets.SETUP_CODE_HASH);
    expect(summary).toContain(`${BASE}/onboarding`);
    expect(summary).toContain(RESUME);
    expect(summary).toMatch(/^.*example\.com.*acme/m);
    // No secret ever lands in the state file.
    const stateText = readFileSync(join(dir, `${ID}.json`), "utf8");
    for (const v of [code!, ...Object.values(secrets)])
      expect(stateText).not.toContain(v);
    expect(existsSync(join(dir, `${ID}.lock`))).toBe(false);
  });

  it("runs every wrangler and deploy subprocess with the chosen account", async () => {
    const h = harness();
    await install(h.ctx, { state: freshState(), ...noOptional });
    const yarn = h.runner.calls.filter((c) => c.cmd === "yarn");
    expect(yarn.length).toBeGreaterThanOrEqual(3);
    for (const c of yarn)
      expect(c.opts?.env).toMatchObject({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
  });

  it("existing secrets are never regenerated; the VAPID public key comes from the deployed var", async () => {
    const s = freshState();
    const h = harness({
      seed: {
        workerVars: {
          acme: {
            SAASMAIL_INSTALLATION: installationVar(s),
            VAPID_PUBLIC_KEY: "DEPLOYED_PUBKEY",
          },
        },
      },
      secretList: {
        code: 0,
        stdout: JSON.stringify(
          [
            "BETTER_AUTH_SECRET",
            "UNSUBSCRIBE_SECRET",
            "TOKEN_ENCRYPTION_KEY",
            "VAPID_PRIVATE_KEY",
          ].map((name) => ({ name, type: "secret_text" })),
        ),
        stderr: "",
      },
    });
    const out = await install(h.ctx, { state: s, ...noOptional });
    expect(Object.keys(h.deploys[0].secrets!)).toEqual(["SETUP_CODE_HASH"]);
    expect(out.vapidPublicKey).toBe("DEPLOYED_PUBKEY");
    expect(readConfig().vars.VAPID_PUBLIC_KEY).toBe("DEPLOYED_PUBKEY");
    const list = h.runner.calls.find((c) => c.args.includes("secret"));
    expect(list?.args).toEqual([
      "-s",
      "wrangler",
      "secret",
      "list",
      "--name",
      "acme",
      "--format",
      "json",
    ]);
  });

  it("an existing VAPID private key keeps the public key already in the state", async () => {
    const s = { ...freshState(), vapidPublicKey: "STATE_PUBKEY" };
    const h = harness({
      secretList: {
        code: 0,
        stdout: JSON.stringify([{ name: "VAPID_PRIVATE_KEY" }]),
        stderr: "",
      },
    });
    const out = await install(h.ctx, { state: s, ...noOptional });
    expect(h.deploys[0].secrets).not.toHaveProperty("VAPID_PRIVATE_KEY");
    expect(out.vapidPublicKey).toBe("STATE_PUBKEY");
    expect(readConfig().vars.VAPID_PUBLIC_KEY).toBe("STATE_PUBKEY");
  });

  it("an existing VAPID private key with no known public key stops before the deploy", async () => {
    const s = freshState();
    const h = harness({
      seed: {
        workerVars: { acme: { SAASMAIL_INSTALLATION: installationVar(s) } },
      },
      secretList: {
        code: 0,
        stdout: JSON.stringify([{ name: "VAPID_PRIVATE_KEY" }]),
        stderr: "",
      },
    });
    const err = (await install(h.ctx, { state: s, ...noOptional }).catch(
      (e: Error) => e,
    )) as Error;
    expect(err.message).toContain(
      "VAPID_PRIVATE_KEY is set but its public key is unknown",
    );
    expect(err.message).toContain("Step secrets failed");
    expect(h.deploys).toHaveLength(0);
    expect(existsSync(join(cwd, "wrangler.jsonc"))).toBe(false);
  });

  it("sends supplied provider credentials and records the rest as skipped", async () => {
    const withKey = harness();
    const a = await install(withKey.ctx, {
      state: freshState({ provider: "resend", sendDomains: [] }),
      yes: true,
      optional: { resendApiKey: "re_123" },
    });
    expect(withKey.deploys[0].secrets).toMatchObject({
      RESEND_API_KEY: "re_123",
    });
    expect(a.skipped).toEqual([]);
    expect(withKey.count("createSendingSubdomain")).toBe(0);
  });

  it("a provider credential not supplied is listed as skipped", async () => {
    const h = harness();
    const provider: Provider = "bavimail";
    const out = await install(h.ctx, {
      state: freshState({ provider, sendDomains: [] }),
      yes: true,
      optional: { bavimailApiKey: "bv_key" },
    });
    expect(h.deploys[0].secrets).toMatchObject({ BAVIMAIL_API_KEY: "bv_key" });
    expect(h.deploys[0].secrets).not.toHaveProperty("BAVIMAIL_ALIAS_ID");
    expect(out.skipped).toEqual(["bavimail-alias-id"]);
    expect(h.printed.join("\n")).toMatch(/Skipped:\n\s+Bavimail alias ID/);
  });

  it("resume after a crash between create and record reuses what was created", async () => {
    const s = freshState();
    const crashed: InstallState = {
      ...s,
      status: "provisioning",
      steps: ["provision-intent:attachments", "provision-intent:queue"].map(
        (key) => ({ key, at: "2026-10-16T00:00:00.000Z" }),
      ),
    };
    const h = harness({
      seed: {
        r2: { "acme-attachments": {} },
        queues: [
          {
            id: "q-orphan",
            name: "acme-sequence-emails",
            producers: [],
            consumers: [],
          },
        ],
      },
    });
    const out = await install(h.ctx, { state: crashed, ...noOptional });
    expect(h.count("createR2")).toBe(0);
    expect(h.count("createQueue")).toBe(0);
    expect(
      JSON.parse(h.cf.state.r2["acme-attachments"][R2_MARKER_KEY]),
    ).toMatchObject({ installationId: ID, key: "attachments" });
    expect(out.resources.find((r) => r.key === "queue")).toMatchObject({
      id: "q-orphan",
    });
    expect(out.status).toBe("installed");
  });

  it("resume after a crash before the D1 marker reuses the empty database", async () => {
    const crashed: InstallState = {
      ...freshState(),
      status: "provisioning",
      steps: [{ key: "provision-intent:d1", at: "2026-10-16T00:00:00.000Z" }],
    };
    const h = harness({
      seed: { d1: [{ uuid: "d1-orphan", name: "acme-db" }] },
    });
    const out = await install(h.ctx, { state: crashed, ...noOptional });
    expect(h.count("createD1")).toBe(0);
    expect(out.resources.find((r) => r.key === "d1")).toMatchObject({
      id: "d1-orphan",
    });
    expect(
      h.cf.state.d1[0].queries.some((q) => q.includes("install_state")),
    ).toBe(true);
  });

  it("retries a failed marker write", async () => {
    const h = harness();
    h.cf.failNext("putR2Object", new Error("HTTP 500"));
    h.cf.failNext("putR2Object", new Error("HTTP 503"));
    const out = await install(h.ctx, { state: freshState(), ...noOptional });
    expect(out.status).toBe("installed");
    expect(h.slept.slice(0, 2)).toEqual([1000, 2000]);
  });

  it("looks again before recording a provision intent", async () => {
    const h = harness();
    const real = h.cf.listQueues.bind(h.cf);
    let n = 0;
    h.cf.listQueues = async (a) => {
      n++;
      // Calls: the plan, the look before d1, before attachments, before the queue.
      if (n === 4)
        h.cf.state.queues.push({
          id: "q-theirs",
          name: "acme-sequence-emails",
          producers: [{ type: "worker", script: "theirs" }],
          consumers: [],
        });
      return real(a);
    };
    const err = (await install(h.ctx, {
      state: freshState(),
      ...noOptional,
    }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("`acme-sequence-emails` already exists");
    expect(err.message).toContain("Step provision:queue failed");
    expect(readState(dir, ID)!.steps.map((x) => x.key)).not.toContain(
      "provision-intent:queue",
    );
    expect(h.count("createQueue")).toBe(0);
  });

  it("expect-plan mismatch stops before any create, with the new plan", async () => {
    const h = harness();
    const err = (await install(h.ctx, {
      state: freshState(),
      expectPlan: "000000000000",
      ...noOptional,
    }).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/000000000000/);
    expect(err.message).toMatch(/create\s+d1\s+acme-db/);
    expect(err.message).toMatch(/Step plan failed/);
    expect(
      h.count("createD1") + h.count("createR2") + h.count("createQueue"),
    ).toBe(0);
    expect(readState(dir, ID)?.status).toBe("failed");
  });

  it("a hand-written wrangler.jsonc stops before any write", async () => {
    writeFileSync(join(cwd, "wrangler.jsonc"), '{ "name": "mine" }\n');
    const h = harness();
    await expect(
      install(h.ctx, { state: freshState(), ...noOptional }),
    ).rejects.toThrow(/was not generated by saasmail/);
    expect(h.cf.calls).toEqual([]);
    expect(readFileSync(join(cwd, "wrangler.jsonc"), "utf8")).toBe(
      '{ "name": "mine" }\n',
    );
    expect(existsSync(dir)).toBe(false);
  });

  it("a failing secret list on an existing worker is an error", async () => {
    const s = freshState();
    const h = harness({
      seed: {
        workerVars: { acme: { SAASMAIL_INSTALLATION: installationVar(s) } },
      },
      secretList: { code: 1, stdout: "", stderr: "boom" },
    });
    await expect(install(h.ctx, { state: s, ...noOptional })).rejects.toThrow(
      /Step secrets failed/,
    );
    expect(h.deploys).toHaveLength(0);
  });

  it("a failing deploy leaves status failed; the resume picks up at the deploy", async () => {
    const h = harness({
      deploy: { code: 1, stdout: "", stderr: "upload failed" },
    });
    const err = (await install(h.ctx, {
      state: freshState(),
      ...noOptional,
    }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("upload failed");
    expect(err.message).toContain(
      `Step deploy:1 failed. Nothing after it ran. Run: ${RESUME}`,
    );
    // The hash never went live: no code is shown.
    expect(h.printed.join("\n")).not.toContain("Setup code:");
    const saved = readState(dir, ID)!;
    expect(saved.status).toBe("failed");
    expect(saved.steps.map((x) => x.key)).not.toContain("deploy:1");

    const again = harness({
      seed: {
        d1: h.cf.state.d1.map(({ uuid, name }) => ({ uuid, name })),
        r2: h.cf.state.r2,
        queues: h.cf.state.queues,
      },
    });
    const out = await install(again.ctx, { state: saved, ...noOptional });
    expect(
      again.count("createD1") +
        again.count("createR2") +
        again.count("createQueue"),
    ).toBe(0);
    expect(again.runner.calls.some((c) => c.args.includes("migrations"))).toBe(
      false,
    );
    expect(again.deploys).toHaveLength(1);
    expect(out.status).toBe("installed");
  });
});

describe("routing", () => {
  it("refuses a domain with MX records other than Cloudflare's before enabling", async () => {
    const h = harness({
      seed: {
        dnsRecords: {
          [ZONE.id]: [
            {
              type: "MX",
              name: "example.com",
              content: "mx.google.com",
              priority: 1,
            },
          ],
        },
      },
    });
    const err = (await install(h.ctx, {
      state: freshState(),
      ...noOptional,
    }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain(
      "example.com already has MX records (mx.google.com). Enabling Email Routing would take over that domain's mail.",
    );
    expect(err.message).toContain("Step routing:example.com failed");
    expect(h.count("enableEmailRoutingDns")).toBe(0);
    expect(h.count("putCatchAllWorker")).toBe(0);
  });

  it("stops when the catch-all was taken after the plan", async () => {
    const h = harness();
    const enable = h.cf.enableEmailRoutingDns.bind(h.cf);
    h.cf.enableEmailRoutingDns = async (z) => {
      h.cf.state.catchAll[z] = {
        enabled: true,
        actions: [{ type: "forward", value: ["someone@example.net"] }],
      };
      return enable(z);
    };
    const err = (await install(h.ctx, {
      state: freshState(),
      ...noOptional,
    }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain(
      "`example.com`'s catch-all rule already sends mail elsewhere",
    );
    expect(h.count("putCatchAllWorker")).toBe(0);
  });

  it("waits for Email Routing to be ready before the catch-all", async () => {
    const h = harness({ seed: { routingReadyAfter: 3 } });
    const out = await install(h.ctx, { state: freshState(), ...noOptional });
    expect(out.status).toBe("installed");
    const methods = h.cf.calls.map((c) => c.method);
    const enable = methods.indexOf("enableEmailRoutingDns");
    const put = methods.indexOf("putCatchAllWorker");
    expect(
      methods.slice(enable, put).filter((m) => m === "emailRouting"),
    ).toHaveLength(3);
    expect(h.slept.filter((ms) => ms === 5000).length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it("times out naming the domain and the resume command, keeping the setup code; the resume finishes", async () => {
    const h = harness({ seed: { routingReadyAfter: Infinity } });
    const err = (await install(h.ctx, {
      state: freshState(),
      ...noOptional,
    }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("example.com");
    expect(err.message).toContain("within 60 s");
    expect(err.message).toContain(
      `Step routing:example.com failed. Nothing after it ran. Run: ${RESUME}`,
    );
    expect(h.count("putCatchAllWorker")).toBe(0);
    // The hash is live: the code is printed (not in the error, not in the state).
    const code = /Setup code: (\S+)/.exec(h.printed.join("\n"))?.[1];
    expect(setupCodeHash(code!)).toBe(h.deploys[0].secrets!.SETUP_CODE_HASH);
    expect(err.message).not.toContain(code!);
    const saved = readState(dir, ID)!;
    expect(saved.status).toBe("failed");
    expect(saved.steps.map((x) => x.key)).toContain("deploy:1");

    const again = harness({
      seed: carryOver(h.cf, saved, {
        routing: { [ZONE.id]: { enabled: true, status: "ready" } },
      }),
    });
    again.cf.state.routing[ZONE.id] = { enabled: true, status: "ready" };
    const out = await install(again.ctx, { state: saved, ...noOptional });
    expect(out.status).toBe("installed");
    expect(again.deploys).toHaveLength(0);
    expect(again.count("enableEmailRoutingDns")).toBe(0);
    expect(again.count("putCatchAllWorker")).toBe(1);
  });
});

describe("sending", () => {
  it("joins a TXT value split into quoted chunks before comparing", async () => {
    const h = harness({
      seed: {
        dnsRecords: {
          [ZONE.id]: [
            {
              type: "TXT",
              name: "cf-bounce.example.com",
              content: '"v=spf1 include:_spf.mx.cloudflare.net" " ~all"',
            },
          ],
        },
      },
    });
    await install(h.ctx, { state: freshState(), ...noOptional });
    expect(h.printed.join("\n")).toMatch(
      /ok\s+TXT cf-bounce\.example\.com v=spf1 include:_spf\.mx\.cloudflare\.net ~all/,
    );
  });

  it("an error reading the records is reported, never fatal", async () => {
    const h = harness();
    h.cf.failNext("sendingDns", new Error("HTTP 500"));
    const out = await install(h.ctx, { state: freshState(), ...noOptional });
    expect(out.status).toBe("installed");
    expect(h.printed.join("\n")).toContain(
      "example.com: status unknown: HTTP 500",
    );
  });

  it("reports each record ok or missing; missing records never fail the install", async () => {
    const h = harness({
      seed: {
        dnsRecords: {
          // Case and a trailing dot differ; still the same record.
          [ZONE.id]: [
            {
              type: "mx",
              name: "CF-Bounce.example.com",
              content: "Route1.mx.cloudflare.net.",
            },
          ],
        },
      },
    });
    const out = await install(h.ctx, { state: freshState(), ...noOptional });
    expect(out.status).toBe("installed");
    expect(h.count("createSendingSubdomain")).toBe(1);
    // The installer reads DNS, never writes it.
    expect(
      h.cf.calls.some(
        (c) => /dns/i.test(c.method) && /^(create|put)/.test(c.method),
      ),
    ).toBe(false);
    const summary = h.printed.join("\n");
    expect(summary).toMatch(/^.*example\.com.*pending/m);
    expect(summary).toMatch(
      /ok\s+MX cf-bounce\.example\.com route1\.mx\.cloudflare\.net/,
    );
    expect(summary).toContain(
      "missing: TXT cf-bounce.example.com v=spf1 include:_spf.mx.cloudflare.net ~all",
    );
    expect(summary).toContain(
      "missing: TXT _dmarc.example.com v=DMARC1; p=none",
    );
  });

  it("a DMARC policy of the owner's own counts as present", async () => {
    const own = SENDING_DNS.map((r) =>
      r.name === "_dmarc.example.com"
        ? {
            ...r,
            content:
              '"v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com"',
          }
        : r,
    );
    const h = harness({ seed: { dnsRecords: { [ZONE.id]: own } } });
    await install(h.ctx, { state: freshState(), ...noOptional });
    expect(h.printed.join("\n")).not.toContain("missing:");
  });

  it("all records present: the domain is ready", async () => {
    const h = harness({ seed: { dnsRecords: { [ZONE.id]: SENDING_DNS } } });
    await install(h.ctx, { state: freshState(), ...noOptional });
    const summary = h.printed.join("\n");
    expect(summary).not.toContain("missing:");
    expect(summary).not.toContain("pending");
  });
});

describe("verify", () => {
  it("retries while the worker is not answering yet", async () => {
    let n = 0;
    const h = harness({
      wellKnown: () => {
        n++;
        if (n <= 2) throw new TypeError("fetch failed");
        return Response.json({ installationId: ID, version: VERSION });
      },
    });
    await verify(h.ctx, freshState());
    expect(n).toBe(3);
    expect(h.slept).toEqual([5000, 5000]);
  });

  it("gives up after 60 s naming the URL", async () => {
    const h = harness({
      wellKnown: () => {
        throw new TypeError("fetch failed");
      },
    });
    const err = (await verify(h.ctx, freshState()).catch(
      (e: Error) => e,
    )) as Error;
    expect(err.message).toContain(`${BASE}/.well-known/saasmail`);
    expect(err.message).toContain("fetch failed");
    expect(err.message).not.toContain("certificate");
    expect(h.slept.reduce((a, b) => a + b, 0)).toBe(60_000);
  });

  it("on a custom hostname, says the certificate may still be issuing", async () => {
    const h = harness({
      wellKnown: () => {
        throw new TypeError("fetch failed");
      },
    });
    const s = freshState({ hostname: "mail.example.com", workersDev: false });
    const err = (await verify(h.ctx, s).catch((e: Error) => e)) as Error;
    expect(err.message).toContain(
      `A custom domain's certificate can take several minutes to issue; wait, then run: ${RESUME}`,
    );
  });

  it("fails when setup is open without a code", async () => {
    const h = harness({
      setupStatus: { setupRequired: true, codeRequired: false },
    });
    await expect(verify(h.ctx, freshState())).rejects.toThrow(/setup code/i);
  });
});

describe("install resumed after a failed verify", () => {
  async function failVerify() {
    const first = harness({
      wellKnown: () => {
        throw new TypeError("fetch failed");
      },
    });
    const err = (await install(first.ctx, {
      state: freshState(),
      ...noOptional,
    }).catch((e: Error) => e)) as Error;
    return { first, err, saved: readState(dir, ID)! };
  }

  it("ends installed without another deploy, and hints when setup still needs the code", async () => {
    const { first, err, saved } = await failVerify();
    expect(err.message).toContain("Step verify failed");
    expect(saved.status).toBe("failed");
    expect(/Setup code: (\S+)/.test(first.printed.join("\n"))).toBe(true);

    const again = harness({ seed: carryOver(first.cf, saved) });
    const out = await install(again.ctx, { state: saved, ...noOptional });
    expect(out.status).toBe("installed");
    expect(again.deploys).toHaveLength(0);
    expect(again.count("putCatchAllWorker")).toBe(0);
    expect(again.count("createSendingSubdomain")).toBe(0);
    const printed = again.printed.join("\n");
    expect(printed).not.toContain("Setup code:");
    expect(printed).toContain(
      `The first admin still needs a setup code. If you no longer have it, run: ${RESUME} --new-setup-code`,
    );
  });

  it("redeploys once without secrets when HEAD moved", async () => {
    const { first, saved } = await failVerify();
    const again = harness({
      seed: carryOver(first.cf, saved),
      version: "fedcba654321",
    });
    const out = await install(again.ctx, { state: saved, ...noOptional });
    expect(again.deploys).toHaveLength(1);
    expect(again.deploys[0].secrets).toBeNull();
    expect(out.deployedVersion).toBe("fedcba654321");
    expect(readConfig().vars.SAASMAIL_VERSION).toBe("fedcba654321");
  });
});

describe("config hash", () => {
  it("covers the deployed (top-level) config, not the env block", async () => {
    const h = harness();
    const s = await install(h.ctx, { state: freshState(), ...noOptional });
    const before = renderConfig(h.ctx, s, VERSION).hash;
    expect(before).toBe(s.deployedConfigHash);
    const path = join(cwd, "wrangler.jsonc");
    const text = readFileSync(path, "utf8").replace(
      /\n}\s*$/,
      ',\n  "env": { "dev": { "name": "my-dev" } }\n}\n',
    );
    writeFileSync(path, text);
    expect(renderConfig(h.ctx, s, VERSION).hash).toBe(before);
    expect(renderConfig(h.ctx, s, "fedcba654321").hash).not.toBe(before);
  });
});

describe("resumeInstalled", () => {
  const closed = { setupRequired: false, codeRequired: false };
  const open = { setupRequired: true, codeRequired: true };

  it("with nothing to add creates nothing", async () => {
    const { s, seed } = installedFixture();
    const h = harness({ seed, setupStatus: closed });
    const out = await resumeInstalled(h.ctx, pinned(h, s), {});
    expect(
      h.cf.calls.filter((c) => /^(create|put|enable)/.test(c.method)),
    ).toEqual([]);
    expect(h.deploys).toHaveLength(0);
    expect(h.printed.join("\n")).toContain("Nothing to do.");
    expect(out.status).toBe("installed");
  });

  it("a differing package version points at upgrade", async () => {
    const { s, seed } = installedFixture();
    const h = harness({ seed, setupStatus: closed, pkg: true });
    await resumeInstalled(
      h.ctx,
      { ...pinned(h, s, "1.0.0"), deployedConfigHash: "old" },
      {},
    );
    const text = h.printed.join("\n");
    expect(text).toContain("differs from the deployed version");
    expect(text).toContain(
      `Run ${h.ctx.source.command(`upgrade --name ${s.names.worker}`)} to move it to 1.0.0.`,
    );
  });

  it("adds an inbound domain: routing only, no deploy", async () => {
    const { s, seed } = installedFixture();
    const h = harness({ seed, setupStatus: closed });
    const more = {
      ...s,
      inputs: { ...s.inputs, inboundDomains: ["example.com", "other.org"] },
    };
    const out = await resumeInstalled(h.ctx, pinned(h, more), {});
    expect(h.deploys).toHaveLength(0);
    expect(
      h.cf.calls
        .filter((c) => c.method === "enableEmailRoutingDns")
        .map((c) => c.args),
    ).toEqual([[ZONE2.id]]);
    expect(
      h.cf.calls
        .filter((c) => c.method === "putCatchAllWorker")
        .map((c) => c.args),
    ).toEqual([[ZONE2.id, "acme"]]);
    expect(out.steps.map((x) => x.key)).toContain("routing:other.org");
    expect(out.status).toBe("installed");
    expect(readState(dir, ID)!.steps.map((x) => x.key)).toContain(
      "routing:other.org",
    );
    expect(h.printed.join("\n")).toMatch(/^.*other\.org.*acme/m);
  });

  it("adds a send domain: sending only, no deploy", async () => {
    const { s, seed } = installedFixture();
    const h = harness({ seed, setupStatus: closed });
    const more = {
      ...s,
      inputs: { ...s.inputs, sendDomains: ["example.com", "other.org"] },
    };
    const out = await resumeInstalled(h.ctx, pinned(h, more), {});
    expect(h.deploys).toHaveLength(0);
    expect(
      h.cf.calls
        .filter((c) => c.method === "createSendingSubdomain")
        .map((c) => c.args),
    ).toEqual([[ZONE2.id, "other.org"]]);
    expect(out.steps.map((x) => x.key)).toContain("sending:other.org");
  });

  it("adds a provider credential with one deploy", async () => {
    const { s, seed } = installedFixture({
      provider: "postmark",
      sendDomains: [],
    });
    const h = harness({ seed, setupStatus: closed });
    const out = await resumeInstalled(
      h.ctx,
      pinned(h, { ...s, skipped: ["postmark-api-key"] }),
      { postmarkApiKey: "pm_1" },
    );
    expect(h.deploys).toHaveLength(1);
    expect(h.deploys[0].secrets).toEqual({ POSTMARK_API_KEY: "pm_1" });
    expect(h.deploys[0].args).toContain("--secrets-file");
    expect(out.skipped).toEqual([]);
    const deploy = h.runner.calls.find((c) => c.args[1] === "deploy");
    expect(deploy?.opts?.env).toMatchObject({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
  });

  it("reissues a lost setup code with --new-setup-code, only while no user exists", async () => {
    const { s, seed } = installedFixture();
    const o = harness({ seed, setupStatus: open });
    const out = await resumeInstalled(
      o.ctx,
      pinned(o, s),
      {},
      { newSetupCode: true },
    );
    expect(o.confirms).toEqual([]);
    expect(o.deploys).toHaveLength(1);
    expect(Object.keys(o.deploys[0].secrets!)).toEqual(["SETUP_CODE_HASH"]);
    const code = /Setup code: (\S+)/.exec(o.printed.join("\n"))?.[1];
    expect(setupCodeHash(code!)).toBe(o.deploys[0].secrets!.SETUP_CODE_HASH);
    expect(o.printed.join("\n")).toContain(`${BASE}/onboarding`);
    expect(out.steps.map((x) => x.key)).toContain("setup-code:2");

    const c = harness({ seed, setupStatus: closed });
    await resumeInstalled(c.ctx, pinned(c, s), {}, { newSetupCode: true });
    expect(c.deploys).toHaveLength(0);
    expect(c.printed.join("\n")).not.toContain("Setup code:");
    expect(c.printed.join("\n")).toContain(
      "A site admin already exists; no setup code is needed.",
    );
  });

  it("does not ask for a new code when no deploy is possible (HEAD moved)", async () => {
    const { s, seed } = installedFixture();
    const h = harness({
      seed,
      tty: true,
      version: "fedcba654321",
      wellKnown: () => Response.json({ installationId: ID, version: VERSION }),
      setupStatus: open,
    });
    await resumeInstalled(h.ctx, pinned(h, s, VERSION), {});
    expect(h.confirms).toEqual([]);
    expect(h.deploys).toHaveLength(0);
  });

  it("an unreachable setup status skips the code question; domains and credentials still go on", async () => {
    const { s, seed } = installedFixture({
      provider: "resend",
      sendDomains: [],
    });
    const h = harness({
      seed,
      tty: true,
      setupStatus: closed,
      setupStatusFailures: 1,
    });
    const more = {
      ...s,
      inputs: { ...s.inputs, inboundDomains: ["example.com", "other.org"] },
    };
    const out = await resumeInstalled(h.ctx, pinned(h, more), {
      resendApiKey: "re_1",
    });
    expect(h.confirms).toEqual([]);
    expect(h.deploys.map((d) => d.secrets)).toEqual([
      { RESEND_API_KEY: "re_1" },
    ]);
    expect(out.steps.map((x) => x.key)).toContain("routing:other.org");
    expect(h.printed.join("\n")).toContain(
      `Could not read ${BASE}/api/setup/status (fetch failed); the setup code was left as it is.`,
    );
  });

  it("a workers.dev install keeps its VAPID subject: a later domain and credential deploy once", async () => {
    const first = harness({ setupStatus: closed });
    const installed = await install(first.ctx, {
      state: freshState({
        inboundDomains: [],
        provider: "resend",
        sendDomains: [],
      }),
      yes: true,
      optional: {},
    });
    expect(installed.vapidSubject).toBe("mailto:admin@acme.me.workers.dev");
    const h = harness({
      seed: carryOver(first.cf, installed),
      setupStatus: closed,
    });
    const more = {
      ...installed,
      inputs: { ...installed.inputs, inboundDomains: ["other.org"] },
    };
    const out = await resumeInstalled(h.ctx, more, { resendApiKey: "re_1" });
    expect(h.deploys).toHaveLength(1);
    expect(h.deploys[0].secrets).toEqual({ RESEND_API_KEY: "re_1" });
    expect(h.printed.join("\n")).not.toContain("differs");
    expect(readConfig().vars.VAPID_SUBJECT).toBe(
      "mailto:admin@acme.me.workers.dev",
    );
    expect(out.steps.map((x) => x.key)).toContain("routing:other.org");
  });

  it("without a terminal and without --new-setup-code, keeps the old code", async () => {
    const { s, seed } = installedFixture();
    const h = harness({ seed, setupStatus: open });
    const out = await resumeInstalled(h.ctx, pinned(h, s), {});
    expect(h.deploys).toHaveLength(0);
    expect(h.confirms).toEqual([]);
    const printed = h.printed.join("\n");
    expect(printed).not.toContain("Setup code:");
    expect(printed).toContain(`${RESUME} --new-setup-code`);
    expect(out.steps.map((x) => x.key)).not.toContain("setup-code:2");
  });

  it("in a terminal, asks before replacing the code (default no)", async () => {
    const { s, seed } = installedFixture();
    const declined = harness({
      seed,
      tty: true,
      confirm: false,
      setupStatus: open,
    });
    await resumeInstalled(declined.ctx, pinned(declined, s), {});
    expect(declined.confirms).toEqual([
      {
        msg: "Issue a new setup code? The old one stops working.",
        initial: false,
      },
    ]);
    expect(declined.deploys).toHaveLength(0);

    const accepted = harness({
      seed,
      tty: true,
      confirm: true,
      setupStatus: open,
    });
    await resumeInstalled(accepted.ctx, pinned(accepted, s), {});
    expect(accepted.deploys).toHaveLength(1);
    expect(Object.keys(accepted.deploys[0].secrets!)).toEqual([
      "SETUP_CODE_HASH",
    ]);
  });

  it("never upgrades: after HEAD moved, no deploy, verifies the recorded version", async () => {
    const { s, seed } = installedFixture();
    const h = harness({
      seed,
      version: "fedcba654321",
      wellKnown: () => Response.json({ installationId: ID, version: VERSION }),
      setupStatus: closed,
    });
    await resumeInstalled(h.ctx, pinned(h, s, VERSION), {});
    expect(h.deploys).toHaveLength(0);
    expect(existsSync(join(cwd, "wrangler.jsonc"))).toBe(false);
    const out = h.printed.join("\n");
    expect(out).toContain("Nothing to do.");
    expect(out).toContain(
      "To update it, see docs/updating.md#forks-and-modified-code.",
    );
  });

  it("refuses credentials that would need an upgrade deploy", async () => {
    const { s, seed } = installedFixture({
      provider: "resend",
      sendDomains: [],
    });
    const h = harness({ seed, version: "fedcba654321", setupStatus: closed });
    await expect(
      resumeInstalled(h.ctx, pinned(h, s, VERSION), { resendApiKey: "re_1" }),
    ).rejects.toThrow(/would be an upgrade/);
    expect(h.deploys).toHaveLength(0);
    expect(readState(dir, ID)?.status).toBe("installed");
  });

  it("checks for a hand-written wrangler.jsonc before anything else", async () => {
    writeFileSync(join(cwd, "wrangler.jsonc"), '{ "name": "mine" }\n');
    const { s, seed } = installedFixture();
    const h = harness({ seed });
    await expect(resumeInstalled(h.ctx, s, {})).rejects.toThrow(
      /was not generated by saasmail/,
    );
    expect(h.fetched).toEqual([]);
    expect(h.cf.calls).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });
});
