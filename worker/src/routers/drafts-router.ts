import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { MAX_CC_ENTRIES } from "../lib/send-limits";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { drafts } from "../db/drafts.schema";
import { upsertDraft } from "../lib/drafts";
import { destroyLinkedJmapDraft, publishWebDraft } from "../jmap/web-drafts";
import { json200Response } from "../lib/helpers";
import { bearerSecurity } from "../lib/openapi-auth";
import type { Variables } from "../variables";

export const draftsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const CcEntrySchema = z.object({
  email: z.string(),
  name: z.string().nullable().optional(),
});

/** The shape returned to the client — cc parsed back into an array. */
const DraftSchema = z.object({
  id: z.string(),
  contextKey: z.string(),
  fromAddress: z.string().nullable(),
  toAddress: z.string().nullable(),
  cc: z.array(CcEntrySchema).nullable(),
  subject: z.string().nullable(),
  bodyHtml: z.string().nullable(),
  bodyText: z.string().nullable(),
  replyToEmailId: z.string().nullable(),
  updatedAt: z.number(),
});

type DraftRow = typeof drafts.$inferSelect;

function toDraft(row: DraftRow): z.infer<typeof DraftSchema> {
  let cc: z.infer<typeof CcEntrySchema>[] | null = null;
  if (row.cc) {
    try {
      const parsed = JSON.parse(row.cc);
      if (Array.isArray(parsed)) cc = parsed;
    } catch {
      cc = null;
    }
  }
  return {
    id: row.id,
    contextKey: row.contextKey,
    fromAddress: row.fromAddress,
    toAddress: row.toAddress,
    cc,
    subject: row.subject,
    bodyHtml: row.bodyHtml,
    bodyText: row.bodyText,
    replyToEmailId: row.replyToEmailId,
    updatedAt: row.updatedAt,
  };
}

const DraftListItemSchema = z.object({
  id: z.string(),
  contextKey: z.string(),
  fromAddress: z.string().nullable(),
  toAddress: z.string().nullable(),
  subject: z.string().nullable(),
  replyToEmailId: z.string().nullable(),
  updatedAt: z.number(),
});

const DraftListQuery = z.object({
  inbox: z.string().min(1).max(320).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /api/drafts/list — list the current user's drafts newest-first.
const listDraftsRoute = createRoute({
  method: "get",
  path: "/list",
  tags: ["Drafts"],
  security: bearerSecurity,
  description:
    "List the current user's drafts newest-first, optionally scoped to an inbox.",
  request: { query: DraftListQuery },
  responses: {
    ...json200Response(
      z.object({ drafts: z.array(DraftListItemSchema) }),
      "The current user's drafts",
    ),
  },
});

draftsRouter.openapi(listDraftsRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const { inbox, limit, offset } = c.req.valid("query");
  const normalizedInbox = inbox?.trim().toLowerCase();

  const where = normalizedInbox
    ? and(
        eq(drafts.userId, user.id),
        or(eq(drafts.fromAddress, normalizedInbox), isNull(drafts.fromAddress)),
      )
    : eq(drafts.userId, user.id);

  const rows = await db
    .select({
      id: drafts.id,
      contextKey: drafts.contextKey,
      fromAddress: drafts.fromAddress,
      toAddress: drafts.toAddress,
      subject: drafts.subject,
      replyToEmailId: drafts.replyToEmailId,
      updatedAt: drafts.updatedAt,
    })
    .from(drafts)
    .where(where)
    .orderBy(desc(drafts.updatedAt))
    .limit(limit)
    .offset(offset);

  return c.json({ drafts: rows }, 200);
});

const ContextQuery = z.object({
  contextKey: z.string().min(1).max(200),
});

// GET /api/drafts?contextKey=… — fetch the draft for a compose surface.
const getDraftRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Drafts"],
  security: bearerSecurity,
  description:
    "Get the current user's autosaved draft for a compose surface (by contextKey), or null.",
  request: { query: ContextQuery },
  responses: {
    ...json200Response(
      z.object({ draft: DraftSchema.nullable() }),
      "The draft, or null if none exists",
    ),
  },
});

