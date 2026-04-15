import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { Resend } from "resend";
import { sentEmails } from "../db/sent-emails.schema";
import { senders } from "../db/senders.schema";
import { emails } from "../db/emails.schema";
import { json201Response } from "../lib/helpers";
import { cancelSequencesForSender } from "../lib/cancel-sequence";
import type { Variables } from "../variables";

export const sendRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const SendEmailSchema = z.object({
  to: z.string().email(),
  subject: z.string(),
  bodyHtml: z.string(),
  bodyText: z.string().optional(),
});

const SentEmailResponseSchema = z.object({
  id: z.string(),
  resendId: z.string().nullable(),
  status: z.string(),
});

// Compose and send a new email
const sendEmailRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Send"],
  description: "Compose and send a new email via Resend.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: SendEmailSchema,
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
  const { to, subject, bodyHtml, bodyText } = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);
  const fromAddress = c.env.RESEND_EMAIL_FROM;

  // Send via Resend
  const resend = new Resend(c.env.RESEND_API_KEY);
  const result = await resend.emails.send({
    from: fromAddress,
    to,
    subject,
    html: bodyHtml,
    text: bodyText,
  });

  // Find sender if they exist
  const existingSender = await db
    .select({ id: senders.id })
    .from(senders)
    .where(eq(senders.email, to))
    .limit(1);

  const senderId = existingSender[0]?.id ?? null;

  // Store sent email
  const id = nanoid();
  await db.insert(sentEmails).values({
    id,
    senderId,
    fromAddress,
    toAddress: to,
    subject,
    bodyHtml,
    bodyText: bodyText ?? null,
    resendId: result.data?.id ?? null,
    status: result.error ? "failed" : "sent",
    sentAt: now,
    createdAt: now,
  });

  // Cancel any active sequences for this recipient
  if (senderId) {
    await cancelSequencesForSender(db, senderId);
  }

  return c.json(
    {
      id,
      resendId: result.data?.id ?? null,
      status: result.error ? "failed" : "sent",
    },
    201,
  );
});

// Reply to an existing email
const replyEmailRoute = createRoute({
  method: "post",
  path: "/reply/{emailId}",
  tags: ["Send"],
  description: "Reply to a received email.",
  request: {
    params: z.object({ emailId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            bodyHtml: z.string(),
            bodyText: z.string().optional(),
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
  const { bodyHtml, bodyText } = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);
  const fromAddress = c.env.RESEND_EMAIL_FROM;

  // Get the original email
  const original = await db
    .select()
    .from(emails)
    .where(eq(emails.id, emailId))
    .limit(1);

  if (original.length === 0) {
    return c.json({ error: "Email not found" }, 404);
  }

  const orig = original[0];

  // Get sender email address
  const sender = await db
    .select({ email: senders.email })
    .from(senders)
    .where(eq(senders.id, orig.senderId))
    .limit(1);

  if (sender.length === 0) {
    return c.json({ error: "Sender not found" }, 404);
  }

  const toAddress = sender[0].email;
  const subject = orig.subject?.startsWith("Re: ")
    ? orig.subject
    : `Re: ${orig.subject || ""}`;

  // Send via Resend
  const resend = new Resend(c.env.RESEND_API_KEY);
  const result = await resend.emails.send({
    from: fromAddress,
    to: toAddress,
    subject,
    html: bodyHtml,
    text: bodyText,
    headers: orig.messageId ? { "In-Reply-To": orig.messageId } : undefined,
  });

  // Store sent email
  const id = nanoid();
  await db.insert(sentEmails).values({
    id,
    senderId: orig.senderId,
    fromAddress,
    toAddress,
    subject,
    bodyHtml,
    bodyText: bodyText ?? null,
    inReplyTo: orig.messageId,
    resendId: result.data?.id ?? null,
    status: result.error ? "failed" : "sent",
    sentAt: now,
    createdAt: now,
  });

  // Cancel any active sequences for this sender
  await cancelSequencesForSender(db, orig.senderId);

  return c.json(
    {
      id,
      resendId: result.data?.id ?? null,
      status: result.error ? "failed" : "sent",
    },
    201,
  );
});
