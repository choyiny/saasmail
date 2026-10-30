#!/usr/bin/env node
// Loads a saasmail database backup into a D1 database.
//
//   node scripts/restore-backup.mjs --from <dir> --database <d1 name>
//     [--key <64 hex>] [--tables a,b] [--local [--persist-to <dir>]]
//     [--dry-run] [--yes] [--from-file <n>]
//
// <dir> is a backup prefix copied out of the bucket (`rclone copy`, or
// `wrangler r2 object get` per file): manifest.json, manifest.sha256 and one
// <table>.ndjson.gz[.enc] per table. The target must already have run
// `yarn db:migrate:prod` (at least the backup's last migration).
//
// A full restore empties every table in the backup (children first) and
// loads it (parents first). Deleting `users` also deletes what references
// it and is not in a backup (sessions, OAuth tokens): everyone signs in
// again. With --tables, those tables' rows are written over the current
// ones by primary key and nothing is deleted: emptying one table would
// cascade into others (D1 cannot turn foreign keys off).
//
// A backup is written over minutes, not at one instant: a row can appear
// twice (the last copy wins) or reference a row that was deleted before its
// table was written (it is left out, with a count). A row that clashes with
// another on a unique key other than its primary key is skipped.
// R2 objects (attachments, raw messages) are not part of a backup: copy the
// bucket to move them. See docs/data.md#backups.

import { createDecipheriv, createHash, createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createInterface as createPrompt } from "node:readline/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

/** D1 refuses statements longer than 100 KB (bytes); stay well under. */
const MAX_STATEMENT = 90_000;
/** A value whose literal is longer than this goes in with appends. */
const MAX_VALUE = 30_000;
/** One `--file` a few megabytes at most. */
const MAX_FILE = 4 * 1024 * 1024;
const HEADER = "PRAGMA defer_foreign_keys = ON;\n";

const bytes = (text) => Buffer.byteLength(text, "utf8");

export function parseArgs(argv) {
  const options = {
    from: null,
    database: null,
    key: null,
    tables: null,
    local: false,
    persistTo: null,
    dryRun: false,
    yes: false,
    fromFile: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--from") options.from = value();
    else if (arg === "--database") options.database = value();
    else if (arg === "--key") options.key = value();
    else if (arg === "--tables") {
      options.tables = value()
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    } else if (arg === "--local") options.local = true;
    else if (arg === "--persist-to") options.persistTo = value();
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--from-file") {
      options.fromFile = Number(value());
      if (!Number.isInteger(options.fromFile) || options.fromFile < 1) {
        throw new Error("--from-file is a file number from 1");
      }
    } else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.from) throw new Error("--from <dir> is required");
  if (options.from.startsWith("s3://") || options.from.startsWith("r2://")) {
    throw new Error(
      "Copy the backup out of the bucket first (rclone copy, or wrangler r2 object get) and pass the local directory",
    );
  }
  if (!options.database) throw new Error("--database <d1 name> is required");
  if (options.persistTo && !options.local) {
    throw new Error("--persist-to needs --local");
  }
  if (options.key !== null && !/^[0-9a-fA-F]{64}$/.test(options.key)) {
    throw new Error("--key must be 64 hex characters");
  }
  return options;
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** The id of a key, as the Worker records it (see backup/crypto.ts). */
export function keyIdOf(keyHex) {
  return createHmac("sha256", Buffer.from(keyHex, "hex"))
    .update("saasmail-backup")
    .digest("hex")
    .slice(0, 16);
}

/** The manifest, checked against manifest.sha256. */
export function readManifest(dir) {
  const data = readFileSync(join(dir, "manifest.json"));
  const sumFile = join(dir, "manifest.sha256");
  if (existsSync(sumFile)) {
    const expected = readFileSync(sumFile, "utf8").split(/\s+/)[0];
    if (sha256(data) !== expected) {
      throw new Error("manifest.json does not match manifest.sha256");
    }
  }
  const manifest = JSON.parse(data.toString("utf8"));
  if (manifest.format !== 1 || manifest.app !== "saasmail") {
    throw new Error("Not a saasmail backup manifest (format 1)");
  }
  return manifest;
}

