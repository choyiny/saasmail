import { describe, expect, it } from "vitest";
import {
  citesDeliveredOriginal,
  bodyValueMatches,
  bytesEqual,
  collectJmapIds,
  expandUriTemplate,
  findMailbox,
  immutableDifferences,
  invalidJmapIds,
  readConfig,
  resolveUrl,
  run,
  stableStringify,
  delayedSendCapabilityOk,
} from "./jmap-send-e2e.mjs";

const REQUIRED = {
  JMAP_BASE_URL: "https://mail.example.com/",
  JMAP_API_KEY: "sk_abc",
  JMAP_FROM: "Hello@Example.com",
  JMAP_TO: "privacy@example.com",
};

describe("jmap-send-e2e configuration", () => {
  it("reads the required settings and applies defaults", () => {
    expect(readConfig(REQUIRED)).toEqual({
      config: {
        baseUrl: "https://mail.example.com",
        apiKey: "sk_abc",
        from: "hello@example.com",
        to: "privacy@example.com",
        cc: null,
        oldAccountId: null,
        expectDelivery: false,
        deliveryTimeoutSeconds: 120,
      },
    });
  });

  it("reads the optional settings", () => {
    const parsed = readConfig({
      ...REQUIRED,
      JMAP_CC: " Cc@Example.com ",
      JMAP_OLD_ACCOUNT_ID: "user-1",
      JMAP_EXPECT_DELIVERY: "1",
      JMAP_DELIVERY_TIMEOUT_S: "30",
    });
    expect(parsed.config).toMatchObject({
      cc: "cc@example.com",
      oldAccountId: "user-1",
      expectDelivery: true,
      deliveryTimeoutSeconds: 30,
    });
  });

  it("names every missing or malformed setting", () => {
    expect(readConfig({}).error).toContain(
      "JMAP_BASE_URL, JMAP_API_KEY, JMAP_FROM, JMAP_TO",
    );
    expect(
      readConfig({ ...REQUIRED, JMAP_BASE_URL: "not a url" }).error,
    ).toContain("JMAP_BASE_URL");
    expect(readConfig({ ...REQUIRED, JMAP_API_KEY: "abc" }).error).toContain(
      "sk_",
    );
    expect(
      readConfig({ ...REQUIRED, JMAP_DELIVERY_TIMEOUT_S: "0" }).error,
    ).toContain("JMAP_DELIVERY_TIMEOUT_S");
  });
});

describe("jmap-send-e2e URLs", () => {
  it("expands and percent-encodes URI template variables", () => {
    expect(
      expandUriTemplate(
        "/jmap/download/{accountId}/{blobId}/{name}?type={type}",
        {
          accountId: "aAcc",
          blobId: "Uabc",
          name: "my file.png",
          type: "image/png",
        },
      ),
    ).toBe("/jmap/download/aAcc/Uabc/my%20file.png?type=image%2Fpng");
    expect(() => expandUriTemplate("/x/{missing}", {})).toThrow("missing");
  });

  it("resolves session URLs against the base URL", () => {
    expect(resolveUrl("https://mail.example.com", "/jmap/api")).toBe(
      "https://mail.example.com/jmap/api",
    );
    expect(
      resolveUrl("https://mail.example.com", "https://api.example.com/jmap"),
    ).toBe("https://api.example.com/jmap");
  });
});

describe("jmap-send-e2e id scanning", () => {
  it("collects every id-bearing value, but not creation ids or part ids", () => {
    const body = {
      methodResponses: [
        [
          "Email/set",
          {
            accountId: "aAcc",
            created: { draft: { id: "Dd1", blobId: "Xc1", threadId: "Tdd1" } },
            updated: { Dd2: null },
            destroyed: ["Dd3"],
            notCreated: {
              "client key": { type: "invalidProperties", properties: ["to"] },
            },
          },
          "0",
        ],
        [
          "Mailbox/get",
          {
            accountId: "aAcc",
            list: [{ id: "bM", parentId: null }],
            notFound: [],
          },
          "1",
        ],
        [
          "Email/changes",
          {
            accountId: "aAcc",
            created: ["Rr1"],
            updated: ["received:bad"],
            destroyed: [],
          },
          "2",
        ],
        [
          "Email/get",
          {
            accountId: "aAcc",
            list: [
              {
                id: "Rr1",
                mailboxIds: { bM: true },
                bodyValues: { 1: { value: "x" } },
              },
            ],
          },
          "3",
        ],
      ],
    };
    expect(new Set(collectJmapIds(body))).toEqual(
      new Set([
        "aAcc",
        "Dd1",
        "Xc1",
        "Tdd1",
        "Dd2",
        "Dd3",
        "bM",
        "Rr1",
        "received:bad",
      ]),
    );
    expect(invalidJmapIds(body)).toEqual(["received:bad"]);
  });

  it("reads the session's account keys and primary accounts", () => {
    expect(
      invalidJmapIds({
        accounts: { "user:1": {} },
        primaryAccounts: { "urn:ietf:params:jmap:mail": "user-1" },
      }),
    ).toEqual(["user:1"]);
  });
});

