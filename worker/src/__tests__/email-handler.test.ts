import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { env } from "cloudflare:workers";
import { handleEmail, ingestParsedEmail } from "../email-handler";
import { parseRaw } from "../lib/email-parser";
import { emails } from "../db/emails.schema";
import { people } from "../db/people.schema";
import { attachments } from "../db/attachments.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { blocklist } from "../db/blocklist.schema";
import { setWebhookConfig } from "../lib/webhook-config";
import { eq } from "drizzle-orm";
import { rules } from "../db/rules.schema";
import { sequences } from "../db/sequences.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import {
  UNKNOWN_RECIPIENT_REASON,
  setRejectUnknownRecipients,
} from "../lib/inbound-rejection";
import {
  getDb,
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestPerson,
  createTestTemplate,
  authFetch,
} from "./helpers";

/**
 * Characterization tests: these pin the CURRENT behaviour of the inbound
 * path so the Slice 2 refactor can be shown to change nothing. They were
 * written against the pre-refactor code. If one starts failing during a
 * refactor, the refactor is wrong — do not edit the test.
 */

/**
 * Minimal RFC822 builder. `extraHeaders` are emitted verbatim. `attachment`
 * (optional) adds a base64-encoded MIME part under an outer
 * `multipart/mixed`, wrapping whatever body (plain, or plain+html
 * alternative) would otherwise have been produced. When `attachment` is
 * omitted this function is byte-identical to the original
 * (pre-side-effect-coverage) version — the 14 existing tests depend on that.
 */
function buildRawEmail(opts: {
  from: string;
  to: string;
  subject?: string;
  messageId?: string;
  cc?: string;
  text?: string;
  html?: string;
  extraHeaders?: string[];
  attachment?: {
    filename: string;
    contentType: string;
    /** Raw (pre-base64) bytes as a JS string; only ASCII-safe content needed for these tests. */
    content: string;
    contentId?: string;
    disposition?: "inline" | "attachment";
  };
}): string {
  const headerLines: string[] = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject ?? "Test subject"}`,
  ];
  if (opts.messageId) headerLines.push(`Message-ID: ${opts.messageId}`);
  if (opts.cc) headerLines.push(`Cc: ${opts.cc}`);
  for (const h of opts.extraHeaders ?? []) headerLines.push(h);

  const bodyPartLines: string[] = [];
  let bodyContentType: string;
  if (opts.html) {
    const boundary = "bnd42";
    bodyContentType = `multipart/alternative; boundary="${boundary}"`;
    bodyPartLines.push(`--${boundary}`);
    bodyPartLines.push("Content-Type: text/plain; charset=utf-8");
    bodyPartLines.push("");
    bodyPartLines.push(opts.text ?? "plain body");
    bodyPartLines.push(`--${boundary}`);
    bodyPartLines.push("Content-Type: text/html; charset=utf-8");
    bodyPartLines.push("");
    bodyPartLines.push(opts.html);
    bodyPartLines.push(`--${boundary}--`);
  } else {
    bodyContentType = "text/plain; charset=utf-8";
    bodyPartLines.push(opts.text ?? "plain body");
  }

  if (!opts.attachment) {
    return [
      ...headerLines,
      `Content-Type: ${bodyContentType}`,
      "",
      ...bodyPartLines,
    ].join("\r\n");
  }

  const att = opts.attachment;
  const mixedBoundary = "bnd-mixed";
  const attHeaderLines = [
    `Content-Type: ${att.contentType}; name="${att.filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: ${att.disposition ?? "attachment"}; filename="${att.filename}"`,
  ];
  if (att.contentId) attHeaderLines.push(`Content-ID: <${att.contentId}>`);

  return [
    ...headerLines,
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    "",
    `--${mixedBoundary}`,
    `Content-Type: ${bodyContentType}`,
    "",
    ...bodyPartLines,
    `--${mixedBoundary}`,
    ...attHeaderLines,
    "",
    btoa(att.content),
    `--${mixedBoundary}--`,
  ].join("\r\n");
}

/**
 * `handleEmail` passes this object only to `parseEmail`, which reads
 * `.raw`, `.from` and `.to`. Everything else on the real
 * ForwardableEmailMessage is unused on this path.
 */
function fakeMessage(raw: string, from: string, to: string) {
  return {
    raw: new Response(raw).body!,
    from,
    to,
    headers: new Headers(),
    rawSize: raw.length,
    setReject: () => {},
    forward: async () => {},
    reply: async () => {},
  } as unknown as ForwardableEmailMessage;
}

