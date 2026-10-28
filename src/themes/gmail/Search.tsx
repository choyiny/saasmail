import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Check,
  ChevronDown,
  Clock,
  Paperclip,
  Search as SearchIcon,
  SlidersHorizontal,
  User,
  X,
} from "lucide-react";
import { fetchGroupedPeople, type GroupedItem } from "@/lib/api";
import { itemTitle } from "@/hooks/useMailList";
import { cn } from "@/lib/utils";
import {
  buildListSearch,
  isSearch,
  labelName,
  parseListState,
  parseSearchQuery,
  pushRecent,
  stateToQuery,
  WITHIN_LABELS,
  type GmailFolder,
  type ListState,
  type Within,
} from "./lib";
import { readRecentSearches, writeRecentSearches } from "./state";
import { isInboxPath } from "./Nav";
import { Avatar, GmMenu, GmMenuItem, GmMenuSep } from "./ui";

export type LabelList = Array<{ address: string; displayName: string | null }>;

const ADV_EVENT = "gmail:advanced-search";
export const openAdvancedSearch = () =>
  window.dispatchEvent(new Event(ADV_EVENT));

/* ── shared hooks ──────────────────────────────────────────────────── */

export function useRecentSearches() {
  const [recent, setRecent] = useState<string[]>(readRecentSearches);
  const add = useCallback((q: string) => {
    setRecent((prev) => {
      const next = pushRecent(prev, q);
      writeRecentSearches(next);
      return next;
    });
  }, []);
  const remove = useCallback((q: string) => {
    setRecent((prev) => {
      const next = prev.filter((x) => x !== q);
      writeRecentSearches(next);
      return next;
    });
  }, []);
  return { recent, add, remove };
}

