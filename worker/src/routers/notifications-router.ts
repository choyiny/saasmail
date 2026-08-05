import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Variables } from "../variables";
import { pushSubscriptions } from "../db/push-subscriptions.schema";
import { expoPushSubscriptions } from "../db/expo-push-subscriptions.schema";
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

Requires \`Upgrade: websocket\` and \`Connection: Upgrade\` headers. Session cookie, API key, or OAuth bearer authentication.

Session-cookie callers must also send an \`Origin\` header matching one of the instance's \`TRUSTED_ORIGINS\`; this defends against Cross-Site WebSocket Hijacking, which relies on the browser attaching the cookie to a cross-origin handshake automatically. Bearer callers are exempt: their credential is not ambient, so it cannot be attached to a socket opened by an attacker's page, and a native client has no browser origin to send.`,
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

  // The Origin allow-list defends against Cross-Site WebSocket Hijacking, which
  // exists because a browser attaches the session cookie to a cross-origin
  // handshake automatically: an attacker's page opens the socket and the
  // victim's credential rides along. `Origin` is the right defence there
  // precisely because a page cannot forge it.
  //
  // A bearer credential is not ambient. It has to be set explicitly on the
  // request, and no attacker page can cause a victim's token to be attached to
  // a socket it opened, so the attack the check prevents cannot occur. The
  // check is still fatal to those callers — a native client has no browser
  // origin to send at all.
  //
  // So the check follows the credential it protects rather than the route.
  //
  // Scoped to OAuth deliberately, not to every bearer credential. The same
  // argument applies to `sk_` API keys — they are not ambient either — but the
  // suite asserts a 403 for them today, and changing a tested contract is not
  // needed to unblock a native client. Left alone rather than quietly widened.
  if (c.get("authMethod") !== "oauth") {
    const origin = c.req.header("Origin");
    const trustedOrigins = c.env.TRUSTED_ORIGINS
      ? c.env.TRUSTED_ORIGINS.split(",").map((o) => o.trim())
      : [];
    if (!origin || !trustedOrigins.includes(origin)) {
      return c.json({ error: "Forbidden" }, 403);
    }
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

// --- Native (Expo) push registration -----------------------------------------

/**
 * Kept separate from the Web Push routes because the two carry different
 * things: a browser subscription is an endpoint URL plus the keypair the
 * `PushManager` generated, a native one is an opaque token. Reusing
 * `PushSubscribeSchema` would mean making `p256dh` and `auth` optional and
 * losing the guarantee that a browser subscription actually has them.
 */
export const ExpoSubscribeSchema = z.object({
  token: z.string().min(1).max(256).openapi({
    description:
      "Expo push token from `getExpoPushTokenAsync()`, e.g. `ExponentPushToken[xxxxxx]`. Stored server-side and never returned by any route.",
  }),
  installationId: z.string().min(1).max(128).openapi({
    description:
      "Stable per-install identifier generated by the client. Identity of the device: re-registering with a rotated token updates this row rather than adding another, so a reinstall does not leave a dead token behind that still looks live.",
  }),
  platform: z.enum(["ios", "android"]).optional(),
  deviceName: z.string().max(128).optional(),
});

const expoSubscribeRoute = createRoute({
  method: "post",
  path: "/expo/subscribe",
  tags: ["Notifications"],
  security: bearerSecurity,
  description:
    "Register or update this installation's Expo push token. Idempotent per (user, installationId).",
  request: {
    body: {
      content: { "application/json": { schema: ExpoSubscribeSchema } },
    },
  },
  responses: {
    ...json200Response(
      z.object({ ok: z.literal(true) }),
      "Registration stored",
    ),
  },
});

notificationsRouter.openapi(expoSubscribeRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const body = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);

  const existing = await db
    .select()
    .from(expoPushSubscriptions)
    .where(
      and(
        eq(expoPushSubscriptions.userId, user.id),
        eq(expoPushSubscriptions.installationId, body.installationId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    const row = existing[0];
    // Bump the version only when the token actually changed, so the number
    // tracks rotations rather than app launches.
    const rotated = row.token !== body.token;
    await db
      .update(expoPushSubscriptions)
      .set({
        token: body.token,
        tokenVersion: rotated ? row.tokenVersion + 1 : row.tokenVersion,
        platform: body.platform ?? row.platform,
        deviceName: body.deviceName ?? row.deviceName,
        updatedAt: now,
      })
      .where(eq(expoPushSubscriptions.id, row.id));
    return c.json({ ok: true as const }, 200);
  }

  await db.insert(expoPushSubscriptions).values({
    id: nanoid(),
    userId: user.id,
    installationId: body.installationId,
    token: body.token,
    tokenVersion: 1,
    platform: body.platform ?? null,
    deviceName: body.deviceName ?? null,
    createdAt: now,
    updatedAt: now,
  });

  return c.json({ ok: true as const }, 200);
});

const expoUnsubscribeRoute = createRoute({
  method: "delete",
  path: "/expo/subscribe",
  tags: ["Notifications"],
  security: bearerSecurity,
  description:
    "Remove this installation's registration. Idempotent — succeeds whether or not a row existed, so a client signing out does not have to care.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ installationId: z.string().min(1).max(128) }),
        },
      },
    },
  },
  responses: {
    ...json200Response(z.object({ ok: z.literal(true) }), "Removed"),
  },
});

notificationsRouter.openapi(expoUnsubscribeRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const { installationId } = c.req.valid("json");

  await db
    .delete(expoPushSubscriptions)
    .where(
      and(
        eq(expoPushSubscriptions.userId, user.id),
        eq(expoPushSubscriptions.installationId, installationId),
      ),
    );

  return c.json({ ok: true as const }, 200);
});
