/** Shared OpenAPI auth documentation for `/doc` and route-level `security`. */

export const BEARER_AUTH_SCHEME = "BearerAuth";

export const openapiInfoDescription = `Self-hosted email API for a single saasmail Worker deployment.

## Authentication

Most routes require authentication via one of:

- **API key (recommended for integrations):** \`Authorization: Bearer sk_…\`
  Keys are issued per user at \`POST /api/api-keys\` (shown once at creation).
- **Session cookie:** BetterAuth session from the web UI (used by the SPA).

Unauthenticated requests to protected routes receive \`401 Unauthorized\`.

## Passkey gate

In non-development deployments, **session-cookie** users must register a passkey
before accessing data routes. Until then, responses are \`403\` with
\`{ "error": "Passkey registration required", "code": "PASSKEY_REQUIRED" }\`.
API-key requests bypass this gate.

## Inbox scoping

Users with the \`member\` role only see data and may only send from inboxes
assigned to them. \`admin\` users have full access. Sending from or accessing
an unassigned inbox returns \`403\`.

## Public routes (no auth)

\`/api/setup/*\`, \`/api/invites/*\`, \`/api/unsubscribe/*\`, \`/unsubscribe/*\`,
\`/api/health\`, \`/api/config\`, and \`/doc\` / \`/swagger-ui\`.

## Admin-only routes

\`/api/admin/*\`, \`/api/suppressions/*\`, and \`/api/webhook/*\` require the
\`admin\` role in addition to authentication.`;

export const bearerAuthSecurityScheme = {
  type: "http" as const,
  scheme: "bearer",
  description:
    "Per-user API key. Format: `sk_…`. Create or rotate at POST /api/api-keys.",
};

/** Apply to integrator-facing routes in route definitions. */
export const bearerSecurity = [{ [BEARER_AUTH_SCHEME]: [] }];