draftsRouter.openapi(getDraftRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const { contextKey } = c.req.valid("query");
  const rows = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.userId, user.id), eq(drafts.contextKey, contextKey)))
    .limit(1);
  return c.json({ draft: rows[0] ? toDraft(rows[0]) : null }, 200);
});

// PUT /api/drafts — upsert the draft for a compose surface.
const SaveDraftBody = z.object({
  contextKey: z.string().min(1).max(200),
  fromAddress: z.string().max(320).optional(),
  // A draft `to` may be a partial/incomplete address while the user types,
  // so it is deliberately NOT validated as an email here.
  to: z.string().max(320).optional(),
  cc: z.array(CcEntrySchema).max(MAX_CC_ENTRIES).optional(),
  subject: z.string().max(2000).optional(),
  bodyHtml: z.string().optional(),
  bodyText: z.string().optional(),
  replyToEmailId: z.string().nullable().optional(),
});

const saveDraftRoute = createRoute({
  method: "put",
  path: "/",
  tags: ["Drafts"],
  security: bearerSecurity,
  description:
    "Create or update (upsert) the autosaved draft for a compose surface.",
  request: {
    body: {
      content: { "application/json": { schema: SaveDraftBody } },
    },
  },
  responses: {
    ...json200Response(z.object({ draft: DraftSchema }), "The saved draft"),
  },
});

draftsRouter.openapi(saveDraftRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const body = c.req.valid("json");
  const draft = await upsertDraft(db, user.id, body);
  return c.json({ draft: toDraft(draft) }, 200);
});

// DELETE /api/drafts?contextKey=… — discard a draft (on send or clear).
const deleteDraftRoute = createRoute({
  method: "delete",
  path: "/",
  tags: ["Drafts"],
  security: bearerSecurity,
  description: "Delete the current user's draft for a compose surface.",
  request: { query: ContextQuery },
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "Draft deleted"),
  },
});

draftsRouter.openapi(deleteDraftRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const { contextKey } = c.req.valid("query");
  const deleted = await db
    .delete(drafts)
    .where(and(eq(drafts.userId, user.id), eq(drafts.contextKey, contextKey)))
    .returning({ jmapDraftId: drafts.jmapDraftId, userId: drafts.userId });
  // A shared draft is one draft: deleting it here deletes it in JMAP too.
  for (const row of deleted) {
    await destroyLinkedJmapDraft(db, c.env, row);
  }
  return c.json({ success: true }, 200);
});

// POST /api/drafts/publish — publish a compose surface's draft to JMAP.
const PublishResponse = z.object({
  status: z.enum(["published", "unchanged", "skipped", "gone", "notFound"]),
  reason: z.string().optional(),
});

const publishDraftRoute = createRoute({
  method: "post",
  path: "/publish",
  tags: ["Drafts"],
  security: bearerSecurity,
  description:
    "Publish the draft of a compose surface so JMAP clients see it (a new JMAP draft revision when it changed). The composer calls it when it closes and after a minute idle. `gone` means the draft was sent or deleted from a JMAP client.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ contextKey: z.string().min(1).max(200) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "What the publish did",
      content: { "application/json": { schema: PublishResponse } },
    },
    401: { description: "Not signed in" },
  },
});

draftsRouter.openapi(publishDraftRoute, async (c) => {
  const { contextKey } = c.req.valid("json");
  const outcome = await publishWebDraft(
    c.get("db"),
    c.env,
    c.get("allowedInboxes")!,
    c.get("user").id,
    contextKey,
  );
  return c.json(
    {
      status: outcome.status,
      ...(outcome.status === "skipped" ? { reason: outcome.reason } : {}),
    },
    200,
  );
});
