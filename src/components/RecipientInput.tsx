import { useEffect, useId, useRef, useState } from "react";
import { fetchGroupedPeople, type GroupedPerson } from "@/lib/api";
import { avatarColor, initials } from "@/lib/avatar";
import { cn } from "@/lib/utils";

/**
 * The compose "To" field with suggestions from people we already have
 * mail with. Typing two or more characters searches by name or address;
 * ↑/↓ move, Enter or Tab picks, Esc closes the list.
 *
 * `onSuggestionsOpenChange` lets the compose tray keep Esc from closing
 * the whole window while the list is showing.
 */
export default function RecipientInput({
  id,
  value,
  onChange,
  onPick,
  onSuggestionsOpenChange,
  className,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  /** Called with the picked person (for name-aware templates). */
  onPick?: (p: { email: string; name: string | null }) => void;
  onSuggestionsOpenChange?: (open: boolean) => void;
  className?: string;
  placeholder?: string;
}) {
  const [people, setPeople] = useState<GroupedPerson[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const skipNext = useRef(false);

  useEffect(() => {
    const term = value.trim();
    if (skipNext.current || term.length < 2) {
      skipNext.current = false;
      setPeople([]);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      fetchGroupedPeople({ q: term, limit: 6, folder: "all" })
        .then((r) => {
          if (!alive) return;
          const found = r.data.filter(
            (it): it is GroupedPerson => it.type === "person",
          );
          // Hide the list once the field already holds an exact address.
          const exact = found.some(
            (p) => p.email.toLowerCase() === term.toLowerCase(),
          );
          setPeople(exact ? [] : found);
          setActive(0);
        })
        .catch(() => alive && setPeople([]));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [value]);

  const showing = open && people.length > 0;
  useEffect(() => {
    onSuggestionsOpenChange?.(showing);
  }, [showing, onSuggestionsOpenChange]);

  const pick = (p: GroupedPerson) => {
    skipNext.current = true;
    onChange(p.email);
    onPick?.({ email: p.email, name: p.name });
    setPeople([]);
    setOpen(false);
  };

  return (
    <div className="relative w-full">
      <input
        id={id}
        type="email"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!showing) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(people.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Enter" || e.key === "Tab") {
            if (e.metaKey || e.ctrlKey) return;
            e.preventDefault();
            pick(people[active]);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
          }
        }}
        required
        autoComplete="off"
        placeholder={placeholder}
        aria-label="To"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showing}
        aria-controls={showing ? listId : undefined}
        aria-activedescendant={showing ? `${listId}-${active}` : undefined}
        className={className}
      />
      {showing && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Suggestions"
          className="absolute left-0 right-3 top-full z-20 mt-1 overflow-hidden rounded-xl border border-border-strong bg-card p-1 shadow-overlay"
        >
          {people.map((p, i) => {
            const color = avatarColor(p.email);
            return (
              <li
                key={p.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                // mousedown, not click: the input's blur would close the
                // list before a click lands.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(p);
                }}
                onMouseMove={() => setActive(i)}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5",
                  i === active && "bg-bg-muted",
                )}
              >
                <span
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold"
                  style={{ backgroundColor: color.bg, color: color.fg }}
                  aria-hidden
                >
                  {initials(p.name, p.email)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-text-primary">
                    {p.name || p.email}
                  </span>
                  {p.name && (
                    <span className="block truncate text-xs text-text-tertiary">
                      {p.email}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
