// Received mail keeps the message exactly as it arrived, as its JMAP blobId,
// for the life of the Email.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { handleEmail } from "../email-handler";
import { emails } from "../db/emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { deleteEmailWithAttachments } from "../lib/delete-email";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { recordingSender, runJmap } from "./jmap-harness";
import { acct, rid } from "./jmap-ids";
import { publicReceivedRawBlobId } from "../jmap/public-ids";

const INBOX = "support@example.com";
const RAW = [
  "From: Customer <customer@example.com>",
  `To: ${INBOX}`,
  "Subject: Raw please",
  "Message-ID: <raw-1@example.com>",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "exact bytes, kept",
  "",
].join("\r\n");

async function deliver() {
  const bytes = new TextEncoder().encode(RAW);
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(senderIdentities)
    .values({ email: INBOX, createdAt: now, updatedAt: now });
  const pending: Promise<unknown>[] = [];
  await handleEmail(
    {
      from: "customer@example.com",
      to: INBOX,
      raw: new Response(bytes).body!,
      rawSize: bytes.byteLength,
      headers: new Headers(),
      setReject() {},
      async forward() {},
      async reply() {},
    } as unknown as ForwardableEmailMessage,
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
    .where(eq(emails.messageId, "<raw-1@example.com>"));
  return { row, bytes };
}

describe("received mail's raw message", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("is stored as received, byte for byte", async () => {
    const { row, bytes } = await deliver();
    expect(row.rawSize).toBe(bytes.byteLength);
    const object = await env.R2.get(row.rawR2Key!);
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes);
  });

  it("is the Email's blobId and exact size, and downloads identically", async () => {
    const { userId, apiKey } = await createTestUser({ id: "raw-admin" });
    const { row, bytes } = await deliver();
    const { sender } = recordingSender();
    const [response] = await runJmap(
      userId,
      [
        [
          "Email/get",
          {
            accountId: acct(userId),
            ids: [rid(row.id)],
            properties: ["blobId", "size"],
          },
          "g",
        ],
      ],
      sender,
    );
    const [email] = (response[1] as Record<string, any>).list;
    expect(email.blobId).toBe(publicReceivedRawBlobId(row.id));
    expect(email.size).toBe(bytes.byteLength);

    const download = await authFetch(
      `/jmap/download/${acct(userId)}/${email.blobId}/message.eml?type=message/rfc822`,
      { apiKey },
    );
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
  });

  it("is not readable by a member without the inbox", async () => {
    const { userId, apiKey } = await createTestUser({
      id: "raw-member",
      role: "member",
      email: "member@example.com",
    });
    const { row } = await deliver();
    const download = await authFetch(
      `/jmap/download/${acct(userId)}/${publicReceivedRawBlobId(row.id)}/m.eml`,
      { apiKey },
    );
    expect(download.status).toBe(404);
  });

  it("stays null for mail received before it was kept", async () => {
    const { userId } = await createTestUser({ id: "raw-old" });
    await createTestPerson({ id: "p1", email: "c@example.com" });
    await createTestEmail({ id: "old", personId: "p1" });
    const { sender } = recordingSender();
    const [response] = await runJmap(
      userId,
      [
        [
          "Email/get",
          {
            accountId: acct(userId),
            ids: [rid("old")],
            properties: ["blobId"],
          },
          "g",
        ],
      ],
      sender,
    );
    expect((response[1] as Record<string, any>).list[0].blobId).toBeNull();
  });

  it("is deleted with the person whose mail it is", async () => {
    const { apiKey } = await createTestUser({ id: "raw-person-admin" });
    const { row } = await deliver();
    const res = await authFetch(`/api/people/${row.personId}`, {
      apiKey,
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(await env.R2.get(row.rawR2Key!)).toBeNull();
  });

  it("is deleted with the email", async () => {
    const { row } = await deliver();
    await deleteEmailWithAttachments(getDb(), env.R2, row.id, {
      isAdmin: true,
    } as never);
    expect(await env.R2.get(row.rawR2Key!)).toBeNull();
  });
});
