import { Fragment } from "react";
import { Link, useLocation } from "react-router-dom";
import { Bell, Menu, PenSquare, Search } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useNavigate } from "react-router-dom";
import { useBranding } from "@/lib/branding";
import { WebMcpStatusBadge } from "@/webmcp/WebMcpStatusBadge";
import { WEBMCP_TOOL_COUNT } from "@/webmcp/registerTools";
import { AgentToggleButton } from "@/agent/AgentPanelToggle";
import { crumbsFor } from "./nav";
import { shellStore } from "./shellStore";
import { useMailCounts } from "./useMailCounts";

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iP(hone|ad)/.test(navigator.platform);

/**
 * The 52px band above the paper: breadcrumb, search / command palette,
 * notifications and a compose button. Hamburger opens the rail on mobile.
 */
export default function TopBand({
  onMenu,
  onCompose,
}: {
  onMenu: () => void;
  onCompose: () => void;
}) {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const { webmcpEnabled } = useBranding();
  const crumbs = crumbsFor(pathname, new URLSearchParams(search));
  const { unread, outboxPending } = useMailCounts();

  return (
    <header className="pt-band">
      <button
        type="button"
        className="icb menu-btn"
        onClick={onMenu}
        aria-label="Open navigation"
      >
        <Menu size={17} />
      </button>
      <nav className="crumb" aria-label="Breadcrumb">
        {crumbs.map((c, i) => (
          <Fragment key={`${c.label}-${i}`}>
            {i > 0 && <span className="sep">/</span>}
            {c.to && i < crumbs.length - 1 ? (
              <Link to={c.to}>{c.label}</Link>
            ) : (
              <span className={i === crumbs.length - 1 ? "here" : ""}>
                {c.label}
              </span>
            )}
          </Fragment>
        ))}
      </nav>
      <button
        type="button"
        className="ask"
        onClick={() => shellStore.set({ cmdk: true })}
        aria-label="Search and jump to"
      >
        <Search size={15} />
        <span>Search, or run a command…</span>
        <kbd>{isMac ? "⌘K" : "Ctrl K"}</kbd>
      </button>
      {webmcpEnabled && <WebMcpStatusBadge toolCount={WEBMCP_TOOL_COUNT} />}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="icb" aria-label="Notifications">
            <Bell size={17} />
            {(unread > 0 || outboxPending > 0) && <span className="dot" />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <div className="px-2 pb-1.5 pt-1 font-label text-[10.5px] text-text-tertiary">
            Notifications
          </div>
          <DropdownMenuItem onSelect={() => navigate("/")}>
            <span className="flex-1">Unread conversations</span>
            <span className="tabular text-text-secondary">{unread}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate("/outbox")}>
            <span className="flex-1">Waiting in the outbox</span>
            <span className="tabular text-text-secondary">{outboxPending}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => navigate("/settings")}>
            Notification settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AgentToggleButton className="icb" />
      <button
        type="button"
        className="icb"
        onClick={onCompose}
        aria-label="New message"
        title="New message"
      >
        <PenSquare size={17} />
      </button>
    </header>
  );
}
