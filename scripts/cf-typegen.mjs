#!/usr/bin/env node
/**
 * Regenerate worker-configuration.d.ts from wrangler.jsonc.ci so the tracked
 * types file only reflects placeholder CI values — not whatever is in the
 * deployer's local (gitignored) wrangler.jsonc.
 *
 * Implementation: `wrangler types --config` has a bug where the runtime-
 * types phase still looks for wrangler.jsonc in the cwd. To work around it
 * we swap the CI config into place, run wrangler types, then restore the
 * local file if there was one. A crash would leave the original at
 * .wrangler.jsonc.local-backup for manual recovery.
 */
import {
  copyFileSync,
  existsSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";

const LOCAL = "wrangler.jsonc";
const CI = "wrangler.jsonc.ci";
const BACKUP = ".wrangler.jsonc.local-backup";

if (!existsSync(CI)) {
  console.error(`cf-typegen: ${CI} is missing`);
  process.exit(1);
}
if (existsSync(BACKUP)) {
  console.error(
    `cf-typegen: ${BACKUP} already exists — a previous run crashed. ` +
      `Resolve manually (inspect the file, then restore it to ${LOCAL} or delete it) before retrying.`,
  );
  process.exit(1);
}

const hadLocal = existsSync(LOCAL);
if (hadLocal) renameSync(LOCAL, BACKUP);

let exitCode = 0;
try {
  copyFileSync(CI, LOCAL);
  const result = spawnSync("npx", ["wrangler", "types"], {
    stdio: "inherit",
  });
  exitCode = result.status ?? 1;
} finally {
  if (hadLocal) {
    renameSync(BACKUP, LOCAL);
  } else if (existsSync(LOCAL)) {
    unlinkSync(LOCAL);
  }
}

process.exit(exitCode);
