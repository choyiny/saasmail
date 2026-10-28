// docs/gmail.md and docs/outlook.md: a reply sent through a connected mailbox
// replaces the Sent copy a sync mirrored first. A sync can also mirror that
// copy while the send is writing its own row (Gmail files it the moment it
// answers); whatever the interleaving, the send's write must not fail after
// the provider accepted the message, and no message state may outlive its row.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { sentEmails } from "../db/sent-emails.schema";
import { insertSentRowReplacingEcho } from "../lib/direct-send";
import type { EmailSender } from "../lib/email-sender/types";

const INBOX = "support@acme.dev";
const MESSAGE_ID = "<reply-1@acme.dev>";
const NOW = 1_800_000_000;

type Db = ReturnType<typeof getDb>;
type SentRow = typeof sentEmails.$inferInsert;

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
  await getDb().run(sql`DELETE FROM mailbox_message_state`);
});

function row(over: Partial<SentRow>): SentRow {
  return {
    id: "x",
    fromAddress: INBOX,
    toAddress: "customer@example.com",
    subject: "Re: Question",
    messageId: MESSAGE_ID,
    status: "sent",
    sentAt: NOW,
    createdAt: NOW,
    ...over,
  };
}

/** A mirrored Sent copy, archived by someone: it has message state. */
async function mirror(db: Db, over: Partial<SentRow>) {
  const mirrored = row({ subject: "Re: Question (mirrored)", ...over });
  await db.insert(sentEmails).values(mirrored);
  await db.run(sql`
    INSERT INTO mailbox_message_state
      (inbox, message_kind, message_id, archived_at, updated_at)
    VALUES (${INBOX}, 'sent', ${mirrored.id}, ${NOW}, ${NOW})
  `);
}

/** The real database, with `hook` run against it just before one call. */
function interleave(
  db: Db,
  method: "insert" | "batch",
  hook: () => Promise<void>,
): Db {
  let fired = false;
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "batch" && method === "batch") {
        return async (queries: Parameters<Db["batch"]>[0]) => {
          if (!fired) {
            fired = true;
            await hook();
          }
          return target.batch(queries);
        };
      }
      if (prop === "insert" && method === "insert") {
        return (table: typeof sentEmails) => ({
          values: (values: SentRow) => ({
            then(
              resolve: (value: unknown) => unknown,
              reject: (reason: unknown) => unknown,
            ) {
              const first = !fired;
              fired = true;
              return (first ? hook() : Promise.resolve())
                .then(() => target.insert(table).values(values))
                .then(resolve, reject);
            },
          }),
        });
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

async function orphanedState(db: Db): Promise<number> {
  const [{ n }] = await db.all<{ n: number }>(sql`
    SELECT count(*) AS n FROM mailbox_message_state
    WHERE message_kind = 'sent'
      AND message_id NOT IN (SELECT id FROM sent_emails)
  `);
  return n;
}

async function stateOf(db: Db, id: string): Promise<number> {
  const [{ n }] = await db.all<{ n: number }>(sql`
    SELECT count(*) AS n FROM mailbox_message_state
    WHERE message_kind = 'sent' AND message_id = ${id}
  `);
  return n;
}

describe("insertSentRowReplacingEcho, with a mirror written mid-write", () => {
  it.each([
    {
      name: "Gmail: no echo at the select, the mirror lands before the insert",
      provider: "gmail" as const,
      before: [] as Partial<SentRow>[],
      during: { id: "mirror-late", gmailMessageId: "g-1" },
      sendRow: { id: "send-1", gmailMessageId: "g-1", gmailThreadId: "t-1" },
    },
    {
      name: "Outlook: no echo at the select, the mirror lands before the insert",
      provider: "outlook" as const,
      before: [],
      during: { id: "mirror-late", outlookMessageId: "ol-1" },
      sendRow: { id: "send-1" },
    },
    {
      name: "Outlook: one echo cleared, a second mirror lands before the batch",
      provider: "outlook" as const,
      before: [{ id: "mirror-early", outlookMessageId: "ol-1" }],
      during: { id: "mirror-late", outlookMessageId: "ol-2" },
      sendRow: { id: "send-1" },
    },
  ])("$name", async (c) => {
    const db = getDb();
    for (const early of c.before) await mirror(db, early);
    const sender = { provider: c.provider } as unknown as EmailSender;
    // The replacement and the insert are one batch: the only window left is
    // between the attachment read and that batch.
    const racing = interleave(db, "batch", () => mirror(db, c.during));

    await expect(
      insertSentRowReplacingEcho(
        racing as never,
        env as unknown as CloudflareBindings,
        sender,
        row(c.sendRow),
      ),
    ).resolves.toBeUndefined();

    const rows = await db
      .select({ id: sentEmails.id })
      .from(sentEmails)
      .where(sql`${sentEmails.messageId} = ${MESSAGE_ID}`);
    // As upstream: the send's row replaces every mirror of the message,
    // whenever it landed, and the mirrors' state goes with them.
    expect(rows.map((r) => r.id)).toEqual([c.sendRow.id]);
    expect(await orphanedState(db)).toBe(0);
    for (const m of [...c.before, c.during]) {
      expect(await stateOf(db, m.id!)).toBe(0);
    }
  });
});
