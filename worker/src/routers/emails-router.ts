import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, desc, like, and, sql, inArray } from "drizzle-orm";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { attachments } from "../db/attachments.schema";
import { people } from "../db/people.schema";
import { json200Response, escapeLike } from "../lib/helpers";
import { deleteEmailWithAttachments } from "../lib/delete-email";
import { inboxFilter } from "../lib/inbox-permissions";
import type { Variables } from "../variables";

export const emailsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

export const CcEntrySchema = z.object({
  email: z.string(),
  name: z.string().nullable().optional(),
});

/** Parse a stored cc TEXT column (JSON) into a typed array, falling back to
 *  [] for NULL or any malformed/corrupt JSON so a bad row never breaks reads. */
export function parseCc(
  raw: string | null | undefined,
): Array<{ email: string; name?: string | null }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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
  attachmentCount: z.number().optional(),
});

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
    "List all emails for a person (received and sent, interleaved chronologically).",
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
  const offset = (page - 1) * limit;

  const allowed = c.get("allowedInboxes")!;

  // Build conditions for received emails
  const receivedConditions: any[] = [eq(emails.personId, personId)];
  if (q) {
    receivedConditions.push(like(emails.subject, `%${escapeLike(q)}%`));
  }
  if (recipient) {
    receivedConditions.push(eq(emails.recipient, recipient));
  }
  const recvScope = inboxFilter(allowed, emails.recipient);
  if (recvScope) receivedConditions.push(recvScope);

  const received = await db
    .select({
      id: emails.id,
      subject: emails.subject,
      bodyHtml: emails.bodyHtml,
      bodyText: emails.bodyText,
      isRead: emails.isRead,
      cc: emails.cc,
      timestamp: emails.receivedAt,
      recipient: emails.recipient,
    })
    .from(emails)
    .where(and(...receivedConditions))
    .orderBy(desc(emails.receivedAt));

  // Build conditions for sent emails
  const sentConditions: any[] = [eq(sentEmails.personId, personId)];
  if (q) {
    sentConditions.push(like(sentEmails.subject, `%${escapeLike(q)}%`));
  }
  if (recipient) {
    sentConditions.push(eq(sentEmails.fromAddress, recipient));
  }
  const sentScope = inboxFilter(allowed, sentEmails.fromAddress);
  if (sentScope) sentConditions.push(sentScope);

  const sent = await db
    .select({
      id: sentEmails.id,
      subject: sentEmails.subject,
      bodyHtml: sentEmails.bodyHtml,
      bodyText: sentEmails.bodyText,
      cc: sentEmails.cc,
      timestamp: sentEmails.sentAt,
      fromAddress: sentEmails.fromAddress,
      toAddress: sentEmails.toAddress,
    })
    .from(sentEmails)
    .where(and(...sentConditions))
    .orderBy(desc(sentEmails.sentAt));

  // Merge and sort
  const merged = [
    ...received.map((e) => ({
      id: e.id,
      type: "received" as const,
      personId,
      recipient: e.recipient,
      fromAddress: null,
      toAddress: null,
      subject: e.subject,
      bodyHtml: e.bodyHtml,
      bodyText: e.bodyText,
      isRead: e.isRead,
      cc: parseCc(e.cc),
      timestamp: e.timestamp,
    })),
    ...sent.map((e) => ({
      id: e.id,
      type: "sent" as const,
      personId,
      recipient: null,
      fromAddress: e.fromAddress,
      toAddress: e.toAddress,
      subject: e.subject,
      bodyHtml: e.bodyHtml,
      bodyText: e.bodyText,
      isRead: null,
      cc: parseCc(e.cc),
      timestamp: e.timestamp,
    })),
  ].sort((a, b) => b.timestamp - a.timestamp);

  const paginated = merged.slice(offset, offset + limit);

  // Get attachment counts for received emails
  const receivedIds = paginated
    .filter((e) => e.type === "received")
    .map((e) => e.id);

  let attachmentCounts: Record<string, number> = {};
  if (receivedIds.length > 0) {
    const counts = await db
      .select({
        emailId: attachments.emailId,
        count: sql<number>`COUNT(*)`,
      })
      .from(attachments)
      .where(
        sql`${attachments.emailId} IN (${sql.join(
          receivedIds.map((id) => sql`${id}`),
          sql`,`,
        )})`,
      )
      .groupBy(attachments.emailId);

    for (const row of counts) {
      attachmentCounts[row.emailId] = row.count;
    }
  }

  // Fetch attachment details for received emails
  let attachmentDetails: Record<string, any[]> = {};
  if (receivedIds.length > 0) {
    const attRows = await db
      .select()
      .from(attachments)
      .where(
        sql`${attachments.emailId} IN (${sql.join(
          receivedIds.map((id) => sql`${id}`),
          sql`,`,
        )})`,
      );

    for (const att of attRows) {
      if (!attachmentDetails[att.emailId]) {
        attachmentDetails[att.emailId] = [];
      }
      attachmentDetails[att.emailId].push(att);
    }
  }

  // Same lookup for sent emails so the chat/thread surface includes outgoing
  // attachments. Mirrors conversations-router; sent rows only have
  // kind='sent' attachment rows, so no kind filter is needed.
  const sentIds = paginated.filter((e) => e.type === "sent").map((e) => e.id);
  let sentAttachmentDetails: Record<string, any[]> = {};
  if (sentIds.length > 0) {
    const attRows = await db
      .select()
      .from(attachments)
      .where(
        sql`${attachments.emailId} IN (${sql.join(
          sentIds.map((id) => sql`${id}`),
          sql`,`,
        )})`,
      );

    for (const att of attRows) {
      if (!sentAttachmentDetails[att.emailId]) {
        sentAttachmentDetails[att.emailId] = [];
      }
      sentAttachmentDetails[att.emailId].push(att);
    }
  }

  const result = paginated.map((e) => {
    const atts =
      e.type === "sent"
        ? (sentAttachmentDetails[e.id] ?? [])
        : (attachmentDetails[e.id] ?? []);
    const count =
      e.type === "sent" ? atts.length : (attachmentCounts[e.id] ?? 0);
    return {
      ...e,
      attachmentCount: count,
      attachments: atts,
    };
  });

  // Collect distinct inbox addresses referenced by the returned emails.
  const inboxAddrs = new Set<string>();
  for (const e of result) {
    if (e.type === "received" && e.recipient) inboxAddrs.add(e.recipient);
    if (e.type === "sent" && e.fromAddress) inboxAddrs.add(e.fromAddress);
  }
  const addrList = [...inboxAddrs];

  const identities =
    addrList.length > 0
      ? await db
          .select({
            email: senderIdentities.email,
            displayName: senderIdentities.displayName,
            displayMode: senderIdentities.displayMode,
          })
          .from(senderIdentities)
          .where(inArray(senderIdentities.email, addrList))
      : [];
  const identityMap = new Map(identities.map((r) => [r.email, r]));

  const inboxesMeta = addrList.map((email) => {
    const id = identityMap.get(email);
    return {
      email,
      displayName: id?.displayName ?? null,
      displayMode: (id?.displayMode ?? "chat") as "thread" | "chat",
    };
  });

  return c.json({ emails: result, inboxes: inboxesMeta }, 200);
});

