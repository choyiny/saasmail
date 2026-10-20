// `upgrade` (spec §5, §5a): moves an install to this package's version. Read-only up to the
// confirmed plan; then resources, config, migrations, deploy, markers and verify, each recorded as
// `upgrade:<to>:<step>` so `--resume` continues a failed upgrade from the first unrecorded step.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  desiredOf,
  look,
  onAccount,
  provision,
  resource,
  writeMarkers,
  type Ctx,
} from "./apply.ts";
import {
  applyMigrations,
  deploy,
  existingSecretNames,
  generatedSecrets,
  renderConfig,
  resumeCommand,
  verifyAt,
  writeConfig,
} from "./apply-steps.ts";
import { ConfigConflict, isGenerated, vapidSubjectFor } from "./config.ts";
import type { Observed } from "./observe.ts";
import { computePlan, type Action, type Plan } from "./plan.ts";
import {
  acquireLock,
  hasStep,
  readState,
  recordResource,
  recordStep,
  transition,
  writeState,
  type InstallState,
} from "./state.ts";
import { compareRunning, type Comparison } from "./versions.ts";

export type UpgradePlan = {
  /** The install's slug. */
  name: string;
  from: string | null;
  to: string;
  comparison: Comparison;
  /** Pending migration file names, sorted. */
  migrations: string[];
  /** computePlan actions with action "create" (resources only). */
  create: Action[];
  /** Generated secret names the worker lacks. */
  secrets: string[];
  /** The generated config's hash differs from `deployedConfigHash`. */
  configChanged: boolean;
  /** First 12 hex of sha256 over the plan lines. */
  digest: string;
};

export const IRREVERSIBLE_LINE =
  "Migrations cannot be undone. If the new release is broken, the way back is the next release.";

