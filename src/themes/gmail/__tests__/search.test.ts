import { describe, expect, it } from "vitest";
import {
  buildListSearch,
  dateQuery,
  folderQuery,
  parseListState,
  negatedOperators,
  parseSearchQuery,
  pushRecent,
  resolveShortcut,
  stateToQuery,
  validDay,
  withinRange,
} from "../lib";

const labels = [
  { address: "support@acme.com", displayName: "Support" },
  { address: "billing@acme.com", displayName: null },
];

describe("parseSearchQuery", () => {
  it("keeps plain words as text and searches all mail", () => {
    const s = parseSearchQuery("quarterly report");
    expect(s.q).toBe("quarterly report");
    expect(s.folder).toBe("all");
  });

  it("maps Gmail operators to filters", () => {
    const s = parseSearchQuery(
      'from:ana@x.com is:unread has:attachment in:archive "exact words" invoice',
    );
    expect(s.from).toBe("ana@x.com");
    expect(s.unread).toBe(true);
    expect(s.attachment).toBe(true);
    expect(s.folder).toBe("archive");
    expect(s.q).toBe('"exact words" invoice');
  });

  it("understands quoted values and is:starred / is:snoozed", () => {
    expect(parseSearchQuery('from:"Ana Lopez"').from).toBe("Ana Lopez");
    expect(parseSearchQuery("is:starred").folder).toBe("starred");
    expect(parseSearchQuery("is:snoozed").folder).toBe("snoozed");
    expect(parseSearchQuery("in:anywhere").folder).toBe("all");
    expect(parseSearchQuery("in:sent").folder).toBe("sent");
    expect(parseSearchQuery("in:drafts").folder).toBe("drafts");
  });

  it("keeps negated operators and is:read as text, never as the positive filter", () => {
    const neg = parseSearchQuery("-from:bob invoice");
    expect(neg.from).toBe("");
    expect(neg.q).toBe("-from:bob invoice");
    expect(parseSearchQuery("-is:unread").unread).toBeFalsy();
    expect(parseSearchQuery("-in:trash").folder).toBe("all");
    const read = parseSearchQuery("is:read");
    expect(read.unread).toBeFalsy();
    expect(read.q).toBe("is:read");
  });

  it("finds negated operators in free text", () => {
    expect(negatedOperators('-from:bob x -subject:"a b"')).toEqual([
      "-from:bob",
      '-subject:"a b"',
    ]);
    expect(negatedOperators("re-sent from:bob")).toEqual([]);
  });

  it("resolves label: by name or address", () => {
    expect(parseSearchQuery("label:support", labels).label).toBe(
      "support@acme.com",
    );
    expect(parseSearchQuery("label:billing", labels).label).toBe(
      "billing@acme.com",
    );
    expect(parseSearchQuery("label:other@x.com", labels).label).toBe(
      "other@x.com",
    );
  });

  it("reads category: and newer_than:/older_than:", () => {
    expect(parseSearchQuery("category:promotions").category).toBe("promotions");
    expect(parseSearchQuery("newer_than:7d").within).toBe("7d");
    expect(parseSearchQuery("older_than:1y").within).toBe("older1y");
  });

  it("leaves unknown operators in the text", () => {
    expect(parseSearchQuery("size:10m hello").q).toBe("size:10m hello");
    expect(parseSearchQuery("is:important").q).toBe("is:important");
  });

  it("round-trips through the search box text and the URL", () => {
    const text =
      "from:ana@x.com label:support is:unread has:attachment category:updates newer_than:1m report";
    const s = parseSearchQuery(text, labels);
    expect(stateToQuery(s, labels)).toBe(text);
    const again = parseListState(new URLSearchParams(buildListSearch(s)));
    expect(again).toEqual(s);
  });
});

describe("folderQuery with tabs", () => {
  it("adds the Primary category to the inbox only when tabs are on", () => {
    const inbox = parseListState(new URLSearchParams(""));
    expect(folderQuery(inbox, true).category).toBe("primary");
    expect(folderQuery(inbox, false).category).toBeUndefined();
    const promos = parseListState(new URLSearchParams("tab=promotions"));
    expect(folderQuery(promos, true)).toEqual({
      folder: "inbox",
      category: "promotions",
    });
    expect(
      folderQuery(parseListState(new URLSearchParams("folder=sent")), true)
        .category,
    ).toBeUndefined();
  });
});

