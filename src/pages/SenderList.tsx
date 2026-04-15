import { useState, useEffect } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fetchSenders, fetchStats, type Sender } from "@/lib/api";

interface SenderListProps {
  selectedSenderId: string | null;
  onSelectSender: (sender: Sender) => void;
}

export default function SenderList({ selectedSenderId, onSelectSender }: SenderListProps) {
  const [senders, setSenders] = useState<Sender[]>([]);
  const [search, setSearch] = useState("");
  const [recipient, setRecipient] = useState<string>("");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStats().then((stats) => setRecipients(stats.recipients));
  }, []);

  useEffect(() => {
    setLoading(true);
    const timeout = setTimeout(() => {
      fetchSenders({
        q: search || undefined,
        recipient: recipient || undefined,
      })
        .then(setSenders)
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(timeout);
  }, [search, recipient]);

  function formatTime(ts: number) {
    const date = new Date(ts * 1000);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 p-3">
        <input
          type="text"
          placeholder="Search senders..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 w-full rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
        />
        {recipients.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex h-7 w-full items-center justify-start rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-secondary hover:text-text-primary">
                {recipient || "All addresses"}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="bg-card border-border-dark text-text-primary">
              <DropdownMenuItem
                onClick={() => setRecipient("")}
                className="text-xs text-text-secondary focus:bg-hover focus:text-text-primary"
              >
                All addresses
              </DropdownMenuItem>
              {recipients.map((r) => (
                <DropdownMenuItem
                  key={r}
                  onClick={() => setRecipient(r)}
                  className="text-xs text-text-secondary focus:bg-hover focus:text-text-primary"
                >
                  {r}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <ScrollArea className="flex-1">
        {loading ? (
          <p className="p-4 text-center text-xs text-text-tertiary">Loading...</p>
        ) : senders.length === 0 ? (
          <p className="p-4 text-center text-xs text-text-tertiary">No senders found</p>
        ) : (
          senders.map((sender) => (
            <button
              key={sender.id}
              onClick={() => onSelectSender(sender)}
              className={`w-full border-b border-border-dark px-4 py-2.5 text-left transition-colors hover:bg-hover ${
                selectedSenderId === sender.id ? "bg-hover" : ""
              }`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`truncate text-xs ${
                    sender.unreadCount > 0
                      ? "font-semibold text-text-primary"
                      : "text-text-secondary"
                  }`}
                >
                  {sender.name || sender.email}
                </span>
                <span className="ml-2 shrink-0 text-[11px] text-text-tertiary">
                  {formatTime(sender.lastEmailAt)}
                </span>
              </div>
              {sender.name && (
                <div className="truncate text-[11px] text-text-tertiary">
                  {sender.email}
                </div>
              )}
              <div className="mt-0.5 flex items-center justify-between">
                <span className="truncate text-[11px] text-text-tertiary">
                  {sender.latestSubject || "(no subject)"}
                </span>
                {sender.unreadCount > 0 && (
                  <span className="ml-2 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-unread px-1 text-[10px] font-semibold text-white">
                    {sender.unreadCount}
                  </span>
                )}
              </div>
            </button>
          ))
        )}
      </ScrollArea>
    </div>
  );
}
