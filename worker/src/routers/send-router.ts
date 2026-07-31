import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createEmailSender } from "../lib/email-sender";
import { json201Response } from "../lib/helpers";
import type { Variables } from "../variables";
import { parseSendBody, sendParseErrorResponse } from "../lib/multipart-send";
import { replyToEmail, sendEmail } from "../lib/send-email";
import { bearerSecurity } from "../lib/openapi-auth";
import {
  inboxForbiddenResponse,
  multipartParseErrorResponses,
  replyNotFoundResponse,
  replyValidationErrorResponse,
} from "../lib/openapi-send-errors";

export const sendRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

export const CcEntrySchema = z
  .object({
    email: z.string().email().openapi({ example: "cc@example.com" }),
    // Constrain the rendered "Name <addr>" header — long display names
    // can blow up the wire format and email headers in general.
    name: z.string().max(200).nullable().optional().openapi({
      description: "Display name rendered as 'Name <email>' in headers.",
      example: "Jane Smith",
    }),
  })
  .openapi("CcEntry");
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

export const SendEmailSchema = z
  .object({
    to: z.string().email().openapi({
      description: "Recipient email address.",
      example: "recipient@example.com",
    }),
    fromAddress: z.string().email().openapi({
      description:
        "Sender address. Must be a sender identity configured in this SaaSMail instance.",
      example: "noreply@yourdomain.com",
    }),
    cc: z
      .array(CcEntrySchema)
      .max(MAX_CC_ENTRIES)
      .optional()
      .openapi({
        description: `CC recipients. Maximum ${MAX_CC_ENTRIES} entries.`,
      }),
    subject: z
      .string()
      .openapi({
        description: "Email subject line. Newlines are collapsed to spaces.",
        example: "Welcome to our service",
      })
      .transform((s) => s.replace(/[\r\n]+/g, " ")),
    bodyHtml: z.string().openapi({
      description: "HTML body of the email.",
      example: "<p>Hello, world!</p>",
    }),
    bodyText: z.string().optional().openapi({
      description:
        "Plain-text fallback body. Recommended for accessibility and deliverability.",
      example: "Hello, world!",
    }),
    replyTo: z.string().email().optional().openapi({
      description:
        "Address that receives the response when the recipient hits Reply. If omitted, replies go to fromAddress. Useful for contact-form-style flows where messages are sent from a tenant-owned address like noreply@ but replies should go to the actual submitter.",
      example: "submitter@example.com",
    }),
    // Transactional sends bypass the suppression list (password resets, OTPs,
    // receipts). Marketing-style sends default to false and respect the list.
    transactional: z.boolean().optional().default(false).openapi({
      description:
        "When true, bypasses the suppression list (for transactional mail like password resets, OTPs, and receipts). Defaults to false, which respects the suppression list.",
    }),
  })
  .openapi("SendEmailSchema");

const SentEmailResponseSchema = z.object({
  id: z.string().nullable(),
  resendId: z.string().nullable(),
  status: z.string().openapi({
    description:
      'Delivery status. "sent" = delivered; "retrying" = transient provider failure — saasmail queues this in the outbox and retries automatically (check GET /api/outbox for resolution); "failed" = provider permanently rejected; "suppressed" = every recipient was on the suppression list.',
  }),
  attachmentIds: z.array(z.string()),
  delivered: z.array(z.string()).default([]),
  suppressed: z.array(z.string()).default([]),
});

