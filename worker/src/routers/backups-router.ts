import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { desc, eq, sql } from "drizzle-orm";
import { backupRuns, type BackupRun } from "../db/backup-runs.schema";
import { backupKey } from "../lib/backup/crypto";
import {
  BackupRunningError,
  backupBucket,
  backupProgress,
  resumeBackup,
  runBackupInline,
  startBackup,
} from "../lib/backup/run";
import {
  MAX_KEEP_DAYS,
  nextBackupDue,
  readBackupSettings,
  updateBackupSettings,
} from "../lib/backup/settings";
import { isDemoMode } from "../lib/is-dev";
import { bearerSecurity } from "../lib/openapi-auth";
import type { Variables } from "../variables";

/** Admin only: mounted under `/api/admin`. */
export const backupsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const ErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
});
const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

const RunSchema = z.object({
  id: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  prefix: z.string(),
  bytes: z.number().int(),
  /** Tables written so far, and how many there are. */
  tablesDone: z.number().int(),
  tablesTotal: z.number().int(),
  rows: z.number().int(),
  encrypted: z.boolean(),
  error: z.string().nullable(),
  /** "Back up now" rather than the schedule. */
  manual: z.boolean(),
  /** Retention deleted its files. */
  prunedAt: z.number().int().nullable(),
});

const SettingsSchema = z.object({
  enabled: z.boolean(),
  hourUtc: z.number().int(),
  keepDays: z.number().int(),
  lastStarted: z.number().int().nullable(),
  nextDue: z.number().int().nullable(),
});

function serializeRun(run: BackupRun) {
  const progress = backupProgress(run);
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    prefix: run.prefix,
    bytes: run.bytes,
    tablesDone: progress.done.length,
    tablesTotal: progress.tables.length,
    rows: progress.done.reduce((n, table) => n + table.rows, 0),
    encrypted: progress.encrypted,
    error: run.error,
    manual: run.requestedBy !== null,
    prunedAt: run.prunedAt,
  };
}

async function settingsView(db: Variables["db"]) {
  const settings = await readBackupSettings(db);
  const now = Math.floor(Date.now() / 1000);
  return {
    ...settings,
    nextDue: settings.enabled ? nextBackupDue(settings, now) : null,
  };
}

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin Backups"],
  security: bearerSecurity,
  description:
    "The backup schedule, where backups go, whether they are encrypted, and the last 30 runs.",
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "Backups",
      content: {
        "application/json": {
          schema: z.object({
            settings: SettingsSchema,
            destination: z.enum(["BACKUPS", "R2"]),
            encryption: z.enum(["configured", "not_configured", "invalid"]),
            runs: z.array(RunSchema),
          }),
        },
      },
    },
  },
});

backupsRouter.openapi(listRoute, async (c) => {
  const db = c.get("db");
  let encryption: "configured" | "not_configured" | "invalid";
  try {
    encryption = (await backupKey(c.env)) ? "configured" : "not_configured";
  } catch {
    encryption = "invalid";
  }
  const runs = await db
    .select()
    .from(backupRuns)
    .orderBy(desc(backupRuns.startedAt), sql`rowid DESC`)
    .limit(30);
  return c.json(
    {
      settings: await settingsView(db),
      destination: c.env.BACKUPS ? ("BACKUPS" as const) : ("R2" as const),
      encryption,
      runs: runs.map(serializeRun),
    },
    200,
  );
});

const settingsRoute = createRoute({
  method: "patch",
  path: "/settings",
  tags: ["Admin Backups"],
  security: bearerSecurity,
  description:
    "Turn scheduled backups on or off, and set the UTC hour they start at and how many days their files are kept. Fields left out are unchanged.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            enabled: z.boolean().optional(),
            hourUtc: z.number().int().min(0).max(23).optional(),
            keepDays: z.number().int().min(1).max(MAX_KEEP_DAYS).optional(),
          }),
        },
      },
    },
  },
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "The schedule",
      content: { "application/json": { schema: SettingsSchema } },
    },
  },
});

backupsRouter.openapi(settingsRoute, async (c) => {
  const db = c.get("db");
  await updateBackupSettings(db, c.req.valid("json"));
  return c.json(await settingsView(db), 200);
});

const runNowRoute = createRoute({
  method: "post",
  path: "/run",
  tags: ["Admin Backups"],
  security: bearerSecurity,
  description: "Back up now, whether or not the schedule is on.",
  responses: {
    500: { description: "Internal server error" },
    202: {
      description: "Started",
      content: { "application/json": { schema: RunSchema } },
    },
    400: errorResponse("BACKUP_ENCRYPTION_KEY is not 64 hex characters"),
    409: errorResponse("A backup is already running"),
  },
});

backupsRouter.openapi(runNowRoute, async (c) => {
  const db = c.get("db");
  try {
    await backupKey(c.env);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Invalid key",
        code: "INVALID_KEY",
      },
      400,
    );
  }
  let run: BackupRun;
  try {
    run = await startBackup(db, c.env, c.get("user").id);
  } catch (error) {
    if (error instanceof BackupRunningError) {
      return c.json({ error: error.message, code: error.code }, 409);
    }
    throw error;
  }
  if (isDemoMode(c.env)) {
    // Demo deployments have no queue consumer (the hourly run finishes a
    // backup that outlives the request).
    c.executionCtx.waitUntil(runBackupInline(db, c.env, run.id));
  } else {
    await resumeBackup(db, c.env, run.id, 0);
  }
  return c.json(serializeRun(run), 202);
});

const manifestRoute = createRoute({
  method: "get",
  path: "/{id}/manifest",
  tags: ["Admin Backups"],
  security: bearerSecurity,
  description:
    "A finished backup's manifest: its tables with row counts, sizes and SHA-256 of each part, the last migration and whether it is encrypted. The files themselves are fetched from the bucket, not through the Worker.",
  request: { params: z.object({ id: z.string().min(1).max(64) }) },
  responses: {
    500: { description: "Internal server error" },
    200: { description: "The manifest" },
    404: errorResponse("No such backup, or its files were deleted"),
  },
});

backupsRouter.openapi(manifestRoute, async (c) => {
  const [run] = await c
    .get("db")
    .select()
    .from(backupRuns)
    .where(eq(backupRuns.id, c.req.valid("param").id))
    .limit(1);
  if (!run || run.status !== "completed" || run.prunedAt !== null) {
    return c.json({ error: "Backup not found" }, 404);
  }
  const object = await backupBucket(c.env).get(`${run.prefix}manifest.json`);
  if (!object) return c.json({ error: "Backup not found" }, 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    },
  });
});
