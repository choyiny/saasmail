import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { lists } from "../db/lists.schema";
import { listMembers } from "../db/list-members.schema";
import { contacts } from "../db/contacts.schema";
import { asyncJobs } from "../db/async-jobs.schema";
import { campaigns } from "../db/campaigns.schema";
import { json200Response, json201Response } from "../lib/helpers";
import {
  assertInboxAllowed,
  inboxFilter,
  type AllowedInboxes,
} from "../lib/inbox-permissions";
import { findOrCreateContact, sanitizeContactName } from "../lib/contacts";
import { csvRow } from "../lib/csv";
import {
  MAX_IMPORT_BYTES,
  sourceKey,
  type ListImportMessage,
} from "../lib/list-import";
import type { Variables } from "../variables";

export const listsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Hard cap per list. Bounds campaign fan-out to 100 coordinator pages of 100
 * recipients. Enforced on every path that can add a member, not just import —
 * a cap checked only at send time is a cap you discover too late.
 */
export const MAX_LIST_MEMBERS = 10_000;

// --- Schemas ---

const ListSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  fromAddress: z.string(),
  doubleOptIn: z.boolean(),
  confirmationTemplateSlug: z.string().nullable(),
  archivedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const ListWithStatsSchema = ListSchema.extend({
  memberCounts: z.object({
    subscribed: z.number(),
    pending: z.number(),
    unsubscribed: z.number(),
  }),
});

const ListsResponseSchema = z.object({
  items: z.array(ListSchema),
  nextCursor: z.string().nullable(),
});

const CreateListSchema = z.object({
  name: z.string().min(1).max(200),
  // Nullable as well as optional, matching UpdateListSchema: a client that
  // renders an empty text field naturally sends `null`, and rejecting that
  // while accepting it on update is an inconsistency callers trip over.
  description: z.string().max(2000).nullable().optional(),
  fromAddress: z.string().email(),
  doubleOptIn: z.boolean().optional(),
  confirmationTemplateSlug: z.string().max(200).nullable().optional(),
});

const UpdateListSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  doubleOptIn: z.boolean().optional(),
  confirmationTemplateSlug: z.string().max(200).nullable().optional(),
});

const DeleteListResponseSchema = z.object({
  /** Which branch was taken — archived when campaign history exists. */
  outcome: z.enum(["deleted", "archived"]),
});

const MemberSchema = z.object({
  id: z.string(),
  listId: z.string(),
  contactId: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  status: z.enum(["pending", "subscribed", "unsubscribed"]),
  source: z.enum(["form", "api", "import"]),
  consentSource: z.enum(["form", "api", "import"]),
  consentAt: z.number().nullable(),
  subscribedAt: z.number().nullable(),
  confirmedAt: z.number().nullable(),
  unsubscribedAt: z.number().nullable(),
  createdAt: z.number(),
});

const MembersResponseSchema = z.object({
  items: z.array(MemberSchema),
  nextCursor: z.string().nullable(),
});

const AddMemberSchema = z.object({
  email: z.string().email(),
  name: z.string().max(200).nullable().optional(),
});

const ErrorSchema = z.object({ error: z.string() });

// --- Helpers ---

function now() {
  return Math.floor(Date.now() / 1000);
}

function parseLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

/**
 * Load a list and assert the caller may act on its sending identity.
 *
 * Returns `null` when the row does not exist so the caller can 404; throws 403
 * via `assertInboxAllowed` when it exists but is out of scope. Those are
 * deliberately different: conflating them would let a scoped member probe for
 * the existence of other teams' lists.
 */
async function loadListForCaller(
  db: Variables["db"],
  allowed: AllowedInboxes,
  id: string,
) {
  const rows = await db.select().from(lists).where(eq(lists.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  assertInboxAllowed(allowed, row.fromAddress);
  return row;
}

/**
 * Whether any campaign has ever targeted this list.
 *
 * A delivered campaign's audit trail references the list, so once one exists
 * the row has to survive — deleting it would strand the record of who was sent
 * what. That is why DELETE archives instead.
 */
async function listHasCampaignHistory(
  db: Variables["db"],
  listId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.listId, listId))
    .limit(1);
  return rows.length > 0;
}

