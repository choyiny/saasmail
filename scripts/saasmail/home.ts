// Package mode keeps every installation under ~/.saasmail/<slug>/ (state, lock, generated wrangler.jsonc).
import { existsSync, readdirSync, statSync } from "node:fs";
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
  for (const slug of readdirSync(home).sort()) {
    const dir = join(home, slug);
    if (!statSync(dir).isDirectory()) continue;
    const states = listStates(dir);
    if (states.length === 1) out.push({ slug, state: states[0]! });
  }
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
    throw new UsageError(
      `Several installs: ${all.map((i) => i.slug).join(", ")}. Pass --name.`,
    );
  }
  return all[0]!;
}
