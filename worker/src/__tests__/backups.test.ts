// docs/archive/SPEC-backups.md: scheduled database backups to R2.
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import { env } from "cloudflare:workers";
// workerd runs node:zlib (nodejs_compat); the worker build has no Node
// types, so it is imported by name. Its gunzip reads every gzip member.
const zlib = "node:zlib";
const { gunzipSync } = (await import(/* @vite-ignore */ zlib)) as {
  gunzipSync: (bytes: Uint8Array) => Uint8Array;
};
import { eq, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { backupRuns } from "../db/backup-runs.schema";
import { decryptFrames, backupKey, sha256Hex } from "../lib/backup/crypto";
import {
  BACKUP_LIMITS,
  backupProgress,
  failBackup,
  pruneBackups,
  rowLine,
  runBackupSchedule,
  runBackupStep,
  startBackup,
  type BackupManifest,
} from "../lib/backup/run";
import {
  nextBackupDue,
  readBackupSettings,
  updateBackupSettings,
} from "../lib/backup/settings";
import { EXCLUDED_TABLES, allTables, backupTables } from "../lib/backup/tables";
import { classifyQueueMessage } from "../lib/queue-router";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";

const decoder = new TextDecoder();

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
});

async function runAll(runId: string): Promise<number> {
  let step: number | null = 0;
  let steps = 0;
  while (step !== null) {
    step = await runBackupStep(getDb(), env, runId, step);
    steps++;
  }
  return steps;
}

async function runRow(id: string) {
  const [run] = await getDb()
    .select()
    .from(backupRuns)
    .where(eq(backupRuns.id, id));
  return run;
}

async function manifestOf(prefix: string): Promise<BackupManifest> {
  const object = await env.R2.get(`${prefix}manifest.json`);
  expect(object).not.toBeNull();
  return JSON.parse(await object!.text()) as BackupManifest;
}

