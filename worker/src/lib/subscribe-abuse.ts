import { and, eq, gte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "../db/schema";
import { nanoid } from "nanoid";
import { subscribeAttempts } from "../db/subscribe-attempts.schema";

/** Max form submissions from one IP in the window. */
export const MAX_SUBMISSIONS_PER_IP_PER_HOUR = 10;
/** Max confirmation emails to one (form, address) in the window. */
export const MAX_RESENDS_PER_EMAIL_PER_HOUR = 2;
const WINDOW_SECONDS = 3600;

/** Max accepted request body. Anything larger is refused before parsing. */
export const MAX_SUBSCRIBE_BODY_BYTES = 4096;

/** How long attempt rows are kept — the widest window plus a safety margin. */
export const ATTEMPT_RETENTION_SECONDS = 24 * 3600;

/**
 * SHA-256 of the lowercased address, hex encoded.
 *
 * The attempts ledger is written from a public unauthenticated endpoint and is
 * high-write by design. Storing raw addresses would make it a second, less
 * guarded copy of the subscriber list, so it stores only what rate limiting
 * actually needs: a stable equality key.
 */
export async function hashEmail(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function recordAttempt(
  db: DrizzleD1Database<any>,
  opts: {
    formId: string;
    emailHash: string;
    ip: string;
    attemptType: "submission" | "confirmation_resend";
    now: number;
  },
): Promise<void> {
  await db.insert(subscribeAttempts).values({
    id: nanoid(),
    formId: opts.formId,
    emailHash: opts.emailHash,
    ip: opts.ip,
    attemptType: opts.attemptType,
    createdAt: opts.now,
  });
}

async function countSince(
  db: DrizzleD1Database<any>,
  where: ReturnType<typeof and>,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(subscribeAttempts)
    .where(where);
  return Number(rows[0]?.n ?? 0);
}

/** Whether this IP has submitted too often in the last hour. */
export async function isIpRateLimited(
  db: DrizzleD1Database<any>,
  ip: string,
  now: number,
): Promise<boolean> {
  const n = await countSince(
    db,
    and(
      eq(subscribeAttempts.ip, ip),
      eq(subscribeAttempts.attemptType, "submission"),
      gte(subscribeAttempts.createdAt, now - WINDOW_SECONDS),
    ),
  );
  return n >= MAX_SUBMISSIONS_PER_IP_PER_HOUR;
}

/**
 * Whether this (form, address) pair has been sent too many confirmations.
 *
 * This is the check a `list_members` count cannot make: submitting repeatedly
 * against an already-pending membership is an upsert that changes no row, so
 * membership counting sees nothing while the victim's inbox fills up.
 */
export async function isConfirmationRateLimited(
  db: DrizzleD1Database<any>,
  formId: string,
  emailHash: string,
  now: number,
): Promise<boolean> {
  const n = await countSince(
    db,
    and(
      eq(subscribeAttempts.formId, formId),
      eq(subscribeAttempts.emailHash, emailHash),
      eq(subscribeAttempts.attemptType, "confirmation_resend"),
      gte(subscribeAttempts.createdAt, now - WINDOW_SECONDS),
    ),
  );
  return n >= MAX_RESENDS_PER_EMAIL_PER_HOUR;
}

/**
 * Origin check, failing **closed**.
 *
 * When a form declares allowed origins, a request must present a matching
 * `Origin`. A missing header counts as a non-match: treating "absent" as
 * "allowed" would let any non-browser client skip the control entirely, which
 * is precisely the client an abuser uses.
 *
 * When no origins are configured the form is open to any caller, which is what
 * makes server-side and non-browser submission work.
 */
export function isOriginAllowed(
  allowedOrigins: string | null,
  origin: string | null,
): boolean {
  if (allowedOrigins === null || allowedOrigins.trim() === "") return true;
  if (!origin) return false;
  const allowed = allowedOrigins
    .split(",")
    .map((o) => o.trim().toLowerCase())
    .filter((o) => o !== "");
  return allowed.includes(origin.trim().toLowerCase());
}

/** Delete attempt rows past the retention window. Called by the hourly cron. */
export async function purgeExpiredAttempts(
  db: DrizzleD1Database<any>,
  now: number,
): Promise<void> {
  await db
    .delete(subscribeAttempts)
    .where(
      sql`${subscribeAttempts.createdAt} < ${now - ATTEMPT_RETENTION_SECONDS}`,
    );
}

/**
 * Cron entry point. Takes `env` and builds its own client, matching
 * `processOutbox(env)` / `handleScheduled(env)` so `index.ts` does not need to
 * know how a db client is constructed.
 */
export async function runSubscribeAttemptPurge(
  env: CloudflareBindings,
): Promise<void> {
  await purgeExpiredAttempts(
    drizzle(env.DB, { schema }),
    Math.floor(Date.now() / 1000),
  );
}
