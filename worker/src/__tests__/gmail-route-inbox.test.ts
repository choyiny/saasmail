import { describe, it, expect } from "vitest";
import { resolvePersonalInbox } from "../lib/gmail/route-inbox";

describe("resolvePersonalInbox", () => {
  it("returns the personal mailbox address when exactly one null mapping exists", () => {
    const mappings = [{ email: "user@acme.dev", gmailGroupAddress: null }];
    expect(resolvePersonalInbox(mappings)).toBe("user@acme.dev");
  });

  it("returns the address lowercased and trimmed", () => {
    const mappings = [{ email: "  User@Acme.DEV  ", gmailGroupAddress: null }];
    expect(resolvePersonalInbox(mappings)).toBe("user@acme.dev");
  });

  it("ignores group mappings and returns null when no personal mapping exists", () => {
    const mappings = [
      { email: "support@acme.dev", gmailGroupAddress: "support@acme.dev" },
      { email: "sales@acme.dev", gmailGroupAddress: "sales@acme.dev" },
    ];
    expect(resolvePersonalInbox(mappings)).toBeNull();
  });

  it("returns the personal mapping when both personal and group mappings exist", () => {
    const mappings = [
      { email: "user@acme.dev", gmailGroupAddress: null },
      { email: "support@acme.dev", gmailGroupAddress: "support@acme.dev" },
      { email: "sales@acme.dev", gmailGroupAddress: "sales@acme.dev" },
    ];
    expect(resolvePersonalInbox(mappings)).toBe("user@acme.dev");
  });

  it("returns the personal mapping regardless of array order (personal first)", () => {
    const mappings = [
      { email: "user@acme.dev", gmailGroupAddress: null },
      { email: "support@acme.dev", gmailGroupAddress: "support@acme.dev" },
    ];
    expect(resolvePersonalInbox(mappings)).toBe("user@acme.dev");
  });

  it("returns the personal mapping regardless of array order (personal last)", () => {
    const mappings = [
      { email: "support@acme.dev", gmailGroupAddress: "support@acme.dev" },
      { email: "user@acme.dev", gmailGroupAddress: null },
    ];
    expect(resolvePersonalInbox(mappings)).toBe("user@acme.dev");
  });

  it("returns null for an empty mapping list", () => {
    expect(resolvePersonalInbox([])).toBeNull();
  });

  it("returns null when multiple personal mappings exist (misconfiguration)", () => {
    const mappings = [
      { email: "user1@acme.dev", gmailGroupAddress: null },
      { email: "user2@acme.dev", gmailGroupAddress: null },
    ];
    expect(resolvePersonalInbox(mappings)).toBeNull();
  });
});
