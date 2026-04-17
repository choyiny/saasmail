import { useState, useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import PersonList from "./PersonList";
import PersonDetail from "./PersonDetail";
import ComposeModal from "./ComposeModal";
import { fetchStats, type GroupedPerson, type Stats } from "@/lib/api";
import { useSession } from "@/lib/auth-client";

export default function InboxPage() {
  const [selectedPerson, setSelectedPerson] = useState<GroupedPerson | null>(
    null,
  );
  const [composeOpen, setComposeOpen] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const { data: session } = useSession();

  useEffect(() => {
    fetchStats()
      .then(setStats)
      .catch(() => {});
  }, []);

  const isAdmin = session?.user?.role === "admin";

  if (stats && stats.recipients.length === 0 && !isAdmin) {
    return (
      <div className="flex flex-1 items-center justify-center p-10 text-center">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">
            No inboxes assigned yet
          </h2>
          <p className="mt-2 text-sm text-text-secondary">
            Ask an admin to grant you access to an inbox.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Middle panel — person list (hidden on mobile when a person is selected) */}
      <div
        className={`w-full md:w-80 shrink-0 border-r border-border bg-bg-subtle ${
          selectedPerson ? "hidden md:block" : "block"
        }`}
      >
        <PersonList
          selectedPersonId={selectedPerson?.id ?? null}
          onSelectPerson={setSelectedPerson}
        />
      </div>

      {/* Right panel — email detail (hidden on mobile when no person selected) */}
      <div
        className={`flex-1 bg-white min-w-0 ${
          selectedPerson ? "block" : "hidden md:block"
        }`}
      >
        {selectedPerson ? (
          <div className="flex h-full flex-col">
            {/* Mobile back button */}
            <button
              onClick={() => setSelectedPerson(null)}
              className="flex items-center gap-1.5 px-4 py-2 text-xs text-text-secondary hover:text-text-primary md:hidden border-b border-border"
            >
              <ArrowLeft size={14} />
              Back
            </button>
            <div className="flex-1 overflow-hidden">
              <PersonDetail person={selectedPerson} />
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-text-tertiary">
            Select a person to view emails
          </div>
        )}
      </div>

      <ComposeModal open={composeOpen} onClose={() => setComposeOpen(false)} />
    </>
  );
}
