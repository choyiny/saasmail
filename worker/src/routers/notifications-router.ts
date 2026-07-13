import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, and } from "drizzle-orm";
import type { Variables } from "../variables";
import { pushSubscriptions } from "../db/push-subscriptions.schema";
import { bearerSecurity } from "../lib/openapi-auth";
import { json200Response } from "../lib/helpers";

const ErrorSchema = z.object({
  error: z.string(),
});

const invalidBodyHook = (
  result: { success: boolean },
  c: { json: (body: { error: string }, status: 400) => Response },
) => {
  if (!result.success) {
    return c.json({ error: "invalid body" }, 400);
  }
};

export const notificationsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const NotificationsConfigSchema = z.object({
  vapidPublicKey: z.string().openapi({
    description:
      "VAPID public key for Web Push subscription (empty when unset).",
  }),
  pushEnabled: z.boolean().openapi({
    description:
      "True when both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are configured.",
  }),
});

const configRoute = createRoute({
  method: "get",
  path: "/config",
  tags: ["Notifications"],
  security: bearerSecurity,
  description:
    "Push notification configuration for the authenticated user. Used by the SPA to register a Web Push subscription.",
  responses: {
    ...json200Response(NotificationsConfigSchema, "Push configuration"),
  },
});

notificationsRouter.openapi(configRoute, (c) => {
  const publicKey = c.env.VAPID_PUBLIC_KEY ?? "";
  const privateKey = c.env.VAPID_PRIVATE_KEY ?? "";
  return c.json({
    vapidPublicKey: publicKey,
    pushEnabled: Boolean(publicKey && privateKey),
  });
});

const streamRoute = createRoute({
  method: "get",
  path: "/stream",
  tags: ["Notifications"],
  security: bearerSecurity,
  description: `Real-time in-app notification stream via WebSocket upgrade to the user's NotificationsHub Durable Object.

Requires \`Upgrade: websocket\` and \`Connection: Upgrade\` headers, plus an \`Origin\` header matching one of the instance's \`TRUSTED_ORIGINS\`. Session cookie or API key authentication.`,
  responses: {
    101: {
      description: "Switching Protocols — WebSocket connection established.",
    },
    401: {
      description: "Missing or invalid authentication",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Missing or untrusted Origin header",
      content: { "application/json": { schema: ErrorSchema } },
    },
    426: {
      description: "Request is not a WebSocket upgrade",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

notificationsRouter.openapi(streamRoute, async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.json({ error: "Expected WebSocket upgrade" }, 426);
  }

  const origin = c.req.header("Origin");
  const trustedOrigins = c.env.TRUSTED_ORIGINS
    ? c.env.TRUSTED_ORIGINS.split(",").map((o) => o.trim())
    : [];
  if (!origin || !trustedOrigins.includes(origin)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const id = c.env.NOTIFICATIONS_HUB.idFromName(user.id);
  const stub = c.env.NOTIFICATIONS_HUB.get(id);

  return stub.fetch(
    new Request("http://do/connect", {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
      },
    }),
  );
});

export const PushSubscribeSchema = z.object({
  endpoint: z.string().url().openapi({
    description: "Push service endpoint URL returned by the browser.",
    example: "https://fcm.googleapis.com/fcm/send/…",
  }),
  keys: z.object({
    p256dh: z.string().min(1).openapi({
      description: "P-256 ECDH public key from the browser PushSubscription.",
    }),
    auth: z.string().min(1).openapi({
      description: "Authentication secret from the browser PushSubscription.",
    }),
  }),
  userAgent: z.string().max(512).optional().openapi({
    description: "Optional browser user-agent string for debugging.",
  }),
});

const subscribeRoute = createRoute({
  method: "post",
  path: "/subscribe",
  tags: ["Notifications"],
  security: bearerSecurity,
  description:
    "Register or update a Web Push subscription for the authenticated user. Upserts by endpoint.",
  request: {
    body: {
      content: {
        "application/json": { schema: PushSubscribeSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Subscription registered",
    },
    400: {
      description: "Invalid JSON body or schema validation failure",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    503: {
      description: "VAPID keys are not configured on this instance",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("push_not_configured") }),
        },
      },
    },
  },
});

notificationsRouter.openapi(
  subscribeRoute,
  async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const privateKey = c.env.VAPID_PRIVATE_KEY ?? "";
    if (!privateKey) {
      return c.json({ error: "push_not_configured" }, 503);
    }

    const body = c.req.valid("json");
    const db = c.get("db");
    const now = Math.floor(Date.now() / 1000);

    await db
      .insert(pushSubscriptions)
      .values({
        id: crypto.randomUUID(),
        userId: user.id,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        userAgent: body.userAgent ?? null,
        createdAt: now,
        lastUsedAt: null,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          userId: user.id,
          p256dh: body.keys.p256dh,
          auth: body.keys.auth,
          userAgent: body.userAgent ?? null,
        },
      });

    return c.body(null, 201);
  },
  invalidBodyHook,
);

