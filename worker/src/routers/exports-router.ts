import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, sql } from "drizzle-orm";
import { asyncJobs, type AsyncJob } from "../db/async-jobs.schema";
import { AUDIT_ACTIONS } from "../lib/audit/events";
import { recordAudit } from "../lib/audit/record";
import {
  EXPORT_TTL_SECONDS,
  ExportRunningError,
  deleteMailExport,
  exportParams,
  runMailExportInline,
  startMailExport,
  type MailExportMessage,
} from "../lib/export/mail-export";
import { isInboxAllowed, type AllowedInboxes } from "../lib/inbox-permissions";
import { isDemoMode } from "../lib/is-dev";
import { bearerSecurity } from "../lib/openapi-auth";
import type { Variables } from "../variables";

export const exportsRouter = new OpenAPIHono<{
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

const ExportSchema = z.object({
  id: z.string(),
  inbox: z.string(),
  status: z.enum(["running", "completed", "failed", "cancelled", "expired"]),
  /** Messages written so far; all of them once completed. */
  processedMessages: z.number().int(),
  totalMessages: z.number().int().nullable(),
  /** Bytes written so far; the file's size once completed. */
  bytes: z.number().int(),
  from: z.number().int().nullable(),
  to: z.number().int().nullable(),
  includeTrash: z.boolean(),
  includeCampaignSends: z.boolean(),
  requestedBy: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /** Completed exports: when the file is deleted. */
  expiresAt: z.number().int().nullable(),
  error: z.string().nullable(),
});

function serializeExport(job: AsyncJob) {
  const params = exportParams(job);
  let error: string | null = null;
  if (job.errorSummary) {
    try {
      const [first] = JSON.parse(job.errorSummary) as { reason?: string }[];
      error = first?.reason ?? null;
    } catch {
      error = null;
    }
  }
  return {
    id: job.id,
    inbox: job.refId,
    status: job.status,
    processedMessages: job.processedRows,
    totalMessages: job.totalRows,
    bytes: params.bytes ?? 0,
    from: params.from ?? null,
    to: params.to ?? null,
    includeTrash: params.includeTrash === true,
    includeCampaignSends: params.includeCampaignSends === true,
    requestedBy: job.requestedBy,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt:
      job.status === "completed" ? job.updatedAt + EXPORT_TTL_SECONDS : null,
    error,
  };
}

/**
 * The export, if this caller may see it: the person who asked, while they
 * can still read the inbox, or an admin.
 */
async function readableExport(
  db: Variables["db"],
  allowed: AllowedInboxes,
  userId: string,
  id: string,
): Promise<AsyncJob | null> {
  const [job] = await db
    .select()
    .from(asyncJobs)
    .where(and(eq(asyncJobs.id, id), eq(asyncJobs.jobType, "mail_export")))
    .limit(1);
  if (!job) return null;
  if (allowed.isAdmin) return job;
  if (job.requestedBy !== userId) return null;
  return isInboxAllowed(allowed, job.refId) ? job : null;
}

const createExportRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Exports"],
  security: bearerSecurity,
  description:
    "Start exporting an inbox as one mbox file: both directions, oldest first, Trash and campaign sends only when asked. Runs in the background; poll the export or wait for the ready notice. One running export per inbox.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            inbox: z.string().min(1).max(320),
            from: z.number().int().min(0).nullable().optional().openapi({
              description: "Unix seconds: only mail on or after this time.",
            }),
            to: z.number().int().min(0).nullable().optional().openapi({
              description: "Unix seconds: only mail on or before this time.",
            }),
            includeTrash: z.boolean().optional(),
            includeCampaignSends: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    500: { description: "Internal server error" },
    202: {
      description: "Export started",
      content: { "application/json": { schema: ExportSchema } },
    },
    400: errorResponse("Invalid range"),
    403: errorResponse("Inbox not allowed"),
    409: errorResponse("An export of this inbox is already running"),
  },
});

exportsRouter.openapi(createExportRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const input = c.req.valid("json");
  const inbox = input.inbox.trim().toLowerCase();
  if (!isInboxAllowed(allowed, inbox)) {
    return c.json({ error: "Inbox not allowed" }, 403);
  }
  if (
    input.from !== null &&
    input.from !== undefined &&
    input.to !== null &&
    input.to !== undefined &&
    input.from > input.to
  ) {
    return c.json({ error: "from is after to", code: "INVALID_RANGE" }, 400);
  }

  let job: AsyncJob;
  try {
    job = await startMailExport(db, c.env, {
      ...input,
      inbox,
      userId: c.get("user").id,
    });
  } catch (error) {
    if (error instanceof ExportRunningError) {
      return c.json({ error: error.message, code: error.code }, 409);
    }
    throw error;
  }

  if (isDemoMode(c.env)) {
    // Demo deployments have no queue consumer: run the slices here.
    c.executionCtx.waitUntil(runMailExportInline(db, c.env, job.id));
  } else {
    const message: MailExportMessage = {
      type: "mail_export",
      jobId: job.id,
      slice: 0,
    };
    try {
      await c.env.EMAIL_QUEUE.send(message);
    } catch (error) {
      // Not queued: it would never run, and would block the inbox's next
      // export until the hourly run noticed.
      await deleteMailExport(db, c.env, job);
      throw error;
    }
  }
  return c.json(serializeExport(job), 202);
});

const listExportsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Exports"],
  security: bearerSecurity,
  description:
    "Mailbox exports, newest first: your own, or everyone's for an admin.",
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "Exports",
      content: {
        "application/json": {
          schema: z.object({ exports: z.array(ExportSchema) }),
        },
      },
    },
  },
});

exportsRouter.openapi(listExportsRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const rows = await db
    .select()
    .from(asyncJobs)
    .where(
      allowed.isAdmin
        ? eq(asyncJobs.jobType, "mail_export")
        : and(
            eq(asyncJobs.jobType, "mail_export"),
            eq(asyncJobs.requestedBy, c.get("user").id),
          ),
    )
    // Newest first; rowid orders two started in the same second.
    .orderBy(desc(asyncJobs.createdAt), sql`rowid DESC`)
    .limit(50);
  return c.json(
    {
      exports: rows
        .filter((job) => allowed.isAdmin || isInboxAllowed(allowed, job.refId))
        .map(serializeExport),
    },
    200,
  );
});

const IdParams = z.object({ id: z.string().min(1).max(64) });

const getExportRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Exports"],
  security: bearerSecurity,
  description: "One export, with its progress.",
  request: { params: IdParams },
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "Export",
      content: { "application/json": { schema: ExportSchema } },
    },
    404: errorResponse("Not found, or not yours"),
  },
});

exportsRouter.openapi(getExportRoute, async (c) => {
  const job = await readableExport(
    c.get("db"),
    c.get("allowedInboxes")!,
    c.get("user").id,
    c.req.valid("param").id,
  );
  if (!job) return c.json({ error: "Export not found" }, 404);
  return c.json(serializeExport(job), 200);
});

const downloadExportRoute = createRoute({
  method: "get",
  path: "/{id}/download",
  tags: ["Exports"],
  security: bearerSecurity,
  description:
    "Download a completed export as an mbox file (mboxrd). Only the person who asked for it, or an admin.",
  request: { params: IdParams },
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "The mbox file",
      content: {
        "application/mbox": {
          schema: z.string().openapi({ format: "binary" }),
        },
      },
    },
    404: errorResponse("Not found, or not yours"),
    409: errorResponse("Not completed yet"),
    410: errorResponse("Expired: the file was deleted"),
  },
});

exportsRouter.openapi(downloadExportRoute, async (c) => {
  const job = await readableExport(
    c.get("db"),
    c.get("allowedInboxes")!,
    c.get("user").id,
    c.req.valid("param").id,
  );
  if (!job) return c.json({ error: "Export not found" }, 404);
  if (job.status === "expired") {
    return c.json({ error: "This export has expired", code: "EXPIRED" }, 410);
  }
  if (job.status !== "completed" || !job.storageKey) {
    return c.json(
      { error: "This export is not ready", code: "EXPORT_NOT_READY" },
      409,
    );
  }
  const object = await c.env.R2.get(job.storageKey);
  if (!object) {
    return c.json({ error: "This export has expired", code: "EXPIRED" }, 410);
  }
  await recordAudit(c.get("db"), {
    action: AUDIT_ACTIONS.exportDownloaded,
    targetType: "export",
    targetId: job.id,
    inbox: job.refId,
    summary: `Downloaded the export of ${job.refId}`,
    details: { bytes: object.size },
  });
  const day = new Date(job.createdAt * 1000).toISOString().slice(0, 10);
  const filename = `${job.refId}-${day}.mbox`.replace(
    /[^A-Za-z0-9@._+-]/g,
    "_",
  );
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/mbox",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(object.size),
      "Cache-Control": "private, no-store",
    },
  });
});

const deleteExportRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Exports"],
  security: bearerSecurity,
  description:
    "Cancel a running export, or delete a finished one and its file.",
  request: { params: IdParams },
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "Deleted",
      content: {
        "application/json": { schema: z.object({ deleted: z.boolean() }) },
      },
    },
    404: errorResponse("Not found, or not yours"),
  },
});

exportsRouter.openapi(deleteExportRoute, async (c) => {
  const job = await readableExport(
    c.get("db"),
    c.get("allowedInboxes")!,
    c.get("user").id,
    c.req.valid("param").id,
  );
  if (!job) return c.json({ error: "Export not found" }, 404);
  await deleteMailExport(c.get("db"), c.env, job);
  return c.json({ deleted: true }, 200);
});
