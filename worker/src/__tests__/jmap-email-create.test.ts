import { describe, expect, it } from "vitest";
import {
  contentLeaves,
  contentPreview,
  deriveBodyLists,
  type ContentLeaf,
  type ContentPart,
} from "../jmap/content";
import {
  MAX_CC_ENTRIES,
  parseEmailCreate,
  Rejection,
  type ParsedEmailCreate,
} from "../jmap/email-create";

const base = {
  mailboxIds: { mbox: true },
  keywords: { $draft: true },
  from: [{ name: "Ada", email: "ada@saasmail.test" }],
  to: [{ name: null, email: "bob@example.com" }],
  subject: "Hi",
  textBody: [{ partId: "t", type: "text/plain" }],
  bodyValues: { t: { value: "Hello\r\nthere" } },
};

function parse(overrides: Record<string, unknown> = {}) {
  return parseEmailCreate({ ...base, ...overrides });
}

function rejected(overrides: Record<string, unknown>) {
  const result = parse(overrides);
  expect(result).toBeInstanceOf(Rejection);
  return (result as Rejection).error;
}

function leaf(
  partId: string,
  type: string,
  extra: Partial<ContentLeaf> = {},
): ContentLeaf {
  return {
    partId,
    type,
    charset: type.startsWith("text/") ? "utf-8" : null,
    name: null,
    disposition: null,
    cid: null,
    size: 1,
    r2Key: type.startsWith("text/") ? null : `k/${partId}`,
    ...extra,
  };
}

describe("parseEmailCreate", () => {
  it("normalises a minimal draft", () => {
    const result = parse() as ParsedEmailCreate;
    expect(result).not.toBeInstanceOf(Rejection);
    expect(result.mailboxId).toBe("mbox");
    expect(result.seen).toBe(false);
    expect(result.flagged).toBe(false);
    expect(result.from).toEqual({ name: "Ada", email: "ada@saasmail.test" });
    expect(result.to).toEqual([{ name: null, email: "bob@example.com" }]);
    expect(result.cc).toEqual([]);
    expect(result.replyTo).toBeNull();
    expect(result.messageId).toBeNull();
    expect(result.sentAt).toBeNull();
    expect(result.receivedAt).toBeNull();
    // CRLF becomes LF in stored values (RFC 8621 EmailBodyValue).
    expect(result.body).toEqual({
      kind: "text",
      type: "text/plain",
      value: "Hello\nthere",
      name: null,
      disposition: null,
      cid: null,
    });
  });

  it("builds mixed(alternative(text, related(html, inline)), attachment) from the flattened form", () => {
    const result = parse({
      htmlBody: [{ partId: "h", type: "text/html" }],
      bodyValues: {
        t: { value: "Hello" },
        h: { value: '<p>Hello <img src="cid:logo"></p>' },
      },
      attachments: [
        {
          blobId: "Ulogo",
          type: "image/png",
          disposition: "inline",
          cid: "<logo>",
        },
        { blobId: "Updf", type: "application/pdf", name: "a.pdf" },
      ],
    }) as ParsedEmailCreate;
    expect(result.body).toEqual({
      kind: "multipart",
      type: "multipart/mixed",
      subParts: [
        {
          kind: "multipart",
          type: "multipart/alternative",
          subParts: [
            {
              kind: "text",
              type: "text/plain",
              value: "Hello",
              name: null,
              disposition: null,
              cid: null,
            },
            {
              kind: "multipart",
              type: "multipart/related",
              subParts: [
                {
                  kind: "text",
                  type: "text/html",
                  value: '<p>Hello <img src="cid:logo"></p>',
                  name: null,
                  disposition: null,
                  cid: null,
                },
                {
                  kind: "blob",
                  blobId: "Ulogo",
                  type: "image/png",
                  name: null,
                  disposition: "inline",
                  cid: "logo",
                },
              ],
            },
          ],
        },
        // Flattened attachments default to disposition "attachment".
        {
          kind: "blob",
          blobId: "Updf",
          type: "application/pdf",
          name: "a.pdf",
          disposition: "attachment",
          cid: null,
        },
      ],
    });
  });

  it("accepts a supported bodyStructure and keeps it as given", () => {
    const result = parse({
      textBody: undefined,
      bodyStructure: {
        type: "multipart/alternative",
        subParts: [
          { partId: "t", type: "text/plain" },
          { partId: "h", type: "text/html" },
        ],
      },
      bodyValues: { t: { value: "a" }, h: { value: "<b>a</b>" } },
    }) as ParsedEmailCreate;
    expect(result).not.toBeInstanceOf(Rejection);
    expect((result.body as { type: string }).type).toBe(
      "multipart/alternative",
    );
  });

  it.each([
    ["missing mailboxIds", { mailboxIds: undefined }, ["mailboxIds"]],
    ["two mailboxes", { mailboxIds: { a: true, b: true } }, ["mailboxIds"]],
    ["no $draft", { keywords: { $seen: true } }, ["keywords"]],
    [
      "unsupported keyword",
      { keywords: { $draft: true, $answered: true } },
      ["keywords"],
    ],
    [
      "two from addresses",
      { from: [{ email: "a@x.io" }, { email: "b@x.io" }] },
      ["from"],
    ],
    ["no from", { from: [] }, ["from"]],
    [
      "too many cc",
      {
        cc: Array.from({ length: MAX_CC_ENTRIES + 1 }, (_, i) => ({
          email: `c${i}@x.io`,
        })),
      },
      ["cc"],
    ],
    ["bad address", { to: [{ email: "not-an-address" }] }, ["to"]],
    ["server-set id", { id: "x" }, ["id"]],
    ["server-set size", { size: 3 }, ["size"]],
    ["headers", { headers: [] }, ["headers"]],
    ["header:*", { "header:X-Foo:asText": "bar" }, ["header:X-Foo:asText"]],
    ["unknown property", { colour: "blue" }, ["colour"]],
    ["non-null sender", { sender: [{ email: "a@x.io" }] }, ["sender"]],
    [
      "subject injection",
      { subject: "Hi\r\nBcc: evil@example.com" },
      ["subject"],
    ],
    [
      "display-name injection",
      {
        to: [{ name: "Bob\nBcc: evil@example.com", email: "bob@example.com" }],
      },
      ["to"],
    ],
    ["messageId injection", { messageId: ["a\r\n@b"] }, ["messageId"]],
    ["messageId without @", { messageId: ["no-at-sign"] }, ["messageId"]],
    ["two messageIds", { messageId: ["a@b", "c@d"] }, ["messageId"]],
    ["bad sentAt", { sentAt: "yesterday" }, ["sentAt"]],
    [
      "receivedAt with offset",
      { receivedAt: "2026-09-26T10:00:00+02:00" },
      ["receivedAt"],
    ],
    [
      "bodyStructure and textBody",
      { bodyStructure: { partId: "t", type: "text/plain" } },
      ["bodyStructure"],
    ],
    ["textBody without value", { bodyValues: {} }, ["textBody"]],
    [
      "two textBody parts",
      { textBody: [{ partId: "t" }, { partId: "t" }] },
      ["textBody"],
    ],
    [
      "html in textBody",
      { textBody: [{ partId: "t", type: "text/html" }] },
      ["textBody"],
    ],
    [
      "textBody with blobId",
      { textBody: [{ blobId: "Ux", type: "text/plain" }] },
      ["textBody"],
    ],
    [
      "truncated body value",
      { bodyValues: { t: { value: "x", isTruncated: true } } },
      ["bodyValues"],
    ],
    [
      "attachment without blobId",
      { attachments: [{ partId: "t" }] },
      ["attachments"],
    ],
    [
      "attachment cid injection",
      { attachments: [{ blobId: "Ux", cid: "a\r\nb" }] },
      ["attachments"],
    ],
    [
      "attachment name injection",
      { attachments: [{ blobId: "Ux", name: "a\nb.txt" }] },
      ["attachments"],
    ],
  ])("rejects %s", (_label, overrides, properties) => {
    expect(rejected(overrides as Record<string, unknown>)).toEqual({
      type: "invalidProperties",
      properties,
    });
  });

  it.each([
    [
      "an unsupported multipart",
      { type: "multipart/signed", subParts: [{ partId: "t" }] },
    ],
    [
      "mixed without a body",
      {
        type: "multipart/mixed",
        subParts: [{ blobId: "Ux", type: "application/pdf" }],
      },
    ],
    ["a root attachment", { blobId: "Ux", type: "application/pdf" }],
    ["partId and blobId", { partId: "t", blobId: "Ux", type: "text/plain" }],
    [
      "a non-utf-8 charset",
      { partId: "t", type: "text/plain", charset: "iso-8859-1" },
    ],
    ["a part header", { partId: "t", type: "text/plain", "header:X-A": "b" }],
    [
      "related without html first",
      {
        type: "multipart/related",
        subParts: [
          { blobId: "Ux", type: "image/png" },
          { partId: "t", type: "text/html" },
        ],
      },
    ],
  ])("rejects a bodyStructure with %s", (_label, bodyStructure) => {
    expect(
      rejected({
        textBody: undefined,
        bodyStructure,
        bodyValues: { t: { value: "x" } },
      }),
    ).toEqual({ type: "invalidProperties", properties: ["bodyStructure"] });
  });
});

