/**
 * Pure helpers for the Gmail layout: date formatting the way Gmail writes
 * it, URL <-> list state, Gmail search operators, avatar/label colours and
 * the keyboard shortcut map. Kept free of React so they are easy to test.
 */
import type { MailCategory, MailFolder } from "@/lib/api";

/* ── Dates ─────────────────────────────────────────────────────────── */

function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * List date, Gmail style: the time for today ("2:34 PM"), month and day
 * for this year ("Oct 3"), a short numeric date for older mail ("3/10/24").
 * `ts` is unix seconds.
 */
export function formatListDate(
  ts: number,
  now: Date = new Date(),
  locale?: string,
): string {
  const d = new Date(ts * 1000);
  if (sameDay(d, now)) {
    return d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(locale, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(locale, {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  });
}

/** "Mon, Oct 3, 2:34 PM" — the full stamp in a message header. */
export function formatFullDate(ts: number, locale?: string): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "(2 hours ago)" style relative time; null past ~a week (Gmail drops it). */
export function relativeTime(
  ts: number,
  now: Date = new Date(),
): string | null {
  const diff = Math.max(0, Math.floor(now.getTime() / 1000) - ts);
  if (diff < 60) return "now";
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days <= 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return null;
}

/* ── Folder state in the URL ───────────────────────────────────────── */

export type GmailFolder =
  | "inbox"
  | "starred"
  | "snoozed"
  | "sent"
  | "drafts"
  | "sequenced"
  | "archive"
  | "trash"
  | "all";

export const GMAIL_FOLDERS: GmailFolder[] = [
  "inbox",
  "starred",
  "snoozed",
  "sent",
  "drafts",
  "sequenced",
  "archive",
  "trash",
  "all",
];

export const CATEGORIES: MailCategory[] = [
  "primary",
  "promotions",
  "social",
  "updates",
];

export const CATEGORY_LABELS: Record<MailCategory, string> = {
  primary: "Primary",
  promotions: "Promotions",
  social: "Social",
  updates: "Updates",
};

/** Search date window ("Any time" chip). */
export type Within = "" | "1d" | "7d" | "1m" | "6m" | "1y" | "older1y";

export const WITHIN_LABELS: Record<Within, string> = {
  "": "Any time",
  "1d": "Past day",
  "7d": "Past week",
  "1m": "Past month",
  "6m": "Past 6 months",
  "1y": "Past year",
  older1y: "Older than a year",
};

export interface ListState {
  folder: GmailFolder;
  /** Inbox address used as a label filter. */
  label: string | null;
  /** Free-text search words. */
  q: string;
  unread: boolean;
  attachment: boolean;
  /** `subject:` words. */
  subject: string;
  /** `after:` / `before:` dates, "YYYY-MM-DD" (local days). */
  after: string;
  before: string;
  /** Sender filter. */
  from: string;
  /** Inbox tab (only applies to the inbox folder). */
  tab: MailCategory | null;
  /** Category filter from a search (`category:`). */
  category: MailCategory | null;
  within: Within;
}

const EMPTY: ListState = {
  folder: "inbox",
  label: null,
  q: "",
  unread: false,
  attachment: false,
  subject: "",
  after: "",
  before: "",
  from: "",
  tab: null,
  category: null,
  within: "",
};

/** True when the list is a search (Gmail shows chips + "Results"). */
export function isSearch(s: ListState): boolean {
  return !!(
    s.q ||
    s.from ||
    s.unread ||
    s.attachment ||
    s.subject ||
    s.after ||
    s.before ||
    s.within ||
    s.category
  );
}

export function parseListState(params: URLSearchParams): ListState {
  const raw = params.get("folder");
  const label = params.get("label") || null;
  const tab = params.get("tab") as MailCategory | null;
  const category = params.get("category") as MailCategory | null;
  const within = (params.get("within") ?? "") as Within;
  const s: ListState = {
    ...EMPTY,
    label,
    q: params.get("q") ?? "",
    from: params.get("from") ?? "",
    unread: params.get("unread") === "1",
    subject: params.get("subject") ?? "",
    after: validDay(params.get("after")),
    before: validDay(params.get("before")),
    attachment: params.get("has") === "attachment",
    tab: tab && CATEGORIES.includes(tab) ? tab : null,
    category: category && CATEGORIES.includes(category) ? category : null,
    within: within in WITHIN_LABELS ? within : "",
  };
  s.folder = GMAIL_FOLDERS.includes(raw as GmailFolder)
    ? (raw as GmailFolder)
    : "inbox";
  // A label or a search with no explicit folder looks across all mail, like
  // Gmail's label views and search results.
  if (!raw && (label || isSearch(s))) s.folder = "all";
  return s;
}

/** Query string (with leading "?", or "" for the plain inbox). */
export function buildListSearch(input: Partial<ListState>): string {
  const s: ListState = { ...EMPTY, ...input };
  const p = new URLSearchParams();
  const implicitAll = s.folder === "all" && (!!s.label || isSearch(s));
  if (s.folder !== "inbox" && !implicitAll) p.set("folder", s.folder);
  if (s.folder === "inbox" && s.tab && s.tab !== "primary") p.set("tab", s.tab);
  if (s.label) p.set("label", s.label);
  if (s.q) p.set("q", s.q);
  if (s.from) p.set("from", s.from);
  if (s.unread) p.set("unread", "1");
  if (s.subject) p.set("subject", s.subject);
  if (s.after) p.set("after", s.after);
  if (s.before) p.set("before", s.before);
  if (s.attachment) p.set("has", "attachment");
  if (s.category) p.set("category", s.category);
  if (s.within) p.set("within", s.within);
  const str = p.toString();
  return str ? `?${str}` : "";
}

/** Map list state to the list query (API params). */
export function folderQuery(
  s: ListState,
  tabsOn: boolean,
): {
  folder: MailFolder;
  drafts?: boolean;
  sequenced?: boolean;
  category?: MailCategory;
  after?: number;
  before?: number;
} {
  const d = dateQuery(s);
  const dates = {
    ...(d.after !== null && { after: d.after }),
    ...(d.before !== null && { before: d.before }),
  };
  const category =
    s.category ??
    (s.folder === "inbox" && tabsOn && !s.label && !isSearch(s)
      ? (s.tab ?? "primary")
      : undefined);
  switch (s.folder) {
    case "drafts":
      return { folder: "all", drafts: true, category, ...dates };
    case "sequenced":
      return { folder: "all", sequenced: true, category, ...dates };
    default:
      return { folder: s.folder, category, ...dates };
  }
}

/** "YYYY-MM-DD" or "" — accepts YYYY/MM/DD and YYYY-M-D too. */
export function validDay(v: string | null | undefined): string {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec((v ?? "").trim());
  if (!m) return "";
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (Number.isNaN(d.getTime()) || d.getMonth() !== +m[2] - 1) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Unix seconds at local midnight starting a "YYYY-MM-DD" day. */
export function dayStart(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Math.floor(new Date(y, m - 1, d).getTime() / 1000);
}

/**
 * The server date window for a list state: the "Any time" chip and
 * newer_than/older_than, intersected with after:/before: dates.
 * Gmail's after: is inclusive, before: exclusive (both local days).
 */
export function dateQuery(
  s: Pick<ListState, "within" | "after" | "before">,
  now: Date = new Date(),
): { after: number | null; before: number | null } {
  const w = withinRange(s.within, now);
  let after = w.after;
  let before = w.before;
  if (s.after) {
    const a = dayStart(s.after);
    after = after === null ? a : Math.max(after, a);
  }
  if (s.before) {
    const b = dayStart(s.before);
    before = before === null ? b : Math.min(before, b);
  }
  return { after, before };
}

/** Seconds window for a `within` value: [after, before] (either may be null). */
export function withinRange(
  w: Within,
  now: Date = new Date(),
): { after: number | null; before: number | null } {
  const t = Math.floor(now.getTime() / 1000);
  const day = 86400;
  switch (w) {
    case "1d":
      return { after: t - day, before: null };
    case "7d":
      return { after: t - 7 * day, before: null };
    case "1m":
      return { after: t - 31 * day, before: null };
    case "6m":
      return { after: t - 183 * day, before: null };
    case "1y":
      return { after: t - 365 * day, before: null };
    case "older1y":
      return { after: null, before: t - 365 * day };
    default:
      return { after: null, before: null };
  }
}

export const FOLDER_LABELS: Record<GmailFolder, string> = {
  inbox: "Inbox",
  starred: "Starred",
  snoozed: "Snoozed",
  sent: "Sent",
  drafts: "Drafts",
  sequenced: "Sequenced",
  archive: "Archive",
  trash: "Trash",
  all: "All mail",
};

/** "open" param: "p:<personId>" or "g:<conversationId>". */
export function parseOpen(
  v: string | null,
): { type: "person" | "group"; id: string } | null {
  if (!v) return null;
  const m = /^([pg]):(.+)$/.exec(v);
  if (!m) return null;
  return { type: m[1] === "p" ? "person" : "group", id: m[2] };
}

export function openParam(item: { type: "person" | "group"; id: string }) {
  return `${item.type === "person" ? "p" : "g"}:${item.id}`;
}

/* ── Gmail search operators ────────────────────────────────────────── */

const IN_FOLDERS: Record<string, GmailFolder> = {
  inbox: "inbox",
  archive: "archive",
  sent: "sent",
  drafts: "drafts",
  draft: "drafts",
  anywhere: "all",
  all: "all",
  snoozed: "snoozed",
  starred: "starred",
  trash: "trash",
  bin: "trash",
};

const OLDER_NEWER: Record<string, Within> = {
  "1d": "1d",
  "7d": "7d",
  "1w": "7d",
  "1m": "1m",
  "6m": "6m",
  "1y": "1y",
};

/**
 * Parse a Gmail search box query into list state. Understands from:, to:,
 * label:, subject:, is:unread|starred|snoozed, has:attachment,
 * in:inbox|archive|sent|drafts|snoozed|starred|trash|anywhere, category:,
 * after:/before:, newer_than:, older_than:. Values may be quoted. Anything
 * else stays as free text, including `is:read` (the server has no "read
 * only" filter) and negated operators like `-from:bob` (it has no exclude
 * filters either; see {@link negatedOperators}), so they are never
 * silently treated as the positive filter.
 *
 * `labels` maps label names (and addresses) to inbox addresses so
 * `label:support` finds "support@acme.com".
 */
export function parseSearchQuery(
  query: string,
  labels: Array<{ address: string; displayName?: string | null }> = [],
): ListState {
  const s: ListState = { ...EMPTY, folder: "all" };
  const words: string[] = [];
  const re = /(-?)([a-z_]+):("([^"]*)"|(\S+))|"([^"]*)"|(\S+)/gi;
  let m: RegExpExecArray | null;
  let explicitFolder = false;
  while ((m = re.exec(query))) {
    if (m[2] && m[1]) {
      // `-op:value`: excluding isn't supported, so don't apply `op:value`.
      words.push(m[0]);
      continue;
    }
    if (m[2]) {
      const op = m[2].toLowerCase();
      const value = (m[4] ?? m[5] ?? "").trim();
      const v = value.toLowerCase();
      switch (op) {
        case "from":
          s.from = value;
          continue;
        case "is":
          if (v === "unread") s.unread = true;
          else if (v === "starred") {
            s.folder = "starred";
            explicitFolder = true;
          } else if (v === "snoozed") {
            s.folder = "snoozed";
            explicitFolder = true;
          } else words.push(m[0]);
          continue;
        case "has":
          if (v === "attachment" || v === "attachments") s.attachment = true;
          else words.push(m[0]);
          continue;
        case "in":
          if (IN_FOLDERS[v]) {
            s.folder = IN_FOLDERS[v];
            explicitFolder = true;
          } else words.push(m[0]);
          continue;
        case "to":
        case "label": {
          const hit = labels.find(
            (l) =>
              l.address.toLowerCase() === v ||
              labelName(l.address, l.displayName).toLowerCase() === v ||
              l.address.toLowerCase().split("@")[0] === v,
          );
          s.label = hit?.address ?? value;
          continue;
        }
        case "category":
          if ((CATEGORIES as string[]).includes(v))
            s.category = v as MailCategory;
          else words.push(m[0]);
          continue;
        case "subject":
          s.subject = value;
          continue;
        case "after":
        case "newer": {
          const d = validDay(value);
          if (d) s.after = d;
          else words.push(m[0]);
          continue;
        }
        case "before":
        case "older": {
          const d = validDay(value);
          if (d) s.before = d;
          else words.push(m[0]);
          continue;
        }
        case "newer_than":
          if (OLDER_NEWER[v]) s.within = OLDER_NEWER[v];
          else if (relativeDay(v, 1)) s.after = relativeDay(v, 1);
          else words.push(m[0]);
          continue;
        case "older_than":
          if (v === "1y") s.within = "older1y";
          else if (relativeDay(v, 0)) s.before = relativeDay(v, 0);
          else words.push(m[0]);
          continue;
        default:
          words.push(m[0]);
          continue;
      }
    }
    words.push(m[6] !== undefined ? `"${m[6]}"` : m[0]);
  }
  s.q = words.join(" ").trim();
  if (!explicitFolder) s.folder = "all";
  return s;
}

/**
 * Negated operators (`-from:bob`) in a free-text query. Search can't
 * exclude, so the UI says so instead of showing an unexplained empty list.
 */
export function negatedOperators(q: string): string[] {
  return (
    q.match(/(?:^|\s)-[a-z_]+:("[^"]*"|\S+)/gi)?.map((t) => t.trim()) ?? []
  );
}

/** "3d" / "2m" / "1y" back from today as "YYYY-MM-DD" (or ""). */
function relativeDay(v: string, _plus: number, now: Date = new Date()): string {
  const m = /^(\d+)([dmy])$/.exec(v);
  if (!m) return "";
  const n = +m[1];
  const d = new Date(now);
  if (m[2] === "d") d.setDate(d.getDate() - n);
  else if (m[2] === "m") d.setMonth(d.getMonth() - n);
  else d.setFullYear(d.getFullYear() - n);
  return validDay(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`);
}

function quote(v: string) {
  return /\s/.test(v) ? `"${v}"` : v;
}

/** The search-box text for a list state (inverse of parseSearchQuery). */
export function stateToQuery(
  s: ListState,
  labels: Array<{ address: string; displayName?: string | null }> = [],
): string {
  const parts: string[] = [];
  if (s.from) parts.push(`from:${quote(s.from)}`);
  if (s.label) {
    const l = labels.find((x) => x.address === s.label);
    parts.push(
      `label:${quote(l ? labelName(l.address, l.displayName).toLowerCase() : s.label)}`,
    );
  }
  if (isSearch(s) || s.label) {
    if (s.folder === "starred") parts.push("is:starred");
    else if (s.folder === "snoozed") parts.push("is:snoozed");
    else if (s.folder !== "all") parts.push(`in:${s.folder}`);
  }
  if (s.unread) parts.push("is:unread");
  if (s.subject) parts.push(`subject:${quote(s.subject)}`);
  if (s.after) parts.push(`after:${s.after.replace(/-/g, "/")}`);
  if (s.before) parts.push(`before:${s.before.replace(/-/g, "/")}`);
  if (s.attachment) parts.push("has:attachment");
  if (s.category) parts.push(`category:${s.category}`);
  if (s.within === "older1y") parts.push("older_than:1y");
  else if (s.within) parts.push(`newer_than:${s.within}`);
  if (s.q) parts.push(s.q);
  return parts.join(" ");
}

/* ── Colours ───────────────────────────────────────────────────────── */

/** Stable 0..n-1 bucket for a string (avatar and label colours). */
export function colorIndex(key: string, n = 8): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % n;
}

/** First letter for an avatar: the name's, else the address's. */
export function initialOf(name: string | null | undefined, email?: string) {
  const src = (name || email || "?").trim();
  const ch = src.replace(/^["'(<]+/, "").charAt(0);
  return (ch || "?").toUpperCase();
}

/** Strip "Re:", "Fwd:" chains for the conversation heading. */
export function cleanSubject(s: string | null | undefined): string {
  const t = (s ?? "").replace(/^\s*((re|fw|fwd|aw)\s*:\s*)+/i, "").trim();
  return t || "(no subject)";
}

/** Gmail-ish short label name for an inbox address: "support@x.com" → "support". */
export function labelName(address: string, displayName?: string | null) {
  if (displayName && displayName.trim()) return displayName.trim();
  const at = address.indexOf("@");
  return at > 0 ? address.slice(0, at) : address;
}

/* ── Keyboard shortcuts ────────────────────────────────────────────── */

export type ShortcutCommand =
  | "next"
  | "prev"
  | "open"
  | "back"
  | "archive"
  | "archiveOlder"
  | "archiveNewer"
  | "star"
  | "delete"
  | "reply"
  | "replyAll"
  | "forward"
  | "compose"
  | "search"
  | "select"
  | "markRead"
  | "markUnread"
  | "snooze"
  | "undo"
  | "expandAll"
  | "collapseAll"
  | "nextMessage"
  | "prevMessage"
  | "moreActions"
  | "help"
  | "goInbox"
  | "goStarred"
  | "goSent"
  | "goDrafts"
  | "goArchive"
  | "goSnoozed"
  | "goTrash"
  | "selectAll"
  | "selectNone"
  | "selectRead"
  | "selectUnread"
  | "selectStarred"
  | "selectUnstarred";

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

export type ShortcutPrefix = "g" | "*";

const G_MAP: Record<string, ShortcutCommand> = {
  i: "goInbox",
  s: "goStarred",
  t: "goSent",
  d: "goDrafts",
  a: "goArchive",
  b: "goSnoozed",
  x: "goTrash",
};

const STAR_MAP: Record<string, ShortcutCommand> = {
  a: "selectAll",
  n: "selectNone",
  r: "selectRead",
  u: "selectUnread",
  s: "selectStarred",
  t: "selectUnstarred",
};

/**
 * Resolve a key press, given an optional pending prefix ("g" or "*").
 * Returns the command, a new prefix to wait on, or nothing.
 */
export function resolveShortcut(
  e: KeyLike,
  prefix: ShortcutPrefix | null = null,
): { cmd?: ShortcutCommand; prefix?: ShortcutPrefix } {
  if (e.metaKey || e.ctrlKey || e.altKey) return {};
  if (prefix === "g") {
    const c = G_MAP[e.key.toLowerCase()];
    return c ? { cmd: c } : {};
  }
  if (prefix === "*") {
    const c = STAR_MAP[e.key.toLowerCase()];
    return c ? { cmd: c } : {};
  }
  if (e.key === "g" && !e.shiftKey) return { prefix: "g" };
  if (e.key === "*") return { prefix: "*" };
  const cmd = shortcutFor(e);
  return cmd ? { cmd } : {};
}

/** Gmail's single-key shortcuts. Returns null for anything else. */
export function shortcutFor(e: KeyLike): ShortcutCommand | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.shiftKey) {
    switch (e.key) {
      case "I":
        return "markRead";
      case "U":
        return "markUnread";
      case "#":
        return "delete";
      case "?":
        return "help";
      case ":":
        return "collapseAll";
      case "*":
        return null;
      case "Enter":
        return null;
    }
  }
  switch (e.key) {
    case "j":
      return "next";
    case "k":
      return "prev";
    case "n":
      return "nextMessage";
    case "p":
      return "prevMessage";
    case "o":
    case "Enter":
      return "open";
    case "u":
      return "back";
    case "e":
    case "y":
      return "archive";
    case "]":
      return "archiveOlder";
    case "[":
      return "archiveNewer";
    case "s":
      return "star";
    case "#":
      return "delete";
    case "r":
      return "reply";
    case "a":
      return "replyAll";
    case "f":
      return "forward";
    case "c":
      return "compose";
    case "/":
      return "search";
    case "x":
      return "select";
    case "b":
      return "snooze";
    case "z":
      return "undo";
    case ";":
      return "expandAll";
    case ":":
      return "collapseAll";
    case ".":
    case "v":
    case "l":
      return "moreActions";
    case "?":
      return "help";
  }
  return null;
}

/** True when a key event comes from somewhere the user is typing. */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export const SHORTCUT_HELP: Array<{
  group: string;
  items: Array<{ keys: string; label: string }>;
}> = [
  {
    group: "Jumping",
    items: [
      { keys: "g then i", label: "Go to Inbox" },
      { keys: "g then s", label: "Go to Starred" },
      { keys: "g then b", label: "Go to Snoozed" },
      { keys: "g then t", label: "Go to Sent" },
      { keys: "g then d", label: "Go to Drafts" },
      { keys: "g then a", label: "Go to Archive" },
      { keys: "g then x", label: "Go to Trash" },
    ],
  },
  {
    group: "Threadlist selection",
    items: [
      { keys: "* then a", label: "Select all conversations" },
      { keys: "* then n", label: "Deselect all" },
      { keys: "* then r", label: "Select read" },
      { keys: "* then u", label: "Select unread" },
      { keys: "* then s", label: "Select starred" },
      { keys: "* then t", label: "Select unstarred" },
    ],
  },
  {
    group: "Navigation",
    items: [
      { keys: "j / k", label: "Older / newer conversation" },
      { keys: "o or Enter", label: "Open conversation" },
      { keys: "u", label: "Back to list" },
      { keys: "n / p", label: "Next / previous message" },
      { keys: "; / :", label: "Expand / collapse all messages" },
      { keys: "/", label: "Search mail" },
      { keys: "?", label: "Keyboard shortcuts" },
    ],
  },
  {
    group: "Actions",
    items: [
      { keys: "c", label: "Compose" },
      { keys: "r / a / f", label: "Reply / reply all / forward" },
      { keys: "x", label: "Select conversation" },
      { keys: "s", label: "Star / unstar" },
      { keys: "e", label: "Archive" },
      { keys: "] / [", label: "Archive and go older / newer" },
      { keys: "#", label: "Delete (to Trash)" },
      { keys: "b", label: "Snooze" },
      { keys: "Shift + I / U", label: "Mark as read / unread" },
      { keys: ". or v", label: "More actions" },
      { keys: "z", label: "Undo last action" },
      { keys: "Ctrl + Enter", label: "Send (in a reply)" },
    ],
  },
];

/** "1–50 of 230" */
export function rangeLabel(page: number, pageSize: number, total: number) {
  if (total === 0) return "0 of 0";
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);
  return `${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}`;
}

/** Recent searches (most recent first, unique, capped). */
export function pushRecent(list: string[], q: string, cap = 8): string[] {
  const t = q.trim();
  if (!t) return list;
  return [t, ...list.filter((x) => x !== t)].slice(0, cap);
}
