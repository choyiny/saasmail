import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, sql } from "drizzle-orm";
import { asyncJobs, type AsyncJob } from "../db/async-jobs.schema";
import {
  IMPORT_PART_BYTES,
  ImportRequestError,
  MAX_IMPORT_BYTES,
  completeImportUpload,
  deleteMailImport,
  expectedParts,
  importJobById,
  importParams,
  resumeMailImport,
  runMailImportInline,
  startMailImport,
  uploadImportPart,
} from "../lib/import/mail-import";
import { isDemoMode } from "../lib/is-dev";
import { bearerSecurity } from "../lib/openapi-auth";
import type { Variables } from "../variables";

/** Admin only: mounted under `/api/admin`. */
export const importsRouter = new OpenAPIHono<{
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

const ImportSchema = z.object({
  id: z.string(),
  inbox: z.string(),
  filename: z.string(),
  status: z.enum([
    "uploading",
    "running",
    "completed",
    "failed",
    "cancelled",
    "expired",
  ]),
  /** Bytes of the file. */
  size: z.number().int(),
  /** Bytes read so far. */
  bytesRead: z.number().int(),
  processedMessages: z.number().int(),
  importedMessages: z.number().int(),
  skippedMessages: z.number().int(),
  direction: z.enum(["strict", "all_received"]),
  createFoldersFromLabels: z.boolean(),
  /** The upload's part size, and how many parts it takes and has. */
  partSize: z.number().int(),
  partsExpected: z.number().int(),
  partsUploaded: z.number().int(),
  /** The first 50 skipped messages and dropped attachments, by message number. */
  notes: z.array(z.object({ row: z.number().int(), reason: z.string() })),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

function serializeImport(job: AsyncJob) {
  const params = importParams(job);
  let notes: { row: number; reason: string }[] = [];
  try {
    notes = job.errorSummary ? JSON.parse(job.errorSummary) : [];
  } catch {
    notes = [];
  }
  return {
    id: job.id,
    inbox: job.refId,
    filename: params.filename,
    status: job.status,
    size: params.size,
    bytesRead: Math.min(Number(job.cursor ?? "0"), params.size),
    processedMessages: job.processedRows,
    importedMessages: job.importedCount,
    skippedMessages: job.skippedCount,
    direction: params.direction,
    createFoldersFromLabels: params.createFoldersFromLabels,
    partSize: IMPORT_PART_BYTES,
    partsExpected: expectedParts(params.size),
    partsUploaded: params.parts.length,
    notes,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function requestError(error: unknown) {
  if (error instanceof ImportRequestError) {
    return { error: error.message, code: error.code };
  }
  return null;
}

const createImportRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin Imports"],
  security: bearerSecurity,
  description: `Start importing an mbox or .eml file into an inbox. Upload the file in parts of ${IMPORT_PART_BYTES} bytes (the last smaller) with \`PUT /{id}/parts/{n}\`, then \`POST /{id}/complete\`. Imported mail is read history: no rules, notifications, webhooks or forwards.`,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            inbox: z
              .string()
              .trim()
              .regex(/^[^\s<>"@]+@[^\s<>"@]+\.[^\s<>"@]+$/, "Not an address")
              .max(320),
            filename: z.string().trim().min(1).max(200),
            size: z.number().int().min(1).max(MAX_IMPORT_BYTES),
            direction: z.enum(["strict", "all_received"]).default("strict"),
            createFoldersFromLabels: z.boolean().default(true),
          }),
        },
      },
    },
  },
  responses: {
    500: { description: "Internal server error" },
    201: {
      description: "The import, waiting for its upload",
      content: { "application/json": { schema: ImportSchema } },
    },
    400: errorResponse("Invalid request"),
  },
});

importsRouter.openapi(createImportRoute, async (c) => {
  const input = c.req.valid("json");
  const db = c.get("db");
  const inbox = input.inbox.toLowerCase();
  // Only into an inbox: an address with a sender identity or mail.
  const known = await db.all(sql`
    SELECT 1 FROM sender_identities WHERE lower(email) = ${inbox}
    UNION ALL
    SELECT 1 FROM emails WHERE recipient = ${inbox}
    LIMIT 1
  `);
  if (known.length === 0) {
    return c.json(
      { error: `${inbox} is not an inbox`, code: "UNKNOWN_INBOX" },
      400,
    );
  }
  const job = await startMailImport(db, c.env, {
    ...input,
    inbox,
    userId: c.get("user").id,
  });
  return c.json(serializeImport(job), 201);
});

const IdParams = z.object({ id: z.string().min(1).max(64) });

