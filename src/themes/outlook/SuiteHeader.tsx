import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  Ban,
  Bot,
  ChevronDown,
  FileText,
  Grid3x3,
  History,
  HelpCircle,
  Inbox as InboxIcon,
  Key,
  Keyboard,
  ListOrdered,
  LogOut,
  Search,
  Send,
  Settings,
  ShieldBan,
  Users,
  X,
} from "lucide-react";
import { fetchGroupedPeople, type GroupedItem } from "@/lib/api";
import { signOut, useSession } from "@/lib/auth-client";
import { useBranding } from "@/lib/branding";
import { itemTitle } from "@/hooks/useMailList";
import { cn } from "@/lib/utils";
import { useOutlook } from "./context";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./Menu";
import { Avatar, IconButton } from "./ui";
import { AgentToggleButton } from "@/agent/AgentPanelToggle";
import {
  FORK_ADMIN_LINKS,
  FORK_WORKSPACE_LINKS,
} from "@/components/shell/fork-nav";

/** Apps reachable from the waffle (app launcher). */
export function useAppLinks() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";
  return useMemo(
    () => [
      { label: "Templates", path: "/templates", icon: FileText },
      { label: "Sequences", path: "/sequences", icon: ListOrdered },
      { label: "Outbox", path: "/outbox", icon: Send },
      { label: "API keys", path: "/api-keys", icon: Key },
      ...FORK_WORKSPACE_LINKS,
      ...(isAdmin
        ? [
            { label: "Inboxes", path: "/inboxes", icon: InboxIcon },
            { label: "Users", path: "/admin/users", icon: Users },
            { label: "Suppressions", path: "/admin/suppressions", icon: Ban },
            ...FORK_ADMIN_LINKS,
          ]
        : []),
      { label: "Blocklist", path: "/blocklist", icon: ShieldBan },
      { label: "Settings", path: "/settings", icon: Settings },
    ],
    [isAdmin],
  );
}

export async function doSignOut(navigate: (to: string) => void) {
  try {
    await signOut();
  } finally {
    navigate("/login");
  }
}

