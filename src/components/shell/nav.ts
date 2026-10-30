import {
  Archive,
  Ban,
  Clock,
  FileText,
  Inbox,
  Key,
  ListOrdered,
  Mails,
  PenLine,
  Send,
  ShieldBan,
  Star,
  Timer,
  Trash2,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { MailFolder } from "@/lib/api";
import {
  FORK_ADMIN_LINKS,
  FORK_DETAIL_BASES,
  FORK_PAGE_TITLES,
  FORK_WORKSPACE_LINKS,
  forkMailCrumbs,
} from "./fork-nav";

/** Mail views reachable from the rail. All live on `/` with URL params. */
export interface MailView {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Search params that select this view (merged onto `/`). */
  params: Record<string, string>;
}

export const MAIL_VIEWS: MailView[] = [
  { id: "inbox", label: "Inbox", icon: Inbox, params: {} },
  {
    id: "starred",
    label: "Starred",
    icon: Star,
    params: { folder: "starred" },
  },
  {
    id: "snoozed",
    label: "Snoozed",
    icon: Clock,
    params: { folder: "snoozed" },
  },
  { id: "sent", label: "Sent", icon: Send, params: { folder: "sent" } },
  { id: "drafts", label: "Drafts", icon: PenLine, params: { drafts: "1" } },
  {
    id: "sequenced",
    label: "Sequenced",
    icon: Workflow,
    params: { sequenced: "1" },
  },
  {
    id: "archive",
    label: "Archive",
    icon: Archive,
    params: { folder: "archive" },
  },
  {
    id: "trash",
    label: "Trash",
    icon: Trash2,
    params: { folder: "trash" },
  },
];

export const FOLDERS: MailFolder[] = [
  "inbox",
  "starred",
  "snoozed",
  "archive",
  "sent",
  "trash",
];

/** Parse the mail folder from the URL; anything unknown means inbox. */
export function folderFromParams(sp: URLSearchParams): MailFolder {
  const f = sp.get("folder");
  return f && (FOLDERS as string[]).includes(f) ? (f as MailFolder) : "inbox";
}

/** Which rail mail view the URL is showing. */
export function activeMailView(sp: URLSearchParams): string {
  if (sp.get("drafts") === "1" || sp.get("drafts") === "true") return "drafts";
  if (sp.get("sequenced") === "1" || sp.get("sequenced") === "true")
    return "sequenced";
  return folderFromParams(sp);
}

export function mailViewHref(view: MailView, inbox?: string | null): string {
  const qs = new URLSearchParams(view.params);
  if (inbox) qs.set("inbox", inbox);
  const s = qs.toString();
  return s ? `/?${s}` : "/";
}

export interface PageLink {
  id: string;
  label: string;
  path: string;
  icon: LucideIcon;
  admin?: boolean;
}

export const WORKSPACE_LINKS: PageLink[] = [
  { id: "templates", label: "Templates", path: "/templates", icon: FileText },
  {
    id: "sequences",
    label: "Sequences",
    path: "/sequences",
    icon: ListOrdered,
  },
  { id: "outbox", label: "Outbox", path: "/outbox", icon: Timer },
  { id: "api-keys", label: "API keys", path: "/api-keys", icon: Key },
  ...FORK_WORKSPACE_LINKS,
];

export const ADMIN_LINKS: PageLink[] = [
  {
    id: "inboxes",
    label: "Inboxes",
    path: "/inboxes",
    icon: Mails,
    admin: true,
  },
  {
    id: "users",
    label: "Users",
    path: "/admin/users",
    icon: Users,
    admin: true,
  },
  {
    id: "suppressions",
    label: "Suppressions",
    path: "/admin/suppressions",
    icon: Ban,
    admin: true,
  },
  {
    id: "blocklist",
    label: "Blocklist",
    path: "/blocklist",
    icon: ShieldBan,
    admin: true,
  },
  ...FORK_ADMIN_LINKS,
];

export interface Crumb {
  label: string;
  to?: string;
}

const PAGE_TITLES: Record<string, string> = {
  "/templates": "Templates",
  "/sequences": "Sequences",
  "/outbox": "Outbox",
  "/api-keys": "API keys",
  "/inboxes": "Inboxes",
  "/admin/users": "Users",
  "/admin/suppressions": "Suppressions",
  "/blocklist": "Blocklist",
  "/settings": "Settings",
  ...Object.fromEntries(FORK_PAGE_TITLES),
};

/** Breadcrumb trail for the top band. */
export function crumbsFor(pathname: string, sp: URLSearchParams): Crumb[] {
  const mailCrumbs = forkMailCrumbs(pathname);
  if (mailCrumbs) return mailCrumbs;
  if (pathname === "/" || pathname.startsWith("/inbox/")) {
    const view = MAIL_VIEWS.find((v) => v.id === activeMailView(sp));
    const out: Crumb[] = [{ label: "Mail", to: "/" }];
    if (sp.get("view") === "agent-plan") {
      out.push({ label: "Agent plan" });
      return out;
    }
    out.push({ label: view?.label ?? "Inbox" });
    const inbox = sp.get("inbox");
    if (inbox) out.push({ label: inbox });
    return out;
  }
  if (pathname.startsWith("/m/"))
    return [{ label: "Mail", to: "/" }, { label: "Message" }];
  for (const base of ["/templates", "/sequences", ...FORK_DETAIL_BASES]) {
    if (pathname.startsWith(base + "/")) {
      const rest = pathname.slice(base.length + 1);
      const tail =
        rest === "new" ? "New" : rest.endsWith("/edit") ? "Edit" : "Detail";
      return [
        { label: "Workspace" },
        { label: PAGE_TITLES[base], to: base },
        { label: tail },
      ];
    }
  }
  const title = PAGE_TITLES[pathname];
  if (!title) return [];
  const section = ADMIN_LINKS.some((l) => l.path === pathname)
    ? "Admin"
    : pathname === "/settings"
      ? "Account"
      : "Workspace";
  return [{ label: section }, { label: title }];
}
