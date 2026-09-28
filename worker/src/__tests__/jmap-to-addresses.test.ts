// JMAP `to` lists every To address: received mail's To header as it arrived,
// and a sent message's further To (with its Bcc). `to` used to list only the
// inbox or the first address; it is immutable, so the change ships with an
// account reset (JMAP id format v4).
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { handleEmail } from "../email-handler";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestSentEmail,
  createTestUser,
  getDb,
} from "./helpers";
import { recordingSender, runJmap } from "./jmap-harness";
import { acct, rid, sid } from "./jmap-ids";

const INBOX = "support@example.com";

function inbound(headers: string[]): ForwardableEmailMessage {
  const raw = new TextEncoder().encode(
    [
      "From: Customer <customer@example.com>",
      "Subject: Several To",
      "Message-ID: <multi-1@example.com>",
      ...headers,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "hello",
    ].join("\r\n"),
  );
  return {
    from: "customer@example.com",
    to: INBOX,
    raw: new Response(raw).body!,
    rawSize: raw.byteLength,
    headers: new Headers(),
    setReject() {},
    async forward() {},
    async reply() {},
  } as unknown as ForwardableEmailMessage;
}

async function deliver(headers: string[]) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(senderIdentities)
    .values({ email: INBOX, createdAt: now, updatedAt: now });
  const pending: Promise<unknown>[] = [];
  await handleEmail(
    inbound(headers),
    env as unknown as CloudflareBindings,
    {
      waitUntil: (p: Promise<unknown>) => void pending.push(p),
      passThroughOnException() {},
    } as unknown as ExecutionContext,
  );
  await Promise.allSettled(pending);
  const [row] = await getDb()
    .select()
    .from(emails)
    .where(eq(emails.messageId, "<multi-1@example.com>"));
  return row;
}

async function jmapAddresses(userId: string, ids: string[]) {
  const { sender } = recordingSender();
  const [response] = await runJmap(
    userId,
    [
      [
        "Email/get",
        {
          accountId: acct(userId),
          ids,
          properties: ["id", "to", "cc", "bcc"],
        },
        "g",
      ],
    ],
    sender,
  );
  return (response[1] as Record<string, any>).list as Record<string, any>[];
}

describe("every To address", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("received mail lists its To header over JMAP, names included, and the web adds the others", async () => {
    const { userId, apiKey } = await createTestUser({ id: "to-user" });
    const row = await deliver([
      `To: "Support Desk" <${INBOX}>, "Second To" <Second@Example.org>`,
      "Cc: Third <third@example.net>",
    ]);
    const [email] = await jmapAddresses(userId, [rid(row.id)]);
    expect(email.to).toEqual([
      { email: INBOX, name: "Support Desk" },
      { email: "second@example.org", name: "Second To" },
    ]);
    expect(email.cc).toEqual([{ email: "third@example.net", name: "Third" }]);
    expect(email.bcc).toBeNull();

    const web = (await (
      await authFetch(`/api/messages?inbox=${encodeURIComponent(INBOX)}`, {
        apiKey,
      })
    ).json()) as { messages: Record<string, any>[] };
    const message = web.messages.find((m) => m.subject === "Several To");
    expect(message?.to).toEqual({ email: INBOX });
    expect(message?.additionalTo).toEqual([
      { email: "second@example.org", name: "Second To" },
    ]);
  });

  it("mail that reached the inbox by Cc lists only the header's To", async () => {
    const { userId } = await createTestUser({ id: "to-user" });
    const row = await deliver([
      "To: Someone <someone@example.org>",
      `Cc: ${INBOX}`,
    ]);
    const [email] = await jmapAddresses(userId, [rid(row.id)]);
    expect(email.to).toEqual([
      { email: "someone@example.org", name: "Someone" },
    ]);
  });

  it("an empty group lists no To; a group's members are flattened", async () => {
    const { userId } = await createTestUser({ id: "to-user" });
    await createTestPerson({ id: "p1", email: "c@example.com" });
    await createTestEmail({
      id: "undisclosed",
      personId: "p1",
      recipient: INBOX,
      messageId: "<u@example.com>",
      rawHeaders: JSON.stringify({ to: "undisclosed-recipients:;" }),
    });
    await createTestEmail({
      id: "grouped",
      personId: "p1",
      recipient: INBOX,
      messageId: "<g@example.com>",
      rawHeaders: JSON.stringify({
        to: `Team: a@example.org, B <b@example.org>;, ${INBOX}`,
      }),
    });
    const list = await jmapAddresses(userId, [
      rid("undisclosed"),
      rid("grouped"),
    ]);
    expect(list[0].to).toEqual([]);
    expect(list[1].to).toEqual([
      { email: "a@example.org", name: null },
      { email: "b@example.org", name: "B" },
      { email: INBOX, name: null },
    ]);
  });

  it("mail stored without a To header, or with unreadable headers, lists the inbox", async () => {
    const { userId } = await createTestUser({ id: "to-user" });
    await createTestPerson({ id: "p1", email: "c@example.com" });
    for (const [id, rawHeaders] of [
      ["no-to", "{}"],
      ["broken", "not json"],
    ]) {
      await createTestEmail({
        id,
        personId: "p1",
        recipient: INBOX,
        messageId: `<${id}@example.com>`,
        rawHeaders,
      });
    }
    await getDb()
      .update(emails)
      .set({ rawHeaders: null })
      .where(eq(emails.id, "no-to"));
    const list = await jmapAddresses(userId, [rid("no-to"), rid("broken")]);
    expect(list.map((email) => email.to)).toEqual([
      [{ email: INBOX, name: null }],
      [{ email: INBOX, name: null }],
    ]);
  });

  it("a sent message lists its further To and its Bcc", async () => {
    const { userId } = await createTestUser({ id: "to-user" });
    await createTestSentEmail({
      id: "sent-multi",
      fromAddress: INBOX,
      toAddress: "alice@example.com",
    });
    await getDb()
      .update(sentEmails)
      .set({
        additionalTo: JSON.stringify([
          { email: "bob@example.com", name: "Bob" },
        ]),
        bcc: JSON.stringify([{ email: "boss@example.com", name: null }]),
      })
      .where(eq(sentEmails.id, "sent-multi"));
    await createTestSentEmail({ id: "sent-plain", fromAddress: INBOX });
    const [multi, plain] = await jmapAddresses(userId, [
      sid("sent-multi"),
      sid("sent-plain"),
    ]);
    expect(multi.to).toEqual([
      { email: "alice@example.com", name: null },
      { email: "bob@example.com", name: "Bob" },
    ]);
    expect(multi.bcc).toEqual([{ email: "boss@example.com", name: null }]);
    expect(plain.to).toEqual([{ email: "alice@example.com", name: null }]);
    expect(plain.bcc).toBeNull();
  });
});
