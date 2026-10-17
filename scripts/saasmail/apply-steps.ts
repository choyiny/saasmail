// Step helpers for apply.ts: local files, wrangler/yarn invocations, secrets and verify.
// Nothing here puts a secret into argv, a log line, the state file or an error message.
// Mail (Email Routing, Email Sending) lives in apply-mail.ts.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Cloudflare } from "./cloudflare.ts";
import type { Io } from "./collect.ts";
import {
  ConfigConflict,
  configHash,
  generateWranglerConfig,
  isGenerated,
} from "./config.ts";
import type { Runner } from "./runner.ts";
import type { Source } from "./source.ts";
import {
  generateEncryptionKey,
  generateHexSecret,
  generateVapidKeys,
  withSecretsFile,
} from "./secrets.ts";
import type { InstallState, Provider } from "./state.ts";

export type Ctx = {
  cf: Cloudflare;
  runner: Runner;
  io: Io;
  /** Where state and lock files live (`.saasmail/`). */
  dir: string;
  /** Where the installer runs from: a checkout or the npm package. */
  source: Source;
  /** Where the generated wrangler.jsonc lives: the checkout root, or `~/.saasmail/<slug>`. */
  configDir: string;
  fetchImpl: typeof fetch;
  sleep(ms: number): Promise<void>;
  now(): Date;
};

/** Provider credentials; each one is sent only when supplied. */
export type Optional = {
  resendApiKey?: string;
  postmarkApiKey?: string;
  bavimailApiKey?: string;
  bavimailAliasId?: string;
};

/** Provider credentials, as recorded in `state.skipped` when not supplied. */
export const OPTIONAL_ITEMS: {
  id: string;
  label: string;
  provider: Provider;
  field: keyof Optional;
  secret: string;
}[] = [
  {
    id: "resend-api-key",
    label: "Resend API key",
    provider: "resend",
    field: "resendApiKey",
    secret: "RESEND_API_KEY",
  },
  {
    id: "postmark-api-key",
    label: "Postmark API key",
    provider: "postmark",
    field: "postmarkApiKey",
    secret: "POSTMARK_API_KEY",
  },
  {
    id: "bavimail-api-key",
    label: "Bavimail API key",
    provider: "bavimail",
    field: "bavimailApiKey",
    secret: "BAVIMAIL_API_KEY",
  },
  {
    id: "bavimail-alias-id",
    label: "Bavimail alias ID",
    provider: "bavimail",
    field: "bavimailAliasId",
    secret: "BAVIMAIL_ALIAS_ID",
  },
];

/**
 * The provider's credentials `o` does not supply, limited to `prev` unless it is `null`
 * (every item was offered).
 */
export function skippedAfter(
  prev: string[] | null,
  o: Optional,
  provider: Provider,
): string[] {
  return OPTIONAL_ITEMS.filter(
    (i) =>
      i.provider === provider &&
      !o[i.field] &&
      (prev === null || prev.includes(i.id)),
  ).map((i) => i.id);
}

export function optionalSecrets(o: Optional): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of OPTIONAL_ITEMS) {
    const v = o[i.field];
    if (v) out[i.secret] = v;
  }
  return out;
}

const tail = (text: string) => text.trim().split("\n").slice(-10).join("\n");

async function mustRun(
  ctx: Ctx,
  what: string,
  c: { cmd: string; args: string[] },
) {
  const r = await ctx.runner.run(c.cmd, c.args, { cwd: ctx.configDir });
  if (r.code !== 0) {
    const out = tail(r.stderr || r.stdout);
    throw new Error(
      `${what} failed (exit ${r.code})${out ? `:\n${out}` : "."}`,
    );
  }
  return r;
}

const configPath = (ctx: Ctx) => join(ctx.configDir, "wrangler.jsonc");

