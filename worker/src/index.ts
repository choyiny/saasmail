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
import { conversationsRouter } from "./routers/conversations-router";
import {
  sendRouter,
  CcEntrySchema,
  ReplyEmailSchema,
  SendEmailSchema,
} from "./routers/send-router";
import { attachmentsRouter } from "./routers/attachments-router";
import { statsRouter } from "./routers/stats-router";
import { setupRouter } from "./routers/setup-router";
import { emailTemplatesRouter } from "./routers/email-templates-router";
import { adminRouter } from "./routers/admin-router";
import { adminInboxesRouter } from "./routers/admin-inboxes-router";
import { oauthAppsRouter } from "./routers/oauth-apps-router";
import { invitesRouter } from "./routers/invites-router";
import { userRouter } from "./routers/user-router";
import { apiKeysRouter } from "./routers/api-keys-router";
import { sequencesRouter } from "./routers/sequences-router";
import { handleScheduled, handleQueueBatch } from "./lib/sequence-processor";
import type { SequenceEmailMessage } from "./lib/sequence-processor";
import { processOutbox } from "./lib/outbox";
import { notificationsRouter } from "./routers/notifications-router";
import { blocklistRouter } from "./routers/blocklist-router";
import { suppressionsRouter } from "./routers/suppressions-router";
import { webhooksRouter } from "./routers/webhooks-router";
import { unsubscribeRouter } from "./routers/unsubscribe-router";
import { outboxRouter } from "./routers/outbox-router";
import { bootstrapRouter } from "./routers/bootstrap-router";
export { NotificationsHub } from "./do/notifications";
import type { Variables } from "./variables";
import type { MiddlewareHandler } from "hono";
import { injectAllowedInboxes } from "./middleware/inject-allowed-inboxes";
import {
  bearerAccessToken,
  resolveOAuthPrincipal,
} from "./lib/oauth-principal";
import { classifyRoute, guardBearerBody } from "./lib/oauth-scope-policy";
import { requirePasskey } from "./middleware/require-passkey";
import { passkeys } from "./db/auth.schema";
import { isDevEnvironment } from "./lib/is-dev";
import { registerMcpRoutes } from "./mcp/http";
import {
  BEARER_AUTH_SCHEME,
  bearerAuthSecurityScheme,
  openapiInfoDescription,
} from "./lib/openapi-auth";

const app = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

app.openAPIRegistry.register("CcEntry", CcEntrySchema);
app.openAPIRegistry.register("SendEmailSchema", SendEmailSchema);
app.openAPIRegistry.register("ReplyEmailSchema", ReplyEmailSchema);

app.openAPIRegistry.registerComponent(
  "securitySchemes",
  BEARER_AUTH_SCHEME,
  bearerAuthSecurityScheme,
);

// Middleware
app.use("*", injectDb);
app.use("*", logger());
// `exposeHeaders` is required so browser-based MCP clients (e.g. Claude.ai
// connectors) can read the `WWW-Authenticate` challenge on a 401 to discover
// the OAuth protected-resource metadata URL, plus the `Mcp-Session-Id` header
// used by the streamable-HTTP transport. Without these a cross-origin MCP
// client sees an opaque 401 and reports "Couldn't reach the MCP server".
// `allowHeaders` is explicit because Hono's default is empty: a cross-origin
// client that preflights a request carrying `Authorization` gets the header
// stripped from the allow-list and the browser blocks the real request. That
// was survivable while the only bearer callers were server-side, but a browser
// or native client presenting an access token needs it.
app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type", "Mcp-Session-Id"],
    exposeHeaders: ["WWW-Authenticate", "Mcp-Session-Id"],
  }),
);

// Paths that don't participate in our session/passkey/inbox pipeline.
// (BetterAuth handles its own auth at /api/auth/*; setup/invites/health/config
// are intentionally public.)
function isUnauthenticatedPath(path: string): boolean {
  return (
    path.startsWith("/api/auth") ||
    path.startsWith("/api/setup") ||
    path.startsWith("/api/invites") ||
    path.startsWith("/api/unsubscribe") ||
    path === "/api/health" ||
    path === "/api/config"
  );
}

// Paths that require a session but are exempt from the passkey requirement.
// Users must be able to check their own passkey status before they've
// registered one (so the frontend can route them to /setup-passkey).
function isPasskeyExemptPath(path: string): boolean {
  return path === "/api/user/passkeys";
}

