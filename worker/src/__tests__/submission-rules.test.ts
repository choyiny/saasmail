import { describe, expect, it } from "vitest";
import {
  checkAttachmentCount,
  checkContentRecipients,
  checkRecipientSupport,
  resolveEnvelope,
  submissionRecipients,
} from "../jmap/submission-rules";

const addr = (email: string, name: string | null = null) => ({ name, email });
const content = (
  to: { name: string | null; email: string }[],
  cc: { name: string | null; email: string }[] = [],
  bcc: { name: string | null; email: string }[] = [],
) => ({
  toJson: JSON.stringify(to),
  ccJson: JSON.stringify(cc),
  bccJson: JSON.stringify(bcc),
});

describe("checkContentRecipients (spec §3.2 steps 3–4)", () => {
  it("accepts one To plus Cc", () => {
    expect(
      checkContentRecipients(content([addr("a@x.com")], [addr("b@x.com")])),
    ).toBeNull();
  });

  it("accepts several To and Bcc", () => {
    expect(
      checkContentRecipients(
        content([addr("a@x.com"), addr("b@x.com")], [], [addr("c@x.com")]),
      ),
    ).toBeNull();
  });

  it("counts Bcc toward the 50-recipient cap", () => {
    const cc = Array.from({ length: 48 }, (_, i) => addr(`cc${i}@x.com`));
    expect(
      checkContentRecipients(
        content([addr("a@x.com")], cc, [addr("h@x.com"), addr("i@x.com")]),
      ),
    ).toMatchObject({ type: "tooManyRecipients", maxRecipients: 50 });
    expect(
      checkContentRecipients(content([addr("a@x.com")], cc, [addr("h@x.com")])),
    ).toBeNull();
  });

  it("refuses several To or Bcc for a provider that can't send them", () => {
    const both = content(
      [addr("a@x.com"), addr("b@x.com")],
      [],
      [addr("c@x.com")],
    );
    expect(
      checkRecipientSupport(both, { multipleTo: false, bcc: true }),
    ).toMatchObject({ type: "invalidEmail", properties: ["to"] });
    expect(
      checkRecipientSupport(both, { multipleTo: true, bcc: false }),
    ).toMatchObject({ type: "invalidEmail", properties: ["bcc"] });
    expect(
      checkRecipientSupport(both, { multipleTo: true, bcc: true }),
    ).toBeNull();
  });

  it("rejects a missing To with noRecipients", () => {
    expect(
      checkContentRecipients(content([], [addr("b@x.com")])),
    ).toMatchObject({ type: "noRecipients" });
  });

  it("lists unsendable addresses", () => {
    expect(
      checkContentRecipients(
        content([addr("not an address")], [addr("b@x.com"), addr("c@")]),
      ),
    ).toEqual({
      type: "invalidRecipients",
      invalidRecipients: ["not an address", "c@"],
      description: "Some recipients are not valid email addresses",
    });
  });

  it("caps the recipient count at 50, To and Cc together (Cloudflare's limit)", () => {
    const cc = Array.from({ length: 50 }, (_, i) => addr(`cc${i}@x.com`));
    expect(
      checkContentRecipients(content([addr("a@x.com")], cc)),
    ).toMatchObject({
      type: "tooManyRecipients",
      maxRecipients: 50,
    });
    expect(
      checkContentRecipients(content([addr("a@x.com")], cc.slice(0, 49))),
    ).toBeNull();
  });

  it("caps attachments at 32, inline parts included", () => {
    expect(checkAttachmentCount(32)).toBeNull();
    expect(checkAttachmentCount(33)).toMatchObject({
      type: "invalidEmail",
      properties: ["attachments"],
    });
  });
});