function existingConfig(ctx: Ctx): string | null {
  const p = configPath(ctx);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** Throws ConfigConflict when wrangler.jsonc exists and is hand-written. Touches nothing. */
export function assertConfigWritable(ctx: Ctx): void {
  const text = existingConfig(ctx);
  if (text !== null && !isGenerated(text)) throw new ConfigConflict();
}

/**
 * The wrangler.jsonc text for `s` at `version`, and the sha256 of its deployed (top-level) part.
 * Writes nothing.
 */
export function renderConfig(
  ctx: Ctx,
  s: InstallState,
  version: string,
): { text: string; hash: string } {
  const template = readFileSync(ctx.source.templatePath, "utf8");
  const text = generateWranglerConfig(template, s, {
    version,
    command: ctx.source.command("install"),
    existing: existingConfig(ctx),
    build: ctx.source.build,
  });
  return {
    text,
    hash: configHash(text, ctx.source.build),
  };
}

/** Generates and writes wrangler.jsonc; returns renderConfig's hash. */
export function writeConfig(
  ctx: Ctx,
  s: InstallState,
  version: string,
): string {
  const { text, hash } = renderConfig(ctx, s, version);
  // Under ~/.saasmail the config sits with the state file, so it is private like it; a checkout's is the repo's own.
  if (text !== existingConfig(ctx))
    writeFileSync(
      configPath(ctx),
      text,
      ctx.source.kind === "package" ? { mode: 0o600 } : undefined,
    );
  return hash;
}

/** sha256 over the sorted migrations/*.sql names and contents. */
export function migrationsDigest(d: string): string {
  const hash = createHash("sha256");
  for (const f of readdirSync(d)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    hash
      .update(`${f}\0`)
      .update(readFileSync(join(d, f)))
      .update("\0");
  }
  return hash.digest("hex");
}

export async function applyMigrations(ctx: Ctx): Promise<void> {
  await mustRun(
    ctx,
    "wrangler d1 migrations apply",
    ctx.source.wrangler(
      ["d1", "migrations", "apply", "DB", "--remote"],
      ctx.configDir,
    ),
  );
}

/** The D1 ownership marker: written after the migrations created `install_state`. */
export async function writeInstallRow(
  ctx: Ctx,
  s: InstallState,
  d1Id: string,
  version: string,
  schemaDigest: string,
): Promise<void> {
  await ctx.cf.queryD1(
    s.accountId,
    d1Id,
    "INSERT OR REPLACE INTO install_state (installation_id, ownership_nonce, version, manifest_json, updated_at) VALUES (?, ?, ?, ?, ?)",
    [
      s.installationId,
      s.ownershipNonce,
      version,
      JSON.stringify({ schemaDigest }),
      ctx.now().getTime(),
    ],
  );
}

/**
 * Secret names the worker already has. A worker that does not exist yet (`workerIsNew`) makes
 * wrangler exit non-zero: that means none.
 */
export async function existingSecretNames(
  ctx: Ctx,
  worker: string,
  workerIsNew: boolean,
): Promise<string[]> {
  const c = ctx.source.wrangler(
    ["secret", "list", "--name", worker, "--format", "json"],
    ctx.configDir,
  );
  const r = await ctx.runner.run(c.cmd, c.args, { cwd: ctx.configDir });
  if (r.code !== 0) {
    if (workerIsNew) return [];
    throw new Error(
      `wrangler secret list failed (exit ${r.code}):\n${tail(r.stderr || r.stdout)}`,
    );
  }
  try {
    const rows = JSON.parse(r.stdout) as { name: string }[];
    return rows.map((x) => x.name);
  } catch {
    throw new Error("wrangler secret list did not print JSON.");
  }
}

/**
 * The generated secrets the worker lacks (`have`), and the VAPID public key that pairs with its
 * `VAPID_PRIVATE_KEY`. An existing private key keeps its public key (from the state, else the
 * deployed `VAPID_PUBLIC_KEY` var): the pair is never regenerated, and an unknown public key stops.
 */
export async function generatedSecrets(
  ctx: Ctx,
  s: InstallState,
  have: string[],
): Promise<{ secrets: Record<string, string>; vapidPublicKey: string }> {
  const secrets: Record<string, string> = {};
  if (!have.includes("BETTER_AUTH_SECRET"))
    secrets.BETTER_AUTH_SECRET = generateHexSecret();
  if (!have.includes("UNSUBSCRIBE_SECRET"))
    secrets.UNSUBSCRIBE_SECRET = generateHexSecret();
  if (!have.includes("TOKEN_ENCRYPTION_KEY"))
    secrets.TOKEN_ENCRYPTION_KEY = generateEncryptionKey();
  if (!have.includes("VAPID_PRIVATE_KEY")) {
    const pair = generateVapidKeys();
    secrets.VAPID_PRIVATE_KEY = pair.privateKey;
    return { secrets, vapidPublicKey: pair.publicKey };
  }
  if (s.vapidPublicKey) return { secrets, vapidPublicKey: s.vapidPublicKey };
  const vars = await ctx.cf.workerVars(s.accountId, s.names.worker);
  const deployed = vars?.VAPID_PUBLIC_KEY;
  if (deployed) return { secrets, vapidPublicKey: deployed };
  throw new Error(lostVapidMessage(ctx, s));
}

/** The worker has `VAPID_PRIVATE_KEY` but its public key is known nowhere. */
export function lostVapidMessage(ctx: Ctx, s: InstallState): string {
  return (
    `VAPID_PRIVATE_KEY is set but its public key is unknown: it is neither in the state file nor the deployed VAPID_PUBLIC_KEY var of worker ${s.names.worker}. ` +
    `Set VAPID_PUBLIC_KEY (the matching public key) as "vapidPublicKey" in ${join(ctx.dir, `${s.installationId}.json`)}, ` +
    `or delete the secret (${ctx.source.wranglerCommand(`secret delete VAPID_PRIVATE_KEY --name ${s.names.worker}`)}) to have both generated again; existing push subscriptions then stop working.`
  );
}

/** `source.deploy`, with a 0600 secrets file only when there are secrets to send. */
export async function deploy(
  ctx: Ctx,
  secrets: Record<string, string>,
): Promise<void> {
  const what =
    ctx.source.kind === "checkout" ? "yarn deploy" : "wrangler deploy";
  if (Object.keys(secrets).length === 0) {
    await mustRun(ctx, what, ctx.source.deploy(ctx.configDir, null));
    return;
  }
  await withSecretsFile(secrets, (path) =>
    mustRun(ctx, what, ctx.source.deploy(ctx.configDir, path)),
  );
}

export const resumeCommand = (s: InstallState, source: Source) =>
  source.command(`install --resume --name ${s.inputs.name}`);

// 13 tries 5 s apart: 60 s of waiting while a custom domain's certificate is issued.
const VERIFY_TRIES = 13;
const VERIFY_INTERVAL_MS = 5000;

const summarize = (text: string) =>
  text.length > 200 ? `${text.slice(0, 200)}…` : text;

export type SetupStatus = { setupRequired?: boolean; codeRequired?: boolean };

export async function setupStatus(
  ctx: Ctx,
  s: InstallState,
): Promise<SetupStatus> {
  const url = `${s.baseUrl}/api/setup/status`;
  const res = await ctx.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}.`);
  return (await res.json()) as SetupStatus;
}

/**
 * `/.well-known/saasmail` must report this installation at `version` (retried every 5 s for
 * 60 s), then setup must not be open without a code. Returns the setup status. `resume` is the
 * command a failure tells the person to run (default: `install --resume`).
 */
export async function verifyAt(
  ctx: Ctx,
  s: InstallState,
  version: string,
  resume: string = resumeCommand(s, ctx.source),
): Promise<SetupStatus> {
  const url = `${s.baseUrl}/.well-known/saasmail`;
  let last = "";
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await ctx.fetchImpl(url, {
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.text();
      if (res.status === 200) {
        const got = JSON.parse(body) as {
          installationId?: unknown;
          version?: unknown;
        };
        if (got.installationId === s.installationId && got.version === version)
          break;
      }
      last = `HTTP ${res.status}: ${summarize(body)}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (attempt >= VERIFY_TRIES) {
      const cert = s.inputs.hostname
        ? ` A custom domain's certificate can take several minutes to issue; wait, then run: ${resume}`
        : "";
      throw new Error(
        `${url} did not report installation ${s.installationId} at version ${version} within 60 s. Last response: ${last}${cert}`,
      );
    }
    await ctx.sleep(VERIFY_INTERVAL_MS);
  }

  const st = await setupStatus(ctx, s);
  if (st.setupRequired && !st.codeRequired) {
    throw new Error(
      `${s.baseUrl}/api/setup/status reports setup open without a setup code: anyone could claim this instance. Run ${resume}.`,
    );
  }
  return st;
}

/** verifyAt the version last deployed (HEAD's when none is recorded). */
export async function verify(ctx: Ctx, s: InstallState): Promise<void> {
  await verifyAt(
    ctx,
    s,
    s.deployedVersion ?? (await ctx.source.version(ctx.runner)),
  );
}
