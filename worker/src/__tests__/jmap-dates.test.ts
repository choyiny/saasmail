import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseJmapDate } from "../jmap/dates";
import { applyMigrations, cleanDb, createTestUser } from "./helpers";
import {
  MINE,
  addIdentity,
  draftCreate,
  recordingSender,
  runJmap,
} from "./jmap-harness";
import { acct } from "./jmap-ids";

describe("parseJmapDate (RFC 3339 Date / UTCDate, RFC 8620 §1.4)", () => {
  it("accepts well-formed dates, with fractions and offsets", () => {
    expect(parseJmapDate("2026-09-26T10:00:00Z")).toBe(
      Date.UTC(2026, 8, 26, 10, 0, 0),
    );
    expect(parseJmapDate("2026-09-26T10:00:00.250Z")).toBe(
      Date.UTC(2026, 8, 26, 10, 0, 0, 250),
    );
    expect(parseJmapDate("2026-09-26T12:00:00+02:00")).toBe(
      Date.UTC(2026, 8, 26, 10, 0, 0),
    );
    expect(parseJmapDate("2024-02-29T00:00:00Z")).toBe(Date.UTC(2024, 1, 29));
  });

  it.each([
    "2026-02-30T10:00:00Z", // Date.parse rolls this over to March 2
    "2026-02-29T10:00:00Z", // not a leap year
    "2026-04-31T10:00:00Z",
    "2026-13-01T10:00:00Z",
    "2026-00-10T10:00:00Z",
    "2026-09-00T10:00:00Z",
    "2026-09-26T24:00:00Z",
    "2026-09-26T10:60:00Z",
    "2026-09-26T10:00:60Z",
    "2026-09-26T10:00:00+24:00",
    "2026-09-26T10:00:00+02:60",
    "2026-09-26 10:00:00Z",
    "2026-09-26T10:00Z",
    "Sep 26 2026",
    "",
  ])("rejects %s", (value) => {
    expect(parseJmapDate(value)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(parseJmapDate(1790000000)).toBeNull();
    expect(parseJmapDate(null)).toBeNull();
  });

  it("requires Z for a UTCDate", () => {
    expect(parseJmapDate("2026-09-26T10:00:00Z", { utc: true })).toBe(
      Date.UTC(2026, 8, 26, 10),
    );
    expect(
      parseJmapDate("2026-09-26T12:00:00+02:00", { utc: true }),
    ).toBeNull();
  });
});

describe("JMAP methods refuse impossible dates", () => {
  let userId: string;

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    ({ userId } = await createTestUser({ id: "dates-user" }));
    await addIdentity(MINE);
  });

  it("Email/set create: sentAt 2026-02-30 is invalidProperties, not March 2", async () => {
    const { sender } = recordingSender();
    const [response] = await runJmap(
      userId,
      [
        [
          "Email/set",
          {
            accountId: acct(userId),
            create: { d1: draftCreate({ sentAt: "2026-02-30T10:00:00Z" }) },
          },
          "e",
        ],
      ],
      sender,
    );
    expect((response[1] as Record<string, any>).notCreated.d1).toMatchObject({
      type: "invalidProperties",
      properties: ["sentAt"],
    });
  });

  it("Email/query and EmailSubmission/query: an impossible or non-UTC bound is invalidArguments", async () => {
    const { sender } = recordingSender();
    const responses = await runJmap(
      userId,
      [
        [
          "Email/query",
          {
            accountId: acct(userId),
            filter: { after: "2026-02-30T00:00:00Z" },
          },
          "q1",
        ],
        [
          "Email/query",
          { accountId: acct(userId), filter: { before: "Sep 1 2026" } },
          "q2",
        ],
        [
          "EmailSubmission/query",
          {
            accountId: acct(userId),
            filter: { after: "2026-09-26T12:00:00+02:00" },
          },
          "q3",
        ],
        [
          "Email/query",
          {
            accountId: acct(userId),
            filter: { after: "2026-09-26T10:00:00Z" },
          },
          "ok",
        ],
      ],
      sender,
      {
        using: [
          "urn:ietf:params:jmap:core",
          "urn:ietf:params:jmap:mail",
          "urn:ietf:params:jmap:submission",
        ],
      },
    );
    for (const callId of ["q1", "q2", "q3"]) {
      const response = responses.find((r) => r[2] === callId)!;
      expect(response[0], callId).toBe("error");
      expect((response[1] as Record<string, any>).type, callId).toBe(
        "invalidArguments",
      );
    }
    expect(responses.find((r) => r[2] === "ok")![0]).toBe("Email/query");
  });
});
