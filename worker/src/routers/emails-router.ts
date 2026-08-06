import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { attachments } from "../db/attachments.schema";
import { people } from "../db/people.schema";
import { json200Response } from "../lib/helpers";
import { deleteEmailWithAttachments } from "../lib/delete-email";
import { isInboxAllowed } from "../lib/inbox-permissions";
import {
  getEmailById,
  listPersonEmails,
  setEmailRead,
} from "../lib/queries/emails";
import type { Variables } from "../variables";

export const emailsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

export const CcEntrySchema = z.object({
  email: z.string(),
  name: z.string().nullable().optional(),
});

/** Attachment row returned on email list/detail/conversation endpoints. */
export const AttachmentSchema = z.object({
  id: z.string(),
  emailId: z.string(),
  kind: z.string().openapi({
    description:
      '"inbound" for received email attachments, "sent" for outbound.',
  }),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().openapi({ description: "Size in bytes." }),
  r2Key: z.string().openapi({
    description:
      "Internal R2 object key. Download via GET /api/attachments/{id}.",
  }),
  contentId: z.string().nullable(),
  createdAt: z.number(),
});

export const EmailSchema = z.object({
  id: z.string(),
  type: z.enum(["received", "sent"]),
  personId: z.string().nullable(),
  recipient: z.string().nullable(),
  fromAddress: z.string().nullable(),
  toAddress: z.string().nullable(),
  subject: z.string().nullable(),
  bodyHtml: z.string().nullable(),
  bodyText: z.string().nullable(),
  isRead: z.number().nullable(),
  cc: z.array(CcEntrySchema),
  timestamp: z.number(),
  status: z
    .string()
    .nullable()
    .optional()
    .openapi({
      description:
        "Delivery status for sent messages: 'sent', 'retrying' (transient " +
        "provider failure, will be retried), or 'failed' (the provider " +
        "rejected it). Null for received messages.",
    }),
  attachmentCount: z.number().optional().openapi({
    description:
      "Number of attachments on this message. Set on list endpoints; may be omitted on GET /api/emails/{id}.",
  }),
  attachments: z.array(AttachmentSchema).optional().openapi({
    description:
      "Attachment metadata. Included on GET /api/emails/by-person/{personId}, GET /api/emails/{id}, and GET /api/conversations/{id}/emails. Download bytes via GET /api/attachments/{id}.",
  }),
  replyTo: z
    .string()
    .nullable()
    .optional()
    .openapi({
      description:
        "Address from the inbound Reply-To header, when present (e.g. a " +
        "contact form's actual submitter behind a noreply@ sender). Populated " +
        "only on GET /api/emails/{id} for received messages; omitted or null " +
        "on list/conversation endpoints and on sent messages.",
    }),
});

/**
 * Strip Reply-To from stored raw headers after re-attribution. Once a message
 * is attributed to a person, `people.email` is the canonical reply target —
 * leaving the original inbound Reply-To in place would mislead the reassign
 * UI and any code that surfaces `replyTo` alongside the new person.
 */
function clearReplyToInRawHeaders(rawHeaders: string | null): string | null {
  if (!rawHeaders) return rawHeaders;
  try {
    const headers = JSON.parse(rawHeaders) as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    let changed = false;
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === "reply-to") {
        changed = true;
        continue;
      }
      next[key] = value;
    }
    return changed ? JSON.stringify(next) : rawHeaders;
  } catch {
    return rawHeaders;
  }
}

const InboxMetaSchema = z.object({
  email: z.string(),
  displayName: z.string().nullable(),
  displayMode: z.enum(["thread", "chat"]),
});

const PersonEmailsResponseSchema = z.object({
  emails: z.array(EmailSchema),
  inboxes: z.array(InboxMetaSchema),
});

