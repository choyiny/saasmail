import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { gmailAccounts } from "../db/gmail-accounts.schema";
import { users } from "../db/auth.schema";
import { encryptSecret } from "../lib/crypto";
import { buildAuthUrl, exchangeCode, getProfile } from "../lib/gmail/oauth";
import { signState, verifyState } from "../lib/gmail/state";
import { json200Response } from "../lib/helpers";
import type { Variables } from "../variables";

type GmailEnv = CloudflareBindings & {
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  BASE_URL?: string;
};

export const adminGmailRouter = new OpenAPIHono<{
  Bindings: GmailEnv;
  Variables: Variables;
}>();

// Must match a route declared in src/App.tsx — anything else is swallowed by
// the SPA catch-all and the `?gmail=` result signal is lost.
const INBOXES_PATH = "/inboxes";

function config(env: GmailEnv) {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  const encryptionKey = env.TOKEN_ENCRYPTION_KEY;
  if (!clientId || !clientSecret || !encryptionKey) return null;
  const base = (env.BASE_URL ?? "").replace(/\/$/, "");
  return {
    clientId,
    clientSecret,
    encryptionKey,
    base,
    redirectUri: `${base}/api/admin/gmail/callback`,
  };
}

const AccountSchema = z.object({
  id: z.string(),
  emailAddress: z.string(),
  lastSyncedAt: z.number().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number(),
  /**
   * The admin who last connected or reconnected this mailbox, resolved from
   * `gmail_accounts.connected_by`. Null on a row connected before the column
   * existed; `name`/`email` are null when that user has since been deleted,
   * since the column carries no foreign key and the id outlives the account.
   */
  connectedBy: z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      email: z.string().nullable(),
    })
    .nullable(),
});

