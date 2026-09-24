import { and, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { emails } from "../../db/emails.schema";
import { mailboxMessageState } from "../../db/mailbox-message-state.schema";
import { people } from "../../db/people.schema";
import { senderIdentities } from "../../db/sender-identities.schema";
import { isAutomatedInbound } from "../automated-inbound";
import { isBlocked } from "../blocklist";
import type { EmailSender } from "../email-sender";
import { replyToEmail } from "../send-email";
import { isSuppressed } from "../suppressions";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

export type AutoReplyInput = {
  ruleId: string;
  emailId: string;
  inbox: string;
  subject?: string;
  bodyText: string;
  now?: number;
  sender?: EmailSender;
};

function parseHeaders(rawHeaders: string | null): Record<string, string> {
  if (!rawHeaders) return {};
  try {
    const parsed = JSON.parse(rawHeaders) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export function plainTextToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function skipped(input: AutoReplyInput, reason: string): void {
  console.log(
    `[auto-reply] skipped rule ${input.ruleId} for ${input.emailId}: ${reason}`,
  );
}

export async function runAutoReply(
  db: Db,
  env: CloudflareBindings,
  input: AutoReplyInput,
): Promise<void> {
  const inbox = input.inbox.trim().toLowerCase();
  const now = input.now ?? Math.floor(Date.now() / 1000);

  const [email] = await db
    .select({
      id: emails.id,
      personId: emails.personId,
      recipient: emails.recipient,
      rawHeaders: emails.rawHeaders,
    })
    .from(emails)
    .where(eq(emails.id, input.emailId))
    .limit(1);
  if (!email || email.recipient.trim().toLowerCase() !== inbox) {
    skipped(input, "message not found in rule inbox");
    return;
  }

  const [person] = await db
    .select({ email: people.email })
    .from(people)
    .where(eq(people.id, email.personId))
    .limit(1);
  if (!person) {
    skipped(input, "sender not found");
    return;
  }

  const senderAddress = person.email.trim().toLowerCase();
  if (isAutomatedInbound(parseHeaders(email.rawHeaders), senderAddress)) {
    skipped(input, "automated inbound mail");
    return;
  }

  const identities = await db
    .select({
      email: senderIdentities.email,
      signatureHtml: senderIdentities.signatureHtml,
    })
    .from(senderIdentities);
  if (
    identities.some(
      (identity) => identity.email.trim().toLowerCase() === senderAddress,
    )
  ) {
    skipped(input, "sender is one of our own addresses");
    return;
  }

  if (await isBlocked(db, senderAddress)) {
    skipped(input, "sender is blocked");
    return;
  }
  if (await isSuppressed(db, senderAddress)) {
    skipped(input, "sender is suppressed");
    return;
  }

  const [mailboxState] = await db
    .select({ spamAt: mailboxMessageState.spamAt })
    .from(mailboxMessageState)
    .where(
      and(
        eq(mailboxMessageState.messageKind, "received"),
        eq(mailboxMessageState.messageId, input.emailId),
      ),
    )
    .limit(1);
  if (mailboxState?.spamAt != null) {
    skipped(input, "message is junk");
    return;
  }

  const claim = await db.run(sql`
    INSERT INTO auto_reply_log (rule_id, sender, sent_at)
    VALUES (${input.ruleId}, ${senderAddress}, ${now})
    ON CONFLICT(rule_id, sender) DO UPDATE
      SET sent_at = excluded.sent_at
      WHERE auto_reply_log.sent_at <= excluded.sent_at - 86400
  `);
  if ((claim.meta?.changes ?? 0) === 0) {
    skipped(input, "sender was auto-replied to within 24h");
    return;
  }

  const identity = identities.find(
    (row) => row.email.trim().toLowerCase() === inbox,
  );
  const replyHtml = plainTextToHtml(input.bodyText);
  const bodyHtml = identity?.signatureHtml
    ? `${replyHtml}<div data-signature>${identity.signatureHtml}</div>`
    : replyHtml;

  try {
    const result = await replyToEmail({
      db,
      env,
      emailId: input.emailId,
      payload: {
        fromAddress: inbox,
        bodyHtml,
        bodyText: input.bodyText,
      },
      files: [],
      allowed: { isAdmin: false, inboxes: [inbox] },
      ...(input.subject ? { subjectOverride: input.subject } : {}),
      extraHeaders: { "Auto-Submitted": "auto-replied" },
      retryOnFailure: false,
      ...(input.sender ? { sender: input.sender } : {}),
    });
    if (!result.ok) {
      console.warn(
        `[auto-reply] send skipped after log for rule ${input.ruleId}:`,
        result.message,
      );
    }
  } catch (error) {
    console.warn(
      `[auto-reply] send failed after log for rule ${input.ruleId}:`,
      error,
    );
  }
}