// List emails for a person (received + sent interleaved)
const listPersonEmailsRoute = createRoute({
  method: "get",
  path: "/by-person/{personId}",
  tags: ["Emails"],
  description:
    "List all emails for a person (received and sent, interleaved chronologically). Each email includes attachment metadata when present.",
  request: {
    params: z.object({ personId: z.string() }),
    query: z.object({
      q: z.string().optional().openapi({ description: "Search by subject" }),
      recipient: z
        .string()
        .optional()
        .openapi({ description: "Filter by recipient address" }),
      page: z.coerce.number().optional().default(1),
      limit: z.coerce.number().optional().default(50),
    }),
  },
  responses: {
    ...json200Response(
      PersonEmailsResponseSchema,
      "Emails + per-inbox metadata for person",
    ),
  },
});

emailsRouter.openapi(listPersonEmailsRoute, async (c) => {
  const db = c.get("db");
  const { personId } = c.req.valid("param");
  const { q, recipient, page, limit } = c.req.valid("query");
  const allowed = c.get("allowedInboxes")!;

  const result = await listPersonEmails(
    db,
    personId,
    { q, recipient, page, limit },
    allowed,
  );

  return c.json(result, 200);
});

// Get single email detail
const getEmailRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Emails"],
  description:
    "Get a single email with full details, including attachments. replyTo is set for received messages when a Reply-To header was present.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    ...json200Response(EmailSchema, "Email detail"),
  },
});

emailsRouter.openapi(getEmailRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const allowed = c.get("allowedInboxes")!;

  const email = await getEmailById(db, id, allowed);

  if (!email) {
    return c.json({ error: "Email not found" }, 404);
  }

  return c.json(email, 200);
});

// Bulk mark read/unread. Must stay above PATCH /{id}: Hono matches in
// registration order, so /{id} first swallows "bulk" as an id.
const bulkPatchRoute = createRoute({
  method: "patch",
  path: "/bulk",
  tags: ["Emails"],
  description: "Bulk mark emails as read or unread.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            ids: z.array(z.string()),
            isRead: z.boolean(),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "Updated"),
  },
});

emailsRouter.openapi(bulkPatchRoute, async (c) => {
  const db = c.get("db");
  const { ids, isRead } = c.req.valid("json");
  const allowed = c.get("allowedInboxes")!;

  for (const id of ids) {
    const email = await db
      .select({
        personId: emails.personId,
        isRead: emails.isRead,
        recipient: emails.recipient,
      })
      .from(emails)
      .where(eq(emails.id, id))
      .limit(1);

    if (email.length === 0) continue;
    if (!isInboxAllowed(allowed, email[0].recipient)) continue;

    const wasRead = email[0].isRead === 1;
    if (wasRead !== isRead) {
      await db
        .update(emails)
        .set({ isRead: isRead ? 1 : 0 })
        .where(eq(emails.id, id));

      const delta = isRead ? -1 : 1;
      await db
        .update(people)
        .set({ unreadCount: sql`${people.unreadCount} + ${delta}` })
        .where(eq(people.id, email[0].personId));
    }
  }

  return c.json({ success: true }, 200);
});

// Mark email read/unread
const patchEmailRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Emails"],
  description: "Mark an email as read or unread.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            isRead: z.boolean(),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "Updated"),
  },
});

emailsRouter.openapi(patchEmailRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const { isRead } = c.req.valid("json");
  const allowed = c.get("allowedInboxes")!;

  const result = await setEmailRead(db, id, isRead, allowed);

  if (!result) {
    return c.json({ error: "Email not found" }, 404);
  }

  return c.json({ success: true }, 200);
});

// --- DELETE email (hard delete with R2 attachment cleanup) ---
const deleteEmailRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Emails"],
  description:
    "Hard delete an email and all associated R2 attachments. Works for both received and sent emails.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    ...json200Response(
      z.object({ success: z.boolean(), attachmentsDeleted: z.number() }),
      "Email deleted",
    ),
  },
});

