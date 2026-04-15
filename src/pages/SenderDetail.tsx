import { useState, useEffect } from "react";
import DOMPurify from "dompurify";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  fetchSenderEmails,
  markEmailRead,
  fetchSenderEnrollment,
  type Sender,
  type Email,
  type SenderEnrollmentInfo,
} from "@/lib/api";
import EnrollSequenceModal from "@/components/EnrollSequenceModal";
import SequenceStatus from "@/components/SequenceStatus";

interface SenderDetailProps {
  sender: Sender;
  onReply: (emailId: string) => void;
}

export default function SenderDetail({ sender, onReply }: SenderDetailProps) {
  const [emails, setEmails] = useState<Email[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [enrollModalOpen, setEnrollModalOpen] = useState(false);
  const [enrollmentInfo, setEnrollmentInfo] = useState<SenderEnrollmentInfo | null>(null);

  useEffect(() => {
    setLoading(true);
    setExpandedId(null);
    fetchSenderEmails(sender.id)
      .then(setEmails)
      .finally(() => setLoading(false));
  }, [sender.id]);

  useEffect(() => {
    fetchSenderEnrollment(sender.id).then(setEnrollmentInfo);
  }, [sender.id]);

  function refreshEnrollment() {
    fetchSenderEnrollment(sender.id).then(setEnrollmentInfo);
  }

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
      <div className="flex h-full items-center justify-center text-text-tertiary">
        Loading...
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border-dark px-6 py-3">
        <h2 className="text-sm font-semibold text-text-primary">
          {sender.name || sender.email}
        </h2>
        {sender.name && (
          <p className="text-xs text-text-secondary">{sender.email}</p>
        )}
        <p className="text-[11px] text-text-tertiary">
          {sender.totalCount} email{sender.totalCount !== 1 ? "s" : ""}
        </p>
      </div>

      {/* Sequence status or enroll button */}
      <div className="border-b border-border-dark px-6 py-2">
        {enrollmentInfo?.enrollment ? (
          <SequenceStatus
            senderId={sender.id}
            onStatusChange={refreshEnrollment}
          />
        ) : (
          <button
            onClick={() => setEnrollModalOpen(true)}
            className="rounded-md border border-border-dark px-3 py-1.5 text-xs text-text-secondary hover:bg-hover"
          >
            Add to Sequence
          </button>
        )}
      </div>

      <ScrollArea className="flex-1">
        {emails.map((email) => (
          <div key={email.id}>
            <button
              onClick={() => handleExpand(email)}
              className={`w-full px-6 py-2.5 text-left transition-colors hover:bg-hover ${
                expandedId === email.id ? "bg-hover" : ""
              }`}
            >
              <div className="flex items-center gap-2">
                {email.type === "sent" && (
                  <span className="rounded border border-border-dark px-1.5 py-0.5 text-[10px] text-text-tertiary">
                    Sent
                  </span>
                )}
                <span
                  className={`flex-1 truncate text-xs ${
                    email.type === "received" && email.isRead === 0
                      ? "font-semibold text-text-primary"
                      : "text-text-secondary"
                  }`}
                >
                  {email.subject || "(no subject)"}
                </span>
                {email.type === "received" && (email.attachmentCount ?? 0) > 0 && (
                  <span className="text-[11px] text-text-tertiary">
                    {email.attachmentCount} file{email.attachmentCount !== 1 ? "s" : ""}
                  </span>
                )}
                <span className="shrink-0 text-[11px] text-text-tertiary">
                  {formatDate(email.timestamp)}
                </span>
              </div>
            </button>

            {expandedId === email.id && (
              <div className="border-t border-border-dark bg-card px-6 py-4">
                <div className="mb-3 flex items-center gap-2">
                  {email.type === "received" && (
                    <>
                      <button
                        onClick={() => onReply(email.id)}
                        className="rounded-md border border-border-dark px-3 py-1 text-xs text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
                      >
                        Reply
                      </button>
                      <button
                        onClick={(e) => handleToggleRead(e, email)}
                        className="rounded-md px-3 py-1 text-xs text-text-tertiary transition-colors hover:bg-hover hover:text-text-secondary"
                      >
                        Mark {email.isRead ? "unread" : "read"}
                      </button>
                    </>
                  )}
                  {email.type === "sent" && email.toAddress && (
                    <span className="text-[11px] text-text-tertiary">
                      To: {email.toAddress}
                    </span>
                  )}
                  {email.type === "received" && email.recipient && (
                    <span className="text-[11px] text-text-tertiary">
                      To: {email.recipient}
                    </span>
                  )}
                </div>
                {email.bodyHtml ? (
                  <div
                    className="prose prose-sm prose-invert max-w-none text-text-secondary"
                    dangerouslySetInnerHTML={{
                      __html: DOMPurify.sanitize(email.bodyHtml),
                    }}
                  />
                ) : (
                  <pre className="whitespace-pre-wrap text-xs text-text-secondary">
                    {email.bodyText || "(empty)"}
                  </pre>
                )}
                {email.type === "received" &&
                  email.attachments &&
                  email.attachments.length > 0 && (
                    <div className="mt-4 border-t border-border-dark pt-3">
                      <p className="mb-2 text-[11px] font-medium text-text-tertiary">
                        Attachments
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {email.attachments.map((att) => (
                          <a
                            key={att.id}
                            href={`/api/attachments/${att.id}`}
                            className="rounded border border-border-dark px-3 py-1.5 text-[11px] text-text-secondary hover:bg-hover"
                          >
                            {att.filename} ({Math.round(att.size / 1024)}KB)
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
              </div>
            )}
            <div className="h-px bg-border-dark" />
          </div>
        ))}
      </ScrollArea>
      <EnrollSequenceModal
        senderId={sender.id}
        senderName={sender.name}
        senderEmail={sender.email}
        open={enrollModalOpen}
        onClose={() => setEnrollModalOpen(false)}
        onEnrolled={refreshEnrollment}
      />
    </div>
  );
}
