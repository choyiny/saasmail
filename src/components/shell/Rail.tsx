import { Link, NavLink, useLocation } from "react-router-dom";
import { Mail, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { useBranding } from "@/lib/branding";
import {
  ADMIN_LINKS,
  MAIL_VIEWS,
  WORKSPACE_LINKS,
  activeMailView,
  mailViewHref,
  type PageLink,
} from "./nav";
import { useDefaultLayoutSettings } from "@/lib/default-layout-settings";
import { useMailCounts } from "./useMailCounts";
import AccountMenu from "./AccountMenu";

function fmt(n: number) {
  return n > 99 ? "99+" : String(n);
}

/**
 * The portal rail: brand, mail views (with the inbox addresses as
 * sub-items), workspace and admin pages, collapse toggle and the account
 * menu. At 900px and below it is an off-canvas drawer (PortalShell).
 */
export default function Rail({ drawer }: { drawer: boolean }) {
  const { brandName } = useBranding();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";
  const [{ railCollapsed }, setLayout] = useDefaultLayoutSettings();
  const shut = railCollapsed && !drawer;
  const { pathname, search } = useLocation();
  const sp = new URLSearchParams(search);
  const onMail = pathname === "/" || pathname.startsWith("/inbox/");
  const view = onMail ? activeMailView(sp) : null;
  const inboxParam = sp.get("inbox");
  const { unread, inboxes, outboxPending } = useMailCounts();

  const pageItem = (l: PageLink, badge?: number) => {
    const Icon = l.icon;
    return (
      <NavLink
        key={l.id}
        to={l.path}
        title={shut ? l.label : undefined}
        className={({ isActive }) => `snav-item${isActive ? " on" : ""}`}
      >
        <span className="snav-ic">
          <Icon size={15} />
        </span>
        <span className="snav-nm">{l.label}</span>
        {badge != null && badge > 0 && (
          <>
            <span className="badge warn" aria-label={`${badge} pending`}>
              {fmt(badge)}
            </span>
            <span className="snav-dot" />
          </>
        )}
      </NavLink>
    );
  };

  const workspace = isAdmin
    ? WORKSPACE_LINKS
    : [...WORKSPACE_LINKS, ...ADMIN_LINKS.filter((l) => l.id === "blocklist")];

  return (
    <aside
      className={`snav${shut ? " shut" : ""}`}
      aria-label="Main navigation"
      data-testid="portal-rail"
    >
      <Link to="/" className="snav-brand" title={brandName}>
        <span className="brand-mark" aria-hidden>
          <Mail size={14} strokeWidth={2.4} />
        </span>
        <span className="brand-wordmark">{brandName}</span>
      </Link>

      <nav className="snav-list">
        <div className="snav-sec">
          <div className="snav-head">Mail</div>
          {MAIL_VIEWS.map((v) => {
            const Icon = v.icon;
            const on = view === v.id;
            return (
              <div key={v.id}>
                <Link
                  to={mailViewHref(v)}
                  title={shut ? v.label : undefined}
                  className={`snav-item${on && !(v.id === "inbox" && inboxParam) ? " on" : ""}`}
                  aria-current={on ? "page" : undefined}
                >
                  <span className="snav-ic">
                    <Icon size={15} />
                  </span>
                  <span className="snav-nm">{v.label}</span>
                  {v.id === "inbox" && unread > 0 && (
                    <>
                      <span className="badge" aria-label={`${unread} unread`}>
                        {fmt(unread)}
                      </span>
                      <span className="snav-dot" />
                    </>
                  )}
                </Link>
                {v.id === "inbox" && view === "inbox" && inboxes.length > 1 && (
                  <div className="snav-sub">
                    {inboxes.map((ib) => (
                      <Link
                        key={ib.email}
                        to={mailViewHref(v, ib.email)}
                        className={
                          view === "inbox" && inboxParam === ib.email
                            ? "on"
                            : ""
                        }
                        title={ib.email}
                      >
                        <span>{ib.displayName || ib.email.split("@")[0]}</span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="snav-sec">
          <div className="snav-head">Workspace</div>
          {workspace.map((l) =>
            pageItem(l, l.id === "outbox" ? outboxPending : undefined),
          )}
        </div>

        {isAdmin && (
          <div className="snav-sec">
            <div className="snav-head">Admin</div>
            {ADMIN_LINKS.map((l) => pageItem(l))}
          </div>
        )}
      </nav>

      <div className="snav-fold-row">
        <button
          type="button"
          className="snav-fold"
          onClick={() => setLayout({ railCollapsed: !shut })}
          aria-label={shut ? "Expand sidebar" : "Collapse sidebar"}
          title={shut ? "Expand sidebar" : "Collapse sidebar"}
        >
          {shut ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          <span>Collapse</span>
        </button>
      </div>

      <AccountMenu />
    </aside>
  );
}
