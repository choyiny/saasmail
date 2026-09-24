import { sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { inboxScopeSql, type AllowedInboxes } from "../lib/inbox-permissions";
import { listAllowedInboxAddresses } from "./mailboxes";

export async function opaqueState(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `s-${hex.slice(0, 32)}`;
}

type StateAggregate = {
  received_count: number;
  received_max: number | null;
  sent_count: number;
  sent_max: number | null;
  user_state_count: number;
  user_state_max: number | null;
  mailbox_state_count: number;
  mailbox_state_max: number | null;
  membership_count: number;
  membership_max: number | null;
  mailbox_count: number;
  mailbox_max: number | null;
  identity_count: number;
  identity_max: number | null;
};

export async function jmapState(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
): Promise<string> {
  const receivedScope = inboxScopeSql(allowed, sql`e.recipient`);
  const sentScope = inboxScopeSql(allowed, sql`se.from_address`);
  const mailboxStateScope = inboxScopeSql(allowed, sql`mms.inbox`);
  const mailboxScope = inboxScopeSql(allowed, sql`mb.inbox`);
  const identityScope = inboxScopeSql(allowed, sql`si.email`);

  const rows = await db.all<StateAggregate>(sql`
    SELECT
      (SELECT COUNT(*) FROM emails e WHERE 1 = 1 ${receivedScope}) AS received_count,
      (SELECT MAX(e.received_at) FROM emails e WHERE 1 = 1 ${receivedScope}) AS received_max,
      (SELECT COUNT(*) FROM sent_emails se WHERE 1 = 1 ${sentScope}) AS sent_count,
      (SELECT MAX(se.sent_at) FROM sent_emails se WHERE 1 = 1 ${sentScope}) AS sent_max,
      (SELECT COUNT(*) FROM message_user_state mus WHERE mus.user_id = ${userId}) AS user_state_count,
      (SELECT MAX(mus.updated_at) FROM message_user_state mus WHERE mus.user_id = ${userId}) AS user_state_max,
      (SELECT COUNT(*) FROM mailbox_message_state mms WHERE 1 = 1 ${mailboxStateScope}) AS mailbox_state_count,
      (SELECT MAX(mms.updated_at) FROM mailbox_message_state mms WHERE 1 = 1 ${mailboxStateScope}) AS mailbox_state_max,
      (SELECT COUNT(*)
         FROM message_mailboxes mm
         JOIN mailboxes mb ON mb.id = mm.mailbox_id
        WHERE 1 = 1 ${mailboxScope}) AS membership_count,
      (SELECT MAX(mm.added_at)
         FROM message_mailboxes mm
         JOIN mailboxes mb ON mb.id = mm.mailbox_id
        WHERE 1 = 1 ${mailboxScope}) AS membership_max,
      (SELECT COUNT(*) FROM mailboxes mb WHERE 1 = 1 ${mailboxScope}) AS mailbox_count,
      (SELECT MAX(mb.updated_at) FROM mailboxes mb WHERE 1 = 1 ${mailboxScope}) AS mailbox_max,
      (SELECT COUNT(*) FROM sender_identities si WHERE 1 = 1 ${identityScope}) AS identity_count,
      (SELECT MAX(si.updated_at) FROM sender_identities si WHERE 1 = 1 ${identityScope}) AS identity_max
  `);

  return opaqueState(rows[0] ?? {});
}

export type ParsedJmapState = {
  seq: number;
  issuedAt: number;
  fp: string;
};

export function formatJmapState(
  seq: number,
  issuedAt: number,
  fp: string,
): string {
  return `j1-${seq}-${issuedAt}-${fp}`;
}

export function parseJmapState(value: unknown): ParsedJmapState | null {
  if (typeof value !== "string") return null;
  const match = /^j1-(\d+)-(\d+)-([0-9a-f]{16})$/.exec(value);
  if (!match) return null;
  const seq = Number(match[1]);
  const issuedAt = Number(match[2]);
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(issuedAt)) {
    return null;
  }
  return { seq, issuedAt, fp: match[3] };
}

async function stateFingerprint(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
): Promise<string> {
  const inboxes = await listAllowedInboxAddresses(db, allowed);
  const bytes = new TextEncoder().encode(`${userId}\n${inboxes.join(",")}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 16);
}

const JMAP_STATE_INBOX_CHUNK_SIZE = 40;
const JMAP_STATE_DAY_SECONDS = 24 * 60 * 60;

function memberInboxChunks(allowed: AllowedInboxes): string[][] {
  if (allowed.isAdmin) return [];
  const inboxes = [
    ...new Set(allowed.inboxes.map((inbox) => inbox.toLowerCase())),
  ].sort();
  const chunks: string[][] = [];
  for (
    let start = 0;
    start < inboxes.length;
    start += JMAP_STATE_INBOX_CHUNK_SIZE
  ) {
    chunks.push(inboxes.slice(start, start + JMAP_STATE_INBOX_CHUNK_SIZE));
  }
  return chunks;
}

export function currentJmapSeqQueries(
  allowed: AllowedInboxes,
  userId: string,
): SQL[] {
  if (allowed.isAdmin) {
    return [
      sql`
        SELECT COALESCE(MAX(seq), 0) AS seq
        FROM (
          SELECT (
            SELECT MAX(seq)
            FROM jmap_changes
            WHERE user_id IS NULL
          ) AS seq
          UNION ALL
          SELECT (
            SELECT MAX(seq)
            FROM jmap_changes
            WHERE user_id = ${userId}
          ) AS seq
        )
      `,
    ];
  }

  const queries: SQL[] = [];
  for (const chunk of memberInboxChunks(allowed)) {
    const inboxValues = sql.join(
      chunk.map((inbox) => sql`(${inbox})`),
      sql`, `,
    );
    queries.push(sql`
      WITH allowed_inboxes(inbox) AS (VALUES ${inboxValues})
      SELECT COALESCE(
        MAX((
          SELECT MAX(seq)
          FROM jmap_changes
          WHERE inbox = allowed_inboxes.inbox
            AND user_id IS NULL
        )),
        0
      ) AS seq
      FROM allowed_inboxes
    `);
  }

  queries.push(sql`
    SELECT COALESCE(MAX(seq), 0) AS seq
    FROM jmap_changes
    WHERE user_id = ${userId}
  `);
  return queries;
}

async function currentJmapSeq(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
): Promise<number> {
  let seq = 0;
  for (const query of currentJmapSeqQueries(allowed, userId)) {
    const rows = await db.all<{ seq: number | null }>(query);
    seq = Math.max(seq, Number(rows[0]?.seq ?? 0));
  }
  return seq;
}

export async function currentJmapState(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  now = Math.floor(Date.now() / 1000),
): Promise<{ state: string; parts: ParsedJmapState }> {
  const seq = await currentJmapSeq(db, allowed, userId);
  const fp = await stateFingerprint(db, allowed, userId);
  const issuedAt =
    Math.floor(now / JMAP_STATE_DAY_SECONDS) * JMAP_STATE_DAY_SECONDS;
  const parts = { seq, issuedAt, fp };
  return { state: formatJmapState(seq, issuedAt, fp), parts };
}