// Compose and send a new email
const sendEmailRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Send"],
  security: bearerSecurity,
  description:
    "Compose and send a new email. The request body is multipart/form-data with a JSON `payload` field containing a SendEmailSchema object, and zero or more `files` fields for attachments.",
  request: {
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            payload: z.string().openapi({
              description:
                "JSON-encoded SendEmailSchema. Required fields: `to`, `fromAddress`, `subject`, `bodyHtml`. See the SendEmailSchema component for the full field reference.",
              example: JSON.stringify(
                {
                  to: "recipient@example.com",
                  fromAddress: "noreply@yourdomain.com",
                  subject: "Welcome to our service",
                  bodyHtml: "<p>Hello!</p>",
                  bodyText: "Hello!",
                  transactional: false,
                },
                null,
                2,
              ),
            }),
            files: z
              .union([z.array(z.any()), z.any()])
              .optional()
              .openapi({ description: "Zero or more file attachments." }),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(SentEmailResponseSchema, "Email sent"),
    ...multipartParseErrorResponses,
    ...inboxForbiddenResponse,
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
  const { payload, files } = parsed.value;

  const result = await sendEmail({
    db,
    env: c.env,
    payload,
    files,
    allowed: c.get("allowedInboxes")!,
  });

  return c.json(
    {
      id: result.id,
      resendId: result.resendId,
      status: result.status,
      attachmentIds: result.attachmentIds,
      delivered: result.delivered,
      suppressed: result.suppressed,
    },
    201,
  );
});

export const ReplyEmailSchema = z
  .object({
    fromAddress: z.string().email().openapi({
      description:
        "Sending identity for the reply. Must be one of your configured inboxes.",
      example: "support@yourdomain.com",
    }),
    bodyHtml: z.string().optional().openapi({
      description:
        "HTML reply body. Provide bodyHtml and/or bodyText unless templateSlug is set.",
    }),
    bodyText: z.string().optional().openapi({
      description: "Plain-text reply body.",
    }),
    cc: z
      .array(CcEntrySchema)
      .max(MAX_CC_ENTRIES)
      .optional()
      .openapi({
        description: `CC recipients. Maximum ${MAX_CC_ENTRIES} entries.`,
      }),
    templateSlug: z.string().optional().openapi({
      description:
        "Optional template slug to render as the reply body instead of bodyHtml/bodyText.",
    }),
    variables: z.record(z.string(), z.string()).optional().openapi({
      description: "Template variables when templateSlug is set.",
    }),
    replyTo: z.string().email().optional().openapi({
      description: "Override Reply-To header for this reply.",
      example: "submitter@example.com",
    }),
  })
  .openapi("ReplyEmailSchema");

// Reply to an existing email
const replyEmailRoute = createRoute({
  method: "post",
  path: "/reply/{emailId}",
  tags: ["Send"],
  security: bearerSecurity,
  description:
    "Reply to a received email. multipart/form-data body with 'payload' JSON and optional 'files'.",
  request: {
    params: z.object({ emailId: z.string() }),
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            payload: z.string().openapi({
              description:
                "JSON-encoded ReplyEmailSchema. Required: `fromAddress`. Provide bodyHtml/bodyText or templateSlug. See the ReplyEmailSchema component for the full field reference.",
              example: JSON.stringify(
                {
                  fromAddress: "support@yourdomain.com",
                  bodyHtml: "<p>Thanks for reaching out — we're on it.</p>",
                  bodyText: "Thanks for reaching out — we're on it.",
                },
                null,
                2,
              ),
            }),
            files: z.union([z.array(z.any()), z.any()]).optional(),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(SentEmailResponseSchema, "Reply sent"),
    ...replyValidationErrorResponse,
    413: multipartParseErrorResponses[413],
    ...inboxForbiddenResponse,
    ...replyNotFoundResponse,
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
  const { payload, files } = parsed.value;

  const result = await replyToEmail({
    db,
    env: c.env,
    emailId,
    payload,
    files,
    allowed: c.get("allowedInboxes")!,
  });

  if (!result.ok) {
    if (result.code === "MISSING_VARIABLES") {
      return c.json(
        {
          error: result.message,
          missingVariables: result.missingVariables,
          requiredVariables: result.requiredVariables,
        },
        400,
      );
    }
    if (result.code === "MISSING_BODY") {
      return c.json({ error: result.message }, 400);
    }
    return c.json({ error: result.message }, 404);
  }

  return c.json(
    {
      id: result.id,
      resendId: result.resendId,
      status: result.status,
      attachmentIds: result.attachmentIds,
    },
    201,
  );
});
