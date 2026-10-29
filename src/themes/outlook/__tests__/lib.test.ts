import { describe, expect, it } from "vitest";
import type { GroupedItem } from "@/lib/api";
import {
  filterQuery,
  serverSort,
  commandForKey,
  dateBucket,
  folderQuery,
  forwardSubject,
  groupRows,
  initials,
  parseFolder,
  rangeKeys,
  swipeOutcome,
  parseSearchQuery,
  buildSearchQuery,
  sweepSelection,
  groupParticipants,
  favoriteKey,
  parseFavorite,
  DEFAULT_FAVORITES,
  flagReminder,
} from "../lib";

// Thu 22 Oct 2026, 14:00 local.
const NOW = new Date(2026, 9, 22, 14, 0, 0);
const sec = (d: Date) => Math.floor(d.getTime() / 1000);
const at = (y: number, m: number, d: number, h = 9) =>
  sec(new Date(y, m, d, h));

function row(id: string, patch: Partial<GroupedItem> = {}): GroupedItem {
  return {
    type: "person",
    id,
    email: `${id}@x.test`,
    name: id,
    lastEmailAt: sec(NOW),
    unreadCount: 0,
    totalCount: 1,
    recipientCount: 1,
    recipients: [],
    hasAttachment: 0,
    starred: false,
    pinned: false,
    archivedAt: null,
    snoozedUntil: null,
    hasSent: false,
    latestSubject: null,
    snippet: null,
    ...patch,
  } as GroupedItem;
}

describe("dateBucket", () => {
  it("buckets like Outlook", () => {
    expect(dateBucket(at(2026, 9, 22, 8), NOW)).toBe("Today");
    expect(dateBucket(at(2026, 9, 21, 23), NOW)).toBe("Yesterday");
    // Week starts Sunday 18 Oct.
    expect(dateBucket(at(2026, 9, 18), NOW)).toBe("This week");
    expect(dateBucket(at(2026, 9, 17), NOW)).toBe("Last week");
    expect(dateBucket(at(2026, 9, 11), NOW)).toBe("Last week");
    expect(dateBucket(at(2026, 9, 10), NOW)).toBe("Earlier this month");
    expect(dateBucket(at(2026, 9, 3), NOW)).toBe("Earlier this month");
    expect(dateBucket(at(2026, 8, 3), NOW)).toBe("Last month");
    expect(dateBucket(at(2026, 6, 3), NOW)).toBe("Older");
  });
});

describe("groupRows", () => {
  it("puts pinned rows first, then date buckets", () => {
    const items = [
      row("a", { lastEmailAt: at(2026, 9, 22) }),
      row("b", { lastEmailAt: at(2026, 9, 1), pinned: true }),
      row("c", { lastEmailAt: at(2026, 9, 21) }),
      row("d", { lastEmailAt: at(2026, 9, 22, 7) }),
    ];
    const groups = groupRows(items, "date", (i) => i.id, NOW);
    expect(groups.map((g) => g.label)).toEqual([
      "Pinned",
      "Today",
      "Yesterday",
    ]);
    expect(groups[1].items.map((i) => i.id)).toEqual(["a", "d"]);
  });

  it("groups by letter for From sort and by state for Unread sort", () => {
    const items = [row("zed"), row("amy", { unreadCount: 2 }), row("Al")];
    expect(
      groupRows(items, "from", (i) => i.id, NOW).map((g) => [
        g.label,
        g.items.length,
      ]),
    ).toEqual([
      ["A", 2],
      ["Z", 1],
    ]);
    expect(
      groupRows(items, "unread", (i) => i.id, NOW).map((g) => g.label),
    ).toEqual(["Unread", "Read"]);
  });
});

describe("filters and folders", () => {
  it("sends every list filter to the server", () => {
    expect(filterQuery("unread")).toEqual({ unread: true });
    expect(filterQuery("flagged")).toEqual({ starred: true });
    expect(filterQuery("files")).toEqual({ hasAttachment: true });
    expect(filterQuery("pinned")).toEqual({ pinned: true });
    expect(filterQuery("all")).toEqual({});
    expect(serverSort("files")).toBe("attachments");
  });

  it("maps Outlook folders to server queries", () => {
    expect(parseFolder("nope")).toBe("inbox");
    expect(folderQuery("flagged")).toEqual({ folder: "starred" });
    expect(folderQuery("drafts")).toEqual({ folder: "all", drafts: true });
    expect(folderQuery("sent")).toEqual({ folder: "sent" });
  });
});

