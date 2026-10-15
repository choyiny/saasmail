import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { gmailAccounts } from "../db/gmail-accounts.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { users } from "../db/auth.schema";
import { encryptSecret } from "../lib/crypto";
import { buildAuthUrl, exchangeCode, getProfile } from "../lib/gmail/oauth";
import { signState, verifyState } from "../lib/gmail/state";
import { clearGmailThreadIds } from "../lib/gmail/thread-ids";
import { ensureBackfillJobs, stopBackfillJob } from "../lib/gmail/backfill-job";
import { json200Response } from "../lib/helpers";
import { loadProviderConfig } from "../lib/oauth-providers";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { schema } from "../db/schema";
import type { Variables } from "../variables";

type GmailEnv = CloudflareBindings & { BASE_URL?: string };

export const adminGmailRouter = new OpenAPIHono<{
  Bindings: GmailEnv;
  Variables: Variables;
}>();

// Must match a route declared in src/App.tsx — anything else is swallowed by
// the SPA catch-all and the `?gmail=` result signal is lost.
const INBOXES_PATH = "/inboxes";

/** Where Google sends the admin back after consent. */
export function gmailRedirectUri(env: { BASE_URL?: string }): string {
  return `${(env.BASE_URL ?? "").replace(/\/$/, "")}/api/admin/gmail/callback`;
}

async function config(db: DrizzleD1Database<typeof schema>, env: GmailEnv) {
  const cfg = await loadProviderConfig(db, env, "google");
  if (!cfg) return null;
  return { ...cfg, redirectUri: gmailRedirectUri(env) };
}

/** Share of the import window already walked, by date. See AccountSchema. */
function backfillProgress(
  completedAt: number | null,
  until: number | null,
  since: number | null,
  reached: number | null,
): number {
  if (completedAt !== null) return 1;
  if (until === null || since === null || reached === null) return 0;
  if (until <= since) return 0;
  return Math.min(1, Math.max(0, (until - reached) / (until - since)));
}

