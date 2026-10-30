import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { emails } from "../db/emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { attachments } from "../db/attachments.schema";
import { people } from "../db/people.schema";
import { auditMailDeleted } from "./audit/mail-events";
import { deleteReceivedMessageStateStatements } from "./messages/state";
import { decodeEntities, htmlToText } from "./html-to-text";
import { isInboxAllowed, type AllowedInboxes } from "./inbox-permissions";
import { queryMessages } from "./messages/query";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/** Days a test inbox keeps its mail when it names none. */
export const DEFAULT_TEST_RETENTION_DAYS = 3;
export const MIN_TEST_RETENTION_DAYS = 1;
export const MAX_TEST_RETENTION_DAYS = 30;
/** Longest wait one call may ask for, in seconds. */
export const MAX_WAIT_SECONDS = 30;
export const DEFAULT_WAIT_SECONDS = 25;

const MAX_LINKS = 20;
const MAX_CODES = 10;

/** Characters that end a URL written in plain text. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/**
 * The `http(s)` URLs of a message: the HTML's `href`s (entities decoded, so
 * `&amp;` is `&`), then the URLs written in the text. Deduplicated, in order,
 * at most 20.
 */
export function extractLinks(
  html: string | null,
  text: string | null,
): string[] {
  const found: string[] = [];
  if (html) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    for (const match of html.matchAll(href)) {
      // An entity naming no code point (`&#1114112;`) makes the decoder
      // throw: that href is skipped, the rest of the message still answers.
      try {
        found.push(
          decodeEntities(match[1] ?? match[2] ?? match[3] ?? "").trim(),
        );
      } catch {
        continue;
      }
    }
  }
  if (text) {
    for (const match of text.matchAll(/https?:\/\/[^\s<>"]+/gi)) {
      found.push(match[0].replace(TRAILING_PUNCTUATION, ""));
    }
  }
  const links: string[] = [];
  for (const url of found) {
    if (!/^https?:\/\/\S+$/i.test(url) || links.includes(url)) continue;
    links.push(url);
    if (links.length === MAX_LINKS) break;
  }
  return links;
}

/**
 * Candidate one-time codes: whole runs of 4–8 digits (not part of a longer
 * run) in the subject, then the text. Deduplicated, in order, at most 10.
 */
export function extractCodes(
  subject: string | null,
  text: string | null,
): string[] {
  const codes: string[] = [];
  for (const source of [subject, text]) {
    if (!source) continue;
    for (const match of source.matchAll(/(?<!\d)\d{4,8}(?!\d)/g)) {
      if (codes.includes(match[0])) continue;
      codes.push(match[0]);
      if (codes.length === MAX_CODES) return codes;
    }
  }
  return codes;
}

export interface TestMailQuery {
  inbox: string;
  /** Exact `+detail`, any case. */
  detail?: string;
  /** Epoch seconds: only mail received at or after it. */
  since: number;
  /** Case-insensitive substring of the subject. */
  subject?: string;
  /** Exact sender address. */
  from?: string;
  /** Seconds, 1–30. */
  timeout: number;
}

export interface TestMail {
  id: string;
  inbox: string;
  detail: string | null;
  from: string | null;
  subject: string | null;
  receivedAt: number;
  text: string | null;
  html: string | null;
  links: string[];
  codes: string[];
}

export interface WaitDeps {
  /** Stops the wait early (the request was aborted). */
  signal?: AbortSignal;
  /** Milliseconds; injectable for tests. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Whether the caller may wait on this inbox: it may read it, and it is a test
 * inbox. One answer for both, so a refusal says nothing about the inbox.
 */
export async function mayWaitOn(
  db: Db,
  allowed: AllowedInboxes,
  inbox: string,
): Promise<boolean> {
  if (!isInboxAllowed(allowed, inbox)) return false;
  const [row] = await db
    .select({ purpose: senderIdentities.purpose })
    .from(senderIdentities)
    .where(eq(senderIdentities.email, inbox))
    .limit(1);
  return row?.purpose === "test";
}

/** The first message to the test inbox that matches, or null. */
async function findTestMail(
  db: Db,
  allowed: AllowedInboxes,
  query: TestMailQuery,
): Promise<TestMail | null> {
  const page = await queryMessages(db, allowed, {
    inboxes: [query.inbox],
    direction: "inbound",
    after: query.since,
    order: "asc",
    includeArchived: true,
    includeSnoozed: true,
    ...(query.detail !== undefined
      ? { recipientDetail: query.detail.toLowerCase() }
      : {}),
    ...(query.from !== undefined ? { fromExact: query.from } : {}),
    ...(query.subject !== undefined
      ? { search: query.subject, searchMode: "subject" as const }
      : {}),
    limit: 5,
  });
  const message = page.messages[0];
  if (!message) return null;
  const text = message.bodyText;
  const html = message.bodyHtml;
  return {
    id: message.ref.id,
    inbox: message.inbox,
    detail: message.recipientDetail ?? null,
    from: message.from?.email ?? null,
    subject: message.subject,
    receivedAt: message.occurredAt,
    text,
    html,
    links: extractLinks(html, text),
    codes: extractCodes(message.subject, text ?? htmlAsText(html)),
  };
}

/** The HTML as text, or null when it cannot be converted (see extractLinks). */
function htmlAsText(html: string | null): string | null {
  if (!html) return null;
  try {
    return htmlToText(html);
  } catch {
    return null;
  }
}

/**
 * Waits up to `timeout` seconds for the first message to a test inbox that
 * matches. Polls D1 (at once, after 1 s, then every 2 s); null on timeout or
 * when `signal` aborts. `error` is set when the caller may not wait on the
 * inbox (not readable, or not a test inbox).
 */
export async function waitForTestMail(
  db: Db,
  allowed: AllowedInboxes,
  input: TestMailQuery,
  deps: WaitDeps = {},
): Promise<{ error: "forbidden" | null; message: TestMail | null }> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const query = { ...input, inbox: input.inbox.trim().toLowerCase() };
  if (!(await mayWaitOn(db, allowed, query.inbox))) {
    return { error: "forbidden", message: null };
  }
  const deadline = now() + query.timeout * 1000;
  let interval = 1000;
  for (;;) {
    const message = await findTestMail(db, allowed, query);
    if (message) return { error: null, message };
    const remaining = deadline - now();
    if (remaining <= 0 || deps.signal?.aborted) break;
    await sleep(Math.min(interval, remaining), deps.signal);
    if (deps.signal?.aborted) break;
    interval = 2000;
  }
  return { error: null, message: null };
}

/**
 * Messages one pass deletes at most. Each delete through the normal path is
 * about 11 D1 statements, and the whole cron chain shares one invocation's
 * D1 query budget.
 */
export const PRUNE_LIMIT = 40;

/** A test-inbox message the prune may delete, evaluated when it runs. */
function prunableIds(now: number, candidates: string[]) {
  return sql`(
    SELECT e.id FROM ${emails} e
    JOIN ${senderIdentities} si ON si.email = e.recipient
    WHERE si.purpose = 'test' AND si.source = 'cloudflare'
      AND e.received_at <
        ${now} - COALESCE(si.test_retention_days, ${DEFAULT_TEST_RETENTION_DAYS}) * 86400
      AND e.id IN (SELECT value FROM json_each(${JSON.stringify(candidates)}))
  )`;
}

/**
 * Deletes test-inbox mail older than its inbox's retention: at most 40
 * messages per pass, oldest first across every test inbox. The next hourly
 * pass takes the rest. Returns how many it deleted.
 *
 * The candidates are read first, then deleted in one `db.batch` whose every
 * statement re-checks eligibility: an inbox switched back to normal mail, or
 * given a longer retention, in between keeps its mail. State goes before the
 * row, as in `deleteEmailWithAttachments`; files, counts and the audit entry
 * follow for the rows the batch actually deleted. Only Cloudflare-routed
 * test inboxes are pruned: a mapped inbox's mail is never deleted here.
 */
export async function pruneTestMail(
  db: Db,
  env: CloudflareBindings,
  now: number,
  hooks: { beforeDelete?: () => Promise<void> } = {},
): Promise<number> {
  const candidates = (
    await db.all<{ id: string }>(sql`
      SELECT e.id AS id
      FROM ${emails} e
      JOIN ${senderIdentities} si ON si.email = e.recipient
      WHERE si.purpose = 'test' AND si.source = 'cloudflare'
        AND e.received_at <
          ${now} - COALESCE(si.test_retention_days, ${DEFAULT_TEST_RETENTION_DAYS}) * 86400
      ORDER BY e.received_at, e.id
      LIMIT ${PRUNE_LIMIT}
    `)
  ).map((row) => row.id);
  if (candidates.length === 0) return 0;

  const files = await db
    .select({ emailId: attachments.emailId, r2Key: attachments.r2Key })
    .from(attachments)
    .where(
      sql`${attachments.emailId} IN (SELECT value FROM json_each(${JSON.stringify(candidates)}))`,
    );
  await hooks.beforeDelete?.();

  const eligible = prunableIds(now, candidates);
  const [, ...rest] = await db.batch([
    db.delete(attachments).where(sql`${attachments.emailId} IN ${eligible}`),
    ...deleteReceivedMessageStateStatements(db, eligible),
    db
      .delete(emails)
      .where(sql`${emails.id} IN ${eligible}`)
      .returning({
        id: emails.id,
        personId: emails.personId,
        isRead: emails.isRead,
        recipient: emails.recipient,
        subject: emails.subject,
        rawR2Key: emails.rawR2Key,
      }),
  ]);
  const deleted = rest[rest.length - 1] as {
    id: string;
    personId: string;
    isRead: number;
    recipient: string;
    subject: string | null;
    rawR2Key: string | null;
  }[];
  if (deleted.length === 0) return 0;

  const counts = new Map<string, { total: number; unread: number }>();
  for (const row of deleted) {
    const c = counts.get(row.personId) ?? { total: 0, unread: 0 };
    c.total++;
    if (row.isRead === 0) c.unread++;
    counts.set(row.personId, c);
  }
  for (const [personId, c] of counts) {
    await db
      .update(people)
      .set({
        totalCount: sql`MAX(${people.totalCount} - ${c.total}, 0)`,
        unreadCount: sql`MAX(${people.unreadCount} - ${c.unread}, 0)`,
      })
      .where(eq(people.id, personId));
  }

  await auditMailDeleted(
    db,
    deleted.map((row) => ({
      ref: { kind: "received" as const, id: row.id },
      inbox: row.recipient,
      subject: row.subject,
    })),
  );

  // Files last: the rows are gone, so a failure here must not stop the
  // accounting above, and the next pass could not retry it. A failed chunk's
  // keys are logged; an orphaned object is the lesser harm.
  const gone = new Set(deleted.map((row) => row.id));
  const keys = [
    ...files.filter((f) => gone.has(f.emailId)).map((f) => f.r2Key),
    ...deleted.flatMap((row) => (row.rawR2Key ? [row.rawR2Key] : [])),
  ];
  for (let start = 0; start < keys.length; start += R2_DELETE_LIMIT) {
    const chunk = keys.slice(start, start + R2_DELETE_LIMIT);
    try {
      await env.R2.delete(chunk);
    } catch (error) {
      console.error(
        `[test-mail] pruned rows' files not deleted from R2: ${chunk.join(", ")}`,
        error instanceof Error ? error.message : "unknown error",
      );
    }
  }
  return deleted.length;
}

/** Keys one R2 `delete()` call accepts. */
const R2_DELETE_LIMIT = 1000;
