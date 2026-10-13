import { Link, useLocation, useParams } from "react-router-dom";
import { ChevronRight, Home } from "lucide-react";

interface Crumb {
  label: string;
  href?: string;
}

/**
 * Builds breadcrumb trail from the current pathname. Top-level routes get
 * a single crumb; edit/new sub-routes get a parent + child trail.
 */
function buildCrumbs(
  pathname: string,
  params: Record<string, string | undefined>,
): Crumb[] {
  // Inbox covers / and /inbox/:inbox/:personId — both render the same page
  if (pathname === "/" || pathname.startsWith("/inbox/")) {
    return [{ label: "Inbox" }];
  }

  if (pathname.startsWith("/mail")) {
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length <= 1) return [{ label: "Mail" }];

    const inbox = parts[1] ? decodeURIComponent(parts[1]) : "Mail";
    if (parts[2] === "f") {
      return [
        { label: "Mail", href: "/mail" },
        { label: inbox, href: `/mail/${encodeURIComponent(inbox)}/inbox` },
        { label: "Folder" },
      ];
    }

    const folderLabels: Record<string, string> = {
      inbox: "Inbox",
      starred: "Starred",
      snoozed: "Snoozed",
      sent: "Sent",
      archive: "Archive",
      junk: "Junk",
      trash: "Trash",
    };
    return [
      { label: "Mail", href: "/mail" },
      { label: folderLabels[parts[2] ?? ""] ?? "Mail" },
    ];
  }

  if (pathname.startsWith("/templates")) {
    if (pathname === "/templates") return [{ label: "Templates" }];
    if (pathname === "/templates/new")
      return [{ label: "Templates", href: "/templates" }, { label: "New" }];
    if (pathname.endsWith("/edit"))
      return [{ label: "Templates", href: "/templates" }, { label: "Edit" }];
    return [{ label: "Templates" }];
  }

  if (pathname.startsWith("/sequences")) {
    if (pathname === "/sequences") return [{ label: "Sequences" }];
    if (pathname === "/sequences/new")
      return [{ label: "Sequences", href: "/sequences" }, { label: "New" }];
    if (pathname.endsWith("/edit"))
      return [{ label: "Sequences", href: "/sequences" }, { label: "Edit" }];
    if (params.id)
      return [{ label: "Sequences", href: "/sequences" }, { label: "Detail" }];
    return [{ label: "Sequences" }];
  }

  if (pathname === "/api-keys") return [{ label: "API Keys" }];
  if (pathname === "/inboxes") return [{ label: "Inboxes" }];
  if (pathname === "/admin/users") return [{ label: "Users" }];
  if (pathname === "/settings") return [{ label: "Settings" }];

  return [];
}

export default function Breadcrumbs() {
  const { pathname } = useLocation();
  const params = useParams();
  const crumbs = buildCrumbs(pathname, params);

  // Hide on top-level pages — the page title already says where you are.
  // Only show the trail on nested routes (e.g. /templates/new, /sequences/:id/edit).
  if (crumbs.length < 2) return null;

  return (
    <div className="relative z-10">
      <nav
        aria-label="Breadcrumb"
        className="mx-auto flex h-7 max-w-[1600px] items-center px-4 pt-2 text-xs md:px-6"
      >
        <ol className="flex items-center gap-1.5">
          <li>
            <Link
              to="/"
              className="flex items-center gap-1.5 text-text-tertiary transition-colors hover:text-text-primary"
              aria-label="Home"
            >
              <Home className="h-3.5 w-3.5" />
            </Link>
          </li>
          {crumbs.map((crumb, i) => (
            <li
              key={`${crumb.label}-${i}`}
              className="flex items-center gap-1.5"
            >
              <ChevronRight className="h-3.5 w-3.5 text-text-tertiary/60" />
              {crumb.href ? (
                <Link
                  to={crumb.href}
                  className="font-light text-text-secondary transition-colors hover:text-text-primary"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span className="font-medium text-text-primary">
                  {crumb.label}
                </span>
              )}
            </li>
          ))}
        </ol>
      </nav>
    </div>
  );
}
