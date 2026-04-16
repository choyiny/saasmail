import type { MiddlewareHandler } from "hono";
import type { Variables } from "../variables";
import { resolveAllowedInboxes } from "../lib/inbox-permissions";

export const injectAllowedInboxes: MiddlewareHandler<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}> = async (c, next) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const db = c.get("db");
  const allowed = await resolveAllowedInboxes(db, user);
  c.set("allowedInboxes", allowed);
  return next();
};