/** People whose name/address matches what is typed (debounced). */
export function usePeopleSuggestions(text: string) {
  const [people, setPeople] = useState<GroupedItem[]>([]);
  useEffect(() => {
    const t = text.trim();
    if (t.length < 1 || /:/.test(t)) {
      setPeople([]);
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(() => {
      fetchGroupedPeople({ from: t, limit: 6 })
        .then((r) => !cancelled && setPeople(r.data))
        .catch(() => {});
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [text]);
  return people;
}

export function personAddress(it: GroupedItem): string {
  return it.type === "person" ? it.email : (it.participants[0]?.email ?? "");
}

/** Navigate to a search built from the text in the box. */
export function useRunSearch(labels: LabelList) {
  const navigate = useNavigate();
  const { add } = useRecentSearches();
  return useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) {
        navigate("/");
        return;
      }
      add(t);
      navigate(`/${buildListSearch(parseSearchQuery(t, labels))}`);
    },
    [navigate, add, labels],
  );
}

/* ── desktop search box ────────────────────────────────────────────── */

type Suggestion =
  | { kind: "search"; text: string }
  | { kind: "recent"; text: string }
  | { kind: "person"; item: GroupedItem };

export function SearchBox({
  inputRef,
  labels,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  labels: LabelList;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const state = parseListState(new URLSearchParams(location.search));
  const current =
    isInboxPath(location.pathname) && (isSearch(state) || state.label)
      ? stateToQuery(state, labels)
      : "";
  const [value, setValue] = useState(current);
  const [focused, setFocused] = useState(false);
  const [panel, setPanel] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { recent, remove } = useRecentSearches();
  const people = usePeopleSuggestions(focused ? value : "");
  const run = useRunSearch(labels);

  useEffect(() => {
    setValue(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search, location.pathname]);

  useEffect(() => {
    const on = () => setPanel(true);
    window.addEventListener(ADV_EVENT, on);
    return () => window.removeEventListener(ADV_EVENT, on);
  }, []);

  useEffect(() => {
    if (!panel && !focused) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setPanel(false);
        setFocused(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [panel, focused]);

  const t = value.trim().toLowerCase();
  const suggestions: Suggestion[] = [];
  if (focused && !panel) {
    if (t) suggestions.push({ kind: "search", text: value.trim() });
    for (const r of recent
      .filter((r) => !t || r.toLowerCase().includes(t))
      .slice(0, t ? 3 : 6))
      if (r.toLowerCase() !== t) suggestions.push({ kind: "recent", text: r });
    for (const p of people.slice(0, 5))
      suggestions.push({ kind: "person", item: p });
  }

  const choose = (s: Suggestion) => {
    setFocused(false);
    inputRef.current?.blur();
    if (s.kind === "person") {
      const addr = personAddress(s.item);
      run(`from:${addr}`);
    } else {
      run(s.text);
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setFocused(false);
      inputRef.current?.blur();
      return;
    }
    if (!suggestions.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (c + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (c <= 0 ? suggestions.length - 1 : c - 1));
    } else if (e.key === "Enter" && cursor >= 0 && suggestions[cursor]) {
      e.preventDefault();
      choose(suggestions[cursor]);
    }
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setFocused(false);
    inputRef.current?.blur();
    run(value);
  };

  const open = focused || panel;

  return (
    <div ref={wrapRef} className="relative w-full max-w-[720px]">
      <form
        onSubmit={submit}
        className="gm-search"
        data-open={
          open && (panel || suggestions.length > 0) ? "true" : undefined
        }
        role="search"
      >
        <button
          type="submit"
          className="gm-icon-btn mx-1"
          aria-label="Search mail"
          title="Search"
        >
          <SearchIcon size={20} />
        </button>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setCursor(-1);
          }}
          onFocus={() => {
            setFocused(true);
            setPanel(false);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search mail"
          aria-label="Search mail"
          aria-autocomplete="list"
          aria-expanded={suggestions.length > 0}
          aria-controls="gm-search-suggestions"
          data-testid="gmail-search"
          autoComplete="off"
          spellCheck={false}
        />
        {value && (
          <button
            type="button"
            className="gm-icon-btn"
            aria-label="Clear search"
            title="Clear search"
            onClick={() => {
              setValue("");
              inputRef.current?.focus();
            }}
          >
            <X size={20} />
          </button>
        )}
        <button
          type="button"
          className="gm-icon-btn mr-1"
          aria-label="Show search options"
          title="Show search options"
          aria-expanded={panel}
          onClick={() => {
            setPanel((p) => !p);
            setFocused(false);
          }}
          data-testid="gmail-search-options"
        >
          <SlidersHorizontal size={20} />
        </button>
      </form>

      {suggestions.length > 0 && (
        <ul
          id="gm-search-suggestions"
          role="listbox"
          className="absolute left-0 right-0 top-[48px] z-50 rounded-b-[24px] bg-card pb-3 pt-1 shadow-overlay"
          data-testid="gmail-search-suggestions"
        >
          {suggestions.map((s, i) => (
            <li
              key={
                s.kind === "person" ? `p:${s.item.id}` : `${s.kind}:${s.text}`
              }
              role="option"
              aria-selected={i === cursor}
              className={cn(
                "group flex h-10 cursor-pointer items-center gap-4 px-4 text-sm",
                i === cursor ? "bg-bg-muted" : "hover:bg-bg-subtle",
              )}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(s);
              }}
              onMouseEnter={() => setCursor(i)}
            >
              {s.kind === "person" ? (
                <>
                  <Avatar
                    name={
                      s.item.type === "person" ? s.item.name : itemTitle(s.item)
                    }
                    email={personAddress(s.item)}
                    size={28}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{itemTitle(s.item)}</span>{" "}
                    <span className="text-text-secondary">
                      {personAddress(s.item)}
                    </span>
                  </span>
                </>
              ) : (
                <>
                  <span className="flex w-7 justify-center text-text-secondary">
                    {s.kind === "recent" ? (
                      <Clock size={18} />
                    ) : (
                      <SearchIcon size={18} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{s.text}</span>
                  {s.kind === "recent" && (
                    <button
                      type="button"
                      className="gm-icon-btn gm-xs opacity-0 group-hover:opacity-100"
                      aria-label={`Remove ${s.text} from recent searches`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        remove(s.text);
                      }}
                    >
                      <X size={16} />
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {panel && (
        <AdvancedSearch
          labels={labels}
          initial={state}
          onClose={() => setPanel(false)}
          onSearch={(s) => {
            setPanel(false);
            const q = stateToQuery(s, labels);
            if (q) writeRecentSearches(pushRecent(readRecentSearches(), q));
            navigate(`/${buildListSearch(s)}`);
          }}
        />
      )}
    </div>
  );
}

function AdvancedSearch({
  labels,
  initial,
  onClose,
  onSearch,
}: {
  labels: LabelList;
  initial: ListState;
  onClose: () => void;
  onSearch: (s: ListState) => void;
}) {
  const [s, setS] = useState<ListState>(() =>
    isSearch(initial) || initial.label
      ? initial
      : { ...initial, folder: "all" },
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const field =
    "h-8 min-w-0 flex-1 border-0 border-b border-border-strong bg-transparent text-text-primary outline-none focus:border-b-2 focus:border-accent";
  const row = "mb-3 flex items-end gap-4";
  const lbl = "w-32 flex-none pb-1";
  const folders: Array<[GmailFolder, string]> = [
    ["all", "All Mail"],
    ["inbox", "Inbox"],
    ["starred", "Starred"],
    ["snoozed", "Snoozed"],
    ["sent", "Sent Mail"],
    ["drafts", "Drafts"],
    ["archive", "Archive"],
    ["trash", "Trash"],
  ];
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(s);
      }}
      className="absolute left-0 right-0 top-[52px] z-50 rounded-[8px] bg-card px-6 pb-4 pt-5 text-sm text-text-primary shadow-overlay"
      aria-label="Search options"
      data-testid="gmail-advanced-search"
    >
      <label className={row}>
        <span className={lbl}>From</span>
        <input
          autoFocus
          value={s.from}
          onChange={(e) => setS({ ...s, from: e.target.value })}
          className={field}
        />
      </label>
      <label className={row}>
        <span className={lbl}>To (inbox)</span>
        <select
          value={s.label ?? ""}
          onChange={(e) => setS({ ...s, label: e.target.value || null })}
          className={cn(field, "bg-card")}
        >
          <option value="">Any inbox</option>
          {labels.map((l) => (
            <option key={l.address} value={l.address}>
              {labelName(l.address, l.displayName)} ({l.address})
            </option>
          ))}
        </select>
      </label>
      <label className={row}>
        <span className={lbl}>Has the words</span>
        <input
          value={s.q}
          onChange={(e) => setS({ ...s, q: e.target.value })}
          className={field}
        />
      </label>
      <label className={row}>
        <span className={lbl}>Subject</span>
        <input
          value={s.subject}
          onChange={(e) => setS({ ...s, subject: e.target.value })}
          className={field}
        />
      </label>
      <div className={row}>
        <span className={lbl}>Dates</span>
        <label className="flex min-w-0 flex-1 items-end gap-2">
          <span className="pb-1 text-text-secondary">After</span>
          <input
            type="date"
            value={s.after}
            onChange={(e) => setS({ ...s, after: e.target.value })}
            className={field}
            aria-label="After date"
          />
        </label>
        <label className="flex min-w-0 flex-1 items-end gap-2">
          <span className="pb-1 text-text-secondary">Before</span>
          <input
            type="date"
            value={s.before}
            onChange={(e) => setS({ ...s, before: e.target.value })}
            className={field}
            aria-label="Before date"
          />
        </label>
      </div>
      <label className={row}>
        <span className={lbl}>Date within</span>
        <select
          value={s.within}
          onChange={(e) => setS({ ...s, within: e.target.value as Within })}
          className={cn(field, "bg-card")}
        >
          {(Object.keys(WITHIN_LABELS) as Within[]).map((w) => (
            <option key={w} value={w}>
              {WITHIN_LABELS[w]}
            </option>
          ))}
        </select>
      </label>
      <label className={row}>
        <span className={lbl}>Search</span>
        <select
          value={s.folder}
          onChange={(e) =>
            setS({ ...s, folder: e.target.value as GmailFolder })
          }
          className={cn(field, "bg-card")}
        >
          {folders.map(([f, l]) => (
            <option key={f} value={f}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <div className="mt-4 flex flex-wrap gap-6">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            className="gm-check"
            checked={s.attachment}
            onChange={(e) => setS({ ...s, attachment: e.target.checked })}
          />
          Has attachment
        </label>
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            className="gm-check"
            checked={s.unread}
            onChange={(e) => setS({ ...s, unread: e.target.checked })}
          />
          Unread only
        </label>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={() =>
            setS({
              ...initial,
              folder: "all",
              q: "",
              from: "",
              label: null,
              unread: false,
              attachment: false,
              subject: "",
              after: "",
              before: "",
              within: "",
              category: null,
            })
          }
          className="h-9 rounded-full px-4 text-sm font-medium text-text-secondary hover:bg-bg-muted"
        >
          Clear filter
        </button>
        <button
          type="submit"
          className="h-9 rounded-full bg-accent px-6 text-sm font-medium text-accent-foreground hover:bg-accent-hover"
        >
          Search
        </button>
      </div>
    </form>
  );
}

/* ── search chips (under the search bar, above results) ────────────── */

type ChipProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  menu?: boolean;
  testId?: string;
};

const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { active, children, menu, testId, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      className="gm-filter-chip"
      data-active={active ? "true" : undefined}
      aria-pressed={menu ? undefined : !!active}
      data-testid={testId}
    >
      {active && !menu && <Check size={16} />}
      {children}
      {menu && <ChevronDown size={16} />}
    </button>
  );
});

/**
 * Gmail's search chips: From, Any time, Has attachment, To, Is unread and
 * Advanced search. They edit the URL state directly.
 */
export function SearchChips({
  state,
  labels,
  senders,
  onChange,
  compact,
}: {
  state: ListState;
  labels: LabelList;
  /** Senders seen in the current results, for the From menu. */
  senders: GroupedItem[];
  onChange: (s: ListState) => void;
  compact?: boolean;
}) {
  const [fromText, setFromText] = useState("");
  const [fromOpen, setFromOpen] = useState(false);
  const set = (patch: Partial<ListState>) => onChange({ ...state, ...patch });
  const fromLabel = state.from ? `From: ${state.from}` : "From";
  const toLabel = state.label
    ? `To: ${labelName(state.label, labels.find((l) => l.address === state.label)?.displayName)}`
    : "To";
  const uniqSenders: GroupedItem[] = [];
  const seen = new Set<string>();
  for (const s of senders) {
    const a = personAddress(s);
    if (!a || seen.has(a)) continue;
    seen.add(a);
    uniqSenders.push(s);
    if (uniqSenders.length >= 8) break;
  }
  return (
    <div
      className={cn(
        "flex flex-none items-center gap-2 overflow-x-auto",
        compact ? "px-4 py-2" : "px-4 pb-2 pt-1",
      )}
      role="toolbar"
      aria-label="Search filters"
      data-testid="gmail-search-chips"
    >
      <GmMenu
        open={fromOpen}
        onOpenChange={setFromOpen}
        trigger={
          <Chip active={!!state.from} menu testId="gmail-chip-from">
            {state.from && <User size={16} />}
            <span className="max-w-[180px] truncate">{fromLabel}</span>
          </Chip>
        }
      >
        <div className="px-3 pb-2 pt-1">
          <input
            value={fromText}
            onChange={(e) => setFromText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && fromText.trim()) {
                set({ from: fromText.trim() });
                setFromOpen(false);
              }
            }}
            placeholder="Type a name or email"
            className="h-9 w-full rounded-[4px] border border-border-strong bg-transparent px-2 text-sm outline-none focus:border-accent"
            aria-label="Sender"
          />
        </div>
        {uniqSenders.map((s) => (
          <GmMenuItem
            key={personAddress(s)}
            icon={
              <Avatar name={itemTitle(s)} email={personAddress(s)} size={24} />
            }
            onSelect={() => set({ from: personAddress(s) })}
          >
            <span className="block max-w-[240px] truncate">
              {itemTitle(s)}{" "}
              <span className="text-text-secondary">{personAddress(s)}</span>
            </span>
          </GmMenuItem>
        ))}
        {state.from && (
          <>
            <GmMenuSep />
            <GmMenuItem onSelect={() => set({ from: "" })}>Clear</GmMenuItem>
          </>
        )}
      </GmMenu>

      <GmMenu
        trigger={
          <Chip active={!!state.within} menu testId="gmail-chip-time">
            {WITHIN_LABELS[state.within]}
          </Chip>
        }
      >
        {(Object.keys(WITHIN_LABELS) as Within[]).map((w) => (
          <GmMenuItem
            key={w || "any"}
            icon={
              <Check
                size={16}
                className={state.within === w ? undefined : "invisible"}
              />
            }
            onSelect={() => set({ within: w })}
          >
            {WITHIN_LABELS[w]}
          </GmMenuItem>
        ))}
      </GmMenu>

      <Chip
        active={state.attachment}
        onClick={() => set({ attachment: !state.attachment })}
        testId="gmail-chip-attachment"
      >
        {!state.attachment && <Paperclip size={16} />}
        Has attachment
      </Chip>

      <GmMenu
        trigger={
          <Chip active={!!state.label} menu testId="gmail-chip-to">
            {toLabel}
          </Chip>
        }
      >
        <GmMenuItem
          icon={
            <Check
              size={16}
              className={state.label ? "invisible" : undefined}
            />
          }
          onSelect={() => set({ label: null })}
        >
          Any inbox
        </GmMenuItem>
        {labels.map((l) => (
          <GmMenuItem
            key={l.address}
            icon={
              <Check
                size={16}
                className={state.label === l.address ? undefined : "invisible"}
              />
            }
            onSelect={() => set({ label: l.address })}
          >
            {labelName(l.address, l.displayName)}{" "}
            <span className="text-text-secondary">{l.address}</span>
          </GmMenuItem>
        ))}
      </GmMenu>

      <Chip
        active={state.unread}
        onClick={() => set({ unread: !state.unread })}
        testId="gmail-chip-unread"
      >
        Is unread
      </Chip>

      {!compact && (
        <button
          type="button"
          className="ml-1 whitespace-nowrap px-2 text-sm font-medium text-accent hover:underline"
          onClick={openAdvancedSearch}
        >
          Advanced search
        </button>
      )}
    </div>
  );
}