describe("jmap-send-e2e comparisons", () => {
  it("stringifies independently of key order", () => {
    expect(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }),
    );
  });

  it("compares immutable properties, treating an Email's own part blob ids as equal", () => {
    const draft = {
      id: "Dd1",
      blobId: "Xc1",
      subject: "Hi",
      mailboxIds: { bD: true },
      keywords: { $draft: true },
      textBody: [{ partId: "1", blobId: "PDd1_1" }],
      receivedAt: "2026-09-26T10:00:00Z",
    };
    const copy = {
      ...draft,
      id: "Ss1",
      mailboxIds: { bS: true },
      keywords: { $seen: true },
      textBody: [{ partId: "1", blobId: "PSs1_1" }],
      receivedAt: "2026-09-26T10:00:05Z",
    };
    expect(
      immutableDifferences(draft, copy, { ignore: ["receivedAt"] }),
    ).toEqual([]);
    expect(immutableDifferences(draft, copy)).toEqual(["receivedAt"]);
    expect(
      immutableDifferences(
        draft,
        { ...copy, subject: "Changed" },
        {
          ignore: ["receivedAt"],
        },
      ),
    ).toEqual(["subject"]);
  });

  it("compares a downloaded text part with its body value", () => {
    // RFC 8621 body values are LF text; the stored part is the CRLF form.
    expect(
      bodyValueMatches(new TextEncoder().encode("a\r\nb\r\n"), "a\nb\n"),
    ).toBe(true);
    expect(bodyValueMatches(new TextEncoder().encode("a\r\nb"), "a\nb\n")).toBe(
      false,
    );
    expect(bodyValueMatches(new TextEncoder().encode("x"), "y")).toBe(false);
  });

  it("compares bytes", () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(
      true,
    );
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(
      false,
    );
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });

  it("finds a system mailbox by role and inbox address", () => {
    const mailboxes = [
      { id: "b1", role: "drafts", name: "Drafts — other@example.com" },
      { id: "b2", role: "drafts", name: "Drafts — hello@example.com" },
      { id: "b3", role: "sent", name: "Sent — hello@example.com" },
    ];
    expect(findMailbox(mailboxes, "drafts", "HELLO@example.com")?.id).toBe(
      "b2",
    );
    expect(findMailbox(mailboxes, "sent", "hello@example.com")?.id).toBe("b3");
    expect(findMailbox(mailboxes, "trash", "hello@example.com")).toBeNull();
  });
});

describe("jmap-send-e2e threading", () => {
  it("accepts a follow-up that cites the original's delivered Message-ID", () => {
    const original = { messageId: ["cf-1@x.test"] };
    expect(
      citesDeliveredOriginal(
        { inReplyTo: ["cf-1@x.test"], references: ["r@x.test", "cf-1@x.test"] },
        original,
      ),
    ).toBe(true);
    expect(
      citesDeliveredOriginal(
        { inReplyTo: ["own@x.test"], references: ["r@x.test", "own@x.test"] },
        original,
      ),
    ).toBe(false);
    expect(
      citesDeliveredOriginal({ inReplyTo: null, references: null }, original),
    ).toBe(false);
  });
});

describe("jmap-send-e2e runner", () => {
  it("fails the run, not the process, when the session's account id isn't the hashed form", async () => {
    const lines = [];
    const fetchImpl = async () => ({
      status: 200,
      headers: new Map(),
      text: async () =>
        JSON.stringify({
          capabilities: {},
          accounts: { "user-1": {} },
          primaryAccounts: { "urn:ietf:params:jmap:mail": "user-1" },
          apiUrl: "/jmap/api",
          uploadUrl: "",
          downloadUrl: "",
        }),
    });
    const result = await run(
      {
        baseUrl: "https://mail.example.com",
        apiKey: "sk_test",
        from: "hello@example.com",
        to: "privacy@example.com",
        cc: null,
        oldAccountId: null,
        expectDelivery: false,
        deliveryTimeoutSeconds: 1,
      },
      { fetchImpl, log: (line) => lines.push(line), sleep: async () => {} },
    );
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("account id is the hashed form");
    expect(lines.filter((line) => line.startsWith("FAIL"))).toHaveLength(1);
  });
});

describe("jmap-send-e2e delayed send capability", () => {
  const NOW = Date.parse("2026-09-28T10:00:00Z");
  const good = {
    maxDelayedSend: 86400,
    submissionExtensions: {
      FUTURERELEASE: ["86400", "2026-09-29T10:00:00Z"],
    },
  };

  it("accepts maxDelayedSend 86400 with both FUTURERELEASE arguments", () => {
    expect(delayedSendCapabilityOk(good, NOW)).toBe(true);
  });

  it("rejects an empty max date-time, a local time, or a stale date", () => {
    for (const args of [
      ["86400", ""],
      ["86400"],
      ["86400", "2026-09-29T12:00:00+02:00"],
      ["86400", "2026-09-28T10:00:00Z"],
      [86400, "2026-09-29T10:00:00Z"],
    ]) {
      expect(
        delayedSendCapabilityOk(
          { ...good, submissionExtensions: { FUTURERELEASE: args } },
          NOW,
        ),
      ).toBe(false);
    }
    expect(
      delayedSendCapabilityOk(
        { maxDelayedSend: 0, submissionExtensions: {} },
        NOW,
      ),
    ).toBe(false);
  });
});
