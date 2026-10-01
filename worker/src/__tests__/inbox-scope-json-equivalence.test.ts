// Every inbox permission check binds the member's grant once, as a JSON array
// read through json_each (D1 caps a statement at 100 bound parameters). The
// grant used to be bound value by value (`IN (?, ?, …)`), so what a member sees
// must be exactly what that showed: a row is visible iff its inbox column,
// byte for byte, is one of the grant's lowercased addresses. Inbox strings
// here carry JSON-special characters (quotes, backslashes, brackets, commas),
// non-ASCII (French, Kabiyè, an emoji) and mixed case on either side, and
// members hold random subsets of them; every web and JMAP read path must
// agree with that oracle, and none may show another inbox's mail.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inboxPermissions } from "../db/inbox-permissions.schema";
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
import { acct, drf, rid, sid, sys } from "./jmap-ids";
import {
  insertTestContent,
  insertTestDraft,
  jmapCall,
} from "./jmap-submission-fixtures";

type Responses = [string, Record<string, any>, string][];

/**
 * Inbox column values as stored. The JSON-breaking ones would widen or break
 * the scope if the list were ever spliced into the JSON text unescaped.
 */
const INBOXES = [
  "plain@eq.test",
  'quote"inside@eq.test',
  "back\\slash@eq.test",
  '"json","inject"@eq.test',
  ']"},{"x@eq.test',
  "o'brien@eq.test",
  "comma,semi;colon@eq.test",
  "percent%_under@eq.test",
  "élève.très-déjà@exemple.test",
  "kabiyè-ɛɔŋʋ@eq.test",
  "emoji😀@eq.test",
  // A legacy mixed-case column value: a grant is lowercased at resolution,
  // so on main it never matched this row, whatever the grant's case.
  "MiXeD@eq.test",
];

/** A small deterministic PRNG, so a failing seed can be replayed. */
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Member = {
  userId: string;
  apiKey: string;
  /** Grant rows as stored (case varied). */
  grants: string[];
};

/** Main's rule: the column value equals one of the lowercased grants. */
function visible(member: Member, column: string): boolean {
  return member.grants.map((grant) => grant.toLowerCase()).includes(column);
}

async function grantRows(userId: string, emails: string[]) {
  const now = Math.floor(Date.now() / 1000);
  for (let start = 0; start < emails.length; start += 10) {
    const chunk = emails.slice(start, start + 10);
    if (chunk.length === 0) continue;
    await getDb()
      .insert(inboxPermissions)
      .values(
        chunk.map((email) => ({
          userId,
          email,
          createdAt: now,
          createdBy: null,
        })),
      );
  }
}

async function seedMail() {
  let index = 0;
  for (const inbox of INBOXES) {
    index += 1;
    await createTestPerson({
      id: `eq-person-${index}`,
      email: `sender${index}@example.com`,
    });
    await createTestEmail({
      id: `eq-r-${index}`,
      personId: `eq-person-${index}`,
      recipient: inbox,
      messageId: `eq-r-${index}@example.com`,
      conversationId: `eq-conv-${index}`,
    });
    await createTestSentEmail({
      id: `eq-s-${index}`,
      fromAddress: inbox,
      toAddress: `sender${index}@example.com`,
    });
  }
}

/**
 * One JMAP draft per inbox, owned by the member. A draft's inbox is stored
 * lowercased (the create path folds the From address), so it is here too.
 */
async function seedDrafts(member: Member) {
  let index = 0;
  for (const inbox of INBOXES) {
    index += 1;
    const id = `${member.userId}-d${index}`;
    const lower = inbox.toLowerCase();
    await insertTestContent({
      id: `${id}-c`,
      userId: member.userId,
      inbox: lower,
    });
    await insertTestDraft({
      id,
      userId: member.userId,
      contentId: `${id}-c`,
      inbox: lower,
    });
  }
}

