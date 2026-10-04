// docs/specs/SPEC-mail-export.md: export a mailbox as mbox, and any message
// as .eml.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { asyncJobs } from "../db/async-jobs.schema";
import { emails } from "../db/emails.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { queryMessages } from "../lib/messages/query";
import type { UnifiedMessage } from "../lib/messages/types";
import {
  asctime,
  mboxEntry,
  renderMessageBytes,
} from "../lib/export/render-message";
import {
  ExportRunningError,
  ExportSliceBusyError,
  PART_BYTES,
  deleteMailExport,
  exportParams,
  reapMailExports,
  runMailExportSlice,
  startMailExport,
} from "../lib/export/mail-export";
import {
  MAIL_EXPORT_MAX_ATTEMPTS,
  classifyQueueMessage,
  handleQueueBatch,
} from "../lib/queue-router";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestAttachment,
  createTestEmail,
  createTestPerson,
  createTestSentEmail,
  createTestUser,
  getDb,
} from "./helpers";

const INBOX = "support@saasmail.test";
const admin = { isAdmin: true as const };
const decoder = new TextDecoder();

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
});

async function messageOf(kind: "received" | "sent", id: string) {
  const page = await queryMessages(getDb(), admin, {
    messageRef: { kind, id },
    limit: 1,
    withAttachments: true,
  });
  return page.messages[0] as UnifiedMessage;
}

async function rendered(kind: "received" | "sent", id: string) {
  return renderMessageBytes(getDb(), env, await messageOf(kind, id));
}

/** The decoded body of the MIME part with this content type. */
function partText(source: string, contentType: string): string {
  const start = source.indexOf(`Content-Type: ${contentType}`);
  expect(start).toBeGreaterThan(-1);
  const body = source.slice(source.indexOf("\r\n\r\n", start) + 4);
  const base64 = body.slice(0, body.indexOf("\r\n--")).replace(/\r\n/g, "");
  return decoder.decode(
    Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
  );
}

/** Separator lines of an mbox file. */
function separators(mbox: string): string[] {
  return mbox
    .split("\n")
    .filter((line) =>
      /^From \S+ \w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/.test(line),
    );
}

async function runAll(jobId: string): Promise<number> {
  let slice: number | null = 0;
  let runs = 0;
  while (slice !== null) {
    slice = await runMailExportSlice(getDb(), env, jobId, slice);
    runs++;
  }
  return runs;
}

async function jobRow(id: string) {
  const [job] = await getDb()
    .select()
    .from(asyncJobs)
    .where(eq(asyncJobs.id, id));
  return job;
}

async function exportedText(jobId: string): Promise<string> {
  const job = await jobRow(jobId);
  const object = await env.R2.get(job.storageKey!);
  expect(object).not.toBeNull();
  return object!.text();
}

/** Received mail, one a minute from `start`, oldest first. */
async function bulkReceived(count: number, start = 1_750_000_000) {
  await getDb().run(sql`
    INSERT INTO emails (id, person_id, recipient, subject, body_text, raw_headers, message_id, is_read, received_at, created_at)
    SELECT 'bulk-' || printf('%03d', value), 'p1', ${INBOX},
      'Message ' || printf('%03d', value), 'Body ' || value, '{}',
      '<bulk-' || value || '@example.com>', 1, ${start} + value * 60, ${start}
    FROM json_each(${JSON.stringify(Array.from({ length: count }, (_, i) => i))})
  `);
}

