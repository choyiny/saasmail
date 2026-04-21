import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createEmailSender } from "../lib/email-sender";
import { sentEmails } from "../db/sent-emails.schema";
import { people } from "../db/people.schema";
import { emails } from "../db/emails.schema";
import { json201Response } from "../lib/helpers";
import { cancelSequencesForPerson } from "../lib/cancel-sequence";
import { emailTemplates } from "../db/email-templates.schema";
import { interpolate, extractVariables } from "../lib/interpolate";
import type { Variables } from "../variables";
import { formatFromAddress } from "../lib/format-from-address";
import { assertInboxAllowed } from "../lib/inbox-permissions";
import { generateMessageId } from "../lib/message-id";

export const sendRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const SendEmailSchema = z.object({
  to: z.string().email(),
  fromAddress: z.string().email(),
  subject: z.string().transform((s) => s.replace(/[\r\n]+/g, " ")),
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
  const { to, fromAddress, subject, bodyHtml, bodyText } = c.req.valid("json");
  const allowed = c.get("allowedInboxes")!;
  assertInboxAllowed(allowed, fromAddress);
  const now = Math.floor(Date.now() / 1000);

  const messageId = generateMessageId(fromAddress);
  const sender = createEmailSender(c.env);
  const formattedFrom = await formatFromAddress(db, fromAddress);
  const result = await sender.send({
    from: formattedFrom,
    to,
    subject,
    html: bodyHtml,
    text: bodyText,
    headers: { "Message-ID": messageId },
  });

  // Find person if they exist
  const existingPerson = await db
    .select({ id: people.id })
    .from(people)
    .where(eq(people.email, to))
    .limit(1);

  const personId = existingPerson[0]?.id ?? null;

  // Store sent email
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
    sentAt: now,
    createdAt: now,
  });

  // Cancel any active sequences for this recipient
  if (personId) {
    await cancelSequencesForPerson(db, personId);
  }

  return c.json(
    {
      id,
      resendId: result.id,
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
            bodyHtml: z.string().optional(),
            bodyText: z.string().optional(),
            fromAddress: z.string().email(),
            templateSlug: z.string().optional(),
            variables: z.record(z.string(), z.string()).optional(),
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
  const { bodyHtml, bodyText, fromAddress, templateSlug, variables } =
    c.req.valid("json");
  const allowed = c.get("allowedInboxes")!;
  assertInboxAllowed(allowed, fromAddress);
  const now = Math.floor(Date.now() / 1000);

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

  // Get person email address
  const person = await db
    .select({ email: people.email })
    .from(people)
    .where(eq(people.id, orig.personId))
    .limit(1);

  if (person.length === 0) {
    return c.json({ error: "Person not found" }, 404);
  }

  const toAddress = person[0].email;

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
    finalSubject = orig.subject?.startsWith("Re: ")
      ? orig.subject
      : `Re: ${orig.subject || ""}`;
    finalBodyHtml = bodyHtml;
  } else {
    return c.json(
      { error: "Either bodyHtml or templateSlug is required" },
      400,
    );
  }

  const messageId = generateMessageId(fromAddress);
  const sender = createEmailSender(c.env);
  const formattedFrom = await formatFromAddress(db, fromAddress);
  const result = await sender.send({
    from: formattedFrom,
    to: toAddress,
    subject: finalSubject,
    html: finalBodyHtml,
    text: bodyText,
    headers: {
      "Message-ID": messageId,
      ...(orig.messageId ? { "In-Reply-To": orig.messageId } : {}),
    },
  });

  // Store sent email
  const id = nanoid();
  await db.insert(sentEmails).values({
    id,
    personId: orig.personId,
    fromAddress,
    toAddress,
    subject: finalSubject,
    bodyHtml: finalBodyHtml,
    bodyText: bodyText ?? null,
    inReplyTo: orig.messageId,
    messageId,
    resendId: result.id,
    status: result.error ? "failed" : "sent",
    sentAt: now,
    createdAt: now,
  });

  // Cancel any active sequences for this person
  await cancelSequencesForPerson(db, orig.personId);

  return c.json(
    {
      id,
      resendId: result.id,
      status: result.error ? "failed" : "sent",
    },
    201,
  );
});
