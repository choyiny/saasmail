import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { outlookAccounts } from "../db/outlook-accounts.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { users } from "../db/auth.schema";
import type { schema } from "../db/schema";
import { encryptSecret } from "../lib/crypto";
import { signState, verifyState } from "../lib/gmail/state";
import { ensureBackfillJobs, stopBackfillJob } from "../lib/gmail/backfill-job";
import { buildAuthUrl, exchangeCode, getProfile } from "../lib/outlook/oauth";
import { outlookAuthConfig } from "../lib/outlook/token";
import { json200Response } from "../lib/helpers";
import { AccountSchema, backfillProgress } from "./admin-gmail-router";
import type { Variables } from "../variables";

/**
 * Connecting and managing Outlook mailboxes — the Microsoft counterpart of
 * `admin-gmail-router.ts`, with the same contract: a consent URL handed back
 * as JSON, a callback bound to the admin who started it and (on reconnect)
 * to the mailbox it was meant for, and a list in the same shape as Gmail's
 * so the Inboxes page renders both alike.
 */

type OutlookEnv = CloudflareBindings & { BASE_URL?: string };

export const adminOutlookRouter = new OpenAPIHono<{
  Bindings: OutlookEnv;
  Variables: Variables;
}>();

const INBOXES_PATH = "/inboxes";

/** Where Microsoft sends the admin back after sign-in. */
export function outlookRedirectUri(env: { BASE_URL?: string }): string {
  return `${(env.BASE_URL ?? "").replace(/\/$/, "")}/api/admin/outlook/callback`;
}

async function config(db: DrizzleD1Database<typeof schema>, env: OutlookEnv) {
  const cfg = await outlookAuthConfig(db, env);
  if (!cfg) return null;
  return { ...cfg, redirectUri: outlookRedirectUri(env) };
}

const NOT_SET_UP =
  "Microsoft is not set up yet. Add its app registration's client ID and secret under Inboxes → Connected mailboxes → Microsoft settings.";

