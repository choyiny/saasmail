import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "../../db/schema";
import { outlookAccounts } from "../../db/outlook-accounts.schema";
import { senderIdentities } from "../../db/sender-identities.schema";
import { emails } from "../../db/emails.schema";
import { parseRaw } from "../email-parser";
import { fetchInternalDomains } from "../internal-domains";
import { ingestParsedEmail } from "../../email-handler";
import {
  MESSAGE_FAILED_PREFIX,
  NO_PERSONAL_INBOX_ERROR,
  SYNC_FAILED_PREFIX,
} from "../gmail/error-codes";
import {
  headerAddresses,
  mirrorSentMessage,
  MAX_MESSAGES_PER_RUN,
  type BackfillChunkResult,
  type MessageOutcome,
  type SyncResult,
} from "../gmail/sync";
import { resolveInboundInboxes, resolveSentInbox } from "../gmail/route-inbox";
import {
  deltaPage,
  getMime,
  GraphApiError,
  initialDeltaUrl,
  type SyncFolder,
} from "./api";
import { MicrosoftAuthError } from "./oauth";
import {
  getOutlookAccessToken,
  outlookAuthConfig,
  type OutlookAuthConfig,
} from "./token";
import { backfillOutlookAccount } from "./backfill";

/**
 * The Outlook mail sync: the same engine as Gmail's (`lib/gmail/sync.ts`) on
 * Microsoft Graph instead of the Gmail API.
 *
 * Live mail comes from a Graph delta round over two folders — Inbox
 * (inbound) and Sent Items (mirrored onto timelines as `sent_emails`) — with
 * a resume point per folder: the page URL plus how much of it was handled,
 * so the 50-message budget can stop mid-page and pick up exactly there. A
 * first sync starts at the connection time, so only new mail comes in; the
 * one-year import fetches the past separately.
 *
 * Mail only filed elsewhere — rules that skip the Inbox, Archive — is not
 * seen live; the import covers every folder but Junk, Deleted and Drafts.
 */

export type OutlookAccountRow = typeof outlookAccounts.$inferSelect;

/** Where a message goes: onto a timeline as inbound, or mirrored as sent. */
export type OutlookMessageKind = "inbound" | "sent";

/** Handle one Graph message. Throws on anything genuinely wrong. */
export type HandleOutlookMessage = (
  messageId: string,
  kind: OutlookMessageKind,
  historical: boolean,
  receivedAt: number | null,
) => Promise<MessageOutcome>;

const SKIPPED: MessageOutcome = { ingested: 0, mirrored: 0, skipped: 1 };

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The inboxes mapped to this mailbox, lowercased. */
async function mappedInboxes(
  db: DrizzleD1Database<typeof schema>,
  accountId: string,
): Promise<string[]> {
  const rows = await db
    .select({ email: senderIdentities.email })
    .from(senderIdentities)
    .where(
      and(
        eq(senderIdentities.outlookAccountId, accountId),
        eq(senderIdentities.source, "outlook"),
      ),
    );
  return [...new Set(rows.map((r) => r.email.trim().toLowerCase()))];
}

