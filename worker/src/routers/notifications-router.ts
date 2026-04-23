import { Hono } from "hono";
import type { Variables } from "../variables";

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