const UnsubscribeBodySchema = z.object({
  endpoint: z.string().url().openapi({
    description: "Push subscription endpoint URL to remove.",
  }),
});

const unsubscribeRoute = createRoute({
  method: "delete",
  path: "/subscribe",
  tags: ["Notifications"],
  security: bearerSecurity,
  description:
    "Remove a Web Push subscription for the authenticated user by endpoint URL.",
  request: {
    body: {
      content: {
        "application/json": { schema: UnsubscribeBodySchema },
      },
    },
  },
  responses: {
    204: {
      description: "Subscription removed (or was not registered)",
    },
    400: {
      description: "Invalid JSON body or missing endpoint",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

notificationsRouter.openapi(
  unsubscribeRoute,
  async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const body = c.req.valid("json");
    if (!body.endpoint) return c.json({ error: "endpoint required" }, 400);

    const db = c.get("db");
    await db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.userId, user.id),
          eq(pushSubscriptions.endpoint, body.endpoint),
        ),
      );
    return c.body(null, 204);
  },
  invalidBodyHook,
);

const PushSubscriptionSummarySchema = z.object({
  id: z.string(),
  userAgent: z.string().nullable(),
  createdAt: z.number().int(),
  lastUsedAt: z.number().int().nullable(),
});

const listSubscriptionsRoute = createRoute({
  method: "get",
  path: "/subscriptions",
  tags: ["Notifications"],
  security: bearerSecurity,
  description:
    "List Web Push subscriptions registered for the authenticated user.",
  responses: {
    ...json200Response(
      z.object({
        subscriptions: z.array(PushSubscriptionSummarySchema),
      }),
      "Push subscriptions",
    ),
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

notificationsRouter.openapi(listSubscriptionsRoute, async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const db = c.get("db");
  const rows = await db
    .select({
      id: pushSubscriptions.id,
      userAgent: pushSubscriptions.userAgent,
      createdAt: pushSubscriptions.createdAt,
      lastUsedAt: pushSubscriptions.lastUsedAt,
    })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, user.id));
  return c.json({ subscriptions: rows });
});

const deleteSubscriptionRoute = createRoute({
  method: "delete",
  path: "/subscriptions/{id}",
  tags: ["Notifications"],
  security: bearerSecurity,
  description:
    "Delete a single push subscription by id. Scoped to the authenticated user.",
  request: {
    params: z.object({
      id: z.string().openapi({ description: "Push subscription id." }),
    }),
  },
  responses: {
    204: {
      description: "Subscription deleted",
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Subscription not found for this user",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

notificationsRouter.openapi(deleteSubscriptionRoute, async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { id } = c.req.valid("param");

  const db = c.get("db");
  const result = await db
    .delete(pushSubscriptions)
    .where(
      and(eq(pushSubscriptions.userId, user.id), eq(pushSubscriptions.id, id)),
    )
    .returning({ id: pushSubscriptions.id });
  if (result.length === 0) return c.json({ error: "not found" }, 404);
  return c.body(null, 204);
});
