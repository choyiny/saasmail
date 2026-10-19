// `saasmail adopt --worker <name>` (spec §6): takes over an install made by the old onboarding
// skill (no state file, no ownership markers) from the deployed worker's settings. Read-only up to
// the confirmed report; then writes the state and the generated wrangler.jsonc under
// <home>/<worker>/. Never deploys, never runs wrangler, never reads or sends a secret value.
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "./apply.ts";
import { sendingReport } from "./apply-mail.ts";
import {
  lostVapidMessage,
  OPTIONAL_ITEMS,
  renderConfig,
  writeConfig,
} from "./apply-steps.ts";
import { plainTextVars, type WorkerBinding } from "./cloudflare.ts";
import { configVars, vapidSubjectFor } from "./config.ts";
import { installDir } from "./home.ts";
import { installationIdOf, resourceNames, validateName } from "./names.ts";
import { catchAllOwner } from "./plan.ts";
import {
  acquireLock,
  listStates,
  newState,
  writeState,
  type InstallState,
  type Provider,
  type Resource,
} from "./state.ts";
import { compareRunning } from "./versions.ts";

export type AdoptInputs = Partial<InstallState["inputs"]>;

/** The template's resource bindings: name -> settings type, state key and resource kind. */
const TEMPLATE = {
  DB: { type: "d1", key: "d1", kind: "d1" },
  R2: { type: "r2_bucket", key: "attachments", kind: "r2" },
  EMAIL_QUEUE: { type: "queue", key: "queue", kind: "queue" },
  GMAIL_BACKFILL: { type: "workflow", key: "workflow", kind: "workflow" },
} as const;
type TemplateName = keyof typeof TEMPLATE;

/** Bindings adopt accepts without mapping them to a resource. */
const OTHER_NAMES = new Set(["ASSETS", "NOTIFICATIONS_HUB"]);
const OTHER_TYPES = new Set(["plain_text", "secret_text", "send_email"]);

const NOTHING = "Nothing was changed.";

/** Secrets saasmail generates when the worker lacks them: a plain var of that name would be replaced. */
const GENERATED_SECRETS = new Set([
  "BETTER_AUTH_SECRET",
  "UNSUBSCRIBE_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "VAPID_PRIVATE_KEY",
  "SETUP_CODE_HASH",
]);
/** Vars the first upgrade is expected to change. */
const EXPECTED_TO_CHANGE = new Set([
  "SAASMAIL_VERSION",
  "SAASMAIL_INSTALLATION",
]);
/** Vars older saasmail versions set that the worker no longer reads: dropping them changes nothing. */
const RETIRED_VARS = new Set(["APP_NAME", "APP_LOGO_LETTER"]);

