import { Hono } from "hono";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import type { Variables } from "../variables";
import { pushSubscriptions } from "../db/push-subscriptions.schema";

export const notificationsRouter = new Hono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

notificationsRouter.get("/stream", async (c) => {
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

notificationsRouter.get("/config", (c) => {
  const publicKey = c.env.VAPID_PUBLIC_KEY ?? "";
  const privateKey = c.env.VAPID_PRIVATE_KEY ?? "";
  return c.json({
    vapidPublicKey: publicKey,
    pushEnabled: Boolean(publicKey && privateKey),
  });
});

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  userAgent: z.string().max(512).optional(),
});

notificationsRouter.post("/subscribe", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const privateKey = c.env.VAPID_PRIVATE_KEY ?? "";
  if (!privateKey) {
    return c.json({ error: "push_not_configured" }, 503);
  }

  let body: z.infer<typeof subscribeSchema>;
  try {
    body = subscribeSchema.parse(await c.req.json());
  } catch {
    return c.json({ error: "invalid body" }, 400);
  }

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
});

notificationsRouter.delete("/subscribe", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  let body: { endpoint?: string };
  try {
    body = (await c.req.json()) as { endpoint?: string };
  } catch {
    return c.json({ error: "invalid body" }, 400);
  }
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
});

notificationsRouter.get("/subscriptions", async (c) => {
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

notificationsRouter.delete("/subscriptions/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");

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
