// Test-only helpers for JMAP submission suites: run calls with an injected
// sender, create drafts through the real Email/set, upload through the real
// route. Not a test file.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { users } from "../db/auth.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import type {
  EmailSender,
  SendEmailParams,
  SendEmailResult,
} from "../lib/email-sender";
import { resolveAllowedInboxes } from "../lib/inbox-permissions";
import {
  CORE_CAPABILITY,
  MAIL_CAPABILITY,
  SUBMISSION_CAPABILITY,
} from "../jmap/constants";
import { executeJmapCalls } from "../jmap/http";
import type { MethodResponse } from "../jmap/result-reference";
import { authFetch, getDb } from "./helpers";
import { acct, idn, sys } from "./jmap-ids";

export const MINE = "mine@saasmail.test";
export const OTHER = "other@saasmail.test";
export const ALL_CAPABILITIES = [
  CORE_CAPABILITY,
  MAIL_CAPABILITY,
  SUBMISSION_CAPABILITY,
];
export const OK: SendEmailResult = { id: "prov-1", error: null };
export const TRANSIENT: SendEmailResult = {
  id: null,
  error: { message: "quota exceeded", transient: true },
};
export const PERMANENT: SendEmailResult = {
  id: null,
  error: { message: "550 mailbox unavailable", transient: false },
};

export async function addIdentity(
  email: string,
  displayName: string | null = "Mine Inbox",
) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(senderIdentities)
    .values({ email, displayName, createdAt: now, updatedAt: now });
}

export function recordingSender(
  results: SendEmailResult[] = [OK],
  maxMessageBytes = 25 * 1024 * 1024,
) {
  const calls: SendEmailParams[] = [];
  const sender: EmailSender = {
    provider: "cloudflare",
    async send(params: SendEmailParams) {
      calls.push(params);
      return results[Math.min(calls.length - 1, results.length - 1)];
    },
    maxAttachmentBytes: () => 25 * 1024 * 1024,
    maxMessageBytes: () => maxMessageBytes,
  };
  return { sender, calls };
}

export async function runJmap(
  userId: string,
  methodCalls: unknown[],
  sender: EmailSender,
  opts: { using?: string[]; env?: CloudflareBindings } = {},
): Promise<MethodResponse[]> {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  const allowed = await resolveAllowedInboxes(db, user);
  return executeJmapCalls(
    db,
    allowed,
    user,
    opts.using ?? ALL_CAPABILITIES,
    methodCalls as [string, Record<string, unknown>, string][],
    { env: opts.env ?? env, createdIds: new Map(), sender },
  );
}

export async function uploadBlob(
  userId: string,
  apiKey: string,
  bytes: Uint8Array,
  type: string,
): Promise<string> {
  const response = await authFetch(`/jmap/upload/${acct(userId)}/`, {
    method: "POST",
    apiKey,
    headers: { "Content-Type": type },
    // Uint8Array is not a BodyInit in the Workers types.
    body: bytes as BodyInit,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { blobId: string }).blobId;
}

export function draftCreate(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mailboxIds: { [sys(MINE, "drafts")]: true },
    keywords: { $draft: true },
    from: [{ name: "Mine", email: MINE }],
    to: [{ name: "Bob Example", email: "bob@example.com" }],
    subject: "Hello Bob",
    bodyValues: {
      t: { value: "Hi Bob" },
      h: { value: "<p>Hi Bob</p>" },
    },
    textBody: [{ partId: "t", type: "text/plain" }],
    htmlBody: [{ partId: "h", type: "text/html" }],
    ...overrides,
  };
}

export type CreatedDraft = {
  id: string;
  blobId: string;
  threadId: string;
  size: number;
};

export async function createDraft(
  userId: string,
  sender: EmailSender,
  overrides: Record<string, unknown> = {},
): Promise<CreatedDraft> {
  const [response] = await runJmap(
    userId,
    [
      [
        "Email/set",
        { accountId: acct(userId), create: { d1: draftCreate(overrides) } },
        "e1",
      ],
    ],
    sender,
  );
  const created = (response[1] as Record<string, any>).created?.d1;
  if (!created)
    throw new Error(`draft create failed: ${JSON.stringify(response)}`);
  return created as CreatedDraft;
}

export function submitCall(
  userId: string,
  emailId: string,
  extra: Record<string, unknown> = {},
  callId = "s",
): unknown[] {
  return [
    "EmailSubmission/set",
    {
      accountId: acct(userId),
      create: { s1: { identityId: idn(MINE), emailId, ...extra } },
    },
    callId,
  ];
}
