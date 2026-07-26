import { describe, expect, it } from "vitest";
import {
  FORWARD_LOOP_HEADER,
  FORWARD_ORIGINAL_FROM_HEADER,
  FORWARD_ORIGINAL_MESSAGE_ID_HEADER,
  buildForwardMessage,
  type BuildForwardMessageParams,
} from "../lib/inbound-forward";

function bytes(n: number): ArrayBuffer {
  return new ArrayBuffer(n);
}

function params(
  over: Partial<BuildForwardMessageParams> = {},
): BuildForwardMessageParams {
  return {
    inbox: "support@acme.com",
    forwardTo: "boss@outlook.com",
    inboxDisplayName: "Acme Support",
    from: { address: "jane@example.com", name: "Jane Customer" },
    subject: "Help with my order",
    fullBodyHtml: "<p>Hi, I can't log in</p>",
    fullBodyText: "Hi, I can't log in",
    messageId: "<abc123@example.com>",
    receivedAt: 1_750_000_000,
    cc: [],
    auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
    attachments: [],
    headers: {},
    knownInboxes: ["support@acme.com", "sales@acme.com"],
    maxAttachmentBytes: 1000,
    ...over,
  };
}

function ok(over: Partial<BuildForwardMessageParams> = {}) {
  const r = buildForwardMessage(params(over));
  if (!r.ok) throw new Error(`expected ok, got skip: ${r.reason}`);
  return r;
}

describe("buildForwardMessage — skip conditions", () => {
  it("skips when no destination is configured", () => {
    const r = buildForwardMessage(params({ forwardTo: null }));
    expect(r).toEqual({ ok: false, reason: "no-destination" });
  });

  it("skips a whitespace-only destination", () => {
    const r = buildForwardMessage(params({ forwardTo: "   " }));
    expect(r).toEqual({ ok: false, reason: "no-destination" });
  });

  it("skips when the destination is the inbox itself", () => {
    const r = buildForwardMessage(params({ forwardTo: "support@acme.com" }));
    expect(r).toEqual({ ok: false, reason: "loop-self" });
  });

  it("treats a differently-cased self-destination as a loop", () => {
    const r = buildForwardMessage(params({ forwardTo: "SUPPORT@Acme.com" }));
    expect(r).toEqual({ ok: false, reason: "loop-self" });
  });

  it("skips when the destination is another inbox on this instance", () => {
    // Would bounce back through handleEmail and loop.
    const r = buildForwardMessage(params({ forwardTo: "sales@acme.com" }));
    expect(r).toEqual({ ok: false, reason: "loop-known-inbox" });
  });

  it("skips a message that already carries the forward trip-wire header", () => {
    const r = buildForwardMessage(
      params({ headers: { [FORWARD_LOOP_HEADER.toLowerCase()]: "x@y.com" } }),
    );
    expect(r).toEqual({ ok: false, reason: "loop-header" });
  });

  it("matches the trip-wire header case-insensitively", () => {
    const r = buildForwardMessage(
      params({ headers: { "X-SaaSMail-Forwarded-For": "x@y.com" } }),
    );
    expect(r).toEqual({ ok: false, reason: "loop-header" });
  });
});

describe("buildForwardMessage — envelope rewriting", () => {
  it("sends from the inbox, not the original sender", () => {
    // The whole point: mail must authenticate on our own domain. Sending as
    // jane@example.com from our IPs would fail SPF/DKIM/DMARC.
    const { message } = ok();
    expect(message.from).toContain("<support@acme.com>");
    expect(message.from).not.toContain("<jane@example.com>");
  });

  it("names the original sender in the From display name", () => {
    const { message } = ok();
    expect(message.from).toContain("Jane Customer");
    expect(message.from).toContain("via Acme Support");
  });

  it("quotes the display name, since it contains RFC 5322 specials", () => {
    // "(" and ")" are specials — an unquoted From breaks provider parsing.
    const { message } = ok();
    expect(message.from.startsWith('"')).toBe(true);
  });

  it("falls back to the inbox address when it has no display name", () => {
    const { message } = ok({ inboxDisplayName: null });
    expect(message.from).toContain("via support@acme.com");
  });

  it("uses the sender address as the label when the sender has no name", () => {
    const { message } = ok({
      from: { address: "jane@example.com", name: "" },
    });
    expect(message.from).toContain("jane@example.com (via Acme Support)");
  });

  it("sets Reply-To to the original sender so replies reach them", () => {
    const { message } = ok();
    expect(message.headers?.["Reply-To"]).toBe("jane@example.com");
  });

  it("addresses the forward to the configured destination, lowercased", () => {
    const { message } = ok({ forwardTo: "Boss@Outlook.COM" });
    expect(message.to).toBe("boss@outlook.com");
  });

  it("passes the subject through unchanged so destination threading matches", () => {
    const { message } = ok();
    expect(message.subject).toBe("Help with my order");
  });

  it("substitutes a placeholder for an empty subject", () => {
    const { message } = ok({ subject: "" });
    expect(message.subject).toBe("(no subject)");
  });

  it("stamps the loop trip-wire header with the inbox", () => {
    const { message } = ok();
    expect(message.headers?.[FORWARD_LOOP_HEADER]).toBe("support@acme.com");
  });

  it("records the original sender and message id as headers", () => {
    const { message } = ok();
    expect(message.headers?.[FORWARD_ORIGINAL_FROM_HEADER]).toBe(
      "jane@example.com",
    );
    expect(message.headers?.[FORWARD_ORIGINAL_MESSAGE_ID_HEADER]).toBe(
      "<abc123@example.com>",
    );
  });

  it("omits the original-message-id header when there was none", () => {
    const { message } = ok({ messageId: null });
    expect(
      message.headers?.[FORWARD_ORIGINAL_MESSAGE_ID_HEADER],
    ).toBeUndefined();
  });

  it("never reuses the original Message-ID on the new message", () => {
    // Reusing it would collide with the message we already stored.
    const { message } = ok();
    expect(message.headers?.["Message-ID"]).toBeUndefined();
  });

  it("does NOT re-send to the original Cc recipients", () => {
    // Critical: those are the sender's contacts. Mailing them would leak the
    // redirect to people who never opted into it.
    const { message } = ok({
      cc: [
        { email: "colleague@example.com", name: "Colleague" },
        { email: "other@example.com", name: null },
      ],
    });
    expect(message.cc).toBeUndefined();
    expect(message.to).toBe("boss@outlook.com");
  });

  it("still shows the Cc list in the body header block", () => {
    const { message } = ok({
      cc: [{ email: "colleague@example.com", name: "Colleague" }],
    });
    expect(message.html).toContain("colleague@example.com");
  });
});