/**
 * An ExecutionContext whose `waitUntil` RECORDS the promises it receives
 * (into `calls`) instead of discarding them. `handleEmail`'s fire-and-forget
 * work (notification fan-out, webhook delivery, inbound forwarding) is
 * registered via `ctx.waitUntil` synchronously during the handler's
 * execution, so by the time `handleEmail(...)` resolves, `calls` already
 * holds every background promise — `deliver` below awaits them so tests can
 * assert on fire-and-forget side effects deterministically, no sleep needed.
 */
function fakeCtx(calls: Promise<unknown>[]): ExecutionContext {
  return {
    waitUntil: (p: Promise<unknown>) => {
      calls.push(p);
    },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
}

/**
 * Deliver one message through the real handler. Returns the promises passed
 * to `ctx.waitUntil`, already settled (awaited via `Promise.allSettled`), so
 * callers can assert on the handler's background work deterministically.
 */
async function deliver(
  opts: Parameters<typeof buildRawEmail>[0],
): Promise<Promise<unknown>[]> {
  const raw = buildRawEmail(opts);
  const waitUntilCalls: Promise<unknown>[] = [];
  await handleEmail(
    fakeMessage(raw, opts.from, opts.to),
    env as unknown as CloudflareBindings,
    fakeCtx(waitUntilCalls),
  );
  await Promise.allSettled(waitUntilCalls);
  return waitUntilCalls;
}

const AUTH_PASS =
  "Authentication-Results: mx.example.com; spf=pass; dkim=pass; dmarc=pass";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
});

describe("handleEmail — storage", () => {
  it("stores the email with a lowercased recipient", async () => {
    await deliver({
      from: "Jane Customer <Jane@Example.COM>",
      to: "Support@Acme.Dev",
      subject: "Hello there",
      messageId: "<m1@example.com>",
    });

    const rows = await getDb().select().from(emails);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient).toBe("support@acme.dev");
    expect(rows[0].subject).toBe("Hello there");
    expect(rows[0].isRead).toBe(0);
  });

  it("creates a person keyed on the lowercased sender address", async () => {
    await deliver({
      from: "Jane <Jane@Example.COM>",
      to: "support@acme.dev",
      messageId: "<m1@example.com>",
    });

    const rows = await getDb().select().from(people);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("jane@example.com");
    expect(rows[0].unreadCount).toBe(1);
    expect(rows[0].totalCount).toBe(1);
  });

  it("increments person counts on a second email rather than duplicating", async () => {
    await deliver({
      from: "jane@example.com",
      to: "support@acme.dev",
      messageId: "<m1@example.com>",
    });
    await deliver({
      from: "jane@example.com",
      to: "support@acme.dev",
      messageId: "<m2@example.com>",
    });

    const rows = await getDb().select().from(people);
    expect(rows).toHaveLength(1);
    expect(rows[0].unreadCount).toBe(2);
    expect(rows[0].totalCount).toBe(2);
    expect(await getDb().select().from(emails)).toHaveLength(2);
  });

  it("records the auth verdicts from Authentication-Results", async () => {
    await deliver({
      from: "jane@example.com",
      to: "support@acme.dev",
      messageId: "<m1@example.com>",
      extraHeaders: [AUTH_PASS],
    });

    const [row] = await getDb().select().from(emails);
    expect(row.spf).toBe("pass");
    expect(row.dkim).toBe("pass");
    expect(row.dmarc).toBe("pass");
  });
});

describe("handleEmail — rejection paths", () => {
  it("drops a duplicate Message-ID without inserting a second row", async () => {
    const opts = {
      from: "jane@example.com",
      to: "support@acme.dev",
      messageId: "<dupe@example.com>",
    };
    await deliver(opts);
    await deliver(opts);

    expect(await getDb().select().from(emails)).toHaveLength(1);
    const [person] = await getDb().select().from(people);
    // The duplicate returns before the person upsert, so counts stay at 1.
    expect(person.totalCount).toBe(1);
  });

  it("drops mail from a blocked sender before any storage", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(blocklist).values({
      id: "b1",
      // Column is `type`, not `kind`. Values: "email" | "domain".
      type: "email",
      value: "spammer@bad.test",
      createdAt: now,
    });

    await deliver({
      from: "spammer@bad.test",
      to: "support@acme.dev",
      messageId: "<spam@bad.test>",
    });

    expect(await getDb().select().from(emails)).toHaveLength(0);
    expect(await getDb().select().from(people)).toHaveLength(0);
  });
});

