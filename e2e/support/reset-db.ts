// e2e/support/reset-db.ts
import { execSync } from "node:child_process";

// Playwright always runs tests from the repo root, so process.cwd() is reliable.
const REPO_ROOT = process.cwd();

/**
 * Full reset: drop local D1 state, re-apply migrations, seed SQL.
 * Only safe to call BEFORE the dev server is running (else miniflare holds file locks).
 * Used by globalSetup.
 */
export function wipeAndSeed(): void {
  // Delete the local miniflare D1 state. Matches `wrangler dev --local` default location.
  execSync(`rm -rf .wrangler/state/v3/d1/miniflare-D1DatabaseObject`, {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });

  execSync(`wrangler d1 migrations apply saasmail-db --local`, {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });

  execSync(`wrangler d1 execute saasmail-db --local --file=seeds/e2e.sql`, {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}

/**
 * Soft reset: re-runs seeds/e2e.sql (which DELETEs then INSERTs) against the
 * live miniflare instance. Safe while the dev server is running.
 * Used by each spec file's beforeAll.
 */
export function truncateAndReseed(): void {
  execSync(`wrangler d1 execute saasmail-db --local --file=seeds/e2e.sql`, {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
}
