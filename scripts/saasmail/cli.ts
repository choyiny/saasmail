// `yarn saasmail <command>`: the user-facing installer (spec docs/superpowers/specs/2026-10-17-deterministic-install-design.md
// §2–§6). Every outside effect comes in through `Deps`, so tests drive `main` with fakes; the real wiring is at the bottom.
import "./node-guard.ts";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { install, resumeInstalled, type Ctx, type Optional } from "./apply.ts";
import { assertConfigWritable, OPTIONAL_ITEMS } from "./apply-steps.ts";
import { restCloudflare, type Cloudflare } from "./cloudflare.ts";
import { clackIo, collect, type Io } from "./collect.ts";
import {
  installDir,
  pickInstall,
  pickResumable,
  saasmailHome,
} from "./home.ts";
import { ConfigConflict } from "./config.ts";
import { installationIdOf, resourceNames, validateName } from "./names.ts";
import { observe } from "./observe.ts";
import { computePlan, formatPlan } from "./plan.ts";
import { preflight } from "./preflight.ts";
import { processRunner, type Runner } from "./runner.ts";
import { checkoutSource, packageSource, type Source } from "./source.ts";
import {
  hasStep,
  listStates,
  newState,
  readState,
  type InstallState,
  type Provider,
} from "./state.ts";
import { findState, status, UsageError } from "./status.ts";
import { upgrade } from "./upgrade.ts";
import { latestOnNpm } from "./versions.ts";

export const usage = (
  source: Source,
) => `Usage: ${source.command("<command> [options]")}

Commands:
  install    Create or update a saasmail installation on Cloudflare
  status     Show a recorded installation and check that it answers
  upgrade    Move an installation to this package's version (npx only)

install options:
  --name <name>             Installation name (default: saasmail)
  --account <id|name>       Cloudflare account (not needed when the login sees one)
  --hostname <host>         Serve on a custom hostname in one of the account's zones
  --workers-dev             Serve on <name>.<subdomain>.workers.dev instead
  --inbound-domain <domain> Route this zone's mail to saasmail (repeatable; default: none)
  --provider <provider>     Outbound email: cloudflare, resend, postmark, bavimail or none
                            (default: cloudflare)
  --send-domain <domain>    Email Sending domain for --provider cloudflare (repeatable)
  --cookie-prefix <prefix>  Session cookie prefix (default: saasmail)
  --plan                    Only show what would change, then print the apply command
  --expect-plan <digest>    Apply only if the plan still has this digest
  --resume                  Continue a recorded installation, or add domains or credentials
                            to an installed one
  --new-setup-code          With --resume on an installed instance nobody has claimed yet:
                            replace the setup code (the old one stops working)
  --yes                     Apply without asking (required when not in a terminal)

  Environment: CLOUDFLARE_API_TOKEN (else wrangler's login); provider credentials
  SAASMAIL_RESEND_API_KEY (resend), SAASMAIL_POSTMARK_API_KEY (postmark),
  SAASMAIL_BAVIMAIL_API_KEY and SAASMAIL_BAVIMAIL_ALIAS_ID (bavimail).
  Without them a terminal asks for them (hidden input).

status options:
  --name <name>             Which installation (default: the only one recorded)

upgrade options:
  --name <name>             Which installation (default: the only one recorded)
  --plan                    Only show what would change, then print the apply command
  --expect-plan <digest>    Apply only if the plan still has this digest
  --resume                  Continue a failed upgrade
  --replace-custom-code     Replace a running version that is not a release with this one
  --yes                     Apply without asking (required when not in a terminal)
`;

const DEFAULT_NAME = "saasmail";
const DEFAULT_PROVIDER: Provider = "cloudflare";
const DEFAULT_COOKIE_PREFIX = "saasmail";
const PROVIDERS: Provider[] = [
  "cloudflare",
  "resend",
  "postmark",
  "bavimail",
  "none",
];