/** A table's lines, read back the way the restore script reads them. */
async function linesOf(
  prefix: string,
  file: string,
  key: CryptoKey | null = null,
): Promise<Record<string, unknown>[]> {
  const object = await env.R2.get(`${prefix}${file}`);
  expect(object).not.toBeNull();
  let bytes: Uint8Array = new Uint8Array(await object!.arrayBuffer());
  if (key) bytes = await decryptFrames(key, bytes, file);
  const text = decoder.decode(gunzipSync(bytes));
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("the table list", () => {
  it("covers every table exactly once, parents first", () => {
    const defined = [...allTables().keys()].sort();
    const listed = backupTables().map((table) => table.name);
    expect(new Set(listed).size).toBe(listed.length);
    for (const name of EXCLUDED_TABLES) expect(defined).toContain(name);
    expect([...listed, ...EXCLUDED_TABLES].sort()).toEqual(defined);

    const position = new Map(listed.map((name, index) => [name, index]));
    for (const name of listed) {
      const table = allTables().get(name)!;
      for (const key of getTableConfig(table).foreignKeys) {
        const parent = getTableConfig(key.reference().foreignTable).name;
        if (parent === name || !position.has(parent)) continue;
        expect(position.get(parent)!).toBeLessThan(position.get(name)!);
      }
    }
    expect(
      backupTables().find((table) => table.name === "people"),
    ).toMatchObject({ primaryKey: ["id"] });
  });

  it("marks blobs", () => {
    expect(
      rowLine({
        __saasmail_rowid: 1,
        id: "a",
        data: new Uint8Array([1, 2, 3]),
      }),
    ).toBe('{"id":"a","data":{"$blob":"AQID"}}\n');
  });
});

describe("a backup run", () => {
  beforeEach(async () => {
    await createTestUser({ id: "admin-1" });
    for (let i = 0; i < 10; i++) {
      await createTestPerson({ id: `p${i}`, email: `p${i}@example.com` });
    }
    await createTestEmail({ id: "e1", personId: "p1" });
  });

  it("writes one file per table and a manifest with hashes", async () => {
    const run = await startBackup(getDb(), env, "admin-1");
    expect(run.prefix).toMatch(/^backups\/\d{4}-\d\d-\d\dT\d{4}Z-/);
    await runAll(run.id);
    const done = await runRow(run.id);
    expect(done.status).toBe("completed");
    const manifest = await manifestOf(run.prefix);
    expect(manifest).toMatchObject({
      format: 1,
      encryption: null,
      compression: "gzip",
    });
    expect(manifest.tables.map((table) => table.name)).toEqual(
      backupTables().map((table) => table.name),
    );
    const peopleFile = manifest.tables.find((t) => t.name === "people")!;
    expect(peopleFile).toMatchObject({ rows: 10, file: "people.ndjson.gz" });
    const lines = await linesOf(run.prefix, peopleFile.file);
    expect(lines.map((line) => line.id).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `p${i}`).sort(),
    );
    expect(lines[0]).toHaveProperty("unread_count");

    // Each part's hash matches the file's bytes.
    const object = await env.R2.get(`${run.prefix}${peopleFile.file}`);
    const bytes = new Uint8Array(await object!.arrayBuffer());
    let at = 0;
    for (const part of peopleFile.parts) {
      expect(await sha256Hex(bytes.subarray(at, at + part.bytes))).toBe(
        part.sha256,
      );
      at += part.bytes;
    }
    expect(at).toBe(bytes.length);

    // An empty table still has a file, with no lines.
    const empty = manifest.tables.find((t) => t.name === "campaigns")!;
    expect(empty.rows).toBe(0);
    expect(await linesOf(run.prefix, empty.file)).toEqual([]);
    // Left out: sessions, for one.
    expect(manifest.excluded).toContain("sessions");
    expect(await env.R2.head(`${run.prefix}sessions.ndjson.gz`)).toBeNull();
    const sum = await env.R2.get(`${run.prefix}manifest.sha256`);
    const manifestBytes = new Uint8Array(
      await (await env.R2.get(`${run.prefix}manifest.json`))!.arrayBuffer(),
    );
    expect(await sum!.text()).toBe(
      `${await sha256Hex(manifestBytes)}  manifest.json\n`,
    );
    // Nothing is left over but the files.
    const listed = await env.R2.list({ prefix: `${run.prefix}.pending/` });
    expect(listed.objects).toEqual([]);
  });

  it("works in steps, and a failed step resumes without writing rows twice", async () => {
    const limits = { ...BACKUP_LIMITS };
    BACKUP_LIMITS.stepRows = 3;
    BACKUP_LIMITS.pageSize = 3;
    onTestFinished(() => {
      Object.assign(BACKUP_LIMITS, limits);
    });
    const run = await startBackup(getDb(), env, null);
    // Steps until one starts inside people, after its first page.
    let step: number | null = 0;
    for (let guard = 0; guard < 500; guard++) {
      const progress = backupProgress(await runRow(run.id));
      if (progress.current?.name === "people" && progress.current.rows > 0) {
        break;
      }
      step = await runBackupStep(getDb(), env, run.id, step!);
      expect(step).not.toBeNull();
    }
    const before = backupProgress(await runRow(run.id)).current!.rows;
    expect(before).toBeGreaterThan(0);
    // This step reads a page, then dies saving it: its second D1 update
    // (the first is its claim) throws.
    const db = getDb();
    let updates = 0;
    const dying = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "update") {
          return (table: typeof backupRuns) => {
            if (++updates === 2) throw new Error("worker died");
            return target.update(table);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(runBackupStep(dying, env, run.id, step!)).rejects.toThrow(
      "worker died",
    );
    expect(backupProgress(await runRow(run.id)).current!.rows).toBe(before);
    let steps = 0;
    while (step !== null && steps++ < 500) {
      step = await runBackupStep(getDb(), env, run.id, step);
    }
    expect((await runRow(run.id)).status).toBe("completed");
    const manifest = await manifestOf(run.prefix);
    const lines = await linesOf(run.prefix, "people.ndjson.gz");
    expect(lines).toHaveLength(10);
    expect(new Set(lines.map((line) => line.id)).size).toBe(10);
    expect(manifest.tables.find((t) => t.name === "people")!.rows).toBe(10);
    expect(
      (await env.R2.list({ prefix: `${run.prefix}.pending/` })).objects,
    ).toEqual([]);
  });

  it("reads a table larger than a page whole", async () => {
    // 150 people: more than the first page of 100, so the page grows.
    for (let i = 10; i < 150; i++) {
      await createTestPerson({ id: `p${i}`, email: `p${i}@example.com` });
    }
    const run = await startBackup(getDb(), env, null);
    await runAll(run.id);
    expect(await linesOf(run.prefix, "people.ndjson.gz")).toHaveLength(150);
  });

  it("uploads a large table in equal parts", async () => {
    // Bodies that do not compress: about 9 MB of text.
    for (let i = 0; i < 30; i++) {
      const random = new Uint8Array(225_000);
      for (let at = 0; at < random.length; at += 65_536) {
        crypto.getRandomValues(random.subarray(at, at + 65_536));
      }
      let binary = "";
      for (const byte of random) binary += String.fromCharCode(byte);
      await createTestEmail({
        id: `big-${i}`,
        personId: "p1",
        messageId: `<big-${i}@example.com>`,
        bodyText: btoa(binary),
      });
    }
    const run = await startBackup(getDb(), env, null);
    await runAll(run.id);
    const manifest = await manifestOf(run.prefix);
    const emailsFile = manifest.tables.find((t) => t.name === "emails")!;
    expect(emailsFile.rows).toBe(31);
    expect(emailsFile.parts.length).toBeGreaterThanOrEqual(2);
    expect(emailsFile.parts[0].bytes).toBe(5 * 1024 * 1024);
    const object = await env.R2.get(`${run.prefix}${emailsFile.file}`);
    expect(object!.size).toBe(
      emailsFile.parts.reduce((n, part) => n + part.bytes, 0),
    );
    expect(await linesOf(run.prefix, emailsFile.file)).toHaveLength(31);
  });

  it("encrypts every file when a key is set", async () => {
    (env as any).BACKUP_ENCRYPTION_KEY = "ab".repeat(32);
    onTestFinished(() => {
      delete (env as any).BACKUP_ENCRYPTION_KEY;
    });
    const key = (await backupKey(env))!;
    const run = await startBackup(getDb(), env, null);
    await runAll(run.id);
    const manifest = await manifestOf(run.prefix);
    expect(manifest.encryption).toBe("aes-256-gcm-frames");
    const file = manifest.tables.find((t) => t.name === "people")!.file;
    expect(file).toBe("people.ndjson.gz.enc");
    expect(await linesOf(run.prefix, file, key)).toHaveLength(10);
    // Without the key it is not gzip.
    const raw = new Uint8Array(
      await (await env.R2.get(`${run.prefix}${file}`))!.arrayBuffer(),
    );
    expect(() => gunzipSync(raw)).toThrow();
  });

  it("spans steps with uploaded parts and carried bytes, and a retry after completing", async () => {
    for (let i = 0; i < 20; i++) {
      const random = new Uint8Array(150_000);
      for (let at = 0; at < random.length; at += 65_536) {
        crypto.getRandomValues(random.subarray(at, at + 65_536));
      }
      let binary = "";
      for (const byte of random) binary += String.fromCharCode(byte);
      await createTestEmail({
        id: `wide-${i}`,
        personId: "p1",
        messageId: `<wide-${i}@example.com>`,
        bodyText: btoa(binary),
      });
    }
    const limits = { ...BACKUP_LIMITS };
    // Pages of about 1 MB, steps of about 6 MB: the emails table (about
    // 4 MB compressed... of random text, so about 3 MB) spans steps.
    BACKUP_LIMITS.pageBytes = 1024 * 1024;
    BACKUP_LIMITS.stepBytes = 2 * 1024 * 1024;
    BACKUP_LIMITS.chunkBytes = 512 * 1024;
    onTestFinished(() => {
      Object.assign(BACKUP_LIMITS, limits);
    });
    const run = await startBackup(getDb(), env, null);
    let step: number | null = 0;
    let sawCarried = false;
    for (let guard = 0; guard < 500 && step !== null; guard++) {
      const progress = backupProgress(await runRow(run.id));
      if (progress.current?.name === "emails" && progress.current.pendingKey) {
        sawCarried = true;
      }
      // When emails is done writing rows, the next step completes the file:
      // make that step die after completing, before recording it.
      if (progress.current?.name === "emails" && progress.current.finishing) {
        const db = getDb();
        let updates = 0;
        const dying = new Proxy(db, {
          get(target, property, receiver) {
            if (property === "update") {
              return (table: typeof backupRuns) => {
                if (++updates === 2) throw new Error("worker died");
                return target.update(table);
              };
            }
            return Reflect.get(target, property, receiver);
          },
        });
        await expect(runBackupStep(dying, env, run.id, step)).rejects.toThrow(
          "worker died",
        );
        expect(
          await env.R2.head(`${run.prefix}emails.ndjson.gz`),
        ).not.toBeNull();
      }
      step = await runBackupStep(getDb(), env, run.id, step);
    }
    expect(sawCarried).toBe(true);
    expect((await runRow(run.id)).status).toBe("completed");
    const manifest = await manifestOf(run.prefix);
    const emailsFile = manifest.tables.find((t) => t.name === "emails")!;
    expect(emailsFile.rows).toBe(21);
    const lines = await linesOf(run.prefix, emailsFile.file);
    expect(lines.map((line) => line.id).sort()).toEqual(
      ["e1", ...Array.from({ length: 20 }, (_, i) => `wide-${i}`)].sort(),
    );
    const object = await env.R2.get(`${run.prefix}${emailsFile.file}`);
    const bytes = new Uint8Array(await object!.arrayBuffer());
    let at = 0;
    for (const part of emailsFile.parts) {
      expect(await sha256Hex(bytes.subarray(at, at + part.bytes))).toBe(
        part.sha256,
      );
      at += part.bytes;
    }
    expect(at).toBe(bytes.length);
  });

  it("fails a backup whose key changed mid-run", async () => {
    (env as any).BACKUP_ENCRYPTION_KEY = "ab".repeat(32);
    onTestFinished(() => {
      delete (env as any).BACKUP_ENCRYPTION_KEY;
    });
    const limits = { ...BACKUP_LIMITS };
    BACKUP_LIMITS.stepRows = 3;
    onTestFinished(() => {
      Object.assign(BACKUP_LIMITS, limits);
    });
    const run = await startBackup(getDb(), env, null);
    expect(await runBackupStep(getDb(), env, run.id, 0)).toBe(1);
    (env as any).BACKUP_ENCRYPTION_KEY = "cd".repeat(32);
    await expect(runBackupStep(getDb(), env, run.id, 1)).rejects.toThrow(
      "BACKUP_ENCRYPTION_KEY changed during the backup",
    );
  });

  it("runs one backup at a time, and a failed one leaves no files", async () => {
    const limits = { ...BACKUP_LIMITS };
    BACKUP_LIMITS.stepRows = 3;
    onTestFinished(() => {
      Object.assign(BACKUP_LIMITS, limits);
    });
    const run = await startBackup(getDb(), env, null);
    await expect(startBackup(getDb(), env, null)).rejects.toThrow(
      "A backup is already running",
    );
    expect(await runBackupStep(getDb(), env, run.id, 0)).toBe(1);
    await failBackup(getDb(), env, run.id, "disk on fire");
    expect(await runRow(run.id)).toMatchObject({
      status: "failed",
      error: "disk on fire",
    });
    expect((await env.R2.list({ prefix: run.prefix })).objects).toEqual([]);
    const audit = await getDb().all<{ action: string }>(
      sql`SELECT action FROM audit_events WHERE action LIKE 'backup.%' ORDER BY rowid`,
    );
    expect(audit.map((row) => row.action)).toEqual([
      "backup.started",
      "backup.failed",
    ]);
  });
});

describe("the schedule", () => {
  const queue = (env as any).EMAIL_QUEUE;
  let sent: unknown[];

  beforeEach(() => {
    sent = [];
    (env as any).EMAIL_QUEUE = {
      send: async (body: unknown) => void sent.push(body),
    };
  });

  afterEach(() => {
    (env as any).EMAIL_QUEUE = queue;
  });

  const at = (iso: string) => Date.parse(iso) / 1000;

  it("knows when the next backup is due", () => {
    const base = { enabled: true, hourUtc: 3, keepDays: 14 };
    expect(
      nextBackupDue({ ...base, lastStarted: null }, at("2026-10-04T01:00:00Z")),
    ).toBe(at("2026-10-04T03:00:00Z"));
    expect(
      nextBackupDue(
        { ...base, lastStarted: at("2026-10-04T03:05:00Z") },
        at("2026-10-04T10:00:00Z"),
      ),
    ).toBe(at("2026-10-05T03:00:00Z"));
  });

  it("starts the daily backup at its hour, once, and only when on", async () => {
    expect(
      (await runBackupSchedule(getDb(), env, at("2026-10-04T05:00:00Z")))
        .started,
    ).toBeNull();
    await updateBackupSettings(getDb(), { enabled: true, hourUtc: 6 });
    expect(
      (await runBackupSchedule(getDb(), env, at("2026-10-04T05:00:00Z")))
        .started,
    ).toBeNull();
    const first = await runBackupSchedule(
      getDb(),
      env,
      at("2026-10-04T06:00:00Z"),
    );
    expect(first.started).not.toBeNull();
    expect(sent).toEqual([
      { type: "backup_step", runId: first.started, step: 0 },
    ]);
    expect((await readBackupSettings(getDb())).lastStarted).toBe(
      at("2026-10-04T06:00:00Z"),
    );
    await getDb()
      .update(backupRuns)
      .set({ status: "completed" })
      .where(eq(backupRuns.id, first.started!));
    expect(
      (await runBackupSchedule(getDb(), env, at("2026-10-04T07:00:00Z")))
        .started,
    ).toBeNull();
    expect(
      (await runBackupSchedule(getDb(), env, at("2026-10-05T06:00:00Z")))
        .started,
    ).not.toBeNull();
  });

  it("queues a stuck run again once, and fails it after a day", async () => {
    const run = await startBackup(getDb(), env, null);
    const now = run.startedAt;
    await getDb()
      .update(backupRuns)
      .set({ updatedAt: now - 3 * 60 * 60 })
      .where(eq(backupRuns.id, run.id));
    expect((await runBackupSchedule(getDb(), env, now)).resumed).toBe(1);
    expect(sent).toEqual([{ type: "backup_step", runId: run.id, step: 0 }]);
    await getDb()
      .update(backupRuns)
      .set({ updatedAt: now - 3 * 60 * 60 })
      .where(eq(backupRuns.id, run.id));
    expect((await runBackupSchedule(getDb(), env, now)).resumed).toBe(0);
    await getDb()
      .update(backupRuns)
      .set({ updatedAt: now - 25 * 60 * 60 })
      .where(eq(backupRuns.id, run.id));
    expect((await runBackupSchedule(getDb(), env, now)).failed).toBe(1);
    expect((await runRow(run.id)).status).toBe("failed");
  });

  it("deletes the files of backups older than the retention", async () => {
    await updateBackupSettings(getDb(), { keepDays: 7 });
    const now = Math.floor(Date.now() / 1000);
    const insert = async (id: string, startedAt: number) => {
      await getDb()
        .insert(backupRuns)
        .values({
          id,
          startedAt,
          status: "completed",
          prefix: `backups/${id}/`,
          progress: JSON.stringify({ step: 0, tables: [], done: [] }),
          bytes: 1,
          updatedAt: startedAt,
        });
      await env.R2.put(`backups/${id}/manifest.json`, "{}");
    };
    await insert("old", now - 8 * 24 * 60 * 60);
    await insert("new", now - 6 * 24 * 60 * 60);
    expect(await pruneBackups(getDb(), env, now)).toBe(1);
    // However old, the newest completed backup stays.
    await getDb()
      .update(backupRuns)
      .set({ startedAt: now - 30 * 24 * 60 * 60 })
      .where(eq(backupRuns.id, "new"));
    expect(await pruneBackups(getDb(), env, now)).toBe(0);
    expect(await env.R2.head("backups/new/manifest.json")).not.toBeNull();
    expect(await env.R2.head("backups/old/manifest.json")).toBeNull();
    expect(await env.R2.head("backups/new/manifest.json")).not.toBeNull();
    expect((await runRow("old")).prunedAt).toBe(now);
    expect((await runRow("new")).prunedAt).toBeNull();
  });
});

describe("the backups API", () => {
  const queue = (env as any).EMAIL_QUEUE;
  let sent: unknown[];
  let adminKey: string;
  let memberKey: string;

  beforeEach(async () => {
    sent = [];
    (env as any).EMAIL_QUEUE = {
      send: async (body: unknown) => void sent.push(body),
    };
    ({ apiKey: adminKey } = await createTestUser({
      id: "admin-1",
      email: "admin@example.com",
    }));
    ({ apiKey: memberKey } = await createTestUser({
      id: "user-aa",
      role: "member",
      email: "aa@example.com",
    }));
  });

  afterEach(() => {
    (env as any).EMAIL_QUEUE = queue;
  });

  it("is for admins: settings, run now, manifest", async () => {
    expect(
      (await authFetch("/api/admin/backups", { apiKey: memberKey })).status,
    ).toBe(403);

    const view = await authFetch("/api/admin/backups", { apiKey: adminKey });
    expect(await view.json()).toMatchObject({
      settings: { enabled: false, hourUtc: 3, keepDays: 14, nextDue: null },
      destination: "R2",
      encryption: "not_configured",
      runs: [],
    });

    const patched = await authFetch("/api/admin/backups/settings", {
      method: "PATCH",
      apiKey: adminKey,
      body: JSON.stringify({ enabled: true, hourUtc: 4, keepDays: 30 }),
    });
    expect(await patched.json()).toMatchObject({
      enabled: true,
      hourUtc: 4,
      keepDays: 30,
    });
    expect(
      (
        await authFetch("/api/admin/backups/settings", {
          method: "PATCH",
          apiKey: adminKey,
          body: JSON.stringify({ hourUtc: 24 }),
        })
      ).status,
    ).toBe(400);

    const started = await authFetch("/api/admin/backups/run", {
      method: "POST",
      apiKey: adminKey,
    });
    expect(started.status).toBe(202);
    const run = (await started.json()) as { id: string; manual: boolean };
    expect(run.manual).toBe(true);
    expect(sent).toEqual([{ type: "backup_step", runId: run.id, step: 0 }]);
    expect(
      (
        await authFetch("/api/admin/backups/run", {
          method: "POST",
          apiKey: adminKey,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await authFetch(`/api/admin/backups/${run.id}/manifest`, {
          apiKey: adminKey,
        })
      ).status,
    ).toBe(404);

    await runAll(run.id);
    const manifest = await authFetch(`/api/admin/backups/${run.id}/manifest`, {
      apiKey: adminKey,
    });
    expect(manifest.status).toBe(200);
    expect(((await manifest.json()) as BackupManifest).format).toBe(1);
    const listed = (await (
      await authFetch("/api/admin/backups", { apiKey: adminKey })
    ).json()) as { runs: { id: string; status: string; tablesDone: number }[] };
    expect(listed.runs[0]).toMatchObject({ id: run.id, status: "completed" });
    expect(listed.runs[0].tablesDone).toBe(backupTables().length);
    const changes = await getDb().all<{ action: string }>(
      sql`SELECT action FROM audit_events WHERE target_id = 'backups'`,
    );
    expect(changes).toHaveLength(1);
  });

  it("refuses to start with a malformed key", async () => {
    (env as any).BACKUP_ENCRYPTION_KEY = "not-hex";
    onTestFinished(() => {
      delete (env as any).BACKUP_ENCRYPTION_KEY;
    });
    const res = await authFetch("/api/admin/backups/run", {
      method: "POST",
      apiKey: adminKey,
    });
    expect(res.status).toBe(400);
    expect(
      classifyQueueMessage({ type: "backup_step", runId: "r", step: 0 }),
    ).toBe("backup_step");
  });
});
