import { X } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import MessageBubble from "@/components/MessageBubble";
import type { Email } from "@/lib/api";

interface ThreadSidebarProps {
  emails: Email[];
  personEmail: string;
  onOpenHtml: (email: Email) => void;
  onMarkRead: (email: Email) => void;
  onReply: (emailId: string) => void;
  onDelete: (emailId: string) => void;
  onClose: () => void;
}

export default function ThreadSidebar({
  emails,
  personEmail,
  onOpenHtml,
  onMarkRead,
  onReply,
  onDelete,
  onClose,
}: ThreadSidebarProps) {
  // Display in chronological order (oldest first)
  const chronological = [...emails].reverse();

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l border-border bg-bg-subtle max-md:absolute max-md:right-0 max-md:top-0 max-md:z-10 max-md:w-full max-md:border-l-0">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-secondary">
          Thread
        </h3>
        <button
          onClick={onClose}
          className="rounded p-0.5 text-text-tertiary hover:bg-bg-muted hover:text-text-secondary"
        >
          <X size={14} />
        </button>
      </div>

      {/* Email list */}
      <ScrollArea className="flex-1">
        <div className="divide-y divide-border-subtle">
          {chronological.map((email) => (
            <MessageBubble
              key={email.id}
              email={email}
              personEmail={personEmail}
              onOpenHtml={onOpenHtml}
              onMarkRead={onMarkRead}
              onReply={onReply}
              onDelete={onDelete}
              compact
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
