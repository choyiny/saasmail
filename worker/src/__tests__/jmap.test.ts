import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestAttachment,
  createTestEmail,
  createTestPerson,
  createTestSentEmail,
  createTestUser,
  getDb,
} from "./helpers";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { mailboxes } from "../db/mailboxes.schema";
import { messageMailboxes } from "../db/message-mailboxes.schema";
import { messageUserState } from "../db/message-user-state.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import {
  CORE_CAPABILITY,
  MAIL_CAPABILITY,
  MAX_CALLS_IN_REQUEST,
} from "../jmap/constants";
import { executeJmapCalls, validateJmapPostRequest } from "../jmap/http";
import {
  acct,
  att,
  expectAllJmapIdsValid,
  mbx,
  rid,
  sid,
  sys,
  thread,
} from "./jmap-ids";

const MINE = "mine@saasmail.test";
const THEIRS = "theirs@saasmail.test";

async function addIdentity(email: string, displayName = "Inbox") {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email,
    displayName,
    createdAt: now,
    updatedAt: now,
  });
}

async function jmap(
  apiKey: string,
  methodCalls: unknown[],
  using = [CORE_CAPABILITY, MAIL_CAPABILITY],
) {
  return authFetch("/jmap/api", {
    method: "POST",
    apiKey,
    body: JSON.stringify({ using, methodCalls }),
  });
}

async function jmapJson(
  apiKey: string,
  methodCalls: unknown[],
  using = [CORE_CAPABILITY, MAIL_CAPABILITY],
) {
  const response = await jmap(apiKey, methodCalls, using);
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    methodResponses: [string, Record<string, any>, string][];
  }>;
}

