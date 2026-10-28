import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Bot,
  FileText,
  LayoutGrid,
  ListOrdered,
  LogOut,
  Mail,
  Search,
  SendHorizontal,
  Settings,
  X,
} from "lucide-react";
import type { ThemeShellProps } from "@/themes/types";
import { fetchStats, type Stats } from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import { useBranding } from "@/lib/branding";
import { cn } from "@/lib/utils";
import { OutlookProvider, useIsMobile, useOutlook } from "./context";
import SuiteHeader, { doSignOut, useAppLinks } from "./SuiteHeader";
import SettingsPanel, { SettingsBody } from "./SettingsPanel";
import FolderList, { folderHref } from "./FolderList";
import { SHORTCUT_HELP, parseFolder } from "./lib";
import { emptyTrash, markFolderRead } from "./folderOps";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./Menu";
import { Avatar, IconButton } from "./ui";
import Tooltips from "./Tooltips";
import { AgentToggleButton } from "@/agent/AgentPanelToggle";
import { FORK_PAGE_TITLES } from "@/components/shell/fork-nav";
import "./outlook.css";

export function isInboxPath(pathname: string): boolean {
  return pathname === "/" || pathname.startsWith("/inbox/");
}

/** Vertical app bar on the far left (Mail, Templates, Sequences, …). */
function AppBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const apps = useAppLinks();
  const items = [
    { label: "Mail", path: "/", icon: Mail, on: isInboxPath(pathname) },
    {
      label: "Templates",
      path: "/templates",
      icon: FileText,
      on: pathname.startsWith("/templates"),
    },
    {
      label: "Sequences",
      path: "/sequences",
      icon: ListOrdered,
      on: pathname.startsWith("/sequences"),
    },
    {
      label: "Outbox",
      path: "/outbox",
      icon: SendHorizontal,
      on: pathname.startsWith("/outbox"),
    },
  ];
  return (
    <nav aria-label="Apps" className="ol-appbar">
      {items.map((it) => (
        <button
          key={it.path}
          type="button"
          onClick={() => navigate(it.path)}
          aria-current={it.on ? "page" : undefined}
          className={cn("ol-appbar-btn", it.on && "ol-appbar-btn-on")}
          title={it.label}
        >
          <it.icon size={20} aria-hidden />
          <span className="ol-appbar-label">{it.label}</span>
        </button>
      ))}
      <Menu>
        <MenuTrigger asChild>
          <button type="button" className="ol-appbar-btn" title="More apps">
            <LayoutGrid size={20} aria-hidden />
            <span className="ol-appbar-label">More</span>
          </button>
        </MenuTrigger>
        <MenuContent side="right" align="start">
          {apps.map((a) => (
            <MenuItem
              key={a.path}
              icon={<a.icon size={16} />}
              onSelect={() => navigate(a.path)}
            >
              {a.label}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
    </nav>
  );
}

function ShortcutsDialog() {
  const { shortcutsOpen, setShortcutsOpen } = useOutlook();
  return (
    <Dialog.Root open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="ol-scrim" />
        <Dialog.Content className="ol-dialog w-[min(92vw,520px)]">
          <div className="flex items-center justify-between pb-3">
            <Dialog.Title className="text-[20px] font-semibold text-text-primary">
              Keyboard shortcuts
            </Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label="Close">
                <X size={18} />
              </IconButton>
            </Dialog.Close>
          </div>
          <Dialog.Description className="pb-3 text-[13px] text-text-secondary">
            Outlook shortcuts. On a Mac use ⌘ for Ctrl.
          </Dialog.Description>
          <dl className="grid max-h-[60dvh] grid-cols-[1fr_auto] gap-x-6 gap-y-2 overflow-y-auto text-[14px]">
            {SHORTCUT_HELP.map((s, i) => (
              <div key={s.group + s.keys} className="contents">
                {(i === 0 || SHORTCUT_HELP[i - 1].group !== s.group) && (
                  <h3 className="col-span-2 mt-2 text-[13px] font-semibold text-text-secondary">
                    {s.group}
                  </h3>
                )}
                <dt className="text-text-primary">{s.label}</dt>
                <dd>
                  <kbd className="ol-kbd">{s.keys}</kbd>
                </dd>
              </div>
            ))}
          </dl>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Mobile folder drawer (avatar button in the header opens it). */
function MobileDrawer() {
  const o = useOutlook();
  const { drawerOpen, setDrawerOpen, setMobileSearchOpen } = o;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const { data: session } = useSession();
  const [stats, setStats] = useState<Stats | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const userName = session?.user?.name || session?.user?.email || "";

  useEffect(() => {
    if (!drawerOpen) {
      setShowSettings(false);
      return;
    }
    fetchStats()
      .then(setStats)
      .catch(() => {});
  }, [drawerOpen]);

  const current = isInboxPath(pathname)
    ? {
        folder: parseFolder(params.get("folder")),
        label: params.get("label") ?? undefined,
      }
    : { folder: "inbox" as const, label: "__none__" };

  return (
    <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="ol-scrim" />
        <Dialog.Content className="ol-drawer" aria-describedby={undefined}>
          <div className="ol-drawer-rail">
            <Avatar name={userName} seed={userName} size={40} />
            <div className="flex-1" />
            <IconButton
              label="Settings"
              size="lg"
              onClick={() => setShowSettings((v) => !v)}
              className={showSettings ? "text-accent" : undefined}
            >
              <Settings size={22} />
            </IconButton>
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="ol-drawer-head">
              <Dialog.Title className="truncate text-[17px] font-semibold text-text-primary">
                {showSettings ? "Settings" : userName}
              </Dialog.Title>
              <div className="truncate text-[13px] text-text-secondary">
                {showSettings ? "Appearance and layout" : session?.user?.email}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {showSettings ? (
                <>
                  <SettingsBody onDone={() => setDrawerOpen(false)} />
                  <button
                    type="button"
                    onClick={() => void doSignOut(navigate)}
                    className="ol-folder mx-3 mb-6 text-destructive"
                  >
                    <span className="ol-folder-icon">
                      <LogOut size={18} />
                    </span>
                    Sign out
                  </button>
                </>
              ) : (
                <FolderList
                  stats={stats}
                  accountEmail={session?.user?.email ?? ""}
                  current={current}
                  touch
                  favorites={o.favorites}
                  favoritesOpen={o.favoritesOpen}
                  onFavoritesOpen={(v) => o.setLayout({ favoritesOpen: v })}
                  onToggleFavorite={o.toggleFavorite}
                  onEmptyTrash={
                    // Permanent delete is admin-only on the server.
                    session?.user?.role === "admin"
                      ? () => void emptyTrash()
                      : undefined
                  }
                  onMarkAllRead={(t) =>
                    void markFolderRead(t).then(() =>
                      fetchStats()
                        .then(setStats)
                        .catch(() => {}),
                    )
                  }
                  onSelect={(t) => {
                    setDrawerOpen(false);
                    setMobileSearchOpen(false);
                    navigate(folderHref(t));
                  }}
                  onOutbox={() => {
                    setDrawerOpen(false);
                    navigate("/outbox");
                  }}
                />
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Outlook mobile bottom tab bar. */
function MobileTabBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { setMobileSearchOpen, setDrawerOpen, mobileSearchOpen } = useOutlook();
  const tabs = [
    {
      label: "Mail",
      icon: Mail,
      on: isInboxPath(pathname) && !mobileSearchOpen,
      go: () => {
        setMobileSearchOpen(false);
        if (!isInboxPath(pathname)) navigate("/");
      },
    },
    {
      label: "Search",
      icon: Search,
      on: isInboxPath(pathname) && mobileSearchOpen,
      go: () => {
        if (!isInboxPath(pathname)) navigate("/");
        setMobileSearchOpen(true);
      },
    },
    {
      label: "Templates",
      icon: FileText,
      on: pathname.startsWith("/templates"),
      go: () => {
        setMobileSearchOpen(false);
        navigate("/templates");
      },
    },
    {
      label: "Settings",
      icon: Settings,
      on: pathname.startsWith("/settings"),
      go: () => {
        setMobileSearchOpen(false);
        navigate("/settings");
      },
    },
  ];
  return (
    <nav aria-label="Main" className="ol-tabbar">
      {tabs.map((t) => (
        <button
          key={t.label}
          type="button"
          onClick={() => {
            setDrawerOpen(false);
            t.go();
          }}
          aria-current={t.on ? "page" : undefined}
          className={cn("ol-tab", t.on && "ol-tab-on")}
        >
          <t.icon size={22} strokeWidth={t.on ? 2.2 : 1.7} aria-hidden />
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

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

function MobilePageHeader() {
  const { pathname } = useLocation();
  const { setDrawerOpen } = useOutlook();
  const { data: session } = useSession();
  const { brandName } = useBranding();
  const userName = session?.user?.name || session?.user?.email || "";
  const title =
    PAGE_TITLES.find(([p]) => pathname.startsWith(p))?.[1] ?? brandName;
  return (
    <header className="ol-m-header">
      <button
        type="button"
        className="ol-m-avatar-btn"
        aria-label="Open folders and settings"
        onClick={() => setDrawerOpen(true)}
      >
        <Avatar name={userName} seed={userName} size={32} />
      </button>
      <h1 className="ol-m-title">{title}</h1>
      <AgentToggleButton className="ol-icon-btn">
        <Bot size={20} />
      </AgentToggleButton>
    </header>
  );
}

function ShellFrame({ children }: { children: React.ReactNode }) {
  const isMobile = useIsMobile();
  const { pathname } = useLocation();
  const { hideTabBar, setSettingsOpen, setMobileSearchOpen } = useOutlook();
  const onInbox = isInboxPath(pathname);

  // The settings flyout belongs to desktop.
  useEffect(() => {
    if (isMobile) setSettingsOpen(false);
  }, [isMobile, setSettingsOpen]);

  useEffect(() => {
    if (!onInbox) setMobileSearchOpen(false);
  }, [onInbox, setMobileSearchOpen]);

  if (isMobile) {
    const full = hideTabBar && onInbox;
    return (
      <div className="ol-root ol-mobile">
        {!onInbox && <MobilePageHeader />}
        <main className={cn("ol-m-main", !onInbox && "ol-m-page")}>
          {children}
        </main>
        {!full && <MobileTabBar />}
        <MobileDrawer />
        <ShortcutsDialog />
      </div>
    );
  }

  return (
    <div className="ol-root ol-desktop">
      <SuiteHeader />
      <div className="flex min-h-0 flex-1">
        <AppBar />
        <main
          className={cn(
            "min-h-0 min-w-0 flex-1",
            onInbox ? "flex flex-col" : "ol-page",
          )}
        >
          {onInbox ? children : <div className="ol-page-card">{children}</div>}
        </main>
        <SettingsPanel />
      </div>
      <ShortcutsDialog />
      <Tooltips />
    </div>
  );
}

/**
 * Outlook (new Outlook / Outlook on the web, Fluent 2) shell: blue suite
 * header, app bar and settings flyout on desktop; avatar header, folder
 * drawer and bottom tab bar on phones.
 */
export default function OutlookShell({ children, onCompose }: ThemeShellProps) {
  return (
    <OutlookProvider onTrayCompose={onCompose}>
      <ShellFrame>{children}</ShellFrame>
    </OutlookProvider>
  );
}
