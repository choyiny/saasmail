import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Clock, Search as SearchIcon, X } from "lucide-react";
import type { MailCategory } from "@/lib/api";
import { itemTitle } from "@/hooks/useMailList";
import { cn } from "@/lib/utils";
import { CATEGORY_LABELS, type ListState } from "./lib";
import { CATEGORY_ICONS } from "./Nav";
import {
  personAddress,
  usePeopleSuggestions,
  useRecentSearches,
  useRunSearch,
  type LabelList,
} from "./Search";
import { Avatar } from "./ui";

/**
 * The Gmail app's search screen: a full-screen sheet with the query box,
 * quick filter chips, recent searches and matching people.
 */
export function MobileSearchScreen({
  initial,
  labels,
  onClose,
}: {
  initial: string;
  labels: LabelList;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const { recent, remove } = useRecentSearches();
  const people = usePeopleSuggestions(text);
  const run = useRunSearch(labels);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const go = (q: string) => {
    run(q);
    onClose();
  };
  const addToken = (token: string) => {
    const next = text.includes(token) ? text : `${text} ${token}`.trim();
    go(next);
  };

  const shownRecent = recent
    .filter((r) => !text.trim() || r.toLowerCase().includes(text.toLowerCase()))
    .slice(0, 8);

  return (
    <div
      className="gm-m-screen fixed inset-0 z-[72] flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label="Search mail"
      data-testid="gmail-m-search-screen"
    >
      <form
        className="flex h-16 flex-none items-center gap-1 border-b border-border px-1 pt-[env(safe-area-inset-top)]"
        onSubmit={(e) => {
          e.preventDefault();
          go(text);
        }}
        role="search"
      >
        <button
          type="button"
          className="gm-icon-btn"
          style={{ width: 48, height: 48 }}
          aria-label="Close search"
          onClick={onClose}
        >
          <ArrowLeft size={22} />
        </button>
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search in mail"
          aria-label="Search in mail"
          enterKeyHint="search"
          autoComplete="off"
          className="h-full min-w-0 flex-1 bg-transparent text-base text-text-primary outline-none placeholder:text-text-secondary"
          data-testid="gmail-m-search-input"
        />
        {text && (
          <button
            type="button"
            className="gm-icon-btn"
            style={{ width: 48, height: 48 }}
            aria-label="Clear"
            onClick={() => {
              setText("");
              inputRef.current?.focus();
            }}
          >
            <X size={20} />
          </button>
        )}
      </form>

      <div
        className="flex flex-none gap-2 overflow-x-auto px-4 py-3"
        role="toolbar"
        aria-label="Search filters"
      >
        {(
          [
            ["is:unread", "Unread"],
            ["has:attachment", "Attachments"],
            ["is:starred", "Starred"],
            ["newer_than:7d", "Past week"],
            ["in:sent", "Sent"],
          ] as const
        ).map(([tok, label]) => (
          <button
            key={tok}
            type="button"
            className="gm-filter-chip"
            onClick={() => addToken(tok)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        {text.trim() && (
          <button
            type="button"
            className="flex h-14 w-full items-center gap-5 px-5 text-left text-base"
            onClick={() => go(text)}
          >
            <SearchIcon size={20} className="text-text-secondary" />
            <span className="truncate">Search for “{text.trim()}”</span>
          </button>
        )}
        {people.length > 0 && (
          <>
            <p className="px-5 pb-1 pt-3 text-xs font-medium uppercase tracking-[0.08em] text-text-secondary">
              People
            </p>
            {people.map((p) => (
              <button
                key={`${p.type}:${p.id}`}
                type="button"
                className="flex h-14 w-full items-center gap-4 px-4 text-left"
                onClick={() => go(`from:${personAddress(p)}`)}
              >
                <Avatar
                  name={itemTitle(p)}
                  email={personAddress(p)}
                  size={32}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base">
                    {itemTitle(p)}
                  </span>
                  <span className="block truncate text-sm text-text-secondary">
                    {personAddress(p)}
                  </span>
                </span>
              </button>
            ))}
          </>
        )}
        {shownRecent.length > 0 && (
          <>
            <p className="px-5 pb-1 pt-3 text-xs font-medium uppercase tracking-[0.08em] text-text-secondary">
              Recent searches
            </p>
            {shownRecent.map((r) => (
              <div key={r} className="flex h-14 items-center pl-5 pr-2">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-5 text-left text-base"
                  onClick={() => go(r)}
                >
                  <Clock size={20} className="flex-none text-text-secondary" />
                  <span className="truncate">{r}</span>
                </button>
                <button
                  type="button"
                  className="gm-icon-btn"
                  aria-label={`Remove ${r}`}
                  onClick={() => remove(r)}
                >
                  <X size={18} />
                </button>
              </div>
            ))}
          </>
        )}
        {!text.trim() && !shownRecent.length && (
          <p className="px-6 py-10 text-center text-sm text-text-secondary">
            Search by sender, subject or words in the message. Try{" "}
            <code>from:</code>, <code>is:unread</code> or{" "}
            <code>has:attachment</code>.
          </p>
        )}
      </div>
    </div>
  );
}

/** The app's category rows at the top of Primary ("Promotions · 3 new"). */
export function CategoryRows({
  counts,
  onOpen,
}: {
  counts: Partial<Record<MailCategory, number>>;
  onOpen: (c: MailCategory) => void;
}) {
  return (
    <div data-testid="gmail-m-categories">
      {(["promotions", "social", "updates"] as MailCategory[]).map((c) => {
        const Icon = CATEGORY_ICONS[c];
        const n = counts[c] ?? 0;
        return (
          <button
            key={c}
            type="button"
            className="gm-m-cat"
            data-cat={c}
            onClick={() => onOpen(c)}
            data-testid={`gmail-m-cat-${c}`}
          >
            <span className="gm-m-cat-icon">
              <Icon size={20} />
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-left text-base",
                n > 0 && "font-bold",
              )}
            >
              {CATEGORY_LABELS[c]}
            </span>
            {n > 0 && <span className="gm-tab-badge">{n} new</span>}
          </button>
        );
      })}
    </div>
  );
}

export type { ListState };
