import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Ban,
  Bot,
  CircleHelp,
  FileText,
  Grid3x3,
  Inbox as InboxIcon,
  Key,
  Keyboard,
  ListOrdered,
  LogOut,
  Mail,
  Menu as MenuIcon,
  Monitor,
  Moon,
  Pencil,
  Send,
  Settings,
  ShieldBan,
  Sun,
  Users,
} from "lucide-react";
import type { ThemeShellProps } from "@/themes/types";
import {
  fetchGroupedPeople,
  fetchOutboxCount,
  fetchStats,
  type ColorMode,
  type MailCategory,
  type Stats,
} from "@/lib/api";
import { onInboxRefresh } from "@/lib/inbox-events";
import { useBranding } from "@/lib/branding";
import { signOut, useSession } from "@/lib/auth-client";
import { usePreferences } from "@/lib/preferences";
import { AgentToggleButton } from "@/agent/AgentPanelToggle";
import {
  FORK_ADMIN_LINKS,
  FORK_PAGE_TITLES,
  FORK_WORKSPACE_LINKS,
} from "@/components/shell/fork-nav";
import { cn } from "@/lib/utils";
import "./gmail.css";
import { GmailNavList, isInboxPath, labelsFrom, NavRow } from "./Nav";
import {
  EMPTY_COUNTS,
  GmailShellContext,
  useGmailView,
  useIsMobile,
  useMediaQuery,
  type GmailShellApi,
  type NavCounts,
} from "./state";
import { SearchBox } from "./Search";
import { QuickSettings } from "./QuickSettings";
import { Avatar, GmMenu, GmMenuItem, GmMenuSep, ShortcutsDialog } from "./ui";

export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <span
      className="flex flex-none items-center justify-center rounded-[8px] bg-accent text-accent-foreground"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <Mail size={Math.round(size * 0.62)} strokeWidth={2.2} />
    </span>
  );
}

function Brand() {
  const { brandName } = useBranding();
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate("/")}
      className="flex h-12 min-w-0 items-center gap-2 rounded-full pl-1 pr-3"
      aria-label={`${brandName} inbox`}
      title={brandName}
    >
      <BrandMark />
      <span className="truncate text-[22px] leading-none tracking-[-0.01em] text-text-secondary">
        {brandName}
      </span>
    </button>
  );
}

export function AccountAvatar({ size = 32 }: { size?: number }) {
  const { data: session } = useSession();
  return (
    <Avatar
      name={session?.user?.name}
      email={session?.user?.email}
      size={size}
    />
  );
}

/* ── Apps grid + account ───────────────────────────────────────────── */

function useAppItems() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";
  return [
    { to: "/templates", label: "Templates", icon: FileText },
    { to: "/sequences", label: "Sequences", icon: ListOrdered },
    { to: "/outbox", label: "Outbox", icon: Send },
    { to: "/api-keys", label: "API keys", icon: Key },
    ...FORK_WORKSPACE_LINKS.map((l) => ({ ...l, to: l.path })),
    ...(isAdmin
      ? [
          { to: "/inboxes", label: "Inboxes", icon: InboxIcon },
          { to: "/admin/users", label: "Users", icon: Users },
          { to: "/admin/suppressions", label: "Suppressions", icon: Ban },
          ...FORK_ADMIN_LINKS.map((l) => ({ ...l, to: l.path })),
        ]
      : []),
    { to: "/blocklist", label: "Blocklist", icon: ShieldBan },
    { to: "/settings", label: "Settings", icon: Settings },
  ];
}

function useSignOut() {
  const navigate = useNavigate();
  return useCallback(async () => {
    try {
      await signOut();
    } finally {
      navigate("/login");
    }
  }, [navigate]);
}

