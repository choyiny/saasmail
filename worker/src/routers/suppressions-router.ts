import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { suppressions } from "../db/suppressions.schema";
import { json200Response, json201Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const suppressionsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// --- Schemas ---

const SuppressionSchema = z.object({
  id: z.string(),
  email: z.string(),
  reason: z.enum(["unsubscribe", "manual"]),
  source: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.number(),
});

const ListResponseSchema = z.object({
  items: z.array(SuppressionSchema),
  nextCursor: z.string().nullable(),
});

const CreateSuppressionSchema = z.object({
  email: z.string().email(),
});

const DeleteResponseSchema = z.object({
  deleted: z.literal(true),
});

const ErrorSchema = z.object({ error: z.string() });

// --- GET /api/suppressions ---

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Suppressions"],
  description:
    "List suppressions, newest first. Cursor-based pagination via `cursor` (the `createdAt` of the last item returned).",
  request: {
    query: z.object({
      cursor: z.string().optional(),
      limit: z.string().optional(),
    }),
  },
  responses: {
    ...json200Response(ListResponseSchema, "List of suppressions"),
  },
});

suppressionsRouter.openapi(listRoute, async (c) => {
  const db = c.get("db");
  const { cursor, limit: limitRaw } = c.req.valid("query");

  let limit = DEFAULT_LIMIT;
  if (limitRaw) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      limit = Math.min(parsed, MAX_LIMIT);
    }
  }

  const whereClause = cursor
    ? lt(suppressions.createdAt, Number.parseInt(cursor, 10))
    : undefined;

  const rows = await db
    .select()
    .from(suppressions)
    .where(whereClause)
    .orderBy(desc(suppressions.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasMore && items.length > 0
      ? String(items[items.length - 1].createdAt)
      : null;

  return c.json(
    {
      items: items.map((r) => ({
        id: r.id,
        email: r.email,
        reason: r.reason,
        source: r.source,
        note: r.note,
        createdAt: r.createdAt,
      })),
      nextCursor,
    },
    200,
  );
});

// --- POST /api/suppressions ---

const createRouteDef = createRoute({
  method: "post",
  path: "/",
  tags: ["Suppressions"],
  description:
    "Add a manual suppression. Idempotent: returns 200 + the existing row if the email is already suppressed.",
  request: {
    body: {
      content: { "application/json": { schema: CreateSuppressionSchema } },
    },
  },
  responses: {
    ...json200Response(SuppressionSchema, "Existing suppression returned"),
    ...json201Response(SuppressionSchema, "Suppression created"),
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

suppressionsRouter.openapi(createRouteDef, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const { email: rawEmail } = c.req.valid("json");

  const email = rawEmail.trim().toLowerCase();

  // If already suppressed, return the existing row (idempotent).
  const existing = await db
    .select()
    .from(suppressions)
    .where(eq(suppressions.email, email))
    .limit(1);

  if (existing.length > 0) {
    const row = existing[0];
    return c.json(
      {
        id: row.id,
        email: row.email,
        reason: row.reason,
        source: row.source,
        note: row.note,
        createdAt: row.createdAt,
      },
      200,
    );
  }

  const id = nanoid();
  const now = Math.floor(Date.now() / 1000);
  const source = `admin:${user.email}`;

  await db
    .insert(suppressions)
    .values({
      id,
      email,
      reason: "manual",
      source,
      note: null,
      createdAt: now,
    })
    .onConflictDoNothing({ target: suppressions.email });

  // Re-fetch in case a concurrent insert won the race.
  const row = (
    await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.email, email))
      .limit(1)
  )[0];

  return c.json(
    {
      id: row.id,
      email: row.email,
      reason: row.reason,
      source: row.source,
      note: row.note,
      createdAt: row.createdAt,
    },
    row.id === id ? 201 : 200,
  );
});

// --- DELETE /api/suppressions/:id ---

const deleteRouteDef = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Suppressions"],
  description:
    "Remove a suppression by id. Idempotent — returns 200 even if the row doesn't exist.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    ...json200Response(DeleteResponseSchema, "Suppression deleted (or absent)"),
  },
});

suppressionsRouter.openapi(deleteRouteDef, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  await db.delete(suppressions).where(eq(suppressions.id, id));
  return c.json({ deleted: true as const }, 200);
});