const connectRoute = createRoute({
  method: "get",
  path: "/connect",
  tags: ["Admin Gmail"],
  description: "Begin the Google OAuth flow for a mailbox.",
  responses: {
    ...json200Response(z.object({ authUrl: z.string() }), "Consent URL"),
    503: {
      description: "Gmail integration is not configured on this instance",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
  },
});

adminGmailRouter.openapi(connectRoute, async (c) => {
  const cfg = config(c.env);
  if (!cfg) {
    return c.json({ error: "Gmail integration is not configured" }, 503);
  }
  // TOKEN_ENCRYPTION_KEY does double duty: it seals stored refresh tokens and
  // is the HMAC secret for the OAuth state. Deliberate — one secret to manage.
  const state = await signState(c.get("user").id, cfg.encryptionKey);
  return c.json({
    authUrl: buildAuthUrl({
      clientId: cfg.clientId,
      redirectUri: cfg.redirectUri,
      state,
    }),
  });
});

const callbackRoute = createRoute({
  method: "get",
  path: "/callback",
  tags: ["Admin Gmail"],
  description: "Google redirects here after consent.",
  request: {
    query: z.object({
      code: z.string().optional(),
      state: z.string().optional(),
    }),
  },
  responses: {
    302: { description: "Redirect back to the Inboxes page" },
  },
});

adminGmailRouter.openapi(callbackRoute, async (c) => {
  const cfg = config(c.env);
  const { code, state } = c.req.valid("query");
  if (!cfg || !code || !state) {
    return c.redirect(`${INBOXES_PATH}?gmail=error`, 302);
  }

  try {
    // Same key as signState above — it both seals refresh tokens and signs
    // this state parameter. Deliberate; see docs/configuration.md.
    const userId = await verifyState(state, cfg.encryptionKey);
    const tokens = await exchangeCode({
      code,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      redirectUri: cfg.redirectUri,
    });
    if (!tokens.refreshToken) {
      // Without a refresh token the connection is useless the moment the
      // access token expires, so refuse it rather than storing a dud.
      return c.redirect(`${INBOXES_PATH}?gmail=error`, 302);
    }

    const profile = await getProfile(tokens.accessToken);
    const sealed = await encryptSecret(tokens.refreshToken, cfg.encryptionKey);
    const now = Math.floor(Date.now() / 1000);
    const db = c.get("db");

    // Reconnecting an already-known mailbox replaces its credentials and
    // clears the error that prompted the reconnect.
    await db
      .insert(gmailAccounts)
      .values({
        id: nanoid(),
        emailAddress: profile.emailAddress,
        refreshTokenEncrypted: sealed,
        accessToken: tokens.accessToken,
        expiresAt: now + tokens.expiresIn,
        historyId: profile.historyId,
        lastSyncedAt: null,
        lastError: null,
        connectedBy: userId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: gmailAccounts.emailAddress,
        set: {
          refreshTokenEncrypted: sealed,
          accessToken: tokens.accessToken,
          expiresAt: now + tokens.expiresIn,
          historyId: profile.historyId,
          lastError: null,
          connectedBy: userId,
          updatedAt: now,
        },
      });

    return c.redirect(`${INBOXES_PATH}?gmail=connected`, 302);
  } catch (err) {
    // Log only the message, never the error object: a D1 error carries its
    // bound query parameters, which on this path include the access token.
    const reason = err instanceof Error ? err.message : "unknown error";
    console.error(`[gmail] OAuth callback failed: ${reason}`);
    return c.redirect(`${INBOXES_PATH}?gmail=error`, 302);
  }
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin Gmail"],
  description: "List connected Google mailboxes.",
  responses: {
    ...json200Response(
      z.object({ accounts: z.array(AccountSchema) }),
      "Connected mailboxes",
    ),
  },
});

adminGmailRouter.openapi(listRoute, async (c) => {
  // The five columns are listed deliberately. `@hono/zod-openapi` does NOT
  // validate or strip response bodies — AccountSchema only feeds the OpenAPI
  // document — so selecting whole rows here would hand the caller
  // `refreshTokenEncrypted` and `accessToken`. The shipped test asserts the
  // response body contains neither token column.
  const rows = await c
    .get("db")
    .select({
      id: gmailAccounts.id,
      emailAddress: gmailAccounts.emailAddress,
      lastSyncedAt: gmailAccounts.lastSyncedAt,
      lastError: gmailAccounts.lastError,
      createdAt: gmailAccounts.createdAt,
      connectedById: gmailAccounts.connectedBy,
      // Left join: `connected_by` carries no foreign key, so the admin who
      // connected a mailbox can be gone while the row remains. An inner join
      // would drop the mailbox from the list entirely.
      connectedByName: users.name,
      connectedByEmail: users.email,
    })
    .from(gmailAccounts)
    .leftJoin(users, eq(users.id, gmailAccounts.connectedBy));
  return c.json({
    accounts: rows.map(
      ({ connectedById, connectedByName, connectedByEmail, ...account }) => ({
        ...account,
        connectedBy:
          connectedById === null
            ? null
            : {
                id: connectedById,
                name: connectedByName,
                email: connectedByEmail,
              },
      }),
    ),
  });
});

const disconnectRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin Gmail"],
  description: "Disconnect a Google mailbox and delete its stored token.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "Disconnected"),
    404: {
      description: "No such connected mailbox",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
  },
});

adminGmailRouter.openapi(disconnectRoute, async (c) => {
  const { id } = c.req.valid("param");
  const db = c.get("db");

  // Say so when there is nothing to disconnect. Answering `success: true` for
  // an id that was never here tells an operator their mailbox is gone when
  // the one they meant is still connected and still syncing.
  const [account] = await db
    .select({ id: gmailAccounts.id })
    .from(gmailAccounts)
    .where(eq(gmailAccounts.id, id))
    .limit(1);
  if (!account) {
    return c.json({ error: "That Google mailbox is not connected." }, 404);
  }

  await db.delete(gmailAccounts).where(eq(gmailAccounts.id, id));
  return c.json({ success: true });
});
