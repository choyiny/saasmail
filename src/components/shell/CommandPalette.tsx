import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  CornerDownLeft,
  FilePlus2,
  Keyboard,
  ListPlus,
  Mails,
  Moon,
  Palette,
  PenSquare,
  Search,
  Settings as SettingsIcon,
  Sun,
  User,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { usePreferences } from "@/lib/preferences";
import { useSession } from "@/lib/auth-client";
import { fetchGroupedPeople, type GroupedItem } from "@/lib/api";
import { ADMIN_LINKS, MAIL_VIEWS, WORKSPACE_LINKS, mailViewHref } from "./nav";
import { shellStore, useShell } from "./shellStore";

interface Entry {
  key: string;
  group: "Actions" | "Pages" | "People";
  label: string;
  meta?: string;
  icon: LucideIcon;
  run: () => void;
}

/**
 * ⌘K palette: jump to any page or mail view, and search people by name or
 * address. Opens from the top band's search button or the shortcut.
 */
export default function CommandPalette({
  onCompose,
}: {
  onCompose?: () => void;
}) {
  const open = useShell((s) => s.cmdk);
  if (!open) return null;
  return createPortal(<Palette_ onCompose={onCompose} />, document.body);
}

function Palette_({ onCompose }: { onCompose?: () => void }) {
  const { resolvedMode, setPreferences } = usePreferences();
  const navigate = useNavigate();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";
  const [q, setQ] = useState("");
  const [people, setPeople] = useState<GroupedItem[]>([]);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => shellStore.set({ cmdk: false });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setPeople([]);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      fetchGroupedPeople({ q: term, limit: 8, folder: "all" })
        .then((r) => alive && setPeople(r.data))
        .catch(() => alive && setPeople([]));
    }, 160);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);

  const entries = useMemo<Entry[]>(() => {
    const go = (to: string) => () => {
      close();
      navigate(to);
    };
    const pages: Entry[] = [
      ...MAIL_VIEWS.map((v) => ({
        key: `mail:${v.id}`,
        group: "Pages" as const,
        label: v.label,
        meta: "Mail",
        icon: v.icon,
        run: go(mailViewHref(v)),
      })),
      ...WORKSPACE_LINKS.map((l) => ({
        key: l.id,
        group: "Pages" as const,
        label: l.label,
        meta: "Workspace",
        icon: l.icon,
        run: go(l.path),
      })),
      ...ADMIN_LINKS.filter((l) => isAdmin || l.id === "blocklist").map(
        (l) => ({
          key: l.id,
          group: "Pages" as const,
          label: l.label,
          meta: isAdmin ? "Admin" : "Workspace",
          icon: l.icon,
          run: go(l.path),
        }),
      ),
      {
        key: "settings",
        group: "Pages",
        label: "Settings",
        meta: "Account",
        icon: SettingsIcon,
        run: go("/settings"),
      },
      {
        key: "appearance",
        group: "Pages",
        label: "Appearance",
        meta: "Settings",
        icon: Palette,
        run: go("/settings#appearance"),
      },
    ];
    const act = (fn: () => void) => () => {
      close();
      fn();
    };
    const actions: Entry[] = [
      ...(onCompose
        ? [
            {
              key: "a:compose",
              group: "Actions" as const,
              label: "New message",
              meta: "C",
              icon: PenSquare,
              run: act(onCompose),
            },
          ]
        : []),
      {
        key: "a:template",
        group: "Actions",
        label: "New template",
        icon: FilePlus2,
        run: go("/templates/new"),
      },
      {
        key: "a:sequence",
        group: "Actions",
        label: "New sequence",
        icon: ListPlus,
        run: go("/sequences/new"),
      },
      ...(isAdmin
        ? [
            {
              key: "a:invite",
              group: "Actions" as const,
              label: "Invite a teammate",
              icon: UserPlus,
              run: go("/admin/users?invite=1"),
            },
            {
              key: "a:connect",
              group: "Actions" as const,
              label: "Connect an inbox",
              icon: Mails,
              run: go("/inboxes"),
            },
          ]
        : []),
      {
        key: "a:mode",
        group: "Actions",
        label:
          resolvedMode === "dark"
            ? "Switch to light mode"
            : "Switch to dark mode",
        meta: "Appearance",
        icon: resolvedMode === "dark" ? Sun : Moon,
        run: act(() => {
          void setPreferences({
            colorMode: resolvedMode === "dark" ? "light" : "dark",
          });
        }),
      },
      {
        key: "a:keys",
        group: "Actions",
        label: "Keyboard shortcuts",
        meta: "?",
        icon: Keyboard,
        run: act(() => shellStore.set({ keys: true })),
      },
    ];
    const term = q.trim().toLowerCase();
    const matches = (p: Entry) =>
      p.label.toLowerCase().includes(term) ||
      (p.meta ?? "").toLowerCase().includes(term);
    const matchedPages = term ? pages.filter(matches) : pages;
    const matchedActions = term ? actions.filter(matches) : actions;
    const peopleEntries: Entry[] = people.map((it) =>
      it.type === "person"
        ? {
            key: `p:${it.id}`,
            group: "People",
            label: it.name || it.email,
            meta: it.name ? it.email : undefined,
            icon: User,
            run: go(`/inbox/all/${it.id}`),
          }
        : {
            key: `g:${it.id}`,
            group: "People",
            label: it.participants
              .map((p) => p.name || p.email)
              .slice(0, 3)
              .join(", "),
            meta: it.inbox,
            icon: Users,
            run: go(`/?q=${encodeURIComponent(q.trim())}`),
          },
    );
    return [...peopleEntries, ...matchedActions, ...matchedPages];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, people, isAdmin, navigate, onCompose, resolvedMode]);

  useEffect(() => setSel(0), [q, people]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${sel}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(entries.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      entries[sel]?.run();
    }
  }

  let idx = -1;
  const groups: Array<Entry["group"]> = ["People", "Actions", "Pages"];

  return (
    <>
      <div className="pt-cmd-scrim" onClick={close} />
      <div
        className="pt-cmd"
        role="dialog"
        aria-modal="true"
        aria-label="Search and jump to"
        onKeyDown={onKey}
      >
        <div className="pt-cmd-input">
          <Search size={17} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search people, run a command, or jump to a page…"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="pt-cmd-list"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="pt-cmd-list" id="pt-cmd-list" ref={listRef}>
          {entries.length === 0 ? (
            <div className="pt-cmd-empty">
              {q.trim().length >= 2
                ? `Nothing matches “${q.trim()}”.`
                : "Type to search."}
            </div>
          ) : (
            groups.map((g) => {
              const rows = entries.filter((e) => e.group === g);
              if (rows.length === 0) return null;
              return (
                <div key={g} role="group" aria-label={g}>
                  <div className="pt-cmd-group">{g}</div>
                  {rows.map((e) => {
                    idx += 1;
                    const i = idx;
                    const Icon = e.icon;
                    return (
                      <button
                        type="button"
                        key={e.key}
                        data-idx={i}
                        className="pt-cmd-item"
                        data-selected={i === sel}
                        onMouseMove={() => setSel(i)}
                        onClick={e.run}
                      >
                        <span className="ic">
                          <Icon size={16} />
                        </span>
                        <span className="nm">{e.label}</span>
                        {e.meta && <span className="meta">{e.meta}</span>}
                        <CornerDownLeft size={14} className="enter" />
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
        <div className="pt-cmd-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>↵</kbd> to open
          </span>
          <span>
            <kbd>Esc</kbd> to close
          </span>
        </div>
      </div>
    </>
  );
}
