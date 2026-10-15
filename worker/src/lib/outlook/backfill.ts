import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "../../db/schema";
import { outlookAccounts } from "../../db/outlook-accounts.schema";
import { MESSAGE_FAILED_PREFIX } from "../gmail/error-codes";
import { BACKFILL_WINDOW_SECONDS } from "../gmail/backfill";
import {
  backfillListUrl,
  listPage,
  wellKnownFolderIds,
  type ListedMessage,
  type FolderIds,
} from "./api";
import type {
  HandleOutlookMessage,
  OutlookAccountRow,
  OutlookMessageKind,
} from "./sync";

/**
 * The Outlook mailbox's last year, a budget's worth per call — the Graph
 * counterpart of `lib/gmail/backfill.ts`, with the same rules: a window
 * pinned on the first run, newest first, quiet (historical) ingestion, the
 * oldest date reached kept as progress, and a message that throws stopping
 * the import at that message for the next run to retry.
 *
 * It lists `/me/messages`, which spans every folder, so each message's
 * folder decides what it is: Sent Items is mirrored as sent mail, Junk,
 * Deleted Items and Drafts are skipped, and anything else — Inbox, Archive,
 * user folders — is inbound.
 *
 * The resume point is Graph's `@odata.nextLink` for the page plus an offset
 * into it, like Gmail's page token.
 */

function kindOf(
  item: ListedMessage,
  folders: FolderIds,
): OutlookMessageKind | null {
  if (item.isDraft) return null;
  switch (item.parentFolderId) {
    case folders.sentitems:
      return "sent";
    case folders.junkemail:
    case folders.deleteditems:
    case folders.drafts:
      return null;
    default:
      return "inbound";
  }
}

export async function backfillOutlookAccount(
  db: DrizzleD1Database<typeof schema>,
  account: OutlookAccountRow,
  accessToken: string,
  budget: number,
  handle: HandleOutlookMessage,
): Promise<{ handled: number; failed: number; done: boolean }> {
  const now = Math.floor(Date.now() / 1000);
  const until = account.backfillUntil ?? now;
  const since = account.backfillSince ?? until - BACKFILL_WINDOW_SECONDS;

  let link = account.backfillLink ?? backfillListUrl(since, until);
  let offset = account.backfillOffset;
  let handled = 0;
  let reached = account.backfillReached;

  const save = async (patch: Partial<typeof outlookAccounts.$inferInsert>) => {
    await db
      .update(outlookAccounts)
      .set({
        backfillUntil: until,
        backfillSince: since,
        backfillLink: link,
        backfillOffset: offset,
        backfillCount: account.backfillCount + handled,
        backfillReached: reached,
        updatedAt: Math.floor(Date.now() / 1000),
        ...patch,
      })
      .where(eq(outlookAccounts.id, account.id));
  };

  const folders = await wellKnownFolderIds(accessToken);

  for (;;) {
    const page = await listPage(accessToken, link);

    while (offset < page.items.length) {
      if (handled >= budget) {
        await save({});
        return { handled, failed: 0, done: false };
      }
      const item = page.items[offset];
      const kind = kindOf(item, folders);
      if (kind) {
        try {
          await handle(item.id, kind, true, item.receivedAt);
        } catch (err) {
          const reason = err instanceof Error ? err.message : "unknown error";
          console.error(
            `Outlook backfill failed on message ${item.id} for ${account.emailAddress}: ${reason}`,
          );
          await save({ lastError: `${MESSAGE_FAILED_PREFIX}${item.id}` });
          return { handled, failed: 1, done: false };
        }
      }
      // Skipped folders still move the bar: they are part of the window.
      if (
        item.receivedAt != null &&
        (reached === null || item.receivedAt < reached)
      ) {
        reached = item.receivedAt;
      }
      handled++;
      offset++;
    }

    if (!page.nextLink) {
      await save({ backfillCompletedAt: Math.floor(Date.now() / 1000) });
      console.log(
        `Outlook backfill for ${account.emailAddress} finished: ${account.backfillCount + handled} messages from the last year.`,
      );
      return { handled, failed: 0, done: true };
    }
    link = page.nextLink;
    offset = 0;
  }
}
