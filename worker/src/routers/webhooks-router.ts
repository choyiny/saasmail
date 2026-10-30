import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { json200Response } from "../lib/helpers";
import { desc } from "drizzle-orm";
import { webhookDeliveries } from "../db/webhook-deliveries.schema";
import {
  WEBHOOK_EVENTS,
  enableWebhook,
  getWebhookConfig,
  setWebhookConfig,
  type WebhookConfig,
  type WebhookEvent,
} from "../lib/webhook-config";
import {
  buildWebhookPayload,
  sendWebhook,
  type OutboundWebhookPayload,
} from "../lib/webhook-delivery";
import type { Variables } from "../variables";

export const webhooksRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const EventSchema = z.enum(WEBHOOK_EVENTS);
const ConfigResponse = z.object({
  url: z.string(),
  hasSecret: z.boolean(),
  events: z.array(EventSchema),
  /** Set while the outbound events are paused after repeated failures. */
  disabledAt: z.number().nullable(),
  disabledReason: z.string().nullable(),
});
const ErrorSchema = z.object({ error: z.string() });

function configResponse(cfg: WebhookConfig | null) {
  return {
    url: cfg?.url ?? "",
    hasSecret: !!cfg?.secret,
    events: cfg?.events ?? ["message.received" as const],
    disabledAt: cfg?.disabledAt ?? null,
    disabledReason: cfg?.disabledReason ?? null,
  };
}

// GET /api/webhook — current config (secret value never returned)
const getRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Webhook"],
  description:
    "Get the global outbound webhook config: destination URL, whether a signing secret is set, the events it sends, and whether its delivery events are paused. Admin only.",
  responses: { ...json200Response(ConfigResponse, "Webhook config") },
});

webhooksRouter.openapi(getRoute, async (c) => {
  const db = c.get("db");
  const cfg = await getWebhookConfig(db);
  return c.json(configResponse(cfg), 200);
});