describe("resolveEnvelope (spec §3.2 step 5)", () => {
  const recipients = submissionRecipients(
    content([addr("A@x.com")], [addr("b@x.com"), addr("a@x.com")]),
  );

  it("derives the envelope when none is given", () => {
    expect(recipients).toEqual(["a@x.com", "b@x.com"]);
    expect(resolveEnvelope(undefined, "me@x.com", recipients)).toEqual({
      envelope: {
        mailFrom: { email: "me@x.com", parameters: null },
        rcptTo: [
          { email: "a@x.com", parameters: null },
          { email: "b@x.com", parameters: null },
        ],
      },
      error: null,
      releaseAt: null,
    });
  });

  it("accepts a matching envelope in any order and case", () => {
    const result = resolveEnvelope(
      {
        mailFrom: { email: "ME@x.com" },
        rcptTo: [{ email: "b@x.com" }, { email: "A@x.com", parameters: null }],
      },
      "me@x.com",
      recipients,
    );
    expect(result.error).toBeNull();
    expect(result.envelope?.mailFrom.email).toBe("me@x.com");
  });

  it("rejects a foreign mailFrom, a different rcptTo, and SMTP parameters", () => {
    expect(
      resolveEnvelope(
        {
          mailFrom: { email: "other@x.com" },
          rcptTo: [{ email: "a@x.com" }, { email: "b@x.com" }],
        },
        "me@x.com",
        recipients,
      ).error,
    ).toMatchObject({ type: "forbiddenMailFrom" });
    expect(
      resolveEnvelope(
        { mailFrom: { email: "me@x.com" }, rcptTo: [{ email: "a@x.com" }] },
        "me@x.com",
        recipients,
      ).error,
    ).toMatchObject({ type: "invalidEmail", properties: ["to", "cc", "bcc"] });
    expect(
      resolveEnvelope(
        {
          mailFrom: { email: "me@x.com", parameters: { SIZE: "100" } },
          rcptTo: [{ email: "a@x.com" }, { email: "b@x.com" }],
        },
        "me@x.com",
        recipients,
      ).error,
    ).toMatchObject({ type: "invalidProperties", properties: ["envelope"] });
    expect(
      resolveEnvelope({ rcptTo: "nope" }, "me@x.com", recipients).error,
    ).toMatchObject({ type: "invalidProperties", properties: ["envelope"] });
  });
});

describe("resolveEnvelope: RFC 4865 FUTURERELEASE on mailFrom", () => {
  const recipients = ["a@x.com"];
  const NOW = 1_800_000_000;
  const hold = (parameters: unknown) =>
    resolveEnvelope(
      {
        mailFrom: { email: "me@x.com", parameters },
        rcptTo: [{ email: "a@x.com" }],
      },
      "me@x.com",
      recipients,
      NOW,
    );

  it("holds for HOLDFOR seconds, case-insensitively, up to 86400", () => {
    expect(hold({ HOLDFOR: "600" })).toMatchObject({
      error: null,
      releaseAt: NOW + 600,
      envelope: { mailFrom: { parameters: { HOLDFOR: "600" } } },
    });
    expect(hold({ holdfor: "86400" }).releaseAt).toBe(NOW + 86400);
    expect(hold({ HOLDFOR: "0" })).toMatchObject({
      error: null,
      releaseAt: null,
    });
  });

  it("holds until a HOLDUNTIL date-time; one in the past sends now", () => {
    expect(hold({ HOLDUNTIL: "2027-01-15T08:00:10Z" }).releaseAt).toBe(
      Date.parse("2027-01-15T08:00:10Z") / 1000,
    );
    expect(
      hold({ HOLDUNTIL: new Date((NOW + 3600) * 1000).toISOString() })
        .releaseAt,
    ).toBe(NOW + 3600);
    expect(hold({ HOLDUNTIL: "2020-01-01T00:00:00Z" })).toMatchObject({
      error: null,
      releaseAt: null,
    });
  });

  it("refuses holds past maxDelayedSend, malformed values and other parameters", () => {
    for (const parameters of [
      { HOLDFOR: "86401" },
      { HOLDFOR: "-5" },
      { HOLDFOR: "1e3" },
      { HOLDFOR: null },
      { HOLDUNTIL: new Date((NOW + 86401) * 1000).toISOString() },
      { HOLDUNTIL: "tomorrow" },
      { HOLDFOR: "60", HOLDUNTIL: "2027-01-15T08:00:00Z" },
      { BODY: "8BITMIME" },
      "HOLDFOR=60",
    ]) {
      expect(hold(parameters).error).toMatchObject({
        type: "invalidProperties",
        properties: ["envelope"],
      });
    }
    expect(
      resolveEnvelope(
        {
          mailFrom: { email: "me@x.com" },
          rcptTo: [{ email: "a@x.com", parameters: { NOTIFY: "NEVER" } }],
        },
        "me@x.com",
        recipients,
        NOW,
      ).error,
    ).toMatchObject({ type: "invalidProperties", properties: ["envelope"] });
  });
});
