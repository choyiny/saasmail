import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { schema } from "../../db/schema";
import { gmailAccounts } from "../../db/gmail-accounts.schema";
import { senderIdentities } from "../../db/sender-identities.schema";
import { emails } from "../../db/emails.schema";
import { people } from "../../db/people.schema";
import { sentEmails } from "../../db/sent-emails.schema";
import { parseRaw } from "../email-parser";
import { computeConversationId, externalsOnly } from "../conversation-id";
import { ingestParsedEmail } from "../../email-handler";
import { getAccessToken, type GmailAuthConfig } from "./token";
import { getProfile, GoogleAuthError } from "./oauth";
import {
  listHistory,
  getMessage,
  GmailApiError,
  type AddedMessage,
} from "./api";
import { resolvePersonalInbox } from "./route-inbox";
import {
  AMBIGUOUS_INBOX_MAPPING_ERROR,
  HISTORY_GAP_ERROR,
  MESSAGE_FAILED_PREFIX,
  NO_PERSONAL_INBOX_ERROR,
  SYNC_FAILED_PREFIX,
} from "./error-codes";

// The `lastError` vocabulary lives in `./error-codes` so the admin UI can
// import the same strings instead of re-declaring them. Re-exported here
// because this is where callers expect to find it.
export { HISTORY_GAP_ERROR, SYNC_FAILED_PREFIX };

/**
 * Bounded so one account cannot exhaust the Worker CPU budget. The cursor
 * makes the remainder resumable on the next tick, so a large backlog drains
 * across runs instead of failing one enormous run.
 */
export const MAX_MESSAGES_PER_RUN = 50;

/**
 * Never reaches a customer timeline, whatever else the message carries.
 *
 * Checked BEFORE the SENT branch on purpose: a sent message that was later
 * trashed carries both SENT and TRASH, and the skip must win.
 */
const SKIP_LABELS = new Set(["DRAFT", "TRASH", "SPAM"]);

/**
 * Gmail's label for the mailbox's own outgoing mail. These are mirrored into
 * `sent_emails` rather than ingested as inbound, so a reply someone typed in
 * Gmail lands on the customer's timeline next to everything else.
 */
const SENT_LABEL = "SENT";

export type GmailAccountRow = typeof gmailAccounts.$inferSelect;

/** One Gmail history record: the messages it added, under its own id. */
type HistoryRecord = { historyId: string; messageIds: string[] };

/**
 * Regroup the flat added-message list back into its history records.
 *
 * A record's entries are contiguous in the list, so grouping consecutive
 * equal `historyId`s reconstructs the record boundaries exactly. We need
 * those boundaries because the cursor may only ever advance to a record we
 * processed IN FULL — see the truncation rule in `syncAccount`.
 */
function groupIntoRecords(added: AddedMessage[]): HistoryRecord[] {
  const records: HistoryRecord[] = [];
  for (const item of added) {
    const current = records[records.length - 1];
    if (current && current.historyId === item.historyId) {
      current.messageIds.push(item.messageId);
    } else {
      records.push({ historyId: item.historyId, messageIds: [item.messageId] });
    }
  }
  return records;
}

export type SyncResult = {
  ingested: number;
  skipped: number;
  reseeded: boolean;
  /** Messages that threw. At most one — a failure stops the run. */
  failed: number;
};

/**
 * A short, stable code for a sync that rejected — and never the error's own
 * message.
 *
 * `lastError` is returned by `GET /api/admin/gmail` and rendered in the admin
 * UI, so what goes in it has to be safe to show. An error message is not: a
 * D1 failure carries its bound query parameters, which on this path include
 * the access token. Gmail's classification (`http_500`, `rate_limited`) and
 * Google's auth codes (`invalid_grant`, `profile_request_failed`) are built
 * in this repo from a status line and carry nothing else, so they can be
 * shown verbatim. Anything else becomes `unknown`, and its message goes to
 * the log only.
 *
 * A Google auth code is recorded bare, without the prefix: `getAccessToken`
 * already writes that same value before rethrowing, and Reconnect is the
 * right offer for it.
 */
function syncFailureCode(err: unknown): string {
  if (err instanceof GoogleAuthError) return err.code;
  if (err instanceof GmailApiError) return `${SYNC_FAILED_PREFIX}${err.code}`;
  return `${SYNC_FAILED_PREFIX}unknown`;
}

