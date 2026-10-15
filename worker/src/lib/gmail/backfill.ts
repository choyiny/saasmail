import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "../../db/schema";
import { gmailAccounts } from "../../db/gmail-accounts.schema";
import { listMessages } from "./api";
import { MESSAGE_FAILED_PREFIX } from "./error-codes";
import type { GmailAccountRow, HandleMessage } from "./sync";

/** How far back the import reaches: one year. */
export const BACKFILL_WINDOW_SECONDS = 365 * 24 * 60 * 60;

/**
 * Fixed, because a resume point is (page token, offset into that page), and
 * an offset only means the same thing if the page is the same size each time.
 */
export const BACKFILL_PAGE_SIZE = 100;

/**
 * Import the mailbox's last year, a budget's worth per call.
 *
 * Connecting a mailbox only syncs mail from that moment on (the history cursor
 * starts at the head), which leaves every existing conversation without its
 * past. This walks `messages.list` over a fixed window and feeds each message
 * through the same handler as live mail, in its historical mode: stored read,
 * at its own time, with no notifications, webhooks, forwards or sequence
 * cancellations.
 *
 * THE WINDOW IS PINNED on the first run (`backfillUntil`, `backfillSince`), so
 * pages stay stable across ticks: new mail falls outside `before:` and cannot
 * shift them. Gmail lists newest first, so the recent months land first and
 * the history fills in backwards from there. Mail
 * at or after that instant belongs to the history sync. Where the two overlap
 * — the seconds between seeding the cursor and starting the import — the
 * per-inbox dedupe makes the second sighting a no-op.
 *
 * Best effort, and honest about it: a message deleted from the window while
 * the import is mid-way shifts later pages by one, which can skip a message
 * or offer one twice. Twice is a no-op; a skip costs one old message from a
 * one-off import, which is not worth a heavier resume scheme.
 *
 * A message that throws stops the import AT that message, records
 * `message_failed:<id>` on the account like the history sync does, and the
 * next run retries it — the same stall-rather-than-drop rule.
 *
 * Throws on a Gmail API failure listing pages; the caller's per-account
 * boundary records it.
 */
export async function backfillAccount(
  db: DrizzleD1Database<typeof schema>,
  account: GmailAccountRow,
  accessToken: string,
  budget: number,
  handle: HandleMessage,
): Promise<{ handled: number; failed: number; done: boolean }> {
  const now = Math.floor(Date.now() / 1000);
  const until = account.backfillUntil ?? now;
  const since = account.backfillSince ?? until - BACKFILL_WINDOW_SECONDS;
  const q = `after:${since} before:${until}`;

  let pageToken = account.backfillPageToken;
  let offset = account.backfillOffset;
  let handled = 0;
  // The oldest message reached so far. Messages come newest first, so this is
  // how far back into the window the import has got — the progress the UI
  // shows, since Gmail offers no reliable total to count against.
  let reached = account.backfillReached;

  /** Persist the resume point, and how far along the import is. */
  const save = async (patch: Partial<typeof gmailAccounts.$inferInsert>) => {
    await db
      .update(gmailAccounts)
      .set({
        backfillUntil: until,
        backfillSince: since,
        backfillPageToken: pageToken,
        backfillOffset: offset,
        backfillCount: account.backfillCount + handled,
        backfillReached: reached,
        updatedAt: Math.floor(Date.now() / 1000),
        ...patch,
      })
      .where(eq(gmailAccounts.id, account.id));
  };

  for (;;) {
    const page = await listMessages(accessToken, {
      q,
      pageToken,
      maxResults: BACKFILL_PAGE_SIZE,
    });

    while (offset < page.ids.length) {
      if (handled >= budget) {
        await save({});
        return { handled, failed: 0, done: false };
      }
      const messageId = page.ids[offset];
      try {
        const { at } = await handle(messageId, true);
        if (at != null && (reached === null || at < reached)) reached = at;
      } catch (err) {
        // The message only, never the error object: a D1 error carries its
        // bound query parameters, which on this path include the access token.
        const reason = err instanceof Error ? err.message : "unknown error";
        console.error(
          `Gmail backfill failed on message ${messageId} for ${account.emailAddress}: ${reason}`,
        );
        await save({ lastError: `${MESSAGE_FAILED_PREFIX}${messageId}` });
        return { handled, failed: 1, done: false };
      }
      handled++;
      offset++;
    }

    if (!page.nextPageToken) {
      await save({ backfillCompletedAt: Math.floor(Date.now() / 1000) });
      console.log(
        `Gmail backfill for ${account.emailAddress} finished: ${account.backfillCount + handled} messages from the last year.`,
      );
      return { handled, failed: 0, done: true };
    }
    pageToken = page.nextPageToken;
    offset = 0;
  }
}
