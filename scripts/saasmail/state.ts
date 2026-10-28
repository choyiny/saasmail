import { randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { ResourceNames } from "./names.ts";

export type Status =
  | "planned"
  | "provisioning"
  | "deploying"
  | "verifying"
  | "installed"
  | "upgrading"
  | "failed";
export type ResourceKind = "worker" | "d1" | "r2" | "queue" | "workflow";

export type Provider =
  | "cloudflare"
  | "resend"
  | "postmark"
  | "bavimail"
  | "none";

export interface Resource {
  key: string;
  kind: ResourceKind;
  name: string;
  id: string;
  ownership: "created" | "adopted";
  state: "ready";
}

export interface InstallState {
  schemaVersion: 1;
  installationId: string;
  ownershipNonce: string;
  accountId: string;
  inputs: {
    name: string;
    hostname: string | null;
    workersDev: boolean;
    /** Zones whose mail Email Routing hands to the worker. */
    inboundDomains: string[];
    provider: Provider;
    /** Email Sending domains (provider `cloudflare`). */
    sendDomains: string[];
    cookiePrefix: string;
  };
  names: ResourceNames;
  status: Status;
  resources: Resource[];
  steps: { key: string; at: string }[];
  baseUrl: string;
  skipped: string[];
  /** sha256 of the wrangler.jsonc text last deployed successfully. */
  deployedConfigHash?: string;
  /** The `SAASMAIL_VERSION` last deployed successfully: what verify expects. */
  deployedVersion?: string;
  /** VAPID public key paired with the `VAPID_PRIVATE_KEY` secret (public, so it may live here). */
  vapidPublicKey?: string;
  /**
   * `VAPID_SUBJECT` as first rendered, kept from then on: later domain changes must not change the
   * deployed config (push services key subscriptions to it, and drift would block resume deploys).
   */
  vapidSubject?: string;
  /** Absolute state dir this installation moved to; this file is then a stub. */
  movedTo?: string;
  adoptedAt?: string;
  upgradedAt?: string;
  /** The version an in-progress upgrade is moving to. */
  upgradeTarget?: string;
}

export type NewStateInput = Pick<
  InstallState,
  "installationId" | "accountId" | "inputs" | "names" | "baseUrl"
>;

export function newState(input: NewStateInput): InstallState {
  return {
    schemaVersion: 1,
    installationId: input.installationId,
    ownershipNonce: randomBytes(32).toString("hex"),
    accountId: input.accountId,
    inputs: input.inputs,
    names: input.names,
    status: "planned",
    resources: [],
    steps: [],
    baseUrl: input.baseUrl,
    skipped: [],
  };
}

const ALLOWED: Record<Status, Status[]> = {
  planned: ["provisioning", "failed"],
  provisioning: ["deploying", "failed"],
  deploying: ["verifying", "provisioning", "failed"],
  verifying: ["installed", "failed"],
  installed: ["upgrading"],
  upgrading: ["installed", "failed"],
  failed: ["provisioning", "deploying", "verifying", "upgrading"],
};

export function transition(s: InstallState, to: Status): InstallState {
  // A run killed mid-phase leaves that status behind; --resume re-enters it.
  if (to === s.status && s.status !== "installed") {
    return s;
  }
  if (!ALLOWED[s.status].includes(to)) {
    throw new Error(`Cannot move from ${s.status} to ${to}`);
  }
  return { ...s, status: to };
}

export function hasStep(s: InstallState, key: string): boolean {
  return s.steps.some((x) => x.key === key);
}

export function recordStep(s: InstallState, key: string): InstallState {
  if (hasStep(s, key)) {
    return s;
  }
  return { ...s, steps: [...s.steps, { key, at: new Date().toISOString() }] };
}

export function recordResource(s: InstallState, r: Resource): InstallState {
  const clash = s.resources.find((x) => x.id === r.id && x.key !== r.key);
  if (clash) {
    throw new Error(
      `Resource id ${r.id} is already recorded under "${clash.key}", not "${r.key}"`,
    );
  }
  return {
    ...s,
    resources: [...s.resources.filter((x) => x.key !== r.key), r],
  };
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function statePath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

function parseState(path: string): InstallState {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as InstallState;
  } catch (e) {
    throw new Error(`State file ${path} is corrupt: ${(e as Error).message}`);
  }
}

export function readState(dir: string, id: string): InstallState | null {
  const p = statePath(dir, id);
  if (!existsSync(p)) {
    return null;
  }
  return parseState(p);
}

export function writeState(dir: string, s: InstallState): void {
  ensureDir(dir);
  const p = statePath(dir, s.installationId);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, p);
}

export function listStates(dir: string): InstallState[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => parseState(join(dir, f)));
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
}

export function acquireLock(
  dir: string,
  id: string,
  opts: { pidAlive?: (pid: number) => boolean } = {},
): () => void {
  ensureDir(dir);
  const pidAlive = opts.pidAlive ?? defaultPidAlive;
  const path = join(dir, `${id}.lock`);
  const me = hostname();
  const info: LockInfo = {
    pid: process.pid,
    host: me,
    startedAt: new Date().toISOString(),
  };
  const heldMessage = (h: LockInfo) =>
    `Another saasmail run is using this installation (pid ${h.pid} on ${h.host}).`;

  // The lock file appears only fully written: write a private file, then link it into place.
  const tryCreate = (): boolean => {
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
    try {
      linkSync(tmp, path);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw e;
    } finally {
      unlinkSync(tmp);
    }
  };

  for (let attempt = 0; attempt < 10; attempt++) {
    if (tryCreate()) {
      return () => {
        try {
          const h = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
          if (
            h.pid === info.pid &&
            h.host === info.host &&
            h.startedAt === info.startedAt
          ) {
            unlinkSync(path);
          }
        } catch {
          // gone or not ours
        }
      };
    }
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw e;
    }
    let held: LockInfo;
    try {
      held = JSON.parse(raw) as LockInfo;
    } catch {
      throw new Error(
        `Another saasmail run is using this installation (lock file ${path} is unreadable). ` +
          "If that run is gone, delete the file.",
      );
    }
    if (!(held.host === me && !pidAlive(held.pid))) {
      throw new Error(heldMessage(held));
    }
    // Stale. Move it aside (only one reclaimer wins the rename), then confirm what we moved.
    const aside = `${path}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
    try {
      renameSync(path, aside);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw e;
    }
    if (readFileSync(aside, "utf8") === raw) {
      unlinkSync(aside);
      continue;
    }
    // We moved a different (live) lock: put it back if the slot is free.
    try {
      linkSync(aside, path);
    } catch {
      // someone else took the slot meanwhile; they hold it
    }
    unlinkSync(aside);
    continue;
  }
  throw new Error("Could not acquire the installation lock; try again.");
}