/** Environment variable per provider credential (`OPTIONAL_ITEMS` id). */
const CREDENTIAL_ENV: Record<string, string> = {
  "resend-api-key": "SAASMAIL_RESEND_API_KEY",
  "postmark-api-key": "SAASMAIL_POSTMARK_API_KEY",
  "bavimail-api-key": "SAASMAIL_BAVIMAIL_API_KEY",
  "bavimail-alias-id": "SAASMAIL_BAVIMAIL_ALIAS_ID",
};

export type Deps = Omit<Ctx, "cf"> & {
  env: Record<string, string | undefined>;
  /** The Cloudflare API token; throws with what to do when there is none. */
  token(): Promise<string>;
  cloudflare(token: string): Cloudflare;
  /** Package mode: the directory holding every install (<home>/<slug>/); null = checkout mode (dir and configDir as given). */
  home: string | null;
};

type InstallFlags = {
  name?: string;
  account?: string;
  hostname?: string;
  "workers-dev"?: boolean;
  "inbound-domain"?: string[];
  provider?: string;
  "send-domain"?: string[];
  "cookie-prefix"?: string;
  plan?: boolean;
  "expect-plan"?: string;
  resume?: boolean;
  "new-setup-code"?: boolean;
  yes?: boolean;
};

const INSTALL_OPTIONS = {
  name: { type: "string" },
  account: { type: "string" },
  hostname: { type: "string" },
  "workers-dev": { type: "boolean" },
  "inbound-domain": { type: "string", multiple: true },
  provider: { type: "string" },
  "send-domain": { type: "string", multiple: true },
  "cookie-prefix": { type: "string" },
  plan: { type: "boolean" },
  "expect-plan": { type: "string" },
  resume: { type: "boolean" },
  "new-setup-code": { type: "boolean" },
  yes: { type: "boolean" },
} as const;

const UPGRADE_OPTIONS = {
  name: { type: "string" },
  plan: { type: "boolean" },
  "expect-plan": { type: "string" },
  resume: { type: "boolean" },
  yes: { type: "boolean" },
  "replace-custom-code": { type: "boolean" },
} as const;

type UpgradeFlags = {
  name?: string;
  plan?: boolean;
  "expect-plan"?: string;
  resume?: boolean;
  yes?: boolean;
  "replace-custom-code"?: boolean;
};

const NOT_A_TERMINAL =
  "Not running in a terminal: pass --yes to apply (or --plan to only review).";

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const COOKIE_RE = /^[A-Za-z0-9_-]{1,32}$/;

const hostProblem = (v: string) =>
  HOST_RE.test(v)
    ? undefined
    : `${v} is not a hostname (like mail.example.com).`;
const cookieProblem = (v: string) =>
  COOKIE_RE.test(v)
    ? undefined
    : `${v} is not a cookie prefix (1 to 32 letters, digits, - or _).`;

/** Trimmed, lowercased, without duplicates, in first-seen order. */
export function normaliseDomains(xs: readonly string[]): string[] {
  return [...new Set(xs.map((x) => x.trim().toLowerCase()))];
}

/** A comma- or space-separated answer as a domain list. */
const splitDomains = (v: string) =>
  normaliseDomains(v.split(/[\s,]+/).filter((x) => x !== ""));

const domainsProblem = (v: string) =>
  splitDomains(v)
    .map(hostProblem)
    .find((p) => p !== undefined);

const SEND_DOMAIN_ONLY_CLOUDFLARE =
  "--send-domain is only for --provider cloudflare (Email Sending).";

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const TOKEN_LINE = /^[A-Za-z0-9._-]{20,}$/;

/**
 * The token: CLOUDFLARE_API_TOKEN, else the last token-shaped line of `wrangler auth token`
 * (banners and colour codes around it are ignored).
 */