/** Checks every part of every file against the manifest's hashes. */
export function verifyFiles(dir, manifest, tables = manifest.tables) {
  for (const table of tables) {
    const path = join(dir, table.file);
    if (!existsSync(path)) throw new Error(`${table.file} is missing`);
    const data = readFileSync(path);
    let at = 0;
    for (const [index, part] of table.parts.entries()) {
      const slice = data.subarray(at, at + part.bytes);
      if (slice.length !== part.bytes || sha256(slice) !== part.sha256) {
        throw new Error(
          `${table.file}: part ${index + 1} does not match its hash`,
        );
      }
      at += part.bytes;
    }
    if (at !== data.length) {
      throw new Error(`${table.file} is ${data.length} bytes, not ${at}`);
    }
  }
}

/**
 * The frames of an encrypted file, decrypted one at a time: length, IV,
 * ciphertext and tag, each bound to `<file>:<index>`.
 */
export function* decryptFrames(data, keyHex, file, expected = null) {
  const key = Buffer.from(keyHex, "hex");
  let at = 0;
  let index = 0;
  while (at < data.length) {
    const length = data.readUInt32BE(at);
    const iv = data.subarray(at + 4, at + 16);
    const sealed = data.subarray(at + 16, at + 4 + length);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(`${file}:${index}`));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    yield Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - 16)),
      decipher.final(),
    ]);
    at += 4 + length;
    index++;
  }
  if (expected !== null && index !== expected) {
    throw new Error(`${file}: ${index} frames, the manifest says ${expected}`);
  }
}

/** A table's rows, streamed. Blobs come back as Buffers. */
export async function* readRows(dir, table, manifest, keyHex) {
  const data = readFileSync(join(dir, table.file));
  if (manifest.encryption && !keyHex) {
    throw new Error("This backup is encrypted: pass --key with its key");
  }
  const source = manifest.encryption
    ? Readable.from(
        decryptFrames(data, keyHex, table.file, table.frames ?? null),
      )
    : Readable.from([data]);
  // Gunzip reads every member of a multi-member file.
  const gunzip = createGunzip();
  source.on("error", (error) => gunzip.destroy(error));
  const lines = createInterface({
    input: source.pipe(gunzip),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line) continue;
    const row = JSON.parse(line);
    for (const [column, value] of Object.entries(row)) {
      if (value && typeof value === "object" && "$blob" in value) {
        row[column] = Buffer.from(value.$blob, "base64");
      }
    }
    yield row;
  }
}

const identifier = (name) => `"${name.replace(/"/g, '""')}"`;

/** A value as an SQLite literal. Text with a NUL goes in as bytes. */
export function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (Buffer.isBuffer(value)) return `X'${value.toString("hex")}'`;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  const text = String(value);
  if (text.includes("\0")) {
    return `CAST(X'${Buffer.from(text, "utf8").toString("hex")}' AS TEXT)`;
  }
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * A long value in pieces whose literals are at most `max` bytes. A string
 * is never split inside a character (an emoji is not cut in two).
 */
export function pieces(value, max = MAX_VALUE) {
  const out = [];
  if (Buffer.isBuffer(value)) {
    const step = Math.floor((max - 3) / 2);
    for (let at = 0; at < value.length; at += step) {
      out.push(value.subarray(at, at + step));
    }
    return out;
  }
  let piece = "";
  let size = 2;
  for (const char of String(value)) {
    // A NUL turns the literal into hex: allow for it generously.
    const add = char === "'" ? 2 : char === "\0" ? 8 : bytes(char) * 2;
    if (size + add > max - 32 && piece) {
      out.push(piece);
      piece = "";
      size = 2;
    }
    piece += char;
    size += add;
  }
  if (piece) out.push(piece);
  return out;
}

/** The migration's number: `0083_backup_runs` → 83. */
const migrationNumber = (name) => Number(/^(\d+)/.exec(name ?? "")?.[1] ?? -1);

/**
 * Writes the SQL that loads tables into a target, file by file through
 * `sink(sql)`: a full restore empties the tables (children first) in its
 * first file, then every row is upserted by primary key (the last copy of a
 * key wins; a clash on another unique key is skipped). `partial` (some
 * tables only): nothing is emptied. Rows that reference a row the restore
 * does not load (a parent deleted while the backup was written) are left
 * out, with a count.
 */