/**
 * Mark an account as failing, so the failure is visible somewhere other than
 * cron output.
 *
 * `lastSyncedAt` is deliberately left where it was — nothing synced — and so
 * is `historyId`, so the next run resumes from the same cursor.
 */
async function recordSyncFailure(
  db: DrizzleD1Database<typeof schema>,
  accountId: string,
  code: string,
): Promise<void> {
  try {
    await db
      .update(gmailAccounts)
      .set({ lastError: code, updatedAt: nowSeconds() })
      .where(eq(gmailAccounts.id, accountId));
  } catch (err) {
    // This account's sync has already failed; failing to write the marker
    // must not also stop the remaining accounts being reported.
    const reason = err instanceof Error ? err.message : "unknown error";
    console.error(
      `Gmail sync could not record the failure for account ${accountId}: ${reason}`,
    );
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Header lookup that tolerates either casing, like the parser's own. */
function header(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  return (
    headers[name] ??
    headers[name.replace(/(^|-)([a-z])/g, (_, s, c) => s + c.toUpperCase())]
  );
}

/**
 * The FIRST entry of a comma-separated address list, as written.
 *
 * Split before extracting anything, and never across the whole header: a
 * pattern matched against the entire string finds the LAST-written address
 * as readily as the first, so `jane@example.com, "Bob" <bob@x.com>` would
 * yield Bob — filing a reply on the wrong customer's timeline.
 *
 * The scan ignores commas inside a quoted display name (`"Smith, Jane"`) and
 * inside a bracketed address, because neither separates list entries.
 */
function firstListEntry(raw: string): string | null {
  let inQuotes = false;
  let inAngles = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inQuotes && c === "\\") {
      i++; // escaped character inside a quoted string, never a delimiter
      continue;
    }
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && c === "<") inAngles = true;
    else if (!inQuotes && c === ">") inAngles = false;
    else if (c === "," && !inQuotes && !inAngles) return raw.slice(0, i);
  }
  // Ending mid-quote or mid-bracket means the header is malformed, and a
  // malformed list has no identifiable first entry. Returning the WHOLE
  // header here would be the wrong-customer bug all over again: one stray
  // quote suppresses every delimiter, and the extraction below would then
  // pick up whatever bracketed address appears LAST. Refuse instead.
  return inQuotes || inAngles ? null : raw;
}

/**
 * The entry with its quoted display names removed.
 *
 * A display name may legally contain anything, including a complete
 * address in brackets, so the search for the real address has to ignore it:
 * `"Bob <bob@x.com>" <jane@example.com>` is a message to JANE.
 *
 * Only ever called on an entry `firstListEntry` already accepted, so the
 * quoting is known to be balanced.
 */
function withoutQuotedText(entry: string): string {
  let out = "";
  let inQuotes = false;
  for (let i = 0; i < entry.length; i++) {
    const c = entry[i];
    if (inQuotes && c === "\\") {
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes) out += c;
  }
  return out;
}

/**
 * Is this a plain addr-spec we are willing to file a customer's mail under?
 *
 * Deliberately strict, and applied AFTER extraction: the extractor's job is
 * to find the candidate, this one's is to refuse anything that is not
 * actually an address. `<jane,x@example.com>` extracts cleanly and is still
 * not an address. Prefer null over a guess — a skipped mirror costs one row,
 * a wrong one puts a customer's reply on someone else's timeline.
 */