// PUT /api/webhook — set/replace/clear config
const PutBody = z.object({
  url: z.string(),
  secret: z.string().nullable().optional(),
  events: z.array(EventSchema).optional(),
});
const putRoute = createRoute({
  method: "put",
  path: "/",
  tags: ["Webhook"],
  description:
    "Set the global outbound webhook. Blank `url` disables it. Omit `secret` to keep the existing one; pass null or '' to clear it. Omit `events` to keep the current list; an empty list sends nothing. Saving lifts a pause. Admin only.",
  request: {
    body: { content: { "application/json": { schema: PutBody } } },
  },
  responses: {
    ...json200Response(ConfigResponse, "Updated"),
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

webhooksRouter.openapi(putRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const body = c.req.valid("json");
  const url = body.url.trim();

  if (!url) {
    await setWebhookConfig(db, null, user?.id ?? null);
    return c.json(configResponse(null), 200);
  }

  // secret omitted → keep existing; null/'' → clear; else → set
  let secret: string | null;
  if (body.secret === undefined) {
    const existing = await getWebhookConfig(db);
    secret = existing?.secret ?? null;
  } else if (body.secret === null || body.secret === "") {
    secret = null;
  } else {
    secret = body.secret;
  }

  await setWebhookConfig(
    db,
    { url, secret, ...(body.events ? { events: body.events } : {}) },
    user?.id ?? null,
  );
  return c.json(configResponse(await getWebhookConfig(db)), 200);
});

// POST /api/webhook/enable — lift a pause after repeated failures
const enableRoute = createRoute({
  method: "post",
  path: "/enable",
  tags: ["Webhook"],
  description:
    "Re-enable the outbound delivery events after they were paused for repeated failures. Deliveries recorded before are not sent. Admin only.",
  responses: {
    500: { description: "Internal server error" },
    ...json200Response(ConfigResponse, "Re-enabled"),
    400: {
      description: "No URL configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

webhooksRouter.openapi(enableRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  if (
    !(await getWebhookConfig(db)) ||
    !(await enableWebhook(db, user?.id ?? null))
  ) {
    return c.json({ error: "No webhook URL configured." }, 400);
  }
  return c.json(configResponse(await getWebhookConfig(db)), 200);
});

// GET /api/webhook/deliveries — the latest outbound deliveries
const DeliverySchema = z.object({
  id: z.string(),
  event: z.string(),
  /** The sent message's id; no address and no subject. */
  messageId: z.string(),
  status: z.enum(["pending", "delivered", "failed", "cancelled"]),
  attempts: z.number(),
  lastStatus: z.number().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number(),
  finishedAt: z.number().nullable(),
});
const deliveriesRoute = createRoute({
  method: "get",
  path: "/deliveries",
  tags: ["Webhook"],
  description:
    "The latest outbound webhook deliveries (message.sent, message.bounced, ...), newest first, kept 7 days. message.received is not logged. Admin only.",
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    500: { description: "Internal server error" },
    ...json200Response(
      z.object({ deliveries: z.array(DeliverySchema) }),
      "Deliveries",
    ),
  },
});

webhooksRouter.openapi(deliveriesRoute, async (c) => {
  const db = c.get("db");
  const { limit } = c.req.valid("query");
  const rows = await db
    .select({
      id: webhookDeliveries.id,
      event: webhookDeliveries.event,
      messageId: webhookDeliveries.messageId,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      lastStatus: webhookDeliveries.lastStatus,
      lastError: webhookDeliveries.lastError,
      createdAt: webhookDeliveries.createdAt,
      finishedAt: webhookDeliveries.finishedAt,
    })
    .from(webhookDeliveries)
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit ?? 20);
  return c.json(
    {
      deliveries: rows.map((row) => ({
        ...row,
        status: row.status as z.infer<typeof DeliverySchema>["status"],
      })),
    },
    200,
  );
});

// POST /api/webhook/test — synthetic delivery to confirm wiring
const TestResponse = z.object({
  ok: z.boolean(),
  status: z.number().optional(),
  error: z.string().optional(),
});
const testRoute = createRoute({
  method: "post",
  path: "/test",
  tags: ["Webhook"],
  description:
    "Send a synthetic event to the configured URL (signed if a secret is set): `event`, or message.received when omitted. Sent once, directly: no retry and no log row. Admin only.",
  request: {
    body: {
      required: false,
      content: {
        "application/json": {
          schema: z.object({ event: EventSchema.optional() }),
        },
      },
    },
  },
  responses: {
    ...json200Response(TestResponse, "Delivery result"),
    400: {
      description: "No URL configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

webhooksRouter.openapi(testRoute, async (c) => {
  const db = c.get("db");
  const cfg = await getWebhookConfig(db);
  if (!cfg) return c.json({ error: "No webhook URL configured." }, 400);
  const event = c.req.valid("json")?.event ?? "message.received";
  if (event !== "message.received") {
    const result = await sendWebhook(
      cfg,
      testOutboundPayload(event, c.env.BASE_URL),
    );
    return c.json(result, 200);
  }
  const payload = buildWebhookPayload({
    emailId: "test_00000000",
    receivedAt: Math.floor(Date.now() / 1000),
    inbox: "you@example.com",
    fromAddress: "sender@example.com",
    fromName: "Test Sender",
    subject: "SaaSMail webhook test",
    bodyText: "This is a test webhook delivery from SaaSMail.",
    conversationId: "test-conversation",
    attachments: [],
    auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
    baseUrl: c.env.BASE_URL,
  });
  const result = await sendWebhook(cfg, payload);
  return c.json(result, 200);
});

/** A synthetic outbound event for the test button. */
function testOutboundPayload(
  event: Exclude<WebhookEvent, "message.received">,
  baseUrl: string,
): OutboundWebhookPayload {
  const id = "test_00000000";
  return {
    event,
    deliveryId: "wd_test_00000000",
    occurredAt: Math.floor(Date.now() / 1000),
    message: {
      id,
      messageId: "<test_00000000@example.com>",
      from: "you@example.com",
      recipients: ["customer@example.com"],
      subject: "SaaSMail webhook test",
      campaignId: null,
      sequenceId: null,
      sequenceEnrollmentId: null,
      conversationId: "test-conversation",
      url: `${baseUrl.replace(/\/$/, "")}/m/${id}`,
    },
    ...(event === "message.sent"
      ? {}
      : {
          delivery: {
            recipient: "customer@example.com",
            status:
              event === "message.bounced"
                ? ("bounced" as const)
                : event === "message.complained"
                  ? ("complained" as const)
                  : ("failed" as const),
            bounceType: event === "message.bounced" ? ("hard" as const) : null,
            smtpStatus: event === "message.bounced" ? "550" : null,
            enhancedStatus: event === "message.bounced" ? "5.1.1" : null,
            reason: "This is a test webhook delivery from SaaSMail.",
            provider: "cloudflare",
          },
        }),
  };
}
