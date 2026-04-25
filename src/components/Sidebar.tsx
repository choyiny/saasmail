import { useLocation, useNavigate } from "react-router-dom";
import {
  Mail,
  FileText,
  Key,
  Settings,
  Users,
  PenSquare,
  LogOut,
  ListOrdered,
  ChevronsLeft,
  ChevronsRight,
  Bot,
  FilePen,
} from "lucide-react";
import { signOut, useSession } from "@/lib/auth-client";
import { useSidebarCollapsed } from "@/lib/useSidebarCollapsed";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface NavItem {
  icon: React.ElementType;
  label: string;
  path: string;
  adminOnly?: boolean;
}

const navItems: NavItem[] = [
  { icon: Mail, label: "Inbox", path: "/" },
  { icon: FilePen, label: "Drafts", path: "/drafts" },
  { icon: FileText, label: "Templates", path: "/templates" },
  { icon: ListOrdered, label: "Sequences", path: "/sequences" },
  { icon: Bot, label: "Agents", path: "/agents" },
  { icon: Key, label: "API", path: "/api-keys" },
  { icon: Settings, label: "Inboxes", path: "/inboxes", adminOnly: true },
  { icon: Users, label: "Users", path: "/admin/users", adminOnly: true },
];

function NavButton({
  icon: Icon,
  label,
  active,
  collapsed,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  if (collapsed) {
    return (
      <button
        onClick={onClick}
        title={label}
        className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
          active
            ? "bg-accent-subtle text-accent-subtle-fg"
            : "text-text-tertiary hover:bg-bg-muted hover:text-text-primary"
        }`}
      >
        <Icon size={18} />
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      className={`flex h-9 w-full items-center gap-3 rounded-md px-3 text-sm transition-colors ${
        active
          ? "bg-accent-subtle text-accent-subtle-fg"
          : "text-text-secondary hover:bg-bg-muted hover:text-text-primary"
      }`}
    >
      <Icon size={16} />
      <span className="truncate">{label}</span>
    </button>
  );
}

interface SidebarProps {
  onCompose: () => void;
}

export default function Sidebar({ onCompose }: SidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: session } = useSession();
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();

  function isActive(path: string) {
    if (path === "/") {
      return location.pathname === "/" || location.pathname.startsWith("/?");
    }
    return location.pathname.startsWith(path);
  }

  const widthClass = collapsed ? "w-16" : "w-56";

  return (
    <div
      className={`flex h-full flex-col border-r border-border bg-bg-subtle transition-[width] duration-150 ${widthClass}`}
    >
      {/* Header */}
      <div
        className={`flex items-center ${collapsed ? "justify-center px-0" : "px-3"} py-3`}
      >
        {collapsed ? (
          // Collapsed: crop the logo to show just the icon portion on the left.
          <div className="h-8 w-8 shrink-0 overflow-hidden">
            <img
              src="/saasmail-logo.png"
              alt="saasmail"
              className="h-8 w-auto max-w-none object-left"
            />
          </div>
        ) : (
          <img src="/saasmail-logo.png" alt="saasmail" className="h-7 w-auto" />
        )}
      </div>

      {/* Nav items */}
      <nav
        className={`flex flex-1 flex-col gap-1 ${collapsed ? "items-center px-2" : "px-2"}`}
      >
        {navItems
          .filter((item) => !item.adminOnly || session?.user?.role === "admin")
          .map((item) => (
            <NavButton
              key={item.path}
              icon={item.icon}
              label={item.label}
              active={isActive(item.path)}
              collapsed={collapsed}
              onClick={() => navigate(item.path)}
            />
          ))}

        {/* Compose (primary CTA) */}
        <div className={`mt-3 ${collapsed ? "" : "px-0"}`}>
          {collapsed ? (
            <button
              onClick={onCompose}
              title="Compose"
              className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-white shadow-sm transition-colors hover:bg-accent-hover"
            >
              <PenSquare size={18} />
            </button>
          ) : (
            <button
              onClick={onCompose}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-accent text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-hover"
            >
              <PenSquare size={16} />
              Compose
            </button>
          )}
        </div>
      </nav>

      {/* Footer */}
      <div
        className={`flex items-center border-t border-border-subtle ${
          collapsed ? "flex-col gap-1 px-2 py-2" : "justify-between px-2 py-2"
        }`}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              title={session?.user?.email || "Account"}
              className={`flex items-center gap-2 rounded-md transition-colors hover:bg-bg-muted ${
                collapsed ? "h-10 w-10 justify-center" : "h-10 flex-1 px-2"
              }`}
            >
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">
                {session?.user?.name?.[0]?.toUpperCase() || "?"}
              </div>
              {!collapsed && (
                <span className="truncate text-left text-xs text-text-secondary">
                  {session?.user?.email}
                </span>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start">
            <DropdownMenuItem
              data-testid="settings-button"
              onClick={() => navigate("/settings")}
            >
              <Settings size={14} />
              Settings
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="logout-button"
              onClick={() => signOut()}
            >
              <LogOut size={14} />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          onClick={toggleCollapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
        >
          {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
        </button>
      </div>
    </div>
  );
}