function isAddrSpec(address: string): boolean {
  // RFC 5321's 254-octet ceiling; also stops a pathological header early.
  if (address.length === 0 || address.length > 254) return false;
  // No whitespace, and none of RFC 5322's specials: comma, quote, angle
  // brackets, parens, colon, semicolon, backslash, square brackets.
  if (/[\s",<>();:\\[\]]/.test(address)) return false;
  const at = address.indexOf("@");
  if (at === -1 || at !== address.lastIndexOf("@")) return false;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!local || !domain) return false;
  // A dot in the domain, and not a leading, trailing or doubled one.
  if (!domain.includes(".")) return false;
  if (domain.startsWith(".") || domain.endsWith(".")) return false;
  if (domain.includes("..")) return false;
  return true;
}

/**
 * The first address on an address-list header, lowercased.
 *
 * Only the first matters here: a mirrored Sent message needs one counterparty
 * to hang off a timeline, and everyone else on the message is already carried
 * by the Cc column.
 *
 * Three steps, in this order, because each one is unsafe without the one
 * before it: split the list, drop the display names, then VALIDATE what is
 * left. Null whenever any step cannot answer confidently — a missing header,
 * a malformed one, or a candidate that is not an address.
 */
function firstAddress(raw: string | undefined): string | null {
  if (!raw) return null;
  const entry = firstListEntry(raw);
  if (entry === null) return null;
  const unquoted = withoutQuotedText(entry);
  const angled = unquoted.match(/<([^>]*)>/);
  const address = (angled ? angled[1] : unquoted).trim().toLowerCase();
  return isAddrSpec(address) ? address : null;
}

/**
 * A `Date:` header as unix seconds, or null when absent or unparseable.
 *
 * Worth the parse: `sentAt` decides where a mirrored reply sorts on the
 * timeline, and stamping the sync time instead would file a backlog drained
 * after an outage at the moment it was pulled — every reply sorting after the
 * mail it answers, on a feature whose whole point is a coherent timeline.
 *
 * The header is sender-controlled in general, but these are messages from the
 * mailbox's OWN Sent folder, so the writer is us. A value that is missing,
 * junk, or not a finite instant falls back to the sync time.
 */
function parseDateHeader(raw: string | undefined): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw.trim());
  if (!Number.isFinite(ms)) return null;
  const seconds = Math.floor(ms / 1000);
  return seconds > 0 ? seconds : null;
}

/**
 * Mirror one message from the mailbox's Sent folder onto the timeline.
 *
 * Returns whether a row was written. A `false` is an ordinary skip, not a
 * failure — it never stops the run. Anything genuinely wrong throws, and the
 * caller treats that exactly as it treats a failed inbound ingest.
 */