async function memberCounts(db: Variables["db"], listId: string) {
  const rows = await db
    .select({ status: listMembers.status, n: sql<number>`count(*)` })
    .from(listMembers)
    .where(eq(listMembers.listId, listId))
    .groupBy(listMembers.status);

  const counts = { subscribed: 0, pending: 0, unsubscribed: 0 };
  for (const r of rows) {
    if (r.status in counts) {
      counts[r.status as keyof typeof counts] = Number(r.n);
    }
  }
  return counts;
}

/** Members that count against `MAX_LIST_MEMBERS` — everything not unsubscribed. */
async function activeMemberCount(db: Variables["db"], listId: string) {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(listMembers)
    .where(
      and(
        eq(listMembers.listId, listId),
        sql`${listMembers.status} != 'unsubscribed'`,
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

function serializeList(row: typeof lists.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    fromAddress: row.fromAddress,
    doubleOptIn: row.doubleOptIn === 1,
    confirmationTemplateSlug: row.confirmationTemplateSlug,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// --- GET / ---

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Lists"],
  description:
    "List subscriber lists, newest first. Archived lists are hidden unless `includeArchived=true`. Cursor is the `createdAt` of the last item returned.",
  request: {
    query: z.object({
      cursor: z.string().optional(),
      limit: z.string().optional(),
      includeArchived: z.string().optional(),
    }),
  },
  responses: { ...json200Response(ListsResponseSchema, "Lists") },
});

listsRouter.openapi(listRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { cursor, limit: limitRaw, includeArchived } = c.req.valid("query");
  const limit = parseLimit(limitRaw);

  const conditions = [inboxFilter(allowed, lists.fromAddress)];
  if (cursor) conditions.push(lt(lists.createdAt, Number.parseInt(cursor, 10)));
  if (includeArchived !== "true")
    conditions.push(sql`${lists.archivedAt} IS NULL`);

  const rows = await db
    .select()
    .from(lists)
    .where(and(...conditions.filter(Boolean)))
    .orderBy(desc(lists.createdAt))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  return c.json({
    items: page.map(serializeList),
    nextCursor:
      rows.length > limit ? String(page[page.length - 1]!.createdAt) : null,
  });
});

// --- POST / ---

const createListRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Lists"],
  description: "Create a subscriber list.",
  request: {
    body: {
      content: { "application/json": { schema: CreateListSchema } },
      required: true,
    },
  },
  responses: {
    ...json201Response(ListSchema, "Created list"),
    403: {
      description: "Sending identity not allowed",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

listsRouter.openapi(createListRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const body = c.req.valid("json");
  const fromAddress = body.fromAddress.toLowerCase();

  assertInboxAllowed(allowed, fromAddress);

  const ts = now();
  const row = {
    id: nanoid(),
    name: body.name,
    description: body.description ?? null,
    fromAddress,
    doubleOptIn: body.doubleOptIn ? 1 : 0,
    confirmationTemplateSlug: body.confirmationTemplateSlug ?? null,
    archivedAt: null,
    createdAt: ts,
    updatedAt: ts,
  };
  await db.insert(lists).values(row);
  return c.json(serializeList(row as typeof lists.$inferSelect), 201);
});

// --- GET /memberships?email= ---
//
// Registered before `/{id}`: Hono matches in registration order, so the
// parameterised route would otherwise swallow this path and look for a list
// with the id "memberships".

const membershipsRoute = createRoute({
  method: "get",
  path: "/memberships",
  tags: ["Lists"],
  description:
    "Which lists an address belongs to, and with what status. Scoped to the caller's allowed inboxes like every other list read.",
  request: { query: z.object({ email: z.string() }) },
  responses: {
    ...json200Response(
      z.object({
        items: z.array(
          z.object({
            listId: z.string(),
            listName: z.string(),
            status: z.enum(["pending", "subscribed", "unsubscribed"]),
            subscribedAt: z.number().nullable(),
            unsubscribedAt: z.number().nullable(),
          }),
        ),
      }),
      "Memberships",
    ),
  },
});

listsRouter.openapi(membershipsRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const email = c.req.valid("query").email.trim().toLowerCase();

  const rows = await db
    .select({
      listId: lists.id,
      listName: lists.name,
      status: listMembers.status,
      subscribedAt: listMembers.subscribedAt,
      unsubscribedAt: listMembers.unsubscribedAt,
    })
    .from(listMembers)
    .innerJoin(lists, eq(lists.id, listMembers.listId))
    .where(
      and(
        eq(sql`lower(${listMembers.email})`, email),
        inboxFilter(allowed, lists.fromAddress),
      ),
    )
    .orderBy(desc(listMembers.createdAt));

  return c.json({ items: rows });
});

// --- GET /:id ---

const getListRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Lists"],
  description: "Get a list with per-status member counts.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(ListWithStatsSchema, "List detail"),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

listsRouter.openapi(getListRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { id } = c.req.valid("param");

  const row = await loadListForCaller(db, allowed, id);
  if (!row) return c.json({ error: "List not found" }, 404);

  return c.json({
    ...serializeList(row),
    memberCounts: await memberCounts(db, id),
  });
});