export async function resolveToken(
  env: Record<string, string | undefined>,
  runner: Runner,
  source: Source,
): Promise<string> {
  if (env.CLOUDFLARE_API_TOKEN) return env.CLOUDFLARE_API_TOKEN;
  let token: string | undefined;
  try {
    const c = source.wranglerBare(["auth", "token"]);
    const r = await runner.run(c.cmd, c.args);
    if (r.code === 0)
      token = r.stdout
        .replace(ANSI, "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => TOKEN_LINE.test(l))
        .pop();
  } catch {
    // no wrangler: same message
  }
  if (!token) throw new Error(`Run ${source.wranglerCommand("login")} first.`);
  return token;
}

/** The CLI entry. Returns the process exit code: 0 done, 1 failed, 2 usage. */
export async function main(argv: string[], deps: Deps): Promise<number> {
  const [command, ...rest] = argv;
  const { io } = deps;
  if (
    command === undefined ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  ) {
    io.print(usage(deps.source));
    return command === undefined ? 2 : 0;
  }
  try {
    if (command === "install") {
      const { values } = parseArgs({
        args: rest,
        options: INSTALL_OPTIONS,
        strict: true,
        allowPositionals: false,
      });
      return await runInstall(values, deps);
    }
    if (command === "status") {
      const { values } = parseArgs({
        args: rest,
        options: { name: { type: "string" } },
        strict: true,
        allowPositionals: false,
      });
      const latest = () => latestOnNpm(deps.fetchImpl);
      // Package mode: the install's own directory under home.
      const picked = deps.home ? pickInstall(deps.home, values.name) : null;
      const dir = picked ? installDir(deps.home!, picked.slug) : deps.dir;
      return await status(
        { name: values.name, slug: picked?.slug },
        { ...deps, dir, latest },
      );
    }
    if (command === "upgrade") {
      const { values } = parseArgs({
        args: rest,
        options: UPGRADE_OPTIONS,
        strict: true,
        allowPositionals: false,
      });
      return await runUpgrade(values, deps);
    }
  } catch (e) {
    if (e instanceof UsageError || isParseArgsError(e)) {
      io.print(`${(e as Error).message}\n\n${usage(deps.source)}`);
      return 2;
    }
    throw e;
  }
  io.print(`Unknown command: ${command}\n\n${usage(deps.source)}`);
  return 2;
}

function isParseArgsError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS");
}

type Resolved = {
  name: string;
  accountId: string;
  hostname: string | null;
  inboundDomains: string[];
  provider: Provider;
  sendDomains: string[];
  cookiePrefix: string;
};

const isProvider = (v: string): v is Provider =>
  (PROVIDERS as string[]).includes(v);

/** Checks that need no network: conflicting or malformed flags are usage errors. */
function checkFlags(f: InstallFlags): void {
  if (f.hostname !== undefined && f["workers-dev"]) {
    throw new UsageError("Pass either --hostname or --workers-dev, not both.");
  }
  if (f["new-setup-code"] && !f.resume) {
    throw new UsageError(
      "--new-setup-code works only with --resume (on an installed instance).",
    );
  }
  if (f.provider !== undefined && !isProvider(f.provider)) {
    throw new UsageError(
      `--provider must be one of ${PROVIDERS.join(", ")} (got ${f.provider}).`,
    );
  }
  if (
    f["send-domain"] !== undefined &&
    f.provider !== undefined &&
    f.provider !== "cloudflare"
  ) {
    throw new UsageError(SEND_DOMAIN_ONLY_CLOUDFLARE);
  }
  const domains = normaliseDomains([
    ...(f.hostname !== undefined ? [f.hostname] : []),
    ...(f["inbound-domain"] ?? []),
    ...(f["send-domain"] ?? []),
  ]);
  const bad =
    (f.name !== undefined ? (validateName(f.name) ?? undefined) : undefined) ??
    domains.map(hostProblem).find((p) => p !== undefined) ??
    (f["cookie-prefix"] !== undefined
      ? cookieProblem(f["cookie-prefix"])
      : undefined);
  if (bad) throw new UsageError(bad);
}

async function resolveAccount(
  cf: Cloudflare,
  io: Io,
  flag: string | undefined,
): Promise<string> {
  const accounts = await cf.listAccounts();
  if (accounts.length === 0) {
    throw new Error("This Cloudflare login sees no accounts.");
  }
  if (flag !== undefined) {
    const hit =
      accounts.find((a) => a.id === flag) ??
      accounts.find((a) => a.name.toLowerCase() === flag.toLowerCase());
    if (!hit) {
      throw new Error(
        `No account matches --account ${flag}. This login sees: ${accounts.map((a) => `${a.name} (${a.id})`).join(", ")}.`,
      );
    }
    return hit.id;
  }
  if (accounts.length === 1) return accounts[0]!.id;
  if (!io.tty) {
    throw new UsageError(
      "--account is required when not running in a terminal (this login sees more than one account).",
    );
  }
  return io.select(
    "Cloudflare account",
    accounts.map((a) => ({ value: a.id, label: `${a.name} (${a.id})` })),
  );
}