// Block email+password sign-in for users who have already registered a
// passkey. Runs BEFORE the catch-all BetterAuth handler so we get first look
// at the request. The body is read via a clone so BetterAuth can still parse
// the original.
app.post("/api/auth/sign-in/email", async (c, next) => {
  if (isDevEnvironment(c.env)) return next();

  let email: string | undefined;
  try {
    const body = (await c.req.raw.clone().json()) as { email?: string };
    email = body.email?.toLowerCase();
  } catch {
    // Malformed body — let BetterAuth surface the error.
    return next();
  }
  if (!email) return next();

  const db = c.get("db");
  const userRows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (userRows.length === 0) return next();

  const pkRows = await db
    .select({ id: passkeys.id })
    .from(passkeys)
    .where(eq(passkeys.userId, userRows[0].id))
    .limit(1);
  if (pkRows.length > 0) {
    return c.json(
      {
        error:
          "Password sign-in is disabled for accounts with a registered passkey. Please sign in with your passkey.",
        code: "PASSKEY_REQUIRED_FOR_SIGNIN",
      },
      403,
    );
  }
  return next();
});

// BetterAuth handler
app.all("/api/auth/*", (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

// Session resolution for all API routes
app.use("/api/*", async (c, next) => {
  if (isUnauthenticatedPath(c.req.path)) return next();

  // Try session cookie first
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  if (session) {
    c.set("user", session.user);
    c.set("authMethod", "session");
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
        c.set("authMethod", "apiKey");
        return next();
      }
    }
  }

  // Try an OAuth 2.1 access token. These are the tokens this deployment
  // already issues; until now they were only accepted by /mcp, so a
  // third-party or native client had no way to reach the API it was granted
  // scopes for. The same resolver backs both surfaces, so revocation, ban and
  // passkey rules cannot drift apart between them.
  const accessToken = bearerAccessToken(authHeader);
  if (accessToken) {
    const result = await resolveOAuthPrincipal({
      db: c.get("db"),
      env: c.env,
      token: accessToken,
      baseURL: c.env.BASE_URL || "http://localhost:8080",
    });

    if (result.ok) {
      c.set("user", result.principal.user);
      c.set("authMethod", "oauth");
      c.set("oauthScopes", result.principal.scopes);
      c.set("oauthClientId", result.principal.clientId);
      c.set("allowedInboxes", result.principal.allowed);
      return next();
    }

    // Answer in this surface's own vocabulary rather than /mcp's bearer
    // challenge. A client that gets a generic 401 for a missing passkey would
    // refresh its token and retry forever against something a new token cannot
    // fix, so that case keeps the documented 403 the web client already knows.
    if (result.failure.reason === "passkey_required") {
      return c.json(
        { error: "Passkey registration required", code: "PASSKEY_REQUIRED" },
        403,
      );
    }
    return c.json({ error: result.failure.message }, 401);
  }

  return c.json({ error: "Unauthorized" }, 401);
});

