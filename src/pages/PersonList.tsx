import { useState, useEffect } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChevronLeft, ChevronRight, ArrowLeft } from "lucide-react";
import {
  fetchGroupedPeople,
  fetchPeople,
  type GroupedPerson,
  type Person,
} from "@/lib/api";

const PAGE_SIZE = 50;

interface PersonListProps {
  selectedPersonId: string | null;
  selectedRecipient: string | null;
  onSelectPerson: (person: Person) => void;
}

export default function PersonList({
  selectedPersonId,
  selectedRecipient,
  onSelectPerson,
}: PersonListProps) {
  // Level 1: grouped people
  const [groupedPeople, setGroupedPeople] = useState<GroupedPerson[]>([]);
  const [groupedTotal, setGroupedTotal] = useState(0);
  const [groupedPage, setGroupedPage] = useState(1);
  const [groupedLoading, setGroupedLoading] = useState(true);

  // Level 2: threads for a selected person
  const [activePerson, setActivePerson] = useState<GroupedPerson | null>(null);
  const [threads, setThreads] = useState<Person[]>([]);
  const [threadsTotal, setThreadsTotal] = useState(0);
  const [threadsPage, setThreadsPage] = useState(1);
  const [threadsLoading, setThreadsLoading] = useState(false);

  const [search, setSearch] = useState("");

  const groupedTotalPages = Math.max(1, Math.ceil(groupedTotal / PAGE_SIZE));
  const threadsTotalPages = Math.max(1, Math.ceil(threadsTotal / PAGE_SIZE));

  // Reset to page 1 when search changes
  useEffect(() => {
    setGroupedPage(1);
    setThreadsPage(1);
  }, [search]);

  // Fetch grouped people (level 1)
  useEffect(() => {
    if (activePerson) return; // don't refetch when drilling down
    setGroupedLoading(true);
    const timeout = setTimeout(() => {
      fetchGroupedPeople({
        q: search || undefined,
        page: groupedPage,
        limit: PAGE_SIZE,
      })
        .then((result) => {
          setGroupedPeople(result.data);
          setGroupedTotal(result.total);
        })
        .finally(() => setGroupedLoading(false));
    }, 200);
    return () => clearTimeout(timeout);
  }, [search, groupedPage, activePerson]);

  // Fetch threads for active person (level 2)
  useEffect(() => {
    if (!activePerson) return;
    setThreadsLoading(true);
    fetchPeople({
      personId: activePerson.id,
      page: threadsPage,
      limit: PAGE_SIZE,
    })
      .then((result) => {
        setThreads(result.data);
        setThreadsTotal(result.total);
      })
      .finally(() => setThreadsLoading(false));
  }, [activePerson, threadsPage]);

  function handleSelectPerson(gp: GroupedPerson) {
    setActivePerson(gp);
    setThreadsPage(1);
  }

  function handleBack() {
    setActivePerson(null);
    setThreads([]);
    setThreadsPage(1);
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

  // Level 2: threads view
  if (activePerson) {
    return (
      <div className="flex h-full flex-col">
        {/* Back button + person info */}
        <div className="border-b border-border p-3">
          <button
            onClick={handleBack}
            className="mb-2 flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary"
          >
            <ArrowLeft size={14} />
            All people
          </button>
          <div>
            <p className="truncate text-xs font-semibold text-text-primary">
              {activePerson.name || activePerson.email}
            </p>
            {activePerson.name && (
              <p className="truncate text-[11px] text-text-tertiary">
                {activePerson.email}
              </p>
            )}
          </div>
        </div>

        <ScrollArea className="flex-1">
          {threadsLoading ? (
            <p className="p-4 text-center text-xs text-text-tertiary">
              Loading...
            </p>
          ) : threads.length === 0 ? (
            <p className="p-4 text-center text-xs text-text-tertiary">
              No threads found
            </p>
          ) : (
            threads.map((thread) => (
              <button
                key={`${thread.id}:${thread.recipient}`}
                onClick={() => onSelectPerson(thread)}
                className={`w-full border-b border-border px-4 py-2.5 text-left transition-colors hover:bg-bg-muted ${
                  selectedPersonId === thread.id &&
                  selectedRecipient === thread.recipient
                    ? "bg-bg-muted"
                    : ""
                }`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`truncate text-xs ${
                      thread.unreadCount > 0
                        ? "font-semibold text-text-primary"
                        : "text-text-secondary"
                    }`}
                  >
                    {thread.recipient}
                  </span>
                  <span className="ml-2 shrink-0 text-[11px] text-text-tertiary">
                    {formatTime(thread.lastEmailAt)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center justify-between">
                  <span className="truncate text-[11px] text-text-tertiary">
                    {thread.latestSubject || "(no subject)"}
                  </span>
                  {thread.unreadCount > 0 && (
                    <span className="ml-2 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-unread px-1 text-[10px] font-semibold text-white">
                      {thread.unreadCount}
                    </span>
                  )}
                </div>
              </button>
            ))
          )}
        </ScrollArea>

        {threadsTotalPages > 1 && (
          <div className="flex items-center justify-between border-t border-border px-3 py-2">
            <button
              onClick={() => setThreadsPage((p) => Math.max(1, p - 1))}
              disabled={threadsPage <= 1}
              className="rounded p-1 text-text-secondary hover:bg-bg-muted disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="text-[11px] text-text-tertiary">
              {threadsPage} / {threadsTotalPages}
            </span>
            <button
              onClick={() =>
                setThreadsPage((p) => Math.min(threadsTotalPages, p + 1))
              }
              disabled={threadsPage >= threadsTotalPages}
              className="rounded p-1 text-text-secondary hover:bg-bg-muted disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        )}
      </div>
    );
  }

  // Level 1: grouped people view
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
        {groupedLoading ? (
          <p className="p-4 text-center text-xs text-text-tertiary">
            Loading...
          </p>
        ) : groupedPeople.length === 0 ? (
          <p className="p-4 text-center text-xs text-text-tertiary">
            No people found
          </p>
        ) : (
          groupedPeople.map((gp) => (
            <button
              key={gp.id}
              onClick={() => handleSelectPerson(gp)}
              className={`w-full border-b border-border px-4 py-2.5 text-left transition-colors hover:bg-bg-muted ${
                activePerson?.id === gp.id ? "bg-bg-muted" : ""
              }`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`truncate text-xs ${
                    gp.unreadCount > 0
                      ? "font-semibold text-text-primary"
                      : "text-text-secondary"
                  }`}
                >
                  {gp.name || gp.email}
                </span>
                <span className="ml-2 shrink-0 text-[11px] text-text-tertiary">
                  {formatTime(gp.lastEmailAt)}
                </span>
              </div>
              {gp.name && (
                <div className="truncate text-[11px] text-text-tertiary">
                  {gp.email}
                </div>
              )}
              <div className="mt-0.5 flex items-center justify-between">
                <span className="truncate text-[11px] text-text-tertiary">
                  {gp.recipientCount} address
                  {gp.recipientCount !== 1 ? "es" : ""}
                  {" · "}
                  {gp.totalCount} email{gp.totalCount !== 1 ? "s" : ""}
                </span>
                {gp.unreadCount > 0 && (
                  <span className="ml-2 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-unread px-1 text-[10px] font-semibold text-white">
                    {gp.unreadCount}
                  </span>
                )}
              </div>
            </button>
          ))
        )}
      </ScrollArea>

      {groupedTotalPages > 1 && (
        <div className="flex items-center justify-between border-t border-border px-3 py-2">
          <button
            onClick={() => setGroupedPage((p) => Math.max(1, p - 1))}
            disabled={groupedPage <= 1}
            className="rounded p-1 text-text-secondary hover:bg-bg-muted disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-[11px] text-text-tertiary">
            {groupedPage} / {groupedTotalPages}
          </span>
          <button
            onClick={() =>
              setGroupedPage((p) => Math.min(groupedTotalPages, p + 1))
            }
            disabled={groupedPage >= groupedTotalPages}
            className="rounded p-1 text-text-secondary hover:bg-bg-muted disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
