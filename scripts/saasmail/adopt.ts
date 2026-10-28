// `saasmail adopt --from <checkout>` (spec §6): moves an install made from a git checkout into the
// package's home (<home>/<slug>/) so `npx saasmail upgrade` can manage it. Files only: no
// Cloudflare call, no deploy.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Io } from "./collect.ts";
import { installDir } from "./home.ts";
import { UsageError } from "./status.ts";
import {
  acquireLock,
  listStates,
  readState,
  statePath,
  writeState,
  type InstallState,
} from "./state.ts";

/** The state `adopt` moves: the one called `name`, or the only one recorded in the checkout. */
export function pickCheckoutState(
  checkout: string,
  name: string | undefined,
): InstallState {
  const dir = join(checkout, ".saasmail");
  const all = listStates(dir);
  if (name !== undefined) {
    const hit = all.find((s) => s.inputs.name === name);
    if (!hit) {
      throw new UsageError(`No saasmail install named ${name} in ${dir}.`);
    }
    return hit;
  }
  if (all.length === 0) {
    throw new UsageError(`No saasmail install in ${dir}.`);
  }
  if (all.length > 1) {
    throw new UsageError(
      `Several installs in ${dir}: ${all.map((s) => s.inputs.name).join(", ")}. Pass --name.`,
    );
  }
  return all[0]!;
}

export async function adoptFromCheckout(o: {
  checkout: string;
  home: string;
  name?: string;
  io: Io;
  now(): Date;
}): Promise<{ slug: string; dir: string }> {
  const checkoutDir = join(o.checkout, ".saasmail");
  const picked = pickCheckoutState(o.checkout, o.name);
  const slug = picked.names.worker;
  const dir = installDir(o.home, slug);
  const configFrom = join(o.checkout, "wrangler.jsonc");
  const configTo = join(dir, "wrangler.jsonc");

  const releaseSource = acquireLock(checkoutDir, picked.installationId);
  let releaseDest: (() => void) | undefined;
  const dirExisted = existsSync(dir);
  let wroteState = false;
  let wroteConfig = false;
  try {
    // Read again under the lock: another run may have changed it since it was picked.
    const s = readState(checkoutDir, picked.installationId);
    if (!s) throw new Error(`The install ${slug} is gone from ${checkoutDir}.`);
    if (s.movedTo !== undefined) {
      throw new Error(`This install already moved to ${s.movedTo}.`);
    }
    if (!existsSync(configFrom)) {
      throw new Error(`${configFrom} is missing: nothing to adopt.`);
    }
    releaseDest = acquireLock(dir, s.installationId);
    if (
      existsSync(statePath(dir, s.installationId)) ||
      listStates(dir).length > 0
    ) {
      throw new Error(`${dir} already has an install.`);
    }

    // Config first, then state (a state file is what makes the directory an install), the
    // checkout's marker last.
    writeFileSync(configTo, readFileSync(configFrom), { mode: 0o600 });
    wroteConfig = true;
    writeState(dir, { ...s, adoptedAt: o.now().toISOString() });
    wroteState = true;
    writeState(checkoutDir, { ...s, movedTo: dir });
  } catch (e) {
    if (wroteState)
      rmSync(statePath(dir, picked.installationId), { force: true });
    if (wroteConfig) rmSync(configTo, { force: true });
    releaseDest?.();
    releaseDest = undefined;
    if (!dirExisted) rmSync(dir, { recursive: true, force: true });
    throw e;
  } finally {
    releaseDest?.();
    releaseSource();
  }
  return { slug, dir };
}