// --- PATCH /:id ---

const updateListRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Lists"],
  description:
    "Update list settings. `fromAddress` is immutable — it is the authorization key, and changing it would move the list between teams.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: UpdateListSchema } },
      required: true,
    },
  },
  responses: {
    ...json200Response(ListSchema, "Updated list"),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "List is archived",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

listsRouter.openapi(updateListRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const row = await loadListForCaller(db, allowed, id);
  if (!row) return c.json({ error: "List not found" }, 404);
  if (row.archivedAt !== null) {
    return c.json({ error: "List is archived" }, 409);
  }

  const patch: Partial<typeof lists.$inferInsert> = { updatedAt: now() };
  if (body.name !== undefined) patch.name = body.name;
  if (body.description !== undefined) patch.description = body.description;
  if (body.doubleOptIn !== undefined) {
    patch.doubleOptIn = body.doubleOptIn ? 1 : 0;
  }
  if (body.confirmationTemplateSlug !== undefined) {
    patch.confirmationTemplateSlug = body.confirmationTemplateSlug;
  }

  await db.update(lists).set(patch).where(eq(lists.id, id));
  const updated = await db
    .select()
    .from(lists)
    .where(eq(lists.id, id))
    .limit(1);
  return c.json(serializeList(updated[0]!));
});

// --- DELETE /:id ---

const deleteListRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Lists"],
  description:
    "Delete a list with no campaign history, or archive it if any campaign has targeted it — a delivered campaign's audit trail references the list, so the row must survive. Archiving is one-way.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(DeleteListResponseSchema, "Deleted or archived"),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

listsRouter.openapi(deleteListRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { id } = c.req.valid("param");

  const row = await loadListForCaller(db, allowed, id);
  if (!row) return c.json({ error: "List not found" }, 404);

  if (await listHasCampaignHistory(db, id)) {
    if (row.archivedAt === null) {
      await db
        .update(lists)
        .set({ archivedAt: now(), updatedAt: now() })
        .where(eq(lists.id, id));
    }
    return c.json({ outcome: "archived" as const });
  }

  // No campaign history: the members carry no audit value on their own, so the
  // list and its memberships go together.
  await db.delete(listMembers).where(eq(listMembers.listId, id));
  await db.delete(lists).where(eq(lists.id, id));
  return c.json({ outcome: "deleted" as const });
});

// --- GET /:id/members ---

