import { describe, it, expect } from "vitest";
import {
  fallbackInbox,
  mappedAddresses,
  resolveInboundInboxes,
  resolveSentInbox,
} from "../lib/gmail/route-inbox";

const ACCOUNT = "choyin@acme.dev";

describe("mappedAddresses", () => {
  it("normalizes, drops group mappings and de-duplicates", () => {
    expect(
      mappedAddresses([
        { email: "  Choyin@Acme.DEV ", gmailGroupAddress: null },
        { email: "hello@acme.dev", gmailGroupAddress: null },
        { email: "choyin@acme.dev", gmailGroupAddress: null },
        { email: "team@acme.dev", gmailGroupAddress: "team@acme.dev" },
      ]),
    ).toEqual(["choyin@acme.dev", "hello@acme.dev"]);
  });
});

describe("fallbackInbox", () => {
  it("prefers the inbox at the account's own address", () => {
    expect(fallbackInbox(["hello@acme.dev", ACCOUNT], ACCOUNT)).toBe(ACCOUNT);
  });

  it("takes the only mapping when the account's own address is not mapped", () => {
    expect(fallbackInbox(["hello@acme.dev"], ACCOUNT)).toBe("hello@acme.dev");
  });

  it("refuses to pick between several aliases", () => {
    expect(
      fallbackInbox(["hello@acme.dev", "sales@acme.dev"], ACCOUNT),
    ).toBeNull();
  });

  it("returns null with nothing mapped", () => {
    expect(fallbackInbox([], ACCOUNT)).toBeNull();
  });
});

describe("resolveInboundInboxes", () => {
  const both = [ACCOUNT, "hello@acme.dev"];

  it("routes mail to an alias into the alias's inbox", () => {
    expect(resolveInboundInboxes(both, ACCOUNT, ["Hello@Acme.dev"])).toEqual([
      "hello@acme.dev",
    ]);
  });

  it("routes mail to the account itself into its own inbox", () => {
    expect(resolveInboundInboxes(both, ACCOUNT, [ACCOUNT])).toEqual([ACCOUNT]);
  });

  it("delivers to every mapped inbox the message names", () => {
    expect(
      resolveInboundInboxes(both, ACCOUNT, [
        "hello@acme.dev",
        "someone@else.com",
        ACCOUNT,
      ]),
    ).toEqual([ACCOUNT, "hello@acme.dev"]);
  });

  it("falls back to the account's inbox when no mapped address is named (Bcc, lists)", () => {
    expect(resolveInboundInboxes(both, ACCOUNT, ["list@lists.dev"])).toEqual([
      ACCOUNT,
    ]);
  });

  it("keeps a single mapping taking everything", () => {
    expect(
      resolveInboundInboxes(["hello@acme.dev"], ACCOUNT, ["x@y.dev"]),
    ).toEqual(["hello@acme.dev"]);
  });

  it("skips unaddressed mail when only several aliases are mapped", () => {
    expect(
      resolveInboundInboxes(["hello@acme.dev", "sales@acme.dev"], ACCOUNT, [
        ACCOUNT,
      ]),
    ).toEqual([]);
  });
});

describe("resolveSentInbox", () => {
  const both = [ACCOUNT, "hello@acme.dev"];

  it("files a send from an alias under the alias's inbox", () => {
    expect(resolveSentInbox(both, ACCOUNT, "HELLO@acme.dev")).toBe(
      "hello@acme.dev",
    );
  });

  it("falls back when the From: address is not mapped", () => {
    expect(resolveSentInbox(both, ACCOUNT, "other@acme.dev")).toBe(ACCOUNT);
    expect(resolveSentInbox(both, ACCOUNT, null)).toBe(ACCOUNT);
  });
});
