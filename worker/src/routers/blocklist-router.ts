import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { desc, eq, lt, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { blocklist } from "../db/blocklist.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { domainOf } from "../lib/blocklist";
import { json200Response, json201Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const blocklistRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const BlockRuleSchema = z.object({
  id: z.string(),
  type: z.enum(["email", "domain"]),
  value: z.string(),
  note: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.number(),
});

const ListResponseSchema = z.object({
  items: z.array(BlockRuleSchema),
  nextCursor: z.string().nullable(),
});

const CreateSchema = z.object({
  type: z.enum(["email", "domain"]),
  value: z.string().min(1),
  note: z.string().optional(),
});

const DeleteResponseSchema = z.object({ deleted: z.literal(true) });
const ErrorSchema = z.object({ error: z.string() });

function toDTO(r: {
  id: string;
  type: "email" | "domain";
  value: string;
  note: string | null;
  createdBy: string | null;
  createdAt: number;
}) {
  return {
    id: r.id,
    type: r.type,
    value: r.value,
    note: r.note,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  };
}

// --- GET /api/blocklist ---
const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Blocklist"],
  description:
    "List block rules, newest first. Cursor is the createdAt of the last item.",
  request: {
    query: z.object({
      cursor: z.string().optional(),
      limit: z.string().optional(),
    }),
  },
  responses: { ...json200Response(ListResponseSchema, "List of block rules") },
});

blocklistRouter.openapi(listRoute, async (c) => {
  const db = c.get("db");
  const { cursor, limit: limitRaw } = c.req.valid("query");

  let limit = DEFAULT_LIMIT;
  if (limitRaw) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0)
      limit = Math.min(parsed, MAX_LIMIT);
  }

  const whereClause = cursor
    ? lt(blocklist.createdAt, Number.parseInt(cursor, 10))
    : undefined;
  const rows = await db
    .select()
    .from(blocklist)
    .where(whereClause)
    .orderBy(desc(blocklist.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasMore && items.length > 0
      ? String(items[items.length - 1].createdAt)
      : null;

  return c.json({ items: items.map(toDTO), nextCursor }, 200);
});

// --- POST /api/blocklist ---
const createRouteDef = createRoute({
  method: "post",
  path: "/",
  tags: ["Blocklist"],
  description:
    "Add a block rule. Idempotent on (type, value). Rejects rules that would block our own sending identities.",
  request: {
    body: { content: { "application/json": { schema: CreateSchema } } },
  },
  responses: {
    ...json200Response(BlockRuleSchema, "Existing rule returned"),
    ...json201Response(BlockRuleSchema, "Rule created"),
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

blocklistRouter.openapi(createRouteDef, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const { type, value: rawValue, note } = c.req.valid("json");

  const value = rawValue.trim().toLowerCase();
  if (!value) return c.json({ error: "Value is required." }, 400);
  if (type === "email" && !value.includes("@")) {
    return c.json({ error: "Enter a valid email address." }, 400);
  }
  if (type === "domain" && (value.includes("@") || !value.includes("."))) {
    return c.json({ error: "Enter a bare domain, e.g. spammer.com." }, 400);
  }

  // Self-lockout guard: never let a rule block one of our own sender identities.
  const identities = await db
    .select({ email: senderIdentities.email })
    .from(senderIdentities);
  const ownEmails = new Set(identities.map((i) => i.email.toLowerCase()));
  const ownDomains = new Set(
    Array.from(ownEmails)
      .map((e) => domainOf(e))
      .filter(Boolean),
  );
  if (type === "email" && ownEmails.has(value)) {
    return c.json({ error: "You can't block one of your own addresses." }, 400);
  }
  if (type === "domain" && ownDomains.has(value)) {
    return c.json({ error: "You can't block your own sending domain." }, 400);
  }

  const existing = await db
    .select()
    .from(blocklist)
    .where(and(eq(blocklist.type, type), eq(blocklist.value, value)))
    .limit(1);
  if (existing.length > 0) return c.json(toDTO(existing[0]), 200);

  const id = nanoid();
  const now = Math.floor(Date.now() / 1000);
  await db
    .insert(blocklist)
    .values({
      id,
      type,
      value,
      note: note ?? null,
      createdBy: user.email,
      createdAt: now,
    })
    .onConflictDoNothing();

  const row = (
    await db
      .select()
      .from(blocklist)
      .where(and(eq(blocklist.type, type), eq(blocklist.value, value)))
      .limit(1)
  )[0];

  return c.json(toDTO(row), row.id === id ? 201 : 200);
});

// --- DELETE /api/blocklist/:id ---
const deleteRouteDef = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Blocklist"],
  description: "Remove a block rule (unblock). Idempotent.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(DeleteResponseSchema, "Rule deleted (or absent)"),
  },
});

blocklistRouter.openapi(deleteRouteDef, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  await db.delete(blocklist).where(eq(blocklist.id, id));
  return c.json({ deleted: true as const }, 200);
});
