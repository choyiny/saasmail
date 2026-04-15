# MCP Server with OAuth Provider — Design Spec

## Overview

Add an MCP (Model Context Protocol) server to cmail, secured via OAuth using `@better-auth/oauth-provider`. MCP clients (e.g., Claude Desktop) can discover the server, self-register via dynamic client registration, go through an OAuth consent flow, and then access email CRUD operations via OAuth-protected endpoints. Connection details and registered app management live on the existing `/api-keys` page.

## OAuth Provider Setup

### better-auth config changes

- Install `@better-auth/oauth-provider` package (via `yarn add`)
- Add `oauthProvider()` and `jwt()` plugins to the auth config in `worker/src/auth/index.ts`
- Configure:
  - `loginPage: "/login"`
  - `consentPage: "/consent"`
  - `allowDynamicClientRegistration: true`
- Run `auth:generate` to create the 4 new tables in the Drizzle schema:
  - `oauthClient` — registered OAuth clients
  - `oauthAccessToken` — access tokens
  - `oauthRefreshToken` — refresh tokens
  - `oauthConsent` — user consent records
- Generate and apply D1 migration

### Endpoints provided by the plugin

These are handled automatically by better-auth's existing `/api/auth/*` catch-all route:

- `GET /api/auth/oauth2/authorize` — authorization endpoint
- `POST /api/auth/oauth2/token` — token exchange
- `POST /api/auth/oauth2/register` — dynamic client registration
- `GET /api/auth/oauth2/userinfo` — user info
- `GET /api/auth/.well-known/openid-configuration` — OIDC discovery

### Well-known endpoints

The oauth-provider plugin needs well-known endpoints at the root path. Add an explicit route before the SPA fallback:

```typescript
app.all("/.well-known/*", (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});
```

This serves:

- `GET /.well-known/openid-configuration`
- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/oauth-protected-resource`

## Consent Screen

### Route

`/consent` — standalone React page, no dashboard layout. Styled to match the dark theme of login/onboarding pages.

### Flow

1. MCP client initiates OAuth flow → user redirected to `/api/auth/oauth2/authorize`
2. If not logged in → better-auth redirects to `/login`
3. After login → redirected to `/consent` with query params (`client_id`, `scope`, `redirect_uri`)
4. Consent page displays:
   - App name (from registered client)
   - Requested scopes (human-readable descriptions)
   - Approve / Deny buttons
5. On approve → posts consent to better-auth → authorization code issued
6. User redirected back to the MCP client

### Scopes

| Scope          | Description                     |
| -------------- | ------------------------------- |
| `email:read`   | Read emails and senders         |
| `email:send`   | Send and reply to emails        |
| `email:manage` | Mark read/unread, delete emails |

## MCP Server Endpoints

REST endpoints at `/mcp/*`, protected by OAuth access token verification.

### Tools

| Tool           | Method | Path                       | Description                         |
| -------------- | ------ | -------------------------- | ----------------------------------- |
| `list_senders` | GET    | `/mcp/senders`             | List senders with search/pagination |
| `get_sender`   | GET    | `/mcp/senders/:id`         | Get a single sender                 |
| `list_emails`  | GET    | `/mcp/senders/:id/emails`  | List emails for a sender            |
| `read_email`   | GET    | `/mcp/emails/:id`          | Read a single email with body       |
| `send_email`   | POST   | `/mcp/send`                | Compose and send a new email        |
| `reply_email`  | POST   | `/mcp/send/reply/:emailId` | Reply to an email                   |
| `mark_read`    | PATCH  | `/mcp/emails/:id`          | Mark email read/unread              |
| `delete_email` | DELETE | `/mcp/emails/:id`          | Delete an email                     |

### Auth middleware

Verify OAuth access token using the oauth-provider's resource client. Extract the user from the token and set on the Hono context — same pattern as the existing session/API key middleware, but checking OAuth bearer tokens.

The middleware applies to all `/mcp/*` routes and enforces scope checks:

- `email:read` required for GET endpoints
- `email:send` required for POST send/reply endpoints
- `email:manage` required for PATCH and DELETE endpoints

## API Keys Page — MCP Connection Details

### Layout

Rework the `/api-keys` page into two sections:

#### Section 1: API Keys (existing)

Keep the existing API key generate/revoke functionality unchanged.

#### Section 2: MCP Connection

- **Server URL**: `https://mail.givefeedback.dev/mcp`
- **Connection config snippet** (copyable JSON for Claude Desktop):
  ```json
  {
    "mcpServers": {
      "cmail": {
        "url": "https://mail.givefeedback.dev/mcp",
        "auth": "oauth"
      }
    }
  }
  ```
- **Registered OAuth apps list**: app name, client ID, created date, "Revoke" button
- Empty state: "Connect an MCP client using the URL above. Apps will appear here after authorization."

### Backend additions

| Method | Path                        | Description                                    |
| ------ | --------------------------- | ---------------------------------------------- |
| GET    | `/api/oauth-apps`           | List OAuth clients registered for current user |
| DELETE | `/api/oauth-apps/:clientId` | Revoke an OAuth client and its tokens          |
