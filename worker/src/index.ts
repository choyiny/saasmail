import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { injectDb } from "./db/middleware";
import { createAuth } from "./auth";
import { handleEmail } from "./email-handler";
import { sendersRouter } from "./routers/senders-router";
import { emailsRouter } from "./routers/emails-router";
import { sendRouter } from "./routers/send-router";
import { attachmentsRouter } from "./routers/attachments-router";
import { statsRouter } from "./routers/stats-router";
import { setupRouter } from "./routers/setup-router";
import { apiKeysRouter } from "./routers/api-keys-router";
import { extractBearerToken, resolveUserFromApiKey } from "./lib/api-keys";
import type { Variables } from "./variables";

const app = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

// Middleware
app.use("*", injectDb);
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: ["http://localhost:8080", "https://mail.givefeedback.dev"],
    credentials: true,
  })
);

// BetterAuth handler
app.all("/api/auth/*", (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

// Session resolution for all API routes (supports both session cookies and API keys)
app.use("/api/*", async (c, next) => {
  if (
    c.req.path.startsWith("/api/auth") ||
    c.req.path.startsWith("/api/setup") ||
    c.req.path === "/api/health"
  ) {
    return next();
  }

  // Try API key via Authorization: Bearer cmail_...
  const token = extractBearerToken(c.req.header("Authorization") ?? null);
  if (token) {
    const db = c.get("db");
    const user = await resolveUserFromApiKey(db, token);
    if (!user) {
      return c.json({ error: "Invalid or revoked API key" }, 401);
    }
    c.set("user", user);
    c.set("authMethod", "api_key");
    return next();
  }

  // Fall back to session cookie auth
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("user", session.user);
  c.set("authMethod", "session");
  return next();
});

// API Routes
app.route("/api/senders", sendersRouter);
app.route("/api/emails", emailsRouter);
app.route("/api/send", sendRouter);
app.route("/api/attachments", attachmentsRouter);
app.route("/api/stats", statsRouter);
app.route("/api/setup", setupRouter);
app.route("/api/api-keys", apiKeysRouter);

// Health check (no auth)
app.get("/api/health", (c) => c.json({ status: "ok" }));

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
};