const connectRoute = createRoute({
  method: "get",
  path: "/connect",
  tags: ["Admin Outlook"],
  description: "Begin the Microsoft sign-in flow for a mailbox.",
  request: {
    query: z.object({
      // Set when reconnecting: pre-selects that account and binds the
      // callback to it.
      email: z.string().email().optional(),
    }),
  },
  responses: {
    ...json200Response(z.object({ authUrl: z.string() }), "Sign-in URL"),
    503: {
      description: "Microsoft is not set up on this instance",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
  },
});

adminOutlookRouter.openapi(connectRoute, async (c) => {
  const cfg = await config(c.get("db"), c.env);
  if (!cfg) return c.json({ error: NOT_SET_UP }, 503);
  const { email } = c.req.valid("query");
  const expectedEmail = email ? email.toLowerCase() : null;
  const state = await signState(
    c.get("user").id,
    cfg.encryptionKey,
    Math.floor(Date.now() / 1000),
    expectedEmail,
  );
  return c.json(
    {
      authUrl: buildAuthUrl({
        clientId: cfg.clientId,
        tenant: cfg.tenant,
        redirectUri: cfg.redirectUri,
        state,
        ...(expectedEmail ? { loginHint: expectedEmail } : {}),
      }),
    },
    200,
  );
});

const callbackRoute = createRoute({
  method: "get",
  path: "/callback",
  tags: ["Admin Outlook"],
  description: "Microsoft redirects here after sign-in.",
  request: {
    query: z.object({
      code: z.string().optional(),
      state: z.string().optional(),
      // Microsoft reports a refused or failed sign-in here instead of a code.
      error: z.string().optional(),
    }),
  },
  responses: { 302: { description: "Redirect back to the Inboxes page" } },
});

adminOutlookRouter.openapi(callbackRoute, async (c) => {
  const db = c.get("db");
  const cfg = await config(db, c.env);
  const { code, state } = c.req.valid("query");
  if (!cfg || !code || !state) {
    return c.redirect(`${INBOXES_PATH}?outlook=error`, 302);
  }

  try {
    const { userId, expectedEmail } = await verifyState(
      state,
      cfg.encryptionKey,
    );
    const connectedBy = c.get("user").id;
    // The flow is bound to the admin who started it, as with Gmail.
    if (userId !== connectedBy) {
      return c.redirect(`${INBOXES_PATH}?outlook=wrong_admin`, 302);
    }

    const tokens = await exchangeCode({
      code,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      tenant: cfg.tenant,
      redirectUri: cfg.redirectUri,
    });
    if (!tokens.refreshToken) {
      // No `offline_access` grant: nothing to sync with after an hour.
      return c.redirect(`${INBOXES_PATH}?outlook=error`, 302);
    }

    const profile = await getProfile(tokens.accessToken);
    const mailbox = profile.emailAddress;

    if (expectedEmail !== null && mailbox !== expectedEmail) {
      const params = new URLSearchParams({
        outlook: "wrong_account",
        outlook_expected: expectedEmail,
        outlook_granted: mailbox,
      });
      return c.redirect(`${INBOXES_PATH}?${params.toString()}`, 302);
    }

    const sealed = await encryptSecret(tokens.refreshToken, cfg.encryptionKey);
    const now = Math.floor(Date.now() / 1000);

    const [previous] = await db
      .select({
        jobId: outlookAccounts.backfillJobId,
        lastSyncedAt: outlookAccounts.lastSyncedAt,
      })
      .from(outlookAccounts)
      .where(eq(outlookAccounts.emailAddress, mailbox));

    await db
      .insert(outlookAccounts)
      .values({
        id: nanoid(),
        emailAddress: mailbox,
        refreshTokenEncrypted: sealed,
        accessToken: tokens.accessToken,
        expiresAt: now + tokens.expiresIn,
        syncFrom: now,
        connectedBy,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: outlookAccounts.emailAddress,
        set: {
          refreshTokenEncrypted: sealed,
          accessToken: tokens.accessToken,
          expiresAt: now + tokens.expiresIn,
          lastError: null,
          // Unlike Gmail, a reconnect leaves no gap: the delta cursors are
          // kept, and if Graph has expired them the sync re-reads from the
          // last successful sync. So `lastGapAt` is not stamped here.
          //
          // The import starts over, as Gmail's does on reconnect.
          backfillUntil: null,
          backfillSince: null,
          backfillLink: null,
          backfillOffset: 0,
          backfillCount: 0,
          backfillCompletedAt: null,
          backfillReached: null,
          backfillJobId: null,
          connectedBy,
          updatedAt: now,
        },
      });

    if (previous?.jobId) {
      await stopBackfillJob(c.env, previous.jobId);
      await ensureBackfillJobs(db, c.env).catch(() => {});
    }

    return c.redirect(`${INBOXES_PATH}?outlook=connected`, 302);
  } catch (err) {
    // The message only: a D1 error carries its bound parameters, tokens
    // included.
    const reason = err instanceof Error ? err.message : "unknown error";
    console.error(`[outlook] OAuth callback failed: ${reason}`);
    return c.redirect(`${INBOXES_PATH}?outlook=error`, 302);
  }
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin Outlook"],
  description: "List connected Outlook mailboxes.",
  responses: {
    ...json200Response(
      z.object({ accounts: z.array(AccountSchema) }),
      "Connected mailboxes",
    ),
  },
});

adminOutlookRouter.openapi(listRoute, async (c) => {
  // Columns listed explicitly so no token column can reach the response.
  const rows = await c
    .get("db")
    .select({
      id: outlookAccounts.id,
      emailAddress: outlookAccounts.emailAddress,
      lastSyncedAt: outlookAccounts.lastSyncedAt,
      lastError: outlookAccounts.lastError,
      lastGapAt: outlookAccounts.lastGapAt,
      backfillUntil: outlookAccounts.backfillUntil,
      backfillSince: outlookAccounts.backfillSince,
      backfillReached: outlookAccounts.backfillReached,
      backfillCount: outlookAccounts.backfillCount,
      backfillCompletedAt: outlookAccounts.backfillCompletedAt,
      createdAt: outlookAccounts.createdAt,
      connectedById: outlookAccounts.connectedBy,
      connectedByName: users.name,
      connectedByEmail: users.email,
    })
    .from(outlookAccounts)
    .leftJoin(users, eq(users.id, outlookAccounts.connectedBy));

  return c.json(
    {
      accounts: rows.map(
        ({
          connectedById,
          connectedByName,
          connectedByEmail,
          backfillUntil,
          backfillSince,
          backfillReached,
          backfillCount,
          backfillCompletedAt,
          ...account
        }) => ({
          ...account,
          backfill: {
            status:
              backfillCompletedAt !== null
                ? ("done" as const)
                : backfillUntil !== null
                  ? ("running" as const)
                  : ("pending" as const),
            count: backfillCount,
            completedAt: backfillCompletedAt,
            progress: backfillProgress(
              backfillCompletedAt,
              backfillUntil,
              backfillSince,
              backfillReached,
            ),
            reachedAt: backfillReached,
          },
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
    },
    200,
  );
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin Outlook"],
  description: "Disconnect an Outlook mailbox and delete its stored token.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "Disconnected"),
    404: {
      description: "No such mailbox",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
  },
});

adminOutlookRouter.openapi(deleteRoute, async (c) => {
  const { id } = c.req.valid("param");
  const db = c.get("db");
  const [account] = await db
    .select({ id: outlookAccounts.id, jobId: outlookAccounts.backfillJobId })
    .from(outlookAccounts)
    .where(eq(outlookAccounts.id, id))
    .limit(1);
  if (!account) {
    return c.json({ error: "That Outlook mailbox is not connected." }, 404);
  }

  // Unmap its inboxes and delete it in one batch, as Gmail's disconnect
  // does: an inbox left pointing at a deleted mailbox silently stops
  // receiving.
  await db.batch([
    db
      .update(senderIdentities)
      .set({
        source: "cloudflare",
        outlookAccountId: null,
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(senderIdentities.outlookAccountId, id)),
    db.delete(outlookAccounts).where(eq(outlookAccounts.id, id)),
  ]);

  if (account.jobId) {
    await stopBackfillJob(c.env, account.jobId);
    await ensureBackfillJobs(db, c.env).catch(() => {});
  }
  return c.json({ success: true }, 200);
});