const RECENT_KEY = "saasmail.outlook.recentSearches";
function readRecent(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(v)
      ? v.filter((x) => typeof x === "string").slice(0, 6)
      : [];
  } catch {
    return [];
  }
}
function rememberSearch(q: string) {
  try {
    const next = [q, ...readRecent().filter((r) => r !== q)].slice(0, 6);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

function SearchBox() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const onInbox =
    location.pathname === "/" || location.pathname.startsWith("/inbox/");
  const urlQ = onInbox ? (params.get("q") ?? "") : "";
  const [q, setQ] = useState(urlQ);
  const [scope, setScope] = useState<"all" | "current">(
    params.get("scope") === "current" ? "current" : "all",
  );
  const [focused, setFocused] = useState(false);
  const recent = useMemo(() => (focused ? readRecent() : []), [focused]);
  const [suggestions, setSuggestions] = useState<GroupedItem[]>([]);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => setQ(urlQ), [urlQ]);

  // Suggestions: people matching what is typed, or recent people.
  useEffect(() => {
    if (!focused) return;
    let cancelled = false;
    const t = setTimeout(
      () => {
        fetchGroupedPeople({
          folder: q.trim() ? "all" : "inbox",
          q: q.trim() || undefined,
          limit: 6,
        })
          .then((res) => !cancelled && setSuggestions(res.data))
          .catch(() => {});
      },
      q.trim() ? 180 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, focused]);

  // Ctrl+E / "/" from the inbox focuses this box.
  useEffect(() => {
    const onFocus = () => inputRef.current?.focus();
    window.addEventListener("ol:focus-search", onFocus);
    return () => window.removeEventListener("ol:focus-search", onFocus);
  }, []);

  function submit(text: string) {
    if (text.trim()) rememberSearch(text.trim());
    const next = new URLSearchParams(onInbox ? params : undefined);
    next.delete("open");
    if (text.trim()) {
      next.set("q", text.trim());
      if (scope === "current") next.set("scope", "current");
      else next.delete("scope");
    } else {
      next.delete("q");
      next.delete("scope");
    }
    navigate(`/?${next.toString()}`);
    setFocused(false);
    inputRef.current?.blur();
  }

  function openItem(it: GroupedItem) {
    navigate(`/?open=${it.type}:${encodeURIComponent(it.id)}`);
    setFocused(false);
    inputRef.current?.blur();
  }

  return (
    <div
      ref={boxRef}
      className={cn("ol-search", focused && "ol-search-focused")}
      onBlur={(e) => {
        if (!boxRef.current?.contains(e.relatedTarget as Node))
          setFocused(false);
      }}
    >
      <Search size={16} className="ol-search-icon" aria-hidden />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(-1);
        }}
        onFocus={() => setFocused(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(suggestions.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(-1, a - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (active >= 0 && suggestions[active])
              openItem(suggestions[active]);
            else submit(q);
          } else if (e.key === "Escape") {
            setFocused(false);
            inputRef.current?.blur();
          }
        }}
        placeholder="Search"
        aria-label="Search mail and people"
        role="combobox"
        aria-expanded={focused}
        aria-controls="ol-search-suggest"
        className="ol-search-input"
      />
      {q && (
        <button
          type="button"
          className="ol-search-clear"
          aria-label="Clear search"
          onClick={() => {
            setQ("");
            if (urlQ) submit("");
            inputRef.current?.focus();
          }}
        >
          <X size={14} />
        </button>
      )}
      {focused && (
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              className="ol-search-scope"
              aria-label="Search scope"
            >
              {scope === "all" ? "All folders" : "Current folder"}
              <ChevronDown size={12} aria-hidden />
            </button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuRadioGroup
              value={scope}
              onValueChange={(v) => setScope(v as "all" | "current")}
            >
              <MenuRadioItem value="all">All folders</MenuRadioItem>
              <MenuRadioItem value="current">Current folder</MenuRadioItem>
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
      )}
      {focused && (
        <div id="ol-search-suggest" role="listbox" className="ol-search-pop">
          {!q.trim() && recent.length > 0 && (
            <>
              <div className="ol-search-pop-label">Recent searches</div>
              {recent.map((r) => (
                <button
                  key={r}
                  type="button"
                  className="ol-search-item"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setQ(r);
                    submit(r);
                  }}
                >
                  <History
                    size={16}
                    className="mx-1.5 text-text-secondary"
                    aria-hidden
                  />
                  <span className="truncate text-[13px] text-text-primary">
                    {r}
                  </span>
                </button>
              ))}
            </>
          )}
          <div className="ol-search-pop-label">
            {q.trim() ? "People" : "Recent people"}
          </div>
          {suggestions.length === 0 && (
            <div className="px-4 py-3 text-[13px] text-text-secondary">
              No suggestions
            </div>
          )}
          {suggestions.map((s, i) => (
            <button
              key={`${s.type}:${s.id}`}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => openItem(s)}
              className={cn(
                "ol-search-item",
                i === active && "ol-search-item-active",
              )}
            >
              <Avatar name={itemTitle(s)} seed={itemTitle(s)} size={28} />
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-[13px] text-text-primary">
                  {itemTitle(s)}
                </span>
                <span className="block truncate text-[12px] text-text-secondary">
                  {s.type === "person" ? s.email : s.latestSubject}
                </span>
              </span>
            </button>
          ))}
          <div className="ol-search-tip">
            Tip: from:name, subject:word, hasattachments:yes, isread:no,
            isflagged:yes, folder:archive, received&gt;=2026-01-01
          </div>
          {q.trim() && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => submit(q)}
              className="ol-search-item border-t border-border"
            >
              <Search size={16} className="mx-1.5 text-accent" aria-hidden />
              <span className="text-[13px] text-text-primary">
                Search for “{q.trim()}”
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function SuiteHeader() {
  const navigate = useNavigate();
  const { brandName } = useBranding();
  const { data: session } = useSession();
  const apps = useAppLinks();
  const { setSettingsOpen, settingsOpen, setShortcutsOpen } = useOutlook();
  const userName = session?.user?.name || session?.user?.email || "";

  return (
    <header className="ol-suite" role="banner">
      <div className="flex items-center">
        <Menu>
          <MenuTrigger asChild>
            <IconButton label="App launcher" className="ol-suite-btn ol-waffle">
              <Grid3x3 size={18} />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="start" className="ol-launcher">
            <MenuLabel>Apps</MenuLabel>
            <div className="grid grid-cols-3 gap-1 p-1">
              {apps.map((a) => (
                <MenuItemTile
                  key={a.path}
                  label={a.label}
                  icon={<a.icon size={20} />}
                  onSelect={() => navigate(a.path)}
                />
              ))}
            </div>
          </MenuContent>
        </Menu>
        <button
          type="button"
          onClick={() => navigate("/")}
          className="ol-suite-brand"
        >
          {brandName}
        </button>
      </div>

      <div className="ol-suite-center">
        <SearchBox />
      </div>

      <div className="flex items-center gap-0.5">
        <AgentToggleButton className="ol-icon-btn ol-suite-btn">
          <Bot size={18} />
        </AgentToggleButton>
        <IconButton
          label="Settings"
          className={cn("ol-suite-btn", settingsOpen && "ol-suite-btn-on")}
          aria-pressed={settingsOpen}
          onClick={() => setSettingsOpen(!settingsOpen)}
        >
          <Settings size={18} />
        </IconButton>
        <Menu>
          <MenuTrigger asChild>
            <IconButton label="Help" className="ol-suite-btn">
              <HelpCircle size={18} />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem
              icon={<Keyboard size={16} />}
              onSelect={() => setShortcutsOpen(true)}
              shortcut="?"
            >
              Keyboard shortcuts
            </MenuItem>
          </MenuContent>
        </Menu>
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              className="ol-suite-me"
              aria-label="Account manager"
              title={userName}
            >
              <Avatar name={userName} seed={userName} size={32} />
            </button>
          </MenuTrigger>
          <MenuContent align="end" className="w-[300px]">
            <div className="flex items-center gap-3 px-4 py-3">
              <Avatar name={userName} seed={userName} size={48} />
              <div className="min-w-0">
                <div className="truncate text-[14px] font-semibold text-text-primary">
                  {session?.user?.name}
                </div>
                <div className="truncate text-[12px] text-text-secondary">
                  {session?.user?.email}
                </div>
              </div>
            </div>
            <MenuSeparator />
            <MenuItem
              icon={<Settings size={16} />}
              onSelect={() => navigate("/settings")}
            >
              Account settings
            </MenuItem>
            <MenuItem
              icon={<LogOut size={16} />}
              onSelect={() => void doSignOut(navigate)}
            >
              Sign out
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </header>
  );
}

function MenuItemTile({
  label,
  icon,
  onSelect,
}: {
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <MenuItem
      onSelect={onSelect}
      className="ol-launcher-tile"
      icon={<span className="ol-launcher-icon">{icon}</span>}
    >
      {label}
    </MenuItem>
  );
}