/** collect(), with a missing or invalid input as a usage error (exit 2). */
async function ask(io: Io, o: Parameters<typeof collect>[1]): Promise<string> {
  try {
    return await collect(io, o);
  } catch (e) {
    const m = (e as Error).message;
    throw m === "Cancelled." ? e : new UsageError(m);
  }
}

/** A prompt answer; a cancelled prompt stops the run. */
async function answer(
  io: Io,
  message: string,
  opts: Parameters<Io["prompt"]>[1],
): Promise<string> {
  const v = await io.prompt(message, opts);
  if (v === null) throw new Error("Cancelled.");
  return v;
}

type MailFlags = Pick<
  InstallFlags,
  "inbound-domain" | "provider" | "send-domain" | "yes"
>;

/**
 * Inbound domains → provider → send domains: flag, else (in a terminal without --yes) a prompt,
 * else none / the default provider.
 */
async function resolveMail(
  f: MailFlags,
  io: Io,
): Promise<Pick<Resolved, "inboundDomains" | "provider" | "sendDomains">> {
  const asking = io.tty && !f.yes;
  const domainList = async (
    flag: string[] | undefined,
    message: string,
  ): Promise<string[]> => {
    if (flag !== undefined) return normaliseDomains(flag);
    if (!asking) return [];
    const v = await answer(io, message, { validate: domainsProblem });
    const bad = domainsProblem(v);
    if (bad) throw new UsageError(bad);
    return splitDomains(v);
  };

  const inboundDomains = await domainList(
    f["inbound-domain"],
    "Domains whose mail saasmail receives (comma-separated, empty for none)",
  );

  let provider: Provider = DEFAULT_PROVIDER;
  if (f.provider !== undefined) provider = f.provider as Provider;
  else if (asking) {
    provider = await io.select<Provider>("Outbound email provider", [
      { value: "cloudflare", label: "Cloudflare Email Sending" },
      { value: "resend", label: "Resend" },
      { value: "postmark", label: "Postmark" },
      { value: "bavimail", label: "Bavimail" },
      { value: "none", label: "None for now (sending fails until set)" },
    ]);
  }
  if (f["send-domain"] !== undefined && provider !== "cloudflare") {
    throw new UsageError(SEND_DOMAIN_ONLY_CLOUDFLARE);
  }

  const sendDomains =
    provider === "cloudflare"
      ? await domainList(
          f["send-domain"],
          "Domains to send from with Email Sending (comma-separated, empty for none)",
        )
      : [];
  return { inboundDomains, provider, sendDomains };
}

/**
 * Spec §2 order: name → account → hostname → inbound domains → provider → send domains → cookie
 * prefix. Flag, then a prompt in a terminal (collect). The mail inputs and the cookie prefix have
 * defaults, so they are asked for only in a terminal without --yes: an apply command (always
 * --yes) then means exactly what it says, including "no domains".
 */