/** What main showed this member, as JMAP ids and web refs. */
function expectedFor(member: Member) {
  const jmapIds: string[] = [];
  const webRefs: string[] = [];
  const hidden: string[] = [];
  INBOXES.forEach((inbox, position) => {
    const index = position + 1;
    const own = [rid(`eq-r-${index}`), sid(`eq-s-${index}`)];
    const draft = drf(`${member.userId}-d${index}`);
    if (visible(member, inbox)) {
      jmapIds.push(...own);
      webRefs.push(`received:eq-r-${index}`, `sent:eq-s-${index}`);
    } else {
      hidden.push(...own);
    }
    if (visible(member, inbox.toLowerCase())) jmapIds.push(draft);
    else hidden.push(draft);
  });
  return { jmapIds: jmapIds.sort(), webRefs: webRefs.sort(), hidden };
}

async function makeMembers(): Promise<Member[]> {
  const random = mulberry32(0x5eed);
  const plans: string[][] = [
    [], // no grant at all: sees nothing
    ["plain@eq.test"],
    INBOXES.map((inbox) => inbox.toUpperCase()), // every grant, stored upper-case
    ["mixed@eq.test", "MiXeD@eq.test"], // the legacy column never matches
  ];
  for (let extra = 0; extra < 4; extra += 1) {
    plans.push(
      INBOXES.filter(() => random() < 0.5).map((inbox) =>
        random() < 0.3 ? inbox.toUpperCase() : inbox,
      ),
    );
  }
  const members: Member[] = [];
  for (const [index, grants] of plans.entries()) {
    const { userId, apiKey } = await createTestUser({
      id: `eq-${index}`,
      role: "member",
      email: `eq-${index}@example.com`,
    });
    // A grant list may hold the same address twice (two case forms).
    await grantRows(userId, [...new Set(grants)]);
    members.push({ userId, apiKey, grants: [...new Set(grants)] });
  }
  return members;
}

async function stateOf(userId: string): Promise<string> {
  const [response] = (await jmapCall(userId, [
    ["Email/get", { accountId: acct(userId), ids: [] }, "s"],
  ])) as Responses;
  return response[1].state as string;
}

