import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, sql, and, inArray } from "drizzle-orm";
import { emails } from "../db/emails.schema";
import { people } from "../db/people.schema";
import { json200Response } from "../lib/helpers";
import { queryMessages } from "../lib/messages/query";
import { EmailSchema } from "./emails-router";
import type { Variables } from "../variables";

export const conversationsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const ParticipantSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
});

const ConversationEmailsResponseSchema = z.object({
  conversation: z.object({
    id: z.string(),
    inbox: z.string(),
    participants: z.array(ParticipantSchema),
  }),
  emails: z.array(EmailSchema),
});

// GET /api/conversations/{id}/emails — full timeline for a group conversation.
const listConversationEmailsRoute = createRoute({
  method: "get",
  path: "/{id}/emails",
  tags: ["Conversations"],
  description:
    "List all emails in a group conversation, oldest first, with participants metadata. Each email includes attachment metadata when present.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    ...json200Response(
      ConversationEmailsResponseSchema,
      "Conversation timeline",
    ),
  },
});

conversationsRouter.openapi(listConversationEmailsRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const allowed = c.get("allowedInboxes")!;

  // This endpoint historically returns the entire conversation. The unified
  // service supports an explicit unbounded read for internal callers so the
  // message union/sort runs once rather than once per 100-row chunk.
  const page = await queryMessages(db, allowed, {
    conversationId: id,
    order: "asc",
    limit: null,
    withAttachmentCounts: true,
    withAttachments: true,
  });
  const messages = page.messages;

  if (messages.length === 0) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  const inbox = messages[messages.length - 1]?.inbox ?? "";

  const personIds = [
    ...new Set(
      messages
        .map((message) => message.personId)
        .filter((personId): personId is string => !!personId),
    ),
  ];
  const participants =
    personIds.length > 0
      ? await db
          .select({
            id: people.id,
            email: people.email,
            name: people.name,
          })
          .from(people)
          .where(inArray(people.id, personIds))
      : [];

  const mapped = messages.map((message) => ({
    id: message.ref.id,
    type: message.ref.kind,
    personId: message.personId,
    recipient: message.ref.kind === "received" ? message.inbox : null,
    fromAddress:
      message.ref.kind === "received"
        ? (message.from?.email ?? null)
        : (message.from?.email ?? message.inbox),
    toAddress: message.ref.kind === "sent" ? message.to.email : null,
    subject: message.subject,
    bodyHtml: message.bodyHtml,
    bodyText: message.bodyText,
    isRead: message.isRead === null ? null : message.isRead ? 1 : 0,
    cc: message.cc,
    timestamp: message.occurredAt,
    attachmentCount: message.attachmentCount ?? 0,
    attachments: message.attachments ?? [],
  }));

  return c.json(
    {
      conversation: {
        id,
        inbox,
        participants,
      },
      emails: mapped,
    },
    200,
  );
});

// Bulk-mark-read for one or more group conversations. Mirrors
// /api/people/mark-read but keyed by conversation_id. Used by the
// inbox-list bulk-action bar when the user has group rows selected.
const bulkMarkConversationsReadRoute = createRoute({
  method: "post",
  path: "/mark-read",
  tags: ["Conversations"],
  description:
    "Mark every unread email in the given group conversations as read.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            conversationIds: z.array(z.string()).min(1),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(
      z.object({
        success: z.boolean(),
        affected: z.number(),
      }),
      "Marked unread emails in the conversations as read",
    ),
  },
});

conversationsRouter.openapi(bulkMarkConversationsReadRoute, async (c) => {
  const db = c.get("db");
  const { conversationIds } = c.req.valid("json");
  const allowed = c.get("allowedInboxes")!;

  if (conversationIds.length === 0) {
    return c.json({ success: true, affected: 0 }, 200);
  }

  // Scope: drop any conversations whose recipient inbox isn't in the
  // caller's allowed set (admins can see everything). We do this by
  // filtering the conversation_id list to the ones with at least one
  // in-scope email row.
  let inScopeIds = conversationIds;
  if (!allowed.isAdmin) {
    if (allowed.inboxes.length === 0) {
      return c.json({ success: true, affected: 0 }, 200);
    }
    const inScope = await db
      .select({ conversationId: emails.conversationId })
      .from(emails)
      .where(
        and(
          inArray(emails.conversationId, conversationIds),
          inArray(emails.recipient, allowed.inboxes),
        )!,
      )
      .groupBy(emails.conversationId);
    inScopeIds = inScope
      .map((r) => r.conversationId)
      .filter((x): x is string => !!x);
    if (inScopeIds.length === 0) {
      return c.json({ success: true, affected: 0 }, 200);
    }
  }

  // Count + flip unread emails in those conversations.
  const where = and(
    inArray(emails.conversationId, inScopeIds),
    eq(emails.isRead, 0),
  )!;
  const countRows = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(emails)
    .where(where);
  const affected = countRows[0]?.count ?? 0;
  if (affected > 0) {
    await db.update(emails).set({ isRead: 1 }).where(where);
  }

  return c.json({ success: true, affected }, 200);
});
