import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
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
    <div className="flex h-full flex-col border-r">
      <div className="space-y-2 p-3">
        <Input
          placeholder="Search senders..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {recipients.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="w-full justify-start text-sm">
                {recipient || "All addresses"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => setRecipient("")}>
                All addresses
              </DropdownMenuItem>
              {recipients.map((r) => (
                <DropdownMenuItem key={r} onClick={() => setRecipient(r)}>
                  {r}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <ScrollArea className="flex-1">
        {loading ? (
          <p className="p-4 text-center text-sm text-neutral-500">Loading...</p>
        ) : senders.length === 0 ? (
          <p className="p-4 text-center text-sm text-neutral-500">No senders found</p>
        ) : (
          senders.map((sender) => (
            <button
              key={sender.id}
              onClick={() => onSelectSender(sender)}
              className={`w-full border-b px-4 py-3 text-left transition-colors hover:bg-neutral-50 ${
                selectedSenderId === sender.id ? "bg-neutral-100" : ""
              }`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`truncate text-sm ${
                    sender.unreadCount > 0 ? "font-semibold" : ""
                  }`}
                >
                  {sender.name || sender.email}
                </span>
                <span className="ml-2 shrink-0 text-xs text-neutral-400">
                  {formatTime(sender.lastEmailAt)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                {sender.name && (
                  <span className="truncate text-xs text-neutral-500">{sender.email}</span>
                )}
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="truncate text-xs text-neutral-400">
                  {sender.latestSubject || "(no subject)"}
                </span>
                {sender.unreadCount > 0 && (
                  <Badge variant="default" className="ml-2 shrink-0 text-xs">
                    {sender.unreadCount}
                  </Badge>
                )}
              </div>
            </button>
          ))
        )}
      </ScrollArea>
    </div>
  );
}
