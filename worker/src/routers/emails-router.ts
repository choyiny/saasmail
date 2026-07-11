import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, desc, like, and, sql, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
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
  attachmentCount: z.number().optional(),
  replyTo: z
    .string()
    .nullable()
    .optional()
    .openapi({
      description:
        "Address from the inbound Reply-To header, when present (e.g. a " +
        "contact form's actual submitter behind a noreply@ sender). Parsed " +
        "from stored raw headers and returned by the single-email endpoint; " +
        "null when there is no Reply-To.",
    }),
});

/**
 * Pull the Reply-To address out of an email's stored raw headers.
 * `raw_headers` is a JSON object of all inbound headers (see email-handler),
 * so no schema change is needed to surface this. Returns the bare address
 * (lower-cased), unwrapping a "Name <addr>" form. Null when absent/malformed.
 */
function extractReplyTo(rawHeaders: string | null): string | null {
  if (!rawHeaders) return null;
  try {
    const headers = JSON.parse(rawHeaders) as Record<string, unknown>;
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === "reply-to" && typeof value === "string") {
        const angle = value.match(/<([^>]+)>/);
        const addr = (angle ? angle[1] : value).trim().toLowerCase();
        return addr || null;
      }
    }
  } catch {
    // Malformed raw_headers — treat as no Reply-To rather than failing the read.
  }
  return null;
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
      status: sentEmails.status,
    })
    .from(sentEmails)
    .where(and(...sentConditions))
    .orderBy(desc(sentEmails.sentAt));

  const personRow = await db
    .select({ email: people.email })
    .from(people)
    .where(eq(people.id, personId))
    .limit(1);
  const personEmail = personRow[0]?.email ?? null;

  // Merge and sort
  const merged = [
    ...received.map((e) => ({
      id: e.id,
      type: "received" as const,
      personId,
      recipient: e.recipient,
      fromAddress: personEmail,
      toAddress: null,
      subject: e.subject,
      bodyHtml: e.bodyHtml,
      bodyText: e.bodyText,
      isRead: e.isRead,
      cc: parseCc(e.cc),
      timestamp: e.timestamp,
      status: null,
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
      status: e.status,
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
    const senderRow = await db
      .select({ email: people.email })
      .from(people)
      .where(eq(people.id, row[0].personId))
      .limit(1);
    return c.json(
      {
        ...row[0],
        type: "received",
        timestamp: row[0].receivedAt,
        fromAddress: senderRow[0]?.email ?? null,
        toAddress: null,
        replyTo: extractReplyTo(row[0].rawHeaders),
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
      replyTo: null,
      cc: parseCc(sent.cc),
      timestamp: sent.sentAt,
      status: sent.status,
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
    })
    .from(emails)
    .where(eq(emails.id, id))
    .limit(1);
  if (recv.length > 0) {
    const target = recv[0];
    if (!allowed.isAdmin && !allowed.inboxes.includes(target.recipient)) {
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
      await db
        .update(emails)
        .set({ personId: person.id })
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
  if (!allowed.isAdmin && !allowed.inboxes.includes(sent.fromAddress)) {
    return c.json({ error: "Email not found" }, 404);
  }
  // A new sending identity must be one the caller owns.
  if (newFrom && !allowed.isAdmin && !allowed.inboxes.includes(newFrom)) {
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