function AppsMenu() {
  const navigate = useNavigate();
  const items = useAppItems();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="gm-icon-btn"
        aria-label="Apps"
        title="Apps"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="gmail-apps"
      >
        <Grid3x3 size={22} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-12 z-50 grid w-[320px] grid-cols-3 gap-1 rounded-[24px] bg-card p-4 shadow-overlay"
        >
          {items.map((it) => {
            const Icon = it.icon;
            return (
              <button
                key={it.to}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  navigate(it.to);
                }}
                className="flex flex-col items-center gap-2 rounded-[12px] px-1 py-3 text-[13px] text-text-primary hover:bg-bg-muted"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-subtle text-accent-subtle-fg">
                  <Icon size={22} />
                </span>
                {it.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AccountMenu() {
  const { data: session } = useSession();
  const doSignOut = useSignOut();
  const navigate = useNavigate();
  const user = session?.user;
  return (
    <GmMenu
      align="end"
      trigger={
        <button
          type="button"
          className="gm-icon-btn ml-1"
          style={{ width: 48, height: 48 }}
          aria-label={`Account: ${user?.email ?? ""}`}
          title={user ? `${user.name ?? ""}\n${user.email}` : "Account"}
          data-testid="gmail-account"
        >
          <Avatar name={user?.name} email={user?.email} size={32} />
        </button>
      }
    >
      <div className="flex w-[340px] flex-col items-center gap-2 px-6 pb-3 pt-3 text-center">
        <span className="text-sm text-text-secondary">{user?.email}</span>
        <Avatar name={user?.name} email={user?.email} size={76} />
        <span className="text-[22px]">
          Hi, {user?.name?.split(" ")[0] || "there"}!
        </span>
      </div>
      <GmMenuSep />
      <GmMenuItem
        icon={<Settings size={20} />}
        onSelect={() => navigate("/settings")}
      >
        Manage your account
      </GmMenuItem>
      <GmMenuItem icon={<LogOut size={20} />} onSelect={() => void doSignOut()}>
        Sign out
      </GmMenuItem>
    </GmMenu>
  );
}

/* ── Mobile sheets ─────────────────────────────────────────────────── */

function MobileDrawer({
  stats,
  counts,
  tabsOn,
  onClose,
  onShortcuts,
  onQuickSettings,
}: {
  stats: Stats | null;
  counts: NavCounts;
  tabsOn: boolean;
  onClose: () => void;
  onShortcuts: () => void;
  onQuickSettings: () => void;
}) {
  const { brandName } = useBranding();
  const navigate = useNavigate();
  const items = useAppItems().filter(
    (i) => !["/templates", "/sequences", "/outbox", "/settings"].includes(i.to),
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="gm-scrim" onClick={onClose} aria-hidden />
      <aside
        className="gm-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        data-testid="gmail-drawer"
      >
        <div className="flex h-16 items-center gap-3 px-5">
          <BrandMark />
          <span className="truncate text-[22px] text-text-secondary">
            {brandName}
          </span>
        </div>
        <div className="mb-2 h-px bg-border" />
        <GmailNavList
          stats={stats}
          counts={counts}
          tabsOn={tabsOn}
          showCategories
          onNavigate={onClose}
          extra={
            <>
              {items.map((it) => {
                const Icon = it.icon;
                return (
                  <NavRow
                    key={it.to}
                    icon={<Icon size={20} />}
                    label={it.label}
                    onClick={() => {
                      onClose();
                      navigate(it.to);
                    }}
                  />
                );
              })}
              <div className="my-2 h-px bg-border" />
              <NavRow
                icon={<Settings size={20} />}
                label="Quick settings"
                onClick={() => {
                  onClose();
                  onQuickSettings();
                }}
                testId="gmail-drawer-quick-settings"
              />
              <NavRow
                icon={<Settings size={20} />}
                label="All settings"
                onClick={() => {
                  onClose();
                  navigate("/settings");
                }}
              />
              {/* Narrow windows can still have a keyboard (a resized desktop
                  browser, a tablet with a keyboard). */}
              <NavRow
                icon={<Keyboard size={20} />}
                label="Keyboard shortcuts"
                onClick={() => {
                  onClose();
                  onShortcuts();
                }}
              />
            </>
          }
        />
      </aside>
    </>
  );
}

function AccountSheet({ onClose }: { onClose: () => void }) {
  const { data: session } = useSession();
  const prefs = usePreferences();
  const doSignOut = useSignOut();
  const navigate = useNavigate();
  const user = session?.user;
  const modes: Array<[ColorMode, string, ReactNode]> = [
    ["light", "Light", <Sun key="l" size={18} />],
    ["dark", "Dark", <Moon key="d" size={18} />],
    ["system", "System", <Monitor key="s" size={18} />],
  ];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="gm-scrim" onClick={onClose} aria-hidden />
      <div
        className="gm-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Account"
        data-testid="gmail-account-sheet"
      >
        <div className="mx-auto mb-1 mt-3 h-1 w-8 rounded-full bg-border-strong" />
        <div className="flex items-center gap-4 px-6 py-4">
          <AccountAvatar size={44} />
          <div className="min-w-0">
            <div className="truncate text-base font-medium">
              {user?.name || "Account"}
            </div>
            <div className="truncate text-sm text-text-secondary">
              {user?.email}
            </div>
          </div>
        </div>
        <div className="px-6 pb-2">
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.08em] text-text-secondary">
            Theme
          </p>
          <div className="grid grid-cols-3 overflow-hidden rounded-full border border-border-strong">
            {modes.map(([v, l, icon]) => (
              <button
                key={v}
                type="button"
                onClick={() => void prefs.setPreferences({ colorMode: v })}
                aria-pressed={prefs.colorMode === v}
                className={cn(
                  "flex h-10 items-center justify-center gap-1.5 text-sm font-medium",
                  prefs.colorMode === v
                    ? "bg-accent-subtle text-accent-subtle-fg"
                    : "text-text-secondary",
                )}
              >
                {icon}
                {l}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-2 flex flex-col">
          <button
            type="button"
            className="flex h-14 items-center gap-6 px-6 text-left text-base hover:bg-bg-muted"
            onClick={() => {
              onClose();
              navigate("/settings");
            }}
          >
            <Settings size={22} className="text-text-secondary" />
            Manage your account
          </button>
          <button
            type="button"
            className="flex h-14 items-center gap-6 px-6 text-left text-base hover:bg-bg-muted"
            onClick={() => void doSignOut()}
            data-testid="gmail-sign-out"
          >
            <LogOut size={22} className="text-text-secondary" />
            Sign out
          </button>
        </div>
      </div>
    </>
  );
}

/* ── Shell ─────────────────────────────────────────────────────────── */

const PAGE_TITLES: Array<[string, string]> = [
  ["/templates", "Templates"],
  ["/sequences", "Sequences"],
  ["/outbox", "Outbox"],
  ["/api-keys", "API keys"],
  ["/inboxes", "Inboxes"],
  ["/admin/users", "Users"],
  ["/admin/suppressions", "Suppressions"],
  ["/blocklist", "Blocklist"],
  ["/settings", "Settings"],
  ...FORK_PAGE_TITLES,
];

export default function GmailShell({ children, onCompose }: ThemeShellProps) {
  const location = useLocation();
  const isMobile = useIsMobile();
  const isWide = useMediaQuery("(min-width: 1024px)");
  const onInbox = isInboxPath(location.pathname);
  const { brandName } = useBranding();

  const [stats, setStats] = useState<Stats | null>(null);
  const [inboxMounted, setInboxMounted] = useState(false);
  const view = useGmailView();
  // Saved to the account; null means automatic by width.
  const rail = view.railCollapsed ?? !isWide;
  const [railHover, setRailHover] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [accountSheet, setAccountSheet] = useState(false);
  const [quick, setQuick] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  const [counts, setCounts] = useState<NavCounts>(EMPTY_COUNTS);

  // Nav counts the way Gmail shows them: unread conversations in the
  // inbox (Primary when tabs are on), total drafts, pending outbox, and
  // unread per tab for the "N new" badges.
  const countsReq = useRef(0);
  const loadCounts = useCallback(() => {
    const id = ++countsReq.current;
    Promise.all([
      // One request: inbox tab counts (unread + new since last viewed).
      fetchGroupedPeople({ folder: "inbox", limit: 1, withTabCounts: true })
        .then((r) => r.tabCounts ?? null)
        .catch(() => null),
      fetchGroupedPeople({ drafts: true, limit: 1 })
        .then((r) => r.total)
        .catch(() => 0),
      fetchOutboxCount()
        .then((r) => r.pending)
        .catch(() => 0),
    ]).then(([tabs, drafts, outbox]) => {
      if (id !== countsReq.current) return;
      const cats: MailCategory[] = [
        "primary",
        "promotions",
        "social",
        "updates",
      ];
      const unread = (c: MailCategory) => tabs?.[c]?.unread ?? 0;
      setCounts({
        inboxUnread: view.tabs
          ? unread("primary")
          : cats.reduce((n, c) => n + unread(c), 0),
        drafts,
        outbox,
        categories: Object.fromEntries(cats.map((c) => [c, unread(c)])),
        categoriesNew: Object.fromEntries(
          cats.map((c) => [c, tabs?.[c]?.new ?? 0]),
        ),
      });
    });
  }, [view.tabs]);
  useEffect(() => {
    loadCounts();
    const t = window.setInterval(loadCounts, 60_000);
    return () => window.clearInterval(t);
  }, [loadCounts]);

  const loadStats = useCallback(() => {
    fetchStats()
      .then(setStats)
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadStats();
    return onInboxRefresh(() => {
      loadStats();
      loadCounts();
    });
  }, [loadStats, loadCounts]);

  // Close sheets on navigation.
  useEffect(() => {
    setDrawer(false);
    setAccountSheet(false);
  }, [location.pathname, location.search]);

  const toggleRail = () => {
    const next = !rail;
    view.update({ railCollapsed: next });
    setRailHover(false);
  };

  const api = useMemo<GmailShellApi>(
    () => ({
      openDrawer: () => setDrawer(true),
      openAccount: () => setAccountSheet(true),
      openQuickSettings: () => setQuick(true),
      focusSearch: () => searchRef.current?.focus(),
      reportStats: setStats,
      refreshCounts: loadCounts,
      openShortcuts: () => setShortcuts(true),
      setInboxMounted,
      stats,
      counts,
    }),
    [stats, counts, loadCounts],
  );

  const labels = labelsFrom(stats);
  const pageTitle =
    PAGE_TITLES.find(([p]) => location.pathname.startsWith(p))?.[1] ?? "";
  const showMobileBar = isMobile && !(onInbox && inboxMounted);

  useEffect(() => {
    if (!onInbox) {
      document.title = pageTitle ? `${pageTitle} - ${brandName}` : brandName;
    }
  }, [onInbox, pageTitle, brandName]);

  const expanded = !rail || railHover;

  return (
    <GmailShellContext.Provider value={api}>
      <div
        className="gm-root flex h-dvh flex-col overflow-hidden"
        data-testid="gmail-shell"
      >
        {!isMobile && (
          <header className="flex h-16 flex-none items-center gap-2 pl-2 pr-3">
            <div className="flex w-[232px] min-w-0 flex-none items-center gap-1">
              <button
                type="button"
                className="gm-icon-btn ml-1"
                style={{ width: 48, height: 48 }}
                aria-label="Main menu"
                title="Main menu"
                aria-expanded={!rail}
                onClick={toggleRail}
                data-testid="gmail-hamburger"
              >
                <MenuIcon size={24} />
              </button>
              <Brand />
            </div>
            <div className="flex min-w-0 flex-1 pl-2">
              <SearchBox inputRef={searchRef} labels={labels} />
            </div>
            <div className="flex flex-none items-center">
              <GmMenu
                align="end"
                trigger={
                  <button
                    type="button"
                    className="gm-icon-btn"
                    aria-label="Support"
                    title="Support"
                  >
                    <CircleHelp size={22} />
                  </button>
                }
              >
                <GmMenuItem
                  icon={<Keyboard size={20} />}
                  onSelect={() => setShortcuts(true)}
                  trailing={<kbd className="gm-kbd">?</kbd>}
                >
                  Keyboard shortcuts
                </GmMenuItem>
              </GmMenu>
              <button
                type="button"
                className="gm-icon-btn"
                aria-label="Settings"
                title="Settings"
                onClick={() => setQuick(true)}
                data-testid="gmail-settings"
              >
                <Settings size={22} />
              </button>
              <AgentToggleButton className="gm-icon-btn">
                <Bot size={22} />
              </AgentToggleButton>
              <AppsMenu />
              <AccountMenu />
            </div>
          </header>
        )}

        {showMobileBar && (
          <header className="flex flex-none items-center gap-1 px-1 pt-[env(safe-area-inset-top)]">
            <button
              type="button"
              className="gm-icon-btn"
              style={{ width: 48, height: 48 }}
              aria-label="Open navigation drawer"
              onClick={() => setDrawer(true)}
            >
              <MenuIcon size={24} />
            </button>
            <h1 className="min-w-0 flex-1 truncate text-[20px]">
              {pageTitle || brandName}
            </h1>
            <AgentToggleButton className="gm-icon-btn">
              <Bot size={22} />
            </AgentToggleButton>
            <button
              type="button"
              className="gm-icon-btn"
              style={{ width: 48, height: 48 }}
              aria-label="Account"
              onClick={() => setAccountSheet(true)}
            >
              <AccountAvatar />
            </button>
          </header>
        )}

        <div className="flex min-h-0 flex-1">
          {!isMobile && (
            <div
              className="relative flex-none"
              style={{
                width: rail ? 72 : 256,
                transition: "width 0.2s var(--sm-ease)",
              }}
            >
              <aside
                className={cn(
                  "absolute inset-y-0 left-0 z-40 flex flex-col overflow-y-auto overflow-x-hidden bg-background",
                  rail && railHover && "rounded-r-2xl shadow-overlay",
                  !expanded && "gm-rail",
                )}
                style={{
                  width: expanded ? 256 : 72,
                  transition: "width 0.2s var(--sm-ease)",
                }}
                onMouseEnter={() => {
                  if (!rail) return;
                  window.clearTimeout(hoverTimer.current);
                  hoverTimer.current = window.setTimeout(
                    () => setRailHover(true),
                    150,
                  );
                }}
                onMouseLeave={() => {
                  window.clearTimeout(hoverTimer.current);
                  setRailHover(false);
                }}
                aria-label="Navigation"
              >
                <div className="pb-4 pl-2 pt-2">
                  <button
                    type="button"
                    className="gm-compose"
                    data-collapsed={!expanded ? "true" : undefined}
                    onClick={() => onCompose()}
                    aria-label="Compose"
                    title="Compose (c)"
                    data-testid="gmail-compose"
                  >
                    <Pencil size={22} />
                    {expanded && <span>Compose</span>}
                  </button>
                </div>
                <GmailNavList
                  stats={stats}
                  counts={counts}
                  tabsOn={view.tabs}
                />
              </aside>
            </div>
          )}

          <main
            className={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col",
              !isMobile && "pb-4 pr-4",
            )}
          >
            {onInbox ? (
              children
            ) : (
              <div
                className={cn(
                  "min-h-0 flex-1 overflow-y-auto bg-card",
                  !isMobile && "rounded-2xl",
                )}
              >
                {children}
              </div>
            )}
          </main>
        </div>

        {drawer && isMobile && (
          <MobileDrawer
            stats={stats}
            counts={counts}
            tabsOn={view.tabs}
            onClose={() => setDrawer(false)}
            onShortcuts={() => setShortcuts(true)}
            onQuickSettings={() => setQuick(true)}
          />
        )}
        {accountSheet && isMobile && (
          <AccountSheet onClose={() => setAccountSheet(false)} />
        )}
        {quick && (
          <QuickSettings onClose={() => setQuick(false)} mobile={isMobile} />
        )}
        <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />
      </div>
    </GmailShellContext.Provider>
  );
}
