import { createHash } from "node:crypto";

export interface ResourceNames {
  worker: string;
  d1: string;
  attachments: string;
  queue: string;
  workflow: string;
}

/** An error message, or null when `n` is a usable installation name. */
export function validateName(n: string): string | null {
  if (n.length < 3 || n.length > 30) {
    return "Use 3 to 30 characters.";
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(n)) {
    return "Use lowercase letters, digits and hyphens, starting and ending with a letter or digit.";
  }
  return null;
}

export function resourceNames(n: string): ResourceNames {
  return {
    worker: n,
    d1: `${n}-db`,
    attachments: `${n}-attachments`,
    queue: `${n}-sequence-emails`,
    workflow: `${n}-gmail-backfill`,
  };
}

/** Stable id for one installation: `<name>-<12 hex of sha256(accountId, name, hostname)>`. */
export function installationIdOf(
  accountId: string,
  n: string,
  hostname: string | "workers.dev",
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([accountId, n, hostname]))
    .digest("hex");
  return `${n}-${digest.slice(0, 12)}`;
}