export class SqlWriter {
  constructor(manifest, targetColumns, { partial = false, sink }) {
    this.manifest = manifest;
    this.targetColumns = targetColumns;
    this.partial = partial;
    this.sink = sink;
    this.current = "";
    this.currentBytes = 0;
    this.warnings = [];
    this.loaded = [];
    /** Key sets of the tables loaded, for the orphan check. */
    this.keys = new Map();
  }

  push(statement) {
    const size = bytes(statement) + 1;
    if (this.current && this.currentBytes + size > MAX_FILE) this.flushFile();
    this.current += `${statement}\n`;
    this.currentBytes += size;
  }

  flushFile() {
    if (!this.current) return;
    this.sink(HEADER + this.current);
    this.current = "";
    this.currentBytes = 0;
  }

  /** The tables that load (those the target has), in the backup's order. */
  plan(tables) {
    const loading = [];
    for (const table of tables) {
      if (this.targetColumns.has(table.name)) loading.push(table);
      else this.warnings.push(`${table.name}: not in the target, skipped`);
    }
    if (!this.partial && loading.length > 0) {
      for (const table of [...loading].reverse()) {
        this.push(`DELETE FROM ${identifier(table.name)};`);
      }
      this.flushFile();
    }
    // A full restore knows every parent it loads: collect their keys so a
    // child row whose parent is gone is left out. A partial restore's
    // parents are in the target already, so it checks nothing.
    if (!this.partial) {
      const names = new Set(loading.map((table) => table.name));
      for (const table of loading) {
        for (const key of table.foreignKeys ?? []) {
          if (key.table === table.name || !names.has(key.table)) continue;
          const id = `${key.table}|${key.references.join(",")}`;
          if (!this.keys.has(id)) this.keys.set(id, new Set());
        }
      }
    }
    return loading;
  }

  /** Loads one table's rows (an iterable or async iterable). */
  async table(table, rows) {
    const target = this.targetColumns.get(table.name);
    const backedUp = table.columns ?? [];
    const columns = backedUp.filter((column) => target.has(column));
    for (const column of backedUp.filter((column) => !target.has(column))) {
      this.warnings.push(`${table.name}.${column}: not in the target, skipped`);
    }
    const primaryKey = table.primaryKey ?? [];
    const keyed =
      primaryKey.length > 0 &&
      primaryKey.every((column) => columns.includes(column));
    const updates = columns.filter((column) => !primaryKey.includes(column));
    const head = `INSERT INTO ${identifier(table.name)} (${columns.map(identifier).join(", ")}) VALUES `;
    const tail = keyed
      ? ` ON CONFLICT (${primaryKey.map(identifier).join(", ")}) DO ${
          updates.length > 0
            ? `UPDATE SET ${updates.map((column) => `${identifier(column)} = excluded.${identifier(column)}`).join(", ")}`
            : "NOTHING"
        } ON CONFLICT DO NOTHING`
      : " ON CONFLICT DO NOTHING";
    const room = MAX_STATEMENT - bytes(head) - bytes(tail);
    const checks = (table.foreignKeys ?? [])
      .filter((key) => key.table !== table.name)
      .map((key) => ({
        key,
        set: this.keys.get(`${key.table}|${key.references.join(",")}`),
      }))
      .filter((check) => check.set);
    const keeps = [...this.keys.keys()]
      .filter((id) => id.startsWith(`${table.name}|`))
      .map((id) => ({
        columns: id.slice(table.name.length + 1).split(","),
        set: this.keys.get(id),
      }));

    let values = [];
    let size = 0;
    let count = 0;
    let orphans = 0;
    const flush = () => {
      if (values.length === 0) return;
      this.push(`${head}${values.join(", ")}${tail};`);
      values = [];
      size = 0;
    };
    for await (const row of rows) {
      const orphan = checks.some(({ key, set }) => {
        const tuple = key.columns.map((column) => row[column]);
        if (tuple.some((value) => value === null || value === undefined)) {
          return false;
        }
        return !set.has(JSON.stringify(tuple));
      });
      if (orphan) {
        orphans++;
        continue;
      }
      for (const { columns: cols, set } of keeps) {
        set.add(JSON.stringify(cols.map((column) => row[column])));
      }
      const cells = columns.map((column) => literal(row[column]));
      const empty = (index) =>
        Buffer.isBuffer(row[columns[index]]) ? "X''" : "''";
      // Values too long for a statement start empty and are appended...
      const appends = [];
      for (let index = 0; index < cells.length; index++) {
        if (
          bytes(cells[index]) > MAX_VALUE &&
          !primaryKey.includes(columns[index])
        ) {
          appends.push(index);
          cells[index] = empty(index);
        }
      }
      // ...and so do the largest others until the row fits a statement.
      while (bytes(`(${cells.join(", ")})`) > room) {
        let largest = -1;
        for (let index = 0; index < cells.length; index++) {
          if (appends.includes(index) || primaryKey.includes(columns[index])) {
            continue;
          }
          if (largest === -1 || bytes(cells[index]) > bytes(cells[largest])) {
            largest = index;
          }
        }
        if (largest === -1) break;
        appends.push(largest);
        cells[largest] = empty(largest);
      }
      const tuple = `(${cells.join(", ")})`;
      const tupleBytes = bytes(tuple);
      if (size + tupleBytes + 2 > room) flush();
      values.push(tuple);
      size += tupleBytes + 2;
      count++;
      if (appends.length === 0) continue;
      flush();
      if (!keyed) {
        this.warnings.push(
          `${table.name}: a long value in a row without a primary key was cut`,
        );
        continue;
      }
      const where = primaryKey
        .map((column) => `${identifier(column)} = ${literal(row[column])}`)
        .join(" AND ");
      for (const index of appends) {
        const column = columns[index];
        const value = row[column];
        for (const piece of pieces(value)) {
          const joined = `${identifier(column)} || ${literal(piece)}`;
          this.push(
            `UPDATE ${identifier(table.name)} SET ${identifier(column)} = ${
              Buffer.isBuffer(value) ? `CAST(${joined} AS BLOB)` : joined
            } WHERE ${where};`,
          );
        }
      }
    }
    flush();
    if (orphans > 0) {
      this.warnings.push(
        `${table.name}: ${orphans} rows left out, referencing rows deleted while the backup was written`,
      );
    }
    this.loaded.push({ name: table.name, rows: count });
  }

