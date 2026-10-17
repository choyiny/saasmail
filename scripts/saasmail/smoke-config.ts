// CI smoke helper: writes the wrangler.jsonc an install of a packed package would deploy with.
//   node scripts/saasmail/smoke-config.ts <package dir> <out dir>
// It uses the real generateWranglerConfig and the package's own build paths, so a dry-run deploy
// of <out dir>/wrangler.jsonc proves the shipped build deploys from a generated config (not the
// config it was built with).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateWranglerConfig } from "./config.ts";
import { resourceNames } from "./names.ts";
import { packageSource } from "./source.ts";
import { newState } from "./state.ts";

const [pkgArg, outArg] = process.argv.slice(2);
if (!pkgArg || !outArg) {
  console.error(
    "Usage: node scripts/saasmail/smoke-config.ts <package dir> <out dir>",
  );
  process.exit(2);
}
const pkgDir = resolve(pkgArg);
const outDir = resolve(outArg);
const source = packageSource(pkgDir);

const state = newState({
  installationId: "smoke-1a2b3c4d5e6f",
  accountId: "a".repeat(32),
  inputs: {
    name: "smoke",
    hostname: null,
    workersDev: true,
    inboundDomains: [],
    provider: "none",
    sendDomains: [],
    cookiePrefix: "smoke",
  },
  names: resourceNames("smoke"),
  baseUrl: "https://smoke.example.workers.dev",
});
state.resources.push({
  key: "d1",
  kind: "d1",
  name: "smoke-db",
  id: "00000000-0000-0000-0000-000000000001",
  ownership: "created",
  state: "ready",
});

const text = generateWranglerConfig(
  readFileSync(source.templatePath, "utf8"),
  state,
  {
    version: (
      JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
        version: string;
      }
    ).version,
    existing: null,
    command: source.command("install"),
    build: source.build,
  },
);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "wrangler.jsonc"), text);
console.log(`Wrote ${join(outDir, "wrangler.jsonc")}`);
