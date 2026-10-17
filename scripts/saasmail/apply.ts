// Apply (spec §6): creates what the plan says, step by step, recording each idempotency key in the
// state file so a rerun (`--resume`) continues from the first unrecorded step. Step helpers live in
// apply-steps.ts, the mail steps and the summary in apply-mail.ts.
import {
  routeDomain,
  sendingReport,
  summary,
  type SendingReport,
} from "./apply-mail.ts";
import {
  applyMigrations,
  assertConfigWritable,
  deploy,
  existingSecretNames,
  generatedSecrets,
  migrationsDigest,
  optionalSecrets,
  renderConfig,
  resumeCommand,
  setupStatus,
  skippedAfter,
  verify,
  verifyAt,
  writeConfig,
  writeInstallRow,
  type Ctx,
  type Optional,
  type SetupStatus,
} from "./apply-steps.ts";
import { vapidSubjectFor } from "./config.ts";
import { observe, R2_MARKER_KEY, type Observed } from "./observe.ts";
import {
  computePlan,
  formatPlan,
  type Action,
  type Desired,
  type Plan,
} from "./plan.ts";
import { withEnv } from "./runner.ts";
import type { Source } from "./source.ts";
import { generateSetupCode, setupCodeHash } from "./secrets.ts";
import {
  acquireLock,
  hasStep,
  recordResource,
  recordStep,
  transition,
  writeState,
  type InstallState,
  type Resource,
  type Status,
} from "./state.ts";

export { verify, type Ctx, type Optional };

export const desiredOf = (s: InstallState): Desired => ({
  installationId: s.installationId,
  ownershipNonce: s.ownershipNonce,
  names: s.names,
  inboundDomains: s.inputs.inboundDomains,
  provider: s.inputs.provider,
  sendDomains: s.inputs.sendDomains,
});

export const look = (ctx: Ctx, s: InstallState): Promise<Observed> =>
  observe(ctx.cf, s.accountId, s.names, s.inputs);

export const resource = (
  key: string,
  kind: Resource["kind"],
  name: string,
  id: string,
): Resource => ({ key, kind, name, id, ownership: "created", state: "ready" });

const RANK: Record<Status, number> = {
  planned: 0,
  failed: 0,
  provisioning: 1,
  deploying: 2,
  verifying: 3,
  installed: 4,
  upgrading: 4,
};

const PHASES: Status[] = ["provisioning", "deploying", "verifying"];

const deployedAs = (
  s: InstallState,
  hash: string,
  version: string,
): InstallState => ({
  ...s,
  deployedConfigHash: hash,
  deployedVersion: version,
});

/** Printed when a run fails after the code's hash went live: the code is never in the error. */
function keepCode(ctx: Ctx, s: InstallState, code: string | null) {
  if (code) {
    ctx.io.print(
      `Setup code: ${code} (keep it: ${s.baseUrl}/onboarding needs it once the site is reachable)`,
    );
  }
}

function wrap(e: unknown, step: string, s: InstallState, ctx: Ctx): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(
    `${msg}\n\nStep ${step} failed. Nothing after it ran. Run: ${resumeCommand(s, ctx.source)}`,
    { cause: e },
  );
}

/** Every wrangler (and deploy) subprocess works on the recorded account, never one wrangler picks. */
export const onAccount = (ctx: Ctx, s: InstallState): Ctx => ({
  ...ctx,
  runner: withEnv(ctx.runner, { CLOUDFLARE_ACCOUNT_ID: s.accountId }),
});

const MARKER_TRIES = 3;

/** The R2 ownership marker; the PUT is idempotent, so a transient failure is retried. */
async function putMarker(
  ctx: Ctx,
  account: string,
  bucket: string,
  marker: { installationId: string; ownershipNonce: string; key: string },
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await ctx.cf.putR2Object(
        account,
        bucket,
        R2_MARKER_KEY,
        JSON.stringify(marker),
      );
      return;
    } catch (e) {
      if (attempt >= MARKER_TRIES) throw e;
      await ctx.sleep(1000 * attempt);
    }
  }
}

