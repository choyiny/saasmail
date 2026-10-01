import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { attachments } from "../db/attachments.schema";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { listPersonEmails } from "../lib/queries/emails";
import { searchEmails } from "../lib/queries/search";

describe("Stage 1A parity fixtures", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("snapshots the current person timeline merge and attachment enrichment", async () => {
    const db = getDb();
    await createTestPerson({
      id: "parity-person",
      email: "alice@example.com",
      name: "Alice",
    });

    await db.insert(emails).values({
      id: "recv-1",
      personId: "parity-person",
      recipient: "support@saasmail.test",
      subject: "Received subject",
      bodyHtml: "<p>Received body</p>",
      bodyText: "Received body",
      rawHeaders: "{}",
      messageId: "recv-1@example.com",
      isRead: 0,
      cc: JSON.stringify([{ email: "cc-in@example.com", name: "CC In" }]),
      conversationId: null,
      receivedAt: 300,
      createdAt: 300,
    });

    await db.insert(sentEmails).values({
      id: "sent-1",
      personId: "parity-person",
      fromAddress: "support@saasmail.test",
      toAddress: "alice@example.com",
      subject: "Sent subject",
      bodyHtml: "<p>Sent body</p>",
      bodyText: "Sent body",
      inReplyTo: "recv-1@example.com",
      messageId: "sent-1@example.com",
      status: "sent",
      cc: JSON.stringify([{ email: "cc-out@example.com", name: "CC Out" }]),
      conversationId: null,
      campaignId: "campaign-1",
      sentAt: 200,
      createdAt: 200,
    });

    await db.insert(attachments).values([
      {
        id: "att-recv",
        emailId: "recv-1",
        kind: "inbound",
        filename: "in.txt",
        contentType: "text/plain",
        size: 3,
        r2Key: "attachments/in.txt",
        contentId: null,
        createdAt: 301,
      },
      {
        id: "att-sent",
        emailId: "sent-1",
        kind: "sent",
        filename: "out.txt",
        contentType: "text/plain",
        size: 4,
        r2Key: "attachments/out.txt",
        contentId: null,
        createdAt: 201,
      },
    ]);

    const result = await listPersonEmails(
      db,
      "parity-person",
      { page: 1, limit: 50 },
      { isAdmin: true },
    );

    expect(result).toMatchInlineSnapshot(`
      {
        "emails": [
          {
            "attachmentCount": 1,
            "attachments": [
              {
                "contentId": null,
                "contentType": "text/plain",
                "createdAt": 301,
                "emailId": "recv-1",
                "filename": "in.txt",
                "id": "att-recv",
                "kind": "inbound",
                "r2Key": "attachments/in.txt",
                "size": 3,
              },
            ],
            "bodyHtml": "<p>Received body</p>",
            "bodyText": "Received body",
            "campaignId": null,
            "cc": [
              {
                "email": "cc-in@example.com",
                "name": "CC In",
              },
            ],
            "fromAddress": "alice@example.com",
            "id": "recv-1",
            "isRead": 0,
            "personId": "parity-person",
            "recipient": "support@saasmail.test",
            "status": null,
            "subject": "Received subject",
            "timestamp": 300,
            "toAddress": null,
            "type": "received",
          },
          {
            "attachmentCount": 1,
            "attachments": [
              {
                "contentId": null,
                "contentType": "text/plain",
                "createdAt": 201,
                "emailId": "sent-1",
                "filename": "out.txt",
                "id": "att-sent",
                "kind": "sent",
                "r2Key": "attachments/out.txt",
                "size": 4,
              },
            ],
            "bodyHtml": "<p>Sent body</p>",
            "bodyText": "Sent body",
            "campaignId": "campaign-1",
            "cc": [
              {
                "email": "cc-out@example.com",
                "name": "CC Out",
              },
            ],
            "fromAddress": "support@saasmail.test",
            "id": "sent-1",
            "isRead": null,
            "personId": "parity-person",
            "recipient": null,
            "status": "sent",
            "subject": "Sent subject",
            "timestamp": 200,
            "toAddress": "alice@example.com",
            "type": "sent",
          },
        ],
        "inboxes": [
          {
            "displayMode": "chat",
            "displayName": null,
            "email": "support@saasmail.test",
          },
        ],
      }
    `);
  });

  it("snapshots the current full-text search merge", async () => {
    const db = getDb();
    await createTestPerson({
      id: "search-person",
      email: "searcher@example.com",
      name: "Searcher",
    });

    await db.insert(emails).values({
      id: "search-recv",
      personId: "search-person",
      recipient: "support@saasmail.test",
      subject: "Quarterly invoice",
      bodyHtml: "<p>Invoice received</p>",
      bodyText: "Invoice details received",
      rawHeaders: "{}",
      messageId: "search-recv@example.com",
      isRead: 0,
      conversationId: null,
      receivedAt: 500,
      createdAt: 500,
    });

    await db.insert(sentEmails).values({
      id: "search-sent",
      personId: "search-person",
      fromAddress: "support@saasmail.test",
      toAddress: "searcher@example.com",
      subject: "Invoice follow-up",
      bodyHtml: "<p>Invoice sent</p>",
      bodyText: "Invoice details sent",
      messageId: "search-sent@example.com",
      status: "sent",
      conversationId: null,
      sentAt: 400,
      createdAt: 400,
    });

    const result = await searchEmails(
      db,
      { q: "invoice", limit: 50, offset: 0 },
      { isAdmin: true },
    );

    expect(result).toMatchInlineSnapshot(`
      {
        "hasMore": false,
        "hits": [
          {
            "id": "search-recv",
            "inbox": "support@saasmail.test",
            "isRead": 0,
            "personEmail": "searcher@example.com",
            "personId": "search-person",
            "personName": "Searcher",
            "snippet": "Invoice details received",
            "subject": "Quarterly invoice",
            "timestamp": 500,
            "type": "received",
          },
          {
            "id": "search-sent",
            "inbox": "support@saasmail.test",
            "isRead": null,
            "personEmail": "searcher@example.com",
            "personId": "search-person",
            "personName": "Searcher",
            "snippet": "Invoice details sent",
            "subject": "Invoice follow-up",
            "timestamp": 400,
            "type": "sent",
          },
        ],
        "truncated": false,
      }
    `);
  });

  it("snapshots the current group conversation response", async () => {
    const db = getDb();
    const { apiKey } = await createTestUser({
      id: "parity-admin",
      email: "parity-admin@example.com",
    });
    await createTestPerson({
      id: "conversation-person",
      email: "threader@example.com",
      name: "Threader",
    });

    await db.insert(emails).values({
      id: "conv-recv",
      personId: "conversation-person",
      recipient: "support@saasmail.test",
      subject: "Thread received",
      bodyHtml: "<p>First</p>",
      bodyText: "First",
      rawHeaders: "{}",
      messageId: "conv-recv@example.com",
      isRead: 0,
      cc: null,
      conversationId: "conversation-parity",
      receivedAt: 700,
      createdAt: 700,
    });

    await db.insert(sentEmails).values({
      id: "conv-sent",
      personId: "conversation-person",
      fromAddress: "support@saasmail.test",
      toAddress: "threader@example.com",
      subject: "Thread sent",
      bodyHtml: "<p>Second</p>",
      bodyText: "Second",
      messageId: "conv-sent@example.com",
      status: "sent",
      cc: null,
      conversationId: "conversation-parity",
      sentAt: 800,
      createdAt: 800,
    });

    await db.insert(attachments).values([
      {
        id: "conv-recv-att",
        emailId: "conv-recv",
        kind: "inbound",
        filename: "first.txt",
        contentType: "text/plain",
        size: 5,
        r2Key: "attachments/first.txt",
        contentId: null,
        createdAt: 701,
      },
      {
        id: "conv-sent-att",
        emailId: "conv-sent",
        kind: "sent",
        filename: "second.txt",
        contentType: "text/plain",
        size: 6,
        r2Key: "attachments/second.txt",
        contentId: null,
        createdAt: 801,
      },
    ]);

    const res = await authFetch(
      "/api/conversations/conversation-parity/emails",
      { apiKey },
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchInlineSnapshot(`
      {
        "conversation": {
          "id": "conversation-parity",
          "inbox": "support@saasmail.test",
          "participants": [
            {
              "email": "threader@example.com",
              "id": "conversation-person",
              "name": "Threader",
            },
          ],
        },
        "emails": [
          {
            "attachmentCount": 1,
            "attachments": [
              {
                "contentId": null,
                "contentType": "text/plain",
                "createdAt": 701,
                "emailId": "conv-recv",
                "filename": "first.txt",
                "id": "conv-recv-att",
                "kind": "inbound",
                "r2Key": "attachments/first.txt",
                "size": 5,
              },
            ],
            "bodyHtml": "<p>First</p>",
            "bodyText": "First",
            "cc": [],
            "fromAddress": "threader@example.com",
            "id": "conv-recv",
            "isRead": 0,
            "personId": "conversation-person",
            "recipient": "support@saasmail.test",
            "subject": "Thread received",
            "timestamp": 700,
            "toAddress": null,
            "type": "received",
          },
          {
            "attachmentCount": 1,
            "attachments": [
              {
                "contentId": null,
                "contentType": "text/plain",
                "createdAt": 801,
                "emailId": "conv-sent",
                "filename": "second.txt",
                "id": "conv-sent-att",
                "kind": "sent",
                "r2Key": "attachments/second.txt",
                "size": 6,
              },
            ],
            "bodyHtml": "<p>Second</p>",
            "bodyText": "Second",
            "cc": [],
            "fromAddress": "support@saasmail.test",
            "id": "conv-sent",
            "isRead": null,
            "personId": "conversation-person",
            "recipient": null,
            "subject": "Thread sent",
            "timestamp": 800,
            "toAddress": "threader@example.com",
            "type": "sent",
          },
        ],
      }
    `);

    const [storedSent] = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, "conv-sent"));
    expect(storedSent.conversationId).toBe("conversation-parity");
  });
});