describe("handleEmail — name trust", () => {
  it("sets the person name when the sender authenticates", async () => {
    await deliver({
      from: "Jane Real <jane@example.com>",
      to: "support@acme.dev",
      messageId: "<m1@example.com>",
      extraHeaders: [AUTH_PASS],
    });

    const [row] = await getDb().select().from(people);
    expect(row.name).toBe("Jane Real");
  });

  it("does not overwrite an existing name from an unauthenticated sender", async () => {
    await deliver({
      from: "Jane Real <jane@example.com>",
      to: "support@acme.dev",
      messageId: "<m1@example.com>",
      extraHeaders: [AUTH_PASS],
    });
    await deliver({
      from: "Imposter <jane@example.com>",
      to: "support@acme.dev",
      messageId: "<m2@example.com>",
    });

    const [row] = await getDb().select().from(people);
    expect(row.name).toBe("Jane Real");
  });
});

describe("handleEmail — cc and conversation grouping", () => {
  it("stores valid Cc entries lowercased and drops malformed ones", async () => {
    await deliver({
      from: "jane@example.com",
      to: "support@acme.dev",
      messageId: "<m1@example.com>",
      cc: "Bob <BOB@Example.com>, not-an-address",
    });

    const [row] = await getDb().select().from(emails);
    const cc = JSON.parse(row.cc!) as Array<{ email: string }>;
    expect(cc.map((c) => c.email)).toEqual(["bob@example.com"]);
  });

  it("leaves conversation_id null for a one-to-one thread", async () => {
    await deliver({
      from: "jane@example.com",
      to: "support@acme.dev",
      messageId: "<m1@example.com>",
    });

    const [row] = await getDb().select().from(emails);
    expect(row.conversationId).toBeNull();
  });

  it("sets a conversation_id when a second external participant is present", async () => {
    await deliver({
      from: "jane@example.com",
      to: "support@acme.dev",
      messageId: "<m1@example.com>",
      cc: "colleague@other.test",
    });

    const [row] = await getDb().select().from(emails);
    expect(row.conversationId).toBeTruthy();
  });

  it("does not count our own inbox addresses as external participants", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: "sales@acme.dev",
      displayName: "Sales",
      displayMode: "thread",
      createdAt: now,
      updatedAt: now,
    });

    await deliver({
      from: "jane@example.com",
      to: "support@acme.dev",
      messageId: "<m1@example.com>",
      cc: "sales@acme.dev",
    });

    const [row] = await getDb().select().from(emails);
    expect(row.conversationId).toBeNull();
  });
});

describe("handleEmail — html bodies", () => {
  it("stores an html body alongside the text body", async () => {
    await deliver({
      from: "jane@example.com",
      to: "support@acme.dev",
      messageId: "<m1@example.com>",
      text: "plain version",
      html: "<p>rich version</p>",
    });

    const [row] = await getDb().select().from(emails);
    expect(row.bodyHtml).toContain("rich version");
    expect(row.bodyText).toContain("plain version");
  });

  it("records no attachments for a message that has none", async () => {
    await deliver({
      from: "jane@example.com",
      to: "support@acme.dev",
      messageId: "<m1@example.com>",
    });

    expect(await getDb().select().from(attachments)).toHaveLength(0);
  });
});

describe("handleEmail — attachment storage", () => {
  it("stores a regular attachment and uploads its bytes to R2", async () => {
    const content = "hello pdf bytes";
    await deliver({
      from: "jane@example.com",
      to: "support@acme.dev",
      messageId: "<m1@example.com>",
      attachment: {
        filename: "notes.pdf",
        contentType: "application/pdf",
        content,
        disposition: "attachment",
      },
    });

    const rows = await getDb().select().from(attachments);
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe("notes.pdf");
    expect(rows[0].contentType).toBe("application/pdf");
    expect(rows[0].size).toBe(content.length);
    expect(rows[0].r2Key).toBeTruthy();

    const obj = await env.R2.get(rows[0].r2Key);
    expect(obj).not.toBeNull();
    expect(await obj!.text()).toBe(content);
  });
});