const zoneOf = (obs: Observed, domain: string): string => {
  const z = obs.zones[domain];
  if (!z) throw new Error(`Zone for \`${domain}\` not found in this account.`);
  return z;
};

/**
 * Steps 7–8 for every routing/sending action whose step is not recorded yet: `create` does the
 * work, `reuse` (already ours) only records. Sending reports cover `reportAll` send domains, or
 * only the ones handled now. `setStep` names the running step for error messages.
 */
async function mailSteps(
  ctx: Ctx,
  plan: Plan,
  obs: Observed,
  get: () => InstallState,
  save: (s: InstallState) => void,
  setStep: (key: string) => void,
  reportAll: boolean,
): Promise<{ changed: boolean; sending: SendingReport[] }> {
  let changed = false;
  const sending: SendingReport[] = [];
  const of = (kind: Action["kind"]) =>
    plan.actions.filter((a) => a.kind === kind);
  for (const a of of("routing")) {
    if (hasStep(get(), a.key)) continue;
    setStep(a.key);
    if (a.action === "create") {
      await routeDomain(ctx, get(), a.name, zoneOf(obs, a.name));
      changed = true;
    }
    save(recordStep(get(), a.key));
  }
  for (const a of of("sending")) {
    const fresh = !hasStep(get(), a.key);
    setStep(a.key);
    const zoneId = zoneOf(obs, a.name);
    if (fresh) {
      if (a.action === "create") {
        await ctx.cf.createSendingSubdomain(zoneId, a.name);
        changed = true;
      }
      save(recordStep(get(), a.key));
    }
    if (fresh || reportAll)
      sending.push(await sendingReport(ctx, a.name, zoneId));
  }
  return { changed: changed || sending.length > 0, sending };
}

/** How a step helper reads and saves the running state, and names the step for error messages. */
export type StepRun = {
  get(): InstallState;
  save(s: InstallState): void;
  setStep(key: string): void;
};

/**
 * D1, R2 and the Queue for every plan action not recorded yet (the Workflow and the worker come
 * from the deploy). `obs` is what the plan was computed from; a create looks again first.
 */
export async function provision(
  ctx: Ctx,
  plan: Plan,
  observed: Observed,
  run: StepRun,
): Promise<void> {
  let obs = observed;
  const acct = run.get().accountId;
  for (const a of plan.actions) {
    if (a.kind !== "d1" && a.kind !== "r2" && a.kind !== "queue") continue;
    if (run.get().resources.some((r) => r.key === a.key)) continue;
    run.setStep(`provision:${a.key}`);
    let action = a.action;
    if (action === "create") {
      // Look again before the intent is recorded: a name someone else took meanwhile must
      // stop here, not pass as ours later (an intent lets an empty same-name resource be reused).
      obs = await look(ctx, run.get());
      action = computePlan(desiredOf(run.get()), obs, run.get()).actions.find(
        (x) => x.key === a.key,
      )!.action;
      if (action === "create")
        run.save(recordStep(run.get(), `provision-intent:${a.key}`));
    }
    let id: string;
    if (a.kind === "d1") {
      id =
        action === "create"
          ? (await ctx.cf.createD1(acct, a.name)).uuid
          : obs.d1.find((d) => d.name === a.name)!.uuid;
    } else if (a.kind === "queue") {
      id =
        action === "create"
          ? (await ctx.cf.createQueue(acct, a.name)).id
          : obs.queues.find((q) => q.name === a.name)!.id;
    } else {
      if (action === "create") await ctx.cf.createR2(acct, a.name);
      // The marker goes in before the bucket is recorded: a recorded bucket always has one.
      // A reused bucket without one is ours and empty (plan.ts), so it gets one now.
      if (obs.r2Markers[a.name] == null) {
        await putMarker(ctx, acct, a.name, markerOf(run.get(), a.key));
      }
      id = a.name;
    }
    run.save(recordResource(run.get(), resource(a.key, a.kind, a.name, id)));
  }
}

const markerOf = (s: InstallState, key: string) => ({
  installationId: s.installationId,
  ownershipNonce: s.ownershipNonce,
  key,
});

/**
 * The ownership markers: the R2 marker of each bucket recorded as adopted (created buckets got
 * theirs when provisioned), then the D1 `install_state` row at `version`. Idempotent.
 */
