import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Runner } from "./runner.ts";

export type BuildPaths = {
  main: string; // <root>/worker/index.js
  assetsDir: string; // <root>/client
  migrationsDir: string; // <root>/migrations
  /** Module-loading keys copied from the build's wrangler.json (no_bundle, rules, find_additional_modules, if present). */
  moduleConfig: Record<string, unknown>;
};

export type Source = {
  kind: "checkout" | "package";
  /** Checkout root, or the package root. */
  root: string;
  templatePath: string; // <root>/wrangler.jsonc.example
  migrationsDir: string; // <root>/migrations
  /** Running version: checkout = buildVersion (git sha[-dirty]); package = package.json version. */
  version(runner: Runner): Promise<string>;
  /** Package only: the commit the package was built from (package.json `saasmailCommit`). */
  commit: string | null;
  /** Package only: absolute paths written into the generated config. */
  build: BuildPaths | null;
  /** How to run wrangler with `args`, for a config in `configDir`. */
  wrangler(args: string[], configDir: string): { cmd: string; args: string[] };
  /** How to run a wrangler command that reads no config (`auth token`): never passes `--config`. */
  wranglerBare(args: string[]): { cmd: string; args: string[] };
  /** A printed wrangler command line: `yarn wrangler <args>` or `npx wrangler@<version> <args>`. */
  wranglerCommand(args: string): string;
  /** The deploy command (checkout: `yarn -s deploy`, which builds; package: wrangler deploy, no build). */
  deploy(
    configDir: string,
    secretsFile: string | null,
  ): { cmd: string; args: string[] };
  /** A printed command line: `yarn saasmail <args>` or `npx saasmail@<version> <args>`. */
  command(args: string): string;
};

async function git(runner: Runner, root: string, args: string[]) {
  const r = await runner.run("git", args, { cwd: root });
  if (r.code !== 0) {
    const out = (r.stderr || r.stdout).trim().split("\n").slice(-10).join("\n");
    throw new Error(
      `git ${args[0]} failed (exit ${r.code})${out ? `:\n${out}` : "."}`,
    );
  }
  return r.stdout;
}

/** `git rev-parse --short=12 HEAD`, plus `-dirty` with uncommitted changes: what verify expects. */
export function checkoutSource(root: string): Source {
  return {
    kind: "checkout",
    root,
    templatePath: join(root, "wrangler.jsonc.example"),
    migrationsDir: join(root, "migrations"),
    async version(runner) {
      const sha = (
        await git(runner, root, ["rev-parse", "--short=12", "HEAD"])
      ).trim();
      const status = await git(runner, root, ["status", "--porcelain"]);
      return status.trim() ? `${sha}-dirty` : sha;
    },
    commit: null,
    build: null,
    wrangler: (args) => ({ cmd: "yarn", args: ["-s", "wrangler", ...args] }),
    wranglerBare: (args) => ({
      cmd: "yarn",
      args: ["-s", "wrangler", ...args],
    }),
    wranglerCommand: (args) => `yarn wrangler ${args}`,
    deploy: (_configDir, secretsFile) => ({
      cmd: "yarn",
      args: [
        "-s",
        "deploy",
        ...(secretsFile ? ["--secrets-file", secretsFile] : []),
      ],
    }),
    command: (args) => `yarn saasmail ${args}`,
  };
}

// Path-valued keys (base_dir) never ship: pack.mjs refuses them (they would resolve against the
// user's config, not the package).
const MODULE_KEYS = ["no_bundle", "rules", "find_additional_modules"];

export function packageSource(root: string): Source {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
    saasmailCommit?: string;
  };
  const buildJson = JSON.parse(
    readFileSync(join(root, "worker", "build.json"), "utf8"),
  ) as Record<string, unknown>;
  const moduleConfig: Record<string, unknown> = {};
  for (const k of MODULE_KEYS)
    if (k in buildJson) moduleConfig[k] = buildJson[k];

  // Resolved from the package, so a hoisted install (wrangler beside it, as npx does) works too.
  const wranglerPkgPath = createRequire(join(root, "package.json")).resolve(
    "wrangler/package.json",
  );
  const wranglerPkg = JSON.parse(readFileSync(wranglerPkgPath, "utf8")) as {
    version: string;
    bin: string | Record<string, string>;
  };
  const rel =
    typeof wranglerPkg.bin === "string"
      ? wranglerPkg.bin
      : wranglerPkg.bin.wrangler;
  const wranglerBin = join(dirname(wranglerPkgPath), rel);
  const configArgs = (configDir: string) => [
    "--config",
    join(configDir, "wrangler.jsonc"),
  ];

  return {
    kind: "package",
    root,
    templatePath: join(root, "wrangler.jsonc.example"),
    migrationsDir: join(root, "migrations"),
    version: async () => pkg.version,
    commit: pkg.saasmailCommit ?? null,
    build: {
      main: join(root, "worker", "index.js"),
      assetsDir: join(root, "client"),
      migrationsDir: join(root, "migrations"),
      moduleConfig,
    },
    wrangler: (args, configDir) => ({
      cmd: process.execPath,
      args: [wranglerBin, ...args, ...configArgs(configDir)],
    }),
    // An explicit --config that does not exist is a hard error in wrangler, even for `auth token`.
    wranglerBare: (args) => ({
      cmd: process.execPath,
      args: [wranglerBin, ...args],
    }),
    wranglerCommand: (args) => `npx wrangler@${wranglerPkg.version} ${args}`,
    deploy: (configDir, secretsFile) => ({
      cmd: process.execPath,
      args: [
        wranglerBin,
        "deploy",
        ...configArgs(configDir),
        ...(secretsFile ? ["--secrets-file", secretsFile] : []),
      ],
    }),
    command: (args) => `npx saasmail@${pkg.version} ${args}`,
  };
}
