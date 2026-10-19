// Builds the npm package `saasmail` into a directory (default build/npm):
//   node scripts/saasmail/pack.mjs [--out build/npm] [--version <semver>]
// Plain JavaScript so it runs on any Node 22. Leaves no tracked changes: the build reads a
// placeholder config through SAASMAIL_BUILD_CONFIG and writes under build/ (gitignored).
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The package.json written into the package. */
export function npmManifest({ version, commit, wranglerVersion }) {
  return {
    name: "saasmail",
    version,
    description:
      "Install, upgrade and adopt a saasmail deployment on Cloudflare.",
    license: "Apache-2.0",
    type: "module",
    bin: { saasmail: "bin/saasmail.js" },
    engines: { node: ">=22.0.0" },
    dependencies: { wrangler: wranglerVersion },
    saasmailCommit: commit,
    repository: {
      type: "git",
      url: "git+https://github.com/choyiny/saasmail.git",
    },
    files: [
      "bin",
      "worker",
      "client",
      "migrations",
      "wrangler.jsonc.example",
      "README.md",
      "LICENSE",
    ],
  };
}

// The worker's module-loading keys the deploy needs (see MODULE_KEYS in source.ts). Path-valued
// keys must never ship: they would resolve against the user's config, not the package.
const MODULE_KEYS = ["no_bundle", "rules", "find_additional_modules"];
const PATH_KEYS = ["base_dir"];
// What the Cloudflare Vite plugin writes for the worker; anything else would be silently dropped.
const WORKER_ENTRIES = new Set([
  "index.js",
  "assets",
  "wrangler.json",
  ".vite",
]);

function parseArgs(argv) {
  const o = { out: "build/npm", version: "0.0.0-dev" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--out" || a === "--version") && argv[i + 1]) {
      o[a.slice(2)] = argv[++i];
    } else {
      throw new Error(
        `Unknown argument ${a}. Usage: pack.mjs [--out build/npm] [--version <semver>]`,
      );
    }
  }
  return o;
}

/** A copy of wrangler.jsonc.ci under build/, with its paths made absolute (the plugin needs a .jsonc). */
async function writeBuildConfig(path) {
  const { applyEdits, modify, parse } = await import("jsonc-parser");
  let text = readFileSync(join(ROOT, "wrangler.jsonc.ci"), "utf8");
  const c = parse(text);
  const abs = (p) => (isAbsolute(p) ? p : join(ROOT, p));
  const set = (path, value) => {
    text = applyEdits(text, modify(text, path, value, {}));
  };
  set(["main"], abs(c.main));
  if (c.assets?.directory)
    set(["assets", "directory"], abs(c.assets.directory));
  writeFileSync(path, text);
}

/** Runs `yarn -s build` into `outDir`, restoring the deploy redirect the plugin leaves behind. */
function viteBuild(configPath, outDir) {
  // The plugin points .wrangler/deploy/config.json at its output; left pointing at the placeholder
  // build, a maintainer's next `yarn wrangler ...` without --config would read it.
  const redirect = join(ROOT, ".wrangler", "deploy", "config.json");
  let before = null;
  try {
    before = readFileSync(redirect);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  try {
    execFileSync("yarn", ["-s", "build", "--outDir", outDir], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, SAASMAIL_BUILD_CONFIG: configPath },
    });
  } finally {
    if (before) writeFileSync(redirect, before);
    else rmSync(redirect, { force: true });
  }
}

function workerBuildDir(viteOut) {
  const dirs = readdirSync(viteOut).filter(
    (d) => d !== "client" && existsSync(join(viteOut, d, "wrangler.json")),
  );
  if (dirs.length !== 1) {
    throw new Error(
      `Expected one worker build in ${viteOut}, found ${dirs.length}: ${dirs.join(", ")}`,
    );
  }
  return join(viteOut, dirs[0]);
}