emailsRouter.openapi(deleteEmailRoute, async (c) => {
  const db = c.get("db");
  const r2 = c.env.R2;
  const { id } = c.req.valid("param");

  const allowed = c.get("allowedInboxes")!;
  // Scoping is enforced inside deleteEmailWithAttachments so that received and
  // sent emails are both covered; a denied delete comes back as null → 404.
  const result = await deleteEmailWithAttachments(db, r2, id, allowed);
  if (!result) {
    return c.json({ error: "Email not found" }, 404);
  }

  return c.json(result, 200);
});

// --- Re-target a message to a different/new person (received or sent) ---
const ReassignPersonResponseSchema = z.object({
  success: z.boolean(),
  type: z.enum(["received", "sent"]),
  email: z.object({
    id: z.string(),
    personId: z.string().nullable(),
    toAddress: z.string().nullable(),
    fromAddress: z.string().nullable(),
  }),
  person: z
    .object({
      id: z.string(),
      email: z.string(),
      name: z.string().nullable(),
      created: z.boolean(),
    })
    .nullable(),
});

const reassignPersonRoute = createRoute({
  method: "patch",
  path: "/{id}/person",
  tags: ["Emails"],
  description:
    "Re-target a single message to a different or new person (find-or-create " +
    "by email). For a received message this re-attributes the sender's person. " +
    "For a sent message — e.g. a contact-form notification mailed from a " +
    "generic address with the real submitter in the body — it re-attributes " +
    "the person AND rewrites the stored `toAddress` so a reply reaches them; " +
    "an optional `fromAddress` switches the sending identity (must be one of " +
    "your inboxes). Conversation threading is left intact and per-person " +
    "counts are recomputed.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: z
              .string()
              .email()
              .optional()
              .openapi({
                description:
                  "Correspondent email to attribute this message to. Required " +
                  "for received messages; for sent messages it also becomes the " +
                  "new recipient (`toAddress`).",
                example: "submitter@example.com",
              }),
            name: z
              .string()
              .max(200)
              .nullable()
              .optional()
              .openapi({
                description:
                  "Display name for the person. Applied only when creating a new " +
                  "person, or filling in a blank name on an existing one — never " +
                  "overwrites an existing name.",
              }),
            fromAddress: z
              .string()
              .email()
              .optional()
              .openapi({
                description:
                  "Sent messages only: change the sending identity. Must be one " +
                  "of your inboxes.",
              }),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(ReassignPersonResponseSchema, "Re-targeted"),
  },
});

