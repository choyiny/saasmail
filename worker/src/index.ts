import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { injectDb } from "./db/middleware";
import { createAuth } from "./auth";
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import type { Context } from "hono";
import { apiKeys } from "./db/api-keys.schema";
import { users } from "./db/auth.schema";
import { eq } from "drizzle-orm";
import { hashKey } from "./lib/crypto";
import { handleEmail } from "./email-handler";
import { sendersRouter } from "./routers/senders-router";
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
import { mcpRouter } from "./routers/mcp-router";
import { oauthAppsRouter } from "./routers/oauth-apps-router";
import { handleScheduled, handleQueueBatch } from "./lib/sequence-processor";
import type { SequenceEmailMessage } from "./lib/sequence-processor";
import type { Variables } from "./variables";
import type { MiddlewareHandler } from "hono";

const app = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

// Middleware
app.use("*", injectDb);
app.use("*", logger());
// `exposeHeaders` is required so browser-based MCP clients (e.g.
// Claude.ai connectors) can read the `WWW-Authenticate` challenge on 401
// responses to discover the OAuth protected-resource metadata URL, and
// the optional `Mcp-Session-Id` header. Without these, a cross-origin
// MCP client sees an opaque 401 and reports "Couldn't reach the MCP server".
app.use(
  "*",
  cors({
    origin: "*",
    exposeHeaders: ["WWW-Authenticate", "Mcp-Session-Id"],
  }),
);

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
    c.req.path === "/api/health"
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
app.route("/api/senders", sendersRouter);
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
app.route("/api/oauth-apps", oauthAppsRouter);

// Admin routes (require admin role)
app.use("/api/admin/*", requireAdmin);
app.route("/api/admin", adminRouter);

// Health check (no auth)
app.get("/api/health", (c) => c.json({ status: "ok" }));

// Swagger UI
app.get("/swagger-ui", swaggerUI({ url: "/doc" }));
app.doc("/doc", {
  openapi: "3.0.0",
  info: { title: "cmail API", version: "1.0.0" },
});

// MCP endpoints (JSON-RPC 2.0 over POST, OAuth bearer token auth)
app.route("/mcp", mcpRouter);

// Expose OAuth discovery metadata at the well-known roots so MCP clients
// (Claude.ai, Claude Code, GitHub Copilot) can discover the authorization
// server and protected-resource endpoints.
//
// /.well-known/oauth-authorization-server: uses oauthProviderAuthServerMetadata
// which calls auth.api.getOAuthServerConfig internally (the endpoint is
// SERVER_ONLY so cannot be reached through auth.handler). We create the auth
// instance with the request's host so the issuer and endpoint URLs match the
// actual domain the client connected to.
//
// /.well-known/oauth-protected-resource: oauthProvider does not expose this
// RFC 9728 endpoint, so we build the response ourselves. The resource and
// authorization_servers fields are derived from the request origin so they
// track whichever domain the client connects to.
async function forwardToOAuthDiscovery(
  c: Context<{
    Bindings: CloudflareBindings;
    Variables: Variables;
  }>,
): Promise<Response> {
  const url = new URL(c.req.raw.url);
  const auth = createAuth(c.env, undefined, url.host);
  return oauthProviderAuthServerMetadata(auth)(c.req.raw);
}

async function serveOAuthProtectedResource(
  c: Context<{
    Bindings: CloudflareBindings;
    Variables: Variables;
  }>,
): Promise<Response> {
  const origin = new URL(c.req.raw.url).origin;
  return Response.json({
    resource: origin,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "profile", "email", "offline_access"],
  });
}

app.get("/.well-known/oauth-authorization-server", forwardToOAuthDiscovery);
// RFC 8414: issuer includes basePath, so clients may request this path
app.get(
  "/.well-known/oauth-authorization-server/api/auth",
  forwardToOAuthDiscovery,
);
app.get("/.well-known/oauth-protected-resource", serveOAuthProtectedResource);

// Forward remaining well-known paths (e.g. openid-configuration) to betterauth
app.all("/.well-known/*", (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
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