describe("renderMessageBytes", () => {
  beforeEach(async () => {
    await createTestPerson({ id: "p1", email: "alice@example.com" });
  });

  it("returns received mail's kept bytes as they are", async () => {
    const raw =
      "From: alice@example.com\r\nSubject: Kept\r\n\r\nExact body\r\n";
    await env.R2.put("raw/exact-1.eml", raw);
    await createTestEmail({ id: "e1", personId: "p1", recipient: INBOX });
    await getDb()
      .update(emails)
      .set({ rawR2Key: "raw/exact-1.eml" })
      .where(eq(emails.id, "e1"));

    const result = await rendered("received", "e1");
    expect(result.exact).toBe(true);
    expect(decoder.decode(result.bytes)).toBe(raw);
    expect(result.envelopeFrom).toBe("alice@example.com");
  });

  it("returns a JMAP send's stored message", async () => {
    const raw =
      "From: support@saasmail.test\r\nSubject: Via JMAP\r\n\r\nHi\r\n";
    await env.R2.put("jmap/raw/c1", raw);
    await getDb().run(sql`
      INSERT INTO jmap_message_content (id, inbox, from_json, to_json, cc_json, bcc_json, subject, message_id, sent_at, parts_json, text_body_json, html_body_json, attachments_json, body_values_json, preview, thread_key, raw_r2_key, size, created_at)
      VALUES ('c1', ${INBOX}, '{}', '[]', '[]', '[]', 'Via JMAP', 'c1@saasmail.test', '2026-10-03T10:00:00Z', '{}', '[]', '[]', '[]', '{}', '', 't1', 'jmap/raw/c1', ${raw.length}, 0)
    `);
    await createTestSentEmail({ id: "s1", fromAddress: INBOX });
    await getDb().run(
      sql`UPDATE sent_emails SET jmap_content_id = 'c1' WHERE id = 's1'`,
    );

    const result = await rendered("sent", "s1");
    expect(result.exact).toBe(true);
    expect(decoder.decode(result.bytes)).toBe(raw);
  });

  it("rebuilds a web send: headers, both bodies, attachments, the marker", async () => {
    await createTestSentEmail({
      id: "s1",
      fromAddress: INBOX,
      toAddress: "alice@example.com",
      cc: JSON.stringify([{ email: "carol@example.com", name: "Carol" }]),
      subject: "Your invoice",
      bodyText: "See attached.\nFrom the team",
      bodyHtml:
        '<p>See attached.</p><img src="/api/attachments/a-inline/inline">',
      messageId: "<s1@saasmail.test>",
      sentAt: 1_790_000_000,
    });
    await env.R2.put("att/invoice.pdf", new Uint8Array([1, 2, 3, 4]));
    await env.R2.put("att/logo.png", new Uint8Array([9, 9]));
    await createTestAttachment({
      id: "a-file",
      emailId: "s1",
      kind: "sent",
      filename: "invoice.pdf",
      contentType: "application/pdf",
      r2Key: "att/invoice.pdf",
    });
    await createTestAttachment({
      id: "a-inline",
      emailId: "s1",
      kind: "sent",
      filename: "logo.png",
      contentType: "image/png",
      r2Key: "att/logo.png",
      contentId: "<logo@saasmail>",
    });

    const result = await rendered("sent", "s1");
    const text = decoder.decode(result.bytes);
    expect(result.exact).toBe(false);
    expect(text).toContain("Date: Mon, 21 Sep 2026 14:13:20 +0000\r\n");
    expect(text).toContain(`From: ${INBOX}\r\n`);
    expect(text).toContain("To: alice@example.com\r\n");
    expect(text).toContain("Cc: Carol <carol@example.com>\r\n");
    expect(text).toContain("Subject: Your invoice\r\n");
    expect(text).toContain("Message-ID: <s1@saasmail.test>\r\n");
    expect(text).toContain("X-Saasmail-Reconstructed: yes\r\n");
    expect(text).toContain("multipart/mixed");
    expect(text).toContain("multipart/alternative");
    expect(partText(text, "text/plain")).toBe("See attached.\r\nFrom the team");
    // The inline image points back at its Content-ID.
    expect(partText(text, "text/html")).toContain('src="cid:logo@saasmail"');
    expect(text).toContain(
      'Content-Disposition: attachment; filename="invoice.pdf"',
    );
    expect(text).toContain("Content-ID: <logo@saasmail>");
    expect(text).toContain("AQIDBA=="); // 1, 2, 3, 4

    // The same message renders to the same bytes (retried slices).
    const again = await rendered("sent", "s1");
    expect(decoder.decode(again.bytes)).toBe(text);
  });

  it("never lets a stored value add a header", async () => {
    await createTestEmail({
      id: "e1",
      personId: "p1",
      recipient: INBOX,
      subject: "Hi\r\nBcc: victim@example.com",
      messageId: "<e1@example.com>",
      inReplyTo: "<a@x>\r\nX-Injected: 1",
      referencesHeader: "<a@x>\nX-Injected: 2",
      rawHeaders: JSON.stringify({ "list-id": "<a>\r\nX-Injected: 3" }),
    });
    await env.R2.put("att/x.txt", "x");
    await createTestAttachment({
      id: "a1",
      emailId: "e1",
      filename: 'a"\r\nX-Injected: 4.txt',
      contentType: "text/plain\r\nX-Injected: 5",
      r2Key: "att/x.txt",
      contentId: "<cid>\r\nX-Injected: 6",
    });
    const text = decoder.decode((await rendered("received", "e1")).bytes);
    expect(text).not.toMatch(/\r\n(Bcc|X-Injected):/);
    expect(text).toContain("Subject: Hi Bcc: victim@example.com\r\n");
  });

  it("folds long headers", async () => {
    const references = Array.from(
      { length: 80 },
      (_, i) => `<thread-${i}@example.com>`,
    ).join(" ");
    await createTestEmail({
      id: "e1",
      personId: "p1",
      recipient: INBOX,
      messageId: "<e1@example.com>",
      referencesHeader: references,
      subject: "Ünïcödé ".repeat(20),
    });
    const text = decoder.decode((await rendered("received", "e1")).bytes);
    expect(text).toContain(
      "References: <thread-0@example.com>\r\n <thread-1@example.com>\r\n",
    );
    for (const line of text.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(998);
    }
    // RFC 2047: encoded words of at most 75 characters, one per line.
    const words = text.match(/=\?UTF-8\?B\?[^?]*\?=/g) ?? [];
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) expect(word.length).toBeLessThanOrEqual(75);
  });

  it("rebuilds older received mail with its stored headers", async () => {
    await createTestEmail({
      id: "e1",
      personId: "p1",
      recipient: INBOX,
      subject: "Grüße",
      messageId: "<e1@example.com>",
      rawHeaders: JSON.stringify({
        "list-id": "<news.example.com>",
        "x-internal": "dropped",
      }),
    });
    const text = decoder.decode((await rendered("received", "e1")).bytes);
    expect(text).toContain("From: ");
    expect(text).toContain(`To: ${INBOX}\r\n`);
    expect(text).toContain("Subject: =?UTF-8?B?");
    expect(text).toContain("list-id: <news.example.com>\r\n");
    expect(text).not.toContain("x-internal");
    expect(partText(text, "text/plain")).toBe("Hello");
  });
});

