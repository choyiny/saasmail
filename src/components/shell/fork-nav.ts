import {
  ClipboardList,
  Mail,
  Megaphone,
  ScrollText,
  ShieldAlert,
  Users,
  Workflow,
} from "lucide-react";
import type { Crumb, PageLink } from "./nav";

/** The fork's own pages, added to every layout's navigation. */
export const FORK_WORKSPACE_LINKS: PageLink[] = [
  { id: "mail", label: "Mail", path: "/mail", icon: Mail },
  { id: "lists", label: "Lists", path: "/lists", icon: Users },
  { id: "campaigns", label: "Campaigns", path: "/campaigns", icon: Megaphone },
  {
    id: "subscribe-forms",
    label: "Subscribe forms",
    path: "/subscribe-forms",
    icon: ClipboardList,
  },
];

export const FORK_ADMIN_LINKS: PageLink[] = [
  {
    id: "automations",
    label: "Automations",
    path: "/automations",
    icon: Workflow,
    admin: true,
  },
  {
    id: "audit",
    label: "Audit log",
    path: "/admin/audit",
    icon: ScrollText,
    admin: true,
  },
  {
    id: "contacts",
    label: "Contact data",
    path: "/admin/contacts",
    icon: ShieldAlert,
    admin: true,
  },
];

/** Page titles for the fork's pages, by path. */
export const FORK_PAGE_TITLES: Array<[string, string]> = [
  ...FORK_WORKSPACE_LINKS,
  ...FORK_ADMIN_LINKS,
].map((l) => [l.path, l.label]);

/** Fork pages with a detail route (`/<base>/:id`). */
export const FORK_DETAIL_BASES = ["/lists", "/campaigns", "/subscribe-forms"];

const MAIL_FOLDER_LABELS: Record<string, string> = {
  inbox: "Inbox",
  starred: "Starred",
  snoozed: "Snoozed",
  sent: "Sent",
  archive: "Archive",
  junk: "Junk",
  trash: "Trash",
};

function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** Breadcrumbs for the /mail page, or null for any other path. */
export function forkMailCrumbs(pathname: string): Crumb[] | null {
  if (pathname !== "/mail" && !pathname.startsWith("/mail/")) return null;
  const out: Crumb[] = [{ label: "Mail", to: "/mail" }];
  const [inbox, second, third] = pathname
    .slice("/mail/".length)
    .split("/")
    .map(safeDecode);
  if (!inbox) return out;
  out.push({ label: inbox });
  if (second === "f" && third) out.push({ label: "Folder" });
  else if (second) out.push({ label: MAIL_FOLDER_LABELS[second] ?? second });
  return out;
}
