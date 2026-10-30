// e2e/specs/data-backup.spec.ts
// Covers: "Back up now" writes a backup to the local bucket, and the restore
// script loads a table of it back into the local D1.
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "../fixtures/test";
import {
  execLocalSql,
  getDbName,
  queryLocalSql,
  truncateAndReseed,
} from "../support/reset-db";

const BUCKET = "saasmail-attachments";
const run = promisify(execFile);

/** Copies these files of a backup out of the local bucket, eight at a time. */
async function download(prefix: string, files: string[], dir: string) {
  const queue = [...files];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        await run("wrangler", [
          "r2",
          "object",
          "get",
          `${BUCKET}/${prefix}${file}`,
          "--local",
          "--file",
          join(dir, file),
        ]);
      }
    }),
  );
}

test.describe.serial("database backups", () => {
  test.beforeAll(() => truncateAndReseed());
  test.afterAll(() => truncateAndReseed());

  test("a backup restores a table", async ({ page, api }) => {
    test.setTimeout(120_000);
    const started = await api.post("/api/admin/backups/run");
    expect(started.status()).toBe(202);
    const { id, prefix } = (await started.json()) as {
      id: string;
      prefix: string;
    };
    await expect
      .poll(
        async () => {
          const res = await api.get("/api/admin/backups");
          const body = (await res.json()) as {
            runs: { id: string; status: string }[];
          };
          return body.runs.find((run) => run.id === id)?.status;
        },
        { timeout: 60_000 },
      )
      .toBe("completed");
    const manifest = (await (
      await api.get(`/api/admin/backups/${id}/manifest`)
    ).json()) as { tables: { name: string; rows: number; file: string }[] };
    expect(
      manifest.tables.find((t) => t.name === "people")!.rows,
    ).toBeGreaterThan(0);

    // Copy the whole backup out of the local bucket.
    const dir = mkdtempSync(join(tmpdir(), "saasmail-backup-"));
    await download(
      prefix,
      [
        "manifest.json",
        "manifest.sha256",
        ...manifest.tables.map((table) => table.file),
      ],
      dir,
    );

    // A full restore into a fresh, migrated local database: every table
    // emptied and loaded in foreign-key order, the counts as backed up.
    const scratch = mkdtempSync(join(tmpdir(), "saasmail-restore-db-"));
    execFileSync(
      "wrangler",
      [
        "d1",
        "migrations",
        "apply",
        getDbName(),
        "--local",
        "--persist-to",
        scratch,
      ],
      { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 },
    );
    execFileSync(
      "node",
      [
        "scripts/restore-backup.mjs",
        "--from",
        dir,
        "--database",
        getDbName(),
        "--local",
        "--persist-to",
        scratch,
        "--yes",
      ],
      { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 },
    );
    const counts = JSON.parse(
      execFileSync(
        "wrangler",
        [
          "d1",
          "execute",
          getDbName(),
          "--local",
          "--persist-to",
          scratch,
          "--json",
          "--command",
          "SELECT (SELECT COUNT(*) FROM people) AS people, (SELECT COUNT(*) FROM emails) AS emails, (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM inbox_permissions) AS permissions",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 64 * 1024 * 1024,
        },
      ),
    )[0].results[0];
    const rowsOf = (name: string) =>
      manifest.tables.find((table) => table.name === name)!.rows;
    expect(counts).toEqual({
      people: rowsOf("people"),
      emails: rowsOf("emails"),
      users: rowsOf("users"),
      permissions: rowsOf("inbox_permissions"),
    });

    // Change a person, add one, then restore people from the backup.
    execLocalSql(
      "UPDATE people SET name = 'Changed after the backup' WHERE id = 'p_alice'",
    );
    execLocalSql(
      "INSERT INTO people (id, email, name, last_email_at, unread_count, total_count, created_at, updated_at) VALUES ('p_after', 'after@customers.test', 'After', 1, 0, 0, 1, 1)",
    );
    execFileSync(
      "node",
      [
        "scripts/restore-backup.mjs",
        "--from",
        dir,
        "--database",
        getDbName(),
        "--local",
        "--tables",
        "people",
        "--yes",
      ],
      { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 },
    );
    expect(
      queryLocalSql<{ name: string }>(
        "SELECT name FROM people WHERE id = 'p_alice'",
      ),
    ).toEqual([{ name: "Alice Anderson" }]);
    // Some tables only: rows added since the backup stay.
    expect(
      queryLocalSql("SELECT id FROM people WHERE id = 'p_after'"),
    ).toHaveLength(1);

    // Settings → Data lists the run.
    await page.goto("/settings#data");
    const row = page.getByTestId("backup-row").first();
    await expect(row).toContainText("Back up now");
    await expect(row.getByTestId("backup-status")).toContainText("tables");
  });
});