describe("mboxEntry", () => {
  it("quotes From lines mboxrd-style and ends with a blank line", () => {
    const date = new Date(Date.UTC(2026, 9, 3, 14, 2, 0));
    const entry = decoder.decode(
      mboxEntry({
        bytes: new TextEncoder().encode(
          "Subject: x\r\n\r\nFrom here\r\n>From there\r\n>>From far\r\nFromage\r\n From indented",
        ),
        exact: true,
        envelopeFrom: "alice@example.com",
        date,
      }),
    );
    expect(asctime(date)).toBe("Sat Oct  3 14:02:00 2026");
    expect(entry).toBe(
      "From alice@example.com Sat Oct  3 14:02:00 2026\n" +
        "Subject: x\n\n>From here\n>>From there\n>>>From far\nFromage\n From indented\n\n",
    );
  });
});

describe("the export job", () => {
  let userId: string;

  beforeEach(async () => {
    ({ userId } = await createTestUser({ id: "admin-1" }));
    await createTestPerson({ id: "p1", email: "alice@example.com" });
  });

  it("writes 450 messages in three slices, oldest first, each once", async () => {
    await bulkReceived(450);
    const job = await startMailExport(getDb(), env, { inbox: INBOX, userId });
    const slices: (number | null)[] = [];
    let slice: number | null = 0;
    while (slice !== null) {
      slice = await runMailExportSlice(getDb(), env, job.id, slice);
      slices.push(slice);
    }
    // Three rendering slices (200, 200, 50), then the completion.
    expect(slices).toEqual([1, 2, 3, null]);

    const mbox = await exportedText(job.id);
    expect(separators(mbox)).toHaveLength(450);
    const subjects = [...mbox.matchAll(/^Subject: (.*)$/gm)].map((m) => m[1]);
    expect(subjects).toEqual(
      Array.from(
        { length: 450 },
        (_, i) => `Message ${String(i).padStart(3, "0")}`,
      ),
    );
    const done = await jobRow(job.id);
    expect(done.status).toBe("completed");
    expect(done.processedRows).toBe(450);
    expect(done.totalRows).toBe(450);
    expect(exportParams(done).bytes).toBe(
      new TextEncoder().encode(mbox).length,
    );
    // Nothing is left behind but the file.
    const listed = await env.R2.list({ prefix: `exports/${job.id}/` });
    expect(listed.objects.map((object) => object.key)).toEqual([
      done.storageKey,
    ]);
  });

  it("resumes a failed slice without writing anything twice", async () => {
    await bulkReceived(450);
    const job = await startMailExport(getDb(), env, { inbox: INBOX, userId });
    expect(await runMailExportSlice(getDb(), env, job.id, 0)).toBe(1);

    // Slice 1 dies after two pages.
    let calls = 0;
    const failing = () => {
      if (++calls === 5) throw new Error("worker died");
      return Date.now();
    };
    await expect(
      runMailExportSlice(getDb(), env, job.id, 1, failing),
    ).rejects.toThrow("worker died");
    expect((await jobRow(job.id)).processedRows).toBe(200);

    // The retry runs at once (the claim was freed) and the export is whole.
    let slice: number | null = 1;
    while (slice !== null) {
      slice = await runMailExportSlice(getDb(), env, job.id, slice);
    }
    const mbox = await exportedText(job.id);
    expect(separators(mbox)).toHaveLength(450);
    const subjects = new Set(
      [...mbox.matchAll(/^Subject: (.*)$/gm)].map((m) => m[1]),
    );
    expect(subjects.size).toBe(450);

    // A late duplicate of an old slice changes nothing.
    expect(await runMailExportSlice(getDb(), env, job.id, 0)).toBeNull();
    expect(await exportedText(job.id)).toBe(mbox);
  });

  it("refuses a slice another run holds", async () => {
    await bulkReceived(3);
    const job = await startMailExport(getDb(), env, { inbox: INBOX, userId });
    const params = exportParams(job);
    await getDb()
      .update(asyncJobs)
      .set({
        params: JSON.stringify({
          ...params,
          lease: "other",
          leaseUntil: Date.now() + 60_000,
        }),
      })
      .where(eq(asyncJobs.id, job.id));
    await expect(
      runMailExportSlice(getDb(), env, job.id, 0),
    ).rejects.toBeInstanceOf(ExportSliceBusyError);

    // Once the claim has run out, the slice runs.
    expect(
      await runMailExportSlice(
        getDb(),
        env,
        job.id,
        0,
        () => Date.now() + 120_000,
      ),
    ).toBe(1);
  });

  it("uploads parts of equal size when the file is large", async () => {
    // Three messages with 3 MiB attachments: about 12.6 MiB of mbox.
    const big = new Uint8Array(3 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    await env.R2.put("att/big.bin", big);
    for (const n of [1, 2, 3]) {
      await createTestEmail({
        id: `big-${n}`,
        personId: "p1",
        recipient: INBOX,
        subject: `Big ${n}`,
        messageId: `<big-${n}@example.com>`,
      });
      await createTestAttachment({
        id: `att-${n}`,
        emailId: `big-${n}`,
        filename: "big.bin",
        contentType: "application/octet-stream",
        size: big.length,
        r2Key: "att/big.bin",
      });
    }
    const job = await startMailExport(getDb(), env, { inbox: INBOX, userId });
    // 4.2 MiB entries: two rendering slices (the second carries 3.4 MiB
    // in), then the completion.
    expect(await runAll(job.id)).toBe(3);

    const done = await jobRow(job.id);
    const params = exportParams(done);
    expect(params.parts).toHaveLength(2);
    const object = await env.R2.get(done.storageKey!);
    expect(object!.size).toBe(params.bytes);
    expect(object!.size).toBeGreaterThan(2 * PART_BYTES);
    expect(object!.httpMetadata?.contentType).toBe("application/mbox");
    expect(separators(await object!.text())).toHaveLength(3);
  });

  it("leaves Trash and campaign sends out unless asked", async () => {
    await createTestEmail({
      id: "e1",
      personId: "p1",
      recipient: INBOX,
      messageId: "<e1@x>",
    });
    await createTestEmail({
      id: "e2",
      personId: "p1",
      recipient: INBOX,
      messageId: "<e2@x>",
    });
    await getDb().run(sql`
      INSERT INTO mailbox_message_state (inbox, message_kind, message_id, trashed_at, updated_at)
      VALUES (${INBOX}, 'received', 'e2', 1, 1)
    `);
    await createTestSentEmail({ id: "s1", fromAddress: INBOX });
    await createTestSentEmail({
      id: "s2",
      fromAddress: INBOX,
      campaignId: "c1",
    });

    const plain = await startMailExport(getDb(), env, { inbox: INBOX, userId });
    await runAll(plain.id);
    expect(separators(await exportedText(plain.id))).toHaveLength(2);

    const everything = await startMailExport(getDb(), env, {
      inbox: INBOX,
      userId,
      includeTrash: true,
      includeCampaignSends: true,
    });
    await runAll(everything.id);
    expect(separators(await exportedText(everything.id))).toHaveLength(4);
  });

  it("keeps to the date range", async () => {
    await bulkReceived(10, 1_750_000_000);
    const job = await startMailExport(getDb(), env, {
      inbox: INBOX,
      userId,
      from: 1_750_000_000 + 2 * 60,
      to: 1_750_000_000 + 4 * 60,
    });
    await runAll(job.id);
    const subjects = [
      ...(await exportedText(job.id)).matchAll(/^Subject: (.*)$/gm),
    ].map((m) => m[1]);
    expect(subjects).toEqual(["Message 002", "Message 003", "Message 004"]);
  });

  it("carries folder state in X-Saasmail headers", async () => {
    await createTestEmail({
      id: "e1",
      personId: "p1",
      recipient: INBOX,
      messageId: "<e1@x>",
      subject: "Starred",
    });
    await createTestEmail({
      id: "e2",
      personId: "p1",
      recipient: INBOX,
      messageId: "<e2@x>",
      subject: "Junked",
    });
    await createTestEmail({
      id: "e3",
      personId: "p1",
      recipient: INBOX,
      messageId: "<e3@x>",
      subject: "Archived",
    });
    await createTestSentEmail({
      id: "s1",
      fromAddress: INBOX,
      subject: "Sent one",
    });
    await getDb().run(sql`
      INSERT INTO mailbox_message_state (inbox, message_kind, message_id, spam_at, archived_at, updated_at)
      VALUES (${INBOX}, 'received', 'e2', 1, NULL, 1), (${INBOX}, 'received', 'e3', NULL, 1, 1)
    `);
    await getDb().run(sql`
      INSERT INTO message_user_state (user_id, message_kind, message_id, seen_at, starred_at, updated_at)
      VALUES (${userId}, 'received', 'e1', 1, 1, 1)
    `);
    await getDb().run(sql`
      INSERT INTO mailboxes (id, inbox, name, created_at, updated_at)
      VALUES ('mb1', ${INBOX}, 'Clients, VIP', 1, 1)
    `);
    await getDb().run(sql`
      INSERT INTO message_mailboxes (message_kind, message_id, mailbox_id, added_at)
      VALUES ('received', 'e1', 'mb1', 1)
    `);

    const job = await startMailExport(getDb(), env, { inbox: INBOX, userId });
    await runAll(job.id);
    const mbox = await exportedText(job.id);
    const entryOf = (subject: string) =>
      mbox
        .split(/\n\n(?=From \S+ \w{3} \w{3} )/)
        .find((entry) => entry.includes(`Subject: ${subject}\n`))!;

    expect(entryOf("Starred")).toContain(
      'X-Saasmail-Labels: Inbox, Starred, "Clients, VIP"\n',
    );
    expect(entryOf("Starred")).toContain("X-Saasmail-Seen: yes\n");
    expect(entryOf("Starred")).toContain("X-Saasmail-Person: p1\n");
    expect(entryOf("Junked")).toContain("X-Saasmail-Labels: Junk\n");
    expect(entryOf("Junked")).toContain("X-Saasmail-Seen: no\n");
    expect(entryOf("Archived")).toContain("X-Saasmail-Labels: \n");
    expect(entryOf("Sent one")).toContain("X-Saasmail-Labels: Sent\n");
  });

  it("allows one running export per inbox", async () => {
    await startMailExport(getDb(), env, { inbox: INBOX, userId });
    await expect(
      startMailExport(getDb(), env, { inbox: INBOX.toUpperCase(), userId }),
    ).rejects.toBeInstanceOf(ExportRunningError);
  });

  it("expires week-old files, with everything under them", async () => {
    const now = Math.floor(Date.now() / 1000);
    await bulkReceived(2);
    const old = await startMailExport(getDb(), env, { inbox: INBOX, userId });
    await runAll(old.id);
    await env.R2.put(`exports/${old.id}/pending-left`, "x");
    await getDb()
      .update(asyncJobs)
      .set({ updatedAt: now - 8 * 24 * 60 * 60 })
      .where(eq(asyncJobs.id, old.id));
    const fresh = await startMailExport(getDb(), env, {
      inbox: "other@saasmail.test",
      userId,
    });
    await runAll(fresh.id);

    expect(await reapMailExports(getDb(), env, now)).toEqual({
      expired: 1,
      resumed: 0,
      failed: 0,
    });
    expect((await jobRow(old.id)).status).toBe("expired");
    expect(
      (await env.R2.list({ prefix: `exports/${old.id}/` })).objects,
    ).toEqual([]);
    expect((await jobRow(fresh.id)).status).toBe("completed");
    expect(await env.R2.head(fresh.storageKey!)).not.toBeNull();
  });

  it("queues an export that stopped moving again, then fails it", async () => {
    const queue = (env as any).EMAIL_QUEUE;
    const sent: unknown[] = [];
    (env as any).EMAIL_QUEUE = {
      send: async (body: unknown) => void sent.push(body),
    };
    try {
      const now = Math.floor(Date.now() / 1000);
      await bulkReceived(2);
      const job = await startMailExport(getDb(), env, { inbox: INBOX, userId });
      const idle = (params: Partial<ReturnType<typeof exportParams>>) =>
        getDb()
          .update(asyncJobs)
          .set({
            updatedAt: now - 20 * 60,
            params: JSON.stringify({
              ...exportParams(job),
              ...params,
            }),
          })
          .where(eq(asyncJobs.id, job.id));

      // A run still holding its claim is left alone.
      await idle({ lease: "live", leaseUntil: now * 1000 + 60_000 });
      expect(await reapMailExports(getDb(), env, now)).toMatchObject({
        resumed: 0,
      });

      await idle({ lease: "dead", leaseUntil: now * 1000 - 1 });
      expect(await reapMailExports(getDb(), env, now)).toMatchObject({
        resumed: 1,
        failed: 0,
      });
      expect(sent).toEqual([{ type: "mail_export", jobId: job.id, slice: 0 }]);
      const resumed = await jobRow(job.id);
      expect(resumed.status).toBe("running");
      expect(exportParams(resumed)).toMatchObject({
        recoveries: 1,
        lease: null,
      });
      // The queued slice runs.
      expect(await runMailExportSlice(getDb(), env, job.id, 0)).toBe(1);

      // The fourth time it stalls, it has failed.
      await env.R2.put(`exports/${job.id}/pending-left`, "x");
      await idle({ recoveries: 3 });
      expect(await reapMailExports(getDb(), env, now)).toMatchObject({
        resumed: 0,
        failed: 1,
      });
      expect((await jobRow(job.id)).status).toBe("failed");
      expect(
        (await env.R2.list({ prefix: `exports/${job.id}/` })).objects,
      ).toEqual([]);
    } finally {
      (env as any).EMAIL_QUEUE = queue;
    }
  });

  describe("across slices", () => {
    /** Four messages with 2 MiB attachments: about 2.7 MiB of mbox each. */
    beforeEach(async () => {
      const blob = new Uint8Array(2 * 1024 * 1024);
      for (let i = 0; i < blob.length; i++) blob[i] = (i * 7) % 256;
      await env.R2.put("att/two.bin", blob);
      for (const n of [1, 2, 3, 4]) {
        await createTestEmail({
          id: `big-${n}`,
          personId: "p1",
          recipient: INBOX,
          subject: `Big ${n}`,
          messageId: `<big-${n}@example.com>`,
        });
        await createTestAttachment({
          id: `att-${n}`,
          emailId: `big-${n}`,
          filename: "two.bin",
          contentType: "application/octet-stream",
          size: blob.length,
          r2Key: "att/two.bin",
        });
      }
    });

    async function checkFile(jobId: string) {
      const done = await jobRow(jobId);
      expect(done.status).toBe("completed");
      const object = await env.R2.get(done.storageKey!);
      const mbox = await object!.text();
      expect(object!.size).toBe(exportParams(done).bytes);
      expect([...mbox.matchAll(/^Subject: (.*)$/gm)].map((m) => m[1])).toEqual([
        "Big 1",
        "Big 2",
        "Big 3",
        "Big 4",
      ]);
      expect(separators(mbox)).toHaveLength(4);
      const listed = await env.R2.list({ prefix: `exports/${jobId}/` });
      expect(listed.objects.map((o) => o.key)).toEqual([done.storageKey]);
    }

    it("carries bytes short of a part into the next slice", async () => {
      const job = await startMailExport(getDb(), env, { inbox: INBOX, userId });
      // Slice 0 stops after the message passing 8 MiB, with one part up and
      // 3.2 MiB carried; slice 1 fills a second part and carries the rest,
      // which completion uploads as the last part.
      expect(await runMailExportSlice(getDb(), env, job.id, 0)).toBe(1);
      const afterFirst = exportParams(await jobRow(job.id));
      expect(afterFirst.parts).toHaveLength(1);
      expect(afterFirst.pendingKey).not.toBeNull();
      expect((await jobRow(job.id)).processedRows).toBe(3);
      expect(await runMailExportSlice(getDb(), env, job.id, 1)).toBe(2);
      expect(exportParams(await jobRow(job.id)).parts).toHaveLength(2);
      expect(await env.R2.head(afterFirst.pendingKey!)).toBeNull();
      expect(await runMailExportSlice(getDb(), env, job.id, 2)).toBeNull();
      await checkFile(job.id);
    });

    it("re-uploads a part after a slice failed past it", async () => {
      const job = await startMailExport(getDb(), env, { inbox: INBOX, userId });
      expect(await runMailExportSlice(getDb(), env, job.id, 0)).toBe(1);
      // Slice 1 dies after uploading part 2, before committing.
      let calls = 0;
      const failing = () => {
        if (++calls === 3) throw new Error("worker died");
        return Date.now();
      };
      await expect(
        runMailExportSlice(getDb(), env, job.id, 1, failing),
      ).rejects.toThrow("worker died");
      expect(exportParams(await jobRow(job.id)).parts).toHaveLength(1);

      expect(await runMailExportSlice(getDb(), env, job.id, 1)).toBe(2);
      expect(await runMailExportSlice(getDb(), env, job.id, 2)).toBeNull();
      await checkFile(job.id);
    });

    it("leaves nothing behind when cancelled between slices", async () => {
      const job = await startMailExport(getDb(), env, { inbox: INBOX, userId });
      expect(await runMailExportSlice(getDb(), env, job.id, 0)).toBe(1);
      await deleteMailExport(getDb(), env, await jobRow(job.id));
      expect(await runMailExportSlice(getDb(), env, job.id, 1)).toBeNull();
      expect(
        (await env.R2.list({ prefix: `exports/${job.id}/` })).objects,
      ).toEqual([]);
    });
  });

  it("keeps Reply-To in rebuilt messages", async () => {
    await createTestEmail({
      id: "e1",
      personId: "p1",
      recipient: INBOX,
      messageId: "<e1@x>",
      replyTo: JSON.stringify([{ email: "billing@other.example", name: null }]),
    });
    const job = await startMailExport(getDb(), env, { inbox: INBOX, userId });
    await runAll(job.id);
    expect(await exportedText(job.id)).toContain(
      "Reply-To: billing@other.example\n",
    );
  });

  it("starts one export when two requests race", async () => {
    const results = await Promise.allSettled([
      startMailExport(getDb(), env, { inbox: INBOX, userId }),
      startMailExport(getDb(), env, { inbox: INBOX, userId }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    expect(rejected?.reason).toBeInstanceOf(ExportRunningError);
    const rows = await getDb()
      .select()
      .from(asyncJobs)
      .where(eq(asyncJobs.status, "running"));
    expect(rows).toHaveLength(1);
  });
});

describe("the mail_export queue message", () => {
  const queue = (env as any).EMAIL_QUEUE;
  let sent: unknown[];

  beforeEach(async () => {
    sent = [];
    (env as any).EMAIL_QUEUE = {
      send: async (body: unknown) => void sent.push(body),
    };
    await createTestUser({ id: "admin-1" });
    await createTestPerson({ id: "p1", email: "alice@example.com" });
  });

  afterEach(() => {
    (env as any).EMAIL_QUEUE = queue;
  });

  function batchOf(body: unknown, attempts = 1) {
    const acked: number[] = [];
    const retried: (number | undefined)[] = [];
    return {
      batch: {
        queue: "saasmail-sequence-emails",
        messages: [
          {
            id: "0",
            timestamp: new Date(),
            body,
            attempts,
            ack: () => void acked.push(0),
            retry: (options?: { delaySeconds?: number }) =>
              void retried.push(options?.delaySeconds),
          },
        ],
        ackAll: () => {},
        retryAll: () => {},
      } as unknown as MessageBatch<unknown>,
      acked,
      retried,
    };
  }

  it("is recognised, runs a slice and queues the next", async () => {
    expect(
      classifyQueueMessage({ type: "mail_export", jobId: "j", slice: 0 }),
    ).toBe("mail_export");
    expect(classifyQueueMessage({ type: "mail_export", jobId: "j" })).toBe(
      "unknown",
    );

    await bulkReceived(2);
    const job = await startMailExport(getDb(), env, {
      inbox: INBOX,
      userId: "admin-1",
    });
    const run = batchOf({ type: "mail_export", jobId: job.id, slice: 0 });
    await handleQueueBatch(run.batch, env);
    expect(run.acked).toEqual([0]);
    expect(sent).toEqual([{ type: "mail_export", jobId: job.id, slice: 1 }]);
  });

  it("runs one export slice per batch and queues the others again", async () => {
    await bulkReceived(2);
    const first = await startMailExport(getDb(), env, {
      inbox: INBOX,
      userId: "admin-1",
    });
    const second = await startMailExport(getDb(), env, {
      inbox: "other@saasmail.test",
      userId: "admin-1",
    });
    const acked: number[] = [];
    const retried: number[] = [];
    const messages = [first, second].map((job, i) => ({
      id: String(i),
      timestamp: new Date(),
      body: { type: "mail_export", jobId: job.id, slice: 0 },
      attempts: 1,
      ack: () => void acked.push(i),
      retry: () => void retried.push(i),
    }));
    await handleQueueBatch(
      {
        queue: "saasmail-sequence-emails",
        messages,
        ackAll: () => {},
        retryAll: () => {},
      } as unknown as MessageBatch<unknown>,
      env,
    );
    expect(acked).toEqual([0, 1]);
    expect(retried).toEqual([]);
    expect(sent).toEqual([
      { type: "mail_export", jobId: first.id, slice: 1 },
      { type: "mail_export", jobId: second.id, slice: 0 },
    ]);
    expect(exportParams(await jobRow(second.id)).slice).toBe(0);
  });

  it("fails the export after the last attempt", async () => {
    await bulkReceived(2);
    const job = await startMailExport(getDb(), env, {
      inbox: INBOX,
      userId: "admin-1",
    });
    // Its carried bytes are gone: every attempt throws.
    await getDb()
      .update(asyncJobs)
      .set({
        params: JSON.stringify({
          ...exportParams(job),
          pendingKey: "exports/missing",
        }),
      })
      .where(eq(asyncJobs.id, job.id));
    const body = { type: "mail_export", jobId: job.id, slice: 0 };

    const first = batchOf(body, 1);
    await handleQueueBatch(first.batch, env);
    expect(first.retried).toEqual([undefined]);
    expect((await jobRow(job.id)).status).toBe("running");

    const last = batchOf(body, MAIL_EXPORT_MAX_ATTEMPTS);
    await handleQueueBatch(last.batch, env);
    expect(last.acked).toEqual([0]);
    const failed = await jobRow(job.id);
    expect(failed.status).toBe("failed");
    expect(failed.errorSummary).toContain("carried bytes missing");
  });
});

describe("the export API", () => {
  const queue = (env as any).EMAIL_QUEUE;
  let sent: unknown[];
  let adminKey: string;
  let memberKey: string;
  let otherKey: string;

  beforeEach(async () => {
    sent = [];
    (env as any).EMAIL_QUEUE = {
      send: async (body: unknown) => void sent.push(body),
    };
    ({ apiKey: adminKey } = await createTestUser({
      id: "admin-1",
      email: "admin@example.com",
    }));
    ({ apiKey: memberKey } = await createTestUser({
      id: "user-aa",
      role: "member",
      email: "aa@example.com",
    }));
    ({ apiKey: otherKey } = await createTestUser({
      id: "user-bb",
      role: "member",
      email: "bb@example.com",
    }));
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(inboxPermissions)
      .values([
        { userId: "user-aa", email: INBOX, createdAt: now },
        { userId: "user-bb", email: INBOX, createdAt: now },
      ]);
    await createTestPerson({ id: "p1", email: "alice@example.com" });
    await bulkReceived(3);
  });

  afterEach(() => {
    (env as any).EMAIL_QUEUE = queue;
  });

  const start = (key: string, body: Record<string, unknown> = {}) =>
    authFetch("/api/exports", {
      method: "POST",
      apiKey: key,
      body: JSON.stringify({ inbox: INBOX, ...body }),
    });

  it("starts an export, queues slice 0 and refuses a second", async () => {
    const res = await start(memberKey);
    expect(res.status).toBe(202);
    const created = (await res.json()) as { id: string; status: string };
    expect(created.status).toBe("running");
    expect(sent).toEqual([
      { type: "mail_export", jobId: created.id, slice: 0 },
    ]);

    const again = await start(otherKey);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe(
      "EXPORT_RUNNING",
    );
    const [audit] = await getDb().all<{ action: string }>(
      sql`SELECT action FROM audit_events WHERE action = 'export.started'`,
    );
    expect(audit?.action).toBe("export.started");
  });

  it("refuses an inbox the caller cannot read, and a reversed range", async () => {
    const res = await authFetch("/api/exports", {
      method: "POST",
      apiKey: memberKey,
      body: JSON.stringify({ inbox: "private@saasmail.test" }),
    });
    expect(res.status).toBe(403);
    expect((await start(memberKey, { from: 10, to: 5 })).status).toBe(400);
  });

  it("lets only the requester and admins see and download it", async () => {
    const { id } = (await (await start(memberKey)).json()) as { id: string };
    const notReady = await authFetch(`/api/exports/${id}/download`, {
      apiKey: memberKey,
    });
    expect(notReady.status).toBe(409);
    await runAll(id);

    const mine = await authFetch(`/api/exports/${id}/download`, {
      apiKey: memberKey,
    });
    expect(mine.status).toBe(200);
    expect(mine.headers.get("Content-Type")).toBe("application/mbox");
    expect(mine.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="support@saasmail\.test-\d{4}-\d{2}-\d{2}\.mbox"$/,
    );
    expect(separators(decoder.decode(await mine.arrayBuffer()))).toHaveLength(
      3,
    );

    // Another member of the same inbox: not theirs.
    for (const path of [`/api/exports/${id}`, `/api/exports/${id}/download`]) {
      expect((await authFetch(path, { apiKey: otherKey })).status).toBe(404);
    }
    const otherList = (await (
      await authFetch("/api/exports", { apiKey: otherKey })
    ).json()) as { exports: unknown[] };
    expect(otherList.exports).toEqual([]);

    const asAdmin = await authFetch(`/api/exports/${id}/download`, {
      apiKey: adminKey,
    });
    expect(asAdmin.status).toBe(200);
    await asAdmin.arrayBuffer();
    const adminList = (await (
      await authFetch("/api/exports", { apiKey: adminKey })
    ).json()) as {
      exports: { id: string; status: string; processedMessages: number }[];
    };
    expect(adminList.exports).toMatchObject([
      { id, status: "completed", processedMessages: 3 },
    ]);
    const downloads = await getDb().all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'export.downloaded'`,
    );
    expect(Number(downloads[0].n)).toBe(2);

    // Losing the inbox loses the file.
    await getDb()
      .delete(inboxPermissions)
      .where(eq(inboxPermissions.userId, "user-aa"));
    expect(
      (await authFetch(`/api/exports/${id}/download`, { apiKey: memberKey }))
        .status,
    ).toBe(404);
  });

  it("deletes a finished export and its file, and cancels a running one", async () => {
    const { id } = (await (await start(memberKey)).json()) as { id: string };
    await runAll(id);
    const key = (await jobRow(id)).storageKey!;
    const res = await authFetch(`/api/exports/${id}`, {
      method: "DELETE",
      apiKey: memberKey,
    });
    expect(res.status).toBe(200);
    expect(await jobRow(id)).toBeUndefined();
    expect(await env.R2.head(key)).toBeNull();

    const running = (await (await start(memberKey)).json()) as { id: string };
    const cancel = await authFetch(`/api/exports/${running.id}`, {
      method: "DELETE",
      apiKey: memberKey,
    });
    expect(cancel.status).toBe(200);
    // A slice that was already queued does nothing.
    expect(await runMailExportSlice(getDb(), env, running.id, 0)).toBeNull();
    // And a new export can start.
    expect((await start(memberKey)).status).toBe(202);
  });

  it("downloads one message as .eml", async () => {
    await createTestSentEmail({
      id: "s1",
      fromAddress: INBOX,
      subject: "Re: plan / v2",
    });
    const received = await authFetch(
      "/api/messages/received/bulk-000/raw.eml",
      { apiKey: memberKey },
    );
    expect(received.status).toBe(200);
    expect(received.headers.get("Content-Type")).toBe("message/rfc822");
    expect(received.headers.get("X-Saasmail-Reconstructed")).toBe("yes");
    expect(received.headers.get("Content-Disposition")).toBe(
      'attachment; filename="Message 000.eml"',
    );
    expect(decoder.decode(await received.arrayBuffer())).toContain(
      "Subject: Message 000\r\n",
    );

    const sentOne = await authFetch("/api/messages/sent/s1/raw.eml", {
      apiKey: memberKey,
    });
    expect(sentOne.status).toBe(200);
    expect(sentOne.headers.get("Content-Disposition")).toBe(
      'attachment; filename="Re_ plan _ v2.eml"',
    );
    await sentOne.arrayBuffer();

    await getDb()
      .delete(inboxPermissions)
      .where(eq(inboxPermissions.userId, "user-aa"));
    expect(
      (
        await authFetch("/api/messages/received/bulk-000/raw.eml", {
          apiKey: memberKey,
        })
      ).status,
    ).toBe(404);
  });
});