async function resolveInputs(
  f: InstallFlags,
  cf: Cloudflare,
  io: Io,
): Promise<Resolved> {
  const name = await ask(io, {
    flag: f.name,
    message: "Installation name",
    initial: DEFAULT_NAME,
    fallback: DEFAULT_NAME,
    validate: (x) => validateName(x) ?? undefined,
    flagName: "--name",
  });

  const accountId = await resolveAccount(cf, io, f.account);

  let hostname: string | null = null;
  if (!f["workers-dev"]) {
    const custom =
      f.hostname !== undefined ||
      !io.tty ||
      (await io.select("Where should it be served?", [
        {
          value: "workers.dev",
          label: `workers.dev (${name}.<subdomain>.workers.dev)`,
        },
        {
          value: "custom",
          label: "A custom hostname on a zone in this account",
        },
      ])) === "custom";
    if (custom) {
      hostname = (
        await ask(io, {
          flag: f.hostname?.trim(),
          message: "Hostname (like mail.example.com)",
          validate: hostProblem,
          flagName: "--hostname <host> or --workers-dev",
        })
      ).toLowerCase();
    }
  }

  const asking = io.tty && !f.yes;
  const { inboundDomains, provider, sendDomains } = await resolveMail(f, io);

  let cookiePrefix = f["cookie-prefix"] ?? DEFAULT_COOKIE_PREFIX;
  if (f["cookie-prefix"] === undefined && asking) {
    const v = await answer(io, "Cookie prefix", {
      initial: DEFAULT_COOKIE_PREFIX,
      validate: (x) => (x === "" ? undefined : cookieProblem(x)),
    });
    if (v !== "") {
      const bad = cookieProblem(v);
      if (bad) throw new UsageError(bad);
      cookiePrefix = v;
    }
  }

  return {
    name,
    accountId,
    hostname,
    inboundDomains,
    provider,
    sendDomains,
    cookiePrefix,
  };
}

/** `--resume` without `--name`: the only unfinished installation, else the only one. */
function resumable(dir: string, name: string | undefined): InstallState | null {
  if (name !== undefined) return findState(dir, name);
  const all = listStates(dir);
  const unfinished = all.filter((s) => s.status !== "installed");
  if (unfinished.length === 1) return unfinished[0]!;
  if (unfinished.length > 1 || all.length > 1) {
    throw new UsageError(
      `More than one installation is recorded in ${dir} (${all.map((s) => s.inputs.name).join(", ")}): pass --name.`,
    );
  }
  return all[0] ?? null;
}

/**
 * The flags given that disagree with what `s` recorded. Domains given are additions to the
 * recorded ones (spec §6), never a difference.
 */
async function differences(
  f: InstallFlags,
  s: InstallState,
  cf: Cloudflare,
): Promise<string[]> {
  const out: string[] = [];
  if (f.account !== undefined && f.account !== s.accountId) {
    const hit = (await cf.listAccounts()).find(
      (a) => a.name.toLowerCase() === f.account!.toLowerCase(),
    );
    if (hit?.id !== s.accountId) out.push("account");
  }
  if (
    (f.hostname !== undefined &&
      f.hostname.trim().toLowerCase() !== s.inputs.hostname) ||
    (f["workers-dev"] && !s.inputs.workersDev)
  ) {
    out.push("hostname");
  }
  if (f.provider !== undefined && f.provider !== s.inputs.provider) {
    out.push("provider");
  }
  if (
    f["cookie-prefix"] !== undefined &&
    f["cookie-prefix"] !== s.inputs.cookiePrefix
  ) {
    out.push("cookie-prefix");
  }
  return out;
}

