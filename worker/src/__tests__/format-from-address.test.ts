import { describe, expect, it } from "vitest";
import { encodeDisplayName } from "../lib/format-from-address";
import { parseFrom } from "../lib/email-sender/shared";

describe("encodeDisplayName", () => {
  it("leaves a plain display name as a bare atom sequence", () => {
    expect(encodeDisplayName("The Support Team")).toBe("The Support Team");
  });

  it("quotes a display name containing a comma", () => {
    // Regression: unquoted, providers split the From header on the comma and
    // reject the send with "Illegal email address 'Ada'".
    expect(encodeDisplayName("Ada, VP of Engineering")).toBe(
      '"Ada, VP of Engineering"',
    );
  });

  it("quotes other RFC 5322 specials", () => {
    expect(encodeDisplayName("Support (Billing)")).toBe('"Support (Billing)"');
    expect(encodeDisplayName("a@b")).toBe('"a@b"');
    expect(encodeDisplayName("Sales: EMEA")).toBe('"Sales: EMEA"');
  });

  it("escapes embedded quotes and backslashes", () => {
    expect(encodeDisplayName('Bob "The Builder"')).toBe(
      '"Bob \\"The Builder\\""',
    );
    expect(encodeDisplayName("back\\slash, inc")).toBe('"back\\\\slash, inc"');
  });
});

describe("parseFrom", () => {
  it.each([
    ["Privacy @ Snowlan", "Privacy @ Snowlan"],
    ["Ada, VP of Engineering", "Ada, VP of Engineering"],
    ['Bob "The Builder"', 'Bob "The Builder"'],
    ["back\\slash, inc", "back\\slash, inc"],
    ["The Support Team", "The Support Team"],
  ])("round-trips %s through encodeDisplayName", (name, expected) => {
    expect(parseFrom(`${encodeDisplayName(name)} <hello@example.com>`)).toEqual(
      {
        name: expected,
        address: "hello@example.com",
      },
    );
  });

  it("parses a bare address without inventing a display name", () => {
    expect(parseFrom("hello@example.com")).toEqual({
      address: "hello@example.com",
    });
  });
});
