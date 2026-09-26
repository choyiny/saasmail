import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { sendWithSuppressionCheck } from "../lib/send";
import type {
  EmailSender,
  SendEmailParams,
  SendEmailResult,
} from "../lib/email-sender";

beforeAll(applyMigrations);
beforeEach(cleanDb);

function fakeSender(): EmailSender & { calls: SendEmailParams[] } {
  const calls: SendEmailParams[] = [];
  return {
    provider: "none" as const,
    calls,
    async send(params: SendEmailParams): Promise<SendEmailResult> {
      calls.push(params);
      return { id: "prov-1", error: null };
    },
    maxAttachmentBytes: () => 25 * 1024 * 1024,
  };
}

const V2_URL = "https://app.test/unsubscribe?token=v2-per-list-token";

const base = {
  env: env as unknown as CloudflareBindings,
  from: "News <news@saasmail.test>",
  subject: "Weekly",
  transactional: false,
};

describe("unsubscribeContext", () => {
  /**
   * Without this, a campaign's per-list v2 link is replaced by a freshly minted
   * global v1 token in the headers and body — so one click would unsubscribe
   * the reader from everything rather than from the one list.
   */
  it("is used for the body, the footer and both List-Unsubscribe headers", async () => {
    const sender = fakeSender();
    await sendWithSuppressionCheck({
      db: getDb(),
      sender,
      to: "sub@example.com",
      html: "<p>Hi</p><p>{{unsubscribe_url}}</p>",
      text: "Hi\n{{unsubscribe_url}}",
      unsubscribeContext: { url: V2_URL },
      ...base,
    });

    expect(sender.calls).toHaveLength(1);
    const sent = sender.calls[0];
    expect(sent.headers?.["List-Unsubscribe"]).toBe(`<${V2_URL}>`);
    expect(sent.headers?.["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click",
    );
    expect(sent.html).toContain(V2_URL);
    expect(sent.text).toContain(V2_URL);
    // And nothing minted a competing v1 link.
    expect(sent.html).not.toMatch(/token=eyJ|token=[A-Za-z0-9_-]{40,}/);
  });

  it("appends the supplied URL as a footer when the body has no placeholder", async () => {
    const sender = fakeSender();
    await sendWithSuppressionCheck({
      db: getDb(),
      sender,
      to: "sub@example.com",
      html: "<p>No placeholder here</p>",
      unsubscribeContext: { url: V2_URL },
      ...base,
    });
    expect(sender.calls[0].html).toContain(V2_URL);
  });

  it("still mints its own token when no context is given", async () => {
    const sender = fakeSender();
    await sendWithSuppressionCheck({
      db: getDb(),
      sender,
      to: "sub@example.com",
      html: "<p>{{unsubscribe_url}}</p>",
      ...base,
    });
    const header = sender.calls[0].headers?.["List-Unsubscribe"];
    // Existing behaviour for transactional/sequence marketing mail is untouched.
    expect(header).toMatch(/^<http.*\/unsubscribe\?token=.+>$/);
    expect(header).not.toContain("v2-per-list-token");
  });

  /**
   * The retry path is where the spec had a gap. `attemptOutboxRow` re-runs this
   * helper, so without honouring the stored header a campaign retry would
   * silently downgrade the recipient's v2 link to a v1 one — the same email,
   * delivered twice, with two different meanings for "unsubscribe".
   */
  it("reuses the stored List-Unsubscribe header on a retry", async () => {
    const sender = fakeSender();
    await sendWithSuppressionCheck({
      db: getDb(),
      sender,
      to: "sub@example.com",
      html: "<p>{{unsubscribe_url}}</p>",
      // Exactly what the outbox round-trips from the original attempt.
      headers: {
        "Message-ID": "<m1@saasmail.test>",
        "List-Unsubscribe": `<${V2_URL}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      ...base,
    });

    const sent = sender.calls[0];
    expect(sent.headers?.["List-Unsubscribe"]).toBe(`<${V2_URL}>`);
    expect(sent.html).toContain(V2_URL);
    // The original Message-ID is preserved too, as it already was.
    expect(sent.headers?.["Message-ID"]).toBe("<m1@saasmail.test>");
  });

  /**
   * A single URL cannot be shared: each recipient's token is what identifies
   * *them*, so reusing one would let a recipient unsubscribe somebody else.
   */
  it("ignores a supplied URL when there is more than one recipient", async () => {
    const sender = fakeSender();
    await sendWithSuppressionCheck({
      db: getDb(),
      sender,
      to: "a@example.com",
      cc: [{ email: "b@example.com", name: null }],
      html: "<p>{{unsubscribe_url}}</p>",
      unsubscribeContext: { url: V2_URL },
      ...base,
    });

    expect(sender.calls).toHaveLength(2);
    for (const call of sender.calls) {
      expect(call.headers?.["List-Unsubscribe"]).not.toBe(`<${V2_URL}>`);
    }
    // Each recipient got a distinct token.
    expect(sender.calls[0].headers?.["List-Unsubscribe"]).not.toBe(
      sender.calls[1].headers?.["List-Unsubscribe"],
    );
  });

  it("does not add unsubscribe headers to a transactional send", async () => {
    const sender = fakeSender();
    await sendWithSuppressionCheck({
      db: getDb(),
      sender,
      to: "sub@example.com",
      html: "<p>Receipt</p>",
      unsubscribeContext: { url: V2_URL },
      env: env as unknown as CloudflareBindings,
      from: "News <news@saasmail.test>",
      subject: "Receipt",
      transactional: true,
    });
    expect(sender.calls[0].headers?.["List-Unsubscribe"]).toBeUndefined();
  });
});