async function processOutlookMessage(
  mc: {
    db: DrizzleD1Database<typeof schema>;
    env: CloudflareBindings;
    ctx: ExecutionContext;
    accessToken: string;
    account: OutlookAccountRow;
    inboxes: string[];
    getInternalDomains: () => Promise<string[]>;
  },
  messageId: string,
  kind: OutlookMessageKind,
  historical: boolean,
  receivedAtHint: number | null,
): Promise<MessageOutcome> {
  const { db, env, ctx, account, inboxes } = mc;

  const raw = await getMime(mc.accessToken, messageId);
  // Deleted between the listing and this fetch: ordinary, not a failure.
  if (!raw) return SKIPPED;
  const at = receivedAtHint;

  const parsed = await parseRaw(raw, {
    from: account.emailAddress,
    to: account.emailAddress,
  });

  if (kind === "sent") {
    const inbox = resolveSentInbox(
      inboxes,
      account.emailAddress,
      parsed.from.address,
    );
    if (!inbox) {
      console.log(
        `Outlook sync for ${account.emailAddress}: sent message ${messageId} is from ${parsed.from.address}, which no inbox here is mapped to; not mirrored.`,
      );
      return { ...SKIPPED, at };
    }
    const didMirror = await mirrorSentMessage(db, {
      ids: { provider: "outlook", messageId },
      parsed,
      inbox,
      internalDomains: await mc.getInternalDomains(),
      historical,
    });
    return didMirror
      ? { ingested: 0, mirrored: 1, skipped: 0, at }
      : { ...SKIPPED, at };
  }

  const targets = resolveInboundInboxes(inboxes, account.emailAddress, [
    ...headerAddresses(parsed.recipientHeaders.to),
    ...headerAddresses(parsed.recipientHeaders.cc),
  ]);
  if (targets.length === 0) {
    console.log(
      `Outlook sync for ${account.emailAddress}: message ${messageId} names none of its mapped inboxes (${inboxes.join(", ")}) and the account's own address is not mapped; skipped.`,
    );
    return { ...SKIPPED, at };
  }

  const receivedAt = at ?? nowSeconds();
  let stored = 0;
  for (const inbox of targets) {
    // The live sync, the import and a re-seeded delta round can all reach the
    // same message. Graph's immutable id is per mailbox, and an inbox
    // belongs to one mailbox, so it is a dedupe key that also covers mail
    // with no Message-ID.
    const already = await db
      .select({ id: emails.id })
      .from(emails)
      .where(
        and(
          eq(emails.outlookMessageId, messageId),
          eq(emails.recipient, inbox),
        ),
      )
      .limit(1);
    if (already.length > 0) continue;

    parsed.to = inbox;
    const outcome = await ingestParsedEmail(
      db,
      parsed,
      env,
      ctx,
      historical ? { historical: { receivedAt } } : {},
    );
    if (outcome.status !== "stored") continue;
    stored++;
    // Written back by primary key, for the reason given in Gmail's sync.
    await db
      .update(emails)
      .set({ outlookMessageId: messageId })
      .where(eq(emails.id, outcome.emailId));
  }
  return stored > 0
    ? { ingested: 1, mirrored: 0, skipped: 0, at }
    : { ...SKIPPED, at };
}

/**
 * A live token, the mapped inboxes and the message handler — or null when no
 * inbox is mapped, after recording that. Throws when no token can be had.
 */
export async function prepareOutlookAccount(
  db: DrizzleD1Database<typeof schema>,
  account: OutlookAccountRow,
  env: CloudflareBindings,
  ctx: ExecutionContext,
  cfg: OutlookAuthConfig,
): Promise<{ accessToken: string; handle: HandleOutlookMessage } | null> {
  const accessToken = await getOutlookAccessToken(db, account.id, cfg);
  const inboxes = await mappedInboxes(db, account.id);

  // Stall rather than drop, exactly as Gmail does: consuming the delta round
  // with nowhere to file it would lose that mail for good.
  if (inboxes.length === 0) {
    console.error(
      `Outlook sync for ${account.emailAddress}: ${NO_PERSONAL_INBOX_ERROR}. Not reading mail until an inbox is mapped.`,
    );
    await db
      .update(outlookAccounts)
      .set({ lastError: NO_PERSONAL_INBOX_ERROR, updatedAt: nowSeconds() })
      .where(eq(outlookAccounts.id, account.id));
    return null;
  }

  let internalDomains: string[] | null = null;
  const getInternalDomains = async () => {
    if (internalDomains === null)
      internalDomains = await fetchInternalDomains(db);
    return internalDomains;
  };
  const handle: HandleOutlookMessage = (id, kind, historical, receivedAt) =>
    processOutlookMessage(
      { db, env, ctx, accessToken, account, inboxes, getInternalDomains },
      id,
      kind,
      historical,
      receivedAt,
    );
  return { accessToken, handle };
}

type FolderState = { cursor: string | null; offset: number };

const FOLDER_COLUMNS = {
  inbox: { cursor: "inboxCursor", offset: "inboxCursorOffset" },
  sentitems: { cursor: "sentCursor", offset: "sentCursorOffset" },
} as const;

/**
 * Walk one folder's delta round from its saved place, handling at most
 * `budget` messages. Saves the place after every page and on stopping.
 *
 * A delta link Graph has expired is re-seeded from the last successful sync
 * (or the connection), not from now: Graph can filter a fresh round by
 * received time, so unlike Gmail's history an expired Outlook cursor loses
 * nothing — what it re-reads is deduped.
 */
