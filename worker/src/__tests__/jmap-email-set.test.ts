import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestSentEmail,
  createTestUser,
  getDb,
} from "./helpers";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { mailboxes } from "../db/mailboxes.schema";
import { CORE_CAPABILITY, MAIL_CAPABILITY } from "../jmap/constants";
import { acct, mbx, rid, sid, sys } from "./jmap-ids";

const MINE = "write@saasmail.test";
const OTHER = "other-write@saasmail.test";

async function member() {
  const { userId, apiKey } = await createTestUser({
    id: "jmap-writer",
    role: "member",
    email: "writer@example.com",
  });
  await getDb()
    .insert(inboxPermissions)
    .values({
      userId,
      email: MINE,
      createdAt: Math.floor(Date.now() / 1000),
      createdBy: null,
    });
  return { userId, apiKey };
}

async function jmapJson(apiKey: string, methodCalls: unknown[]) {
  const response = await authFetch("/jmap/api", {
    method: "POST",
    apiKey,
    body: JSON.stringify({
      using: [CORE_CAPABILITY, MAIL_CAPABILITY],
      methodCalls,
    }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    methodResponses: [string, Record<string, any>, string][];
  }>;
}

async function emailGet(apiKey: string, userId: string, id: string) {
  const result = await jmapJson(apiKey, [
    ["Email/get", { accountId: acct(userId), ids: [id] }, "g"],
  ]);
  return result.methodResponses[0][1];
}

async function emailSet(
  apiKey: string,
  userId: string,
  update: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const result = await jmapJson(apiKey, [
    ["Email/set", { accountId: acct(userId), update, ...extra }, "s"],
  ]);
  return result.methodResponses[0];
}

describe("JMAP Email/set", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function seedReceived() {
    const auth = await member();
    await createTestPerson({
      id: "jmap-write-person",
      email: "person@example.com",
    });
    await createTestEmail({
      id: "jmap-write-email",
      personId: "jmap-write-person",
      recipient: MINE,
      messageId: "jmap-write-email@example.com",
    });
    await getDb().insert(mailboxes).values({
      id: "jmap-write-folder",
      inbox: MINE,
      name: "Folder",
      role: null,
      parentId: null,
      sortOrder: 0,
      createdBy: auth.userId,
      createdAt: 1,
      updatedAt: 1,
    });
    return auth;
  }

  it("updates keyword patches and full keyword objects", async () => {
    const { userId, apiKey } = await seedReceived();
    let response = await emailSet(apiKey, userId, {
      [rid("jmap-write-email")]: { "keywords/$seen": true },
    });
    expect(response[0]).toBe("Email/set");
    expect(response[1].updated).toEqual({
      [rid("jmap-write-email")]: null,
    });

    let get = await emailGet(apiKey, userId, rid("jmap-write-email"));
    expect(get.list[0].keywords).toEqual({ $seen: true });

    response = await emailSet(apiKey, userId, {
      [rid("jmap-write-email")]: {
        keywords: { $flagged: true },
      },
    });
    expect(response[0]).toBe("Email/set");
    get = await emailGet(apiKey, userId, rid("jmap-write-email"));
    expect(get.list[0].keywords).toEqual({ $flagged: true });
  });

  it("moves mail through system mailboxes and custom folders", async () => {
    const { userId, apiKey } = await seedReceived();
    const id = rid("jmap-write-email");

    for (const role of ["archive", "junk", "trash"] as const) {
      const response = await emailSet(apiKey, userId, {
        [id]: { mailboxIds: { [sys(MINE, role)]: true } },
      });
      expect(response[0]).toBe("Email/set");
      const get = await emailGet(apiKey, userId, id);
      expect(get.list[0].mailboxIds).toEqual({
        [sys(MINE, role)]: true,
      });
    }

    let response = await emailSet(apiKey, userId, {
      [id]: {
        mailboxIds: {
          [sys(MINE, "inbox")]: true,
          [mbx("jmap-write-folder")]: true,
        },
      },
    });
    expect(response[0]).toBe("Email/set");
    let get = await emailGet(apiKey, userId, id);
    expect(get.list[0].mailboxIds).toEqual({
      [sys(MINE, "inbox")]: true,
      [mbx("jmap-write-folder")]: true,
    });

    response = await emailSet(apiKey, userId, {
      [id]: { [`mailboxIds/${mbx("jmap-write-folder")}`]: null },
    });
    expect(response[0]).toBe("Email/set");
    get = await emailGet(apiKey, userId, id);
    expect(get.list[0].mailboxIds).toEqual({
      [sys(MINE, "inbox")]: true,
    });
  });

  it("rejects invalid patch and keyword targets", async () => {
    const { userId, apiKey } = await seedReceived();
    const id = rid("jmap-write-email");

    let response = await emailSet(apiKey, userId, {
      [id]: { subject: "nope" },
    });
    expect(response[1].notUpdated[id]).toEqual({ type: "invalidPatch" });

    response = await emailSet(apiKey, userId, {
      [id]: { "keywords/$draft": true },
    });
    expect(response[1].notUpdated[id]).toEqual({
      type: "invalidProperties",
      properties: ["keywords"],
    });

    response = await emailSet(apiKey, userId, {
      [id]: { keywords: {}, "keywords/$seen": true },
    });
    expect(response[1].notUpdated[id]).toEqual({ type: "invalidPatch" });

    response = await emailSet(apiKey, userId, {
      [id]: { "keywords/$seen": false },
    });
    expect(response[1].notUpdated[id]).toEqual({ type: "invalidPatch" });
  });

  it("rejects every invalid mailbox target before writing", async () => {
    const { userId, apiKey } = await seedReceived();
    const id = rid("jmap-write-email");
    const cases = [
      {},
      { [sys(MINE, "inbox")]: true, [mbx("missing")]: true },
      {
        [sys(MINE, "inbox")]: true,
        [sys(MINE, "archive")]: true,
      },
      { [sys(MINE, "drafts")]: true },
      { [sys(MINE, "sent")]: true },
      { [sys(OTHER, "inbox")]: true },
    ];

    for (const mailboxIds of cases) {
      const response = await emailSet(apiKey, userId, {
        [id]: { mailboxIds },
      });
      expect(response[1].notUpdated[id]).toEqual({
        type: "invalidProperties",
        properties: ["mailboxIds"],
      });
    }

    const get = await emailGet(apiKey, userId, id);
    expect(get.list[0].mailboxIds).toEqual({
      [sys(MINE, "inbox")]: true,
    });
  });

  it("keeps sent mail seen and only allows Sent or Trash", async () => {
    const { userId, apiKey } = await member();
    await createTestSentEmail({
      id: "jmap-write-sent",
      fromAddress: MINE,
      toAddress: "person@example.com",
    });
    const id = sid("jmap-write-sent");

    let response = await emailSet(apiKey, userId, {
      [id]: { "keywords/$seen": null },
    });
    expect(response[1].notUpdated[id]).toEqual({
      type: "invalidProperties",
      properties: ["keywords"],
    });

    response = await emailSet(apiKey, userId, {
      [id]: { mailboxIds: { [sys(MINE, "trash")]: true } },
    });
    expect(response[0]).toBe("Email/set");
    let get = await emailGet(apiKey, userId, id);
    expect(get.list[0].mailboxIds).toEqual({
      [sys(MINE, "trash")]: true,
    });

    response = await emailSet(apiKey, userId, {
      [id]: { mailboxIds: { [sys(MINE, "sent")]: true } },
    });
    expect(response[0]).toBe("Email/set");
    get = await emailGet(apiKey, userId, id);
    expect(get.list[0].mailboxIds).toEqual({
      [sys(MINE, "sent")]: true,
    });
  });

  it("returns notFound for unknown and out-of-scope ids", async () => {
    const { userId, apiKey } = await seedReceived();
    await createTestEmail({
      id: "other-inbox-email",
      personId: "jmap-write-person",
      recipient: OTHER,
      messageId: "other-inbox-email@example.com",
    });

    const response = await emailSet(apiKey, userId, {
      [rid("missing")]: { "keywords/$seen": true },
      [rid("other-inbox-email")]: { "keywords/$seen": true },
    });
    expect(response[1].notUpdated).toEqual({
      [rid("missing")]: { type: "notFound" },
      [rid("other-inbox-email")]: { type: "notFound" },
    });
  });

  it("enforces state, forbids create/destroy, and caps updates", async () => {
    const { userId, apiKey } = await seedReceived();
    const id = rid("jmap-write-email");

    let response = await emailSet(
      apiKey,
      userId,
      { [id]: { "keywords/$seen": true } },
      { ifInState: "wrong-state" },
    );
    expect(response).toEqual(["error", { type: "stateMismatch" }, "s"]);

    const result = await jmapJson(apiKey, [
      [
        "Email/set",
        {
          accountId: acct(userId),
          create: { draft1: {} },
          destroy: [id],
        },
        "f",
      ],
    ]);
    expect(result.methodResponses[0][0]).toBe("Email/set");
    expect(result.methodResponses[0][1].notCreated).toEqual({
      draft1: { type: "forbidden" },
    });
    expect(result.methodResponses[0][1].notDestroyed).toEqual({
      [id]: { type: "forbidden" },
    });

    const tooMany = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [
        rid(`too-many-${index}`),
        { "keywords/$seen": true },
      ]),
    );
    response = await emailSet(apiKey, userId, tooMany);
    expect(response[0]).toBe("error");
    expect(response[1].type).toBe("requestTooLarge");
  });

  it("keeps states stable across time and accepts ifInState by seq and fingerprint", async () => {
    vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));
    const { userId, apiKey } = await seedReceived();
    const id = rid("jmap-write-email");

    const first = await emailGet(apiKey, userId, id);
    vi.setSystemTime(new Date("2026-09-23T12:05:00.000Z"));
    const second = await emailGet(apiKey, userId, id);
    expect(second.state).toBe(first.state);

    let response = await emailSet(
      apiKey,
      userId,
      { [id]: { "keywords/$seen": true } },
      { ifInState: first.state },
    );
    expect(response[0]).toBe("Email/set");

    const current = await emailGet(apiKey, userId, id);
    const [version, seq, issuedAt, fp] = current.state.split("-");
    const differentSeq = `${version}-${Number(seq) + 1}-${issuedAt}-${fp}`;
    response = await emailSet(
      apiKey,
      userId,
      { [id]: { "keywords/$flagged": true } },
      { ifInState: differentSeq },
    );
    expect(response).toEqual(["error", { type: "stateMismatch" }, "s"]);
  });

  it("feeds successful Email/set writes into Email/changes", async () => {
    const { userId, apiKey } = await seedReceived();
    const id = rid("jmap-write-email");
    const before = await emailGet(apiKey, userId, id);

    const response = await emailSet(apiKey, userId, {
      [id]: { "keywords/$flagged": true },
    });
    expect(response[0]).toBe("Email/set");

    const changes = await jmapJson(apiKey, [
      [
        "Email/changes",
        { accountId: acct(userId), sinceState: before.state },
        "c",
      ],
    ]);
    expect(changes.methodResponses[0][1].updated).toContain(id);
  });

  it("advertises writable rights except for Drafts", async () => {
    const { userId, apiKey } = await seedReceived();
    const result = await jmapJson(apiKey, [
      [
        "Mailbox/get",
        {
          accountId: acct(userId),
          ids: [
            sys(MINE, "inbox"),
            sys(MINE, "drafts"),
            mbx("jmap-write-folder"),
          ],
        },
        "m",
      ],
    ]);
    type MailboxResult = {
      id: string;
      myRights: Record<string, boolean>;
    };
    const mailboxList = result.methodResponses[0][1].list as MailboxResult[];
    const byId = new Map<string, MailboxResult>(
      mailboxList.map((row) => [row.id, row]),
    );
    expect(byId.get(sys(MINE, "inbox")).myRights).toMatchObject({
      mayReadItems: true,
      mayAddItems: true,
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: true,
      mayCreateChild: false,
      mayRename: false,
      mayDelete: false,
      maySubmit: false,
    });
    expect(byId.get(mbx("jmap-write-folder")).myRights).toMatchObject({
      mayAddItems: true,
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: true,
    });
    expect(byId.get(sys(MINE, "drafts")).myRights).toMatchObject({
      mayReadItems: true,
      mayAddItems: false,
      mayRemoveItems: false,
      maySetSeen: false,
      maySetKeywords: false,
    });
  });
});