const uploadPartRoute = createRoute({
  method: "put",
  path: "/{id}/parts/{n}",
  tags: ["Admin Imports"],
  security: bearerSecurity,
  description: `One part of the file, as the raw request body: exactly ${IMPORT_PART_BYTES} bytes, the last part what is left. Sending a part again replaces it.`,
  request: {
    params: IdParams.extend({ n: z.coerce.number().int().min(1).max(10_000) }),
  },
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "Stored",
      content: {
        "application/json": {
          schema: z.object({
            partNumber: z.number().int(),
            partsUploaded: z.number().int(),
          }),
        },
      },
    },
    400: errorResponse("Wrong size, out of range, or not uploading"),
    404: errorResponse("No such import"),
    413: errorResponse("Larger than a part"),
  },
});

importsRouter.openapi(uploadPartRoute, async (c) => {
  const { id, n } = c.req.valid("param");
  const db = c.get("db");
  const job = await importJobById(db, id);
  if (!job) return c.json({ error: "Import not found" }, 404);
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > IMPORT_PART_BYTES) {
    return c.json(
      { error: "A part is at most 32 MiB", code: "PART_TOO_LARGE" },
      413,
    );
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length > IMPORT_PART_BYTES) {
    return c.json(
      { error: "A part is at most 32 MiB", code: "PART_TOO_LARGE" },
      413,
    );
  }
  try {
    await uploadImportPart(db, c.env, job, n, bytes);
  } catch (error) {
    const mapped = requestError(error);
    if (mapped) return c.json(mapped, 400);
    throw error;
  }
  const updated = await importJobById(db, id);
  return c.json(
    {
      partNumber: n,
      partsUploaded: updated ? importParams(updated).parts.length : 0,
    },
    200,
  );
});

const completeRoute = createRoute({
  method: "post",
  path: "/{id}/complete",
  tags: ["Admin Imports"],
  security: bearerSecurity,
  description:
    "The upload is whole: the import starts in the background. 400 `PARTS_MISSING` names the parts not uploaded yet.",
  request: { params: IdParams },
  responses: {
    500: { description: "Internal server error" },
    202: {
      description: "Importing",
      content: { "application/json": { schema: ImportSchema } },
    },
    400: errorResponse("Parts missing, or not uploading"),
    404: errorResponse("No such import"),
  },
});

importsRouter.openapi(completeRoute, async (c) => {
  const db = c.get("db");
  const job = await importJobById(db, c.req.valid("param").id);
  if (!job) return c.json({ error: "Import not found" }, 404);
  let started: AsyncJob;
  try {
    started = await completeImportUpload(db, c.env, job);
  } catch (error) {
    const mapped = requestError(error);
    if (mapped) return c.json(mapped, 400);
    throw error;
  }
  if (isDemoMode(c.env)) {
    // Demo deployments have no queue consumer: run the slices here (the
    // hourly run finishes one that outlives the request).
    c.executionCtx.waitUntil(runMailImportInline(db, c.env, started.id));
  } else {
    await resumeMailImport(db, c.env, started.id, 0);
  }
  return c.json(serializeImport(started), 202);
});

const listImportsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin Imports"],
  security: bearerSecurity,
  description: "Mail imports, newest first (the last 50).",
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "Imports",
      content: {
        "application/json": {
          schema: z.object({ imports: z.array(ImportSchema) }),
        },
      },
    },
  },
});

importsRouter.openapi(listImportsRoute, async (c) => {
  const rows = await c
    .get("db")
    .select()
    .from(asyncJobs)
    .where(and(eq(asyncJobs.jobType, "mail_import")))
    // Newest first; rowid orders two started in the same second.
    .orderBy(desc(asyncJobs.createdAt), sql`rowid DESC`)
    .limit(50);
  return c.json({ imports: rows.map(serializeImport) }, 200);
});

const getImportRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Admin Imports"],
  security: bearerSecurity,
  description: "One import, with its progress.",
  request: { params: IdParams },
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "Import",
      content: { "application/json": { schema: ImportSchema } },
    },
    404: errorResponse("No such import"),
  },
});

importsRouter.openapi(getImportRoute, async (c) => {
  const job = await importJobById(c.get("db"), c.req.valid("param").id);
  if (!job) return c.json({ error: "Import not found" }, 404);
  return c.json(serializeImport(job), 200);
});

const deleteImportRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin Imports"],
  security: bearerSecurity,
  description:
    "Cancel an import (an upload is aborted; messages already imported stay), or delete a finished one's record and file.",
  request: { params: IdParams },
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "Deleted",
      content: {
        "application/json": { schema: z.object({ deleted: z.boolean() }) },
      },
    },
    404: errorResponse("No such import"),
  },
});

importsRouter.openapi(deleteImportRoute, async (c) => {
  const job = await importJobById(c.get("db"), c.req.valid("param").id);
  if (!job) return c.json({ error: "Import not found" }, 404);
  await deleteMailImport(c.get("db"), c.env, job);
  return c.json({ deleted: true }, 200);
});
