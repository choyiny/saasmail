import { useNavigate } from "react-router-dom";
import {
  Check,
  ChevronsUpDown,
  LogOut,
  Monitor,
  Moon,
  Palette,
  Settings as SettingsIcon,
  Sun,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOut, useSession } from "@/lib/auth-client";
import { usePreferences } from "@/lib/preferences";
import { initials } from "@/lib/avatar";
import type { ColorMode, UiTheme } from "@/lib/api";

const LAYOUTS: Array<{ id: UiTheme; label: string }> = [
  { id: "default", label: "Default" },
  { id: "gmail", label: "Gmail-style" },
  { id: "outlook", label: "Outlook-style" },
];

const MODES: Array<{ id: ColorMode; label: string; icon: typeof Sun }> = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Monitor },
];

/** The person at the foot of the rail: settings, appearance, sign out. */
export default function AccountMenu() {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const user = session?.user;
  const { uiTheme, colorMode, setPreferences } = usePreferences();

  return (
    <div className="snav-acct">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="snav-user"
            title={user?.email}
            aria-label="Account and appearance"
          >
            <span className="avatar">
              {initials(user?.name ?? null, user?.email ?? "?")}
            </span>
            <span className="su-id">
              <b>{user?.name || user?.email || "Signed in"}</b>
              <small>{user?.email}</small>
            </span>
            <ChevronsUpDown size={14} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-[80] w-[256px] max-w-[calc(100vw-24px)]"
        >
          <div className="px-2 pb-2 pt-1.5">
            <p className="truncate text-[13.5px] font-semibold text-text-primary">
              {user?.name || "Account"}
            </p>
            <p className="truncate text-xs text-text-secondary">
              {user?.email}
            </p>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => navigate("/settings")}>
            <SettingsIcon /> Settings
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Palette className="text-text-secondary" /> Appearance
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-52">
              <DropdownMenuLabel>Mail layout</DropdownMenuLabel>
              {LAYOUTS.map((l) => (
                <DropdownMenuItem
                  key={l.id}
                  onSelect={() => setPreferences({ uiTheme: l.id })}
                >
                  <span className="flex-1">{l.label}</span>
                  {uiTheme === l.id && <Check className="text-accent" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Colour mode</DropdownMenuLabel>
              {MODES.map((m) => (
                <DropdownMenuItem
                  key={m.id}
                  onSelect={() => setPreferences({ colorMode: m.id })}
                >
                  <m.icon />
                  <span className="flex-1">{m.label}</span>
                  {colorMode === m.id && <Check className="text-accent" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => navigate("/settings#appearance")}
              >
                All appearance settings
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="logout-button"
            onSelect={() => signOut()}
            className="text-destructive focus:bg-destructive-subtle focus:text-destructive [&>svg]:text-destructive"
          >
            <LogOut /> Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