async function syncFolder(
  db: DrizzleD1Database<typeof schema>,
  account: OutlookAccountRow,
  accessToken: string,
  folder: SyncFolder,
  budget: number,
  handle: HandleOutlookMessage,
): Promise<{ handled: number; counts: MessageOutcome; failed: boolean }> {
  const cols = FOLDER_COLUMNS[folder];
  const state: FolderState = {
    cursor: account[cols.cursor],
    offset: account[cols.offset],
  };
  const reseedFrom = () =>
    Math.max(0, (account.lastSyncedAt ?? account.syncFrom) - 300);
  let url = state.cursor ?? initialDeltaUrl(folder, account.syncFrom);
  let offset = state.offset;
  let handled = 0;
  const counts: MessageOutcome = { ingested: 0, mirrored: 0, skipped: 0 };
  let reseeded = false;

  const save = async (
    patch: Partial<typeof outlookAccounts.$inferInsert> = {},
  ) => {
    await db
      .update(outlookAccounts)
      .set({
        [cols.cursor]: url,
        [cols.offset]: offset,
        updatedAt: nowSeconds(),
        ...patch,
      })
      .where(eq(outlookAccounts.id, account.id));
  };

  for (;;) {
    let page;
    try {
      page = await deltaPage(accessToken, url);
    } catch (err) {
      if (
        err instanceof GraphApiError &&
        err.code === "sync_state_gone" &&
        !reseeded
      ) {
        console.warn(
          `Outlook sync for ${account.emailAddress}: the ${folder} delta link expired; re-reading from the last sync.`,
        );
        reseeded = true;
        url = initialDeltaUrl(folder, reseedFrom());
        offset = 0;
        continue;
      }
      throw err;
    }

    while (offset < page.items.length) {
      if (handled >= budget) {
        await save();
        return { handled, counts, failed: false };
      }
      const item = page.items[offset];
      if (!item.removed && !item.isDraft) {
        try {
          const outcome = await handle(
            item.id,
            folder === "sentitems" ? "sent" : "inbound",
            false,
            item.receivedAt,
          );
          counts.ingested += outcome.ingested;
          counts.mirrored += outcome.mirrored;
          counts.skipped += outcome.skipped;
        } catch (err) {
          const reason = err instanceof Error ? err.message : "unknown error";
          console.error(
            `Outlook sync failed on message ${item.id} for ${account.emailAddress}: ${reason}`,
          );
          await save({ lastError: `${MESSAGE_FAILED_PREFIX}${item.id}` });
          return { handled, counts, failed: true };
        }
        handled++;
      }
      offset++;
    }

    if (page.nextLink) {
      url = page.nextLink;
      offset = 0;
      await save();
      continue;
    }
    url = page.deltaLink!;
    offset = 0;
    await save();
    return { handled, counts, failed: false };
  }
}

/** Whether this deployment binds the import Workflow. */
function hasImportJob(env: CloudflareBindings): boolean {
  return Boolean(env.GMAIL_BACKFILL);
}

/**
 * Poll one connected Outlook mailbox: Inbox, then Sent Items, sharing the
 * per-run budget. Where the import Workflow is not bound, the one-year
 * import runs here in what is left, on the mailbox whose turn it is.
 *
 * Throws on an unrecoverable per-account failure; see `syncAllOutlookAccounts`.
 */
export async function syncOutlookAccount(
  db: DrizzleD1Database<typeof schema>,
  account: OutlookAccountRow,
  env: CloudflareBindings,
  ctx: ExecutionContext,
  cfg: OutlookAuthConfig,
  opts: { importTurn?: boolean } = {},
): Promise<SyncResult> {
  const result: SyncResult = {
    ingested: 0,
    mirrored: 0,
    skipped: 0,
    reseeded: false,
    failed: 0,
    backfilled: 0,
  };
  const prepared = await prepareOutlookAccount(db, account, env, ctx, cfg);
  if (!prepared) return result;
  const { accessToken, handle } = prepared;

  let budget = MAX_MESSAGES_PER_RUN;
  for (const folder of ["inbox", "sentitems"] as const) {
    const r = await syncFolder(
      db,
      account,
      accessToken,
      folder,
      budget,
      handle,
    );
    budget -= r.handled;
    result.ingested += r.counts.ingested;
    result.mirrored += r.counts.mirrored;
    result.skipped += r.counts.skipped;
    if (r.failed) {
      result.failed = 1;
      return result;
    }
  }

  await db
    .update(outlookAccounts)
    .set({
      lastSyncedAt: nowSeconds(),
      lastError: null,
      updatedAt: nowSeconds(),
    })
    .where(eq(outlookAccounts.id, account.id));

  if (
    !hasImportJob(env) &&
    (opts.importTurn ?? true) &&
    account.backfillCompletedAt === null &&
    budget > 0
  ) {
    const fresh = (
      await db
        .select()
        .from(outlookAccounts)
        .where(eq(outlookAccounts.id, account.id))
    )[0];
    if (fresh) {
      const backfill = await backfillOutlookAccount(
        db,
        fresh,
        accessToken,
        budget,
        handle,
      );
      result.backfilled = backfill.handled;
      result.failed += backfill.failed;
    }
  }
  return result;
}