/** What `/.well-known/saasmail` reports, compared with this package. */
type Running = {
  installationId: string | null;
  version: string | null;
  comparison: Comparison;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Adopted and not upgraded since: the running code may predate the installation id (spec §5.2). */
const firstAfterAdopt = (s: InstallState) =>
  Boolean(s.adoptedAt) && !s.upgradedAt;

async function inspect(
  ctx: Ctx,
  s: InstallState,
  to: string,
): Promise<Running> {
  const url = `${s.baseUrl}/.well-known/saasmail`;
  let installationId: string | null = null;
  let version: string | null = null;
  let res: Response;
  try {
    res = await ctx.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new Error(
      `Could not read ${url} (${message(e)}). Nothing was changed.`,
    );
  }
  if (res.ok) {
    const body = (await res.json().catch(() => null)) as {
      installationId?: unknown;
      version?: unknown;
    } | null;
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    installationId = str(body?.installationId);
    version = str(body?.version);
  } else if (!(res.status === 404 && firstAfterAdopt(s))) {
    throw new Error(`${url} answered HTTP ${res.status}. Nothing was changed.`);
  }
  const comparison = await compareRunning(
    version,
    { version: to, commit: ctx.source.commit ?? "" },
    ctx.fetchImpl,
  );
  return { installationId, version, comparison };
}

/**
 * Migration files in the package that the install's D1 has not applied. No `d1_migrations` table
 * on an empty database: all. No such table beside other tables (a database set up without
 * `wrangler d1 migrations apply`) stops: applying everything would fail on the existing tables.
 */
async function pendingMigrations(ctx: Ctx, s: InstallState): Promise<string[]> {
  const files = readdirSync(ctx.source.migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const d1 = s.resources.find((r) => r.key === "d1");
  if (!d1) return files;
  let applied: string[];
  try {
    const rows = await ctx.cf.queryD1(
      s.accountId,
      d1.id,
      "SELECT name FROM d1_migrations",
    );
    applied = rows.map((r) => String(r.name));
  } catch (e) {
    if (!/no such table/i.test(message(e))) throw e;
    const tables = await ctx.cf.queryD1(
      s.accountId,
      d1.id,
      // D1's own tables (_cf_*) and SQLite's (sqlite_*) do not count.
      "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_'",
    );
    if (tables.length === 0) return files;
    throw new Error(
      `D1 ${d1.name} has tables but no d1_migrations table; saasmail cannot tell which migrations ran. ` +
        `See docs/updating.md ("A database without d1_migrations") to record the ones that did, then run the upgrade again. Nothing was changed.`,
    );
  }
  return files.filter((f) => !applied.includes(f));
}

/** A state from before the subject was frozen keeps the deployed one (else the derived one). */
const withSubject = (s: InstallState, obs: Observed): InstallState =>
  s.vapidSubject
    ? s
    : {
        ...s,
        vapidSubject: obs.worker.vars?.VAPID_SUBJECT ?? vapidSubjectFor(s),
      };

function planLines(p: Omit<UpgradePlan, "digest">): string[] {
  const list = (xs: string[]) => (xs.length > 0 ? xs.join(", ") : "none");
  const from = p.from ?? "unknown";
  const lines = [`Upgrade ${p.name}: ${from} → ${p.to}`];
  if (p.comparison.kind === "custom") {
    lines.push(
      `Replacing custom code: ${from} (${p.comparison.reason}) → saasmail ${p.to}`,
    );
  }
  lines.push(
    `Migrations: ${list(p.migrations)}`,
    `Create: ${list(p.create.map((a) => `${a.kind} ${a.name}`))}`,
    `New secrets: ${list(p.secrets)}`,
    `Config: ${p.configChanged ? "changes" : "unchanged"}`,
    "",
    IRREVERSIBLE_LINE,
  );
  return lines;
}

export function formatUpgradePlan(p: UpgradePlan): string {
  return planLines(p).join("\n");
}

type Planned = {
  plan: UpgradePlan;
  base: Plan;
  obs: Observed;
  /** Secret names the worker has. */
  have: string[];
};

async function planned(
  ctx: Ctx,
  s: InstallState,
  running: Running,
  to: string,
): Promise<Planned> {
  const obs = await look(ctx, s);
  const base = computePlan(desiredOf(s), obs, s);
  const migrations = await pendingMigrations(ctx, s);
  const workerIsNew =
    base.actions.find((a) => a.key === "worker")?.action === "create";
  const have = await existingSecretNames(ctx, s.names.worker, workerIsNew);
  // The same call the deploy makes: a lost VAPID public key stops here, before anything changes.
  const g = await generatedSecrets(ctx, s, have);
  const rendered = withSubject({ ...s, vapidPublicKey: g.vapidPublicKey }, obs);
  const p: Omit<UpgradePlan, "digest"> = {
    name: s.inputs.name,
    from: running.version,
    to,
    comparison: running.comparison,
    migrations,
    create: base.actions.filter(
      (a) =>
        a.action === "create" && a.kind !== "routing" && a.kind !== "sending",
    ),
    secrets: Object.keys(g.secrets),
    configChanged:
      renderConfig(ctx, rendered, to).hash !== s.deployedConfigHash,
  };
  const digest = createHash("sha256")
    .update(planLines(p).join("\n"))
    .digest("hex")
    .slice(0, 12);
  return { plan: { ...p, digest }, base, obs, have };
}

/** The upgrade plan for `s` against what runs and what Cloudflare holds now. Read-only. */
export async function planUpgrade(
  ctx: Ctx,
  s: InstallState,
): Promise<UpgradePlan> {
  const to = await ctx.source.version(ctx.runner);
  return (await planned(ctx, s, await inspect(ctx, s, to), to)).plan;
}

/** Stops (spec §5.2–3, §5a) before anything is planned: wrong install, downgrade, custom code. */
function checkRunning(
  ctx: Ctx,
  s: InstallState,
  r: Running,
  to: string,
  replaceCustomCode: boolean,
): void {
  const url = `${s.baseUrl}/.well-known/saasmail`;
  const sameId =
    r.installationId === s.installationId ||
    (r.installationId === null && firstAfterAdopt(s));
  if (!sameId) {
    throw new Error(
      `${url} reports installation ${r.installationId ?? "(none)"}, not ${s.installationId}: this is not the install the state describes. Nothing was changed.`,
    );
  }
  const running = r.version ?? "unknown";
  if (r.comparison.kind === "downgrade") {
    throw new Error(
      `${s.baseUrl} runs ${running}, newer than this package (${to}); upgrade never downgrades. Run that version instead: npx saasmail@${running} upgrade --name ${s.inputs.name}. Nothing was changed.`,
    );
  }
  if (r.comparison.kind === "custom" && !replaceCustomCode) {
    throw new Error(
      `${s.baseUrl} runs code that is not a release (${running}: ${r.comparison.reason}). ` +
        `Upgrading would replace it with stock saasmail ${to}; forks keep deploying from their own checkout. ` +
        `To replace it anyway: ${ctx.source.command(`upgrade --name ${s.inputs.name} --replace-custom-code`)}. Nothing was changed.`,
    );
  }
}

export async function upgrade(
  outer: Ctx,
  opts: {
    state: InstallState;
    yes: boolean;
    expectPlan?: string;
    replaceCustomCode: boolean;
    resume: boolean;
    /** Only print the plan and the apply command: no lock, nothing written. */
    plan?: boolean;
  },
): Promise<InstallState> {
  const ctx = onAccount(outer, opts.state);
  const slug = opts.state.inputs.name;
  const id = opts.state.installationId;
  const to = await ctx.source.version(ctx.runner);
  const resumeCmd = ctx.source.command(`upgrade --resume --name ${slug}`);
  const release = opts.plan ? () => {} : acquireLock(ctx.dir, id);
  let s = opts.state;
  const save = (next: InstallState) => {
    s = next;
    writeState(ctx.dir, s);
  };
  const prefix = `upgrade:${to}:`;
  let step = "plan";
  let started = false;
  try {
    // Spec §5.2: lock, then read the state as it is on disk now (inside the try: a corrupt
    // state file must not leak the lock).
    s = readState(ctx.dir, id) ?? opts.state;
    const unfinished =
      s.status === "upgrading" ||
      (s.status === "failed" && s.upgradeTarget !== undefined);
    if (unfinished) {
      if (s.upgradeTarget !== to) {
        throw new Error(
          `An upgrade to ${s.upgradeTarget} is unfinished; run npx saasmail@${s.upgradeTarget} upgrade --resume --name ${slug}.`,
        );
      }
      if (!opts.resume && !opts.plan) {
        throw new Error(`An upgrade to ${to} is unfinished; run ${resumeCmd}.`);
      }
    } else if (s.status !== "installed") {
      throw new Error(
        `${slug} is not installed yet (status ${s.status}). Finish the install first: ${resumeCommand(s, ctx.source)}`,
      );
    }
    const configFile = join(ctx.configDir, "wrangler.jsonc");
    if (
      existsSync(configFile) &&
      !isGenerated(readFileSync(configFile, "utf8"))
    )
      throw new ConfigConflict(configFile);

    // Continuing an upgrade skips the running-version checks; they were made (and
    // custom code consented to) when it started, and the site may be down meanwhile.
    let running: Running;
    if (unfinished) {
      const from = s.deployedVersion ?? null;
      running = {
        installationId: s.installationId,
        version: from,
        comparison: { kind: from === to ? "same" : "upgrade" },
      };
    } else {
      running = await inspect(ctx, s, to);
      checkRunning(ctx, s, running, to, opts.replaceCustomCode);
    }
    const { plan, base, obs, have } = await planned(ctx, s, running, to);
    ctx.io.print(formatUpgradePlan(plan));
    if (opts.plan) {
      const args = [
        "upgrade",
        ...(unfinished ? ["--resume"] : []),
        `--name ${slug}`,
        ...(plan.comparison.kind === "custom" ? ["--replace-custom-code"] : []),
        `--expect-plan ${plan.digest}`,
        "--yes",
      ];
      ctx.io.print(`\nPlan ${plan.digest}\n\nTo apply it:`);
      ctx.io.print(ctx.source.command(args.join(" ")));
      return s;
    }
    if (opts.expectPlan !== undefined && opts.expectPlan !== plan.digest) {
      throw new Error(
        `The plan changed since it was reviewed (expected ${opts.expectPlan}, now ${plan.digest}). Review it again with --plan. Nothing was changed.`,
      );
    }
    if (!opts.yes && !(await ctx.io.confirm("Apply this upgrade?", true))) {
      throw new Error("Nothing was changed.");
    }

    // A fresh upgrade to a version upgraded to before (a same-version redeploy) runs every step.
    const from = unfinished
      ? s
      : { ...s, steps: s.steps.filter((x) => !x.key.startsWith(prefix)) };
    save({ ...transition(from, "upgrading"), upgradeTarget: to });
    started = true;
    const once = async (name: string, fn: () => Promise<void>) => {
      const key = `${prefix}${name}`;
      if (hasStep(s, key)) return;
      step = key;
      await fn();
      save(recordStep(s, key));
    };

    await once("resources", () =>
      provision(ctx, base, obs, {
        get: () => s,
        save,
        setStep: (k) => (step = k),
      }),
    );

    // Secrets and config whenever the deploy is still to come: a VAPID pair generated now
    // (never stored) must go out with the config that carries its public key.
    const deployPending = !hasStep(s, `${prefix}deploy`);
    const secrets: Record<string, string> = {};
    let hash = s.deployedConfigHash;
    if (deployPending) {
      step = `${prefix}config`;
      save(withSubject(s, obs));
      const g = await generatedSecrets(ctx, s, have);
      for (const n of plan.secrets) {
        const v = g.secrets[n];
        if (v !== undefined) secrets[n] = v;
      }
      if (g.vapidPublicKey !== s.vapidPublicKey)
        save({ ...s, vapidPublicKey: g.vapidPublicKey });
      hash = writeConfig(ctx, s, to);
      save(recordStep(s, step));
    }

    await once("migrations", () => applyMigrations(ctx));
    await once("deploy", async () => {
      await deploy(ctx, secrets);
      s = { ...s, deployedConfigHash: hash, deployedVersion: to };
      for (const key of ["worker", "workflow"] as const) {
        if (!s.resources.some((r) => r.key === key))
          s = recordResource(s, resource(key, key, s.names[key], s.names[key]));
      }
    });
    await once("markers", () => writeMarkers(ctx, s, to));
    await once("verify", async () => {
      await verifyAt(ctx, s, to, resumeCmd);
    });

    const { upgradeTarget: _done, ...rest } = transition(s, "installed");
    save({ ...rest, upgradedAt: ctx.now().toISOString() });
  } catch (e) {
    if (!started) throw e;
    if (s.status === "upgrading") s = transition(s, "failed");
    writeState(ctx.dir, s);
    throw new Error(
      `${message(e)}\n\nStep ${step} failed. Nothing after it ran. Run: ${resumeCmd}`,
      { cause: e },
    );
  } finally {
    release();
  }
  ctx.io.print(`Upgraded ${slug} to ${to}: ${s.baseUrl}`);
  return s;
}
