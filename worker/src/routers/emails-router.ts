import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, desc, like, and, sql } from "drizzle-orm";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { attachments } from "../db/attachments.schema";
import { senders } from "../db/senders.schema";
import { json200Response } from "../lib/helpers";
import { deleteEmailWithAttachments } from "../lib/delete-email";
import type { Variables } from "../variables";

export const emailsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const EmailSchema = z.object({
  id: z.string(),
  type: z.enum(["received", "sent"]),
  senderId: z.string().nullable(),
  recipient: z.string().nullable(),
  fromAddress: z.string().nullable(),
  toAddress: z.string().nullable(),
  subject: z.string().nullable(),
  bodyHtml: z.string().nullable(),
  bodyText: z.string().nullable(),
  isRead: z.number().nullable(),
  timestamp: z.number(),
  attachmentCount: z.number().optional(),
});

// List emails for a sender (received + sent interleaved)
const listSenderEmailsRoute = createRoute({
  method: "get",
  path: "/by-sender/{senderId}",
  tags: ["Emails"],
  description:
    "List all emails for a sender (received and sent, interleaved chronologically).",
  request: {
    params: z.object({ senderId: z.string() }),
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
    ...json200Response(z.array(EmailSchema), "Emails for sender"),
  },
});

emailsRouter.openapi(listSenderEmailsRoute, async (c) => {
  const db = c.get("db");
  const { senderId } = c.req.valid("param");
  const { q, recipient, page, limit } = c.req.valid("query");
  const offset = (page - 1) * limit;

  // Build conditions for received emails
  const receivedConditions: any[] = [eq(emails.senderId, senderId)];
  if (q) {
    receivedConditions.push(like(emails.subject, `%${q}%`));
  }
  if (recipient) {
    receivedConditions.push(eq(emails.recipient, recipient));
  }

  const received = await db
    .select({
      id: emails.id,
      subject: emails.subject,
      bodyHtml: emails.bodyHtml,
      bodyText: emails.bodyText,
      isRead: emails.isRead,
      timestamp: emails.receivedAt,
      recipient: emails.recipient,
    })
    .from(emails)
    .where(and(...receivedConditions))
    .orderBy(desc(emails.receivedAt));

  // Build conditions for sent emails
  const sentConditions: any[] = [eq(sentEmails.senderId, senderId)];
  if (q) {
    sentConditions.push(like(sentEmails.subject, `%${q}%`));
  }
  if (recipient) {
    sentConditions.push(eq(sentEmails.toAddress, recipient));
  }

  const sent = await db
    .select({
      id: sentEmails.id,
      subject: sentEmails.subject,
      bodyHtml: sentEmails.bodyHtml,
      bodyText: sentEmails.bodyText,
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
      senderId,
      recipient: e.recipient,
      fromAddress: null,
      toAddress: null,
      subject: e.subject,
      bodyHtml: e.bodyHtml,
      bodyText: e.bodyText,
      isRead: e.isRead,
      timestamp: e.timestamp,
    })),
    ...sent.map((e) => ({
      id: e.id,
      type: "sent" as const,
      senderId,
      recipient: null,
      fromAddress: e.fromAddress,
      toAddress: e.toAddress,
      subject: e.subject,
      bodyHtml: e.bodyHtml,
      bodyText: e.bodyText,
      isRead: null,
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

  const result = paginated.map((e) => ({
    ...e,
    attachmentCount: attachmentCounts[e.id] ?? 0,
    attachments: attachmentDetails[e.id] ?? [],
  }));

  return c.json(result, 200);
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

  const row = await db.select().from(emails).where(eq(emails.id, id)).limit(1);

  if (row.length === 0) {
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
      attachments: atts,
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
    .select({ senderId: emails.senderId, isRead: emails.isRead })
    .from(emails)
    .where(eq(emails.id, id))
    .limit(1);

  if (email.length === 0) {
    return c.json({ error: "Email not found" }, 404);
  }

  const wasRead = email[0].isRead === 1;
  const nowRead = isRead;

  if (wasRead !== nowRead) {
    await db
      .update(emails)
      .set({ isRead: nowRead ? 1 : 0 })
      .where(eq(emails.id, id));

    // Update sender unread count
    const delta = nowRead ? -1 : 1;
    await db
      .update(senders)
      .set({
        unreadCount: sql`${senders.unreadCount} + ${delta}`,
      })
      .where(eq(senders.id, email[0].senderId));
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

  for (const id of ids) {
    const email = await db
      .select({ senderId: emails.senderId, isRead: emails.isRead })
      .from(emails)
      .where(eq(emails.id, id))
      .limit(1);

    if (email.length === 0) continue;

    const wasRead = email[0].isRead === 1;
    if (wasRead !== isRead) {
      await db
        .update(emails)
        .set({ isRead: isRead ? 1 : 0 })
        .where(eq(emails.id, id));

      const delta = isRead ? -1 : 1;
      await db
        .update(senders)
        .set({ unreadCount: sql`${senders.unreadCount} + ${delta}` })
        .where(eq(senders.id, email[0].senderId));
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

  const result = await deleteEmailWithAttachments(db, r2, id);
  if (!result) {
    return c.json({ error: "Email not found" }, 404);
  }

  return c.json(result, 200);
});
