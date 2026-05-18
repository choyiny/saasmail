import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createEmailSender } from "../lib/email-sender";
import { sentEmails } from "../db/sent-emails.schema";
import { people } from "../db/people.schema";
import { emails } from "../db/emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { json201Response } from "../lib/helpers";
import { cancelSequencesForPerson } from "../lib/cancel-sequence";
import { emailTemplates } from "../db/email-templates.schema";
import { interpolate, extractVariables } from "../lib/interpolate";
import type { Variables } from "../variables";
import { formatFromAddress } from "../lib/format-from-address";
import { assertInboxAllowed } from "../lib/inbox-permissions";
import { generateMessageId } from "../lib/message-id";
import { computeConversationId, externalsOnly } from "../lib/conversation-id";
import { parseSendBody, sendParseErrorResponse } from "../lib/multipart-send";
import { attachments } from "../db/attachments.schema";

/**
 * Fetch the set of "internal" domains (domains owned by our
 * sender_identities) for the current request — used to derive the
 * external-only participant list when computing a conversation_id.
 */
async function fetchInternalDomains(
  db: ReturnType<typeof OpenAPIHono.prototype.notFound> extends never
    ? unknown
    : unknown,
): Promise<string[]> {
  // Loose typing — we just need .select() and .from() to work. The actual
  // db value comes from c.get("db") which already has the correct type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await (db as any)
    .select({ email: senderIdentities.email })
    .from(senderIdentities);
  return Array.from(
    new Set(
      rows
        .map((r: { email: string }) => {
          const at = r.email.lastIndexOf("@");
          return at === -1 ? "" : r.email.slice(at + 1).toLowerCase();
        })
        .filter(Boolean),
    ),
  ) as string[];
}

export const sendRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const CcEntrySchema = z.object({
  email: z.string().email(),
  // Constrain the rendered "Name <addr>" header — long display names
  // can blow up the wire format and email headers in general.
  name: z.string().max(200).nullable().optional(),
});
type CcEntry = z.infer<typeof CcEntrySchema>;

// Practical cap on CC participants per message. Real-world replies-
// all rarely exceed a dozen; 50 is a generous ceiling that still
// blocks address-list spam payloads (stored as JSON in `cc`, then
// concatenated into outbound headers).
const MAX_CC_ENTRIES = 50;

/** Format a CC entry as a header-friendly "Name <addr>" string. */
function formatCc(c: CcEntry): string {
  return c.name ? `${c.name} <${c.email}>` : c.email;
}

const SendEmailSchema = z.object({
  to: z.string().email(),
  fromAddress: z.string().email(),
  cc: z.array(CcEntrySchema).max(MAX_CC_ENTRIES).optional(),
  subject: z.string().transform((s) => s.replace(/[\r\n]+/g, " ")),
  bodyHtml: z.string(),
  bodyText: z.string().optional(),
});

const SentEmailResponseSchema = z.object({
  id: z.string(),
  resendId: z.string().nullable(),
  status: z.string(),
  attachmentIds: z.array(z.string()),
});

// Compose and send a new email
const sendEmailRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Send"],
  description:
    "Compose and send a new email. multipart/form-data body with a JSON 'payload' field and zero or more 'files' fields.",
  request: {
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            payload: z.string().describe("JSON-encoded SendEmailSchema"),
            files: z.union([z.array(z.any()), z.any()]).optional(),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(SentEmailResponseSchema, "Email sent"),
  },
});