describe("resolveShortcut", () => {
  it("handles g and * prefixes", () => {
    expect(resolveShortcut({ key: "g" })).toEqual({ prefix: "g" });
    expect(resolveShortcut({ key: "i" }, "g")).toEqual({ cmd: "goInbox" });
    expect(resolveShortcut({ key: "t" }, "g")).toEqual({ cmd: "goSent" });
    expect(resolveShortcut({ key: "*", shiftKey: true })).toEqual({
      prefix: "*",
    });
    expect(resolveShortcut({ key: "u" }, "*")).toEqual({
      cmd: "selectUnread",
    });
    expect(resolveShortcut({ key: "q" }, "g")).toEqual({});
  });
  it("maps the single keys", () => {
    expect(resolveShortcut({ key: "z" }).cmd).toBe("undo");
    expect(resolveShortcut({ key: "]" }).cmd).toBe("archiveOlder");
    expect(resolveShortcut({ key: "[" }).cmd).toBe("archiveNewer");
    expect(resolveShortcut({ key: ";" }).cmd).toBe("expandAll");
    expect(resolveShortcut({ key: ":", shiftKey: true }).cmd).toBe(
      "collapseAll",
    );
    expect(resolveShortcut({ key: "e", ctrlKey: true })).toEqual({});
  });
});

describe("misc", () => {
  it("computes date windows", () => {
    const now = new Date(2026, 9, 26);
    const t = Math.floor(now.getTime() / 1000);
    expect(withinRange("7d", now)).toEqual({
      after: t - 7 * 86400,
      before: null,
    });
    expect(withinRange("older1y", now)).toEqual({
      after: null,
      before: t - 365 * 86400,
    });
    expect(withinRange("", now)).toEqual({ after: null, before: null });
  });
  it("keeps recent searches unique and capped", () => {
    expect(pushRecent(["a", "b"], "b")).toEqual(["b", "a"]);
    expect(pushRecent(["a"], "  ")).toEqual(["a"]);
    expect(pushRecent(["1", "2", "3"], "4", 3)).toEqual(["4", "1", "2"]);
  });
});

describe("server-side search fields", () => {
  it("parses subject:, to:, before: and after:", () => {
    const s = parseSearchQuery(
      'subject:"quarterly plan" to:support after:2026/01/05 before:2026-02-01 hi',
      labels,
    );
    expect(s.subject).toBe("quarterly plan");
    expect(s.label).toBe("support@acme.com");
    expect(s.after).toBe("2026-01-05");
    expect(s.before).toBe("2026-02-01");
    expect(s.q).toBe("hi");
  });
  it("keeps bad dates and unsupported operators as text", () => {
    expect(parseSearchQuery("after:soon").q).toBe("after:soon");
    expect(parseSearchQuery("is:read").q).toBe("is:read");
    expect(parseSearchQuery("in:trash").folder).toBe("trash");
  });
  it("turns relative newer_than/older_than into dates", () => {
    const s = parseSearchQuery("newer_than:3d older_than:2y");
    expect(s.after).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.before).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("sends date windows to the server", () => {
    const now = new Date(2026, 9, 26, 12);
    const day = (y: number, m: number, d: number) =>
      Math.floor(new Date(y, m - 1, d).getTime() / 1000);
    expect(
      dateQuery({ within: "", after: "2026-10-01", before: "2026-10-10" }, now),
    ).toEqual({ after: day(2026, 10, 1), before: day(2026, 10, 10) });
    const w = dateQuery({ within: "7d", after: "2026-10-25", before: "" }, now);
    expect(w.after).toBe(day(2026, 10, 25));
    const s = parseListState(
      new URLSearchParams(
        buildListSearch({ folder: "all", after: "2026-10-01" }),
      ),
    );
    expect(folderQuery(s, true).after).toBe(day(2026, 10, 1));
  });
  it("validates days", () => {
    expect(validDay("2026/2/30")).toBe("");
    expect(validDay("2026-2-3")).toBe("2026-02-03");
  });
});