emailsRouter.openapi(reassignPersonRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const { email: rawEmail, name, fromAddress: rawFrom } = c.req.valid("json");
  const allowed = c.get("allowedInboxes")!;
  const now = Math.floor(Date.now() / 1000);

  const destEmail = rawEmail?.trim().toLowerCase();
  const newFrom = rawFrom?.trim().toLowerCase();
  if (!destEmail && !newFrom) {
    return c.json({ error: "Provide an email and/or fromAddress." }, 400);
  }

  // Find-or-create the destination person by the unique `people.email`.
  async function resolvePerson() {
    const existing = await db
      .select({ id: people.id, name: people.name })
      .from(people)
      .where(eq(people.email, destEmail!))
      .limit(1);
    if (existing.length > 0) {
      let pname = existing[0].name;
      // Fill a blank name only — never clobber an existing one.
      if (name && !existing[0].name) {
        await db
          .update(people)
          .set({ name, updatedAt: now })
          .where(eq(people.id, existing[0].id));
        pname = name;
      }
      return {
        id: existing[0].id,
        email: destEmail!,
        name: pname,
        created: false,
      };
    }
    const pid = nanoid();
    const pname = name ?? null;
    await db.insert(people).values({
      id: pid,
      email: destEmail!,
      name: pname,
      lastEmailAt: now,
      unreadCount: 0,
      totalCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { id: pid, email: destEmail!, name: pname, created: true };
  }

  // Recompute denormalized counts from source-of-truth. totalCount/unreadCount
  // track received emails only (sent never increments them), so counting
  // `emails` rows is canonical; a sent-message move leaves them unchanged.
  const recompute = async (pid: string) => {
    const [counts] = await db.all<{
      total: number;
      unread: number;
      last: number | null;
    }>(sql`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END), 0) AS unread,
             MAX(received_at) AS last
      FROM ${emails}
      WHERE person_id = ${pid}
    `);
    await db
      .update(people)
      .set({
        totalCount: counts?.total ?? 0,
        unreadCount: counts?.unread ?? 0,
        ...(counts?.last != null ? { lastEmailAt: counts.last } : {}),
        updatedAt: now,
      })
      .where(eq(people.id, pid));
  };

  // ---- Received message: re-attribute the sender's person ----
  const recv = await db
    .select({
      id: emails.id,
      personId: emails.personId,
      recipient: emails.recipient,
      rawHeaders: emails.rawHeaders,
    })
    .from(emails)
    .where(eq(emails.id, id))
    .limit(1);
  if (recv.length > 0) {
    const target = recv[0];
    if (!isInboxAllowed(allowed, target.recipient)) {
      return c.json({ error: "Email not found" }, 404);
    }
    if (!destEmail) {
      return c.json(
        { error: "A received message can only be re-attributed by email." },
        400,
      );
    }
    const person = await resolvePerson();
    if (person.id !== target.personId) {
      // conversation_id is orthogonal and intentionally left unchanged.
      const rawHeaders = clearReplyToInRawHeaders(target.rawHeaders);
      await db
        .update(emails)
        .set({
          personId: person.id,
          ...(rawHeaders !== target.rawHeaders ? { rawHeaders } : {}),
        })
        .where(eq(emails.id, target.id));
      await recompute(target.personId);
      await recompute(person.id);
    }
    return c.json(
      {
        success: true,
        type: "received" as const,
        email: {
          id: target.id,
          personId: person.id,
          toAddress: null,
          fromAddress: person.email,
        },
        person,
      },
      200,
    );
  }

  // ---- Sent message: re-attribute + rewrite the recipient so replies land ----
  const sentRow = await db
    .select({
      id: sentEmails.id,
      personId: sentEmails.personId,
      fromAddress: sentEmails.fromAddress,
      toAddress: sentEmails.toAddress,
    })
    .from(sentEmails)
    .where(eq(sentEmails.id, id))
    .limit(1);
  if (sentRow.length === 0) {
    return c.json({ error: "Email not found" }, 404);
  }
  const sent = sentRow[0];
  // Authz: caller must own the inbox this message was sent from.
  if (!isInboxAllowed(allowed, sent.fromAddress)) {
    return c.json({ error: "Email not found" }, 404);
  }
  // A new sending identity must be one the caller owns.
  if (newFrom && !isInboxAllowed(allowed, newFrom)) {
    return c.json({ error: "fromAddress must be one of your inboxes." }, 400);
  }

  let person: Awaited<ReturnType<typeof resolvePerson>> | null = null;
  const updates: Partial<typeof sentEmails.$inferInsert> = {};
  if (destEmail) {
    person = await resolvePerson();
    updates.personId = person.id;
    updates.toAddress = destEmail; // replies to a sent message route to its toAddress
  }
  if (newFrom) {
    updates.fromAddress = newFrom;
  }
  if (Object.keys(updates).length > 0) {
    await db.update(sentEmails).set(updates).where(eq(sentEmails.id, sent.id));
  }
  if (person && sent.personId && sent.personId !== person.id) {
    await recompute(sent.personId);
    await recompute(person.id);
  }

  return c.json(
    {
      success: true,
      type: "sent" as const,
      email: {
        id: sent.id,
        personId: person?.id ?? sent.personId,
        toAddress: destEmail ?? sent.toAddress,
        fromAddress: newFrom ?? sent.fromAddress,
      },
      person,
    },
    200,
  );
});
