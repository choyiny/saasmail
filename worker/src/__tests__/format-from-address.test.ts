import { describe, expect, it } from "vitest";
import { encodeDisplayName } from "../lib/format-from-address";

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
