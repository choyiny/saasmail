// `saasmail status`: prints the recorded state and asks the deployed worker who it is, once.
// Read-only: no Cloudflare API call, no subprocess, no file written.
import type { Io } from "./collect.ts";
import type { Source } from "./source.ts";
import { listStates, type InstallState } from "./state.ts";
import { compareSemver } from "./versions.ts";

export type StatusDeps = {
  io: Io;
  dir: string;
  fetchImpl: typeof fetch;
  source: Source;
  /** The newest release on npm; null when it cannot be read. */
  latest(): Promise<string | null>;
};

export class UsageError extends Error {}

/** The state for `--name`, or the only one in `dir`; null when there is none. */
export function findState(dir: string, name?: string): InstallState | null {
  const all = listStates(dir);
  if (name !== undefined) {
    return all.find((s) => s.inputs.name === name) ?? null;
  }
  if (all.length > 1) {
    throw new UsageError(
      `More than one installation is recorded in ${dir} (${all.map((s) => s.inputs.name).join(", ")}): pass --name.`,
    );
  }
  return all[0] ?? null;
}

const list = (xs: string[]) => (xs.length > 0 ? xs.join(", ") : "(none)");

const SEMVER_ONLY =
  /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function describeState(
  s: InstallState,
  latest?: { version: string | null; upgrade: string },
): string {
  const kw = Math.max(0, ...s.resources.map((r) => r.kind.length));
  const nw = Math.max(0, ...s.resources.map((r) => r.name.length));
  const i = s.inputs;
  const lines = [
    `Installation  ${s.installationId} (${i.name})`,
    `Status        ${s.status}`,
    `URL           ${s.baseUrl}`,
    `Account       ${s.accountId}`,
    `Inbound       ${list(i.inboundDomains)}`,
    `Provider      ${i.provider}`,
  ];
  if (s.movedTo !== undefined) lines.splice(2, 0, `Moved         ${s.movedTo}`);
  if (i.provider === "cloudflare") {
    lines.push(`Send          ${list(i.sendDomains)}`);
  }
  lines.push(
    `Cookie prefix ${i.cookiePrefix}`,
    `Steps         ${s.steps.length} recorded`,
    `Version       ${s.deployedVersion ?? "(not deployed yet)"}`,
  );
  if (latest) {
    const running = s.deployedVersion;
    const older =
      latest.version !== null &&
      running !== undefined &&
      SEMVER_ONLY.test(running) &&
      compareSemver(running, latest.version) < 0;
    lines.push(
      `Latest        ${latest.version ?? "unknown"}${older ? `  (${latest.upgrade})` : ""}`,
    );
  }
  if (s.skipped.length > 0) {
    lines.push(`Skipped       ${s.skipped.join(", ")}`);
  }
  lines.push("", "Resources");
  if (s.resources.length === 0) lines.push("  (none recorded)");
  for (const r of s.resources) {
    lines.push(`  ${r.kind.padEnd(kw)}  ${r.name.padEnd(nw)}  ${r.id}`);
  }
  return lines.join("\n");
}

/**
 * The command that moves this install to `latest`: always npx at that version (this package's own
 * version would redeploy the same release). upgrade runs only on installs under ~/.saasmail
 * (ruling P2), so an install still in a checkout is pointed at the fork update path instead.
 */
export function upgradeHint(
  s: InstallState,
  latest: string | null,
  where: { slug?: string; checkout?: string },
): string {
  if (where.checkout !== undefined && s.movedTo === undefined)
    return "update this checkout with git: see docs/updating.md#forks-and-modified-code";
  const npx = `npx saasmail@${latest ?? "latest"}`;
  return `${npx} upgrade --name ${where.slug ?? s.inputs.name}`;
}

export async function status(
  opts: { name?: string; slug?: string },
  deps: StatusDeps,
): Promise<number> {
  const { io } = deps;
  let s: InstallState | null;
  try {
    s = findState(deps.dir, opts.name);
  } catch (e) {
    io.print((e as Error).message);
    return e instanceof UsageError ? 2 : 1;
  }
  if (!s) {
    io.print(
      opts.name === undefined
        ? `No installation found in ${deps.dir}. Install one with: ${deps.source.command("install")}`
        : `No installation named ${opts.name} found in ${deps.dir}.`,
    );
    return 1;
  }
  const latest = await deps.latest();
  io.print(
    describeState(s, {
      version: latest,
      upgrade: upgradeHint(s, latest, {
        slug: opts.slug,
        checkout:
          deps.source.kind === "checkout" ? deps.source.root : undefined,
      }),
    }),
  );

  const url = `${s.baseUrl}/.well-known/saasmail`;
  let got: { installationId?: unknown; version?: unknown };
  try {
    const res = await deps.fetchImpl(url, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      io.print(`\nUnexpected answer from ${url}`);
      return 1;
    }
    got = body as typeof got;
  } catch (e) {
    io.print(
      `\nCould not reach ${url}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }
  const idOk = got.installationId === s.installationId;
  const versionOk =
    s.deployedVersion === undefined || got.version === s.deployedVersion;
  const seen = `installation ${String(got.installationId)}, version ${String(got.version)}`;
  if (idOk && versionOk) {
    io.print(`\nLive          ${seen} (matches)`);
    return 0;
  }
  io.print(
    `\n${url} reports ${seen}, but the state records installation ${s.installationId}` +
      (s.deployedVersion ? `, version ${s.deployedVersion}` : "") +
      ".",
  );
  return 1;
}