export async function pack(argv) {
  const { out: outArg, version } = parseArgs(argv);
  const out = resolve(outArg);
  const work = join(ROOT, "build");
  const viteOut = join(work, "vite");
  const buildConfig = join(work, "wrangler.build.jsonc");

  rmSync(out, { recursive: true, force: true });
  rmSync(viteOut, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  // (1) Build the worker and client from the placeholder config.
  await writeBuildConfig(buildConfig);
  viteBuild(buildConfig, viteOut);

  // (2) Worker bundle, its module config, and the client assets.
  const workerDir = workerBuildDir(viteOut);
  const unexpected = readdirSync(workerDir).filter(
    (e) => !WORKER_ENTRIES.has(e),
  );
  if (unexpected.length) {
    throw new Error(
      `Unexpected files in the worker build ${workerDir}: ${unexpected.join(", ")}`,
    );
  }
  const built = JSON.parse(
    readFileSync(join(workerDir, "wrangler.json"), "utf8"),
  );
  for (const k of PATH_KEYS) {
    if (k in built) {
      throw new Error(
        `The worker build's wrangler.json sets ${k} (${JSON.stringify(built[k])}). ` +
          `A path cannot ship in worker/build.json; change the build so it does not set ${k}.`,
      );
    }
  }
  const buildJson = {};
  for (const k of MODULE_KEYS) if (k in built) buildJson[k] = built[k];
  mkdirSync(join(out, "worker"), { recursive: true });
  cpSync(join(workerDir, "index.js"), join(out, "worker", "index.js"));
  if (existsSync(join(workerDir, "assets"))) {
    cpSync(join(workerDir, "assets"), join(out, "worker", "assets"), {
      recursive: true,
    });
  }
  writeFileSync(
    join(out, "worker", "build.json"),
    JSON.stringify(buildJson, null, 2) + "\n",
  );
  cpSync(join(viteOut, "client"), join(out, "client"), { recursive: true });

  // (3) Migrations, the config template, the licence and the package README.
  mkdirSync(join(out, "migrations"), { recursive: true });
  for (const f of readdirSync(join(ROOT, "migrations"))) {
    if (f.endsWith(".sql")) {
      cpSync(join(ROOT, "migrations", f), join(out, "migrations", f));
    }
  }
  if (existsSync(join(ROOT, "migrations", "meta"))) {
    cpSync(join(ROOT, "migrations", "meta"), join(out, "migrations", "meta"), {
      recursive: true,
    });
  }
  cpSync(
    join(ROOT, "wrangler.jsonc.example"),
    join(out, "wrangler.jsonc.example"),
  );
  cpSync(join(ROOT, "LICENSE"), join(out, "LICENSE"));
  cpSync(
    join(ROOT, "scripts", "saasmail", "npm-README.md"),
    join(out, "README.md"),
  );

  // (4) The installer, bundled to plain JavaScript (no type stripping needed at run time).
  const { build } = await import("esbuild");
  const bin = join(out, "bin", "saasmail.js");
  await build({
    entryPoints: [join(ROOT, "scripts", "saasmail", "cli.ts")],
    outfile: bin,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["wrangler"],
    // Prefer ESM builds: jsonc-parser's `main` is a UMD bundle whose relative require()s cannot be
    // bundled.
    mainFields: ["module", "main"],
    define: { __SAASMAIL_PACKAGE_ROOT__: '"bundled"' },
    // Bundled CommonJS dependencies call require(); ESM has none. Aliased so it cannot clash with
    // the bundle's own `createRequire` import.
    banner: {
      js: [
        "#!/usr/bin/env node",
        'import { createRequire as __saasmailCreateRequire } from "node:module";',
        "const require = __saasmailCreateRequire(import.meta.url);",
      ].join("\n"),
    },
    logLevel: "warning",
  });
  chmodSync(bin, 0o755);

  // (5) package.json.
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT })
    .toString()
    .trim();
  const wranglerVersion = JSON.parse(
    readFileSync(
      createRequire(join(ROOT, "package.json")).resolve(
        "wrangler/package.json",
      ),
      "utf8",
    ),
  ).version;
  writeFileSync(
    join(out, "package.json"),
    JSON.stringify(npmManifest({ version, commit, wranglerVersion }), null, 2) +
      "\n",
  );
  console.log(`Packed saasmail ${version} (${commit.slice(0, 12)}) in ${out}`);
}

const isMain =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) ===
    realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    await pack(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