/** A failure code for the row, like Gmail's `syncFailureCode`. */
function failureCode(err: unknown): string {
  if (err instanceof MicrosoftAuthError) return err.code;
  if (err instanceof GraphApiError) return `${SYNC_FAILED_PREFIX}${err.code}`;
  return `${SYNC_FAILED_PREFIX}unknown`;
}

/**
 * Sync every connected Outlook mailbox, each isolated from the others. A
 * no-op until Microsoft is set up under Inboxes. Without the import job, the
 * inline import goes to one mailbox per tick across BOTH providers — the
 * caller passes whether Gmail already took it.
 */
export async function syncAllOutlookAccounts(
  db: DrizzleD1Database<typeof schema>,
  env: CloudflareBindings,
  ctx: ExecutionContext,
  opts: { importTaken?: boolean } = {},
): Promise<void> {
  const cfg = await outlookAuthConfig(db, env);
  if (!cfg) return;
  const accounts = await db.select().from(outlookAccounts);
  if (accounts.length === 0) return;

  const importTurn = opts.importTaken
    ? undefined
    : accounts
        .filter((a) => a.backfillCompletedAt === null)
        .sort(
          (a, b) =>
            Number(a.lastError !== null) - Number(b.lastError !== null) ||
            a.createdAt - b.createdAt,
        )[0]?.id;

  const results = await Promise.allSettled(
    accounts.map((account) =>
      syncOutlookAccount(db, account, env, ctx, cfg, {
        importTurn: account.id === importTurn,
      }),
    ),
  );
  for (const [i, r] of results.entries()) {
    if (r.status === "fulfilled") {
      if (r.value.failed > 0) {
        console.error(
          `Outlook sync failed to ingest ${r.value.failed} message(s) for ${accounts[i].emailAddress}`,
        );
      }
      continue;
    }
    // The message only: D1 errors carry bound parameters, tokens included.
    const reason =
      r.reason instanceof Error ? r.reason.message : "unknown error";
    console.error(
      `Outlook sync failed for ${accounts[i].emailAddress}: ${reason}`,
    );
    try {
      await db
        .update(outlookAccounts)
        .set({ lastError: failureCode(r.reason), updatedAt: nowSeconds() })
        .where(eq(outlookAccounts.id, accounts[i].id));
    } catch {
      // Already failing; do not stop the others being reported.
    }
  }
}

/**
 * One unit of the import job for an Outlook mailbox — the counterpart of
 * Gmail's `runBackfillChunk`, with the same ownership and stop rules.
 */
export async function runOutlookBackfillChunk(
  db: DrizzleD1Database<typeof schema>,
  env: CloudflareBindings,
  ctx: ExecutionContext,
  cfg: OutlookAuthConfig,
  accountId: string,
  jobId: string,
  budget: number,
): Promise<BackfillChunkResult> {
  const [account] = await db
    .select()
    .from(outlookAccounts)
    .where(eq(outlookAccounts.id, accountId));
  if (!account) return { status: "stopped", handled: 0, reason: "gone" };
  if (account.backfillJobId !== jobId) {
    return { status: "stopped", handled: 0, reason: "superseded" };
  }
  if (account.backfillCompletedAt !== null) {
    return { status: "stopped", handled: 0, reason: "complete" };
  }
  const prepared = await prepareOutlookAccount(db, account, env, ctx, cfg);
  if (!prepared) return { status: "stopped", handled: 0, reason: "no_inbox" };

  const { handled, failed, done } = await backfillOutlookAccount(
    db,
    account,
    prepared.accessToken,
    budget,
    prepared.handle,
  );
  if (failed > 0) return { status: "stopped", handled, reason: "failed" };
  return { status: done ? "done" : "continue", handled };
}
