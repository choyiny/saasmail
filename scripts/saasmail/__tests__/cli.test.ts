import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "../apply.ts";
import { renderConfig } from "../apply-steps.ts";
import type { SendingDnsRecord } from "../cloudflare.ts";
import {
  applyCommand,
  isEntry,
  main,
  resolveToken,
  type Deps,
} from "../cli.ts";
import type { Io } from "../collect.ts";
import { installationIdOf, resourceNames } from "../names.ts";
import { R2_MARKER_KEY } from "../observe.ts";
import type { RunResult } from "../runner.ts";
import { checkoutSource, packageSource } from "../source.ts";
import {
  listStates,
  newState,
  readState,
  writeState,
  type InstallState,
} from "../state.ts";
import {
  fakeCloudflare,
  fakePackage,
  fakeRunner,
  type FakeCloudflare,
  type FakeCloudflareSeed,
} from "./fakes.ts";

const ACCOUNT = "a".repeat(32);
const VERSION = "abcdef123456";
const ID = installationIdOf(ACCOUNT, "acme", "workers.dev");
const BASE = "https://acme.me.workers.dev";
const FLAGS = ["--name", "acme", "--account", ACCOUNT, "--workers-dev"];
const ZONE = { id: "z-example", name: "example.com", status: "active" };
const ZONE2 = { id: "z-other", name: "other.org", status: "active" };
const SENDING_DNS: SendingDnsRecord[] = [
  { type: "TXT", name: "_dmarc.example.com", content: "v=DMARC1; p=none" },
];

let root: string;
let cwd: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "saasmail-cli-"));
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
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type Deploy = { args: string[]; secrets: Record<string, string> | null };

