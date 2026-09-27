import { describe, expect, it } from "vitest";
import type { ContentPart } from "../jmap/content";
import {
  buildRawMessage,
  rfc5322Date,
  type RawMessageInput,
} from "../jmap/raw-message";

const textLeaf: ContentPart = {
  partId: "1",
  type: "text/plain",
  charset: "utf-8",
  name: null,
  disposition: null,
  cid: null,
  size: 12,
  r2Key: null,
};

function input(overrides: Partial<RawMessageInput> = {}): RawMessageInput {
  return {
    contentId: "c1",
    from: { name: "Ada", email: "ada@saasmail.test" },
    to: [{ name: null, email: "bob@example.com" }],
    cc: [],
    replyTo: null,
    subject: "Hi",
    messageId: "m1@saasmail.test",
    inReplyTo: null,
    references: null,
    sentAt: "2026-09-26T10:00:00Z",
    root: textLeaf,
    bodyValues: { "1": "Hello\nWorld" },
    ...overrides,
  };
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("buildRawMessage", () => {
  it("writes a byte-exact single-part message", () => {
    expect(decode(buildRawMessage(input(), new Map()))).toBe(
      [
        "Date: Sat, 26 Sep 2026 10:00:00 +0000",
        "From: Ada <ada@saasmail.test>",
        "To: bob@example.com",
        "Subject: Hi",
        "Message-ID: <m1@saasmail.test>",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        // "Hello\r\nWorld": body values are CRLF-normalised before encoding.
        "SGVsbG8NCldvcmxk",
        "",
      ].join("\r\n"),
    );
  });

  it("is deterministic and never emits a bare LF", () => {
    const first = buildRawMessage(input(), new Map());
    const second = buildRawMessage(input(), new Map());
    expect(second).toEqual(first);
    expect(decode(first)).not.toMatch(/[^\r]\n/);
  });

  it("encodes non-ASCII headers, keeps the offset in Date, and omits Bcc", () => {
    const text = decode(
      buildRawMessage(
        input({
          from: { name: "Zoë", email: "zoe@saasmail.test" },
          to: [
            { name: "Doe, John", email: "john@example.com" },
            { name: null, email: "amy@example.com" },
          ],
          subject: "Café",
          sentAt: "2026-09-26T12:00:00+02:00",
          inReplyTo: ["a@x.io"],
          references: ["r1@x.io", "a@x.io"],
        }),
        new Map(),
      ),
    );
    expect(text).toContain("Date: Sat, 26 Sep 2026 12:00:00 +0200\r\n");
    expect(text).toContain(
      "From: =?UTF-8?B?Wm/Dqw==?= <zoe@saasmail.test>\r\n",
    );
    expect(text).toContain(
      'To: "Doe, John" <john@example.com>,\r\n amy@example.com\r\n',
    );
    expect(text).toContain("Subject: =?UTF-8?B?Q2Fmw6k=?=\r\n");
    expect(text).toContain("In-Reply-To: <a@x.io>\r\n");
    expect(text).toContain("References: <r1@x.io>\r\n <a@x.io>\r\n");
    expect(text).not.toMatch(/^Bcc:/im);
  });

  it("builds multipart with deterministic boundaries, attachments, cid and folded base64", () => {
    const root: ContentPart = {
      partId: null,
      type: "multipart/mixed",
      subParts: [
        textLeaf,
        {
          partId: "2",
          type: "application/pdf",
          charset: null,
          name: "résumé.pdf",
          disposition: "attachment",
          cid: null,
          size: 100,
          r2Key: "k/2",
        },
        {
          partId: "3",
          type: "image/png",
          charset: null,
          name: "logo.png",
          disposition: "inline",
          cid: "logo@x",
          size: 3,
          r2Key: "k/3",
        },
      ],
    };
    const text = decode(
      buildRawMessage(
        input({ contentId: "c2", root }),
        new Map([
          ["2", new Uint8Array(100).fill(65)],
          ["3", new TextEncoder().encode("abc")],
        ]),
      ),
    );
    expect(text).toContain(
      'Content-Type: multipart/mixed; boundary="=_saasmail_c2_0"\r\n',
    );
    expect(text.split("--=_saasmail_c2_0\r\n")).toHaveLength(4);
    expect(text).toContain("--=_saasmail_c2_0--\r\n");
    expect(text).toContain(
      "Content-Disposition: attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf\r\n",
    );
    expect(text).toContain(
      'Content-Disposition: inline; filename="logo.png"\r\n',
    );
    expect(text).toContain("Content-ID: <logo@x>\r\n");
    expect(text).toContain("YWJj\r\n");
    // 100 bytes -> 136 base64 characters -> a 76-character line then 60
    // (14 full "QUFB" groups plus the final "QQ==").
    expect(text).toMatch(/\r\n(QUFB){19}\r\n(QUFB){14}QQ==\r\n/);
  });

  it("throws when an attachment's bytes are missing", () => {
    const root: ContentPart = {
      partId: null,
      type: "multipart/mixed",
      subParts: [
        textLeaf,
        {
          ...textLeaf,
          partId: "2",
          type: "application/pdf",
          charset: null,
          r2Key: "k/2",
        },
      ],
    };
    expect(() => buildRawMessage(input({ root }), new Map())).toThrow("part 2");
  });

  it("formats RFC 5322 dates", () => {
    expect(rfc5322Date("2026-01-05T03:04:05.123Z")).toBe(
      "Mon, 5 Jan 2026 03:04:05 +0000",
    );
    expect(rfc5322Date("2026-09-26T23:30:00-05:30")).toBe(
      "Sat, 26 Sep 2026 23:30:00 -0530",
    );
  });
});
