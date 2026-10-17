// Package mode keeps every installation under ~/.saasmail/<slug>/ (state, lock, generated wrangler.jsonc).
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UsageError } from "./status.ts";
import { listStates, type InstallState } from "./state.ts";

/** `SAASMAIL_HOME`, else `~/.saasmail`. */
export function saasmailHome(env: Record<string, string | undefined>): string {
  return env.SAASMAIL_HOME || join(homedir(), ".saasmail");
}

export function installDir(home: string, slug: string): string {
  return join(home, slug);
}

/** Each subdirectory of `home` holding exactly one state file. Read-only. */
export function listInstalls(
  home: string,
): { slug: string; state: InstallState }[] {
  if (!existsSync(home)) return [];
  const out: { slug: string; state: InstallState }[] = [];
  for (const e of readdirSync(home, { withFileTypes: true })) {
    if (!e.isDirectory()) continue; // files, dangling symlinks
    const states = listStates(join(home, e.name));
    if (states.length === 1) out.push({ slug: e.name, state: states[0]! });
  }
  out.sort((a, b) => (a.slug < b.slug ? -1 : 1));
  return out;
}

/** The install called `name`, or the only one when no name is given. */
export function pickInstall(
  home: string,
  name: string | undefined,
): { slug: string; state: InstallState } {
  const all = listInstalls(home);
  if (name !== undefined) {
    const hit = all.find((i) => i.slug === name);
    if (!hit)
      throw new UsageError(`No saasmail install named ${name} in ${home}.`);
    return hit;
  }
  if (all.length === 0) throw new UsageError(`No saasmail install in ${home}.`);
  if (all.length > 1) {
    throw new UsageError(several(all));
  }
  return all[0]!;
}

const several = (xs: { slug: string }[]) =>
  `Several installs: ${xs.map((i) => i.slug).join(", ")}. Pass --name.`;

/**
 * The install `install --resume` continues: `name`, else the only unfinished one (or, with none
 * unfinished, the only install). Never a directory outside an install.
 */
export function pickResumable(
  home: string,
  name: string | undefined,
): { slug: string; state: InstallState } {
  const all = listInstalls(home);
  if (name !== undefined) {
    const hit = all.find((i) => i.slug === name);
    if (!hit)
      throw new UsageError(`No saasmail install named ${name} in ${home}.`);
    return hit;
  }
  const unfinished = all.filter((i) => i.state.status !== "installed");
  const candidates = unfinished.length > 0 ? unfinished : all;
  if (candidates.length === 0)
    throw new UsageError(`No saasmail install to resume in ${home}.`);
  if (candidates.length > 1) throw new UsageError(several(candidates));
  return candidates[0]!;
}
