#!/usr/bin/env node

// Checks that migrations/ is one chain wrangler and drizzle-kit agree on:
// one .sql file per 4-digit number, every file in _journal.json and every
// entry on disk, journal idx 0..n-1 in order, and each snapshot's prevId
// equal to the previous snapshot's id. An upstream migration file that
// survives a merge shares a number with the fork's and fails the first check.
// See docs/updating.md#upstream-migrations.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const migrationsDir = path.join(root, "migrations");
const metaDir = path.join(migrationsDir, "meta");
const unknownArgs = process.argv.slice(2);

if (unknownArgs.length > 0) {
  console.error(`Unknown argument(s): ${unknownArgs.join(", ")}`);
  process.exit(1);
}

// Pairs (file -> journal tag) that differ on purpose. 0027's file was
// renamed after it shipped (upstream #142) while its journal entry kept the
// old tag; wrangler tracks applied migrations by file name, so renaming the
// file back would run 0027 again on every database. Nothing else goes here.
const KNOWN_TAG_MISMATCHES = new Map([
  ["0027_strong_thena.sql", "0027_sad_moonstone"],
]);

const problems = [];

const sqlFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

const byNumber = new Map();
for (const name of sqlFiles) {
  const match = name.match(/^(\d{4})_/);
  if (!match) {
    problems.push(`${name}: name does not start with a 4-digit number`);
    continue;
  }
  const files = byNumber.get(match[1]) ?? [];
  files.push(name);
  byNumber.set(match[1], files);
}
for (const [number, files] of byNumber) {
  if (files.length > 1) {
    problems.push(`${number}: ${files.length} files (${files.join(", ")})`);
  }
}

let journal;
try {
  journal = JSON.parse(
    readFileSync(path.join(metaDir, "_journal.json"), "utf8"),
  );
} catch (error) {
  console.error("Unable to read migrations/meta/_journal.json.");
  throw error;
}
const entries = Array.isArray(journal.entries) ? journal.entries : [];

const tags = new Set(entries.map((entry) => entry.tag));
const tagOf = (name) =>
  KNOWN_TAG_MISMATCHES.get(name) ?? name.slice(0, -".sql".length);
for (const name of sqlFiles) {
  if (!tags.has(tagOf(name))) {
    problems.push(`${name}: no _journal.json entry`);
  }
}
const sqlSet = new Set(sqlFiles.map((name) => `${tagOf(name)}.sql`));
entries.forEach((entry, index) => {
  if (entry.idx !== index) {
    problems.push(
      `_journal.json entry ${index} (${entry.tag}): idx is ${String(entry.idx)}, expected ${index}`,
    );
  }
  if (!sqlSet.has(`${entry.tag}.sql`)) {
    problems.push(`_journal.json entry ${entry.tag}: no ${entry.tag}.sql`);
  }
});

function readSnapshot(tag) {
  const file = path.join(metaDir, `${tag.slice(0, 4)}_snapshot.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

// Data-only steps can lack a snapshot: a pair with a missing file is skipped.
for (let index = 1; index < entries.length; index += 1) {
  const previous = readSnapshot(entries[index - 1].tag);
  const current = readSnapshot(entries[index].tag);
  if (!previous || !current) continue;
  if (current.prevId !== previous.id) {
    problems.push(
      `${entries[index].tag}: snapshot prevId ${String(current.prevId)} is not ${entries[index - 1].tag}'s id ${String(previous.id)}`,
    );
  }
}

if (problems.length > 0) {
  console.error("Migration check failed:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(
  `Migration check passed: ${sqlFiles.length} files, ${entries.length} journal entries.`,
);