export async function writeMarkers(
  ctx: Ctx,
  s: InstallState,
  version: string,
): Promise<void> {
  for (const r of s.resources) {
    if (r.kind === "r2" && r.ownership === "adopted")
      await putMarker(ctx, s.accountId, r.name, markerOf(s, r.key));
  }
  const d1 = s.resources.find((r) => r.key === "d1")!;
  await writeInstallRow(
    ctx,
    s,
    d1.id,
    version,
    migrationsDigest(ctx.source.migrationsDir),
  );
}

export async function install(
  outer: Ctx,
  opts: {
    state: InstallState;
    expectPlan?: string;
    yes: boolean;
    optional: Optional;
  },
): Promise<InstallState> {
  let s = opts.state;
  const ctx = onAccount(outer, s);
  let step = "plan";
  let code: string | null = null;
  const optional = opts.optional;
  const save = (next: InstallState) => {
    s = next;
    writeState(ctx.dir, s);
  };
  // From failed, go straight to the phase now running (allowed). Otherwise walk forward through
  // each phase in order; a run resumed past a phase (e.g. killed while verifying) never moves back.
  const enter = (to: Status) => {
    if (s.status === "failed") {
      save(transition(s, to));
      return;
    }
    for (const p of PHASES) {
      if (RANK[p] > RANK[s.status] && RANK[p] <= RANK[to]) {
        save(transition(s, p));
      }
    }
  };
  // Set once the hash of `code` is live: from then on a failure must still show the code.
  let codeDeployed = false;
  let setup: SetupStatus = {};
  let sending: SendingReport[] = [];

  // Before the lock and the draft: a hand-written wrangler.jsonc leaves nothing behind.
  assertConfigWritable(ctx);
  const release = acquireLock(ctx.dir, s.installationId);
  try {
    // 1. Draft saved, lock held; the plan is recomputed against Cloudflare as it is now.
    save(s);
    const desired = desiredOf(s);
    const obs = await look(ctx, s);
    const plan = computePlan(desired, obs, s);
    if (opts.expectPlan !== undefined && opts.expectPlan !== plan.digest) {
      throw new Error(
        `The plan changed since it was reviewed (expected ${opts.expectPlan}, now ${plan.digest}):\n\n` +
          `${formatPlan(plan, s.inputs, s.baseUrl)}\n\nReview it again with --plan, then apply with --expect-plan ${plan.digest}.`,
      );
    }
    enter("provisioning");

    // 2. D1, R2 and the Queue (the Workflow and the worker come from the deploy).
    await provision(ctx, plan, obs, {
      get: () => s,
      save,
      setStep: (k) => (step = k),
    });

    // 3. Generated secrets the worker lacks. Before the config: the VAPID public key goes into it.
    let secrets: Record<string, string> = {};
    if (!hasStep(s, "deploy:1")) {
      step = "secrets";
      const workerIsNew =
        plan.actions.find((a) => a.key === "worker")?.action === "create";
      const have = await existingSecretNames(ctx, s.names.worker, workerIsNew);
      const g = await generatedSecrets(ctx, s, have);
      secrets = g.secrets;
      if (g.vapidPublicKey !== s.vapidPublicKey)
        save({ ...s, vapidPublicKey: g.vapidPublicKey });
    }

    // 4. wrangler.jsonc. VAPID_SUBJECT is frozen at the first render: later domains never change it.
    step = "config";
    if (!s.vapidSubject) save({ ...s, vapidSubject: vapidSubjectFor(s) });
    const version = await ctx.source.version(ctx.runner);
    const configHash = writeConfig(ctx, s, version);
    save(recordStep(s, `config:${configHash}`));

    // 5. Migrations, then the install_state row (the D1 ownership marker).
    const digest = migrationsDigest(ctx.source.migrationsDir);
    if (!hasStep(s, `migrations:${digest}`)) {
      step = `migrations:${digest}`;
      await applyMigrations(ctx);
      await writeMarkers(ctx, s, version);
      save(recordStep(s, step));
    }

    // 6. The first deploy, with the secrets, the setup code's hash and supplied credentials.
    if (!hasStep(s, "deploy:1")) {
      if (!hasStep(s, "setup-code:1")) {
        code = generateSetupCode();
        secrets.SETUP_CODE_HASH = setupCodeHash(code);
      }
      Object.assign(secrets, optionalSecrets(optional));
      step = "deploy:1";
      enter("deploying");
      await deploy(ctx, secrets);
      codeDeployed = code !== null;
      s = recordStep(deployedAs(s, configHash, version), "deploy:1");
      if (code) s = recordStep(s, "setup-code:1");
      s = recordResource(
        s,
        resource("worker", "worker", s.names.worker, s.names.worker),
      );
      s = recordResource(
        s,
        resource("workflow", "workflow", s.names.workflow, s.names.workflow),
      );
      save({ ...s, skipped: skippedAfter(null, optional, s.inputs.provider) });
    } else if (Object.keys(optionalSecrets(optional)).length > 0) {
      // Resumed past the first deploy with credentials supplied now: send just those.
      step = "deploy:credentials";
      enter("deploying");
      await deploy(ctx, optionalSecrets(optional));
      save({
        ...deployedAs(s, configHash, version),
        skipped: skippedAfter(s.skipped, optional, s.inputs.provider),
      });
    }

    // 6b. A resume whose checkout or inputs moved on since the last deploy: deploy what is
    // generated now (no secrets file: the worker keeps its secrets).
    if (configHash !== s.deployedConfigHash) {
      step = "deploy:config";
      enter("deploying");
      await deploy(ctx, {});
      save(deployedAs(s, configHash, version));
    }

    // 7–8. Email Routing and Email Sending, after the deploy.
    enter("deploying");
    ({ sending } = await mailSteps(
      ctx,
      plan,
      obs,
      () => s,
      save,
      (k) => (step = k),
      true,
    ));

    // 9. Verify.
    step = "verify";
    enter("verifying");
    setup = await verifyAt(ctx, s, s.deployedVersion ?? version);

    // 10. Done.
    step = "summary";
    save(transition(s, "installed"));
  } catch (e) {
    if (s.status !== "installed") s = transition(s, "failed");
    writeState(ctx.dir, s);
    if (codeDeployed) keepCode(ctx, s, code);
    throw wrap(e, step, s, ctx);
  } finally {
    release();
  }
  ctx.io.print(summary(s, code, optional, sending, ctx.source));
  if (!code && setup.setupRequired && setup.codeRequired) {
    ctx.io.print(
      `The first admin still needs a setup code. If you no longer have it, run: ${newCodeCommand(s, ctx.source)}`,
    );
  }
  return s;
}