describe("commandForKey", () => {
  it("maps the Outlook web shortcut set", () => {
    expect(commandForKey({ key: "n", ctrlKey: true })).toBe("newMail");
    expect(commandForKey({ key: "r", metaKey: true })).toBe("reply");
    expect(commandForKey({ key: "R", ctrlKey: true, shiftKey: true })).toBe(
      "replyAll",
    );
    expect(commandForKey({ key: "F", ctrlKey: true, shiftKey: true })).toBe(
      "forward",
    );
    expect(commandForKey({ key: "q", ctrlKey: true })).toBe("markRead");
    expect(commandForKey({ key: "u", ctrlKey: true })).toBe("markUnread");
    expect(commandForKey({ key: "Delete" })).toBe("delete");
    expect(commandForKey({ key: "e" })).toBe("archive");
    expect(commandForKey({ key: "Insert" })).toBe("flag");
    expect(commandForKey({ key: "ArrowDown" })).toBe("next");
    expect(commandForKey({ key: "?", shiftKey: true })).toBe("help");
    expect(commandForKey({ key: "x" })).toBeNull();
    expect(commandForKey({ key: "V", ctrlKey: true, shiftKey: true })).toBe(
      "move",
    );
    expect(commandForKey({ key: "Delete", shiftKey: true })).toBe("delete");
    expect(commandForKey({ key: "q" })).toBe("markRead");
    expect(commandForKey({ key: "u" })).toBe("markUnread");
    expect(commandForKey({ key: "z", metaKey: true })).toBe("undo");
    expect(commandForKey({ key: ".", ctrlKey: true })).toBe("next");
    expect(commandForKey({ key: ",", ctrlKey: true })).toBe("prev");
    expect(commandForKey({ key: "Home" })).toBe("first");
    expect(commandForKey({ key: "End" })).toBe("last");
    expect(commandForKey({ key: "F6" })).toBe("panes");
    expect(commandForKey({ key: "/" })).toBe("search");
    expect(commandForKey({ key: "k", ctrlKey: true })).toBeNull();
  });
});

