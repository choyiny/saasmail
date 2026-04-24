import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ChevronLeft,
  ChevronRight,
  Paperclip,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import {
  fetchGroupedPeople,
  deletePerson,
  type GroupedPerson,
} from "@/lib/api";

const PAGE_SIZE = 50;

interface PersonListProps {
  people: GroupedPerson[];
  setPeople: (people: GroupedPerson[]) => void;
  selectedPersonId: string | null;
  onSelectPerson: (person: GroupedPerson) => void;
  onPersonDeleted?: (personId: string) => void;
  refreshKey?: number;
  isAdmin?: boolean;
}

export default function PersonList({
  people,
  setPeople,
  selectedPersonId,
  onSelectPerson,
  onPersonDeleted,
  refreshKey,
  isAdmin,
}: PersonListProps) {
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(
    null,
  );
  const menuRef = useRef<HTMLDivElement | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Reset to page 1 when search changes
  useEffect(() => {
    setPage(1);
  }, [search]);

  // Fetch flat list of people (aggregated across all inboxes)
  useEffect(() => {
    setLoading(true);
    const timeout = setTimeout(() => {
      fetchGroupedPeople({
        q: search || undefined,
        page,
        limit: PAGE_SIZE,
      })
        .then((result) => {
          setPeople(result.data);
          setTotal(result.total);
        })
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(timeout);
  }, [search, page, refreshKey]);

  // Close menu when clicking outside or scrolling
  useEffect(() => {
    if (!menuOpenId) return;
    function handleClose(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenId(null);
      }
    }
    document.addEventListener("mousedown", handleClose);
    document.addEventListener("scroll", () => setMenuOpenId(null), true);
    return () => {
      document.removeEventListener("mousedown", handleClose);
      document.removeEventListener("scroll", () => setMenuOpenId(null), true);
    };
  }, [menuOpenId]);

  async function handleDeletePerson(person: GroupedPerson) {
    setMenuOpenId(null);
    if (
      !confirm(
        `Permanently delete ${person.name || person.email} and all ${person.totalCount} email${person.totalCount !== 1 ? "s" : ""}? This cannot be undone.`,
      )
    )
      return;
    await deletePerson(person.id);
    setPeople(people.filter((p) => p.id !== person.id));
    setTotal((t) => t - 1);
    onPersonDeleted?.(person.id);
  }

  function formatTime(ts: number) {
    const date = new Date(ts * 1000);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 p-3">
        <input
          type="text"
          placeholder="Search people..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 w-full rounded-md border border-border bg-white ring-1 ring-gray-200 px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
      <ScrollArea className="flex-1">
        {loading ? (
          <p className="p-4 text-center text-xs text-text-tertiary">
            Loading...
          </p>
        ) : people.length === 0 ? (
          <p className="p-4 text-center text-xs text-text-tertiary">
            No people found
          </p>
        ) : (
          people.map((person) => {
            const isSelected = selectedPersonId === person.id;
            const menuOpen = menuOpenId === person.id;
            return (
              <div
                key={person.id}
                className={`group relative border-b border-border transition-colors hover:bg-bg-muted ${
                  isSelected ? "bg-bg-muted" : ""
                }`}
              >
                <button
                  data-testid="person-row"
                  data-person-id={person.id}
                  onClick={() => onSelectPerson(person)}
                  className={`w-full px-4 py-2.5 text-left ${isAdmin ? "pr-8" : ""}`}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={`truncate text-xs ${
                        person.unreadCount > 0
                          ? "font-semibold text-text-primary"
                          : "text-text-secondary"
                      }`}
                    >
                      {person.name || person.email}
                    </span>
                    <span className="ml-2 shrink-0 text-[11px] text-text-tertiary">
                      {formatTime(person.lastEmailAt)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between">
                    <span className="truncate text-[11px] text-text-tertiary">
                      {person.totalCount} email
                      {person.totalCount !== 1 ? "s" : ""}
                      {person.recipientCount > 1
                        ? ` · ${person.recipientCount} inboxes`
                        : ""}
                    </span>
                    <div className="ml-2 flex shrink-0 items-center gap-1.5">
                      {person.hasAttachment === 1 && (
                        <Paperclip size={10} className="text-text-tertiary" />
                      )}
                      {person.unreadCount > 0 && (
                        <span
                          data-testid="person-unread-badge"
                          className="flex h-4 min-w-4 items-center justify-center rounded-full bg-unread px-1 text-[10px] font-semibold text-white"
                        >
                          {person.unreadCount}
                        </span>
                      )}
                    </div>
                  </div>
                </button>

                {/* Kebab menu button — admin only, visible on hover or when menu is open */}
                {isAdmin && (
                  <button
                    data-testid="person-kebab-menu"
                    data-person-id={person.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (menuOpen) {
                        setMenuOpenId(null);
                      } else {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setMenuPos({
                          top: rect.bottom + 4,
                          right: window.innerWidth - rect.right,
                        });
                        setMenuOpenId(person.id);
                      }
                    }}
                    className={`absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-text-tertiary transition-opacity hover:bg-bg-subtle hover:text-text-secondary ${
                      menuOpen
                        ? "opacity-100"
                        : "opacity-0 group-hover:opacity-100"
                    }`}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                )}
              </div>
            );
          })
        )}
      </ScrollArea>

      {/* Dropdown rendered in a portal so it escapes ScrollArea's overflow clipping */}
      {menuOpenId &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            style={{ top: menuPos.top, right: menuPos.right }}
            className="fixed z-50 w-40 rounded-md border border-border bg-white py-1 shadow-md"
          >
            <button
              data-testid="person-delete-button"
              onClick={(e) => {
                e.stopPropagation();
                const person = people.find((p) => p.id === menuOpenId);
                if (person) handleDeletePerson(person);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-red-600 hover:bg-bg-muted"
            >
              <Trash2 size={12} />
              Delete person
            </button>
          </div>,
          document.body,
        )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-border px-3 py-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="rounded p-1 text-text-secondary hover:bg-bg-muted disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-[11px] text-text-tertiary">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="rounded p-1 text-text-secondary hover:bg-bg-muted disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
