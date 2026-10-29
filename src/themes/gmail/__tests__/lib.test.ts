import { describe, expect, it } from "vitest";
import {
  buildListSearch,
  cleanSubject,
  colorIndex,
  folderQuery,
  formatListDate,
  initialOf,
  isTypingTarget,
  openParam,
  parseListState,
  parseOpen,
  rangeLabel,
  relativeTime,
  shortcutFor,
} from "../lib";

const sec = (d: Date) => Math.floor(d.getTime() / 1000);

describe("formatListDate", () => {
  const now = new Date(2026, 9, 26, 15, 0);
  it("shows the time for today", () => {
    expect(formatListDate(sec(new Date(2026, 9, 26, 9, 5)), now, "en-US")).toBe(
      "9:05 AM",
    );
  });
  it("shows month and day earlier this year", () => {
    expect(formatListDate(sec(new Date(2026, 9, 3, 9, 5)), now, "en-US")).toBe(
      "Oct 3",
    );
  });
  it("shows a short numeric date for older years", () => {
    expect(formatListDate(sec(new Date(2024, 2, 10)), now, "en-US")).toBe(
      "3/10/24",
    );
  });
});

describe("relativeTime", () => {
  const now = new Date(2026, 9, 26, 15, 0);
  it("counts minutes, hours and days", () => {
    expect(relativeTime(sec(now) - 30, now)).toBe("now");
    expect(relativeTime(sec(now) - 60, now)).toBe("1 minute ago");
    expect(relativeTime(sec(now) - 2 * 3600, now)).toBe("2 hours ago");
    expect(relativeTime(sec(now) - 3 * 86400, now)).toBe("3 days ago");
  });
  it("drops past a week", () => {
    expect(relativeTime(sec(now) - 9 * 86400, now)).toBeNull();
  });
});

describe("list state in the URL", () => {
  it("defaults to the inbox", () => {
    const s = parseListState(new URLSearchParams(""));
    expect(s.folder).toBe("inbox");
    expect(buildListSearch(s)).toBe("");
  });
  it("round-trips folder and label", () => {
    const search = buildListSearch({ folder: "starred", label: "a@x.com" });
    const s = parseListState(new URLSearchParams(search));
    expect(s.folder).toBe("starred");
    expect(s.label).toBe("a@x.com");
  });
  it("treats a label or search with no folder as all mail", () => {
    expect(parseListState(new URLSearchParams("label=a@x.com")).folder).toBe(
      "all",
    );
    expect(parseListState(new URLSearchParams("q=hello")).folder).toBe("all");
    expect(buildListSearch({ folder: "all", q: "hello" })).toBe("?q=hello");
  });
  it("maps drafts and sequenced to list filters", () => {
    expect(
      folderQuery(parseListState(new URLSearchParams("folder=drafts")), false),
    ).toEqual({ folder: "all", drafts: true });
    expect(
      folderQuery(
        parseListState(new URLSearchParams("folder=sequenced")),
        false,
      ),
    ).toEqual({ folder: "all", sequenced: true });
  });
  it("encodes the open conversation", () => {
    expect(openParam({ type: "group", id: "c1" })).toBe("g:c1");
    expect(parseOpen("p:abc")).toEqual({ type: "person", id: "abc" });
    expect(parseOpen("zz")).toBeNull();
  });
});

describe("shortcutFor", () => {
  it("maps Gmail's single keys", () => {
    expect(shortcutFor({ key: "j" })).toBe("next");
    expect(shortcutFor({ key: "k" })).toBe("prev");
    expect(shortcutFor({ key: "e" })).toBe("archive");
    expect(shortcutFor({ key: "#", shiftKey: true })).toBe("delete");
    expect(shortcutFor({ key: "I", shiftKey: true })).toBe("markRead");
    expect(shortcutFor({ key: "U", shiftKey: true })).toBe("markUnread");
    expect(shortcutFor({ key: "?", shiftKey: true })).toBe("help");
    expect(shortcutFor({ key: "/" })).toBe("search");
  });
  it("ignores modified keys", () => {
    expect(shortcutFor({ key: "c", metaKey: true })).toBeNull();
    expect(shortcutFor({ key: "r", ctrlKey: true })).toBeNull();
    expect(shortcutFor({ key: "q" })).toBeNull();
  });
  it("detects typing targets", () => {
    const input = document.createElement("input");
    const div = document.createElement("div");
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(div)).toBe(false);
  });
});

describe("misc helpers", () => {
  it("cleans reply prefixes", () => {
    expect(cleanSubject("Re: RE: Fwd: Hello")).toBe("Hello");
    expect(cleanSubject("")).toBe("(no subject)");
  });
  it("picks initials and stable colours", () => {
    expect(initialOf("ana lopez")).toBe("A");
    expect(initialOf(null, "bob@x.com")).toBe("B");
    expect(colorIndex("a@x.com")).toBe(colorIndex("a@x.com"));
    expect(colorIndex("a@x.com")).toBeLessThan(8);
  });
  it("formats the page range", () => {
    expect(rangeLabel(1, 50, 230)).toBe("1–50 of 230");
    expect(rangeLabel(5, 50, 230)).toBe("201–230 of 230");
    expect(rangeLabel(1, 50, 0)).toBe("0 of 0");
  });
});