const listMembersRoute = createRoute({
  method: "get",
  path: "/{id}/members",
  tags: ["Lists"],
  description:
    "List members, oldest id first. Cursor is the `id` of the last item returned; id ordering matches the campaign fan-out cursor.",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      cursor: z.string().optional(),
      limit: z.string().optional(),
      status: z.enum(["pending", "subscribed", "unsubscribed"]).optional(),
    }),
  },
  responses: {
    ...json200Response(MembersResponseSchema, "Members"),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

listsRouter.openapi(listMembersRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { id } = c.req.valid("param");
  const { cursor, limit: limitRaw, status } = c.req.valid("query");
  const limit = parseLimit(limitRaw);

  const row = await loadListForCaller(db, allowed, id);
  if (!row) return c.json({ error: "List not found" }, 404);

  const conditions = [eq(listMembers.listId, id)];
  if (status) conditions.push(eq(listMembers.status, status));
  if (cursor) conditions.push(gt(listMembers.id, cursor));

  const rows = await db
    .select({ member: listMembers, name: contacts.name })
    .from(listMembers)
    .leftJoin(contacts, eq(contacts.id, listMembers.contactId))
    .where(and(...conditions))
    .orderBy(asc(listMembers.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  return c.json({
    items: page.map(({ member: m, name }) => ({
      id: m.id,
      listId: m.listId,
      contactId: m.contactId,
      email: m.email,
      name,
      status: m.status,
      source: m.source,
      consentSource: m.consentSource,
      consentAt: m.consentAt,
      subscribedAt: m.subscribedAt,
      confirmedAt: m.confirmedAt,
      unsubscribedAt: m.unsubscribedAt,
      createdAt: m.createdAt,
    })),
    nextCursor: rows.length > limit ? page[page.length - 1]!.member.id : null,
  });
});

// --- POST /:id/members ---

const addMemberRoute = createRoute({
  method: "post",
  path: "/{id}/members",
  tags: ["Lists"],
  description:
    "Add a member directly (source `api`, bypassing double opt-in). Creates a `contacts` row if needed — never a `people` row.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: AddMemberSchema } },
      required: true,
    },
  },
  responses: {
    ...json201Response(MemberSchema, "Added member"),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "List is archived",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: {
      description: "List is at capacity",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

listsRouter.openapi(addMemberRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const row = await loadListForCaller(db, allowed, id);
  if (!row) return c.json({ error: "List not found" }, 404);
  if (row.archivedAt !== null) {
    return c.json({ error: "List is archived" }, 409);
  }

  const ts = now();
  const contact = await findOrCreateContact(
    db,
    body.email,
    body.name ?? null,
    ts,
  );

  const existing = await db
    .select()
    .from(listMembers)
    .where(
      and(eq(listMembers.listId, id), eq(listMembers.contactId, contact.id)),
    )
    .limit(1);

  if (existing[0]) {
    // Re-adding a previously unsubscribed member re-subscribes them; adding an
    // already-subscribed member is a no-op. Either way this is idempotent
    // rather than a 409, so a retried client request is harmless.
    if (existing[0].status !== "subscribed") {
      await db
        .update(listMembers)
        .set({
          status: "subscribed",
          subscribedAt: ts,
          unsubscribedAt: null,
          unsubscribeReason: null,
        })
        .where(eq(listMembers.id, existing[0].id));
    }
    const refreshed = await db
      .select()
      .from(listMembers)
      .where(eq(listMembers.id, existing[0].id))
      .limit(1);
    const m = refreshed[0]!;
    return c.json(
      {
        id: m.id,
        listId: m.listId,
        contactId: m.contactId,
        email: m.email,
        name: sanitizeContactName(body.name ?? null),
        status: m.status,
        source: m.source,
        consentSource: m.consentSource,
        consentAt: m.consentAt,
        subscribedAt: m.subscribedAt,
        confirmedAt: m.confirmedAt,
        unsubscribedAt: m.unsubscribedAt,
        createdAt: m.createdAt,
      },
      201,
    );
  }

  if ((await activeMemberCount(db, id)) >= MAX_LIST_MEMBERS) {
    return c.json(
      { error: `List has reached the ${MAX_LIST_MEMBERS} member limit` },
      422,
    );
  }

  const member = {
    id: nanoid(),
    listId: id,
    contactId: contact.id,
    email: contact.email,
    status: "subscribed" as const,
    source: "api" as const,
    formId: null,
    submittedIp: null,
    consentSource: "api" as const,
    consentAt: ts,
    importJobId: null,
    subscribedAt: ts,
    confirmedAt: null,
    unsubscribedAt: null,
    unsubscribeReason: null,
    createdAt: ts,
  };
  await db.insert(listMembers).values(member);

  return c.json(
    {
      id: member.id,
      listId: member.listId,
      contactId: member.contactId,
      email: member.email,
      name: sanitizeContactName(body.name ?? null),
      status: member.status,
      source: member.source,
      consentSource: member.consentSource,
      consentAt: member.consentAt,
      subscribedAt: member.subscribedAt,
      confirmedAt: member.confirmedAt,
      unsubscribedAt: member.unsubscribedAt,
      createdAt: member.createdAt,
    },
    201,
  );
});

// --- DELETE /:id/members/:memberId ---

const removeMemberRoute = createRoute({
  method: "delete",
  path: "/{id}/members/{memberId}",
  tags: ["Lists"],
  description:
    "Unsubscribe a member. This is a status change, never a row delete — the row carries the consent provenance that answers 'why did we have this address?'.",
  request: { params: z.object({ id: z.string(), memberId: z.string() }) },
  responses: {
    ...json200Response(MemberSchema, "Unsubscribed member"),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

listsRouter.openapi(removeMemberRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { id, memberId } = c.req.valid("param");

  const row = await loadListForCaller(db, allowed, id);
  if (!row) return c.json({ error: "List not found" }, 404);

  const ts = now();
  await db
    .update(listMembers)
    .set({ status: "unsubscribed", unsubscribedAt: ts })
    .where(
      and(
        eq(listMembers.id, memberId),
        eq(listMembers.listId, id),
        sql`${listMembers.status} != 'unsubscribed'`,
      ),
    );

  const rows = await db
    .select({ member: listMembers, name: contacts.name })
    .from(listMembers)
    .leftJoin(contacts, eq(contacts.id, listMembers.contactId))
    .where(and(eq(listMembers.id, memberId), eq(listMembers.listId, id)))
    .limit(1);
  const row2 = rows[0];
  if (!row2) return c.json({ error: "Member not found" }, 404);
  const m = row2.member;

  return c.json({
    id: m.id,
    listId: m.listId,
    contactId: m.contactId,
    email: m.email,
    name: row2.name,
    status: m.status,
    source: m.source,
    consentSource: m.consentSource,
    consentAt: m.consentAt,
    subscribedAt: m.subscribedAt,
    confirmedAt: m.confirmedAt,
    unsubscribedAt: m.unsubscribedAt,
    createdAt: m.createdAt,
  });
});

// --- GET /:id/members/export ---

const EXPORT_PAGE = 500;

const exportRoute = createRoute({
  method: "get",
  path: "/{id}/members/export",
  tags: ["Lists"],
  description:
    "Stream list members as CSV. Cells are formula-injection-safe. Streamed in pages rather than buffered, so a 10,000-member list does not have to fit in memory.",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      status: z.enum(["pending", "subscribed", "unsubscribed"]).optional(),
    }),
  },
  responses: {
    200: {
      description: "CSV export",
      content: { "text/csv": { schema: z.string() } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

listsRouter.openapi(exportRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { id } = c.req.valid("param");
  const { status } = c.req.valid("query");

  const list = await loadListForCaller(db, allowed, id);
  if (!list) return c.json({ error: "List not found" }, 404);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(
          encoder.encode(
            csvRow([
              "email",
              "status",
              "source",
              "consent_source",
              "consent_at",
              "subscribed_at",
              "unsubscribed_at",
            ]),
          ),
        );

        let cursor: string | null = null;
        for (;;) {
          const conditions = [eq(listMembers.listId, id)];
          if (status) conditions.push(eq(listMembers.status, status));
          if (cursor) conditions.push(gt(listMembers.id, cursor));

          const rows = await db
            .select()
            .from(listMembers)
            .where(and(...conditions))
            .orderBy(asc(listMembers.id))
            .limit(EXPORT_PAGE);

          if (rows.length === 0) break;

          for (const m of rows) {
            controller.enqueue(
              encoder.encode(
                csvRow([
                  m.email,
                  m.status,
                  m.source,
                  m.consentSource,
                  m.consentAt === null ? "" : String(m.consentAt),
                  m.subscribedAt === null ? "" : String(m.subscribedAt),
                  m.unsubscribedAt === null ? "" : String(m.unsubscribedAt),
                ]),
              ),
            );
          }

          if (rows.length < EXPORT_PAGE) break;
          cursor = rows[rows.length - 1]!.id;
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="list-${id}-members.csv"`,
      "Cache-Control": "no-store",
    },
  });
});

// --- Import: POST /:id/members/import ---

const ImportJobSchema = z.object({
  jobId: z.string(),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  totalRows: z.number().nullable(),
  processedRows: z.number(),
  importedCount: z.number(),
  skippedCount: z.number(),
  errors: z.array(z.object({ row: z.number(), reason: z.string() })),
});

const startImportRoute = createRoute({
  method: "post",
  path: "/{id}/members/import",
  tags: ["Lists"],
  description:
    "Start an async CSV import. The body is the raw CSV. Returns 202 immediately — the file is stored and parsed by a background job, because a 10,000-row import cannot finish inside one request.",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "text/csv": { schema: z.string() } }, required: true },
  },
  responses: {
    202: {
      description: "Import accepted",
      content: {
        "application/json": { schema: z.object({ jobId: z.string() }) },
      },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "List is archived",
      content: { "application/json": { schema: ErrorSchema } },
    },
    413: {
      description: "File too large",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

listsRouter.openapi(startImportRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { id } = c.req.valid("param");

  const list = await loadListForCaller(db, allowed, id);
  if (!list) return c.json({ error: "List not found" }, 404);
  if (list.archivedAt !== null) {
    return c.json({ error: "List is archived" }, 409);
  }

  const body = await c.req.arrayBuffer();
  if (body.byteLength > MAX_IMPORT_BYTES) {
    return c.json({ error: "CSV exceeds the 10MB limit" }, 413);
  }

  const jobId = nanoid();
  const ts = now();

  // Store first, then create the job row: a job row pointing at an object that
  // does not exist would be a job that can only ever fail.
  await c.env.R2.put(sourceKey(jobId), body);

  await db.insert(asyncJobs).values({
    id: jobId,
    jobType: "list_import",
    refId: id,
    status: "running",
    cursor: null,
    storageKey: sourceKey(jobId),
    totalRows: null,
    processedRows: 0,
    importedCount: 0,
    skippedCount: 0,
    errorSummary: null,
    createdAt: ts,
    updatedAt: ts,
  });

  const message: ListImportMessage = { type: "list_import", jobId };
  await c.env.EMAIL_QUEUE.send(message);

  return c.json({ jobId }, 202);
});

// --- Import status: GET /:id/members/import/:jobId ---

function serializeJob(job: typeof asyncJobs.$inferSelect) {
  return {
    jobId: job.id,
    status: job.status,
    totalRows: job.totalRows,
    processedRows: job.processedRows,
    importedCount: job.importedCount,
    skippedCount: job.skippedCount,
    errors: job.errorSummary
      ? (JSON.parse(job.errorSummary) as Array<{ row: number; reason: string }>)
      : [],
  };
}

async function loadJobForList(
  db: Variables["db"],
  listId: string,
  jobId: string,
) {
  const rows = await db
    .select()
    .from(asyncJobs)
    .where(
      and(
        eq(asyncJobs.id, jobId),
        eq(asyncJobs.refId, listId),
        eq(asyncJobs.jobType, "list_import"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

const importStatusRoute = createRoute({
  method: "get",
  path: "/{id}/members/import/{jobId}",
  tags: ["Lists"],
  description: "Poll an import job's progress and result.",
  request: { params: z.object({ id: z.string(), jobId: z.string() }) },
  responses: {
    ...json200Response(ImportJobSchema, "Import job"),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

listsRouter.openapi(importStatusRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { id, jobId } = c.req.valid("param");

  const list = await loadListForCaller(db, allowed, id);
  if (!list) return c.json({ error: "List not found" }, 404);

  const job = await loadJobForList(db, id, jobId);
  if (!job) return c.json({ error: "Import job not found" }, 404);
  return c.json(serializeJob(job));
});

// --- Cancel: DELETE /:id/members/import/:jobId ---

const cancelImportRoute = createRoute({
  method: "delete",
  path: "/{id}/members/import/{jobId}",
  tags: ["Lists"],
  description:
    "Cancel a running import. Rows already imported are kept — an import is not a transaction, and rolling back would delete memberships that may already have been mailed.",
  request: { params: z.object({ id: z.string(), jobId: z.string() }) },
  responses: {
    ...json200Response(ImportJobSchema, "Cancelled job"),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

listsRouter.openapi(cancelImportRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { id, jobId } = c.req.valid("param");

  const list = await loadListForCaller(db, allowed, id);
  if (!list) return c.json({ error: "List not found" }, 404);

  const job = await loadJobForList(db, id, jobId);
  if (!job) return c.json({ error: "Import job not found" }, 404);

  if (job.status === "running") {
    await db
      .update(asyncJobs)
      .set({ status: "cancelled", updatedAt: now() })
      .where(eq(asyncJobs.id, jobId));
  }

  const updated = await loadJobForList(db, id, jobId);
  return c.json(serializeJob(updated!));
});
