import { X } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import MessageBubble from "@/components/MessageBubble";
import type { Email } from "@/lib/api";

interface ThreadSidebarProps {
  emails: Email[];
  senderEmail: string;
  onOpenHtml: (email: Email) => void;
  onMarkRead: (email: Email) => void;
  onReply: (emailId: string) => void;
  onDelete: (emailId: string) => void;
  onClose: () => void;
}

export default function ThreadSidebar({
  emails,
  senderEmail,
  onOpenHtml,
  onMarkRead,
  onReply,
  onDelete,
  onClose,
}: ThreadSidebarProps) {
  // Display in chronological order (oldest first)
  const chronological = [...emails].reverse();

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l border-border-dark bg-panel">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border-dark px-4 py-3">
        <h3 className="text-xs font-semibold text-text-primary">Thread</h3>
        <button
          onClick={onClose}
          className="rounded p-0.5 text-text-tertiary hover:bg-hover hover:text-text-secondary"
        >
          <X size={14} />
        </button>
      </div>

      {/* Email list */}
      <ScrollArea className="flex-1">
        <div className="divide-y divide-border-dark">
          {chronological.map((email) => (
            <MessageBubble
              key={email.id}
              email={email}
              senderEmail={senderEmail}
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