// Get single email detail
const getEmailRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Emails"],
  description: "Get a single email with full details.",
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

  // Look up the id in `emails` (received) first.
  const row = await db.select().from(emails).where(eq(emails.id, id)).limit(1);

  if (row.length > 0) {
    if (!allowed.isAdmin && !allowed.inboxes.includes(row[0].recipient)) {
      return c.json({ error: "Email not found" }, 404);
    }
    const atts = await db
      .select()
      .from(attachments)
      .where(eq(attachments.emailId, id));
    return c.json(
      {
        ...row[0],
        type: "received",
        timestamp: row[0].receivedAt,
        fromAddress: null,
        toAddress: null,
        cc: parseCc(row[0].cc),
        attachments: atts,
      },
      200,
    );
  }

  // Fall back to `sent_emails`. The reply route already accepts both
  // tables as reply targets, but historically this lookup didn't —
  // which meant ReplyComposer's "what you're replying to" panel never
  // rendered when the user clicked Reply on one of our own outgoing
  // messages, and the silent .catch in the client masked the 404.
  const sentRow = await db
    .select()
    .from(sentEmails)
    .where(eq(sentEmails.id, id))
    .limit(1);

  if (sentRow.length === 0) {
    return c.json({ error: "Email not found" }, 404);
  }

  // Authorization mirrors the reply route's defense-in-depth — only
  // surface a sent row to a caller who still owns the inbox that sent it.
  if (!allowed.isAdmin && !allowed.inboxes.includes(sentRow[0].fromAddress)) {
    return c.json({ error: "Email not found" }, 404);
  }

  const sent = sentRow[0];
  const sentAtts = await db
    .select()
    .from(attachments)
    .where(eq(attachments.emailId, id));
  return c.json(
    {
      id: sent.id,
      type: "sent",
      personId: sent.personId,
      recipient: null,
      fromAddress: sent.fromAddress,
      toAddress: sent.toAddress,
      subject: sent.subject,
      bodyHtml: sent.bodyHtml,
      bodyText: sent.bodyText,
      isRead: null,
      cc: parseCc(sent.cc),
      timestamp: sent.sentAt,
      attachments: sentAtts,
    },
    200,
  );
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

  const email = await db
    .select({
      personId: emails.personId,
      isRead: emails.isRead,
      recipient: emails.recipient,
    })
    .from(emails)
    .where(eq(emails.id, id))
    .limit(1);

  if (email.length === 0) {
    return c.json({ error: "Email not found" }, 404);
  }

  const allowed = c.get("allowedInboxes")!;
  if (!allowed.isAdmin && !allowed.inboxes.includes(email[0].recipient)) {
    return c.json({ error: "Email not found" }, 404);
  }

  const wasRead = email[0].isRead === 1;
  const nowRead = isRead;

  if (wasRead !== nowRead) {
    await db
      .update(emails)
      .set({ isRead: nowRead ? 1 : 0 })
      .where(eq(emails.id, id));

    // Update person unread count
    const delta = nowRead ? -1 : 1;
    await db
      .update(people)
      .set({
        unreadCount: sql`${people.unreadCount} + ${delta}`,
      })
      .where(eq(people.id, email[0].personId));
  }

  return c.json({ success: true }, 200);
});

// Bulk mark read/unread
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
    if (!allowed.isAdmin && !allowed.inboxes.includes(email[0].recipient))
      continue;

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
  if (!allowed.isAdmin) {
    const row = await db
      .select({ recipient: emails.recipient })
      .from(emails)
      .where(eq(emails.id, id))
      .limit(1);
    if (row.length > 0 && !allowed.inboxes.includes(row[0].recipient)) {
      return c.json({ error: "Email not found" }, 404);
    }
  }

  const result = await deleteEmailWithAttachments(db, r2, id);
  if (!result) {
    return c.json({ error: "Email not found" }, 404);
  }

  return c.json(result, 200);
});
