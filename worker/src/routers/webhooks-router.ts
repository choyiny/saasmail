import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { json200Response } from "../lib/helpers";
import { getWebhookConfig, setWebhookConfig } from "../lib/webhook-config";
import { buildWebhookPayload, sendWebhook } from "../lib/webhook-delivery";
import type { Variables } from "../variables";

export const webhooksRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const ConfigResponse = z.object({ url: z.string(), hasSecret: z.boolean() });
const ErrorSchema = z.object({ error: z.string() });

// GET /api/webhook — current config (secret value never returned)
const getRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Webhook"],
  description:
    "Get the global outbound webhook config: destination URL and whether a signing secret is set. Admin only.",
  responses: { ...json200Response(ConfigResponse, "Webhook config") },
});

webhooksRouter.openapi(getRoute, async (c) => {
  const db = c.get("db");
  const cfg = await getWebhookConfig(db);
  return c.json({ url: cfg?.url ?? "", hasSecret: !!cfg?.secret }, 200);
});

// PUT /api/webhook — set/replace/clear config
const PutBody = z.object({
  url: z.string(),
  secret: z.string().nullable().optional(),
});
const putRoute = createRoute({
  method: "put",
  path: "/",
  tags: ["Webhook"],
  description:
    "Set the global outbound webhook. Blank `url` disables it. Omit `secret` to keep the existing one; pass null or '' to clear it. Admin only.",
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
    return c.json({ url: "", hasSecret: false }, 200);
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

  await setWebhookConfig(db, { url, secret }, user?.id ?? null);
  return c.json({ url, hasSecret: !!secret }, 200);
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
    "Send a synthetic message.received event to the configured URL (signed if a secret is set). Admin only.",
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