// Scope enforcement for OAuth bearer callers.
//
// Only OAuth requests are gated: a session or API-key caller acts as the user
// with their whole surface, exactly as before. A token acts on behalf of a
// client the user consented to for specific capabilities, so it gets only
// those. Unclassified routes are refused rather than allowed, so adding a
// route without classifying it breaks an integration instead of quietly
// widening every token.
app.use("/api/*", async (c, next) => {
  if (isUnauthenticatedPath(c.req.path)) return next();
  if (c.get("authMethod") !== "oauth") return next();

  const cls = classifyRoute(c.req.method, c.req.path);

  if (cls.kind === "denied") {
    return c.json(
      {
        error: "This endpoint is not available to OAuth clients",
        code: "OAUTH_SCOPE_DENIED",
      },
      403,
    );
  }

  const granted = c.get("oauthScopes") ?? [];
  if (!granted.includes(cls.scope)) {
    return c.json(
      {
        error: `Missing required scope: ${cls.scope}`,
        code: "OAUTH_INSUFFICIENT_SCOPE",
        required: cls.scope,
      },
      403,
    );
  }

  // The scope says the client may act on the admin surface; the role says this
  // user may. Both are required — a consented scope must never promote a
  // member.
  if (cls.requiresAdminRole && c.get("user")?.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Four routes are safe by path and not by body: an invite is a credential, a
  // role change can promote, and `forwardTo` / the webhook URL repoint every
  // future message. The clamps live beside the path table rather than in the
  // handlers so both halves of the boundary are read together, and
  // `guardBearerBody` reads the body only for a route it guards — caching it on
  // anything else would break a multipart send.
  const refusal = await guardBearerBody(c.req.method, c.req.path, () =>
    c.req.json().catch(() => null),
  );
  if (refusal) {
    return c.json({ error: refusal, code: "OAUTH_SCOPE_DENIED" }, 403);
  }

  return next();
});

// Enforce passkey registration for session-cookie users. Runs before
// inbox-scoping so an unregistered user gets a consistent 403.
app.use("/api/*", async (c, next) => {
  if (isUnauthenticatedPath(c.req.path)) return next();
  if (isPasskeyExemptPath(c.req.path)) return next();
  return requirePasskey(c, next);
});

// Inject allowed inboxes for all authenticated API routes
app.use("/api/*", async (c, next) => {
  if (isUnauthenticatedPath(c.req.path)) return next();
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
app.route("/api/conversations", conversationsRouter);
app.route("/api/send", sendRouter);
app.route("/api/attachments", attachmentsRouter);
app.route("/api/stats", statsRouter);
app.route("/api/setup", setupRouter);
app.route("/api/email-templates", emailTemplatesRouter);
app.route("/api/user", userRouter);
app.route("/api/api-keys", apiKeysRouter);
app.route("/api/invites", invitesRouter);
app.route("/api/sequences", sequencesRouter);
app.route("/api/notifications", notificationsRouter);
app.route("/api/blocklist", blocklistRouter);
app.route("/api/outbox", outboxRouter);

// Admin routes (require admin role)
app.use("/api/admin/*", requireAdmin);
app.route("/api/admin", adminRouter);
app.route("/api/admin/inboxes", adminInboxesRouter);

// Registered OAuth clients. Admin-only: registration is open to any caller so
// MCP clients can self-register, which makes an operator-visible list and a
// revocation path the control that actually bounds it.
app.use("/api/oauth-apps", requireAdmin);
app.use("/api/oauth-apps/*", requireAdmin);
app.route("/api/oauth-apps", oauthAppsRouter);

// Suppressions CRUD — admin-only (not under /api/admin/ for UX but enforced
// here with the same role guard).
app.use("/api/suppressions/*", requireAdmin);
app.use("/api/suppressions", requireAdmin);
app.route("/api/suppressions", suppressionsRouter);

// Webhook config — admin-only global instance config.
app.use("/api/webhook", requireAdmin);
app.use("/api/webhook/*", requireAdmin);
app.route("/api/webhook", webhooksRouter);

// Public unsubscribe endpoints — token-authenticated, no session/API key.
// Allowlisted in `isUnauthenticatedPath` above.
app.route("/api/unsubscribe", unsubscribeRouter);

// Also mount at `/unsubscribe` so the same URL we put in the `List-Unsubscribe`
// email header (which doubles as the body link → SPA at GET /unsubscribe) handles
// RFC 8058 one-click POSTs from mail clients like Fastmail / Gmail / Apple Mail.
// GET requests don't match the router and fall through to the SPA assets handler.
app.route("/unsubscribe", unsubscribeRouter);

// Public bootstrap routes (no auth) — documented in OpenAPI under Bootstrap tag
app.route("/api", bootstrapRouter);

// MCP endpoint + OAuth discovery. Registered before the SPA catch-all so
// `/.well-known/*` isn't served index.html. `/mcp` authenticates with OAuth
// bearer tokens via mcpHandler rather than the session/API-key pipeline, and
// it sits outside `/api/*` so that middleware never applies to it.
registerMcpRoutes(app);

// Swagger UI
app.get("/swagger-ui", swaggerUI({ url: "/doc" }));
app.doc("/doc", {
  openapi: "3.0.0",
  info: {
    title: "saasmail API",
    version: "1.0.0",
    description: openapiInfoDescription,
  },
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
    ctx.waitUntil(
      handleScheduled(env)
        .catch((err) => console.error("[cron] sequence dispatch failed:", err))
        .then(() => processOutbox(env)),
    );
  },
  async queue(
    batch: MessageBatch<SequenceEmailMessage>,
    env: CloudflareBindings,
  ) {
    await handleQueueBatch(batch, env);
  },
};