const hostOf = (url: string | undefined): string | null => {
  try {
    return url ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const origins = (v: string) =>
  v
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o !== "");

/**
 * Whether a TRUSTED_ORIGINS change only drops local development origins (the old template trusted
 * localhost for `yarn dev`): every origin the upgrade keeps is already trusted.
 */
function dropsOnlyLocalOrigins(current: string, next: string): boolean {
  const now = origins(current);
  const kept = origins(next);
  return (
    kept.every((o) => now.includes(o)) &&
    now
      .filter((o) => !kept.includes(o))
      .every((o) => LOCAL_HOSTS.has(hostOf(o) ?? ""))
  );
}

/**
 * The worker's plain vars that the first upgrade's deploy would drop or change (wrangler deploy
 * replaces every var with the generated config's): one line each, current -> new. `stops` would
 * change what the worker does; `drops` do not (retired vars, local development origins) and are
 * shown in the report. A var named like a generated secret has its value withheld, since it
 * likely holds one.
 */
function varChanges(
  current: Record<string, string>,
  next: Record<string, string>,
): { stops: string[]; drops: string[] } {
  const stops: string[] = [];
  const drops: string[] = [];
  for (const [name, value] of Object.entries(current).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (GENERATED_SECRETS.has(name)) {
      stops.push(
        `  ${name}  (value not shown) -> removed; the upgrade would generate a ${name} secret in its place`,
      );
    } else if (EXPECTED_TO_CHANGE.has(name)) {
      continue;
    } else if (!(name in next)) {
      (RETIRED_VARS.has(name) ? drops : stops).push(
        `  ${name}  ${JSON.stringify(value)} -> removed (${RETIRED_VARS.has(name) ? "saasmail no longer reads it" : "saasmail's config does not set it"})`,
      );
    } else if (next[name] !== value) {
      const local =
        name === "TRUSTED_ORIGINS" && dropsOnlyLocalOrigins(value, next[name]!);
      (local ? drops : stops).push(
        `  ${name}  ${JSON.stringify(value)} -> ${JSON.stringify(next[name])}${local ? " (drops local development origins)" : ""}`,
      );
    }
  }
  return { stops, drops };
}

const isTemplate = (b: WorkerBinding) =>
  b.name in TEMPLATE && TEMPLATE[b.name as TemplateName].type === b.type;

export const noWorker = (worker: string, accountId: string) =>
  `No worker named ${worker} on account ${accountId}. ${NOTHING}`;

/** Provider the worker uses: Email Sending when it has a send_email binding, else by credential secret. */
export function detectProvider(bindings: WorkerBinding[]): Provider {
  if (bindings.some((b) => b.type === "send_email")) return "cloudflare";
  const secrets = new Set(
    bindings.filter((b) => b.type === "secret_text").map((b) => b.name),
  );
  return OPTIONAL_ITEMS.find((i) => secrets.has(i.secret))?.provider ?? "none";
}

/** The deployed `version` from `/.well-known/saasmail`, else null (old installs predate it). */
async function wellKnownVersion(
  ctx: Ctx,
  baseUrl: string,
): Promise<string | null> {
  try {
    const res = await ctx.fetchImpl(`${baseUrl}/.well-known/saasmail`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as {
      version?: unknown;
    } | null;
    return typeof body?.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

/** The custom domain the worker is served on (null = workers.dev). Several without a tie-break stop. */
async function servedOn(
  ctx: Ctx,
  accountId: string,
  worker: string,
  baseUrl: string | undefined,
): Promise<string | null> {
  const domains = (await ctx.cf.workerDomains(accountId))
    .filter((d) => d.service === worker)
    .map((d) => d.hostname.toLowerCase());
  if (domains.length <= 1) return domains[0] ?? null;
  const base = hostOf(baseUrl);
  if (base && domains.includes(base)) return base;
  throw new Error(
    `Worker ${worker} serves several custom domains (${domains.join(", ")}) and its BASE_URL names none of them. ${NOTHING}`,
  );
}

/** Each bound template resource, checked to exist. */
async function boundResources(
  ctx: Ctx,
  accountId: string,
  bindings: WorkerBinding[],
): Promise<Resource[]> {
  const bound = (n: TemplateName) =>
    bindings.find((b) => b.name === n && isTemplate(b));
  const missing = (n: TemplateName, what: string, ref: string) =>
    new Error(
      `Binding ${n} points to ${what} ${ref}, which does not exist. ${NOTHING}`,
    );
  const adopted = (n: TemplateName, name: string, id: string): Resource => ({
    key: TEMPLATE[n].key,
    kind: TEMPLATE[n].kind,
    name,
    id,
    ownership: "adopted",
    state: "ready",
  });
  const out: Resource[] = [];

  const db = bound("DB");
  if (!db) {
    throw new Error(
      `The worker has no D1 binding DB: it does not look like a saasmail install. ${NOTHING}`,
    );
  }
  const dbId = db.id ?? db.database_id ?? "(no id)";
  const d1 = (await ctx.cf.listD1(accountId)).find((d) => d.uuid === dbId);
  if (!d1) throw missing("DB", "D1", dbId);
  out.push(adopted("DB", d1.name, d1.uuid));

  const r2 = bound("R2");
  if (r2) {
    const bucket = r2.bucket_name ?? "(no name)";
    if (!(await ctx.cf.listR2(accountId)).includes(bucket))
      throw missing("R2", "R2 bucket", bucket);
    out.push(adopted("R2", bucket, bucket));
  }

  const q = bound("EMAIL_QUEUE");
  if (q) {
    const name = q.queue_name ?? "(no name)";
    const hit = (await ctx.cf.listQueues(accountId)).find(
      (x) => x.name === name,
    );
    if (!hit) throw missing("EMAIL_QUEUE", "queue", name);
    out.push(adopted("EMAIL_QUEUE", hit.name, hit.id));
  }

  const wf = bound("GMAIL_BACKFILL");
  if (wf) {
    const name = wf.workflow_name ?? "(no name)";
    if (!(await ctx.cf.listWorkflows(accountId)).some((x) => x.name === name))
      throw missing("GMAIL_BACKFILL", "workflow", name);
    out.push(adopted("GMAIL_BACKFILL", name, name));
  }
  return out;
}

/**
 * Inbound domains, as install sets them up: the account's zones whose catch-all sends mail to
 * `worker`, with Email Routing on. `routingOff`: zones whose catch-all names the worker but whose
 * Email Routing is off (adding one turns it on, which changes the zone's MX records). Reads every
 * zone's catch-all.
 */
async function detectInbound(
  ctx: Ctx,
  accountId: string,
  worker: string,
): Promise<{ found: string[]; routingOff: string[] }> {
  const found: string[] = [];
  const routingOff: string[] = [];
  for (const z of await ctx.cf.listZones(accountId)) {
    if (catchAllOwner(await ctx.cf.catchAll(z.id), worker) !== "ours") continue;
    const on = (await ctx.cf.emailRouting(z.id))?.enabled;
    (on ? found : routingOff).push(z.name.toLowerCase());
  }
  return { found: found.sort(), routingOff: routingOff.sort() };
}

/**
 * Send domains: the enabled Email Sending subdomains in the inbound domains' zones. Sending
 * subdomains name no worker, so zones that do not receive this worker's mail are not looked at.
 */
async function detectSending(
  ctx: Ctx,
  accountId: string,
  inbound: string[],
): Promise<string[]> {
  const found = new Set<string>();
  const zones = new Set<string>();
  for (const d of inbound) {
    const z = await ctx.cf.findZone(accountId, d);
    if (!z || zones.has(z.id)) continue;
    zones.add(z.id);
    for (const sub of await ctx.cf.listSendingSubdomains(z.id))
      if (sub.enabled) found.add(sub.name.toLowerCase());
  }
  return [...found].sort();
}

/** Email Routing per inbound domain: ok (catch-all to the worker), missing, or elsewhere. */
async function routingLines(ctx: Ctx, s: InstallState): Promise<string[]> {
  const lines: string[] = [];
  for (const d of s.inputs.inboundDomains) {
    const z = await ctx.cf.findZone(s.accountId, d);
    if (!z) {
      lines.push(`  ${d}  missing (no zone in this account)`);
      continue;
    }
    const r = await ctx.cf.emailRouting(z.id);
    const owner = catchAllOwner(await ctx.cf.catchAll(z.id), s.names.worker);
    const verdict =
      owner === "taken"
        ? "elsewhere"
        : owner === "ours" && r?.enabled
          ? "ok"
          : "missing";
    lines.push(`  ${d}  ${verdict}`);
  }
  return lines;
}

/** Email Sending per send domain: ok (every DNS record in place) or missing (with what). */
async function sendingLines(ctx: Ctx, s: InstallState): Promise<string[]> {
  const lines: string[] = [];
  for (const d of s.inputs.sendDomains) {
    const z = await ctx.cf.findZone(s.accountId, d);
    if (!z) {
      lines.push(`  ${d}  missing (no zone in this account)`);
      continue;
    }
    const r = await sendingReport(ctx, d, z.id);
    const absent = r.records.filter((x) => !x.ok).length;
    lines.push(
      r.error !== undefined
        ? `  ${d}  unknown (${r.error})`
        : absent > 0
          ? `  ${d}  missing (${absent} of ${r.records.length} DNS records)`
          : `  ${d}  ok`,
    );
  }
  return lines;
}

/**
 * What adopting `worker` would record, as a report and its digest. Read-only: Cloudflare reads,
 * one GET of `/.well-known/saasmail`, nothing written. Throws (with what was found) on anything
 * it cannot map.
 */
export async function planAdoptWorker(
  ctx: Ctx,
  o: { accountId: string; worker: string; inputs: AdoptInputs },
): Promise<{
  state: InstallState;
  report: string;
  digest: string;
  /** Printed after the report, outside its digest (only when the domains were looked up). */
  notes: string[];
}> {
  const { accountId, worker } = o;
  const badName = validateName(worker);
  if (badName) {
    throw new Error(
      `Worker ${worker} cannot be an installation name: ${badName} ${NOTHING}`,
    );
  }
  const settings = await ctx.cf.workerSettings(accountId, worker);
  if (!settings) throw new Error(noWorker(worker, accountId));
  const { bindings } = settings;
  const unknown = bindings.filter(
    (b) =>
      !isTemplate(b) && !OTHER_NAMES.has(b.name) && !OTHER_TYPES.has(b.type),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Worker ${worker} has bindings saasmail's template does not: ${unknown.map((b) => `${b.name} (${b.type})`).join(", ")}. ${NOTHING}`,
    );
  }
  const vars = plainTextVars(bindings);
  if (vars.SAASMAIL_INSTALLATION) {
    throw new Error(
      `Worker ${worker} already carries a saasmail installation (SAASMAIL_INSTALLATION): adopt it from its checkout with ${ctx.source.command("adopt --from <checkout>")}. ${NOTHING}`,
    );
  }
  const secrets = bindings
    .filter((b) => b.type === "secret_text")
    .map((b) => b.name)
    .sort();

  const resources = await boundResources(ctx, accountId, bindings);
  const names = { ...resourceNames(worker), worker };
  for (const r of resources) names[r.key as keyof typeof names] = r.name;
  resources.push({
    key: "worker",
    kind: "worker",
    name: worker,
    id: worker,
    ownership: "adopted",
    state: "ready",
  });

  const hostname = await servedOn(ctx, accountId, worker, vars.BASE_URL);
  let baseUrl = `https://${hostname}`;
  if (hostname === null) {
    const sub = await ctx.cf.workersSubdomain(accountId);
    if (!sub) {
      throw new Error(
        `Worker ${worker} has no custom domain and the account has no workers.dev subdomain: no URL serves it. ${NOTHING}`,
      );
    }
    baseUrl = `https://${worker}.${sub}.workers.dev`;
  }
  // A zone route (or a BASE_URL naming another host) would silently move the install's URL.
  const deployedHost = hostOf(vars.BASE_URL);
  if (deployedHost && deployedHost !== new URL(baseUrl).hostname) {
    throw new Error(
      `BASE_URL is ${vars.BASE_URL}, but the worker has no custom domain for it (adopt would record ${baseUrl}). Routes other than custom domains are not supported by adopt. ${NOTHING}`,
    );
  }

  const provider = o.inputs.provider ?? detectProvider(bindings);
  if (provider !== "cloudflare" && (o.inputs.sendDomains ?? []).length > 0) {
    throw new Error(
      `--send-domain is only for --provider cloudflare (Email Sending). ${NOTHING}`,
    );
  }
  const deployedPrefix = vars.COOKIE_PREFIX || undefined;
  if (
    o.inputs.cookiePrefix !== undefined &&
    deployedPrefix !== undefined &&
    o.inputs.cookiePrefix !== deployedPrefix
  ) {
    throw new Error(
      `--cookie-prefix ${o.inputs.cookiePrefix} differs from the worker's COOKIE_PREFIX (${deployedPrefix}); changing it signs everyone out. Leave it out to keep ${deployedPrefix}. ${NOTHING}`,
    );
  }

  // Left out, the mail domains are what Cloudflare already sends to this worker. The report is the
  // same either way: the apply command passes what was found as flags, under the same digest.
  const detected =
    o.inputs.inboundDomains === undefined
      ? await detectInbound(ctx, accountId, worker)
      : undefined;
  const inboundDomains = o.inputs.inboundDomains ?? detected!.found;
  const notes = (detected?.routingOff ?? []).map(
    (d) =>
      `Note: ${d}'s catch-all sends mail to ${worker}, but Email Routing is off there, so it is not an inbound domain. Add --inbound-domain ${d} to have the first upgrade turn Email Routing on (that changes ${d}'s MX records).`,
  );
  const sendDomains =
    provider !== "cloudflare"
      ? []
      : (o.inputs.sendDomains ??
        (await detectSending(ctx, accountId, inboundDomains)));

  const fresh = newState({
    installationId: installationIdOf(
      accountId,
      worker,
      hostname ?? "workers.dev",
    ),
    accountId,
    inputs: {
      name: worker,
      hostname,
      workersDev: hostname === null,
      inboundDomains,
      provider,
      sendDomains,
      cookiePrefix: deployedPrefix ?? o.inputs.cookiePrefix ?? "saasmail",
    },
    names,
    baseUrl,
  });
  let s: InstallState = { ...fresh, status: "installed", resources };
  const vapidPublicKey = vars.VAPID_PUBLIC_KEY || undefined;
  if (vapidPublicKey) s.vapidPublicKey = vapidPublicKey;
  else if (secrets.includes("VAPID_PRIVATE_KEY"))
    throw new Error(
      `${lostVapidMessage(ctx, s)} For an adopted worker, set the VAPID_PUBLIC_KEY var on the worker instead.`,
    );
  // The deployed subject is kept: push services key subscriptions to it.
  s = {
    ...s,
    vapidSubject: vapidSubjectFor({
      ...s,
      vapidSubject: vars.VAPID_SUBJECT || undefined,
    }),
  };

  const to = await ctx.source.version(ctx.runner);
  // Spec §6.7: what the first upgrade cannot carry over stops here, before anything is written.
  const changes = varChanges(vars, configVars(renderConfig(ctx, s, to).text));
  if (changes.stops.length > 0) {
    throw new Error(
      [
        `Worker ${worker} has vars the first upgrade would drop or change:`,
        ...changes.stops,
        `Change or remove them on the worker, then run adopt again. ${NOTHING}`,
      ].join("\n"),
    );
  }

  const running =
    (await wellKnownVersion(ctx, baseUrl)) ?? (vars.SAASMAIL_VERSION || null);
  if (running !== null) s.deployedVersion = running;
  const cmp = await compareRunning(
    running,
    { version: to, commit: ctx.source.commit ?? "" },
    ctx.fetchImpl,
  );

  const list = (xs: string[]) => (xs.length > 0 ? xs.join(", ") : "none");
  const i = s.inputs;
  const lines: string[] = [];
  if (cmp.kind === "custom") {
    lines.push(
      `The first upgrade will need --replace-custom-code: ${cmp.reason}.`,
      "",
    );
  }
  lines.push(
    `Adopt worker ${worker} on account ${accountId} as ${i.name}`,
    `  Installation   ${s.installationId}`,
    `  URL            ${baseUrl}`,
    "",
    "Resources (recorded as adopted, as found):",
    ...resources.map(
      (r) =>
        `  ${r.kind.padEnd(9)} ${r.name}${r.id !== r.name ? ` (${r.id})` : ""}`,
    ),
    ...(["d1", "attachments", "queue", "workflow"] as const)
      .filter((k) => !resources.some((r) => r.key === k))
      .map(
        (k) =>
          `  ${(k === "attachments" ? "r2" : k).padEnd(9)} ${names[k]}: not bound; the first upgrade creates it`,
      ),
    "",
    "Inputs:",
    `  Hostname       ${i.hostname ?? "workers.dev"}`,
    `  Inbound        ${list(i.inboundDomains)}`,
    `  Provider       ${i.provider}`,
    `  Send domains   ${list(i.sendDomains)}`,
    `  Cookie prefix  ${i.cookiePrefix}`,
    `  VAPID subject: ${s.vapidSubject}`,
    `  VAPID public key: ${vapidPublicKey ? `${vapidPublicKey.slice(0, 12)}…` : "none (the first upgrade generates a pair)"}`,
    "",
    `Secrets on the worker (names only): ${list(secrets)}`,
  );
  if (changes.drops.length > 0)
    lines.push(
      "",
      "The first upgrade drops these vars (the worker does not need them):",
      ...changes.drops,
    );
  if (i.inboundDomains.length > 0)
    lines.push("", "Routing:", ...(await routingLines(ctx, s)));
  if (i.sendDomains.length > 0)
    lines.push("", "Sending:", ...(await sendingLines(ctx, s)));
  lines.push(
    "",
    `Running ${running ?? "unknown"}; this package ${to} (${cmp.kind === "custom" ? `custom: ${cmp.reason}` : cmp.kind})`,
    "Adopt deploys nothing and changes nothing on Cloudflare; the first upgrade deploys this package.",
  );
  const report = lines.join("\n");
  const digest = createHash("sha256").update(report).digest("hex").slice(0, 12);
  return { state: s, report, digest, notes };
}

/**
 * Prints the plan, then (after confirm, `yes`, or a matching `expectPlan`) writes the state and
 * the generated wrangler.jsonc into `<home>/<worker>/`. Deploys nothing.
 */
export async function adoptWorker(
  outer: Ctx,
  o: {
    accountId: string;
    worker: string;
    inputs: AdoptInputs;
    yes: boolean;
    expectPlan?: string;
    home: string;
  },
): Promise<InstallState> {
  const dir = installDir(o.home, o.worker);
  const ctx: Ctx = { ...outer, dir, configDir: dir };
  const taken = () => {
    if (listStates(dir).length > 0)
      throw new Error(`${dir} already has an install. ${NOTHING}`);
  };
  taken();
  const p = await planAdoptWorker(ctx, o);
  ctx.io.print(p.report);
  for (const n of p.notes) ctx.io.print(`\n${n}`);
  if (o.expectPlan !== undefined && o.expectPlan !== p.digest) {
    throw new Error(
      `The plan changed since it was reviewed (expected ${o.expectPlan}, now ${p.digest}). Review it again with --plan. ${NOTHING}`,
    );
  }
  const consented =
    o.yes ||
    o.expectPlan === p.digest ||
    (await ctx.io.confirm("Adopt this install?", true));
  if (!consented) throw new Error(NOTHING);

  const s: InstallState = { ...p.state, adoptedAt: ctx.now().toISOString() };
  const configFile = join(dir, "wrangler.jsonc");
  const dirExisted = existsSync(dir);
  const configExisted = existsSync(configFile);
  let release: (() => void) | undefined = acquireLock(dir, s.installationId);
  try {
    taken();
    // Config first: a state file is what makes the directory an install.
    writeConfig(ctx, s, s.deployedVersion ?? "");
    writeState(dir, s);
  } catch (e) {
    if (!configExisted) rmSync(configFile, { force: true });
    release();
    release = undefined;
    if (!dirExisted) rmSync(dir, { recursive: true, force: true });
    throw e;
  } finally {
    release?.();
  }
  ctx.io.print(
    `Adopted ${o.worker} into ${dir}.\nCheck it: ${ctx.source.command(`status --name ${o.worker}`)}\nUpgrade it: ${ctx.source.command(`upgrade --name ${o.worker}`)}`,
  );
  return s;
}
