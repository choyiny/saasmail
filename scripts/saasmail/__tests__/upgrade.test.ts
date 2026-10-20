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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "../apply.ts";
import { renderConfig } from "../apply-steps.ts";
import type { Io } from "../collect.ts";
import { ConfigConflict } from "../config.ts";
import { resourceNames } from "../names.ts";
import { R2_MARKER_KEY } from "../observe.ts";
import type { RunResult } from "../runner.ts";
import { packageSource } from "../source.ts";
import {
  newState,
  readState,
  writeState,
  type InstallState,
} from "../state.ts";
import { formatUpgradePlan, planUpgrade, upgrade } from "../upgrade.ts";
import {
  fakeCloudflare,
  fakePackage,
  fakeRunner,
  type FakeCloudflareSeed,
} from "./fakes.ts";

const ACCOUNT = "a".repeat(32);
const BASE = "https://acme.me.workers.dev";
const ID = "acme-1a2b3c4d5e6f";
const TO = "1.3.0";
const LAST =
  "Migrations cannot be undone. If the new release is broken, the way back is the next release.";
const ALL_BUT_TOKEN = [
  "BETTER_AUTH_SECRET",
  "UNSUBSCRIBE_SECRET",
  "VAPID_PRIVATE_KEY",
];
const ALL_SECRETS = [...ALL_BUT_TOKEN, "TOKEN_ENCRYPTION_KEY"];

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "saasmail-upgrade-"));
  home = join(root, "home", "acme");
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const res = (
  key: string,
  kind: "d1" | "r2" | "queue" | "worker" | "workflow",
  name: string,
  id = name,
  ownership: "created" | "adopted" = "created",
) => ({ key, kind, name, id, ownership, state: "ready" as const });

/** Installed at 1.2.0, without the queue (a resource the new version needs). */
function installedAt120(): InstallState {
  const s = newState({
    installationId: ID,
    accountId: ACCOUNT,
    inputs: {
      name: "acme",
      hostname: null,
      workersDev: true,
      inboundDomains: [],
      provider: "none",
      sendDomains: [],
      cookiePrefix: "acme",
    },
    names: resourceNames("acme"),
    baseUrl: BASE,
  });
  return {
    ...s,
    ownershipNonce: "n".repeat(64),
    status: "installed",
    resources: [
      res("d1", "d1", "acme-db", "d1-existing"),
      res("attachments", "r2", "acme-attachments"),
      res("worker", "worker", "acme"),
      res("workflow", "workflow", "acme-gmail-backfill"),
    ],
    steps: [{ key: "deploy:1", at: "2026-10-16T00:00:00.000Z" }],
    deployedVersion: "1.2.0",
    deployedConfigHash: "old",
    vapidPublicKey: "PUBKEY",
    vapidSubject: "mailto:admin@example.com",
  };
}

