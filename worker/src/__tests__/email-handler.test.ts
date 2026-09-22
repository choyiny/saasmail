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
import { handleEmail } from "../email-handler";
import { emails } from "../db/emails.schema";
import { people } from "../db/people.schema";
import { attachments } from "../db/attachments.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { blocklist } from "../db/blocklist.schema";
import { setWebhookConfig } from "../lib/webhook-config";
import { getDb, applyMigrations, cleanDb } from "./helpers";

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