async function mirrorSentMessage(
  db: DrizzleD1Database<typeof schema>,
  opts: {
    gmailMessageId: string;
    message: { raw: ArrayBuffer; threadId: string };
    /** The saasmail inbox this account is mapped to. */
    inbox: string;
    internalDomains: string[];
  },
): Promise<boolean> {
  const { gmailMessageId, message, inbox, internalDomains } = opts;

  // ECHO SUPPRESSION. saasmail now sends replies THROUGH Gmail, and Gmail
  // files those in the same mailbox's Sent folder, so they come straight back
  // here. The send path records Gmail's returned id on the `sent_emails` row
  // (`sent_emails.gmailMessageId`), so seeing that id again means this is our
  // own send coming home. Without this check every reply a user sends would
  // appear on the timeline twice.
  //
  // It doubles as this mirror's idempotency key: a row written below stores
  // the same id, so replaying a history page re-skips the message instead of
  // inserting a second copy. (`emails` gets that for free from the UNIQUE
  // Message-ID dedupe inside `ingestParsedEmail`; `sent_emails` has no such
  // constraint, so the id is the only thing standing in for it.)
  const echo = await db
    .select({ id: sentEmails.id })
    .from(sentEmails)
    .where(eq(sentEmails.gmailMessageId, gmailMessageId))
    .limit(1);
  if (echo.length > 0) return false;

  // Provisional envelope: nothing in a Sent message's envelope is known to
  // us, and the addresses that matter are read back out of the headers below.
  const parsed = await parseRaw(message.raw, { from: inbox, to: inbox });

  // The counterparty of a SENT message is its RECIPIENT, not its sender —
  // the sender is us.
  //
  // `To:` first, then `Cc:`, then `Bcc:` — a message in the mailbox's own
  // Sent folder usually retains the Bcc it was sent with, so the chain
  // rescues a blind-copied send that would otherwise have no counterparty at
  // all. Each step reads one header and takes its first entry; they are never
  // mixed.
  const toHeader = header(parsed.headers, "to");
  const ccHeader = header(parsed.headers, "cc");
  const bccHeader = header(parsed.headers, "bcc");
  const toAddress =
    firstAddress(toHeader) ?? firstAddress(ccHeader) ?? firstAddress(bccHeader);
  if (!toAddress) {
    // There is no timeline to put it on, and `sent_emails.to_address` is NOT
    // NULL, so inventing a value would be worse than passing over it.
    //
    // The two cases read very differently to an operator: a blind-copied send
    // with no recipient headers at all is ordinary, while headers that are
    // present but unusable mean mail IS being skipped and something upstream
    // is wrong.
    const anyHeaderPresent = [toHeader, ccHeader, bccHeader].some(
      (h) => h && h.trim(),
    );
    console.warn(
      anyHeaderPresent
        ? `Gmail sync for ${inbox}: sent message ${gmailMessageId} has MALFORMED recipient headers — To:/Cc:/Bcc: are present but none yields a valid address (unbalanced quotes or brackets, or not an addr-spec). Refusing to guess a counterparty; not mirrored.`
        : `Gmail sync for ${inbox}: sent message ${gmailMessageId} has no To:, Cc: or Bcc: header at all, so it has no counterparty; not mirrored.`,
    );
    return false;
  }

  // Person matching follows the inbound path: look the person up by the
  // canonical (trimmed, lowercased) address — `firstAddress` already did
  // both — so casing variants resolve to the same row.
  //
  // Unlike the inbound path this never CREATES a person. Inbound mail is
  // proof someone exists and wants to be on the timeline; our own outgoing
  // mail is not, and `sent_emails.person_id` is nullable precisely so a row
  // can be stored without one. A message to an address we have never heard
  // from is therefore recorded, not dropped and not a failure.
  const personRow = await db
    .select({ id: people.id })
    .from(people)
    .where(eq(people.email, toAddress))
    .limit(1);

  // Same grouping the outbound send path computes, so a mirrored reply lands
  // in the same group thread as the messages it answers rather than forking
  // one of its own.
  const externals = externalsOnly(
    [toAddress, ...parsed.cc.map((c) => c.email)],
    internalDomains,
  );
  const conversationId = await computeConversationId(inbox, externals);

  const now = nowSeconds();
  // When the message was actually sent, not when we got around to pulling it.
  const sentAt = parseDateHeader(header(parsed.headers, "date")) ?? now;

  await db.insert(sentEmails).values({
    id: nanoid(),
    personId: personRow[0]?.id ?? null,
    // The mapped inbox, not the Gmail account's own address: the timeline
    // groups sent mail by `from_address`, and the inbox is what the rest of
    // the thread is filed under.
    fromAddress: inbox,
    toAddress,
    subject: parsed.subject,
    bodyHtml: parsed.bodyHtml,
    bodyText: parsed.bodyText,
    inReplyTo: header(parsed.headers, "in-reply-to") ?? null,
    messageId: parsed.messageId,
    status: "sent",
    cc: parsed.cc.length > 0 ? JSON.stringify(parsed.cc) : null,
    conversationId,
    gmailMessageId,
    gmailThreadId: message.threadId || null,
    // `sentAt` orders the timeline, so it is the message's own time.
    // `createdAt` is when this row appeared here, which is now.
    sentAt,
    createdAt: now,
  });

  return true;
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
  /**
   * True when this seed skipped mail — i.e. an expired cursor forced it. A
   * first seed skips nothing and must leave both markers alone.
   */
  afterGap = false,
): Promise<string> {
  const profile = await getProfile(accessToken);
  const now = nowSeconds();
  await db
    .update(gmailAccounts)
    .set({
      historyId: profile.historyId,
      lastSyncedAt: now,
      // `lastError` is the transient signal, cleared by the next successful
      // run. `lastGapAt` is the durable one and is never written anywhere
      // else in this file, so no success can erase it.
      lastError: afterGap ? HISTORY_GAP_ERROR : null,
      ...(afterGap ? { lastGapAt: now } : {}),
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
  //
  // And scoped to `source: "gmail"`, because the send path already is:
  // `resolveGmailAccountId` refuses an identity whose source is not "gmail".
  // Reading the pair differently is how a row could receive through Google
  // while replying through Cloudflare — and it made `source: "cloudflare"`,
  // the obvious way to stop a sync from an API client, not stop it.
  const mappings = await db
    .select({
      email: senderIdentities.email,
      gmailGroupAddress: senderIdentities.gmailGroupAddress,
    })
    .from(senderIdentities)
    .where(
      and(
        eq(senderIdentities.gmailAccountId, account.id),
        eq(senderIdentities.source, "gmail"),
      ),
    );

  // Resolved once per run, not per message: this slice routes personal
  // mailboxes only (1:1 account -> inbox) and deliberately inspects no
  // header, because List-ID and Delivered-To are both sender-forgeable.
  // Group mappings are ignored.
  const inbox = resolvePersonalInbox(mappings);

  let ingested = 0;
  let skipped = 0;
  let failed = 0;

  /**
   * Our own domains, for the conversation grouping a mirrored Sent message
   * needs. Loaded at most once per run and only when a Sent message actually
   * turns up, so an account that never sees one pays nothing for it.
   */
  let internalDomains: string[] | null = null;
  const getInternalDomains = async (): Promise<string[]> => {
    if (internalDomains === null) {
      const rows = await db
        .select({ email: senderIdentities.email })
        .from(senderIdentities);
      internalDomains = Array.from(
        new Set(
          rows
            .map((r) => {
              const at = r.email.lastIndexOf("@");
              return at === -1 ? "" : r.email.slice(at + 1).toLowerCase();
            })
            .filter(Boolean),
        ),
      );
    }
    return internalDomains;
  };

  // No usable destination — so stall, before touching history at all.
  //
  // Skipping each message instead would consume the history that names it and
  // advance the cursor past it, discarding the mail permanently for a problem
  // that is pure misconfiguration and trivially fixable. Consuming nothing
  // leaves it all in Gmail until the mapping is corrected, which is the same
  // stall-rather-than-drop rule this engine applies everywhere else.
  //
  // Reachable in normal operation: the admin PATCH does not enforce one inbox
  // per Gmail account, so two mappings make `resolvePersonalInbox` return null
  // by its refuse-to-guess rule.
  if (!inbox) {
    // `resolvePersonalInbox` collapses both shapes to null. Recount here only
    // to tell the operator WHICH one they have — the fixes differ. Mirrors
    // the `=== null` predicate in route-inbox.ts.
    const personalCount = mappings.filter(
      (m) => m.gmailGroupAddress === null,
    ).length;
    const reason =
      personalCount === 0
        ? NO_PERSONAL_INBOX_ERROR
        : AMBIGUOUS_INBOX_MAPPING_ERROR;
    console.error(
      `Gmail sync for ${account.emailAddress}: ${reason} (${personalCount} personal mappings). Not consuming history until the mapping is fixed.`,
    );
    const now = nowSeconds();
    await db
      .update(gmailAccounts)
      // No `lastSyncedAt` — nothing was synced — and no `historyId`, so the
      // cursor stays exactly where it was.
      .set({ lastError: reason, updatedAt: now })
      .where(eq(gmailAccounts.id, account.id));
    return { ingested, skipped, reseeded: false, failed };
  }

  if (!account.historyId) {
    // A first seed skips nothing — there was no cursor — so it leaves no
    // error marker behind.
    await seedCursor(db, account.id, accessToken);
    return { ingested, skipped, reseeded: false, failed };
  }

  const startHistoryId = account.historyId;
  let pageToken: string | undefined;
  /**
   * The FIRST page's historyId, not the last.
   *
   * Each page reports the mailbox head as it stands when that page is
   * fetched, so mail arriving mid-pagination pushes later pages' values above
   * records we were never shown. The first page's value is the only one that
   * provably sits at or below everything we went on to read, so it is the
   * only safe place to leave the cursor after a full drain.
   */
  let firstPageHistoryId: string | null = null;
  /** True once we stopped early at MAX_MESSAGES_PER_RUN, mid-history. */
  let truncated = false;
  /** True once Gmail has no further history pages for this cursor. */
  let exhausted = false;
  /**
   * The id of the last history record processed IN FULL. The only value it is
   * safe to resume from when a run stops early.
   */
  let lastCompleteRecordId: string | null = null;
  /** Set when a message threw; stops the run without discarding finished work. */
  let failedMessageId: string | null = null;

  while (!truncated && !exhausted && !failedMessageId) {
    let page;
    try {
      page = await listHistory(accessToken, { startHistoryId, pageToken });
    } catch (err) {
      if (err instanceof GmailApiError && err.code === "history_gone") {
        // The cursor is older than Gmail's ~1 week history retention. Retrying
        // would fail forever, so re-seed at the mailbox's current position and
        // log the gap loudly — mail in that window is not recoverable here.
        // Mail arrived in the gap and is not recoverable here, so the account
        // is left marked: re-seeding keeps sync alive, but an operator has to
        // be able to see that something was missed.
        const seeded = await seedCursor(db, account.id, accessToken, true);
        console.warn(
          `Gmail history expired for ${account.emailAddress}: cursor ${startHistoryId} is gone, re-seeded at ${seeded}. Messages in the gap were not synced.`,
        );
        return { ingested, skipped, reseeded: true, failed };
      }
      throw err;
    }

    if (firstPageHistoryId === null && page.historyId) {
      firstPageHistoryId = page.historyId;
    }

    for (const record of groupIntoRecords(page.added)) {
      // Records are processed whole, never partially. Advancing the cursor to
      // a record we only half-processed would skip its remaining messages
      // permanently, which is the exact loss this cursor design exists to
      // prevent. So the cap is checked at record boundaries only.
      //
      // The `lastCompleteRecordId` guard means a single record larger than
      // the cap is still processed in full, slightly over budget: refusing it
      // would leave the cursor unable to advance past that record, ever.
      if (
        lastCompleteRecordId !== null &&
        ingested + skipped + record.messageIds.length > MAX_MESSAGES_PER_RUN
      ) {
        truncated = true;
        break;
      }

      /** Cleared if any message in this record throws. */
      let recordComplete = true;

      for (const messageId of record.messageIds) {
        try {
          const message = await getMessage(accessToken, messageId);
          // Deleted between the history page and this fetch. Ordinary, not a
          // failure — Gmail history is a log of what happened, not of what
          // still exists.
          if (!message) {
            skipped++;
            continue;
          }

          if (message.labelIds.some((label) => SKIP_LABELS.has(label))) {
            skipped++;
            continue;
          }

          // The mailbox's own outgoing mail goes onto the timeline as a
          // `sent_emails` row instead of down the inbound path. Everything
          // below this branch is the inbound path, unchanged.
          //
          // Inside the same try/catch as the inbound ingest deliberately: a
          // mirror that throws is not a new failure mode, it is the existing
          // one. The catch counts it, leaves this record incomplete and stops
          // the run with the cursor at the last record that finished.
          if (message.labelIds.includes(SENT_LABEL)) {
            const mirrored = await mirrorSentMessage(db, {
              gmailMessageId: messageId,
              message,
              inbox,
              internalDomains: await getInternalDomains(),
            });
            // Counted either way, so the per-run message cap stays honest.
            if (mirrored) ingested++;
            else skipped++;
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

          const outcome = await ingestParsedEmail(db, parsed, env, ctx);

          // Count what happened, not what was attempted.
          //
          // `ingested++` unconditionally was the critical bug in this engine:
          // a blocked sender or a duplicate produced the same `void` as a
          // stored message, so the run reported mail as ingested that it had
          // thrown away, and the cursor advanced past it. `skipped` is the
          // honest counter for both — and neither is a failure, so neither
          // stalls the run.
          //
          // The duplicate that matters here is now per-inbox (see the dedupe
          // in `ingestParsedEmail`): a message addressed to two connected
          // mailboxes is stored once per inbox, so the second mailbox's sync
          // no longer drops it and calls that a delivery.
          if (outcome.status === "stored") ingested++;
          else skipped++;

          // `gmailMessageId` / `gmailThreadId` are not ParsedEmail fields, so
          // they are written back afterwards — by PRIMARY KEY, using the id
          // the ingest just handed back.
          //
          // It used to match on `emails.message_id`, which is written by the
          // sender. A stranger who reuses a Message-ID we already hold could
          // therefore get this mailbox's Gmail ids stamped onto a row created
          // by a different source, and `isNull(gmailMessageId)` did not stop
          // it — a Cloudflare-delivered row has exactly that. Addressing the
          // row by id removes the guesswork instead of narrowing it.
          //
          // Only for a row THIS call created: a duplicate means the row
          // already belongs to an earlier delivery, and a blocked message has
          // no row at all.
          if (outcome.status === "stored") {
            await db
              .update(emails)
              .set({
                gmailMessageId: messageId,
                gmailThreadId: message.threadId || null,
              })
              .where(eq(emails.id, outcome.emailId));
          }
        } catch (err) {
          // One message must not discard the work this run already finished,
          // and must not be skipped past either. So: stop here, leave this
          // record incomplete, and let the cursor stand at the last record
          // that finished BEFORE this one. The next run retries from there.
          //
          // A permanently poisonous message therefore stalls this account —
          // visibly, via lastError — rather than being silently dropped.
          console.error(
            `Gmail sync failed on message ${messageId} for ${account.emailAddress}:`,
            err,
          );
          failed++;
          failedMessageId = messageId;
          recordComplete = false;
          break;
        }
      }

      if (!recordComplete) break;

      // Reached only when every message in the record was handled, which is
      // what makes this id safe to resume from.
      lastCompleteRecordId = record.historyId;
    }

    if (truncated) break;
    // Do not fall through to `exhausted` — that would advance the cursor to
    // the mailbox head and skip everything from the failed message onward.
    if (failedMessageId) break;
    if (page.nextPageToken) {
      pageToken = page.nextPageToken;
    } else {
      exhausted = true;
    }
  }

  const now = nowSeconds();
  const patch: Partial<typeof gmailAccounts.$inferInsert> = {
    lastSyncedAt: now,
    // Naming the message gives an operator something to act on: they can open
    // it in Gmail and see why it cannot be ingested.
    lastError: failedMessageId
      ? `${MESSAGE_FAILED_PREFIX}${failedMessageId}`
      : null,
    updatedAt: now,
  };

  // Three ways to advance, and the distinctions matter.
  //
  // A run that consumed the whole history range advances to the FIRST page's
  // historyId. Nothing is left behind, but the mailbox head may have moved
  // while we paginated, so the last page's value can sit above records we
  // were never shown; the first page's cannot.
  //
  // A run cut short by the cap advances only to the last record it processed
  // IN FULL. `startHistoryId` is exclusive ("returns history records AFTER
  // the specified startHistoryId"), so the next run resumes at the very next
  // record. Using the page-level historyId here would jump past everything
  // unprocessed; using a message's own `historyId` would be worse still,
  // since Gmail defines that as the last record to MODIFY the message and a
  // later read or label can sort it past mail this run never saw.
  //
  // A run stopped by a failing message keeps whatever it finished: the cursor
  // moves to the last record completed BEFORE the failure, so that work is
  // not thrown away and re-fetched every tick. It never moves past the failed
  // record, so nothing is skipped.
  if (failedMessageId) {
    if (lastCompleteRecordId) patch.historyId = lastCompleteRecordId;
  } else if (exhausted && firstPageHistoryId) {
    patch.historyId = firstPageHistoryId;
  } else if (truncated && lastCompleteRecordId) {
    patch.historyId = lastCompleteRecordId;
    console.warn(
      `Gmail sync for ${account.emailAddress} hit the ${MAX_MESSAGES_PER_RUN}-message cap; resuming after history record ${lastCompleteRecordId} on the next run.`,
    );
  }

  await db
    .update(gmailAccounts)
    .set(patch)
    .where(eq(gmailAccounts.id, account.id));

  return { ingested, skipped, reseeded: false, failed };
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

  for (const [i, result] of results.entries()) {
    if (result.status === "rejected") {
      // The message only, never the error object: a D1 error carries its
      // bound query parameters, which on this path include the access token.
      const reason =
        result.reason instanceof Error
          ? result.reason.message
          : "unknown error";
      console.error(
        `Gmail sync failed for ${accounts[i].emailAddress}: ${reason}`,
      );
      // And on the row, or the failure exists only in cron output. `lastError`
      // is the one field the admin UI reads for trouble, and nothing there has
      // a staleness threshold — so without this a mailbox that has failed
      // every 15 minutes for a week renders as "Synced 7 days ago" with no
      // Reconnect offered, and the only symptom is mail not arriving.
      await recordSyncFailure(
        db,
        accounts[i].id,
        syncFailureCode(result.reason),
      );
      continue;
    }

    // A fulfilled result can still carry a failure: `syncAccount` catches a
    // poisonous message internally, increments `failed`, and RESOLVES
    // rather than rejecting (see the comment on its own catch block). Without
    // this branch, `Promise.allSettled` reports the account as healthy and
    // the failure is visible only on `gmail_accounts.lastError` — never in
    // cron output. A rejection above means "this account could not sync at
    // all"; this means "it synced, but some messages did not make it".
    if (result.value.failed > 0) {
      console.error(
        `Gmail sync failed to ingest ${result.value.failed} message(s) for ${accounts[i].emailAddress}`,
      );
    }

    // A re-seed means an expired history cursor forced a jump to the
    // mailbox's current position, and mail inside the gap was never synced.
    // `gmail_accounts.lastGapAt` records this durably, so it isn't invisible
    // — but a line here means it's also visible to whoever is watching cron
    // output in real time, not just to someone later querying the account.
    if (result.value.reseeded) {
      console.warn(
        `Gmail sync re-seeded the history cursor for ${accounts[i].emailAddress} after an expired cursor; mail in the gap was not synced.`,
      );
    }
  }
}