  finish() {
    this.flushFile();
    return { warnings: this.warnings, tables: this.loaded };
  }
}

/** The whole plan in memory (for tests and small backups). */
export async function planSql(manifest, data, targetColumns, partial = false) {
  const files = [];
  const writer = new SqlWriter(manifest, targetColumns, {
    partial,
    sink: (sql) => files.push(sql),
  });
  const loading = writer.plan(
    manifest.tables.filter((table) => data.has(table.name)),
  );
  for (const table of loading) await writer.table(table, data.get(table.name));
  const { warnings, tables } = writer.finish();
  return { files, warnings, tables };
}

/** Runs wrangler and returns its stdout. */
function runWrangler(args) {
  return execFileSync(process.env.WRANGLER ?? "wrangler", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Where wrangler runs: the account's database, or a local one. */
function targetArgs(options) {
  if (!options.local) return ["--remote"];
  return options.persistTo
    ? ["--local", "--persist-to", options.persistTo]
    : ["--local"];
}

/** The JSON results of `wrangler d1 execute --json`. */
function d1Json(wrangler, options, command) {
  const out = wrangler([
    "d1",
    "execute",
    options.database,
    ...targetArgs(options),
    "--json",
    "--command",
    command,
  ]);
  return JSON.parse(out);
}

/** The target's last applied migration and its tables' columns. */
export function inspectTarget(wrangler, options, tableNames) {
  const [migrations] = d1Json(
    wrangler,
    options,
    "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1",
  );
  const lastMigration = migrations?.results?.[0]?.name ?? null;
  const pragmas = tableNames
    .map((name) => `PRAGMA table_info(${identifier(name)});`)
    .join(" ");
  const results = d1Json(wrangler, options, pragmas);
  const columns = new Map();
  tableNames.forEach((name, index) => {
    const rows = results[index]?.results ?? [];
    if (rows.length > 0) {
      columns.set(name, new Set(rows.map((row) => row.name)));
    }
  });
  return { lastMigration, columns };
}

export async function main(argv, deps = {}) {
  const wrangler = deps.wrangler ?? runWrangler;
  const log = deps.log ?? ((line) => console.log(line));
  const confirm =
    deps.confirm ??
    (async (question) => {
      if (!process.stdin.isTTY) {
        throw new Error(
          "Not confirmed: run it in a terminal, or pass --yes to load without asking",
        );
      }
      const rl = createPrompt({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(question);
      rl.close();
      return answer.trim() === "yes";
    });

  const options = parseArgs(argv);
  const manifest = readManifest(options.from);
  if (options.tables) {
    for (const name of options.tables) {
      if (!manifest.tables.some((table) => table.name === name)) {
        throw new Error(`${name} is not in this backup`);
      }
    }
  }
  const chosen = options.tables
    ? manifest.tables.filter((table) => options.tables.includes(table.name))
    : manifest.tables;
  verifyFiles(options.from, manifest, chosen);
  if (manifest.encryption) {
    if (!options.key) {
      throw new Error("This backup is encrypted: pass --key with its key");
    }
    if (manifest.keyId && keyIdOf(options.key) !== manifest.keyId) {
      throw new Error("Wrong key: this backup was encrypted with another one");
    }
  }

  const target = inspectTarget(
    wrangler,
    options,
    chosen.map((table) => table.name),
  );
  if (
    manifest.lastMigration &&
    migrationNumber(target.lastMigration) <
      migrationNumber(manifest.lastMigration)
  ) {
    throw new Error(
      `The target's last migration is ${target.lastMigration ?? "none"}, older than the backup's ${manifest.lastMigration}: run yarn db:migrate:prod against it first`,
    );
  }

  // Write the SQL to files, table by table, without holding a table.
  const dir = mkdtempSync(join(tmpdir(), "saasmail-restore-"));
  const paths = [];
  const writer = new SqlWriter(manifest, target.columns, {
    partial: options.tables !== null,
    sink: (sql) => {
      const path = join(
        dir,
        `${String(paths.length + 1).padStart(4, "0")}.sql`,
      );
      writeFileSync(path, sql);
      paths.push(path);
    },
  });
  const loading = writer.plan(chosen);
  for (const table of loading) {
    await writer.table(
      table,
      readRows(options.from, table, manifest, options.key),
    );
  }
  const plan = writer.finish();
  const rows = plan.tables.reduce((n, table) => n + table.rows, 0);
  log(
    `Backup of ${new Date(manifest.startedAt * 1000).toISOString()} (migration ${manifest.lastMigration ?? "unknown"}) into ${options.database} (${options.local ? "local" : "remote"}, migration ${target.lastMigration ?? "none"}):`,
  );
  for (const table of plan.tables) log(`  ${table.name}: ${table.rows} rows`);
  log(`${plan.tables.length} tables, ${rows} rows, ${paths.length} SQL files.`);
  for (const warning of plan.warnings) log(`warning: ${warning}`);
  if (options.dryRun) {
    log(`Dry run: nothing loaded. The SQL is in ${dir}.`);
    return { dryRun: true, paths, plan };
  }
  if (options.fromFile > paths.length) {
    throw new Error(
      `--from-file ${options.fromFile}: there are ${paths.length} files`,
    );
  }
  const go =
    options.yes ||
    (await confirm(
      options.tables
        ? `This writes the backup's rows of ${plan.tables.length} tables over those in ${options.database}. Type yes to go on: `
        : `This empties and reloads ${plan.tables.length} tables in ${options.database}. Type yes to go on: `,
    ));
  if (!go) {
    log("Nothing loaded.");
    return { dryRun: false, cancelled: true, paths, plan };
  }
  for (const [index, path] of paths.entries()) {
    const number = index + 1;
    if (number < options.fromFile) continue;
    log(`Loading ${number}/${paths.length}…`);
    try {
      wrangler([
        "d1",
        "execute",
        options.database,
        ...targetArgs(options),
        "--file",
        path,
        "--yes",
      ]);
    } catch (error) {
      throw new Error(
        `File ${number} of ${paths.length} (${path}) did not load: ${error instanceof Error ? error.message : error}\nThe database is partly loaded. Fix the cause, then run the same command with --from-file ${number} to go on from there.`,
      );
    }
  }
  log(
    `Done. R2 objects (${(manifest.r2Prefixes ?? []).join(", ")}) are not part of a backup: copy the bucket if you moved accounts.`,
  );
  return { dryRun: false, paths, plan };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
