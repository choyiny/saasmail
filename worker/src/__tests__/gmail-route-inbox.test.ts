import { describe, it, expect } from "vitest";
import { resolveInbox } from "../lib/gmail/route-inbox";
import type { ParsedEmail } from "../lib/email-parser";

function parsed(headers: Record<string, string>): ParsedEmail {
  return {
    from: { address: "jane@example.com", name: "Jane" },
    to: "collector@acme.dev",
    cc: [],
    subject: "s",
    bodyHtml: null,
    bodyText: "b",
    fullBodyHtml: null,
    fullBodyText: "b",
    messageId: "<m@example.com>",
    headers,
    attachments: [],
    auth: { spf: null, dkim: null, dmarc: null },
    spamScore: null,
  } as unknown as ParsedEmail;
}

const GROUPS = [
  { email: "support@acme.dev", gmailGroupAddress: "support@acme.dev" },
  { email: "sales@acme.dev", gmailGroupAddress: "sales@acme.dev" },
];

describe("resolveInbox", () => {
  // Must MATCH cases

  it("matches a group on Delivered-To", () => {
    expect(
      resolveInbox(parsed({ "delivered-to": "support@acme.dev" }), GROUPS),
    ).toBe("support@acme.dev");
  });

  it("is case-insensitive on Delivered-To", () => {
    expect(
      resolveInbox(parsed({ "delivered-to": "Support@Acme.DEV" }), GROUPS),
    ).toBe("support@acme.dev");
  });

  it("matches a group on List-ID with dot-form and angle brackets", () => {
    expect(
      resolveInbox(
        parsed({ "list-id": "Acme Support <support.acme.dev>" }),
        GROUPS,
      ),
    ).toBe("support@acme.dev");
  });

  it("matches a group on List-ID with just angle brackets", () => {
    expect(
      resolveInbox(parsed({ "list-id": "<support.acme.dev>" }), GROUPS),
    ).toBe("support@acme.dev");
  });

  it("matches a group on X-Original-To", () => {
    expect(
      resolveInbox(parsed({ "x-original-to": "support@acme.dev" }), GROUPS),
    ).toBe("support@acme.dev");
  });

  it("matches a group on Delivered-To with comment", () => {
    expect(
      resolveInbox(
        parsed({ "delivered-to": "support@acme.dev (Acme Support)" }),
        GROUPS,
      ),
    ).toBe("support@acme.dev");
  });

  it("prefers a group match over the catch-all mailbox", () => {
    const mappings = [
      { email: "cho@acme.dev", gmailGroupAddress: null },
      ...GROUPS,
    ];
    expect(
      resolveInbox(parsed({ "delivered-to": "support@acme.dev" }), mappings),
    ).toBe("support@acme.dev");
  });

  it("falls back to the catch-all mailbox when no group matches", () => {
    const mappings = [
      { email: "cho@acme.dev", gmailGroupAddress: null },
      ...GROUPS,
    ];
    expect(
      resolveInbox(parsed({ "delivered-to": "cho@acme.dev" }), mappings),
    ).toBe("cho@acme.dev");
  });

  // Must NOT MATCH cases

  it("rejects a trailing comment attack (evil@attacker.test followed by comment with target)", () => {
    const mappings = [
      { email: "cho@acme.dev", gmailGroupAddress: null },
      ...GROUPS,
    ];
    expect(
      resolveInbox(
        parsed({ "delivered-to": "evil@attacker.test (<support@acme.dev>)" }),
        mappings,
      ),
    ).toBe("cho@acme.dev");
  });

  it("rejects brackets in Delivered-To (addr-spec before bracket)", () => {
    const mappings = [
      { email: "cho@acme.dev", gmailGroupAddress: null },
      ...GROUPS,
    ];
    expect(
      resolveInbox(
        parsed({ "delivered-to": "evil@attacker.test <support@acme.dev>" }),
        mappings,
      ),
    ).toBe("cho@acme.dev");
  });

  it("rejects quoted display-name attack in Delivered-To", () => {
    const mappings = [
      { email: "cho@acme.dev", gmailGroupAddress: null },
      ...GROUPS,
    ];
    expect(
      resolveInbox(
        parsed({
          "delivered-to": '"<support@acme.dev>, Smith" <evil@attacker.test>',
        }),
        mappings,
      ),
    ).toBe("cho@acme.dev");
  });

  it("rejects a partial-match on the left (info-support@acme.dev does not match support@acme.dev)", () => {
    const mappings = [
      { email: "cho@acme.dev", gmailGroupAddress: null },
      ...GROUPS,
    ];
    expect(
      resolveInbox(
        parsed({ "delivered-to": "info-support@acme.dev" }),
        mappings,
      ),
    ).toBe("cho@acme.dev");
  });

  it("rejects a partial-match on the right (support@acme.dev.evil.test does not match support@acme.dev)", () => {
    const mappings = [
      { email: "cho@acme.dev", gmailGroupAddress: null },
      ...GROUPS,
    ];
    expect(
      resolveInbox(
        parsed({ "delivered-to": "support@acme.dev.evil.test" }),
        mappings,
      ),
    ).toBe("cho@acme.dev");
  });

  it("rejects multiple bracket pairs in List-ID", () => {
    const mappings = [
      { email: "cho@acme.dev", gmailGroupAddress: null },
      ...GROUPS,
    ];
    expect(
      resolveInbox(
        parsed({ "list-id": "<evil.attacker.test> <support.acme.dev>" }),
        mappings,
      ),
    ).toBe("cho@acme.dev");
  });

  it("rejects the @/. collision (support.acme@dev should not match support@acme.dev)", () => {
    const mappings = [
      { email: "cho@acme.dev", gmailGroupAddress: null },
      ...GROUPS,
    ];
    expect(
      resolveInbox(parsed({ "delivered-to": "<support.acme@dev>" }), mappings),
    ).toBe("cho@acme.dev");
  });

  it("ignores To header (sender-controlled) and falls back to catch-all", () => {
    const mappings = [
      { email: "cho@acme.dev", gmailGroupAddress: null },
      ...GROUPS,
    ];
    expect(resolveInbox(parsed({ to: "support@acme.dev" }), mappings)).toBe(
      "cho@acme.dev",
    );
  });

  it("returns null when nothing matches and there is no catch-all", () => {
    expect(
      resolveInbox(parsed({ "delivered-to": "other@acme.dev" }), GROUPS),
    ).toBeNull();
  });

  it("returns null for an empty mapping list", () => {
    expect(
      resolveInbox(parsed({ "delivered-to": "support@acme.dev" }), []),
    ).toBeNull();
  });

  it("ignores a group address that only appears inside the body-less headers it does not scan", () => {
    // Subject is not a routing header; a group address there must not match.
    expect(
      resolveInbox(parsed({ subject: "about support@acme.dev" }), GROUPS),
    ).toBeNull();
  });
});