describe("handleEmail — inline CID rewriting", () => {
  it("rewrites an inline cid: reference to the stored attachment's inline URL", async () => {
    await deliver({
      from: "jane@example.com",
      to: "support@acme.dev",
      messageId: "<m1@example.com>",
      html: '<p>See <img src="cid:logo123"></p>',
      attachment: {
        filename: "logo.png",
        contentType: "image/png",
        content: "not-really-a-png",
        contentId: "logo123",
        disposition: "inline",
      },
    });

    const [attachmentRow] = await getDb().select().from(attachments);
    const [emailRow] = await getDb().select().from(emails);
    expect(emailRow.bodyHtml).not.toContain("cid:logo123");
    expect(emailRow.bodyHtml).toContain(
      `/api/attachments/${attachmentRow.id}/inline`,
    );
  });
});

describe("handleEmail — ctx wiring", () => {
  it("passes background work to ctx.waitUntil", async () => {
    const calls = await deliver({
      from: "jane@example.com",
      to: "support@acme.dev",
      messageId: "<m1@example.com>",
    });

    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("handleEmail — webhook delivery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to the configured webhook URL when one is set", async () => {
    await setWebhookConfig(
      getDb(),
      { url: "https://hook.example.com/inbound", secret: null },
      null,
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await deliver({
      from: "jane@example.com",
      to: "support@acme.dev",
      messageId: "<m1@example.com>",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://hook.example.com/inbound");
  });
});

describe("parseRaw + ingestParsedEmail — direct seam usage", () => {
  /**
   * Rehearses how Slice 3 (Gmail sync) will call this seam: parse raw bytes
   * with a provisional envelope, then reassign `parsed.to` before ingesting
   * — exactly what a Google Group delivery needs, where the real inbox
   * comes from a `Delivered-To`/`List-ID` header rather than the envelope.
   * Proves `parsed.to` is the sole inbox determinant for storage.
   */
  it("stores the reassigned parsed.to, lowercased, not the original envelope.to", async () => {
    const raw = buildRawEmail({
      from: "jane@example.com",
      to: "envelope-provisional@acme.dev",
      subject: "Group mail",
      messageId: "<m1@example.com>",
    });
    const rawBytes = await new Response(raw).arrayBuffer();

    const parsed = await parseRaw(rawBytes, {
      from: "jane@example.com",
      to: "envelope-provisional@acme.dev",
    });
    parsed.to = "Real-Group@Acme.Dev";

    const waitUntilCalls: Promise<unknown>[] = [];
    await ingestParsedEmail(
      getDb(),
      parsed,
      env as unknown as CloudflareBindings,
      fakeCtx(waitUntilCalls),
    );
    await Promise.allSettled(waitUntilCalls);

    const [row] = await getDb().select().from(emails);
    expect(row.recipient).toBe("real-group@acme.dev");
  });
});

/**
 * The fork's pipeline behind `ingestParsedEmail` (docs/updating.md): every
 * outcome it returns, the message it stores read back the way /mail reads it,
 * and the live handler's SMTP refusals and envelope routing on top of it.
 */
describe("ingestParsedEmail — outcomes", () => {
  const HEADERS_INBOX = "threads@acme.dev";
  const CUSTOMER_INBOX = "support@acme.dev";

  beforeEach(async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(senderIdentities)
      .values([
        {
          email: HEADERS_INBOX,
          displayName: "Threads",
          threadingMode: "headers",
          createdAt: now,
          updatedAt: now,
        },
        {
          email: CUSTOMER_INBOX,
          displayName: "Support",
          threadingMode: "relationship",
          createdAt: now,
          updatedAt: now,
        },
      ]);
  });

  async function parsedFor(opts: Parameters<typeof buildRawEmail>[0]) {
    const bytes = await new Response(buildRawEmail(opts)).arrayBuffer();
    return parseRaw(bytes, { from: opts.from, to: opts.to });
  }

  async function ingest(opts: Parameters<typeof buildRawEmail>[0]) {
    const calls: Promise<unknown>[] = [];
    const outcome = await ingestParsedEmail(
      getDb(),
      await parsedFor(opts),
      env as unknown as CloudflareBindings,
      fakeCtx(calls),
    );
    // Every background step was registered before the outcome came back.
    const registered = calls.length;
    await Promise.allSettled(calls);
    return { outcome, registered };
  }

  async function addRule(id: string, inbox: string, actions: unknown[]) {
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(rules)
      .values({
        id,
        name: `Rule ${id}`,
        inbox,
        trigger: "message.received",
        conditions: [],
        actions: actions as never,
        position: 0,
        stopProcessing: 0,
        enabled: 1,
        matchCount: 0,
        createdAt: now,
        updatedAt: now,
      });
  }

  it("stores a message that /mail lists like live mail, after its rules ran", async () => {
    const { apiKey, userId } = await createTestUser({ role: "admin" });
    await addRule("assign-1", HEADERS_INBOX, [{ type: "assign", userId }]);

    const { outcome, registered } = await ingest({
      from: "Jane Customer <jane@example.com>",
      to: HEADERS_INBOX,
      subject: "Synced from a mailbox",
      messageId: "<ingest-1@example.com>",
    });

    expect(outcome.status).toBe("stored");
    const emailId = (outcome as { emailId: string }).emailId;
    expect(registered).toBeGreaterThan(0);

    const [row] = await getDb()
      .select()
      .from(emails)
      .where(eq(emails.id, emailId));
    expect(row.rawR2Key).toBeTruthy();
    expect(await env.R2.get(row.rawR2Key!)).not.toBeNull();
    expect(row.threadKey).toBeTruthy();

    const res = await authFetch(
      `/api/messages?folder=inbox&inbox=${encodeURIComponent(HEADERS_INBOX)}`,
      { apiKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{
        ref: string;
        subject: string;
        from: { email: string; name: string | null };
        isRead: boolean;
        state: { seen: boolean; assignedUserId: string | null };
      }>;
    };
    const listed = body.messages.find((m) => m.ref === `received:${emailId}`);
    expect(listed).toMatchObject({
      subject: "Synced from a mailbox",
      from: { email: "jane@example.com", name: "Jane Customer" },
      isRead: false,
      state: { seen: false, assignedUserId: userId },
    });
  });

  it("leaves thread_key null in a relationship-mode inbox", async () => {
    const { outcome } = await ingest({
      from: "jane@example.com",
      to: CUSTOMER_INBOX,
      messageId: "<ingest-rel@example.com>",
    });
    expect(outcome.status).toBe("stored");
    const [row] = await getDb().select().from(emails);
    expect(row.rawR2Key).toBeTruthy();
    expect(row.threadKey).toBeNull();
  });

  it("returns duplicate for the same Message-ID in the same inbox", async () => {
    const opts = {
      from: "jane@example.com",
      to: CUSTOMER_INBOX,
      messageId: "<ingest-dupe@example.com>",
    };
    const first = await ingest(opts);
    const second = await ingest(opts);

    expect(first.outcome.status).toBe("stored");
    expect(second.outcome).toEqual({
      status: "duplicate",
      emailId: (first.outcome as { emailId: string }).emailId,
    });
    expect(second.registered).toBe(0);
    expect(await getDb().select().from(emails)).toHaveLength(1);
  });

  it("returns blocked for a blocked sender and stores nothing", async () => {
    await getDb().insert(blocklist).values({
      id: "b1",
      type: "email",
      value: "spammer@bad.test",
      createdAt: 1,
    });
    const { outcome } = await ingest({
      from: "spammer@bad.test",
      to: CUSTOMER_INBOX,
      messageId: "<ingest-blocked@bad.test>",
    });
    expect(outcome).toEqual({ status: "blocked" });
    expect(await getDb().select().from(emails)).toHaveLength(0);
  });

  it("returns rejected for an unknown recipient and stores nothing", async () => {
    await setRejectUnknownRecipients(getDb(), true);
    const { outcome } = await ingest({
      from: "jane@example.com",
      to: "nobody@acme.dev",
      messageId: "<ingest-unknown@example.com>",
    });
    expect(outcome).toEqual({
      status: "rejected",
      reason: UNKNOWN_RECIPIENT_REASON,
    });
    expect(await getDb().select().from(emails)).toHaveLength(0);
    expect(await getDb().select().from(people)).toHaveLength(0);
  });

  it("returns rejected with a reject rule's reason and stores nothing", async () => {
    await addRule("reject-1", CUSTOMER_INBOX, [
      { type: "reject", reason: "We do not accept this mail" },
    ]);
    const { outcome, registered } = await ingest({
      from: "jane@example.com",
      to: CUSTOMER_INBOX,
      messageId: "<ingest-rule@example.com>",
    });
    expect(outcome).toEqual({
      status: "rejected",
      reason: "We do not accept this mail",
    });
    expect(registered).toBe(0);
    expect(await getDb().select().from(emails)).toHaveLength(0);
  });
});

describe("handleEmail — on top of ingestParsedEmail", () => {
  const INBOX = "support@acme.dev";

  beforeEach(async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: INBOX,
      displayName: "Support",
      createdAt: now,
      updatedAt: now,
    });
  });

  async function deliverTo(envelopeTo: string, mimeTo: string, id: string) {
    const raw = buildRawEmail({
      from: "jane@example.com",
      to: mimeTo,
      messageId: `<${id}@example.com>`,
    });
    const message = fakeMessage(raw, "jane@example.com", envelopeTo);
    const setReject = vi.fn();
    (message as unknown as { setReject: typeof setReject }).setReject =
      setReject;
    const calls: Promise<unknown>[] = [];
    await handleEmail(
      message,
      env as unknown as CloudflareBindings,
      fakeCtx(calls),
    );
    await Promise.allSettled(calls);
    return setReject;
  }

  it("refuses an unknown recipient with the same SMTP reason", async () => {
    await setRejectUnknownRecipients(getDb(), true);
    const setReject = await deliverTo(
      "nobody@acme.dev",
      "nobody@acme.dev",
      "h-unknown",
    );
    expect(setReject).toHaveBeenCalledTimes(1);
    expect(setReject).toHaveBeenCalledWith("No such mailbox");
  });

  it("refuses with a reject rule's reason", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(rules)
      .values({
        id: "reject-h",
        name: "Reject",
        inbox: INBOX,
        trigger: "message.received",
        conditions: [],
        actions: [{ type: "reject" }],
        position: 0,
        stopProcessing: 0,
        enabled: 1,
        matchCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    const setReject = await deliverTo(INBOX, INBOX, "h-rule");
    expect(setReject).toHaveBeenCalledTimes(1);
    expect(setReject).toHaveBeenCalledWith("Rejected by mailbox policy");
  });

  it("does not refuse stored or duplicate mail", async () => {
    expect(await deliverTo(INBOX, INBOX, "h-ok")).not.toHaveBeenCalled();
    expect(await deliverTo(INBOX, INBOX, "h-ok")).not.toHaveBeenCalled();
  });

  it("stores a Bcc delivery in the envelope recipient's inbox, not the MIME To", async () => {
    const setReject = await deliverTo(INBOX, "someone@elsewhere.test", "h-bcc");
    expect(setReject).not.toHaveBeenCalled();
    const rows = await getDb().select().from(emails);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient).toBe(INBOX);
  });
});

/**
 * The steps after storage run on a stored message only, and before
 * `ingestParsedEmail` resolves: an enrolled sender's sequence is cancelled,
 * a suggested reply is queued for an autodraft inbox, and the inbox's users
 * get a real-time push. A rejected, blocked or duplicate message gets none of
 * them (the early returns the live handler always had).
 */
describe("ingestParsedEmail — steps after storage", () => {
  const INBOX = "agent@acme.dev";
  const SENDER = "jane@example.com";

  it("runs them before `stored` resolves, and never for a message it does not store", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(senderIdentities).values({
      email: INBOX,
      displayName: "Agent",
      agentAutodraft: 1,
      createdAt: now,
      updatedAt: now,
    });
    const { userId: adminId } = await createTestUser({ role: "admin" });
    await createTestPerson({ id: "p-jane", email: SENDER });
    await createTestTemplate({ slug: "welcome" });
    await db.insert(sequences).values({
      id: "seq-1",
      name: "Onboarding",
      steps: JSON.stringify([
        { order: 1, templateSlug: "welcome", delayHours: 24 },
      ]),
      createdAt: now,
      updatedAt: now,
    });
    async function enroll(id: string) {
      await db.insert(sequenceEnrollments).values({
        id,
        sequenceId: "seq-1",
        personId: "p-jane",
        status: "active",
        variables: "{}",
        fromAddress: INBOX,
        enrolledAt: now,
      });
      await db.insert(sequenceEmails).values({
        id: `${id}-step-1`,
        enrollmentId: id,
        stepOrder: 1,
        templateSlug: "welcome",
        scheduledAt: now + 86_400,
        status: "pending",
      });
    }
    async function statusOf(id: string) {
      const [enrollment] = await db
        .select({ status: sequenceEnrollments.status })
        .from(sequenceEnrollments)
        .where(eq(sequenceEnrollments.id, id));
      const [step] = await db
        .select({ status: sequenceEmails.status })
        .from(sequenceEmails)
        .where(eq(sequenceEmails.enrollmentId, id));
      return [enrollment.status, step.status];
    }
    await enroll("enr-1");
    await db.insert(rules).values({
      id: "refuse",
      name: "Refuse",
      inbox: INBOX,
      trigger: "message.received",
      conditions: [{ field: "subject", operator: "contains", value: "refuse" }],
      actions: [{ type: "reject", reason: "Refused here" }],
      position: 0,
      stopProcessing: 0,
      enabled: 1,
      matchCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    const mutableEnv = env as unknown as Record<string, unknown>;
    const saved = {
      queue: mutableEnv.EMAIL_QUEUE,
      hub: mutableEnv.NOTIFICATIONS_HUB,
      anthropic: mutableEnv.ANTHROPIC_API_KEY,
    };
    const queued: unknown[] = [];
    const pushedTo: string[] = [];
    mutableEnv.EMAIL_QUEUE = {
      send: async (message: unknown) => void queued.push(message),
    };
    mutableEnv.NOTIFICATIONS_HUB = {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async () => {
          pushedTo.push(id);
          return new Response("ok");
        },
      }),
    };
    // A configured model, so an autodraft inbox queues a suggested reply.
    mutableEnv.ANTHROPIC_API_KEY = "sk-ant-test";

    async function ingest(subject: string, messageId: string, to = INBOX) {
      const bytes = await new Response(
        buildRawEmail({ from: SENDER, to, subject, messageId }),
      ).arrayBuffer();
      const calls: Promise<unknown>[] = [];
      const outcome = await ingestParsedEmail(
        db,
        await parseRaw(bytes, { from: SENDER, to }),
        env as unknown as CloudflareBindings,
        fakeCtx(calls),
      );
      // Read before any background work settles: what `stored` promises.
      const atResolve = {
        registered: calls.length,
        enr1: await statusOf("enr-1"),
      };
      await Promise.allSettled(calls);
      return { outcome, ...atResolve };
    }

    try {
      // Refused by a rule, by the unknown-recipient setting, and blocked.
      const refused = await ingest("please refuse", "<refused@example.com>");
      expect(refused.outcome).toEqual({
        status: "rejected",
        reason: "Refused here",
      });

      await setRejectUnknownRecipients(db, true);
      const unknown = await ingest(
        "hello",
        "<unknown@example.com>",
        "nobody@acme.dev",
      );
      expect(unknown.outcome).toEqual({
        status: "rejected",
        reason: UNKNOWN_RECIPIENT_REASON,
      });

      await db.insert(blocklist).values({
        id: "b-jane",
        type: "email",
        value: SENDER,
        createdAt: now,
      });
      const blocked = await ingest("hello", "<blocked@example.com>");
      expect(blocked.outcome).toEqual({ status: "blocked" });
      await db.delete(blocklist).where(eq(blocklist.id, "b-jane"));

      for (const notStored of [refused, unknown, blocked]) {
        expect(notStored.registered).toBe(0);
        expect(notStored.enr1).toEqual(["active", "pending"]);
      }
      expect(queued).toEqual([]);
      expect(pushedTo).toEqual([]);
      expect(await db.select().from(emails)).toHaveLength(0);

      // Stored: the sequence is already cancelled when the outcome arrives.
      const stored = await ingest("hello", "<stored@example.com>");
      expect(stored.outcome.status).toBe("stored");
      const emailId = (stored.outcome as { emailId: string }).emailId;
      expect(stored.enr1).toEqual(["cancelled", "cancelled"]);
      expect(stored.registered).toBeGreaterThan(0);
      expect(queued).toEqual([{ type: "suggest_reply", emailId }]);
      expect(pushedTo).toEqual([adminId]);

      // A redelivery is a duplicate: a sequence enrolled since stays active,
      // nothing is queued or pushed.
      await enroll("enr-2");
      const duplicate = await ingest("hello", "<stored@example.com>");
      expect(duplicate.outcome).toEqual({ status: "duplicate", emailId });
      expect(duplicate.registered).toBe(0);
      expect(await statusOf("enr-2")).toEqual(["active", "pending"]);
      expect(queued).toHaveLength(1);
      expect(pushedTo).toHaveLength(1);
      expect(await db.select().from(emails)).toHaveLength(1);
    } finally {
      mutableEnv.EMAIL_QUEUE = saved.queue;
      mutableEnv.NOTIFICATIONS_HUB = saved.hub;
      mutableEnv.ANTHROPIC_API_KEY = saved.anthropic;
    }
  });
});

describe("ingestParsedEmail — a failure part-way through", () => {
  /**
   * Appended, not edited: every characterization test above still describes
   * the behaviour it always did. What is new is what happens when the ingest
   * does not finish, which nothing pinned before.
   */
  async function ingest(opts: Parameters<typeof buildRawEmail>[0]) {
    const rawBytes = await new Response(buildRawEmail(opts)).arrayBuffer();
    const parsed = await parseRaw(rawBytes, {
      from: opts.from,
      to: opts.to,
    });
    const waitUntilCalls: Promise<unknown>[] = [];
    const outcome = await ingestParsedEmail(
      getDb(),
      parsed,
      env as unknown as CloudflareBindings,
      fakeCtx(waitUntilCalls),
    );
    await Promise.allSettled(waitUntilCalls);
    return outcome;
  }

  const withAttachment = {
    from: "jane@example.com",
    to: "support@acme.dev",
    subject: "With a file",
    attachment: {
      filename: "a.bin",
      contentType: "application/octet-stream",
      content: "hello bytes",
    },
  };

  it("leaves no orphaned attachment row when storing the bytes fails", async () => {
    // The R2 put and the `attachments` insert used to commit BEFORE the
    // `emails` row. A failure in between left a row pointing at an email
    // that does not exist — unreachable by every delete path, because they
    // all find attachments by an email or a person.
    const put = vi
      .spyOn(env.R2 as R2Bucket, "put")
      .mockRejectedValue(new Error("R2 unavailable"));
    try {
      await expect(
        ingest({ ...withAttachment, messageId: "<orphan@example.com>" }),
      ).rejects.toThrow(/R2 unavailable/);
    } finally {
      put.mockRestore();
    }

    // This fork writes the files before the row (so a JMAP Email never gains
    // a blobId after a client has seen it): the message is not stored, the
    // sender's retry delivers it, and nothing dangles.
    const emailRows = await getDb().select().from(emails);
    expect(emailRows).toHaveLength(0);
    expect(await getDb().select().from(attachments)).toHaveLength(0);
  });

  it("still completes the ingest when cancelling sequences fails", async () => {
    // The `emails` row is committed by the time the cancel runs, and the
    // per-inbox dedupe matches on it — so an escaping error would stop the
    // Gmail sync's run AND make every retry skip this message, losing the
    // cancellation permanently rather than retrying it. `mirrorSentMessage`
    // guards the identical call for the identical reason; the inbound path
    // did not.
    //
    // The failure is real, not mocked: dropping the table makes the cancel's
    // own SELECT throw the way a genuine database fault would.
    await env.DB.exec("DROP TABLE sequence_enrollments");
    try {
      const outcome = await ingest({
        from: "jane@example.com",
        to: "support@acme.dev",
        subject: "Answer me",
        messageId: "<cancelfail@example.com>",
      });
      expect(outcome.status).toBe("stored");
      expect(await getDb().select().from(emails)).toHaveLength(1);
    } finally {
      // Every statement is CREATE TABLE IF NOT EXISTS, so this just puts the
      // dropped table back for the rest of the file.
      await applyMigrations();
    }
  });

  it("does not count the person twice when the same message is retried", async () => {
    // The retry used to mint a fresh emailId, re-upload the bytes and
    // re-insert, while the person's unread and total climbed by one per
    // tick — unbounded for a deterministically failing message.
    const put = vi
      .spyOn(env.R2 as R2Bucket, "put")
      .mockRejectedValue(new Error("R2 unavailable"));
    try {
      await expect(
        ingest({ ...withAttachment, messageId: "<retry@example.com>" }),
      ).rejects.toThrow(/R2 unavailable/);
    } finally {
      put.mockRestore();
    }

    // Nothing was stored, so nothing was counted.
    const first = await getDb().select().from(people);
    expect(first[0].totalCount).toBe(0);
    expect(first[0].unreadCount).toBe(0);

    // The retry stores it, and counts it once.
    const outcome = await ingest({
      ...withAttachment,
      messageId: "<retry@example.com>",
    });
    expect(outcome.status).toBe("stored");

    const after = await getDb().select().from(people);
    expect(after[0].totalCount).toBe(1);
    expect(after[0].unreadCount).toBe(1);
    expect(await getDb().select().from(emails)).toHaveLength(1);
    expect(await getDb().select().from(attachments)).toHaveLength(1);
  });
});
