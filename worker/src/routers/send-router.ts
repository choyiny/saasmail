import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createEmailSender } from "../lib/email-sender";
import type { Variables } from "../variables";
import { parseSendBody, sendParseErrorResponse } from "../lib/multipart-send";
import { replyToEmail, sendEmail } from "../lib/send-email";
import { bearerSecurity } from "../lib/openapi-auth";
import { MAX_CC_ENTRIES } from "../lib/send-limits";
import { respondIdempotently } from "../lib/idempotent-send-route";
import { sendRequestFields } from "../lib/send-idempotency";
import {
  dailySendLimitResponses,
  idempotencyConflictResponses,
  idempotencyKeyHeader,
  idempotent201Response,
  inboxForbiddenResponse,
  multipartParseErrorResponses,
  replyNotFoundResponse,
  replyValidationErrorResponse,
} from "../lib/openapi-send-errors";
import { templateVariablesSchema } from "../lib/template-variables-schema";

export const sendRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

export const CcEntrySchema = z
  .object({
    email: z.string().email().openapi({ example: "cc@example.com" }),
    // Constrain the rendered "Name <addr>" header — long display names
    // can blow up the wire format and email headers in general.
    name: z
      .string()
      .max(200)
      // A line break would end the header it is written into.
      .regex(/^[^\r\n]*$/, "Display names cannot contain line breaks")
      .nullable()
      .optional()
      .openapi({
        description: "Display name rendered as 'Name <email>' in headers.",
        example: "Jane Smith",
      }),
  })
  .openapi("CcEntry");
type CcEntry = z.infer<typeof CcEntrySchema>;

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
        "When true, bypasses the suppression list and skips the List-Unsubscribe headers and unsubscribe footer. Use for transactional or 1:1 mail such as password resets, OTPs, receipts, and person-to-person messages. Defaults to false, which respects suppression and adds unsubscribe metadata.",
    }),
    idempotencyKey: z.string().optional().openapi({
      description:
        "Same as the `Idempotency-Key` header, for clients that cannot set one; the header wins.",
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
  paused: z.boolean().optional().openapi({
    description:
      "`true` when outbound sending is paused: the message is recorded and held (`status` is `retrying`) and goes out when sending resumes.",
  }),
});

// Compose and send a new email
const sendEmailRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Send"],
  security: bearerSecurity,
  description:
    "Compose and send a new email. The request body is multipart/form-data with a JSON `payload` field containing a SendEmailSchema object, and zero or more `files` fields for attachments. Send an `Idempotency-Key` so that a retry never sends twice.",
  request: {
    headers: idempotencyKeyHeader,
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
    ...idempotent201Response(SentEmailResponseSchema, "Email sent"),
    ...multipartParseErrorResponses,
    ...inboxForbiddenResponse,
    ...idempotencyConflictResponses,
    ...dailySendLimitResponses,
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
  const { idempotencyKey, ...payload } = parsed.value.payload;
  const { files } = parsed.value;

  return respondIdempotently(
    c,
    {
      payloadKey: idempotencyKey,
      fields: { kind: "send", ...sendRequestFields(payload) },
      files,
    },
    async () => {
      const result = await sendEmail({
        db,
        env: c.env,
        payload,
        files,
        allowed: c.get("allowedInboxes")!,
      });
      return {
        status: 201,
        body: {
          id: result.id,
          resendId: result.resendId,
          status: result.status,
          attachmentIds: result.attachmentIds,
          delivered: result.delivered,
          suppressed: result.suppressed,
          ...(result.paused ? { paused: true } : {}),
        },
        sentEmailId: result.id,
      };
    },
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
    variables: templateVariablesSchema.optional().openapi({
      description:
        "Template variables when templateSlug is set. Values may be nested arrays/objects for `{{#section}}` bodies.",
    }),
    replyTo: z.string().email().optional().openapi({
      description: "Override Reply-To header for this reply.",
      example: "submitter@example.com",
    }),
    idempotencyKey: z.string().optional().openapi({
      description:
        "Same as the `Idempotency-Key` header, for clients that cannot set one; the header wins.",
    }),
    recipient: z.enum(["reply_to", "sender"]).optional().openapi({
      description:
        "Who a reply to a received message is addressed to. `reply_to` (the default) follows the message's Reply-To header: its first address becomes To and the others are added to Cc, skipping this instance's own inboxes; without a usable Reply-To the reply goes to the sender. `sender` always answers the From address. Ignored when replying to a sent message.",
      example: "sender",
    }),
  })
  .openapi("ReplyEmailSchema");

const ReplyEmailResponseSchema = SentEmailResponseSchema.extend({
  to: z.string().openapi({
    description: "The address the reply was sent to.",
    example: "support@acme.com",
  }),
  cc: z.array(z.string()).openapi({
    description:
      "Every address the reply was copied to: the Cc of the request plus, when the reply followed a Reply-To header with several addresses, the ones after the first.",
  }),
  repliedTo: z.enum(["reply_to", "sender"]).openapi({
    description:
      "`reply_to` when `to` came from the original's Reply-To header, `sender` when it is the original's sender (or, for a sent original, its recipient).",
  }),
});

// Reply to an existing email
const replyEmailRoute = createRoute({
  method: "post",
  path: "/reply/{emailId}",
  tags: ["Send"],
  security: bearerSecurity,
  description:
    "Reply to a received or sent email. multipart/form-data body with 'payload' JSON and optional 'files'. A reply to a received message goes to its Reply-To address when it has one, unless the payload says `recipient: \"sender\"`; the response's `to` is the address used.",
  request: {
    params: z.object({ emailId: z.string() }),
    headers: idempotencyKeyHeader,
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
    ...idempotent201Response(ReplyEmailResponseSchema, "Reply sent"),
    ...replyValidationErrorResponse,
    413: multipartParseErrorResponses[413],
    ...inboxForbiddenResponse,
    ...replyNotFoundResponse,
    ...idempotencyConflictResponses,
    ...dailySendLimitResponses,
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
  const { files } = parsed.value;
  const { recipient, idempotencyKey, ...replyPayload } = parsed.value.payload;

  return respondIdempotently(
    c,
    {
      payloadKey: idempotencyKey,
      fields: {
        kind: "reply",
        emailId,
        recipient,
        templateSlug: replyPayload.templateSlug,
        variables: replyPayload.variables,
        ...sendRequestFields(replyPayload),
      },
      files,
    },
    async () => {
      const result = await replyToEmail({
        db,
        env: c.env,
        emailId,
        payload: replyPayload,
        files,
        allowed: c.get("allowedInboxes")!,
        recipient,
      });

      // Refusals are answered, not remembered: a corrected retry may run.
      if (!result.ok) {
        if (result.code === "MISSING_VARIABLES") {
          return {
            status: 400,
            body: {
              error: result.message,
              missingVariables: result.missingVariables,
              requiredVariables: result.requiredVariables,
            },
          };
        }
        if (
          result.code === "MISSING_BODY" ||
          result.code === "TEMPLATE_PARSE_ERROR"
        ) {
          return { status: 400, body: { error: result.message } };
        }
        return { status: 404, body: { error: result.message } };
      }

      return {
        status: 201,
        body: {
          id: result.id,
          resendId: result.resendId,
          status: result.status,
          attachmentIds: result.attachmentIds,
          to: result.to,
          cc: result.cc,
          repliedTo: result.repliedTo,
          ...(result.paused ? { paused: true } : {}),
        },
        sentEmailId: result.id,
      };
    },
  );
});
