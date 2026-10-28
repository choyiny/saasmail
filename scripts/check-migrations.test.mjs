// docs/updating.md#upstream-migrations: check-migrations fails on any
// migrations/ tree wrangler and drizzle-kit would disagree on, and the one
// named 0027 file/tag exception hides nothing else. The script reads
// migrations/ under its working directory, so each case runs it against a
// temporary tree.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "check-migrations.mjs");
const repoRoot = join(here, "..");

const COUNT = 30;
// 0010 is a data-only step (`drizzle-kit generate --custom`): no snapshot.
const DATA_ONLY = 10;
const pad = (n) => String(n).padStart(4, "0");

/** The journal tag of step n; 0027 keeps the tag upstream shipped it with. */
const tagOf = (n) => (n === 27 ? "0027_sad_moonstone" : `${pad(n)}_step_${n}`);
/** The file of step n; 0027's file was renamed after it shipped. */
const fileOf = (n) => (n === 27 ? "0027_strong_thena.sql" : `${tagOf(n)}.sql`);

/** A consistent tree of COUNT steps, then `mutate(dir)` breaks it. */
function run(mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "check-migrations-"));
  const migrations = join(root, "migrations");
  const meta = join(migrations, "meta");
  mkdirSync(meta, { recursive: true });
  const entries = [];
  for (let n = 0; n < COUNT; n += 1) {
    writeFileSync(join(migrations, fileOf(n)), `-- step ${n}\n`);
    entries.push({
      idx: n,
      version: "6",
      when: 1776227146221 + n,
      tag: tagOf(n),
      breakpoints: true,
    });
    if (n !== DATA_ONLY) {
      writeFileSync(
        join(meta, `${pad(n)}_snapshot.json`),
        JSON.stringify({
          version: "6",
          dialect: "sqlite",
          id: `id-${n}`,
          prevId:
            n === 0 ? "00000000-0000-0000-0000-000000000000" : `id-${n - 1}`,
        }),
      );
    }
  }
  writeFileSync(
    join(meta, "_journal.json"),
    JSON.stringify({ version: "7", dialect: "sqlite", entries }),
  );
  mutate({ root, migrations, meta });
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

function editJournal(meta, edit) {
  const file = join(meta, "_journal.json");
  const journal = JSON.parse(readFileSync(file, "utf8"));
  edit(journal.entries);
  writeFileSync(file, JSON.stringify(journal));
}

function editSnapshot(meta, n, edit) {
  const file = join(meta, `${pad(n)}_snapshot.json`);
  const snapshot = JSON.parse(readFileSync(file, "utf8"));
  edit(snapshot);
  writeFileSync(file, JSON.stringify(snapshot));
}

describe("check-migrations", () => {
  it("passes this repo's migrations", () => {
    const result = spawnSync(process.execPath, [script], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("passes a consistent tree with the 0027 pair and a data-only step", () => {
    const { status, out, err } = run();
    expect(err).toBe("");
    expect(status).toBe(0);
    expect(out).toContain(`${COUNT} files, ${COUNT} journal entries`);
  });

  it.each([
    [
      "an upstream file that survived a merge (two files for one number)",
      ({ migrations }) =>
        writeFileSync(join(migrations, "0005_overjoyed_rocket_racer.sql"), ""),
      "0005: 2 files",
    ],
    [
      "a file with no journal entry",
      ({ migrations }) =>
        writeFileSync(join(migrations, "0030_orphan.sql"), ""),
      "0030_orphan.sql: no _journal.json entry",
    ],
    [
      "a journal entry with no file",
      ({ migrations }) => unlinkSync(join(migrations, fileOf(29))),
      `_journal.json entry ${tagOf(29)}: no ${tagOf(29)}.sql`,
    ],
    [
      "a file whose name has no 4-digit number",
      ({ migrations }) => writeFileSync(join(migrations, "add_table.sql"), ""),
      "add_table.sql: name does not start with a 4-digit number",
    ],
    [
      "a gap in the journal idx",
      ({ meta }) =>
        editJournal(meta, (entries) => {
          for (const entry of entries) if (entry.idx >= 5) entry.idx += 1;
        }),
      "idx is 6, expected 5",
    ],
    [
      "journal entries out of order",
      ({ meta }) =>
        editJournal(meta, (entries) => {
          [entries[3], entries[4]] = [entries[4], entries[3]];
        }),
      "idx is 4, expected 3",
    ],
    [
      "a snapshot whose prevId is not the previous snapshot's id",
      ({ meta }) => editSnapshot(meta, 12, (s) => (s.prevId = "id-forked")),
      `${tagOf(12)}: snapshot prevId id-forked is not ${tagOf(11)}'s id id-11`,
    ],
    [
      "the renamed 0027 file under any other journal tag",
      ({ meta }) =>
        editJournal(meta, (entries) => {
          entries[27].tag = "0027_other_name";
        }),
      "0027_strong_thena.sql: no _journal.json entry",
    ],
    [
      "the 0027 journal tag with its renamed file gone",
      ({ migrations }) => unlinkSync(join(migrations, "0027_strong_thena.sql")),
      "_journal.json entry 0027_sad_moonstone: no 0027_sad_moonstone.sql",
    ],
    [
      "the 0027 file and its old name both on disk",
      ({ migrations }) =>
        writeFileSync(join(migrations, "0027_sad_moonstone.sql"), ""),
      "0027: 2 files",
    ],
    [
      "another 0027 file in place of the named one (the exception is one file name)",
      ({ migrations }) =>
        renameSync(
          join(migrations, "0027_strong_thena.sql"),
          join(migrations, "0027_upstream_rename.sql"),
        ),
      "0027_upstream_rename.sql: no _journal.json entry",
    ],
    [
      "a renamed file at another number (the exception is 0027's only)",
      ({ migrations }) =>
        renameSync(
          join(migrations, fileOf(28)),
          join(migrations, "0028_strong_thena.sql"),
        ),
      "0028_strong_thena.sql: no _journal.json entry",
    ],
  ])("fails on %s", (_name, mutate, expected) => {
    const { status, err } = run(mutate);
    expect(status).toBe(1);
    expect(err).toContain("Migration check failed:");
    expect(err).toContain(expected);
  });
});
