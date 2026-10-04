// docs/specs/SPEC-backups.md: the restore script, against a stubbed wrangler.
import {
  createCipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  keyIdOf,
  literal,
  main,
  parseArgs,
  pieces,
  planSql,
  readManifest,
  readRows,
  verifyFiles,
} from "./restore-backup.mjs";

const KEY = "ab".repeat(32);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function encrypt(bytes, file, index) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(KEY, "hex"), iv);
  cipher.setAAD(Buffer.from(`${file}:${index}`));
  const sealed = Buffer.concat([
    cipher.update(bytes),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(12 + sealed.length);
  return Buffer.concat([length, iv, sealed]);
}

const USERS = {
  columns: ["id", "email", "name"],
  primaryKey: ["id"],
  foreignKeys: [],
};
const PEOPLE = {
  columns: ["id", "email", "unread_count", "note"],
  primaryKey: ["id"],
  foreignKeys: [],
};

/** A backup on disk: users, then people. */
function fixture({
  encrypted = false,
  lastMigration = "0083_backup_runs",
  rows = {},
  tables = { users: USERS, people: PEOPLE },
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "backup-fixture-"));
  const data = {
    users: [{ id: "u1", email: "admin@example.com", name: "It's me" }],
    people: [
      { id: "p1", email: "a@example.com", unread_count: 0, note: null },
      {
        id: "p2",
        email: "b@example.com",
        unread_count: 2,
        note: "x".repeat(70_000),
      },
    ],
    ...rows,
  };
  const entries = Object.entries(tables).map(([name, meta]) => {
    const file = `${name}.ndjson.gz${encrypted ? ".enc" : ""}`;
    const list = data[name] ?? [];
    // Two gzip members, as a backup written in steps has.
    const half = Math.ceil(list.length / 2);
    const members = [list.slice(0, half), list.slice(half)].map(
      (chunk, index) => {
        const gz = gzipSync(
          chunk.map((row) => `${JSON.stringify(row)}\n`).join(""),
        );
        return encrypted ? encrypt(gz, file, index) : gz;
      },
    );
    const bytes = Buffer.concat(members);
    writeFileSync(join(dir, file), bytes);
    return {
      name,
      file,
      rows: list.length,
      bytes: bytes.length,
      parts: [{ bytes: bytes.length, sha256: sha256(bytes) }],
      frames: encrypted ? members.length : null,
      ...meta,
    };
  });
  const manifest = {
    format: 1,
    app: "saasmail",
    startedAt: 1_790_000_000,
    finishedAt: 1_790_000_100,
    lastMigration,
    compression: "gzip",
    encryption: encrypted ? "aes-256-gcm-frames" : null,
    keyId: encrypted
      ? createHmac("sha256", Buffer.from(KEY, "hex"))
          .update("saasmail-backup")
          .digest("hex")
          .slice(0, 16)
      : null,
    tables: entries,
    excluded: ["sessions"],
    r2Prefixes: ["attachments/"],
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  writeFileSync(join(dir, "manifest.json"), bytes);
  writeFileSync(
    join(dir, "manifest.sha256"),
    `${sha256(bytes)}  manifest.json\n`,
  );
  return dir;
}

async function collect(rows) {
  const out = [];
  for await (const row of rows) out.push(row);
  return out;
}

/** wrangler, answering the two queries and recording file loads. */
function stubWrangler({
  lastMigration = "0084_later",
  columns,
  failFile,
} = {}) {
  const calls = [];
  const known = columns ?? {
    users: ["id", "email", "name"],
    people: ["id", "email", "unread_count", "note", "added_later"],
  };
  let files = 0;
  const wrangler = (args) => {
    calls.push(args);
    if (args.includes("--file")) {
      files++;
      if (failFile === files) throw new Error("D1 said no");
      return "";
    }
    const command = args[args.indexOf("--command") + 1];
    if (command.startsWith("SELECT name FROM d1_migrations")) {
      return JSON.stringify([
        { results: lastMigration ? [{ name: lastMigration }] : [] },
      ]);
    }
    const names = [...command.matchAll(/table_info\("([^"]+)"\)/g)].map(
      (m) => m[1],
    );
    return JSON.stringify(
      names.map((name) => ({
        results: (known[name] ?? []).map((column) => ({ name: column })),
      })),
    );
  };
  return { wrangler, calls };
}

const targetOf = (map) =>
  new Map(
    Object.entries(map).map(([name, columns]) => [name, new Set(columns)]),
  );

describe("restore-backup", () => {
  it("reads and checks a backup", async () => {
    const dir = fixture();
    const manifest = readManifest(dir);
    expect(() => verifyFiles(dir, manifest)).not.toThrow();
    const rows = await collect(
      readRows(dir, manifest.tables[1], manifest, null),
    );
    expect(rows.map((row) => row.id)).toEqual(["p1", "p2"]);

    const tampered = Buffer.from(readFileSync(join(dir, "people.ndjson.gz")));
    tampered[tampered.length - 1] ^= 1;
    writeFileSync(join(dir, "people.ndjson.gz"), tampered);
    expect(() => verifyFiles(dir, manifest)).toThrow("does not match its hash");
  });

  it("decrypts frames bound to their file and place, and knows the key", async () => {
    const dir = fixture({ encrypted: true });
    const manifest = readManifest(dir);
    expect(keyIdOf(KEY)).toBe(manifest.keyId);
    const users = await collect(
      readRows(dir, manifest.tables[0], manifest, KEY),
    );
    expect(users[0].name).toBe("It's me");
    await expect(
      collect(readRows(dir, manifest.tables[0], manifest, null)),
    ).rejects.toThrow("--key");
    // A frame from another file does not decrypt there.
    const people = readFileSync(join(dir, "people.ndjson.gz.enc"));
    writeFileSync(join(dir, "users.ndjson.gz.enc"), people);
    await expect(
      collect(readRows(dir, manifest.tables[0], manifest, KEY)),
    ).rejects.toThrow();
    // A missing frame is noticed.
    const short = { ...manifest.tables[1], frames: 3 };
    await expect(collect(readRows(dir, short, manifest, KEY))).rejects.toThrow(
      "2 frames, the manifest says 3",
    );
    const { wrangler } = stubWrangler();
    const fresh = fixture({ encrypted: true });
    await expect(
      main(
        ["--from", fresh, "--database", "x", "--key", "cd".repeat(32), "--yes"],
        {
          wrangler,
          log: () => {},
        },
      ),
    ).rejects.toThrow("Wrong key");
  });

  it("builds the SQL: empty children first, fill parents first, upsert, long values in pieces", async () => {
    const dir = fixture();
    const manifest = readManifest(dir);
    const data = new Map(
      await Promise.all(
        manifest.tables.map(async (table) => [
          table.name,
          await collect(readRows(dir, table, manifest, null)),
        ]),
      ),
    );
    const { files, warnings } = await planSql(
      manifest,
      data,
      targetOf({
        users: ["id", "email"],
        people: ["id", "email", "unread_count", "note"],
      }),
    );
    expect(files[0]).toBe(
      'PRAGMA defer_foreign_keys = ON;\nDELETE FROM "people";\nDELETE FROM "users";\n',
    );
    const load = files.slice(1).join("");
    expect(load.indexOf('INSERT INTO "users"')).toBeLessThan(
      load.indexOf('INSERT INTO "people"'),
    );
    expect(load).toContain(
      `INSERT INTO "users" ("id", "email") VALUES ('u1', 'admin@example.com') ON CONFLICT ("id") DO UPDATE SET "email" = excluded."email" ON CONFLICT DO NOTHING;`,
    );
    expect(warnings).toContain("users.name: not in the target, skipped");
    // The 70,000-character note: inserted empty, then appended.
    expect(load).toContain(`('p2', 'b@example.com', 2, '')`);
    const appends =
      load.match(/UPDATE "people" SET "note" = "note" \|\| '/g) ?? [];
    expect(appends.length).toBeGreaterThan(1);
  });

  it("keeps every statement under D1's 100 KB in bytes, whatever the script", async () => {
    const manifest = {
      tables: [
        {
          name: "emails",
          columns: ["id", "body_text", "body_html"],
          primaryKey: ["id"],
          foreignKeys: [],
        },
      ],
    };
    const row = {
      id: "e1",
      body_text: "漢".repeat(25_000),
      body_html: `<p>${"字".repeat(28_000)}</p>`,
    };
    const { files } = await planSql(
      manifest,
      new Map([["emails", [row, { ...row, id: "e2" }]]]),
      targetOf({ emails: ["id", "body_text", "body_html"] }),
    );
    const statements = files.join("").split("\n").filter(Boolean);
    for (const statement of statements) {
      expect(Buffer.byteLength(statement)).toBeLessThan(100_000);
    }
    // The appended pieces put the bodies back together.
    const text = statements
      .filter(
        (s) =>
          s.startsWith('UPDATE "emails" SET "body_text"') &&
          s.endsWith("WHERE \"id\" = 'e1';"),
      )
      .map((s) => /\|\| '(.*)' WHERE/.exec(s)[1])
      .join("");
    expect(text).toBe(row.body_text);
  });

  it("leaves out rows whose parent is gone, and lets the last copy of a key win", async () => {
    const manifest = {
      tables: [
        {
          name: "people",
          columns: ["id"],
          primaryKey: ["id"],
          foreignKeys: [],
        },
        {
          name: "emails",
          columns: ["id", "person_id", "subject"],
          primaryKey: ["id"],
          foreignKeys: [
            { columns: ["person_id"], table: "people", references: ["id"] },
          ],
        },
      ],
    };
    const { files, warnings, tables } = await planSql(
      manifest,
      new Map([
        ["people", [{ id: "p1" }]],
        [
          "emails",
          [
            { id: "e1", person_id: "p1", subject: "first copy" },
            { id: "e2", person_id: "p-gone", subject: "orphan" },
            { id: "e1", person_id: "p1", subject: "second copy" },
          ],
        ],
      ]),
      targetOf({ people: ["id"], emails: ["id", "person_id", "subject"] }),
    );
    const sql = files.join("");
    expect(sql).not.toContain("orphan");
    expect(warnings).toContain(
      "emails: 1 rows left out, referencing rows deleted while the backup was written",
    );
    expect(tables).toEqual([
      { name: "people", rows: 1 },
      { name: "emails", rows: 2 },
    ]);
    // Both copies go in; the upsert keeps the later one.
    expect(sql.indexOf("first copy")).toBeLessThan(sql.indexOf("second copy"));
    expect(sql).toContain(
      'ON CONFLICT ("id") DO UPDATE SET "person_id" = excluded."person_id", "subject" = excluded."subject" ON CONFLICT DO NOTHING',
    );
  });

  it("quotes literals, NULs included, and never splits a character", () => {
    expect(literal("it's")).toBe("'it''s'");
    expect(literal(null)).toBe("NULL");
    expect(literal(3)).toBe("3");
    expect(literal(Buffer.from([1, 255]))).toBe("X'01ff'");
    expect(literal("a\0b")).toBe("CAST(X'610062' AS TEXT)");
    const text = `${"ab".repeat(10)}😀${"cd".repeat(10)}`;
    const split = pieces(text, 60);
    expect(split.join("")).toBe(text);
    for (const piece of split) {
      expect(piece).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(Buffer.byteLength(literal(piece))).toBeLessThanOrEqual(60);
    }
  });

  it("refuses a target older than the backup", async () => {
    const dir = fixture({ lastMigration: "0083_backup_runs" });
    const { wrangler, calls } = stubWrangler({
      lastMigration: "0080_spam_filter",
    });
    await expect(
      main(["--from", dir, "--database", "saasmail", "--yes"], {
        wrangler,
        log: () => {},
      }),
    ).rejects.toThrow("run yarn db:migrate:prod");
    expect(calls.some((args) => args.includes("--file"))).toBe(false);
  });

  it("loads only what --tables names, and --dry-run loads nothing", async () => {
    const dir = fixture();
    const dry = stubWrangler();
    const lines = [];
    const result = await main(
      [
        "--from",
        dir,
        "--database",
        "saasmail",
        "--tables",
        "people",
        "--dry-run",
      ],
      { wrangler: dry.wrangler, log: (line) => lines.push(line) },
    );
    expect(result.dryRun).toBe(true);
    expect(dry.calls.some((args) => args.includes("--file"))).toBe(false);
    expect(result.plan.tables.map((table) => table.name)).toEqual(["people"]);
    // Some tables only: nothing deleted (a delete would cascade), rows
    // written over by primary key.
    const sql = result.paths.map((path) => readFileSync(path, "utf8")).join("");
    expect(sql).not.toContain("DELETE FROM");
    expect(sql).not.toContain('"users"');
    expect(sql).toContain(
      'ON CONFLICT ("id") DO UPDATE SET "email" = excluded."email", "unread_count" = excluded."unread_count", "note" = excluded."note" ON CONFLICT DO NOTHING;',
    );
    expect(lines.join("\n")).toContain("people: 2 rows");
  });

  it("says which file failed, resumes from it, and wants a confirmation", async () => {
    const dir = fixture();
    const failing = stubWrangler({ failFile: 2 });
    let error;
    try {
      await main(["--from", dir, "--database", "saasmail", "--yes"], {
        wrangler: failing.wrangler,
        log: () => {},
      });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("did not load: D1 said no");
    expect(String(error)).toContain("--from-file 2");

    const resumed = stubWrangler();
    const result = await main(
      ["--from", dir, "--database", "saasmail", "--yes", "--from-file", "2"],
      { wrangler: resumed.wrangler, log: () => {} },
    );
    const loaded = resumed.calls.filter((args) => args.includes("--file"));
    expect(loaded).toHaveLength(result.paths.length - 1);
    expect(loaded[0]).toEqual([
      "d1",
      "execute",
      "saasmail",
      "--remote",
      "--file",
      result.paths[1],
      "--yes",
    ]);

    // No terminal and no --yes: refused, not silently skipped.
    await expect(
      main(["--from", dir, "--database", "saasmail"], {
        wrangler: stubWrangler().wrangler,
        log: () => {},
      }),
    ).rejects.toThrow("Not confirmed");
    const declined = await main(["--from", dir, "--database", "saasmail"], {
      wrangler: stubWrangler().wrangler,
      log: () => {},
      confirm: async () => false,
    });
    expect(declined.cancelled).toBe(true);
  });

  it("checks its options", () => {
    expect(() => parseArgs(["--database", "x"])).toThrow("--from");
    expect(() =>
      parseArgs(["--from", "s3://bucket/x", "--database", "x"]),
    ).toThrow("rclone");
    expect(() =>
      parseArgs(["--from", "d", "--database", "x", "--key", "12"]),
    ).toThrow("64 hex");
    expect(() =>
      parseArgs(["--from", "d", "--database", "x", "--persist-to", "p"]),
    ).toThrow("--local");
    expect(
      parseArgs([
        "--from",
        "d",
        "--database",
        "x",
        "--local",
        "--tables",
        "a, b",
      ]),
    ).toMatchObject({ local: true, tables: ["a", "b"] });
  });
});