function seedFor(s: InstallState): FakeCloudflareSeed {
  return {
    d1: [{ uuid: "d1-existing", name: "acme-db" }],
    d1Migrations: { "d1-existing": ["0000_init.sql"] },
    r2: {
      "acme-attachments": {
        [R2_MARKER_KEY]: JSON.stringify({
          installationId: s.installationId,
          ownershipNonce: s.ownershipNonce,
          key: "attachments",
        }),
      },
    },
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

type Deploy = { args: string[]; secrets: Record<string, string> | null };

function harness(
  opts: {
    state?: InstallState;
    seed?: FakeCloudflareSeed;
    /** The version /.well-known reports before the first deploy. */
    running?: string | null;
    /** The installation id it reports before the first deploy. */
    runningId?: string | null;
    secrets?: string[];
    confirm?: boolean;
    tty?: boolean;
    /** Setup open without a code: verify refuses. */
    setupOpen?: boolean;
  } = {},
) {
  const s = opts.state ?? installedAt120();
  writeState(home, s);
  const cf = fakeCloudflare(opts.seed ?? seedFor(s));
  const pkgRoot = fakePackage(join(root, "pkg"), {
    version: TO,
    commit: "c".repeat(40),
  });
  mkdirSync(join(pkgRoot, "migrations"), { recursive: true });
  copyFileSync(
    new URL("../../../wrangler.jsonc.example", import.meta.url),
    join(pkgRoot, "wrangler.jsonc.example"),
  );
  writeFileSync(
    join(pkgRoot, "migrations", "0000_init.sql"),
    "CREATE TABLE a (x);",
  );
  writeFileSync(
    join(pkgRoot, "migrations", "0001_more.sql"),
    "CREATE TABLE b (y);",
  );
  const source = packageSource(pkgRoot);
  const deploys: Deploy[] = [];
  const migrations: string[][] = [];
  const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
  let deployResult: RunResult = ok();
  const runner = fakeRunner({
    [process.execPath]: (args) => {
      const w = args.slice(1);
      if (w[0] === "deploy") {
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
        return deployResult;
      }
      if (w[0] === "secret") {
        const names = opts.secrets ?? ALL_BUT_TOKEN;
        return ok(JSON.stringify(names.map((name) => ({ name }))));
      }
      if (w[0] === "d1") {
        migrations.push(w);
        return ok();
      }
      throw new Error(`unexpected wrangler ${args.join(" ")}`);
    },
  });
  const printed: string[] = [];
  const io: Io = {
    tty: opts.tty ?? false,
    async prompt() {
      return null;
    },
    async select() {
      throw new Error("no select");
    },
    async confirm() {
      return opts.confirm ?? true;
    },
    print(t) {
      printed.push(t);
    },
  };
  let down = false;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : String(input);
    if (url === `${BASE}/.well-known/saasmail`) {
      const deployed = deploys.length > 0 && deployResult.code === 0;
      if (down && !deployed) throw new TypeError("fetch failed");
      return Response.json({
        installationId: deployed
          ? ID
          : opts.runningId === undefined
            ? ID
            : opts.runningId,
        version: deployed
          ? TO
          : opts.running === undefined
            ? "1.2.0"
            : opts.running,
      });
    }
    if (url === `${BASE}/api/setup/status`) {
      return Response.json({
        setupRequired: opts.setupOpen === true,
        codeRequired: opts.setupOpen !== true,
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const ctx: Ctx = {
    cf,
    runner,
    io,
    dir: home,
    source,
    configDir: home,
    fetchImpl,
    sleep: async () => {},
    now: () => new Date("2026-10-17T00:00:00Z"),
  };
  return {
    ctx,
    cf,
    runner,
    deploys,
    migrations,
    printed,
    state: s,
    /** /.well-known unreachable until a deploy succeeds. */
    siteDown() {
      down = true;
    },
    failDeploys() {
      deployResult = { code: 1, stdout: "", stderr: "boom" };
    },
    okDeploys() {
      deployResult = ok();
    },
    saved: () => readState(home, ID)!,
  };
}

const run = (
  h: ReturnType<typeof harness>,
  o: Partial<Parameters<typeof upgrade>[1]> = {},
) =>
  upgrade(h.ctx, {
    state: h.saved(),
    yes: true,
    replaceCustomCode: false,
    resume: false,
    ...o,
  });

describe("planUpgrade", () => {
  it("plan lists migrations, new secret and new resource", async () => {
    const h = harness();
    const p = await planUpgrade(h.ctx, h.state);
    expect(p.from).toBe("1.2.0");
    expect(p.to).toBe(TO);
    expect(p.comparison).toEqual({ kind: "upgrade" });
    expect(p.migrations).toEqual(["0001_more.sql"]);
    expect(p.create.map((a) => [a.kind, a.name])).toEqual([
      ["queue", "acme-sequence-emails"],
    ]);
    expect(p.secrets).toEqual(["TOKEN_ENCRYPTION_KEY"]);
    expect(p.configChanged).toBe(true);
    expect(p.digest).toMatch(/^[0-9a-f]{12}$/);
    const lines = formatUpgradePlan(p).split("\n");
    expect(lines[0]).toBe("Upgrade acme: 1.2.0 → 1.3.0");
    expect(lines).toContain("Migrations: 0001_more.sql");
    expect(lines).toContain("Create: queue acme-sequence-emails");
    expect(lines).toContain("New secrets: TOKEN_ENCRYPTION_KEY");
    expect(lines).toContain("Config: changes");
    expect(lines.at(-1)).toBe(LAST);
  });

  it("no d1_migrations table: every migration is pending", async () => {
    const s = installedAt120();
    const h = harness({ seed: { ...seedFor(s), d1Migrations: {} } });
    const p = await planUpgrade(h.ctx, h.state);
    expect(p.migrations).toEqual(["0000_init.sql", "0001_more.sql"]);
  });

  it("no d1_migrations table but other tables: the plan stops", async () => {
    const s = installedAt120();
    const h = harness({
      seed: {
        ...seedFor(s),
        d1Migrations: {},
        d1Tables: { "d1-existing": ["users", "emails"] },
      },
    });
    await expect(planUpgrade(h.ctx, h.state)).rejects.toThrow(
      "D1 acme-db has tables but no d1_migrations table; saasmail cannot tell which migrations ran. See docs/updating.md",
    );
    await expect(run(h)).rejects.toThrow("no d1_migrations table");
    expect(h.deploys).toHaveLength(0);
    expect(h.migrations).toHaveLength(0);
    expect(h.saved().status).toBe("installed");
  });
});

describe("upgrade", () => {
  it("applies resources, config, migrations, deploy, markers, verify", async () => {
    const h = harness();
    const s = await run(h);
    expect(s.status).toBe("installed");
    expect(s.deployedVersion).toBe(TO);
    expect(s.upgradedAt).toBe("2026-10-17T00:00:00.000Z");
    expect(s.upgradeTarget).toBeUndefined();
    expect(s.resources.find((r) => r.key === "queue")?.ownership).toBe(
      "created",
    );
    expect(h.migrations).toHaveLength(1);
    expect(h.deploys).toHaveLength(1);
    const ctxHash = renderConfig(h.ctx, s, TO).hash;
    expect(s.deployedConfigHash).toBe(ctxHash);
    expect(
      ["resources", "config", "migrations", "deploy", "markers", "verify"].map(
        (k) => s.steps.some((x) => x.key === `upgrade:${TO}:${k}`),
      ),
    ).toEqual([true, true, true, true, true, true]);
    expect(
      h.cf.state.d1[0]!.queries.some((q) =>
        q.startsWith("INSERT OR REPLACE INTO install_state"),
      ),
    ).toBe(true);
    expect(readState(home, ID)!.status).toBe("installed");
  });

  it("downgrade refused", async () => {
    const h = harness({ running: "1.4.0" });
    await expect(run(h)).rejects.toThrow("npx saasmail@1.4.0");
    await expect(run(h)).rejects.toThrow("1.4.0");
    expect(h.runner.calls).toHaveLength(0);
    expect(h.saved().status).toBe("installed");
  });

  it("installation id mismatch stops", async () => {
    const h = harness({ runningId: "someone-else" });
    await expect(run(h)).rejects.toThrow(
      "this is not the install the state describes",
    );
    expect(h.deploys).toHaveLength(0);
  });

  it("null id accepted only after adopt", async () => {
    const plain = harness({ runningId: null });
    await expect(run(plain)).rejects.toThrow(
      "this is not the install the state describes",
    );
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });

    const adopted = harness({
      runningId: null,
      state: { ...installedAt120(), adoptedAt: "2026-10-16T00:00:00.000Z" },
    });
    const s = await run(adopted);
    expect(s.status).toBe("installed");
    expect(adopted.deploys).toHaveLength(1);

    // After that first upgrade, a null id stops again.
    const later = harness({ runningId: null, running: TO, state: s });
    await expect(run(later)).rejects.toThrow(
      "this is not the install the state describes",
    );
  });

  it("the first upgrade after adopt writes the adopted bucket's marker", async () => {
    const base = installedAt120();
    const s0: InstallState = {
      ...base,
      adoptedAt: "2026-10-16T00:00:00.000Z",
      resources: base.resources.map((r) =>
        r.key === "attachments" ? { ...r, ownership: "adopted" } : r,
      ),
    };
    const h = harness({
      state: s0,
      seed: { ...seedFor(s0), r2: { "acme-attachments": {} } },
    });
    await run(h);
    expect(
      JSON.parse(h.cf.state.r2["acme-attachments"]![R2_MARKER_KEY]!),
    ).toEqual({
      installationId: ID,
      ownershipNonce: s0.ownershipNonce,
      key: "attachments",
    });
  });

  it("custom code stops without --replace-custom-code", async () => {
    const h = harness({ running: "deadbeef1234-dirty" });
    const e = await run(h).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    const m = (e as Error).message;
    expect(m).toContain("not a release");
    expect(m).toContain("stock saasmail");
    expect(m).toContain("own checkout");
    expect(m).toContain("--replace-custom-code");
    expect(h.runner.calls).toHaveLength(0);
  });

  it("custom code proceeds with --replace-custom-code", async () => {
    const h = harness({ running: "deadbeef1234-dirty" });
    const s = await run(h, { replaceCustomCode: true });
    expect(s.status).toBe("installed");
    const text = h.printed.join("\n");
    expect(text).toContain("Replacing custom code: deadbeef1234-dirty");
  });

  it("hand-edited config refused", async () => {
    const h = harness();
    writeFileSync(join(home, "wrangler.jsonc"), "{}\n");
    const e = await run(h).catch((x: Error) => x);
    expect(e).toBeInstanceOf(ConfigConflict);
    expect((e as Error).message).toContain(join(home, "wrangler.jsonc"));
    expect(h.deploys).toHaveLength(0);
    expect(readFileSync(join(home, "wrangler.jsonc"), "utf8")).toBe("{}\n");
  });

  it("only missing secrets are sent", async () => {
    const h = harness();
    await run(h);
    expect(h.deploys).toHaveLength(1);
    expect(Object.keys(h.deploys[0]!.secrets ?? {})).toEqual([
      "TOKEN_ENCRYPTION_KEY",
    ]);
    expect(h.deploys[0]!.secrets).not.toHaveProperty("SETUP_CODE_HASH");
  });

  it("no missing secrets: deploys without a secrets file", async () => {
    const h = harness({ secrets: ALL_SECRETS });
    await run(h);
    expect(h.deploys).toHaveLength(1);
    expect(h.deploys[0]!.args).not.toContain("--secrets-file");
  });

  it("resume after failed deploy skips migrations", async () => {
    const h = harness();
    h.failDeploys();
    const e = await run(h).catch((x: Error) => x);
    expect((e as Error).message).toContain("upgrade --resume --name acme");
    const failed = h.saved();
    expect(failed.status).toBe("failed");
    expect(failed.upgradeTarget).toBe(TO);
    expect(failed.steps.map((x) => x.key)).toContain(
      `upgrade:${TO}:migrations`,
    );
    expect(h.migrations).toHaveLength(1);

    h.okDeploys();
    const deploysBefore = h.deploys.length;
    const s = await run(h, { resume: true });
    expect(h.migrations).toHaveLength(1);
    expect(h.deploys.length - deploysBefore).toBe(1);
    expect(s.status).toBe("installed");
    expect(s.deployedVersion).toBe(TO);
    expect(s.upgradeTarget).toBeUndefined();
  });

  it("resume with /.well-known unreachable continues", async () => {
    const h = harness();
    h.failDeploys();
    await run(h).catch(() => {});
    expect(h.saved().status).toBe("failed");
    h.okDeploys();
    h.siteDown();
    const s = await run(h, { resume: true });
    expect(s.status).toBe("installed");
    expect(s.deployedVersion).toBe(TO);
  });

  it("a fresh upgrade with /.well-known unreachable stops", async () => {
    const h = harness();
    h.siteDown();
    await expect(run(h)).rejects.toThrow("Could not read");
    expect(h.runner.calls).toHaveLength(0);
  });

  it("resumes a killed run (status upgrading)", async () => {
    const base = installedAt120();
    const h = harness({
      state: {
        ...base,
        status: "upgrading",
        upgradeTarget: TO,
        resources: [
          ...base.resources,
          res("queue", "queue", "acme-sequence-emails", "q-1"),
        ],
        steps: [
          ...base.steps,
          { key: "provision-intent:queue", at: "2026-10-17T00:00:00.000Z" },
          { key: `upgrade:${TO}:resources`, at: "2026-10-17T00:00:00.000Z" },
          { key: `upgrade:${TO}:migrations`, at: "2026-10-17T00:00:00.000Z" },
        ],
      },
      seed: {
        ...seedFor(base),
        queues: [
          {
            id: "q-1",
            name: "acme-sequence-emails",
            producers: [],
            consumers: [],
          },
        ],
      },
    });
    const s = await run(h, { resume: true });
    expect(h.migrations).toHaveLength(0);
    expect(h.deploys).toHaveLength(1);
    expect(s.status).toBe("installed");
    expect(s.deployedVersion).toBe(TO);
  });

  it("a failed verify names only the upgrade resume command", async () => {
    const h = harness({ setupOpen: true });
    const e = await run(h).catch((x: Error) => x);
    const m = (e as Error).message;
    expect(m).toContain("anyone could claim this instance");
    expect(m).toContain("npx saasmail@1.3.0 upgrade --resume --name acme");
    expect(m).not.toContain("install --resume");
  });

  it("an unfinished upgrade to another version stops", async () => {
    const h = harness({
      state: { ...installedAt120(), status: "failed", upgradeTarget: "1.2.5" },
    });
    await expect(run(h, { resume: true })).rejects.toThrow(
      "An upgrade to 1.2.5 is unfinished; run npx saasmail@1.2.5 upgrade --resume",
    );
    expect(h.deploys).toHaveLength(0);
  });

  it("expect-plan mismatch stops", async () => {
    const h = harness();
    await expect(run(h, { expectPlan: "000000000000" })).rejects.toThrow(
      "The plan changed since it was reviewed",
    );
    expect(h.deploys).toHaveLength(0);
    expect(h.migrations).toHaveLength(0);
    expect(h.saved().status).toBe("installed");
  });

  it("expect-plan match applies", async () => {
    const h = harness();
    const p = await planUpgrade(h.ctx, h.state);
    const s = await run(h, { expectPlan: p.digest });
    expect(s.status).toBe("installed");
  });

  it("declined confirmation changes nothing", async () => {
    const h = harness({ tty: true, confirm: false });
    await expect(run(h, { yes: false })).rejects.toThrow("Nothing was changed");
    expect(h.deploys).toHaveLength(0);
    expect(h.saved().status).toBe("installed");
  });

  it("same version redeploys", async () => {
    const first = harness();
    const s = await run(first);
    const queue = first.cf.state.queues[0]!;
    const again = harness({
      running: TO,
      state: s,
      secrets: ALL_SECRETS,
      seed: {
        ...seedFor(s),
        d1Migrations: { "d1-existing": ["0000_init.sql", "0001_more.sql"] },
        queues: [{ ...queue, consumers: [{ type: "worker", script: "acme" }] }],
      },
    });
    const s2 = await run(again);
    expect(again.deploys).toHaveLength(1);
    expect(again.deploys[0]!.args).not.toContain("--secrets-file");
    expect(again.printed.join("\n")).toContain("Migrations: none");
    expect(s2.status).toBe("installed");
    expect(s2.deployedVersion).toBe(TO);
  });

  it("a corrupt state file fails without leaking the lock", async () => {
    const h = harness();
    const state = h.saved();
    writeFileSync(join(home, `${ID}.json`), "{ not json");
    await expect(
      upgrade(h.ctx, {
        state,
        yes: true,
        replaceCustomCode: false,
        resume: false,
      }),
    ).rejects.toThrow();
    expect(existsSync(join(home, `${ID}.lock`))).toBe(false);
  });

  it("--plan writes nothing and prints the apply command", async () => {
    const h = harness();
    const before = readFileSync(join(home, `${ID}.json`), "utf8");
    await run(h, { plan: true });
    expect(readFileSync(join(home, `${ID}.json`), "utf8")).toBe(before);
    expect(existsSync(join(home, `${ID}.lock`))).toBe(false);
    expect(existsSync(join(home, "wrangler.jsonc"))).toBe(false);
    expect(h.deploys).toHaveLength(0);
    const p = await planUpgrade(h.ctx, h.state);
    expect(h.printed.join("\n")).toContain(
      `npx saasmail@${TO} upgrade --name acme --expect-plan ${p.digest}`,
    );
  });
});
