import { useLocation, useNavigate } from "react-router-dom";
import {
  Mail,
  FileText,
  Key,
  Users,
  PenSquare,
  LogOut,
  ListOrdered,
} from "lucide-react";
import { signOut, useSession } from "@/lib/auth-client";
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
  { icon: FileText, label: "Templates", path: "/templates" },
  { icon: ListOrdered, label: "Sequences", path: "/sequences" },
  { icon: Key, label: "API", path: "/api-keys" },
  { icon: Users, label: "Users", path: "/admin/users", adminOnly: true },
];

function SidebarButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
        active
          ? "bg-hover text-text-primary"
          : "text-text-tertiary hover:bg-hover hover:text-text-secondary"
      }`}
    >
      <Icon size={20} />
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

  function isActive(path: string) {
    if (path === "/") {
      return location.pathname === "/" || location.pathname.startsWith("/?");
    }
    return location.pathname.startsWith(path);
  }

  return (
    <div className="flex h-full w-16 flex-col items-center bg-sidebar py-3">
      {/* Logo */}
      <div className="mb-4 flex h-10 w-10 items-center justify-center text-lg font-bold text-text-primary">
        c
      </div>

      {/* Nav items */}
      <nav className="flex flex-1 flex-col items-center gap-1">
        {navItems
          .filter((item) => !item.adminOnly || session?.user?.role === "admin")
          .map((item) => (
            <SidebarButton
              key={item.path}
              icon={item.icon}
              label={item.label}
              active={isActive(item.path)}
              onClick={() => navigate(item.path)}
            />
          ))}
      </nav>

      {/* Bottom actions */}
      <div className="flex flex-col items-center gap-1">
        <SidebarButton
          icon={PenSquare}
          label="Compose"
          active={false}
          onClick={onCompose}
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              title={session?.user?.email || "Account"}
              className="flex h-10 w-10 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-hover hover:text-text-secondary"
            >
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">
                {session?.user?.name?.[0]?.toUpperCase() || "?"}
              </div>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="right"
            align="end"
            className="bg-card border-border-dark text-text-primary"
          >
            <div className="px-2 py-1.5 text-xs text-text-secondary">
              {session?.user?.email}
            </div>
            <DropdownMenuItem
              onClick={() => signOut()}
              className="text-text-secondary focus:bg-hover focus:text-text-primary"
            >
              <LogOut size={14} />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