describe("inbox scope bound as JSON: members see exactly what the value-by-value IN list showed", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("JMAP Email/query, Email/get, Email/changes and Mailbox/get counts agree with the grant for every member", async () => {
    const members = await makeMembers();
    const since = new Map<string, string>();
    for (const member of members) {
      since.set(member.userId, await stateOf(member.userId));
    }
    await seedMail();
    for (const member of members) await seedDrafts(member);

    const everyId = [
      ...INBOXES.flatMap((_, position) => [
        rid(`eq-r-${position + 1}`),
        sid(`eq-s-${position + 1}`),
      ]),
    ];

    for (const member of members) {
      const label = `${member.userId} ${JSON.stringify(member.grants)}`;
      const expected = expectedFor(member);
      const account = acct(member.userId);
      const ownDrafts = INBOXES.map((_, position) =>
        drf(`${member.userId}-d${position + 1}`),
      );
      const responses = (await jmapCall(member.userId, [
        ["Email/query", { accountId: account, filter: {} }, "q"],
        [
          "Email/get",
          {
            accountId: account,
            ids: [...everyId, ...ownDrafts],
            properties: ["id"],
          },
          "g",
        ],
        [
          "Email/changes",
          { accountId: account, sinceState: since.get(member.userId) },
          "c",
        ],
      ])) as Responses;

      const [queryName, query] = responses[0];
      expect(queryName, label).toBe("Email/query");
      expect([...query.ids].sort(), label).toEqual(expected.jmapIds);

      const [, got] = responses[1];
      expect(
        got.list.map((email: { id: string }) => email.id).sort(),
        label,
      ).toEqual(expected.jmapIds);
      expect([...got.notFound].sort(), label).toEqual(
        [...expected.hidden].sort(),
      );

      const [changesName, changes] = responses[2];
      expect(changesName, label).toBe("Email/changes");
      expect(
        [...changes.created, ...changes.updated]
          .filter(
            (id: string, at: number, all: string[]) => all.indexOf(id) === at,
          )
          .sort(),
        label,
      ).toEqual(expected.jmapIds);

      // Counts of each granted inbox's Inbox and Drafts: one received mail
      // (one draft) when its column matches the lowercased grant, else none.
      const grantedInboxes = [
        ...new Set(member.grants.map((grant) => grant.toLowerCase())),
      ];
      if (grantedInboxes.length > 0) {
        const ids = grantedInboxes.flatMap((inbox) => [
          sys(inbox, "inbox"),
          sys(inbox, "drafts"),
        ]);
        const [[mailboxName, mailboxes]] = (await jmapCall(member.userId, [
          ["Mailbox/get", { accountId: account, ids }, "m"],
        ])) as Responses;
        expect(mailboxName, label).toBe("Mailbox/get");
        expect(mailboxes.notFound, label).toEqual([]);
        const totals = Object.fromEntries(
          mailboxes.list.map((m: { id: string; totalEmails: number }) => [
            m.id,
            m.totalEmails,
          ]),
        );
        for (const inbox of grantedInboxes) {
          const present = INBOXES.includes(inbox) ? 1 : 0;
          expect(totals[sys(inbox, "inbox")], `${label} ${inbox}`).toBe(
            present,
          );
          // Drafts are stored lowercased, so the legacy mixed-case inbox has one.
          const drafted = INBOXES.some((each) => each.toLowerCase() === inbox)
            ? 1
            : 0;
          expect(totals[sys(inbox, "drafts")], `${label} ${inbox}`).toBe(
            drafted,
          );
        }
      }
    }
  });

  it("the web message list, drafts list, people list and stats agree with the grant for every member", async () => {
    const members = await makeMembers();
    await seedMail();
    for (const member of members) await seedDrafts(member);

    for (const member of members) {
      const label = `${member.userId} ${JSON.stringify(member.grants)}`;
      const expected = expectedFor(member);
      const visibleInboxes = INBOXES.filter((inbox) => visible(member, inbox));

      const messagesResponse = await authFetch("/api/messages?limit=100", {
        apiKey: member.apiKey,
      });
      expect(messagesResponse.status, label).toBe(200);
      const messages = (await messagesResponse.json()) as {
        messages: { ref: string; inbox: string }[];
      };
      expect(
        messages.messages
          .map((message) => message.ref)
          .filter((ref) => /^(received|sent):/.test(ref))
          .sort(),
        label,
      ).toEqual(expected.webRefs);
      for (const message of messages.messages) {
        expect(visibleInboxes, label).toContain(message.inbox);
      }

      const draftsResponse = await authFetch(
        "/api/drafts/list?includeMailClient=1&limit=100",
        { apiKey: member.apiKey },
      );
      expect(draftsResponse.status, label).toBe(200);
      const drafts = (await draftsResponse.json()) as {
        drafts: { id: string; fromAddress: string }[];
      };
      expect(
        drafts.drafts.map((draft) => draft.fromAddress).sort(),
        label,
      ).toEqual(
        INBOXES.map((inbox) => inbox.toLowerCase())
          .filter((inbox) => visible(member, inbox))
          .sort(),
      );

      const peopleResponse = await authFetch("/api/people?limit=100", {
        apiKey: member.apiKey,
      });
      expect(peopleResponse.status, label).toBe(200);
      const people = (await peopleResponse.json()) as {
        data: { recipient: string }[];
      };
      expect(people.data.map((row) => row.recipient).sort(), label).toEqual(
        [...visibleInboxes].sort(),
      );

      const statsResponse = await authFetch("/api/stats", {
        apiKey: member.apiKey,
      });
      expect(statsResponse.status, label).toBe(200);
      const stats = (await statsResponse.json()) as { totalEmails: number };
      expect(stats.totalEmails, label).toBe(visibleInboxes.length);
    }
  });
});