function harness(
  opts: {
    tty?: boolean;
    env?: Record<string, string>;
    seed?: FakeCloudflareSeed;
    prompts?: (string | null)[];
    wellKnown?: () => Response;
    /** The npm registry's dist-tags.latest; null = the registry answers 500. */
    latest?: string | null;
    confirm?: boolean;
    setupStatus?: { setupRequired: boolean; codeRequired: boolean };
    onCloudflare?: (cf: FakeCloudflare) => void;
    /** Package mode: installs live under this home, run from a fake npm package. */
    home?: string;
    /** Package mode: the fake package's version (default VERSION). */
    pkgVersion?: string;
    /** Package mode: what `wrangler secret list` prints (default: the worker is missing). */
    secretList?: RunResult;
    /** Package mode: what `wrangler deploy` returns (default: success). */
    deployResult?: RunResult;
  } = {},
) {
  let cf: FakeCloudflare | null = null;
  let tokenCalls = 0;
  const deploys: Deploy[] = [];
  const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
  const runner = fakeRunner({
    "git rev-parse": () => ok(`${VERSION}\n`),
    "git status": () => ok(""),
    yarn: (args) => {
      if (args[1] === "deploy") {
        const i = args.indexOf("--secrets-file");
        deploys.push({
          args,
          secrets:
            i >= 0
              ? (JSON.parse(readFileSync(args[i + 1]!, "utf8")) as Record<
                  string,
                  string
                >)
              : null,
        });
        return ok();
      }
      if (args[1] === "wrangler" && args[2] === "secret")
        return { code: 1, stdout: "", stderr: "not found" };
      if (args[1] === "wrangler" && args[2] === "d1") return ok();
      throw new Error(`unexpected yarn ${args.join(" ")}`);
    },
    // Package mode runs wrangler as `node <wrangler.js> ...`.
    [process.execPath]: (args) => {
      if (args[1] === "deploy") {
        deploys.push({ args, secrets: null });
        return opts.deployResult ?? ok();
      }
      if (args[1] === "secret")
        return opts.secretList ?? { code: 1, stdout: "", stderr: "not found" };
      return ok();
    },
  });
  const out: string[] = [];
  const prompts = [...(opts.prompts ?? [])];
  const asked: { msg: string; mask?: boolean }[] = [];
  const confirms: string[] = [];
  const events: string[] = [];
  const io: Io = {
    tty: opts.tty ?? false,
    async prompt(msg, o) {
      asked.push({ msg, mask: o.mask });
      events.push(`prompt:${msg}`);
      return prompts.shift() ?? null;
    },
    async select<T>(_m: string, options: { value: T }[]) {
      return options[0]!.value;
    },
    async confirm(m: string, initial: boolean) {
      confirms.push(m);
      events.push(`confirm:${m}`);
      return opts.confirm ?? initial;
    },
    print(t) {
      out.push(t);
    },
  };
  const pkgSource = () => {
    const pkgRoot = fakePackage(join(root, "pkg"), {
      version: opts.pkgVersion ?? VERSION,
      commit: "abc",
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
    return packageSource(pkgRoot);
  };
  const fetched: string[] = [];
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
      return Response.json({ installationId: ID, version: VERSION });
    }
    if (url === "https://registry.npmjs.org/saasmail") {
      if (opts.latest === undefined || opts.latest === null)
        return new Response("down", { status: 500 });
      return Response.json({ "dist-tags": { latest: opts.latest } });
    }
    if (url === `${BASE}/api/setup/status`) {
      return Response.json(
        opts.setupStatus ?? { setupRequired: true, codeRequired: true },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const deps: Deps = {
    io,
    env: opts.env ?? {},
    runner,
    dir,
    source: opts.home ? pkgSource() : checkoutSource(cwd),
    home: opts.home ?? null,
    configDir: cwd,
    fetchImpl,
    sleep: async () => {},
    now: () => new Date("2026-10-17T00:00:00Z"),
    async token() {
      tokenCalls++;
      return "tok";
    },
    cloudflare() {
      cf = fakeCloudflare({
        accounts: [{ id: ACCOUNT, name: "Acme" }],
        subdomain: "me",
        zones: [ZONE, ZONE2],
        sendingDns: { "example.com": SENDING_DNS },
        ...opts.seed,
      });
      opts.onCloudflare?.(cf);
      return cf;
    },
  };
  return {
    deps,
    out,
    asked,
    confirms,
    events,
    fetched,
    runner,
    deploys,
    text: () => out.join("\n"),
    cf: () => cf,
    tokenCalls: () => tokenCalls,
  };
}

function installedState(
  over: Partial<InstallState["inputs"]> = {},
): InstallState {
  const s = newState({
    installationId: ID,
    accountId: ACCOUNT,
    inputs: {
      name: "acme",
      hostname: null,
      workersDev: true,
      inboundDomains: [],
      provider: "cloudflare",
      sendDomains: [],
      cookiePrefix: "saasmail",
      ...over,
    },
    names: resourceNames("acme"),
    baseUrl: BASE,
  });
  return {
    ...s,
    status: "installed",
    resources: [
      {
        key: "d1",
        kind: "d1",
        name: "acme-db",
        id: "d1-x",
        ownership: "created",
        state: "ready",
      },
    ],
    steps: [{ key: "deploy:1", at: "2026-10-16T00:00:00.000Z" }],
    deployedVersion: VERSION,
    vapidPublicKey: "PUBKEY",
  };
}

/** What Cloudflare holds for an installed `s` (enough for its plan to be all reuse/deploy). */
function seedFor(s: InstallState): FakeCloudflareSeed {
  return {
    d1: [{ uuid: "d1-x", name: "acme-db" }],
    r2: {
      "acme-attachments": {
        [R2_MARKER_KEY]: JSON.stringify({
          installationId: s.installationId,
          ownershipNonce: s.ownershipNonce,
          key: "attachments",
        }),
      },
    },
    queues: [
      {
        id: "q-x",
        name: "acme-sequence-emails",
        producers: [{ type: "worker", script: "acme" }],
        consumers: [{ type: "worker", script: "acme" }],
      },
    ],
    workflows: [{ name: "acme-gmail-backfill", scriptName: "acme" }],
    workerVars: {
      acme: {
        SAASMAIL_INSTALLATION: JSON.stringify({
          installationId: s.installationId,
          ownershipNonce: s.ownershipNonce,
        }),
        VAPID_PUBLIC_KEY: "PUBKEY",
      },
    },
  };
}

const MUTATING = [
  "createD1",
  "createR2",
  "createQueue",
  "putR2Object",
  "enableEmailRoutingDns",
  "putCatchAllWorker",
  "createSendingSubdomain",
];
/** Cloudflare calls that change something; a D1 query counts unless it only reads. */
const mutations = (h: ReturnType<typeof harness>) =>
  h
    .cf()!
    .calls.filter(
      (c) =>
        MUTATING.includes(c.method) ||
        (c.method === "queryD1" && !/^\s*SELECT\b/i.test(String(c.args[2]))),
    );

describe("usage", () => {
  it("--help lists both commands, every flag and env var, exit 0", async () => {
    const h = harness();
    expect(await main(["--help"], h.deps)).toBe(0);
    const t = h.text();
    for (const s of [
      "install",
      "status",
      "upgrade",
      "--replace-custom-code",
      "--name",
      "--account",
      "--hostname",
      "--workers-dev",
      "--inbound-domain",
      "--provider",
      "--send-domain",
      "--cookie-prefix",
      "--plan",
      "--expect-plan",
      "--resume",
      "--new-setup-code",
      "--yes",
      "CLOUDFLARE_API_TOKEN",
      "SAASMAIL_RESEND_API_KEY",
      "SAASMAIL_POSTMARK_API_KEY",
      "SAASMAIL_BAVIMAIL_API_KEY",
      "SAASMAIL_BAVIMAIL_ALIAS_ID",
    ])
      expect(t).toContain(s);
  });

  it("no command prints usage and exits 2; unknown command exits 2", async () => {
    expect(await main([], harness().deps)).toBe(2);
    const h = harness();
    expect(await main(["nope"], h.deps)).toBe(2);
    expect(h.text()).toContain("Unknown command: nope");
  });

  it("an unknown flag is a usage error", async () => {
    const h = harness();
    expect(await main(["install", "--frobnicate"], h.deps)).toBe(2);
    expect(h.cf()).toBeNull();
  });
});

describe("install", () => {
  it("without a terminal and without --yes exits 2 before any read", async () => {
    const h = harness();
    expect(await main(["install", ...FLAGS], h.deps)).toBe(2);
    expect(h.text()).toContain(
      "Not running in a terminal: pass --yes to apply (or --plan to only review).",
    );
    expect(h.cf()).toBeNull();
    expect(h.tokenCalls()).toBe(0);
  });

  it("--hostname with --workers-dev is a usage error", async () => {
    const h = harness();
    const code = await main(
      ["install", "--plan", "--hostname", "mail.example.com", "--workers-dev"],
      h.deps,
    );
    expect(code).toBe(2);
    expect(h.cf()).toBeNull();
  });

  it.each([
    ["--inbound-domain", "not a domain"],
    ["--send-domain", "exa_mple.com"],
    ["--hostname", "nodot"],
  ])("an invalid %s is a usage error", async (flag, value) => {
    const h = harness();
    expect(await main(["install", "--plan", flag, value], h.deps)).toBe(2);
    expect(h.text()).toContain("is not a hostname");
    expect(h.cf()).toBeNull();
  });

  it("an unknown --provider is a usage error", async () => {
    const h = harness();
    expect(
      await main(["install", "--plan", "--provider", "sendgrid"], h.deps),
    ).toBe(2);
    expect(h.text()).toContain("--provider");
    expect(h.cf()).toBeNull();
  });

  it("--send-domain with another provider is a usage error", async () => {
    const h = harness();
    const code = await main(
      [
        "install",
        "--plan",
        "--provider",
        "resend",
        "--send-domain",
        "example.com",
      ],
      h.deps,
    );
    expect(code).toBe(2);
    expect(h.text()).toContain("--send-domain");
    expect(h.cf()).toBeNull();
  });

  it("package install writes under home/<slug>", async () => {
    const home = join(root, "home");
    const h = harness({ home });
    const before = readdirSync(cwd).sort();
    const code = await main(["install", "--yes", ...FLAGS], h.deps);
    expect(code).toBe(0);
    const d = join(home, "acme");
    expect(existsSync(join(d, `${ID}.json`))).toBe(true);
    expect(existsSync(join(d, "wrangler.jsonc"))).toBe(true);
    const mode = (p: string) => statSync(p).mode & 0o777;
    expect(mode(join(d, `${ID}.json`))).toBe(0o600);
    expect(mode(join(d, "wrangler.jsonc"))).toBe(0o600);
    expect(mode(d)).toBe(0o700);
    expect(readdirSync(cwd).sort()).toEqual(before);
    expect(existsSync(dir)).toBe(false);
  });

  it("package --plan creates no home directory", async () => {
    const home = join(root, "home");
    const h = harness({ home });
    expect(await main(["install", "--plan", ...FLAGS], h.deps)).toBe(0);
    expect(existsSync(home)).toBe(false);
    expect(h.out.at(-1)).toContain(`npx saasmail@${VERSION} install`);
  });

  describe("package --resume", () => {
    const home = () => join(root, "home");
    const seed = (name: string, status: "installed" | "failed") => {
      const d = join(home(), name);
      writeState(d, {
        ...installedState(),
        installationId: installationIdOf(ACCOUNT, name, "workers.dev"),
        inputs: { ...installedState().inputs, name },
        status,
      });
    };
    const resume = (extra: string[] = []) => {
      const h = harness({ home: home() });
      return main(["install", "--resume", "--yes", ...extra], h.deps).then(
        (code) => ({ code, text: h.text() }),
      );
    };

    it("picks the only unfinished install", async () => {
      seed("acme", "failed");
      seed("done", "installed");
      const r = await resume();
      expect(r.text).not.toContain("Several installs");
      expect(r.text).not.toContain("No saasmail install");
      // Selected and run: it got as far as comparing the recorded resources with Cloudflare.
      expect(r.text).toContain("`acme-db` is recorded but missing");
      expect(existsSync(join(home(), "wrangler.jsonc"))).toBe(false);
    });

    it("several unfinished without --name: exit 2 listing them", async () => {
      seed("acme", "failed");
      seed("beta", "failed");
      seed("done", "installed");
      const r = await resume();
      expect(r.code).toBe(2);
      expect(r.text).toContain("Several installs: acme, beta. Pass --name.");
    });

    it("--name selects", async () => {
      seed("acme", "failed");
      seed("beta", "failed");
      const r = await resume(["--name", "acme"]);
      expect(r.text).not.toContain("Several installs");
      expect(r.text).toContain("`acme-db` is recorded but missing");
    });

    it("none: a clear message, exit 2", async () => {
      const r = await resume();
      expect(r.code).toBe(2);
      expect(r.text).toContain(`No saasmail install to resume in ${home()}.`);
      const n = await resume(["--name", "ghost"]);
      expect(n.code).toBe(2);
      expect(n.text).toContain("No saasmail install named ghost");
    });
  });

  it("package status finds the only install under home", async () => {
    const home = join(root, "home");
    const h = harness({ home });
    expect(await main(["install", "--yes", ...FLAGS], h.deps)).toBe(0);
    const s = harness({ home });
    expect(await main(["status"], s.deps)).toBe(0);
    expect(s.text()).toContain("Installation");
    const none = harness({ home: join(root, "empty") });
    expect(await main(["status"], none.deps)).toBe(2);
    expect(none.text()).toContain("No saasmail install in");
  });

  it("--plan prints the plan and the apply command, writes nothing", async () => {
    const h = harness();
    expect(await main(["install", "--plan", ...FLAGS], h.deps)).toBe(0);
    const text = h.text();
    expect(text).toContain("create  d1");
    expect(text).toContain("No Cloudflare resource or local file was changed.");
    const digest = /Plan ([0-9a-f]{12})/.exec(text)?.[1];
    expect(digest).toBeDefined();
    expect(h.out.at(-1)).toBe(
      `yarn saasmail install --name acme --account ${ACCOUNT} --workers-dev --provider cloudflare --cookie-prefix saasmail --expect-plan ${digest} --yes`,
    );
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(cwd, "wrangler.jsonc"))).toBe(false);
    expect(mutations(h)).toEqual([]);
    expect(h.runner.calls).toEqual([]);
  });

  it("normalises domains (trim, lowercase, dedupe, first-seen order) in the plan and the command", async () => {
    const h = harness();
    const code = await main(
      [
        "install",
        "--plan",
        ...FLAGS,
        "--inbound-domain",
        " Other.ORG ",
        "--inbound-domain",
        "example.com",
        "--inbound-domain",
        "other.org",
        "--send-domain",
        "EXAMPLE.com",
        "--send-domain",
        "example.com",
      ],
      h.deps,
    );
    expect(code).toBe(0);
    const text = h.text();
    expect(text).toContain("Inbound   other.org, example.com");
    expect(text).toContain("Send      example.com");
    expect(h.out.at(-1)).toMatch(
      new RegExp(
        `--workers-dev --inbound-domain other.org --inbound-domain example.com --provider cloudflare --send-domain example.com --cookie-prefix saasmail --expect-plan [0-9a-f]{12} --yes$`,
      ),
    );
  });

  it("--plan warns that a hand-written wrangler.jsonc blocks the apply", async () => {
    writeFileSync(join(cwd, "wrangler.jsonc"), '{ "name": "mine" }\n');
    const h = harness();
    expect(await main(["install", "--plan", ...FLAGS], h.deps)).toBe(0);
    expect(h.text()).toContain(
      "wrangler.jsonc was written by hand: apply will refuse until you move it aside",
    );
    rmSync(join(cwd, "wrangler.jsonc"));
    const clean = harness();
    await main(["install", "--plan", ...FLAGS], clean.deps);
    expect(clean.text()).not.toContain("written by hand");
  });

  it("uses the only account and the defaults without flags", async () => {
    const h = harness();
    expect(await main(["install", "--plan", "--workers-dev"], h.deps)).toBe(0);
    expect(h.out.at(-1)).toContain(
      `--name saasmail --account ${ACCOUNT} --workers-dev --provider cloudflare --cookie-prefix saasmail`,
    );
  });

  it("without a terminal, a missing --hostname/--workers-dev is a usage error", async () => {
    const h = harness();
    expect(await main(["install", "--plan", "--name", "acme"], h.deps)).toBe(2);
    expect(h.text()).toContain("--hostname <host> or --workers-dev");
  });

  it("preflight failure exits 1 with the fix text", async () => {
    const h = harness({ seed: { subdomain: null } });
    expect(await main(["install", "--plan", ...FLAGS], h.deps)).toBe(1);
    expect(h.text()).toContain(
      "Preflight found problems; nothing was changed.",
    );
    expect(h.text()).toContain("Fix:");
  });

  it("preflight runs before an apply too (foreign MX stops it)", async () => {
    const h = harness({
      seed: {
        dnsRecords: {
          [ZONE.id]: [
            {
              name: "example.com",
              type: "MX",
              content: "mx.google.com",
              priority: 1,
            },
          ],
        },
      },
    });
    const code = await main(
      ["install", "--yes", ...FLAGS, "--inbound-domain", "example.com"],
      h.deps,
    );
    expect(code).toBe(1);
    expect(h.text()).toContain("Preflight found problems");
    expect(mutations(h)).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it("a PlanStop exits 1 with its message", async () => {
    const h = harness({ seed: { d1: [{ uuid: "x", name: "acme-db" }] } });
    expect(await main(["install", "--plan", ...FLAGS], h.deps)).toBe(1);
    expect(h.text()).toContain("already exists");
  });

  it("several accounts without a terminal need --account (exit 2)", async () => {
    const h = harness({
      seed: {
        accounts: [
          { id: ACCOUNT, name: "Acme" },
          { id: "b".repeat(32), name: "Other" },
        ],
      },
    });
    const code = await main(
      ["install", "--plan", "--name", "acme", "--workers-dev"],
      h.deps,
    );
    expect(code).toBe(2);
    expect(h.text()).toContain("--account is required");
  });

  it("an account may be named", async () => {
    const h = harness();
    expect(
      await main(
        ["install", "--plan", "--account", "acme", "--workers-dev"],
        h.deps,
      ),
    ).toBe(0);
    expect(h.out.at(-1)).toContain(`--account ${ACCOUNT}`);
  });

  it("an existing unfinished state without --resume exits 1 pointing to --resume", async () => {
    const h = harness();
    writeState(dir, { ...installedState(), status: "failed" });
    expect(await main(["install", "--yes", ...FLAGS], h.deps)).toBe(1);
    expect(h.text()).toContain("yarn saasmail install --resume --name acme");
  });

  it("an installed state without --resume says so and changes nothing", async () => {
    const h = harness();
    writeState(dir, installedState());
    expect(await main(["install", "--yes", ...FLAGS], h.deps)).toBe(0);
    expect(h.text()).toContain("already installed");
    expect(mutations(h)).toEqual([]);
  });

  it("--yes without a terminal installs (provider cloudflare needs no credentials)", async () => {
    const h = harness();
    expect(
      await main(
        [
          "install",
          "--yes",
          ...FLAGS,
          "--inbound-domain",
          "Example.com",
          "--send-domain",
          "example.com",
          "--cookie-prefix",
          "acme",
        ],
        h.deps,
      ),
    ).toBe(0);
    const s = readState(dir, ID)!;
    expect(s.status).toBe("installed");
    expect(s.inputs).toEqual({
      name: "acme",
      hostname: null,
      workersDev: true,
      inboundDomains: ["example.com"],
      provider: "cloudflare",
      sendDomains: ["example.com"],
      cookiePrefix: "acme",
    });
    expect(s.skipped).toEqual([]);
    expect(h.text()).toContain(`saasmail is installed at ${BASE}`);
    expect(h.text()).toMatch(/Setup code: \S+/);
  });

  it("resend: the key comes from SAASMAIL_RESEND_API_KEY and is deployed, never printed", async () => {
    const h = harness({ env: { SAASMAIL_RESEND_API_KEY: "re_secret_key" } });
    expect(
      await main(
        ["install", "--yes", ...FLAGS, "--provider", "resend"],
        h.deps,
      ),
    ).toBe(0);
    expect(h.deploys[0]!.secrets!.RESEND_API_KEY).toBe("re_secret_key");
    expect(h.text()).not.toContain("re_secret_key");
    expect(readState(dir, ID)!.skipped).toEqual([]);
    expect(JSON.stringify(readState(dir, ID))).not.toContain("re_secret_key");
  });

  it("resend without the key and without a terminal exits 1 naming the variable, before any write", async () => {
    const h = harness();
    expect(
      await main(
        ["install", "--yes", ...FLAGS, "--provider", "resend"],
        h.deps,
      ),
    ).toBe(1);
    expect(h.text()).toContain("SAASMAIL_RESEND_API_KEY");
    expect(mutations(h)).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it("bavimail without credentials names the missing variable", async () => {
    const h = harness({ env: { SAASMAIL_BAVIMAIL_API_KEY: "k" } });
    expect(
      await main(
        ["install", "--yes", ...FLAGS, "--provider", "bavimail"],
        h.deps,
      ),
    ).toBe(1);
    expect(h.text()).toContain("SAASMAIL_BAVIMAIL_ALIAS_ID");
    expect(h.text()).not.toContain("SAASMAIL_BAVIMAIL_API_KEY");
    const none = harness();
    await main(
      ["install", "--yes", ...FLAGS, "--provider", "bavimail"],
      none.deps,
    );
    expect(none.text()).toContain(
      "SAASMAIL_BAVIMAIL_API_KEY, SAASMAIL_BAVIMAIL_ALIAS_ID",
    );
  });

  it("postmark in a terminal: masked prompt after the confirm", async () => {
    const h = harness({
      tty: true,
      // inbound domains, cookie prefix, then the key
      prompts: ["", "saasmail", "pm_secret"],
    });
    expect(
      await main(["install", ...FLAGS, "--provider", "postmark"], h.deps),
    ).toBe(0);
    const i = h.events.indexOf("confirm:Apply this plan?");
    expect(i).toBeGreaterThanOrEqual(0);
    const p = h.events.findIndex((e) => e.startsWith("prompt:Postmark"));
    expect(p).toBeGreaterThan(i);
    expect(h.asked.find((a) => a.msg.startsWith("Postmark"))!.mask).toBe(true);
    expect(h.deploys[0]!.secrets!.POSTMARK_API_KEY).toBe("pm_secret");
  });

  it("an empty credential prompt in a terminal stops before any write", async () => {
    const h = harness({ tty: true, prompts: ["", "saasmail", ""] });
    expect(
      await main(["install", ...FLAGS, "--provider", "postmark"], h.deps),
    ).toBe(1);
    expect(h.text()).toContain("SAASMAIL_POSTMARK_API_KEY");
    expect(h.text()).toContain("left empty");
    expect(h.text()).not.toContain("run in a terminal");
    expect(mutations(h)).toEqual([]);
  });

  it("--expect-plan with a stale digest fails without creating anything", async () => {
    const h = harness();
    const code = await main(
      ["install", "--yes", "--expect-plan", "000000000000", ...FLAGS],
      h.deps,
    );
    expect(code).toBe(1);
    expect(h.text()).toContain("The plan changed");
    expect(mutations(h)).toEqual([]);
  });

  it("--yes --expect-plan <stale> stops before any credential prompt or create", async () => {
    const h = harness({ tty: true, prompts: ["x", "y", "z"] });
    const code = await main(
      [
        "install",
        "--yes",
        "--expect-plan",
        "000000000000",
        ...FLAGS,
        "--provider",
        "resend",
      ],
      h.deps,
    );
    expect(code).toBe(1);
    expect(h.asked).toEqual([]);
    expect(h.out.at(-1)).toMatch(/Plan [0-9a-f]{12}$/);
    expect(mutations(h)).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it("the --plan digest applies with --expect-plan", async () => {
    const p = harness();
    await main(["install", "--plan", ...FLAGS], p.deps);
    const digest = /Plan ([0-9a-f]{12})/.exec(p.text())![1]!;
    const h = harness();
    expect(
      await main(
        ["install", "--yes", "--expect-plan", digest, ...FLAGS],
        h.deps,
      ),
    ).toBe(0);
    expect(readState(dir, ID)!.status).toBe("installed");
  });

  it("a plan that changes after it was shown stops the apply", async () => {
    const h = harness({
      onCloudflare(cf) {
        // The second observe (install's recomputation) sees our workflow appear: reuse, not create.
        const orig = cf.listWorkflows.bind(cf);
        let n = 0;
        cf.listWorkflows = async (a) => {
          const r = await orig(a);
          return ++n >= 2
            ? [...r, { name: "acme-gmail-backfill", scriptName: "acme" }]
            : r;
        };
      },
    });
    expect(await main(["install", "--yes", ...FLAGS], h.deps)).toBe(1);
    expect(h.text()).toContain("The plan changed since it was reviewed");
    expect(h.cf()!.calls.filter((c) => c.method === "createD1")).toEqual([]);
  });

  it('declining "Apply this plan?" exits 1 and writes nothing', async () => {
    const h = harness({
      tty: true,
      confirm: false,
      prompts: ["", "", "saasmail"],
    });
    expect(await main(["install", ...FLAGS], h.deps)).toBe(1);
    expect(h.confirms).toEqual(["Apply this plan?"]);
    expect(h.text()).toContain("Nothing was changed.");
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(cwd, "wrangler.jsonc"))).toBe(false);
    expect(mutations(h)).toEqual([]);
  });

  it("--resume with a different --hostname exits 1 naming hostname", async () => {
    const h = harness();
    writeState(dir, { ...installedState(), status: "failed" });
    const code = await main(
      [
        "install",
        "--resume",
        "--yes",
        "--name",
        "acme",
        "--hostname",
        "mail.example.com",
      ],
      h.deps,
    );
    expect(code).toBe(1);
    expect(h.text()).toContain(
      "These options differ from the recorded installation: hostname",
    );
  });

  it("--resume with a different provider or cookie prefix names them", async () => {
    const h = harness({ env: { SAASMAIL_RESEND_API_KEY: "k" } });
    writeState(dir, { ...installedState(), status: "failed" });
    const code = await main(
      [
        "install",
        "--resume",
        "--yes",
        "--name",
        "acme",
        "--provider",
        "resend",
        "--cookie-prefix",
        "other",
      ],
      h.deps,
    );
    expect(code).toBe(1);
    expect(h.text()).toContain(
      "These options differ from the recorded installation: provider, cookie-prefix",
    );
  });

  it("--resume --send-domain on a recorded non-cloudflare provider is a usage error", async () => {
    const h = harness();
    writeState(dir, installedState({ provider: "none" }));
    const code = await main(
      [
        "install",
        "--resume",
        "--plan",
        "--name",
        "acme",
        "--send-domain",
        "example.com",
      ],
      h.deps,
    );
    expect(code).toBe(2);
    expect(h.text()).toContain("--send-domain");
  });

  it("--plan --resume prints a command with --resume and the digest", async () => {
    const s = { ...installedState(), status: "failed" as const };
    const h = harness({ seed: seedFor(s) });
    writeState(dir, s);
    expect(
      await main(["install", "--plan", "--resume", "--name", "acme"], h.deps),
    ).toBe(0);
    expect(h.out.at(-1)).toMatch(
      new RegExp(
        `^yarn saasmail install --resume --name acme --account ${ACCOUNT} --workers-dev --provider cloudflare --cookie-prefix saasmail --expect-plan [0-9a-f]{12} --yes$`,
      ),
    );
    expect(readState(dir, ID)).toEqual(s);
  });

  it("--plan --resume on an installed state prints no --expect-plan", async () => {
    const s = installedState();
    const h = harness({ seed: seedFor(s) });
    writeState(dir, s);
    expect(
      await main(["install", "--plan", "--resume", "--name", "acme"], h.deps),
    ).toBe(0);
    expect(h.out.at(-1)).toBe(
      `yarn saasmail install --resume --name acme --account ${ACCOUNT} --workers-dev --provider cloudflare --cookie-prefix saasmail --yes`,
    );
  });

  it("--plan --resume with a new inbound domain adds it to the plan, writes nothing", async () => {
    const s = installedState({ inboundDomains: ["example.com"] });
    const h = harness({
      seed: {
        ...seedFor(s),
        routing: { [ZONE.id]: { enabled: true, status: "ready" } },
        catchAll: {
          [ZONE.id]: {
            enabled: true,
            actions: [{ type: "worker", value: ["acme"] }],
          },
        },
      },
    });
    writeState(dir, s);
    expect(
      await main(
        [
          "install",
          "--plan",
          "--resume",
          "--name",
          "acme",
          "--inbound-domain",
          "OTHER.org",
        ],
        h.deps,
      ),
    ).toBe(0);
    expect(h.text()).toMatch(/^.*create\s+routing\s+other\.org(\s.*)?$/m);
    expect(h.out.at(-1)).toContain(
      "--inbound-domain example.com --inbound-domain other.org",
    );
    expect(readState(dir, ID)).toEqual(s);
    expect(mutations(h)).toEqual([]);
  });

  it("--resume on an installed state runs resumeInstalled: verify only", async () => {
    const s = installedState();
    const h = harness({
      seed: seedFor(s),
      setupStatus: { setupRequired: false, codeRequired: false },
    });
    writeState(dir, s);
    expect(
      await main(["install", "--resume", "--yes", "--name", "acme"], h.deps),
    ).toBe(0);
    expect(h.out.at(-1)).toBe("Nothing to do.");
    expect(h.confirms).toEqual([]);
    expect(mutations(h)).toEqual([]);
    expect(h.deploys).toEqual([]);
    expect(h.fetched).toContain(`${BASE}/.well-known/saasmail`);
    expect(readState(dir, ID)!.status).toBe("installed");
  });

  it("--resume on an installed state: credentials are optional, and added when given", async () => {
    const s = installedState({ provider: "resend" });
    const pinned = {
      ...s,
      deployedConfigHash: renderConfig(
        { source: checkoutSource(cwd), configDir: cwd } as Ctx,
        s,
        VERSION,
      ).hash,
    };
    const without = harness({
      seed: seedFor(s),
      setupStatus: { setupRequired: false, codeRequired: false },
    });
    writeState(dir, pinned);
    expect(
      await main(
        ["install", "--resume", "--yes", "--name", "acme"],
        without.deps,
      ),
    ).toBe(0);
    expect(without.deploys).toEqual([]);

    const withKey = harness({
      seed: seedFor(s),
      env: { SAASMAIL_RESEND_API_KEY: "re_new" },
      setupStatus: { setupRequired: false, codeRequired: false },
    });
    expect(
      await main(
        ["install", "--resume", "--yes", "--name", "acme"],
        withKey.deps,
      ),
    ).toBe(0);
    expect(withKey.deploys).toHaveLength(1);
    expect(withKey.deploys[0]!.secrets).toEqual({ RESEND_API_KEY: "re_new" });
  });

  it("--resume preflight runs before resumeInstalled (foreign MX on a new inbound domain)", async () => {
    const s = installedState();
    const h = harness({
      seed: {
        ...seedFor(s),
        dnsRecords: {
          [ZONE2.id]: [
            {
              name: "other.org",
              type: "MX",
              content: "mx.google.com",
              priority: 1,
            },
          ],
        },
      },
    });
    writeState(dir, s);
    expect(
      await main(
        [
          "install",
          "--resume",
          "--yes",
          "--name",
          "acme",
          "--inbound-domain",
          "other.org",
        ],
        h.deps,
      ),
    ).toBe(1);
    expect(h.text()).toContain("Preflight found problems");
    expect(h.fetched).toEqual([]);
    expect(readState(dir, ID)).toEqual(s);
  });

  it("--resume --new-setup-code on an installed state replaces the code", async () => {
    const s = installedState();
    const pinned = {
      ...s,
      deployedConfigHash: renderConfig(
        { source: checkoutSource(cwd), configDir: cwd } as Ctx,
        s,
        VERSION,
      ).hash,
    };
    const without = harness({ seed: seedFor(s) });
    writeState(dir, pinned);
    expect(
      await main(
        ["install", "--resume", "--yes", "--name", "acme"],
        without.deps,
      ),
    ).toBe(0);
    expect(without.deploys).toHaveLength(0);
    expect(without.text()).toContain("--new-setup-code");

    const withFlag = harness({ seed: seedFor(s) });
    expect(
      await main(
        ["install", "--resume", "--yes", "--name", "acme", "--new-setup-code"],
        withFlag.deps,
      ),
    ).toBe(0);
    expect(withFlag.deploys).toHaveLength(1);
    expect(withFlag.text()).toMatch(/Setup code: \S+/);
    expect(withFlag.confirms).toEqual([]);
  });

  it("--plan --resume --new-setup-code carries the flag into the apply command", async () => {
    const s = installedState();
    const h = harness({ seed: seedFor(s) });
    writeState(dir, s);
    expect(
      await main(
        ["install", "--plan", "--resume", "--name", "acme", "--new-setup-code"],
        h.deps,
      ),
    ).toBe(0);
    expect(h.out.at(-1)).toBe(
      `yarn saasmail install --resume --name acme --account ${ACCOUNT} --workers-dev --provider cloudflare --cookie-prefix saasmail --new-setup-code --yes`,
    );
  });

  describe("installed --resume that adds a domain", () => {
    const ADD = [
      "install",
      "--resume",
      "--name",
      "acme",
      "--inbound-domain",
      "other.org",
    ];
    const setup = (o: Parameters<typeof harness>[0] = {}) => {
      const s = installedState();
      const pinned = {
        ...s,
        deployedConfigHash: renderConfig(
          { source: checkoutSource(cwd), configDir: cwd } as Ctx,
          s,
          VERSION,
        ).hash,
      };
      writeState(dir, pinned);
      return {
        pinned,
        h: harness({
          seed: seedFor(s),
          setupStatus: { setupRequired: false, codeRequired: false },
          ...o,
        }),
      };
    };

    it("asks to apply in a terminal and records the routing step on yes", async () => {
      const { h } = setup({ tty: true });
      expect(await main(ADD, h.deps)).toBe(0);
      expect(h.confirms).toEqual(["Apply this plan?"]);
      const steps = readState(dir, ID)!.steps.map((x) => x.key);
      expect(steps).toContain("routing:other.org");
      expect(readState(dir, ID)!.inputs.inboundDomains).toEqual(["other.org"]);
    });

    it("declining writes nothing", async () => {
      const { h, pinned } = setup({ tty: true, confirm: false });
      expect(await main(ADD, h.deps)).toBe(1);
      expect(h.text()).toContain("Nothing was changed.");
      expect(mutations(h)).toEqual([]);
      expect(readState(dir, ID)).toEqual(pinned);
    });

    it("--plan prints --expect-plan, and that command applies", async () => {
      const { h, pinned } = setup();
      expect(await main([...ADD, "--plan"], h.deps)).toBe(0);
      const cmd = h.out.at(-1)!;
      expect(cmd).toMatch(
        /^yarn saasmail install --resume --name acme .*--inbound-domain other\.org .*--expect-plan [0-9a-f]{12} --yes$/,
      );
      const again = harness({
        seed: seedFor(pinned),
        setupStatus: { setupRequired: false, codeRequired: false },
      });
      expect(await main(cmd.split(" ").slice(2), again.deps)).toBe(0);
      expect(readState(dir, ID)!.steps.map((x) => x.key)).toContain(
        "routing:other.org",
      );
    });

    it("a stale --expect-plan stops it", async () => {
      const { h, pinned } = setup();
      expect(
        await main([...ADD, "--yes", "--expect-plan", "000000000000"], h.deps),
      ).toBe(1);
      expect(h.text()).toContain("The plan changed");
      expect(mutations(h)).toEqual([]);
      expect(readState(dir, ID)).toEqual(pinned);
    });

    it("a plan that changes before resumeInstalled recomputes it stops", async () => {
      const { h } = setup({
        onCloudflare(cf) {
          // The second observe (resumeInstalled's) sees other.org's catch-all taken by us: reuse.
          const orig = cf.catchAll.bind(cf);
          let n = 0;
          cf.catchAll = async (z) => {
            const r = await orig(z);
            if (z !== ZONE2.id) return r;
            return ++n >= 2
              ? {
                  enabled: true,
                  actions: [{ type: "worker", value: ["acme"] }],
                }
              : r;
          };
          const settings = cf.emailRouting.bind(cf);
          let m = 0;
          cf.emailRouting = async (z) =>
            z === ZONE2.id && ++m >= 2
              ? { enabled: true, status: "ready" }
              : settings(z);
        },
      });
      expect(await main([...ADD, "--yes"], h.deps)).toBe(1);
      expect(h.text()).toContain("The plan changed since it was reviewed");
      expect(
        h.cf()!.calls.filter((c) => c.method === "putCatchAllWorker"),
      ).toEqual([]);
    });
  });

  it("--new-setup-code without --resume is a usage error", async () => {
    const h = harness();
    expect(
      await main(["install", "--plan", ...FLAGS, "--new-setup-code"], h.deps),
    ).toBe(2);
    expect(h.text()).toContain("--new-setup-code");
    expect(h.cf()).toBeNull();
  });

  it("the printed apply command round-trips: it applies with no digest mismatch", async () => {
    const p = harness();
    const args = [
      "install",
      "--plan",
      ...FLAGS,
      "--inbound-domain",
      " Other.ORG ",
      "--inbound-domain",
      "example.com",
      "--send-domain",
      "EXAMPLE.com",
    ];
    expect(await main(args, p.deps)).toBe(0);
    const cmd = p.out.at(-1)!;
    expect(cmd.startsWith("yarn saasmail ")).toBe(true);
    const h = harness();
    expect(await main(cmd.split(" ").slice(2), h.deps)).toBe(0);
    expect(h.text()).not.toContain("The plan changed");
    const s = readState(dir, ID)!;
    expect(s.status).toBe("installed");
    expect(s.inputs.inboundDomains).toEqual(["other.org", "example.com"]);
  });

  it("--resume with nothing recorded exits 1", async () => {
    const h = harness();
    expect(await main(["install", "--resume", "--yes"], h.deps)).toBe(1);
    expect(h.text()).toContain("No installation found to resume");
  });
});

describe("upgrade", () => {
  const home = () => join(root, "home");
  const seedInstall = (over: Partial<InstallState> = {}) => {
    const s = { ...installedState(), deployedVersion: "1.2.0", ...over };
    writeState(join(home(), "acme"), s);
    return s;
  };
  const allSecrets: RunResult = {
    code: 0,
    stdout: JSON.stringify(
      [
        "BETTER_AUTH_SECRET",
        "UNSUBSCRIBE_SECRET",
        "TOKEN_ENCRYPTION_KEY",
        "VAPID_PRIVATE_KEY",
      ].map((name) => ({ name })),
    ),
    stderr: "",
  };
  const upgradeHarness = (o: { tty?: boolean } = {}) => {
    const s = seedInstall();
    return harness({
      home: home(),
      pkgVersion: "1.3.0",
      secretList: allSecrets,
      seed: seedFor(s),
      tty: o.tty,
      wellKnown: () => Response.json({ installationId: ID, version: "1.2.0" }),
    });
  };

  it("upgrade --plan prints the apply command", async () => {
    const h = upgradeHarness();
    const before = readFileSync(join(home(), "acme", `${ID}.json`), "utf8");
    expect(await main(["upgrade", "--plan"], h.deps)).toBe(0);
    const text = h.text();
    expect(text).toContain("Upgrade acme: 1.2.0 → 1.3.0");
    const digest = /Plan ([0-9a-f]{12})/.exec(text)?.[1];
    expect(digest).toBeDefined();
    expect(text).toContain(
      `npx saasmail@1.3.0 upgrade --name acme --expect-plan ${digest}`,
    );
    expect(h.deploys).toHaveLength(0);
    expect(readFileSync(join(home(), "acme", `${ID}.json`), "utf8")).toBe(
      before,
    );
    expect(readdirSync(join(home(), "acme"))).toEqual([`${ID}.json`]);
  });

  it("upgrade without tty needs --yes or --plan", async () => {
    const h = upgradeHarness();
    expect(await main(["upgrade"], h.deps)).toBe(2);
    expect(h.text()).toContain("--yes");
    expect(h.tokenCalls()).toBe(0);
  });

  it("upgrade --yes deploys the package version", async () => {
    const h = upgradeHarness();
    expect(await main(["upgrade", "--yes", "--name", "acme"], h.deps)).toBe(1);
    // The fake site keeps reporting 1.2.0, so verify fails after the deploy.
    expect(h.deploys).toHaveLength(1);
    const s = readState(join(home(), "acme"), ID)!;
    expect(s.status).toBe("failed");
    expect(s.upgradeTarget).toBe("1.3.0");
    expect(h.text()).toContain(
      "npx saasmail@1.3.0 upgrade --resume --name acme",
    );
  });

  it("a failed --replace-custom-code upgrade completes with the printed resume command", async () => {
    const s0 = seedInstall();
    let running = "deadbeef1234-dirty";
    const make = (deployResult?: RunResult) =>
      harness({
        home: home(),
        pkgVersion: "1.3.0",
        secretList: allSecrets,
        seed: seedFor(s0),
        tty: true,
        deployResult,
        wellKnown: () =>
          Response.json({ installationId: ID, version: running }),
      });
    const first = make({ code: 1, stdout: "", stderr: "boom" });
    expect(
      await main(["upgrade", "--yes", "--replace-custom-code"], first.deps),
    ).toBe(1);
    const printed = /Run: (npx saasmail@1\.3\.0 (.+))$/m.exec(first.text());
    expect(printed?.[1]).toBe(
      "npx saasmail@1.3.0 upgrade --resume --name acme",
    );

    running = "1.3.0";
    const again = make();
    expect(await main(printed![2]!.split(" "), again.deps)).toBe(0);
    const s = readState(join(home(), "acme"), ID)!;
    expect(s.status).toBe("installed");
    expect(s.deployedVersion).toBe("1.3.0");
    expect(again.deploys).toHaveLength(1);
  });

  it("checkout mode points at npx", async () => {
    const h = harness();
    expect(await main(["upgrade", "--yes"], h.deps)).toBe(2);
    expect(h.text()).toContain(
      "upgrade runs from npm on installs made with npx saasmail install.",
    );
    expect(h.tokenCalls()).toBe(0);
  });

  it.each([
    ["upgrading", {}],
    ["failed", { upgradeTarget: "1.3.0" }],
  ] as const)(
    "install --resume refuses an unfinished upgrade (%s)",
    async (status, extra) => {
      seedInstall({ status, upgradeTarget: "1.3.0", ...extra });
      const h = harness({ home: home(), pkgVersion: "1.3.0" });
      expect(
        await main(["install", "--resume", "--yes", "--name", "acme"], h.deps),
      ).toBe(1);
      expect(h.text()).toContain(
        "An upgrade to 1.3.0 is unfinished; run npx saasmail@1.3.0 upgrade --resume --name acme.",
      );
      expect(h.deploys).toHaveLength(0);
    },
  );
});

describe("status", () => {
  it("prints the recorded state and the well-known check, changing nothing", async () => {
    const h = harness();
    const s = installedState({ inboundDomains: ["example.com"] });
    writeState(dir, s);
    expect(await main(["status"], h.deps)).toBe(0);
    const text = h.text();
    expect(text).toContain("installed");
    expect(text).toContain(BASE);
    expect(text).toContain("acme-db");
    expect(text).toContain("example.com");
    expect(text).toContain("(matches)");
    expect(h.fetched).toEqual([
      "https://registry.npmjs.org/saasmail",
      `${BASE}/.well-known/saasmail`,
    ]);
    expect(h.cf()).toBeNull();
    expect(h.tokenCalls()).toBe(0);
    expect(h.runner.calls).toEqual([]);
    expect(listStates(dir)).toEqual([s]);
  });

  it("exits 1 when the well-known answer disagrees", async () => {
    const h = harness({
      wellKnown: () => Response.json({ installationId: ID, version: "other" }),
    });
    writeState(dir, installedState());
    expect(await main(["status"], h.deps)).toBe(1);
    expect(h.text()).toContain("other");
  });

  it.each([
    ["null", "null"],
    ["an array", "[1]"],
    ["not JSON", "<html>hi</html>"],
  ])("exits 1 on a 2xx body that is %s", async (_label, body) => {
    const h = harness({ wellKnown: () => new Response(body, { status: 200 }) });
    writeState(dir, installedState());
    expect(await main(["status"], h.deps)).toBe(1);
    expect(h.text()).toContain(
      `Unexpected answer from ${BASE}/.well-known/saasmail`,
    );
  });

  it("exits 1 when unreachable", async () => {
    const h = harness({
      wellKnown: () => {
        throw new Error("ECONNREFUSED");
      },
    });
    writeState(dir, installedState());
    expect(await main(["status"], h.deps)).toBe(1);
    expect(h.text()).toContain("ECONNREFUSED");
  });

  it("prints the latest release, and the upgrade command when running is older", async () => {
    const h = harness({
      home: join(root, "home"),
      latest: "9.9.9",
      wellKnown: () => Response.json({ installationId: ID, version: "1.0.0" }),
    });
    writeState(join(root, "home", "acme"), {
      ...installedState(),
      deployedVersion: "1.0.0",
    });
    expect(await main(["status"], h.deps)).toBe(0);
    expect(h.text()).toMatch(/Latest\s+9\.9\.9/);
    // The latest version, never this package's own (which would redeploy the same release).
    expect(h.text()).toContain("(npx saasmail@9.9.9 upgrade --name acme)");
    expect(h.text()).not.toContain(`saasmail@${VERSION}`);
  });

  it("in a checkout, the hint points at the fork update path (never an upgrade command)", async () => {
    const h = harness({
      latest: "9.9.9",
      wellKnown: () => Response.json({ installationId: ID, version: "1.0.0" }),
    });
    writeState(dir, { ...installedState(), deployedVersion: "1.0.0" });
    expect(await main(["status"], h.deps)).toBe(0);
    expect(h.text()).toContain(
      "(update this checkout with git: see docs/updating.md#forks-and-modified-code)",
    );
    expect(h.text()).not.toContain("upgrade --name");
  });

  it("running at the latest prints no upgrade hint", async () => {
    const h = harness({ latest: VERSION });
    writeState(dir, installedState());
    expect(await main(["status"], h.deps)).toBe(0);
    expect(h.text()).toMatch(new RegExp(`Latest\\s+${VERSION}\\n`));
    expect(h.text()).not.toContain("upgrade --name");
  });

  it("offline prints latest unknown and the exit stays 0", async () => {
    const h = harness({ latest: null });
    writeState(dir, installedState());
    expect(await main(["status"], h.deps)).toBe(0);
    expect(h.text()).toMatch(/Latest\s+unknown/);
  });

  it("a moved install shows where", async () => {
    const h = harness();
    writeState(dir, {
      ...installedState(),
      movedTo: "/home/me/.saasmail/acme",
    });
    await main(["status"], h.deps);
    expect(h.text()).toMatch(/Moved\s+\/home\/me\/\.saasmail\/acme/);
  });

  it("with no installation says so and exits 1", async () => {
    const h = harness();
    expect(await main(["status"], h.deps)).toBe(1);
    expect(h.text()).toContain("No installation found");
    expect(h.text()).toContain("yarn saasmail install");
  });

  it("with several installations needs --name (exit 2)", async () => {
    const h = harness();
    writeState(dir, installedState());
    const other = installedState();
    writeState(dir, {
      ...other,
      installationId: "beta-000000000000",
      inputs: { ...other.inputs, name: "beta" },
    });
    expect(await main(["status"], h.deps)).toBe(2);
    expect(h.text()).toContain("pass --name");
  });
});

const source = checkoutSource("/repo");

describe("resolveToken", () => {
  it("prefers CLOUDFLARE_API_TOKEN without running wrangler", async () => {
    const r = fakeRunner({});
    expect(
      await resolveToken({ CLOUDFLARE_API_TOKEN: "env-tok" }, r, source),
    ).toBe("env-tok");
    expect(r.calls).toEqual([]);
  });

  it("uses the last token-shaped line of wrangler's output, without colour codes", async () => {
    const tok = "AbC_def-123.456789012345";
    const r = fakeRunner({
      yarn: () => ({
        code: 0,
        stdout: `\u001b[33m▲ [WARNING] a newer wrangler is out\u001b[0m\n\u001b[1m${tok}\u001b[22m\n\n`,
        stderr: "",
      }),
    });
    expect(await resolveToken({}, r, source)).toBe(tok);
    expect(r.calls[0]!.args).toEqual(["-s", "wrangler", "auth", "token"]);
  });

  it("package mode runs its wrangler's auth token without --config", async () => {
    const pkgSource = packageSource(
      fakePackage(mkdtempSync(join(tmpdir(), "tok-")), {
        version: "1.2.0",
        commit: "abc123def456",
      }),
    );
    const tok = "AbC_def-123.456789012345";
    const r = fakeRunner({
      [process.execPath]: () => ({ code: 0, stdout: `${tok}\n`, stderr: "" }),
    });
    expect(await resolveToken({}, r, pkgSource)).toBe(tok);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.cmd).toBe(process.execPath);
    expect(r.calls[0]!.args.slice(1)).toEqual(["auth", "token"]);
    expect(r.calls[0]!.args).not.toContain("--config");
  });

  it("package mode without a login prints its pinned login command", async () => {
    const pkgSource = packageSource(
      fakePackage(mkdtempSync(join(tmpdir(), "tok-")), {
        version: "1.2.0",
        commit: "abc123def456",
      }),
    );
    const r = fakeRunner({
      [process.execPath]: () => ({ code: 1, stdout: "", stderr: "x" }),
    });
    await expect(resolveToken({}, r, pkgSource)).rejects.toThrow(
      "Run npx wrangler@4.127.0 login first.",
    );
  });

  it("with no token-shaped line says to run wrangler login", async () => {
    const r = fakeRunner({
      yarn: () => ({
        code: 0,
        stdout: "You are not logged in.\nshort\n",
        stderr: "",
      }),
    });
    await expect(resolveToken({}, r, source)).rejects.toThrow(
      "Run yarn wrangler login first.",
    );
  });

  it("without a login says to run wrangler login", async () => {
    const r = fakeRunner({
      yarn: () => ({ code: 1, stdout: "", stderr: "Not logged in" }),
    });
    await expect(resolveToken({}, r, source)).rejects.toThrow(
      "Run yarn wrangler login first.",
    );
  });

  it("a token failure exits 1 with its message", async () => {
    const h = harness();
    h.deps.token = async () => {
      throw new Error("Run yarn wrangler login first.");
    };
    expect(await main(["install", "--plan", ...FLAGS], h.deps)).toBe(1);
    expect(h.text()).toContain("Run yarn wrangler login first.");
    expect(h.cf()).toBeNull();
  });
});

describe("applyCommand", () => {
  it("single-quotes values outside the safe set", () => {
    const s = installedState({
      hostname: "mail.example.com",
      workersDev: false,
      cookiePrefix: "o'brien prefix",
    });
    expect(applyCommand(s, false, "abc", false, source)).toBe(
      `yarn saasmail install --name acme --account ${ACCOUNT} --hostname mail.example.com --provider cloudflare --cookie-prefix 'o'\\''brien prefix' --expect-plan abc --yes`,
    );
  });
});

describe("isEntry", () => {
  it("prefers import.meta.main, else compares real paths", () => {
    const d = mkdtempSync(join(tmpdir(), "sm-cli-"));
    const file = join(d, "cli.ts");
    writeFileSync(file, "");
    const link = join(d, "link.ts");
    symlinkSync(file, link);
    const url = pathToFileURL(file).href;
    expect(isEntry(true, undefined, url)).toBe(true);
    expect(isEntry(false, file, url)).toBe(false);
    expect(isEntry(undefined, link, url)).toBe(true);
    expect(isEntry(undefined, join(d, "other.ts"), url)).toBe(false);
    expect(isEntry(undefined, undefined, url)).toBe(false);
    rmSync(d, { recursive: true, force: true });
  });
});

describe("a checkout install moved to the package", () => {
  const MOVED = "/home/me/.saasmail/acme";
  const MOVED_LINE = `This install moved to ${MOVED}. Run npx saasmail upgrade --name acme.`;

  it("the checkout refuses install and --resume", async () => {
    writeState(dir, { ...installedState(), movedTo: MOVED });
    const fresh = harness({});
    expect(await main(["install", ...FLAGS, "--yes"], fresh.deps)).toBe(1);
    expect(fresh.text()).toContain(MOVED_LINE);
    expect(fresh.deploys).toHaveLength(0);

    const resume = harness({});
    expect(
      await main(
        ["install", "--resume", "--name", "acme", "--yes"],
        resume.deps,
      ),
    ).toBe(1);
    expect(resume.text()).toContain(MOVED_LINE);
    expect(resume.deploys).toHaveLength(0);
  });
});
