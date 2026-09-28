import { sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import { MAX_DELAYED_SEND } from "./constants";
import { listAllowedInboxAddresses } from "./mailboxes";
import { JMAP_ID_FORMAT_VERSION } from "./public-ids";

export async function opaqueState(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `s-${hex.slice(0, 32)}`;
}

/**
 * The Session object's `state` (RFC 8620 §2): it changes only when the Session
 * itself does (id format, account, username, the inboxes it covers, the origin
 * its URLs are on), never because mail arrived. Mail and mailbox state is
 * `currentJmapState`.
 */
export async function sessionState(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  user: { id: string; email?: string | null },
  origin: string,
): Promise<string> {
  return opaqueState({
    kind: "session",
    v: JMAP_ID_FORMAT_VERSION,
    origin,
    user: user.id,
    username: user.email ?? user.id,
    inboxes: await listAllowedInboxAddresses(db, allowed),
    // The submission capability's stable part. FUTURERELEASE's max date-time
    // moves every second and is left out, or the state would never settle.
    maxDelayedSend: MAX_DELAYED_SEND,
  });
}

/**
 * The Identity `state`: identities aren't in the change log, so the state is a
 * hash of exactly the Identity objects the user sees. Any visible change moves
 * it, whatever its timing (a COUNT/MAX(updated_at) fingerprint can miss one).
 */
export async function identityState(identities: unknown[]): Promise<string> {
  return opaqueState({
    kind: "identity",
    v: JMAP_ID_FORMAT_VERSION,
    identities,
  });
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
  return `j${JMAP_ID_FORMAT_VERSION}-${seq}-${issuedAt}-${fp}`;
}

export function parseJmapState(value: unknown): ParsedJmapState | null {
  if (typeof value !== "string") return null;
  const match = new RegExp(
    `^j${JMAP_ID_FORMAT_VERSION}-(\\d+)-(\\d+)-([0-9a-f]{16})$`,
  ).exec(value);
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
  if (!("inboxes" in allowed)) return [];
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