sendRouter.openapi(sendEmailRoute, async (c) => {
  const db = c.get("db");
  const sender = createEmailSender(c.env);

  const parsed = await parseSendBody(
    c,
    SendEmailSchema,
    sender.maxAttachmentBytes(),
  );
  if (!parsed.ok) {
    const { status, body } = sendParseErrorResponse(parsed.err);
    return c.json(body, status);
  }
  const { payload: raw, files } = parsed.value;

  const fromAddress = raw.fromAddress.trim().toLowerCase();
  const to = raw.to.trim().toLowerCase();
  const cc = raw.cc?.map((c) => ({
    email: c.email.trim().toLowerCase(),
    name: c.name ?? null,
  }));
  const { subject, bodyHtml, bodyText } = raw;
  const allowed = c.get("allowedInboxes")!;
  assertInboxAllowed(allowed, fromAddress);
  const now = Math.floor(Date.now() / 1000);

  const messageId = generateMessageId(fromAddress);
  const formattedFrom = await formatFromAddress(db, fromAddress);

  const result = await sender.send({
    from: formattedFrom,
    to,
    ...(cc && cc.length > 0 ? { cc: cc.map(formatCc) } : {}),
    subject,
    html: bodyHtml,
    text: bodyText,
    headers: { "Message-ID": messageId },
    ...(files.length > 0
      ? {
          attachments: files.map((f) => ({
            filename: f.filename,
            contentType: f.contentType,
            content: f.bytes,
          })),
        }
      : {}),
  });

  // Find or create the person row for this recipient.
  const existingPerson = await db
    .select({ id: people.id })
    .from(people)
    .where(eq(people.email, to))
    .limit(1);

  let personId: string;
  if (existingPerson[0]) {
    personId = existingPerson[0].id;
  } else {
    personId = nanoid();
    await db
      .insert(people)
      .values({
        id: personId,
        email: to,
        name: null,
        lastEmailAt: now,
        unreadCount: 0,
        totalCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: people.email });
    const refetched = await db
      .select({ id: people.id })
      .from(people)
      .where(eq(people.email, to))
      .limit(1);
    personId = refetched[0]!.id;
  }

  const internalDomains = await fetchInternalDomains(db);
  const externals = externalsOnly(
    [to, ...(cc ?? []).map((c) => c.email)],
    internalDomains,
  );
  const conversationId = await computeConversationId(fromAddress, externals);

  const id = nanoid();
  await db.insert(sentEmails).values({
    id,
    personId,
    fromAddress,
    toAddress: to,
    subject,
    bodyHtml,
    bodyText: bodyText ?? null,
    messageId,
    resendId: result.id,
    status: result.error ? "failed" : "sent",
    cc: cc && cc.length > 0 ? JSON.stringify(cc) : null,
    conversationId,
    sentAt: now,
    createdAt: now,
  });

  const attachmentIds = !result.error
    ? await persistSentAttachments(db, c.env, id, files, now)
    : [];

  await cancelSequencesForPerson(db, personId);

  return c.json(
    {
      id,
      resendId: result.id,
      status: result.error ? "failed" : "sent",
      attachmentIds,
    },
    201,
  );
});

const ReplyEmailSchema = z.object({
  bodyHtml: z.string().optional(),
  bodyText: z.string().optional(),
  fromAddress: z.string().email(),
  cc: z.array(CcEntrySchema).max(MAX_CC_ENTRIES).optional(),
  templateSlug: z.string().optional(),
  variables: z.record(z.string(), z.string()).optional(),
});

// Reply to an existing email
const replyEmailRoute = createRoute({
  method: "post",
  path: "/reply/{emailId}",
  tags: ["Send"],
  description:
    "Reply to a received email. multipart/form-data body with 'payload' JSON and optional 'files'.",
  request: {
    params: z.object({ emailId: z.string() }),
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            payload: z.string().describe("JSON-encoded reply body"),
            files: z.union([z.array(z.any()), z.any()]).optional(),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(SentEmailResponseSchema, "Reply sent"),
  },
});