const newCodeCommand = (s: InstallState, source: Source) =>
  `${resumeCommand(s, source)} --new-setup-code`;

/**
 * `--resume` on an installed instance (spec §6): adds supplied provider credentials and, while no
 * user exists, replaces the setup code (in a terminal after a yes, default no; otherwise only with
 * `newSetupCode`), in one deploy; then routes inbound domains and onboards send domains added to
 * the inputs since. Never an upgrade. The status stays `installed` throughout.
 */
export async function resumeInstalled(
  outer: Ctx,
  state: InstallState,
  optional: Optional,
  opts: {
    newSetupCode?: boolean;
    /** The digest of the plan shown (and confirmed); a plan that changes meanwhile stops. */
    expectPlan?: string;
  } = {},
): Promise<InstallState> {
  let s = state;
  const ctx = onAccount(outer, s);
  let step = "config";
  let code: string | null = null;
  let codeDeployed = false;
  const save = (next: InstallState) => {
    s = next;
    writeState(ctx.dir, s);
  };
  assertConfigWritable(ctx);
  const release = acquireLock(ctx.dir, s.installationId);
  try {
    step = "plan";
    const obs = await look(ctx, s);
    const plan = computePlan(desiredOf(s), obs, s);
    if (opts.expectPlan !== undefined && opts.expectPlan !== plan.digest) {
      throw new Error(
        `The plan changed since it was reviewed (expected ${opts.expectPlan}, now ${plan.digest}):\n\n` +
          `${formatPlan(plan, s.inputs, s.baseUrl)}\n\nReview it again with --plan, then apply with --expect-plan ${plan.digest}.`,
      );
    }
    // A state from before the subject was frozen keeps the deployed one.
    const deployedSubject = obs.worker.vars?.VAPID_SUBJECT;
    if (!s.vapidSubject && deployedSubject)
      save({ ...s, vapidSubject: deployedSubject });

    // Never an upgrade: wrangler.jsonc is rewritten and deployed only when it would come out
    // exactly as the configuration already deployed.
    step = "config";
    const head = await ctx.source.version(ctx.runner);
    const upToDate = renderConfig(ctx, s, head).hash === s.deployedConfigHash;
    if (!upToDate) {
      ctx.io.print(
        `${ctx.source.kind === "checkout" ? "This checkout" : "This package"} (${head}) differs from the deployed version (${s.deployedVersion ?? "unknown"}). ` +
          (ctx.source.kind === "package"
            ? `Run ${ctx.source.command(`upgrade --name ${s.names.worker}`)} to move it to ${head}.`
            : `Upgrades: run npx saasmail adopt --from ${ctx.configDir}, then npx saasmail upgrade.`),
      );
    }

    // Unreachable setup status: the code question is skipped, domains and credentials go on.
    step = "setup-status";
    let setupRequired: boolean | null;
    try {
      setupRequired = (await setupStatus(ctx, s)).setupRequired === true;
    } catch (e) {
      setupRequired = null;
      ctx.io.print(
        `Could not read ${s.baseUrl}/api/setup/status (${e instanceof Error ? e.message : String(e)}); the setup code was left as it is.`,
      );
    }
    if (setupRequired === false && opts.newSetupCode) {
      ctx.io.print("A site admin already exists; no setup code is needed.");
    }
    const secrets = optionalSecrets(optional);
    // A new code makes the old one stop working: never replaced without being asked, and not
    // asked about when no deploy is possible.
    const replace =
      setupRequired === true &&
      (opts.newSetupCode === true ||
        (upToDate &&
          ctx.io.tty &&
          (await ctx.io.confirm(
            "Issue a new setup code? The old one stops working.",
            false,
          ))));
    if (replace) {
      code = generateSetupCode();
      secrets.SETUP_CODE_HASH = setupCodeHash(code);
    } else if (setupRequired === true && !ctx.io.tty) {
      ctx.io.print(
        `The first admin still needs the setup code. If it is lost, issue a new one (the old one stops working): ${newCodeCommand(s, ctx.source)}`,
      );
    }
    const redeploy = Object.keys(secrets).length > 0;
    if (redeploy && !upToDate) {
      throw new Error(
        ctx.source.kind === "checkout"
          ? `Adding credentials or a setup code needs a deploy, which from this checkout would be an upgrade. Check out ${s.deployedVersion ?? "the deployed commit"} and run again. If you have updated with \`yarn deploy\` since installing, do not: deploying the older commit would roll back code and schema. Follow docs/updating.md instead.`
          : `Adding credentials or a setup code needs a deploy, which from this package would be an upgrade. Run the deployed version again (${s.deployedVersion ?? "unknown"}).`,
      );
    }
    if (redeploy) {
      writeConfig(ctx, s, head);
      step = "deploy";
      await deploy(ctx, secrets);
      codeDeployed = code !== null;
      if (code) {
        const n = s.steps.filter((x) => x.key.startsWith("setup-code:")).length;
        s = recordStep(s, `setup-code:${n + 1}`);
      }
      save({
        ...s,
        skipped: skippedAfter(s.skipped, optional, s.inputs.provider),
      });
    }

    const mail = await mailSteps(
      ctx,
      plan,
      obs,
      () => s,
      save,
      (k) => (step = k),
      false,
    );

    step = "verify";
    await verifyAt(ctx, s, s.deployedVersion ?? head);
    ctx.io.print(
      redeploy || mail.changed
        ? summary(s, code, optional, mail.sending, ctx.source)
        : "Nothing to do.",
    );
    return s;
  } catch (e) {
    writeState(ctx.dir, s);
    if (codeDeployed) keepCode(ctx, s, code);
    throw wrap(e, step, s, ctx);
  } finally {
    release();
  }
}
