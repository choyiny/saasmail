import { describe, it, expect } from "vitest";
import { parseFrom } from "../lib/email-sender/shared";
import { encodeDisplayName } from "../lib/format-from-address";

describe("parseFrom", () => {
  it("parses a bare display name", () => {
    expect(parseFrom("Matt <support@example.com>")).toEqual({
      name: "Matt",
      address: "support@example.com",
    });
  });

  it("strips both quotes from a quoted display name", () => {
    expect(parseFrom('"Matt from Example.io" <support@example.com>')).toEqual({
      name: "Matt from Example.io",
      address: "support@example.com",
    });
  });

  it("unescapes quotes and backslashes inside a quoted display name", () => {
    expect(
      parseFrom('"Ada \\"The Countess\\" \\\\ L" <ada@example.com>'),
    ).toEqual({
      name: 'Ada "The Countess" \\ L',
      address: "ada@example.com",
    });
  });

  it("round-trips names that encodeDisplayName has to quote", () => {
    for (const name of [
      "Matt from Example.io",
      "Fred, Co-Founder",
      'Say "hi"',
      "a\\b",
    ]) {
      expect(parseFrom(`${encodeDisplayName(name)} <x@example.com>`).name).toBe(
        name,
      );
    }
  });

  it("returns a bare address with no name", () => {
    expect(parseFrom(" support@example.com ")).toEqual({
      address: "support@example.com",
    });
  });
});