const AccountSchema = z.object({
  id: z.string(),
  emailAddress: z.string(),
  lastSyncedAt: z.number().nullable(),
  lastError: z.string().nullable(),
  // When the sync cursor was last re-seeded from the present (unix seconds) —
  // an expired history cursor, or a reconnect — or null if that has never
  // happened. Mail from inside that gap could not be recovered; see the doc
  // comment on gmail_accounts.last_gap_at.
  lastGapAt: z.number().nullable(),
  /**
   * The one-off import of the last year. `status` is "pending" until
   * it has started, "running" while it pages through the window, and "done"
   * once it has reached the end; `count` is how many messages it has handled.
   */
  backfill: z.object({
    status: z.enum(["pending", "running", "done"]),
    count: z.number(),
    completedAt: z.number().nullable(),
    /**
     * How far through its window the import is, 0 to 1. Measured by date,
     * not count: the import walks newest first, and Gmail gives no reliable
     * total, so the oldest date reached is the honest measure. 1 when done.
     */
    progress: z.number(),
    /** Gmail date (unix seconds) of the oldest message reached so far. */
    reachedAt: z.number().nullable(),
  }),
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
  request: {
    query: z.object({
      // Set when reconnecting a mailbox that is already connected. It both
      // pre-selects that account at Google and, carried in the signed state,
      // is what the callback refuses to write anything else against.
      email: z.string().email().optional(),
    }),
  },
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
  const cfg = await config(c.get("db"), c.env);
  if (!cfg) {
    return c.json(
      {
        error:
          "Google is not set up yet. Add its OAuth client ID and secret under Inboxes → Connected mailboxes → Google settings.",
      },
      503,
    );
  }
  const { email } = c.req.valid("query");
  // Lowercased here and on the profile coming back, or a reconnect started
  // as ?email=Ops@Example.com would refuse itself: the callback compares
  // against Gmail's lowercase address and redirects to wrong_account. No
  // trim: `z.string().email()` has already rejected a padded address with a
  // 400, so trimming here would only be decoration.
  const expectedEmail = email ? email.toLowerCase() : null;
  // TOKEN_ENCRYPTION_KEY does double duty: it seals stored refresh tokens and
  // is the HMAC secret for the OAuth state. Deliberate — one secret to manage.
  const state = await signState(
    c.get("user").id,
    cfg.encryptionKey,
    Math.floor(Date.now() / 1000),
    expectedEmail,
  );
  return c.json({
    authUrl: buildAuthUrl({
      clientId: cfg.clientId,
      redirectUri: cfg.redirectUri,
      state,
      ...(expectedEmail ? { loginHint: expectedEmail } : {}),
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
  const cfg = await config(c.get("db"), c.env);
  const { code, state } = c.req.valid("query");
  if (!cfg || !code || !state) {
    return c.redirect(`${INBOXES_PATH}?gmail=error`, 302);
  }

  try {
    // Same key as signState above — it both seals refresh tokens and signs
    // this state parameter. Deliberate; see docs/configuration.md.
    const { userId, expectedEmail } = await verifyState(
      state,
      cfg.encryptionKey,
    );
    const connectedBy = c.get("user").id;

    // The signature is what makes the payload trustworthy; this is what the
    // payload is *for*. `signState` seals in the admin who began the flow, so
    // requiring the session to match binds the consent to them. Without it a
    // state minted in one admin's browser completes in another's, and the
    // mailbox Google hands back is stored — and attributed — under whoever
    // happened to open the link.
    //
    // It refuses nothing legitimate: a state lives ten minutes (state.ts) and
    // the same admin signed in twice is still the same user id. The only flow
    // this stops is one finished by somebody else. Checked before
    // `exchangeCode`, so a refused callback also burns no authorization code.
    if (userId !== connectedBy) {
      return c.redirect(`${INBOXES_PATH}?gmail=wrong_admin`, 302);
    }
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
    // Normalised for both the check and the row. The unique index on
    // email_address is case-sensitive, so storing Google's casing verbatim
    // would let the same mailbox land twice under different spellings and
    // miss the upsert entirely. Every other address in the codebase is
    // lowercased at the boundary; this one is no different.
    const mailbox = profile.emailAddress.trim().toLowerCase();

    // A reconnect names the mailbox it is for. If Google handed back a
    // different account — the operator was signed in as someone else and
    // clicked through the chooser — writing it would upsert on *that*
    // address: it would reset a healthy mailbox's history cursor to head,
    // skipping everything since its last poll, while leaving the mailbox the
    // operator meant to fix untouched. So write nothing and say which is
    // which. `login_hint` is only a hint; this check is the guarantee.
    if (expectedEmail !== null && mailbox !== expectedEmail) {
      const params = new URLSearchParams({
        gmail: "wrong_account",
        gmail_expected: expectedEmail,
        gmail_granted: profile.emailAddress,
      });
      return c.redirect(`${INBOXES_PATH}?${params.toString()}`, 302);
    }

    const sealed = await encryptSecret(tokens.refreshToken, cfg.encryptionKey);
    const now = Math.floor(Date.now() / 1000);
    const db = c.get("db");

    // A reconnect restarts the import, so the job running the old one has to
    // stop — read its id before the upsert below clears it.
    const [previous] = await db
      .select({ jobId: gmailAccounts.backfillJobId })
      .from(gmailAccounts)
      .where(eq(gmailAccounts.emailAddress, mailbox));

    // Reconnecting an already-known mailbox replaces its credentials and
    // clears the error that prompted the reconnect. It also moves the history
    // cursor to the mailbox's current head, which is why `lastGapAt` is
    // stamped on the conflict branch below: mail that arrived between the old
    // cursor and now is never fetched and cannot be recovered from history,
    // exactly like an expired cursor. Recording it is the only thing that
    // makes that loss visible — a reconnect otherwise re-seeds in silence,
    // under a green "Mailbox connected" banner. Never on the insert branch: a
    // first connection has no earlier cursor to skip past.
    await db
      .insert(gmailAccounts)
      .values({
        id: nanoid(),
        emailAddress: mailbox,
        refreshTokenEncrypted: sealed,
        accessToken: tokens.accessToken,
        expiresAt: now + tokens.expiresIn,
        historyId: profile.historyId,
        lastSyncedAt: null,
        lastError: null,
        connectedBy,
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
          lastGapAt: now,
          // Import the last year again. It is what refills the gap the line
          // above records, as far as a year reaches, and the
          // per-inbox dedupe makes everything already here a no-op.
          backfillUntil: null,
          backfillSince: null,
          backfillPageToken: null,
          backfillOffset: 0,
          backfillCount: 0,
          backfillCompletedAt: null,
          backfillReached: null,
          // Any job still running stops at its next chunk, and the next
          // cron tick starts a new one over the reset window.
          backfillJobId: null,
          connectedBy,
          updatedAt: now,
        },
      });

    if (previous?.jobId) {
      await stopBackfillJob(c.env, previous.jobId);
      // The turn it held is free: start the next import (possibly this
      // mailbox's own restart) now rather than at the next cron tick.
      await ensureBackfillJobs(db, c.env).catch(() => {});
    }

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
  // The columns are listed deliberately. `@hono/zod-openapi` does NOT
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
      lastGapAt: gmailAccounts.lastGapAt,
      backfillUntil: gmailAccounts.backfillUntil,
      backfillSince: gmailAccounts.backfillSince,
      backfillReached: gmailAccounts.backfillReached,
      backfillCount: gmailAccounts.backfillCount,
      backfillCompletedAt: gmailAccounts.backfillCompletedAt,
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
    .select({ id: gmailAccounts.id, jobId: gmailAccounts.backfillJobId })
    .from(gmailAccounts)
    .where(eq(gmailAccounts.id, id))
    .limit(1);
  if (!account) {
    return c.json({ error: "That Google mailbox is not connected." }, 404);
  }

  const mapped = await db
    .select({ email: senderIdentities.email })
    .from(senderIdentities)
    .where(eq(senderIdentities.gmailAccountId, id));

  // Unmap every inbox that read from this mailbox and delete the account in
  // ONE batch. Leaving the foreign key behind would leave rows claiming
  // source "gmail" while pointing at an account that no longer exists: the
  // inbox silently stops receiving, and the UI can only show it as an orphan
  // after a reload. Cloudflare is the honest fallback — it is what an
  // unmapped inbox is.
  //
  // Batched because as two unguarded statements a failure between them left
  // every inbox flipped to cloudflare while the mailbox stayed connected and
  // syncing — a silent wipe of the operator's mapping behind a UI that said
  // "Couldn't disconnect".
  await db.batch([
    db
      .update(senderIdentities)
      .set({
        source: "cloudflare",
        gmailAccountId: null,
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(senderIdentities.gmailAccountId, id)),
    db.delete(gmailAccounts).where(eq(gmailAccounts.id, id)),
  ]);

  // Those inboxes' stored Gmail thread ids were issued by the mailbox that
  // has just gone. See `clearGmailThreadIds` for why leaving them is worse
  // than losing the threading.
  await clearGmailThreadIds(
    db,
    mapped.map((m) => m.email),
  );

  // Its import, if one was running, goes with it — and frees the turn for
  // the next mailbox waiting.
  if (account.jobId) {
    await stopBackfillJob(c.env, account.jobId);
    await ensureBackfillJobs(db, c.env).catch(() => {});
  }

  return c.json({ success: true });
});