/** Single-quotes a value for a POSIX shell unless it is plainly safe. */
export function shellQuote(v: string): string {
  return /^[A-Za-z0-9@._:/-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * The apply command for a reviewed plan: the resolved inputs as flags, never a secret. `digest`
 * is null for an installed resume, which applies no plan.
 */
export function applyCommand(
  s: InstallState,
  resume: boolean,
  digest: string | null,
  newSetupCode = false,
  source: Source,
): string {
  const i = s.inputs;
  const q = shellQuote;
  return [
    source.command("install"),
    ...(resume ? ["--resume"] : []),
    `--name ${q(i.name)}`,
    `--account ${q(s.accountId)}`,
    i.hostname ? `--hostname ${q(i.hostname)}` : "--workers-dev",
    ...i.inboundDomains.map((d) => `--inbound-domain ${q(d)}`),
    `--provider ${q(i.provider)}`,
    ...(i.provider === "cloudflare" ? i.sendDomains : []).map(
      (d) => `--send-domain ${q(d)}`,
    ),
    `--cookie-prefix ${q(i.cookiePrefix)}`,
    ...(digest ? [`--expect-plan ${digest}`] : []),
    ...(newSetupCode ? ["--new-setup-code"] : []),
    "--yes",
  ].join(" ");
}

/**
 * The provider's credentials (spec §2): env first, else (in a terminal) masked prompts. Required
 * until the first deploy has sent them: a missing one is returned in `missing` (by variable name)
 * so the run stops before anything is written. Afterwards they are optional and added only when
 * given; a terminal is asked only for the ones recorded as skipped (empty skips).
 */
async function collectCredentials(
  deps: Deps,
  s: InstallState,
): Promise<{ optional: Optional; missing: string[] }> {
  const { io, env } = deps;
  const required = s.status !== "installed" && !hasStep(s, "deploy:1");
  const optional: Optional = {};
  const missing: string[] = [];
  for (const item of OPTIONAL_ITEMS) {
    if (item.provider !== s.inputs.provider) continue;
    const envName = CREDENTIAL_ENV[item.id]!;
    let v = env[envName];
    if (!v && io.tty && (required || s.skipped.includes(item.id))) {
      v =
        (await io.prompt(`${item.label} (${envName})`, { mask: true })) ??
        undefined;
    }
    if (v) optional[item.field] = v;
    else if (required) missing.push(envName);
  }
  return { optional, missing };
}

const movedMessage = (movedTo: string) =>
  `This install moved to ${movedTo}. Run npx saasmail upgrade --name ${basename(movedTo)}.`;

async function runInstall(f: InstallFlags, deps: Deps): Promise<number> {
  const { io } = deps;
  checkFlags(f);
  // Before the token or any Cloudflare call.
  if (!io.tty && !f.plan && !f.yes) {
    io.print(NOT_A_TERMINAL);
    return 2;
  }

  let token: string;
  try {
    token = await deps.token();
  } catch (e) {
    io.print((e as Error).message);
    return 1;
  }
  const { env: _env, token: _t, cloudflare, home, ...rest } = deps;
  let ctx: Ctx = { ...rest, cf: cloudflare(token) };
  // Package mode: state, lock and wrangler.jsonc live together in <home>/<slug>/, chosen once the name is known.
  const inInstall = (slug: string) => {
    if (home === null) return;
    const d = installDir(home, slug);
    ctx = { ...ctx, dir: d, configDir: d };
  };

  try {
    let s: InstallState;
    let recorded: boolean;
    if (f.resume) {
      if (home !== null) inInstall(pickResumable(home, f.name).slug);
      const found = resumable(ctx.dir, f.name);
      if (!found) {
        io.print(
          f.name === undefined
            ? `No installation found to resume in ${ctx.dir}.`
            : `No installation named ${f.name} found in ${ctx.dir}.`,
        );
        return 1;
      }
      if (found.movedTo !== undefined) {
        io.print(movedMessage(found.movedTo));
        return 1;
      }
      if (
        found.status === "upgrading" ||
        (found.status === "failed" && found.upgradeTarget !== undefined)
      ) {
        io.print(
          `An upgrade to ${found.upgradeTarget} is unfinished; run ${deps.source.command(`upgrade --resume --name ${found.inputs.name}`)}.`,
        );
        return 1;
      }
      if (
        f["send-domain"] !== undefined &&
        (f.provider ?? found.inputs.provider) !== "cloudflare"
      ) {
        throw new UsageError(
          `${SEND_DOMAIN_ONLY_CLOUDFLARE} ${found.inputs.name} uses ${found.inputs.provider}.`,
        );
      }
      const diff = await differences(f, found, ctx.cf);
      if (diff.length > 0) {
        io.print(
          `These options differ from the recorded installation: ${diff.join(", ")}`,
        );
        return 1;
      }
      // Domains given now are added to the recorded ones (saved only by the apply).
      s = {
        ...found,
        inputs: {
          ...found.inputs,
          inboundDomains: normaliseDomains([
            ...found.inputs.inboundDomains,
            ...(f["inbound-domain"] ?? []),
          ]),
          sendDomains: normaliseDomains([
            ...found.inputs.sendDomains,
            ...(f["send-domain"] ?? []),
          ]),
        },
      };
      recorded = true;
    } else {
      const r = await resolveInputs(f, ctx.cf, io);
      const id = installationIdOf(
        r.accountId,
        r.name,
        r.hostname ?? "workers.dev",
      );
      inInstall(r.name);
      const existing = readState(ctx.dir, id);
      if (existing) {
        if (existing.movedTo !== undefined) {
          io.print(movedMessage(existing.movedTo));
          return 1;
        }
        if (existing.status === "installed") {
          io.print(
            `${r.name} is already installed at ${existing.baseUrl}. Nothing was changed.\n` +
              `Check it: ${deps.source.command(`status --name ${r.name}`)}\n` +
              `Add domains or credentials: ${deps.source.command(`install --resume --name ${r.name}`)}\n` +
              `Replace a lost setup code (before the first admin exists): ${deps.source.command(`install --resume --name ${r.name} --new-setup-code`)}`,
          );
          return 0;
        }
        io.print(
          `An installation of ${r.name} is recorded with status ${existing.status}. Rerun with --resume: ${deps.source.command(`install --resume --name ${r.name}`)}`,
        );
        return 1;
      }
      // Transient: written only by install(), never by --plan.
      s = newState({
        installationId: id,
        accountId: r.accountId,
        inputs: {
          name: r.name,
          hostname: r.hostname,
          workersDev: r.hostname === null,
          inboundDomains: r.inboundDomains,
          provider: r.provider,
          sendDomains: r.sendDomains,
          cookiePrefix: r.cookiePrefix,
        },
        names: resourceNames(r.name),
        baseUrl: "",
      });
      recorded = false;
    }

    // Before every path, --plan and apply alike (an installed resume too).
    const pre = await preflight(ctx.cf, ctx.runner, {
      accountId: s.accountId,
      hostname: s.inputs.hostname,
      workersDev: s.inputs.workersDev,
      workerName: s.names.worker,
      inboundDomains: s.inputs.inboundDomains,
      sendDomains: s.inputs.sendDomains,
      provider: s.inputs.provider,
    });
    if (pre.failures.length > 0) {
      io.print("Preflight found problems; nothing was changed.\n");
      for (const x of pre.failures) io.print(`✗ ${x.message}\n  Fix: ${x.fix}`);
      return 1;
    }
    // A recorded base URL is never recomputed.
    if (!recorded) {
      if (!pre.baseUrl) throw new Error("Could not work out the base URL.");
      s = { ...s, baseUrl: pre.baseUrl };
    }

    const plan = computePlan(
      {
        installationId: s.installationId,
        ownershipNonce: s.ownershipNonce,
        names: s.names,
        inboundDomains: s.inputs.inboundDomains,
        provider: s.inputs.provider,
        sendDomains: s.inputs.sendDomains,
      },
      await observe(ctx.cf, s.accountId, s.names, s.inputs),
      s,
    );
    io.print(formatPlan(plan, s.inputs, s.baseUrl));
    const installed = s.status === "installed";
    // An installed resume that routes or onboards a domain changes mail delivery: it is confirmed
    // and bound to the plan like a first install. Credential- or code-only resumes are not.
    const pendingMail = plan.actions.some(
      (a) =>
        (a.kind === "routing" || a.kind === "sending") && !hasStep(s, a.key),
    );
    const bound = !installed || pendingMail;

    if (f.plan) {
      try {
        assertConfigWritable(ctx);
      } catch (e) {
        if (!(e instanceof ConfigConflict)) throw e;
        io.print(
          "\nwrangler.jsonc was written by hand: apply will refuse until you move it aside (e.g. `mv wrangler.jsonc wrangler.jsonc.hand`).",
        );
      }
      io.print(`\nPlan ${plan.digest}\n\nTo apply it:`);
      // An installed resume without mail changes applies no plan, so its command carries no digest.
      io.print(
        applyCommand(
          s,
          Boolean(f.resume),
          bound ? plan.digest : null,
          Boolean(f["new-setup-code"]),
          deps.source,
        ),
      );
      return 0;
    }
    const expected = f["expect-plan"];
    if (expected !== undefined && expected !== plan.digest) {
      io.print(
        `\nThe plan changed since it was reviewed (expected ${expected}, now ${plan.digest}). Nothing was changed.\n\nPlan ${plan.digest}`,
      );
      return 1;
    }

    if (bound && !f.yes && !(await io.confirm("Apply this plan?", true))) {
      io.print("Nothing was changed.");
      return 1;
    }
    const { optional, missing } = await collectCredentials(deps, s);
    if (missing.length > 0) {
      io.print(
        io.tty
          ? `The ${s.inputs.provider} provider needs ${missing.join(", ")}, which ${missing.length > 1 ? "were" : "was"} left empty. Nothing was changed.`
          : `The ${s.inputs.provider} provider needs ${missing.join(", ")}: set ${missing.length > 1 ? "them" : "it"} in the environment, or run in a terminal to be asked. Nothing was changed.`,
      );
      return 1;
    }
    if (installed) {
      await resumeInstalled(ctx, s, optional, {
        newSetupCode: Boolean(f["new-setup-code"]),
        expectPlan: pendingMail ? (expected ?? plan.digest) : undefined,
      });
    } else {
      await install(ctx, {
        state: s,
        // Binds the apply to the plan shown (and confirmed): a plan that changes meanwhile stops.
        expectPlan: expected ?? plan.digest,
        yes: Boolean(f.yes),
        optional,
      });
    }
    return 0;
  } catch (e) {
    if (e instanceof UsageError) throw e;
    // A PlanStop's message is the text meant for the person, like every other failure here.
    io.print((e as Error).message);
    return 1;
  }
}

/** `upgrade` (spec §5): package mode only (ruling P2); a checkout points at npx. */
async function runUpgrade(f: UpgradeFlags, deps: Deps): Promise<number> {
  const { io, home } = deps;
  if (home === null) {
    io.print(
      "upgrade runs from npm on installs made with npx saasmail install. To update this checkout, see https://github.com/choyiny/saasmail/blob/main/docs/updating.md#forks-and-modified-code.",
    );
    return 2;
  }
  if (!io.tty && !f.plan && !f.yes) {
    io.print(NOT_A_TERMINAL);
    return 2;
  }
  const picked = pickInstall(home, f.name);
  let token: string;
  try {
    token = await deps.token();
  } catch (e) {
    io.print((e as Error).message);
    return 1;
  }
  const { env: _env, token: _t, cloudflare, home: _h, ...rest } = deps;
  const d = installDir(home, picked.slug);
  const ctx: Ctx = { ...rest, cf: cloudflare(token), dir: d, configDir: d };
  try {
    await upgrade(ctx, {
      state: picked.state,
      yes: Boolean(f.yes),
      expectPlan: f["expect-plan"],
      replaceCustomCode: Boolean(f["replace-custom-code"]),
      resume: Boolean(f.resume),
      plan: Boolean(f.plan),
    });
    return 0;
  } catch (e) {
    io.print((e as Error).message);
    return 1;
  }
}

/**
 * Whether this module is the program being run. `import.meta.main` exists from Node 22.18/24.2;
 * where it is undefined (an older Node), compare the script path instead.
 */
export function isEntry(
  main: boolean | undefined,
  argv1: string | undefined,
  url: string,
): boolean {
  if (main !== undefined) return main;
  if (argv1 === undefined) return false;
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(argv1) === real(fileURLToPath(url));
}

if (isEntry(import.meta.main, process.argv[1], import.meta.url)) {
  const cwd = process.cwd();
  // The npm bundle defines __SAASMAIL_PACKAGE_ROOT__ (Task 11); in a checkout it is not defined at all.
  const PACKAGED = typeof __SAASMAIL_PACKAGE_ROOT__ === "string";
  const home = PACKAGED ? saasmailHome(process.env) : null;
  // The bundle lives at <root>/bin/saasmail.js.
  const source = PACKAGED
    ? packageSource(dirname(dirname(fileURLToPath(import.meta.url))))
    : checkoutSource(cwd);
  const deps: Deps = {
    io: clackIo,
    env: process.env,
    runner: processRunner,
    dir: home ?? join(cwd, ".saasmail"),
    source,
    home,
    configDir: home ?? cwd,
    fetchImpl: fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    token: () => resolveToken(process.env, processRunner, source),
    cloudflare: (token) => restCloudflare(token, fetch),
  };
  process.exitCode = await main(process.argv.slice(2), deps);
}
