import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "../../db/schema";
import { gmailAccounts } from "../../db/gmail-accounts.schema";
import { senderIdentities } from "../../db/sender-identities.schema";
import { emails } from "../../db/emails.schema";
import { parseRaw } from "../email-parser";
import { ingestParsedEmail } from "../../email-handler";
import { getAccessToken, type GmailAuthConfig } from "./token";
import { getProfile } from "./oauth";
import { listHistory, getMessage, GmailApiError } from "./api";
import { resolvePersonalInbox } from "./route-inbox";

/**
 * Bounded so one account cannot exhaust the Worker CPU budget. The cursor
 * makes the remainder resumable on the next tick, so a large backlog drains
 * across runs instead of failing one enormous run.
 */
export const MAX_MESSAGES_PER_RUN = 50;

/** Never reaches a customer timeline. SENT is a later slice's job. */
const SKIP_LABELS = new Set(["SENT", "DRAFT", "TRASH", "SPAM"]);

export type GmailAccountRow = typeof gmailAccounts.$inferSelect;

export type SyncResult = {
  ingested: number;
  skipped: number;
  reseeded: boolean;
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Point this account's cursor at the mailbox's current history position.
 *
 * Used both for the first sync (no cursor yet) and after Gmail expires a
 * cursor. Neither case backfills: history before `historyId` is either
 * pre-existing mail the operator did not ask us to import, or mail Gmail no
 * longer retains history for. Seeding and returning is the honest behaviour —
 * the alternative is silently inventing a backfill window.
 */
async function seedCursor(
  db: DrizzleD1Database<typeof schema>,
  accountId: string,
  accessToken: string,
): Promise<string> {
  const profile = await getProfile(accessToken);
  const now = nowSeconds();
  await db
    .update(gmailAccounts)
    .set({
      historyId: profile.historyId,
      lastSyncedAt: now,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(gmailAccounts.id, accountId));
  return profile.historyId;
}

/**
 * Poll one connected mailbox and feed anything new through the shared
 * ingestion path.
 *
 * Throws on an unrecoverable per-account failure (a revoked grant, a Gmail
 * outage). Callers must isolate it — see `syncAllGmailAccounts`.
 */
export async function syncAccount(
  db: DrizzleD1Database<typeof schema>,
  account: GmailAccountRow,
  env: CloudflareBindings,
  ctx: ExecutionContext,
  cfg: GmailAuthConfig,
): Promise<SyncResult> {
  // A revoked grant throws here. getAccessToken has already recorded
  // `lastError` on the row, so let it propagate to the per-account boundary
  // rather than swallowing it into a zero-count "success".
  const accessToken = await getAccessToken(db, account.id, cfg);

  // Scoped to THIS account: a `source: "cloudflare"` identity also has a null
  // `gmailGroupAddress`, and without this filter it would look like every
  // Gmail account's personal mailbox.
  const mappings = await db
    .select({
      email: senderIdentities.email,
      gmailGroupAddress: senderIdentities.gmailGroupAddress,
    })
    .from(senderIdentities)
    .where(eq(senderIdentities.gmailAccountId, account.id));

  // Resolved once per run, not per message: this slice routes personal
  // mailboxes only (1:1 account -> inbox) and deliberately inspects no
  // header, because List-ID and Delivered-To are both sender-forgeable.
  // Group mappings are ignored; `resolvePersonalInbox` returns null and each
  // message is counted as skipped rather than guessed at.
  const inbox = resolvePersonalInbox(mappings);

  let ingested = 0;
  let skipped = 0;

  if (!account.historyId) {
    await seedCursor(db, account.id, accessToken);
    return { ingested, skipped, reseeded: false };
  }

  const startHistoryId = account.historyId;
  let pageToken: string | undefined;
  let latestHistoryId: string | null = null;
  /** True once we stopped early at MAX_MESSAGES_PER_RUN, mid-history. */
  let truncated = false;
  /** True once Gmail has no further history pages for this cursor. */
  let exhausted = false;

  while (!truncated && !exhausted) {
    let page;
    try {
      page = await listHistory(accessToken, { startHistoryId, pageToken });
    } catch (err) {
      if (err instanceof GmailApiError && err.code === "history_gone") {
        // The cursor is older than Gmail's ~1 week history retention. Retrying
        // would fail forever, so re-seed at the mailbox's current position and
        // log the gap loudly — mail in that window is not recoverable here.
        const seeded = await seedCursor(db, account.id, accessToken);
        console.warn(
          `Gmail history expired for ${account.emailAddress}: cursor ${startHistoryId} is gone, re-seeded at ${seeded}. Messages in the gap were not synced.`,
        );
        return { ingested, skipped, reseeded: true };
      }
      throw err;
    }

    if (page.historyId) latestHistoryId = page.historyId;

    for (const messageId of page.addedMessageIds) {
      if (ingested + skipped >= MAX_MESSAGES_PER_RUN) {
        truncated = true;
        break;
      }

      const message = await getMessage(accessToken, messageId);
      // Deleted between the history page and this fetch. Ordinary, not a
      // failure — Gmail history is a log of what happened, not of what still
      // exists.
      if (!message) {
        skipped++;
        continue;
      }

      if (message.labelIds.some((label) => SKIP_LABELS.has(label))) {
        skipped++;
        continue;
      }

      if (!inbox) {
        skipped++;
        continue;
      }

      // Provisional envelope: the raw bytes carry the real addresses, and
      // `parsed.to` is what decides the destination, so it is overwritten
      // with the resolved inbox immediately below.
      const parsed = await parseRaw(message.raw, {
        from: account.emailAddress,
        to: account.emailAddress,
      });
      parsed.to = inbox;

      await ingestParsedEmail(db, parsed, env, ctx);
      ingested++;

      // `gmailMessageId` / `gmailThreadId` are not ParsedEmail fields, so they
      // are written back by matching the UNIQUE `emails.message_id`.
      //
      // `isNull(emails.gmailMessageId)` is load-bearing. `ingestParsedEmail`
      // silently DROPS blocked senders and duplicate Message-IDs, and returns
      // void either way. Without the guard, a message dropped as a duplicate
      // of one Cloudflare already delivered would stamp Gmail ids onto that
      // pre-existing row — a row this sync never created.
      //
      // With no Message-ID there is no row we can identify as ours, so we
      // write nothing rather than guess.
      if (parsed.messageId) {
        await db
          .update(emails)
          .set({
            gmailMessageId: messageId,
            gmailThreadId: message.threadId || null,
          })
          .where(
            and(
              eq(emails.messageId, parsed.messageId),
              isNull(emails.gmailMessageId),
            ),
          );
      }
    }

    if (truncated) break;
    if (page.nextPageToken) {
      pageToken = page.nextPageToken;
    } else {
      exhausted = true;
    }
  }

  const now = nowSeconds();
  const patch: Partial<typeof gmailAccounts.$inferInsert> = {
    lastSyncedAt: now,
    lastError: null,
    updatedAt: now,
  };

  // The cursor advances only once the whole history range has been processed.
  // A mid-run failure (or a truncated run) therefore retries from the same
  // point next tick instead of skipping mail — re-delivery is deduplicated by
  // Message-ID inside `ingestParsedEmail`, whereas skipped mail is lost.
  if (exhausted && latestHistoryId) {
    patch.historyId = latestHistoryId;
  } else if (truncated) {
    console.warn(
      `Gmail sync for ${account.emailAddress} hit the ${MAX_MESSAGES_PER_RUN}-message cap; cursor ${startHistoryId} held for the next run.`,
    );
  }

  await db
    .update(gmailAccounts)
    .set(patch)
    .where(eq(gmailAccounts.id, account.id));

  return { ingested, skipped, reseeded: false };
}

/**
 * Cron entry point. Isolates each account: one failing mailbox must never
 * stop the others, so every account runs under Promise.allSettled and its
 * rejection is logged rather than propagated.
 */
export async function syncAllGmailAccounts(
  db: DrizzleD1Database<typeof schema>,
  env: CloudflareBindings,
  ctx: ExecutionContext,
): Promise<void> {
  const gmailEnv = env as CloudflareBindings & {
    GOOGLE_OAUTH_CLIENT_ID?: string;
    GOOGLE_OAUTH_CLIENT_SECRET?: string;
    TOKEN_ENCRYPTION_KEY?: string;
  };
  const clientId = gmailEnv.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = gmailEnv.GOOGLE_OAUTH_CLIENT_SECRET;
  const encryptionKey = gmailEnv.TOKEN_ENCRYPTION_KEY;

  // Gmail sync is optional. An instance that never configured it must not log
  // an error on every cron tick.
  if (!clientId || !clientSecret || !encryptionKey) return;

  const cfg: GmailAuthConfig = { clientId, clientSecret, encryptionKey };
  const accounts = await db.select().from(gmailAccounts);
  if (accounts.length === 0) return;

  const results = await Promise.allSettled(
    accounts.map((account) => syncAccount(db, account, env, ctx, cfg)),
  );

  results.forEach((result, i) => {
    if (result.status === "rejected") {
      console.error(
        `Gmail sync failed for ${accounts[i].emailAddress}:`,
        result.reason,
      );
    }
  });
}