sendRouter.openapi(replyEmailRoute, async (c) => {
  const db = c.get("db");
  const { emailId } = c.req.valid("param");
  const sender = createEmailSender(c.env);
  const parsed = await parseSendBody(
    c,
    ReplyEmailSchema,
    sender.maxAttachmentBytes(),
  );
  if (!parsed.ok) {
    const { status, body } = sendParseErrorResponse(parsed.err);
    return c.json(body, status);
  }
  const raw = parsed.value.payload;
  const files = parsed.value.files;
  // Same canonicalization story as the send route — lowercase the
  // inbox + recipient + CC emails before downstream use so stored
  // rows match the lowercased conversation_id.
  const fromAddress = raw.fromAddress.trim().toLowerCase();
  const cc = raw.cc?.map((c) => ({
    email: c.email.trim().toLowerCase(),
    name: c.name ?? null,
  }));
  const { bodyHtml, bodyText, templateSlug, variables } = raw;
  const allowed = c.get("allowedInboxes")!;
  assertInboxAllowed(allowed, fromAddress);
  const now = Math.floor(Date.now() / 1000);

  // Resolve the original across both received and sent tables.
  const receivedRow = await db
    .select()
    .from(emails)
    .where(eq(emails.id, emailId))
    .limit(1);

  let origPersonId: string;
  let origSubject: string | null;
  let origInReplyToMessageId: string | null;
  let toAddress: string;

  if (receivedRow.length > 0) {
    const orig = receivedRow[0];
    const person = await db
      .select({ email: people.email })
      .from(people)
      .where(eq(people.id, orig.personId))
      .limit(1);
    if (person.length === 0) {
      return c.json({ error: "Person not found" }, 404);
    }
    origPersonId = orig.personId;
    origSubject = orig.subject ?? null;
    origInReplyToMessageId = orig.messageId ?? null;
    // Canonicalize the recipient — older rows may be mixed-case.
    toAddress = person[0].email.toLowerCase();
  } else {
    const sentRow = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, emailId))
      .limit(1);
    if (sentRow.length === 0) {
      return c.json({ error: "Email not found" }, 404);
    }
    const orig = sentRow[0];
    // Defense-in-depth: only allow replies to sent rows whose original
    // fromAddress the caller still owns. Prevents a user from threading a
    // reply to another user's outgoing message via its id.
    assertInboxAllowed(allowed, orig.fromAddress);
    if (!orig.personId) {
      return c.json({ error: "Email has no associated person" }, 404);
    }
    origPersonId = orig.personId;
    origSubject = orig.subject ?? null;
    origInReplyToMessageId = orig.messageId ?? null;
    toAddress = orig.toAddress.toLowerCase();
  }

  // Determine subject and body
  let finalSubject: string;
  let finalBodyHtml: string;

  if (templateSlug) {
    // Template-based reply
    const templateRows = await db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.slug, templateSlug))
      .limit(1);

    if (templateRows.length === 0) {
      return c.json({ error: "Template not found" }, 404);
    }

    const template = templateRows[0];
    const vars = variables ?? {};

    // Validate required variables
    const subjectVars = extractVariables(template.subject);
    const bodyVars = extractVariables(template.bodyHtml);
    const requiredVars = Array.from(new Set([...subjectVars, ...bodyVars]));
    const missingVars = requiredVars.filter((v) => !(v in vars));

    if (missingVars.length > 0) {
      return c.json(
        {
          error: "Missing required template variables",
          missingVariables: missingVars,
          requiredVariables: requiredVars,
        },
        400,
      );
    }

    finalSubject = interpolate(template.subject, vars);
    finalBodyHtml = interpolate(template.bodyHtml, vars);
  } else if (bodyHtml) {
    // Freeform reply
    finalSubject = origSubject?.startsWith("Re: ")
      ? origSubject
      : `Re: ${origSubject || ""}`;
    finalBodyHtml = bodyHtml;
  } else {
    return c.json(
      { error: "Either bodyHtml or templateSlug is required" },
      400,
    );
  }

  const messageId = generateMessageId(fromAddress);
  const formattedFrom = await formatFromAddress(db, fromAddress);
  const result = await sender.send({
    from: formattedFrom,
    to: toAddress,
    ...(cc && cc.length > 0 ? { cc: cc.map(formatCc) } : {}),
    subject: finalSubject,
    html: finalBodyHtml,
    text: bodyText,
    headers: {
      "Message-ID": messageId,
      ...(origInReplyToMessageId
        ? { "In-Reply-To": origInReplyToMessageId }
        : {}),
    },
    ...(files.length > 0
      ? {
          attachments: files.map((f) => ({
            filename: f.filename,
            contentType: f.contentType,
            content: f.bytes,
          })),
        }
      : {}),
  });

  // Compute conversation_id for this reply.
  const internalDomainsReply = await fetchInternalDomains(db);
  const externalsReply = externalsOnly(
    [toAddress, ...(cc ?? []).map((c) => c.email)],
    internalDomainsReply,
  );
  const conversationIdReply = await computeConversationId(
    fromAddress,
    externalsReply,
  );

  // Store sent email
  const id = nanoid();
  await db.insert(sentEmails).values({
    id,
    personId: origPersonId,
    fromAddress,
    toAddress,
    subject: finalSubject,
    bodyHtml: finalBodyHtml,
    bodyText: bodyText ?? null,
    inReplyTo: origInReplyToMessageId,
    messageId,
    resendId: result.id,
    status: result.error ? "failed" : "sent",
    cc: cc && cc.length > 0 ? JSON.stringify(cc) : null,
    conversationId: conversationIdReply,
    sentAt: now,
    createdAt: now,
  });

  const attachmentIds = !result.error
    ? await persistSentAttachments(db, c.env, id, files, now)
    : [];

  // Cancel any active sequences for this person
  await cancelSequencesForPerson(db, origPersonId);

  return c.json(
    {
      id,
      resendId: result.id,
      status: result.error ? "failed" : "sent",
      attachmentIds,
    },
    201,
  );
});

async function persistSentAttachments(
  db: Variables["db"],
  env: CloudflareBindings,
  sentEmailId: string,
  files: {
    filename: string;
    contentType: string;
    bytes: Uint8Array;
    size: number;
  }[],
  now: number,
): Promise<string[]> {
  if (files.length === 0) return [];
  const rows = files.map((f) => {
    const attachmentId = nanoid();
    const r2Key = `attachments/sent/${sentEmailId}/${attachmentId}/${f.filename}`;
    return { attachmentId, r2Key, file: f };
  });
  await Promise.all(
    rows.map((r) =>
      env.R2.put(r.r2Key, r.file.bytes, {
        httpMetadata: { contentType: r.file.contentType },
      }),
    ),
  );
  await db.insert(attachments).values(
    rows.map((r) => ({
      id: r.attachmentId,
      emailId: sentEmailId,
      kind: "sent" as const,
      filename: r.file.filename,
      contentType: r.file.contentType,
      size: r.file.size,
      r2Key: r.r2Key,
      contentId: null,
      createdAt: now,
    })),
  );
  return rows.map((r) => r.attachmentId);
}
