import { useState, useEffect } from "react";
import DOMPurify from "dompurify";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  fetchSenderEmails,
  markEmailRead,
  type Sender,
  type Email,
} from "@/lib/api";

interface SenderDetailProps {
  sender: Sender;
  onReply: (emailId: string) => void;
}

export default function SenderDetail({ sender, onReply }: SenderDetailProps) {
  const [emails, setEmails] = useState<Email[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setExpandedId(null);
    fetchSenderEmails(sender.id)
      .then(setEmails)
      .finally(() => setLoading(false));
  }, [sender.id]);

  async function handleExpand(email: Email) {
    if (expandedId === email.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(email.id);
    if (email.type === "received" && email.isRead === 0) {
      await markEmailRead(email.id, true);
      setEmails((prev) =>
        prev.map((e) => (e.id === email.id ? { ...e, isRead: 1 } : e))
      );
    }
  }

  async function handleToggleRead(e: React.MouseEvent, email: Email) {
    e.stopPropagation();
    if (email.type !== "received") return;
    const newIsRead = email.isRead === 0;
    await markEmailRead(email.id, newIsRead);
    setEmails((prev) =>
      prev.map((em) =>
        em.id === email.id ? { ...em, isRead: newIsRead ? 1 : 0 } : em
      )
    );
  }

  function formatDate(ts: number) {
    return new Date(ts * 1000).toLocaleString();
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-neutral-500">
        Loading...
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-6 py-4">
        <h2 className="text-lg font-semibold">
          {sender.name || sender.email}
        </h2>
        {sender.name && (
          <p className="text-sm text-neutral-500">{sender.email}</p>
        )}
        <p className="text-xs text-neutral-400">
          {sender.totalCount} email{sender.totalCount !== 1 ? "s" : ""}
        </p>
      </div>

      <ScrollArea className="flex-1">
        {emails.map((email) => (
          <div key={email.id}>
            <button
              onClick={() => handleExpand(email)}
              className={`w-full px-6 py-3 text-left transition-colors hover:bg-neutral-50 ${
                expandedId === email.id ? "bg-neutral-50" : ""
              }`}
            >
              <div className="flex items-center gap-2">
                {email.type === "sent" && (
                  <Badge variant="outline" className="text-xs">
                    Sent
                  </Badge>
                )}
                <span
                  className={`flex-1 truncate text-sm ${
                    email.type === "received" && email.isRead === 0
                      ? "font-semibold"
                      : ""
                  }`}
                >
                  {email.subject || "(no subject)"}
                </span>
                {email.type === "received" && (email.attachmentCount ?? 0) > 0 && (
                  <span className="text-xs text-neutral-400">
                    {email.attachmentCount} file{email.attachmentCount !== 1 ? "s" : ""}
                  </span>
                )}
                <span className="shrink-0 text-xs text-neutral-400">
                  {formatDate(email.timestamp)}
                </span>
              </div>
            </button>

            {expandedId === email.id && (
              <div className="border-t bg-white px-6 py-4">
                <div className="mb-3 flex items-center gap-2">
                  {email.type === "received" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onReply(email.id)}
                      >
                        Reply
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => handleToggleRead(e, email)}
                      >
                        Mark {email.isRead ? "unread" : "read"}
                      </Button>
                    </>
                  )}
                  {email.type === "sent" && email.toAddress && (
                    <span className="text-xs text-neutral-500">
                      To: {email.toAddress}
                    </span>
                  )}
                  {email.type === "received" && email.recipient && (
                    <span className="text-xs text-neutral-500">
                      To: {email.recipient}
                    </span>
                  )}
                </div>
                {email.bodyHtml ? (
                  <div
                    className="prose prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(email.bodyHtml) }}
                  />
                ) : (
                  <pre className="whitespace-pre-wrap text-sm">
                    {email.bodyText || "(empty)"}
                  </pre>
                )}
                {email.type === "received" &&
                  email.attachments &&
                  email.attachments.length > 0 && (
                    <div className="mt-4">
                      <Separator className="mb-3" />
                      <p className="mb-2 text-xs font-medium text-neutral-500">
                        Attachments
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {email.attachments.map((att) => (
                          <a
                            key={att.id}
                            href={`/api/attachments/${att.id}`}
                            className="rounded border px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50"
                          >
                            {att.filename} ({Math.round(att.size / 1024)}KB)
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
              </div>
            )}
            <Separator />
          </div>
        ))}
      </ScrollArea>
    </div>
  );
}