async function createMember() {
  const { userId, apiKey } = await createTestUser({
    id: "jmap-member",
    role: "member",
    email: "member@example.com",
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

describe("JMAP", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("serves the RFC 8620 session shape and requires authentication", async () => {
    const unauthorized = await authFetch("/.well-known/jmap");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("Content-Type")).toContain(
      "application/problem+json",
    );

    const { userId, apiKey } = await createTestUser({ id: "jmap-user" });
    await addIdentity(MINE);
    const response = await authFetch("/.well-known/jmap", { apiKey });
    expect(response.status).toBe(200);
    const session = (await response.json()) as any;

    expect(session.apiUrl).toBe("/jmap/api");
    expect(session.downloadUrl).toBe(
      "/jmap/download/{accountId}/{blobId}/{name}?type={type}",
    );
    expect(session.uploadUrl).toBe("");
    expect(session.eventSourceUrl).toBe("");
    expect(session.capabilities[CORE_CAPABILITY]).toMatchObject({
      maxSizeRequest: 10_000_000,
      maxCallsInRequest: 16,
      maxObjectsInGet: 256,
      maxObjectsInSet: 256,
      maxConcurrentRequests: 4,
      collationAlgorithms: ["i;ascii-casemap"],
    });
    expect(session.capabilities[MAIL_CAPABILITY]).toEqual({});
    expect(session.accounts[acct(userId)]).toMatchObject({
      isPersonal: true,
      isReadOnly: false,
    });
    expect(session.primaryAccounts[MAIL_CAPABILITY]).toBe(acct(userId));
  });

  it("advertises the v2 account id and rejects the old one", async () => {
    const { userId, apiKey } = await createTestUser({ id: "jmap-reset-user" });
    const session = await (
      await authFetch("/.well-known/jmap", { apiKey })
    ).json<Record<string, any>>();
    expect(Object.keys(session.accounts)).toEqual([acct(userId)]);
    expect(session.primaryAccounts["urn:ietf:params:jmap:mail"]).toBe(
      acct(userId),
    );

    const oldId = await jmapJson(apiKey, [
      ["Mailbox/get", { accountId: userId }, "m1"],
    ]);
    expect(oldId.methodResponses[0]).toEqual([
      "error",
      { type: "accountNotFound" },
      "m1",
    ]);
    const download = await authFetch(
      `/jmap/download/${userId}/${att("anything")}/x.txt`,
      { apiKey },
    );
    expect(download.status).toBe(404);
  });

  it("answers a pre-upgrade j1 state with cannotCalculateChanges", async () => {
    const { userId, apiKey } = await createTestUser({ id: "jmap-state-user" });
    const res = await jmapJson(apiKey, [
      [
        "Email/changes",
        { accountId: acct(userId), sinceState: "j1-5-1-0123456789abcdef" },
        "c1",
      ],
    ]);
    expect(res.methodResponses[0][1].type).toBe("cannotCalculateChanges");
  });

  it("guards cookie-authenticated POSTs while leaving Bearer requests unchanged", async () => {
    const requestBody = JSON.stringify({
      using: [CORE_CAPABILITY],
      methodCalls: [["Core/echo", { ok: true }, "c1"]],
    });

    const badType = validateJmapPostRequest(
      new Request("http://localhost/jmap/api", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: requestBody,
      }),
      env as unknown as CloudflareBindings,
      "session",
    );
    expect(badType?.status).toBe(400);
    expect(await badType!.json()).toMatchObject({
      type: "urn:ietf:params:jmap:error:notJSON",
      status: 400,
    });

    const badOrigin = validateJmapPostRequest(
      new Request("http://localhost/jmap/api", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Origin: "https://evil.example",
        },
        body: requestBody,
      }),
      env as unknown as CloudflareBindings,
      "session",
    );
    expect(badOrigin?.status).toBe(403);

    expect(
      validateJmapPostRequest(
        new Request("http://localhost/jmap/api", {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            Origin: env.BASE_URL,
          },
          body: requestBody,
        }),
        env as unknown as CloudflareBindings,
        "session",
      ),
    ).toBeNull();

    const { apiKey } = await createTestUser({ id: "jmap-bearer-user" });
    const bearer = await authFetch("/jmap/api", {
      method: "POST",
      apiKey,
      headers: {
        "Content-Type": "text/plain",
        Origin: "https://evil.example",
      },
      body: requestBody,
    });
    expect(bearer.status).toBe(200);
  });

  it("supports Core/echo, rejects bad capabilities, and enforces the call limit", async () => {
    const { apiKey } = await createTestUser({ id: "jmap-user" });
    const echo = await jmapJson(apiKey, [
      ["Core/echo", { hello: "world" }, "c1"],
    ]);
    expect(echo.methodResponses[0]).toEqual([
      "Core/echo",
      { hello: "world" },
      "c1",
    ]);

    const capability = await jmap(
      apiKey,
      [["Core/echo", {}, "c1"]],
      [CORE_CAPABILITY, "urn:example:unknown"],
    );
    expect(capability.status).toBe(400);
    expect(((await capability.json()) as any).type).toBe(
      "urn:ietf:params:jmap:error:unknownCapability",
    );

    const tooMany = await jmap(
      apiKey,
      Array.from({ length: MAX_CALLS_IN_REQUEST + 1 }, (_, index) => [
        "Core/echo",
        {},
        `c${index}`,
      ]),
    );
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toMatchObject({
      type: "urn:ietf:params:jmap:error:limit",
      limit: "maxCallsInRequest",
    });
  });

  it("exposes virtual and custom mailboxes plus usable identities", async () => {
    const { userId, apiKey } = await createTestUser({ id: "jmap-user" });
    await addIdentity(MINE, "Support");
    await createTestPerson({ id: "person-1", email: "alice@example.com" });
    await createTestEmail({
      id: "mail-1",
      personId: "person-1",
      recipient: MINE,
      isRead: 0,
    });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(mailboxes).values({
      id: "folder-1",
      inbox: MINE,
      name: "VIP",
      role: null,
      parentId: null,
      sortOrder: 2,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    await getDb().insert(messageMailboxes).values({
      messageKind: "received",
      messageId: "mail-1",
      mailboxId: "folder-1",
      addedBy: userId,
      addedAt: now,
    });

    const result = await jmapJson(apiKey, [
      ["Mailbox/get", { accountId: acct(userId) }, "m1"],
      ["Mailbox/query", { accountId: acct(userId) }, "m2"],
      ["Identity/get", { accountId: acct(userId) }, "i1"],
    ]);

    const mailboxGet = result.methodResponses[0][1];
    expect(mailboxGet.list.map((mailbox: any) => mailbox.id)).toEqual(
      expect.arrayContaining([
        sys(MINE, "inbox"),
        sys(MINE, "drafts"),
        sys(MINE, "sent"),
        sys(MINE, "archive"),
        sys(MINE, "junk"),
        sys(MINE, "trash"),
        mbx("folder-1"),
      ]),
    );
    const inbox = mailboxGet.list.find(
      (mailbox: any) => mailbox.id === sys(MINE, "inbox"),
    );
    expect(inbox).toMatchObject({
      role: "inbox",
      totalEmails: 1,
      unreadEmails: 1,
      myRights: { mayReadItems: true, mayDelete: false },
    });
    expect(result.methodResponses[1][1].ids).toContain(mbx("folder-1"));
    expect(result.methodResponses[2][1].list).toEqual([
      expect.objectContaining({
        email: MINE,
        name: "Support",
        mayDelete: false,
      }),
    ]);
  });

  it("rejects unknown properties in every supported get method", async () => {
    const { userId, apiKey } = await createTestUser({
      id: "jmap-properties-user",
    });
    const result = await jmapJson(apiKey, [
      [
        "Email/get",
        { accountId: acct(userId), ids: [], properties: ["id", "bogus"] },
        "e1",
      ],
      [
        "Mailbox/get",
        { accountId: acct(userId), ids: [], properties: ["id", "unknown"] },
        "m1",
      ],
      [
        "Thread/get",
        { accountId: acct(userId), ids: [], properties: ["id", "unknown"] },
        "t1",
      ],
      [
        "Identity/get",
        { accountId: acct(userId), ids: [], properties: ["id", "unknown"] },
        "i1",
      ],
    ]);

    for (const [index, callId] of ["e1", "m1", "t1", "i1"].entries()) {
      expect(result.methodResponses[index]).toEqual([
        "error",
        { type: "invalidArguments", properties: ["properties"] },
        callId,
      ]);
    }
  });

  it("accepts standard Email properties and header selectors it cannot yet model", async () => {
    const { userId, apiKey } = await createTestUser({
      id: "jmap-standard-properties-user",
    });
    await addIdentity(MINE);
    await createTestPerson({
      id: "jmap-standard-properties-person",
      email: "alice@example.com",
    });
    await createTestEmail({
      id: "standard-properties-mail",
      personId: "jmap-standard-properties-person",
      recipient: MINE,
      messageId: "<a@x>",
    });
    await createTestSentEmail({
      id: "standard-properties-reply",
      fromAddress: MINE,
      toAddress: "alice@example.com",
      messageId: "<reply@x>",
      inReplyTo: "<a@x> <b@y>",
    });

    const result = await jmapJson(apiKey, [
      [
        "Email/get",
        {
          accountId: acct(userId),
          ids: [rid("standard-properties-mail")],
          properties: ["id", "blobId", "messageId", "header:List-Id:asText"],
        },
        "e1",
      ],
      [
        "Email/get",
        {
          accountId: acct(userId),
          ids: [sid("standard-properties-reply")],
          properties: ["id", "inReplyTo"],
        },
        "e2",
      ],
    ]);

    expect(result.methodResponses[0][0]).toBe("Email/get");
    expect(result.methodResponses[0][1].list).toEqual([
      {
        id: rid("standard-properties-mail"),
        blobId: null,
        messageId: ["a@x"],
        "header:List-Id:asText": null,
      },
    ]);
    expect(result.methodResponses[1][1].list).toEqual([
      {
        id: sid("standard-properties-reply"),
        inReplyTo: ["a@x", "b@y"],
      },
    ]);
  });

  it("returns Email/get fields, body values, state keywords, and attachment blob ids", async () => {
    const { userId, apiKey } = await createTestUser({ id: "jmap-user" });
    await addIdentity(MINE);
    await createTestPerson({ id: "person-1", email: "alice@example.com" });
    await createTestEmail({
      id: "mail-1",
      personId: "person-1",
      recipient: MINE,
      subject: "Hello JMAP",
      bodyText: "Visible plain text",
      conversationId: "conv-1",
      cc: JSON.stringify([{ email: "cc@example.com", name: "Cc" }]),
    });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(messageUserState).values({
      userId,
      messageKind: "received",
      messageId: "mail-1",
      seenAt: now,
      starredAt: now,
      updatedAt: now,
    });
    const attachment = await createTestAttachment({
      id: "blob-1",
      emailId: "mail-1",
      kind: "inbound",
      filename: "hello.txt",
      contentType: "text/plain",
      size: 5,
      r2Key: "jmap/mail-1/hello.txt",
    });
    await env.R2.put(attachment.r2Key, new TextEncoder().encode("hello"));

    const result = await jmapJson(apiKey, [
      [
        "Email/get",
        {
          accountId: acct(userId),
          ids: [rid("mail-1")],
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
        },
        "e1",
      ],
    ]);
    const email = result.methodResponses[0][1].list[0];
    expect(email).toMatchObject({
      id: rid("mail-1"),
      subject: "Hello JMAP",
      preview: "Visible plain text",
      hasAttachment: true,
      keywords: { $seen: true, $flagged: true },
      mailboxIds: { [sys(MINE, "inbox")]: true },
      bodyValues: {
        text: { value: "Visible plain text" },
        html: { value: "<p>Hello</p>" },
      },
    });
    expect(email.threadId).toBeTruthy();
    expect(email.attachments).toEqual([
      expect.objectContaining({ blobId: att("blob-1"), name: "hello.txt" }),
    ]);
  });

  it("queries email with supported filters and only receivedAt descending sort", async () => {
    const { userId, apiKey } = await createTestUser({ id: "jmap-user" });
    await addIdentity(MINE);
    await createTestPerson({ id: "alice", email: "alice@example.com" });
    await createTestPerson({ id: "bob", email: "bob@example.com" });
    await createTestEmail({
      id: "alice-mail",
      personId: "alice",
      recipient: MINE,
      subject: "Project alpha",
      bodyText: "keyword body",
      isRead: 1,
    });
    await createTestEmail({
      id: "bob-mail",
      personId: "bob",
      recipient: MINE,
      subject: "Other",
      bodyText: "other body",
      messageId: "bob-message@example.com",
    });

    const filtered = await jmapJson(apiKey, [
      [
        "Email/query",
        {
          accountId: acct(userId),
          filter: {
            inMailbox: sys(MINE, "inbox"),
            text: "alpha",
            from: "alice@",
            hasKeyword: "$seen",
          },
          sort: [{ property: "receivedAt", isAscending: false }],
          position: 0,
          limit: 10,
          collapseThreads: false,
          calculateTotal: true,
        },
        "q1",
      ],
      [
        "Email/query",
        {
          accountId: acct(userId),
          sort: [{ property: "receivedAt", isAscending: true }],
        },
        "q2",
      ],
    ]);
    expect(filtered.methodResponses[0][1]).toMatchObject({
      ids: [rid("alice-mail")],
      total: 1,
      canCalculateChanges: false,
    });
    expect(filtered.methodResponses[1]).toEqual([
      "error",
      { type: "unsupportedSort" },
      "q2",
    ]);
  });

  it("supports negative positions for Email/query and Mailbox/query", async () => {
    const { userId, apiKey } = await createTestUser({
      id: "jmap-negative-position-user",
    });
    await addIdentity(MINE);
    const base = 1_800_000_000;
    await createTestSentEmail({
      id: "negative-1",
      fromAddress: MINE,
      toAddress: "alice@example.com",
      sentAt: base + 1,
    });
    await createTestSentEmail({
      id: "negative-2",
      fromAddress: MINE,
      toAddress: "alice@example.com",
      sentAt: base + 2,
    });
    await createTestSentEmail({
      id: "negative-3",
      fromAddress: MINE,
      toAddress: "alice@example.com",
      sentAt: base + 3,
    });

    const result = await jmapJson(apiKey, [
      [
        "Email/query",
        { accountId: acct(userId), position: -1, limit: 1 },
        "e1",
      ],
      [
        "Mailbox/query",
        { accountId: acct(userId), position: -1, limit: 1 },
        "m1",
      ],
      [
        "Email/query",
        { accountId: acct(userId), position: -99, limit: 1 },
        "e2",
      ],
    ]);

    expect(result.methodResponses[0][1]).toMatchObject({
      position: 2,
      ids: [sid("negative-1")],
    });
    expect(result.methodResponses[0][1]).not.toHaveProperty("total");
    expect(result.methodResponses[1][1]).toMatchObject({
      position: 5,
      ids: [sys(MINE, "trash")],
      total: 6,
    });
    expect(result.methodResponses[2][1]).toMatchObject({
      position: 0,
      ids: [sid("negative-3")],
    });
  });

  it("supports result references and Thread/get", async () => {
    const { userId, apiKey } = await createTestUser({ id: "jmap-user" });
    await addIdentity(MINE);
    await createTestPerson({ id: "person-1", email: "alice@example.com" });
    await createTestEmail({
      id: "received-1",
      personId: "person-1",
      recipient: MINE,
      conversationId: "conv-1",
    });
    await createTestSentEmail({
      id: "sent-1",
      personId: "person-1",
      fromAddress: MINE,
      toAddress: "alice@example.com",
      conversationId: "conv-1",
    });

    const result = await jmapJson(apiKey, [
      ["Email/query", { accountId: acct(userId) }, "q1"],
      [
        "Email/get",
        {
          accountId: acct(userId),
          "#ids": { resultOf: "q1", name: "Email/query", path: "/ids" },
        },
        "g1",
      ],
      [
        "Thread/get",
        {
          accountId: acct(userId),
          "#ids": {
            resultOf: "g1",
            name: "Email/get",
            path: "/list/*/threadId",
          },
        },
        "t1",
      ],
    ]);

    expect(result.methodResponses[1][0]).toBe("Email/get");
    expect(result.methodResponses[1][1].list).toHaveLength(2);
    expect(result.methodResponses[2][0]).toBe("Thread/get");
    expect(result.methodResponses[2][1].list[0].emailIds).toEqual(
      expect.arrayContaining([rid("received-1"), sid("sent-1")]),
    );
  });

  it("emits only RFC 8620 ids across the whole read surface", async () => {
    const { userId, apiKey } = await createTestUser({
      id: "jmap-surface-user",
    });
    await addIdentity(MINE);
    await createTestPerson({
      id: "surface-person",
      email: "alice@example.com",
    });
    await createTestEmail({
      id: "surface-mail",
      personId: "surface-person",
      recipient: MINE,
      conversationId: "surface-thread",
    });
    await createTestSentEmail({
      id: "surface-sent",
      personId: "surface-person",
      fromAddress: MINE,
      toAddress: "alice@example.com",
      conversationId: "surface-thread",
    });
    const res = await jmapJson(apiKey, [
      ["Mailbox/get", { accountId: acct(userId) }, "m"],
      ["Mailbox/query", { accountId: acct(userId) }, "mq"],
      ["Identity/get", { accountId: acct(userId) }, "i"],
      ["Email/query", { accountId: acct(userId), limit: 50 }, "q"],
      [
        "Email/get",
        {
          accountId: acct(userId),
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        },
        "g",
      ],
      [
        "Thread/get",
        {
          accountId: acct(userId),
          "#ids": {
            resultOf: "g",
            name: "Email/get",
            path: "/list/*/threadId",
          },
        },
        "t",
      ],
    ]);
    expectAllJmapIdsValid(res);
    const get = res.methodResponses[4][1];
    expect(get.list.length).toBeGreaterThan(0);
    expect(get.notFound).toEqual([]);
    const threads = res.methodResponses[5][1];
    expect(threads.notFound).toEqual([]);
    expect(threads.list.length).toBeGreaterThan(0);
  });

  it("treats malformed ids as not found", async () => {
    const { userId, apiKey } = await createTestUser({
      id: "jmap-malformed-user",
    });
    const res = await jmapJson(apiKey, [
      [
        "Email/get",
        { accountId: acct(userId), ids: ["", "R", "r!!", "received:x"] },
        "g",
      ],
      ["Thread/get", { accountId: acct(userId), ids: ["T", "nope"] }, "t"],
    ]);
    expect(res.methodResponses[0][1].notFound).toEqual([
      "",
      "R",
      "r!!",
      "received:x",
    ]);
    expect(res.methodResponses[1][1].notFound).toEqual(["T", "nope"]);
  });

  it("echoes the public account id from every method", async () => {
    // A user id that is itself a valid JMAP id, so only the value (not the
    // character set) can tell the internal and public account ids apart.
    const { userId, apiKey } = await createTestUser({ id: "jmap-echo-user" });
    const since = (name: string) => ({
      resultOf: "g",
      name,
      path: "/state",
    });
    const res = await jmapJson(apiKey, [
      ["Email/get", { accountId: acct(userId), ids: [] }, "g"],
      ["Mailbox/get", { accountId: acct(userId), ids: [] }, "mg"],
      ["Email/query", { accountId: acct(userId) }, "q"],
      ["Email/set", { accountId: acct(userId), update: {} }, "s"],
      [
        "Email/changes",
        { accountId: acct(userId), "#sinceState": since("Email/get") },
        "c",
      ],
      [
        "Mailbox/changes",
        {
          accountId: acct(userId),
          "#sinceState": {
            resultOf: "mg",
            name: "Mailbox/get",
            path: "/state",
          },
        },
        "mc",
      ],
      ["Mailbox/query", { accountId: acct(userId) }, "mq"],
      ["Thread/get", { accountId: acct(userId), ids: [] }, "t"],
      ["Identity/get", { accountId: acct(userId) }, "i"],
    ]);
    for (const [name, result] of res.methodResponses) {
      expect(name).not.toBe("error");
      expect(result.accountId).toBe(acct(userId));
    }
  });

  it("returns invalidResultReference and cannotCalculateChanges per call", async () => {
    const { userId, apiKey } = await createTestUser({ id: "jmap-user" });
    const methodCalls: unknown[] = [
      [
        "Email/get",
        {
          accountId: acct(userId),
          "#ids": { resultOf: "missing", name: "Email/query", path: "/ids" },
        },
        "bad-ref",
      ],
    ];
    for (const [index, name] of [
      "Mailbox/changes",
      "Mailbox/queryChanges",
      "Email/changes",
      "Email/queryChanges",
      "Thread/changes",
      "Thread/queryChanges",
      "Identity/changes",
      "Identity/queryChanges",
    ].entries()) {
      methodCalls.push([name, { accountId: acct(userId) }, `ch-${index}`]);
    }

    const result = await jmapJson(apiKey, methodCalls);
    expect(result.methodResponses[0]).toEqual([
      "error",
      { type: "invalidResultReference" },
      "bad-ref",
    ]);
    for (const response of result.methodResponses.slice(1)) {
      expect(response[0]).toBe("error");
      expect(response[1]).toEqual({ type: "cannotCalculateChanges" });
    }
  });

  it("hides another inbox's ids from a member", async () => {
    await addIdentity(MINE);
    await addIdentity(THEIRS);
    await createTestPerson({ id: "person-1", email: "alice@example.com" });
    await createTestEmail({
      id: "theirs-1",
      personId: "person-1",
      recipient: THEIRS,
    });
    const { userId, apiKey } = await createMember();

    const result = await jmapJson(apiKey, [
      ["Email/get", { accountId: acct(userId), ids: [rid("theirs-1")] }, "e1"],
      [
        "Mailbox/get",
        { accountId: acct(userId), ids: [sys(THEIRS, "inbox")] },
        "m1",
      ],
    ]);
    expect(result.methodResponses[0][1]).toMatchObject({
      list: [],
      notFound: [rid("theirs-1")],
    });
    expect(result.methodResponses[1][1]).toMatchObject({
      list: [],
      notFound: [sys(THEIRS, "inbox")],
    });
  });

  it("keeps Email/get and Email/query bounded with more than 300 messages", async () => {
    const { userId, apiKey } = await createTestUser({ id: "jmap-large-user" });
    const base = Math.floor(Date.now() / 1000) - 1000;
    for (let index = 0; index < 305; index += 1) {
      await createTestSentEmail({
        id: `bulk-${index}`,
        personId: null,
        fromAddress: MINE,
        toAddress: "alice@example.com",
        sentAt: base + index,
      });
    }

    const selected = await jmapJson(apiKey, [
      [
        "Email/get",
        {
          accountId: acct(userId),
          ids: [sid("bulk-3"), sid("bulk-301")],
        },
        "g1",
      ],
      [
        "Email/get",
        {
          accountId: acct(userId),
          ids: null,
        },
        "g2",
      ],
      [
        "Email/query",
        {
          accountId: acct(userId),
          position: 10,
          limit: 5,
          calculateTotal: true,
        },
        "q1",
      ],
    ]);

    expect(
      selected.methodResponses[0][1].list.map((email: any) => email.id),
    ).toEqual(expect.arrayContaining([sid("bulk-3"), sid("bulk-301")]));
    expect(selected.methodResponses[0][1].list).toHaveLength(2);
    expect(selected.methodResponses[1]).toEqual([
      "error",
      expect.objectContaining({ type: "requestTooLarge" }),
      "g2",
    ]);
    expect(selected.methodResponses[2][1]).toMatchObject({
      position: 10,
      ids: [
        sid("bulk-294"),
        sid("bulk-293"),
        sid("bulk-292"),
        sid("bulk-291"),
        sid("bulk-290"),
      ],
      total: 305,
    });
  });

  it("chunks Email/get across the D1 binding cap and preserves request order", async () => {
    const { userId, apiKey } = await createTestUser({ id: "jmap-chunk-user" });
    await createTestPerson({
      id: "chunk-person",
      email: "chunk@example.com",
    });

    for (let index = 0; index < 100; index += 1) {
      await createTestEmail({
        id: `chunk-recv-${index}`,
        personId: "chunk-person",
        recipient: MINE,
        messageId: `chunk-recv-${index}@example.com`,
        conversationId: `chunk-recv-thread-${index}`,
      });
      await createTestSentEmail({
        id: `chunk-sent-${index}`,
        personId: null,
        fromAddress: MINE,
        toAddress: "chunk@example.com",
        conversationId: `chunk-sent-thread-${index}`,
      });
    }

    const requestedIds = Array.from({ length: 256 }, (_, index) => {
      if (index < 200) {
        const id = Math.floor(index / 2);
        return index % 2 === 0
          ? rid(`chunk-recv-${id}`)
          : sid(`chunk-sent-${id}`);
      }
      return rid(`chunk-missing-${index}`);
    });

    const result = await jmapJson(apiKey, [
      ["Email/get", { accountId: acct(userId), ids: requestedIds }, "g1"],
    ]);
    const get = result.methodResponses[0][1];

    expect(get.list.map((email: any) => email.id)).toEqual(
      requestedIds.slice(0, 200),
    );
    expect(get.notFound).toEqual(requestedIds.slice(200));
  });

  it("chunks Thread/get for more than 20 requested thread ids", async () => {
    const { userId, apiKey } = await createTestUser({
      id: "jmap-thread-chunk-user",
    });

    for (let index = 0; index < 60; index += 1) {
      await createTestSentEmail({
        id: `thread-chunk-email-${index}`,
        personId: null,
        fromAddress: MINE,
        toAddress: "alice@example.com",
        conversationId: `thread-chunk-${index}`,
        sentAt: 1000 + index,
      });
    }

    const ids = Array.from({ length: 60 }, (_, index) =>
      thread(`thread-chunk-${index}`),
    );
    const result = await jmapJson(apiKey, [
      ["Thread/get", { accountId: acct(userId), ids }, "t1"],
    ]);

    expect(
      result.methodResponses[0][1].list.map((thread: any) => thread.id),
    ).toEqual(ids);
  });

  it("keeps Thread/get requestTooLarge semantics across query chunks", async () => {
    const { userId, apiKey } = await createTestUser({
      id: "jmap-thread-overflow-user",
    });

    for (let index = 0; index < 1025; index += 1) {
      const threadIndex = index < 1000 ? Math.floor(index / 50) : 20;
      await createTestSentEmail({
        id: `thread-overflow-email-${index}`,
        personId: null,
        fromAddress: MINE,
        toAddress: "alice@example.com",
        conversationId: `thread-overflow-${threadIndex}`,
        sentAt: 2000 + index,
      });
    }

    const ids = Array.from({ length: 21 }, (_, index) =>
      thread(`thread-overflow-${index}`),
    );
    const result = await jmapJson(apiKey, [
      ["Thread/get", { accountId: acct(userId), ids }, "t1"],
    ]);

    expect(result.methodResponses[0]).toEqual([
      "error",
      expect.objectContaining({ type: "requestTooLarge" }),
      "t1",
    ]);
  });

  it("isolates method exceptions as serverFail and continues later calls", async () => {
    const db = getDb();
    const responses = await executeJmapCalls(
      db,
      { isAdmin: true },
      { id: "jmap-user" },
      [CORE_CAPABILITY, MAIL_CAPABILITY],
      [
        ["Core/boom", {}, "boom"],
        ["Core/echo", { ok: true }, "next"],
      ],
      async (_db, _allowed, _user, name, args) => {
        if (name === "Core/boom") throw new Error("boom");
        return { ok: true, name, result: args };
      },
    );

    expect(responses).toEqual([
      ["error", { type: "serverFail" }, "boom"],
      ["Core/echo", { ok: true }, "next"],
    ]);
  });

  it("downloads only permission-scoped attachment blobs", async () => {
    await addIdentity(MINE);
    await addIdentity(THEIRS);
    await createTestPerson({ id: "person-1", email: "alice@example.com" });
    await createTestEmail({
      id: "mine-1",
      personId: "person-1",
      recipient: MINE,
    });
    await createTestEmail({
      id: "theirs-1",
      personId: "person-1",
      recipient: THEIRS,
      messageId: "theirs-message@example.com",
    });
    const mine = await createTestAttachment({
      id: "mine-blob",
      emailId: "mine-1",
      r2Key: "jmap/mine.txt",
      filename: "mine.txt",
    });
    const theirs = await createTestAttachment({
      id: "theirs-blob",
      emailId: "theirs-1",
      r2Key: "jmap/theirs.txt",
      filename: "theirs.txt",
    });
    await env.R2.put(mine.r2Key, new TextEncoder().encode("m"));
    await env.R2.put(theirs.r2Key, new TextEncoder().encode("t"));
    const { userId, apiKey } = await createMember();

    const readable = await authFetch(
      `/jmap/download/${acct(userId)}/${att("mine-blob")}/mine.txt?type=text/plain`,
      { apiKey },
    );
    expect(readable.status).toBe(200);
    expect(await readable.text()).toBe("m");
    expect(readable.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const hidden = await authFetch(
      `/jmap/download/${acct(userId)}/${att("theirs-blob")}/theirs.txt?type=text/plain`,
      { apiKey },
    );
    expect(hidden.status).toBe(404);
  });
});