describe("buildForwardMessage — body", () => {
  it("uses the untrimmed body so quoted history survives", () => {
    const full = '<p>my reply</p><div class="gmail_quote">older thread</div>';
    const { message } = ok({ fullBodyHtml: full });
    expect(message.html).toContain("older thread");
  });

  it("includes the original envelope in a header block", () => {
    const { message } = ok();
    expect(message.html).toContain("jane@example.com");
    expect(message.html).toContain("Help with my order");
    expect(message.html).toContain("support@acme.com");
  });

  it("reports the original auth verdicts", () => {
    const { message } = ok({
      auth: { spf: "fail", dkim: null, dmarc: "fail" },
    });
    expect(message.html).toContain("spf=fail");
    expect(message.html).toContain("dkim=none");
    expect(message.html).toContain("dmarc=fail");
  });

  it("escapes the header block against HTML injection via sender name", () => {
    const { message } = ok({
      from: {
        address: "jane@example.com",
        name: "<img src=x onerror=alert(1)>",
      },
    });
    // The injected markup must appear escaped inside the block we build.
    expect(message.html).toContain("&lt;img");
    expect(message.html).not.toContain("<img src=x");
  });

  it("wraps a text-only message in a pre block", () => {
    const { message } = ok({
      fullBodyHtml: null,
      fullBodyText: "plain only",
    });
    expect(message.html).toContain("<pre");
    expect(message.html).toContain("plain only");
  });

  it("handles a message with no body at all", () => {
    const { message } = ok({ fullBodyHtml: null, fullBodyText: null });
    expect(message.html).toContain("no message body");
    expect(message.text).toContain("no message body");
  });

  it("builds a plain-text alternative with the same header block", () => {
    const { message } = ok();
    expect(message.text).toContain("Forwarded by saasmail");
    expect(message.text).toContain("From: Jane Customer <jane@example.com>");
    expect(message.text).toContain("Hi, I can't log in");
  });
});

describe("buildForwardMessage — attachments", () => {
  it("forwards attachments that fit under the provider cap", () => {
    const { message, skippedAttachments } = ok({
      attachments: [
        {
          filename: "shot.png",
          contentType: "image/png",
          content: bytes(500),
          contentId: null,
          disposition: "attachment",
        },
      ],
    });
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments?.[0].filename).toBe("shot.png");
    expect(skippedAttachments).toEqual([]);
  });

  it("skips attachments that would exceed the cap, and names them", () => {
    const { message, skippedAttachments } = ok({
      maxAttachmentBytes: 1000,
      attachments: [
        {
          filename: "small.png",
          contentType: "image/png",
          content: bytes(600),
          contentId: null,
          disposition: "attachment",
        },
        {
          filename: "huge.zip",
          contentType: "application/zip",
          content: bytes(900),
          contentId: null,
          disposition: "attachment",
        },
      ],
    });
    expect(message.attachments).toHaveLength(1);
    expect(skippedAttachments).toEqual(["huge.zip"]);
  });

  it("tells the recipient in the body when attachments were withheld", () => {
    // Silently dropping them would leave the reader unaware anything is missing.
    const { message } = ok({
      maxAttachmentBytes: 10,
      attachments: [
        {
          filename: "huge.zip",
          contentType: "application/zip",
          content: bytes(5000),
          contentId: null,
          disposition: "attachment",
        },
      ],
    });
    expect(message.html).toContain("huge.zip");
    expect(message.html).toContain("too large to forward");
    expect(message.text).toContain("huge.zip");
  });

  it("omits the attachments key entirely when there are none", () => {
    const { message } = ok({ attachments: [] });
    expect(message.attachments).toBeUndefined();
  });
});