describe("misc helpers", () => {
  it("builds initials", () => {
    expect(initials("Vera Wayne")).toBe("VW");
    expect(initials("vera.wayne@piedpiper.ai")).toBe("VW");
    expect(initials("bob")).toBe("B");
    expect(initials("")).toBe("?");
  });

  it("builds a forward subject without stacking prefixes", () => {
    expect(forwardSubject("Re: Fwd: Quote")).toBe("Fwd: Quote");
  });

  it("computes shift-click ranges in either direction", () => {
    const order = ["a", "b", "c", "d"];
    expect(rangeKeys(order, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeKeys(order, "d", "b")).toEqual(["b", "c", "d"]);
  });

  it("decides swipe outcomes past a threshold", () => {
    expect(swipeOutcome(150, 390)).toBe("right");
    expect(swipeOutcome(-150, 390)).toBe("left");
    expect(swipeOutcome(40, 390)).toBeNull();
  });
});

describe("parseSearchQuery", () => {
  it("pulls Outlook keywords out of the text", () => {
    const p = parseSearchQuery(
      'invoice from:"Vera Wayne" hasattachments:yes isread:no isflagged:yes folder:archive to:support@example.com',
    );
    expect(p).toMatchObject({
      text: "invoice",
      from: "Vera Wayne",
      hasAttachment: true,
      unread: true,
      flagged: true,
      folder: "archive",
      to: "support@example.com",
    });
  });

  it("handles isread:yes, unknown keywords and dates", () => {
    const p = parseSearchQuery(
      "isread:yes subject:hello received>=2026-01-01 foo:bar",
    );
    // The server can't filter "read only", so that stays plain text.
    expect(p.unread).toBeUndefined();
    expect(p.subject).toBe("hello");
    expect(p.text).toBe("isread:yes foo:bar");
    expect(p.after).toBe(Math.floor(Date.parse("2026-01-01") / 1000));
  });

  it("round-trips through buildSearchQuery", () => {
    const q = "from:bob hasattachments:yes isread:no report";
    expect(parseSearchQuery(buildSearchQuery(parseSearchQuery(q)))).toEqual(
      parseSearchQuery(q),
    );
  });

  it("round-trips both date bounds and exact days", () => {
    for (const q of [
      "received<=2026-02-10",
      "received>=2026-01-01 received<=2026-02-10",
      "received:2026-03-05",
    ]) {
      const p = parseSearchQuery(q);
      expect(buildSearchQuery(p)).toBe(q);
      expect(parseSearchQuery(buildSearchQuery(p))).toEqual(p);
    }
    // A refiner click must not erase a typed upper bound.
    const p = parseSearchQuery("received<=2026-02-10");
    expect(
      parseSearchQuery(buildSearchQuery({ ...p, hasAttachment: true })),
    ).toMatchObject({
      before: p.before,
      hasAttachment: true,
    });
    // An exact day stays a day, not "since".
    expect(buildSearchQuery(parseSearchQuery("received:2026-03-05"))).toBe(
      "received:2026-03-05",
    );
  });

  it("maps folder aliases and keeps unknown folders as text", () => {
    expect(parseSearchQuery("folder:trash").folder).toBe("deleted");
    expect(parseSearchQuery('folder:"Deleted Items"').folder).toBe("deleted");
    expect(parseSearchQuery("folder:deleted").folder).toBe("deleted");
    expect(parseSearchQuery("folder:unread").folder).toBe("unread");
    const p = parseSearchQuery("invoice folder:receipts");
    expect(p.folder).toBeUndefined();
    expect(p.text).toBe("invoice folder:receipts");
    expect(buildSearchQuery(p)).toBe("invoice folder:receipts");
  });
});

describe("flagReminder", () => {
  // Wednesday 2026-10-21, 10:00 local.
  const now = new Date(2026, 9, 21, 10, 0, 0);
  const at = (d: number, h: number) =>
    Math.floor(new Date(2026, 9, d, h, 0, 0).getTime() / 1000);
  it("brings the row back at a real time for every option", () => {
    expect(flagReminder("tomorrow", now)).toBe(at(22, 8));
    expect(flagReminder("thisweek", now)).toBe(at(22, 8));
    expect(flagReminder("nextweek", now)).toBe(at(26, 8));
  });
});

describe("sweepSelection", () => {
  const items = [
    row("a", { email: "news@shop.test" } as Partial<GroupedItem>),
    row("b", { email: "deals@shop.test" } as Partial<GroupedItem>),
    row("c", { email: "vera@piedpiper.ai" } as Partial<GroupedItem>),
  ];
  it("matches one sender exactly, case-insensitively", () => {
    expect(sweepSelection(items, "NEWS@shop.test").map((i) => i.id)).toEqual([
      "a",
    ]);
  });
  it("matches a whole domain with a leading @", () => {
    expect(sweepSelection(items, "@shop.test").map((i) => i.id)).toEqual([
      "a",
      "b",
    ]);
  });
  it("matches nothing for an empty sender", () => {
    expect(sweepSelection(items, " ")).toEqual([]);
  });
});

describe("group titles and favorites", () => {
  it("lists every participant, then Cc, once", () => {
    const g = {
      type: "group",
      id: "c1",
      inbox: "billing@x.test",
      participants: [{ id: "p1", email: "vera@x.test", name: "Vera Wayne" }],
      ccParticipants: [
        { email: "bob@x.test", name: "Bob Brown" },
        { email: "VERA@x.test", name: "Vera" },
      ],
    } as unknown as Extract<GroupedItem, { type: "group" }>;
    expect(groupParticipants(g)).toBe("Vera Wayne; Bob Brown");
  });
  it("encodes favorites and defaults to Outlook's Inbox / Sent Items / Drafts", () => {
    expect(favoriteKey("inbox", "support@x.test")).toBe("label:support@x.test");
    expect(parseFavorite("label:support@x.test")).toEqual({
      folder: "inbox",
      label: "support@x.test",
    });
    expect(parseFavorite("flagged")).toEqual({ folder: "flagged" });
    expect(parseFavorite("bogus")).toBeNull();
    expect(DEFAULT_FAVORITES).toEqual(["inbox", "sent", "drafts"]);
  });
});