describe("deriveBodyLists (RFC 8621 §4.1.4)", () => {
  it("puts a lone text part in both text and html lists", () => {
    expect(deriveBodyLists(leaf("1", "text/plain"))).toEqual({
      textBody: ["1"],
      htmlBody: ["1"],
      attachments: [],
    });
  });

  it("splits alternative, keeps related images as attachments, and lists mixed attachments", () => {
    const root: ContentPart = {
      partId: null,
      type: "multipart/mixed",
      subParts: [
        {
          partId: null,
          type: "multipart/alternative",
          subParts: [
            leaf("1", "text/plain"),
            {
              partId: null,
              type: "multipart/related",
              subParts: [
                leaf("2", "text/html"),
                leaf("3", "image/png", { disposition: "inline", cid: "logo" }),
              ],
            },
          ],
        },
        leaf("4", "application/pdf", {
          disposition: "attachment",
          name: "a.pdf",
        }),
      ],
    };
    expect(deriveBodyLists(root)).toEqual({
      textBody: ["1"],
      htmlBody: ["2"],
      attachments: ["3", "4"],
    });
    expect(contentLeaves(root).map((part) => part.partId)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
  });

  it("previews the text body, else the html body as text, capped at 256 characters", () => {
    const text = leaf("1", "text/plain");
    expect(
      contentPreview(
        text,
        { "1": "  Hello\n\n world " },
        deriveBodyLists(text),
      ),
    ).toBe("Hello world");
    const html = leaf("1", "text/html");
    expect(
      contentPreview(
        html,
        { "1": "<p>Hi <b>there</b></p>" },
        deriveBodyLists(html),
      ),
    ).toBe("Hi there");
    expect(
      contentPreview(text, { "1": "x".repeat(400) }, deriveBodyLists(text)),
    ).toHaveLength(256);
  });
});
