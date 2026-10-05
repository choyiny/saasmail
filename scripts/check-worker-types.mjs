#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const baselinePath = path.join(root, "scripts", "worker-tsc-baseline.json");
const update = process.argv.includes("--update");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--update");

if (unknownArgs.length > 0) {
  console.error(`Unknown argument(s): ${unknownArgs.join(", ")}`);
  process.exit(1);
}

const tscPath = path.join(root, "node_modules", "typescript", "bin", "tsc");
const result = spawnSync(
  process.execPath,
  [tscPath, "-p", "worker/tsconfig.json", "--noEmit", "--pretty", "false"],
  {
    cwd: root,
    encoding: "utf8",
  },
);

if (result.error) {
  throw result.error;
}

const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
const counts = new Map();
const unmatchedDiagnostics = [];

for (const line of output.split(/\r?\n/)) {
  if (!line.includes("error TS")) continue;
  const match = line.match(/^(.+?)\(\d+,\d+\): error TS\d+:/);
  if (!match) {
    unmatchedDiagnostics.push(line);
    continue;
  }

  let file = match[1].replaceAll("\\", "/");
  if (path.isAbsolute(file)) {
    file = path.relative(root, file).replaceAll("\\", "/");
  }
  if (file.startsWith("./")) file = file.slice(2);
  counts.set(file, (counts.get(file) ?? 0) + 1);
}

if (unmatchedDiagnostics.length > 0) {
  console.error(
    "Worker typecheck produced diagnostics that cannot be ratcheted:",
  );
  for (const line of unmatchedDiagnostics) console.error(`  ${line}`);
  process.exit(1);
}

if ((result.status ?? 1) !== 0 && counts.size === 0) {
  console.error(
    "Worker typecheck failed without file-scoped TypeScript errors.",
  );
  if (output.trim()) console.error(output.trim());
  process.exit(1);
}

const sortedCounts = Object.fromEntries(
  [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)),
);

if (update) {
  writeFileSync(
    baselinePath,
    `${JSON.stringify(sortedCounts, null, 2)}\n`,
    "utf8",
  );
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  console.log(
    `Updated worker TypeScript baseline: ${total} errors across ${counts.size} files.`,
  );
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
} catch (error) {
  console.error("Unable to read scripts/worker-tsc-baseline.json.");
  throw error;
}

const regressions = [];
const improvements = [];

for (const [file, count] of counts) {
  const allowed = baseline[file];
  if (allowed === undefined) {
    regressions.push(`${file}: ${count} new error${count === 1 ? "" : "s"}`);
    continue;
  }
  if (!Number.isInteger(allowed) || allowed < 0) {
    console.error(`Invalid baseline count for ${file}: ${String(allowed)}`);
    process.exit(1);
  }
  if (count > allowed) {
    regressions.push(`${file}: ${allowed} -> ${count}`);
  } else if (count < allowed) {
    improvements.push(`${file}: ${allowed} -> ${count}`);
  }
}

for (const [file, allowed] of Object.entries(baseline)) {
  if (!Number.isInteger(allowed) || allowed < 0) {
    console.error(`Invalid baseline count for ${file}: ${String(allowed)}`);
    process.exit(1);
  }
  if (!counts.has(file) && allowed > 0) {
    improvements.push(`${file}: ${allowed} -> 0`);
  }
}

const currentTotal = [...counts.values()].reduce(
  (sum, count) => sum + count,
  0,
);
const baselineTotal = Object.values(baseline).reduce(
  (sum, count) => sum + count,
  0,
);

console.log(
  `Worker TypeScript ratchet: ${currentTotal} current errors; ${baselineTotal} baseline errors.`,
);

if (improvements.length > 0) {
  console.log("Worker TypeScript improvements:");
  for (const improvement of improvements.sort()) {
    console.log(`  ${improvement}`);
  }
}

if (regressions.length > 0) {
  console.error("Worker TypeScript regressions:");
  for (const regression of regressions.sort()) {
    console.error(`  ${regression}`);
  }
  process.exit(1);
}

console.log("Worker TypeScript ratchet passed.");
