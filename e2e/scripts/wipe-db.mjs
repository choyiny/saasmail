// e2e/scripts/wipe-db.mjs
// Run BEFORE `playwright test` so the dev server starts against a clean DB.
// Usage: node e2e/scripts/wipe-db.mjs
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

function getDbName() {
  const raw = readFileSync(resolve(REPO_ROOT, "wrangler.jsonc"), "utf-8");
  const match = raw.match(/"database_name"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? "saasmail-db";
}

const dbName = getDbName();
console.log(`[wipe-db] Using database: ${dbName}`);

execSync(`rm -rf .wrangler/state/v3/d1`, { cwd: REPO_ROOT, stdio: "inherit" });
console.log(`[wipe-db] Cleared .wrangler/state/v3/d1`);

execSync(`wrangler d1 migrations apply ${dbName} --local`, {
  cwd: REPO_ROOT,
  stdio: "inherit",
});
console.log(`[wipe-db] Migrations applied`);

execSync(`wrangler d1 execute ${dbName} --local --file=seeds/e2e.sql`, {
  cwd: REPO_ROOT,
  stdio: "inherit",
});
console.log(`[wipe-db] Seed applied`);
