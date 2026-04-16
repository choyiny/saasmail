import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { injectDb } from "./db/middleware";
import { createAuth } from "./auth";
import { apiKeys } from "./db/api-keys.schema";
import { users } from "./db/auth.schema";
import { eq } from "drizzle-orm";
import { hashKey } from "./lib/crypto";
import { handleEmail } from "./email-handler";
import { peopleRouter } from "./routers/people-router";
import { emailsRouter } from "./routers/emails-router";
import { sendRouter } from "./routers/send-router";
import { attachmentsRouter } from "./routers/attachments-router";
import { statsRouter } from "./routers/stats-router";
import { setupRouter } from "./routers/setup-router";
import { emailTemplatesRouter } from "./routers/email-templates-router";
import { adminRouter } from "./routers/admin-router";
import { invitesRouter } from "./routers/invites-router";
import { userRouter } from "./routers/user-router";
import { apiKeysRouter } from "./routers/api-keys-router";
import { sequencesRouter } from "./routers/sequences-router";
import { senderIdentitiesRouter } from "./routers/sender-identities-router";
import { handleScheduled, handleQueueBatch } from "./lib/sequence-processor";
import type { SequenceEmailMessage } from "./lib/sequence-processor";
import type { Variables } from "./variables";
import type { MiddlewareHandler } from "hono";
import { injectAllowedInboxes } from "./middleware/inject-allowed-inboxes";

const app = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

// Middleware
app.use("*", injectDb);
app.use("*", logger());
app.use("*", cors({ origin: "*" }));

// BetterAuth handler
app.all("/api/auth/*", (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

// Session resolution for all API routes
app.use("/api/*", async (c, next) => {
  if (
    c.req.path.startsWith("/api/auth") ||
    c.req.path.startsWith("/api/setup") ||
    c.req.path.startsWith("/api/invites") ||
    c.req.path === "/api/health" ||
    c.req.path === "/api/config"
  ) {
    return next();
  }

  // Try session cookie first
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  if (session) {
    c.set("user", session.user);
    return next();
  }

  // Try Bearer token (API key)
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer sk_")) {
    const token = authHeader.slice(7); // Remove "Bearer "
    const tokenHash = await hashKey(token);

    const db = c.get("db");
    const rows = await db
      .select({ userId: apiKeys.userId })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, tokenHash))
      .limit(1);

    if (rows.length > 0) {
      const userRows = await db
        .select()
        .from(users)
        .where(eq(users.id, rows[0].userId))
        .limit(1);

      if (userRows.length > 0) {
        c.set("user", userRows[0]);
        return next();
      }
    }
  }

  return c.json({ error: "Unauthorized" }, 401);
});

// Inject allowed inboxes for all authenticated API routes
app.use("/api/*", async (c, next) => {
  if (
    c.req.path.startsWith("/api/auth") ||
    c.req.path.startsWith("/api/setup") ||
    c.req.path.startsWith("/api/invites") ||
    c.req.path === "/api/health" ||
    c.req.path === "/api/config"
  ) {
    return next();
  }
  return injectAllowedInboxes(c, next);
});

// Admin guard middleware
const requireAdmin: MiddlewareHandler<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}> = async (c, next) => {
  const user = c.get("user");
  if (!user || user.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }
  return next();
};

// API Routes
app.route("/api/people", peopleRouter);
app.route("/api/emails", emailsRouter);
app.route("/api/send", sendRouter);
app.route("/api/attachments", attachmentsRouter);
app.route("/api/stats", statsRouter);
app.route("/api/setup", setupRouter);
app.route("/api/email-templates", emailTemplatesRouter);
app.route("/api/user", userRouter);
app.route("/api/api-keys", apiKeysRouter);
app.route("/api/invites", invitesRouter);
app.route("/api/sequences", sequencesRouter);
app.route("/api/sender-identities", senderIdentitiesRouter);

// Admin routes (require admin role)
app.use("/api/admin/*", requireAdmin);
app.route("/api/admin", adminRouter);

// Health check (no auth)
app.get("/api/health", (c) => c.json({ status: "ok" }));

// Public branding config (no auth) — consumed by the SPA for whitelabeling
app.get("/api/config", (c) =>
  c.json({
    appName: c.env.APP_NAME || "cmail",
    logoLetter: c.env.APP_LOGO_LETTER || "c",
  }),
);

// Swagger UI
app.get("/swagger-ui", swaggerUI({ url: "/doc" }));
app.doc("/doc", {
  openapi: "3.0.0",
  info: { title: "cmail API", version: "1.0.0" },
});

// SPA fallback
app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
  email: handleEmail,
  async scheduled(
    event: ScheduledEvent,
    env: CloudflareBindings,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(handleScheduled(env));
  },
  async queue(
    batch: MessageBatch<SequenceEmailMessage>,
    env: CloudflareBindings,
  ) {
    await handleQueueBatch(batch, env);
  },
};
