// SPEC-reply-to §1: the inbound Reply-To header is parsed into a clean list,
// stored on the row, and read back through one helper that also covers rows
// from before the column existed.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { handleEmail } from "../email-handler";
import { emails } from "../db/emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { parseEmail } from "../lib/email-parser";
import { replyToOf } from "../lib/messages/adapters";
import { applyMigrations, cleanDb, getDb } from "./helpers";

function inbound(headers: string[], id = "m1"): ForwardableEmailMessage {
  const raw = new TextEncoder().encode(
    [
      "From: Notifier <noreply@acme.com>",
      "To: support@example.com",
      "Subject: Ticket update",
      `Message-ID: <${id}@acme.com>`,
      ...headers,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "hello",
    ].join("\r\n"),
  );
  return {
    from: "noreply@acme.com",
    to: "support@example.com",
    raw: new Response(raw).body!,
    rawSize: raw.byteLength,
    headers: new Headers(),
    setReject() {},
    async forward() {},
    async reply() {},
  } as unknown as ForwardableEmailMessage;
}

async function deliver(headers: string[], id?: string) {
  const pending: Promise<unknown>[] = [];
  await handleEmail(
    inbound(headers, id),
    env as unknown as CloudflareBindings,
    {
      waitUntil: (p: Promise<unknown>) => void pending.push(p),
      passThroughOnException() {},
    } as unknown as ExecutionContext,
  );
  await Promise.allSettled(pending);
}

describe("parseEmail Reply-To", () => {
  it("keeps the display name and lowercases the address", async () => {
    const parsed = await parseEmail(
      inbound(["Reply-To: Acme Support <Support@Acme.com>"]),
    );
    expect(parsed.replyTo).toEqual([
      { email: "support@acme.com", name: "Acme Support" },
    ]);
  });

  it("keeps a list of three in header order", async () => {
    const parsed = await parseEmail(
      inbound(["Reply-To: a@acme.com, Bee <b@acme.com>, c@acme.com"]),
    );
    expect(parsed.replyTo).toEqual([
      { email: "a@acme.com", name: null },
      { email: "b@acme.com", name: "Bee" },
      { email: "c@acme.com", name: null },
    ]);
  });

  it("drops an entry that is not an address", async () => {
    const parsed = await parseEmail(
      inbound(["Reply-To: not-an-address, real@acme.com"]),
    );
    expect(parsed.replyTo).toEqual([{ email: "real@acme.com", name: null }]);
  });

  it("is empty when the header is absent", async () => {
    const parsed = await parseEmail(inbound([]));
    expect(parsed.replyTo).toEqual([]);
  });

  it("removes duplicates and keeps at most ten", async () => {
    const many = Array.from({ length: 14 }, (_, i) => `r${i}@acme.com`);
    const parsed = await parseEmail(
      inbound([`Reply-To: ${["R0@acme.com", ...many].join(", ")}`]),
    );
    expect(parsed.replyTo.map((entry) => entry.email)).toEqual(
      many.slice(0, 10),
    );
  });
});

describe("handleEmail stores Reply-To", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(senderIdentities)
      .values({ email: "support@example.com", createdAt: now, updatedAt: now });
  });

  it("writes the list as JSON, the cc convention", async () => {
    await deliver(["Reply-To: Acme Support <support@acme.com>, b@acme.com"]);
    const [row] = await getDb()
      .select({ replyTo: emails.replyTo })
      .from(emails)
      .where(eq(emails.messageId, "<m1@acme.com>"));
    expect(JSON.parse(row.replyTo!)).toEqual([
      { email: "support@acme.com", name: "Acme Support" },
      { email: "b@acme.com", name: null },
    ]);
  });

  it("stores NULL when the header is absent", async () => {
    await deliver([], "m2");
    const [row] = await getDb()
      .select({ replyTo: emails.replyTo })
      .from(emails)
      .where(eq(emails.messageId, "<m2@acme.com>"));
    expect(row.replyTo).toBeNull();
  });
});

describe("replyToOf", () => {
  it("returns the stored list", () => {
    expect(
      replyToOf({
        replyTo: JSON.stringify([{ email: "support@acme.com", name: "Acme" }]),
        // The stored column wins: this header is not read.
        rawHeaders: JSON.stringify({ "reply-to": "other@acme.com" }),
      }),
    ).toEqual([{ email: "support@acme.com", name: "Acme" }]);
  });

  it("falls back to raw_headers for a row from before the column", () => {
    expect(
      replyToOf({
        replyTo: null,
        rawHeaders: JSON.stringify({
          "reply-to": "Acme Support <Support@Acme.com>, b@acme.com",
        }),
      }),
    ).toEqual([
      { email: "support@acme.com", name: "Acme Support" },
      { email: "b@acme.com", name: null },
    ]);
  });

  it("is empty with no stored list and no header", () => {
    expect(replyToOf({ replyTo: null, rawHeaders: "{}" })).toEqual([]);
    expect(replyToOf({ replyTo: null, rawHeaders: null })).toEqual([]);
  });

  it("is empty when raw_headers is not JSON", () => {
    expect(replyToOf({ replyTo: null, rawHeaders: "not json" })).toEqual([]);
  });
});
