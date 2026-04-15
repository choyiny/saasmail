import { useState, useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  fetchSenderEmails,
  markEmailRead,
  deleteEmail,
  fetchSenderEnrollment,
  type Sender,
  type Email,
  type SenderEnrollmentInfo,
} from "@/lib/api";
import EnrollSequenceModal from "@/components/EnrollSequenceModal";
import SequenceStatus from "@/components/SequenceStatus";
import MessageBubble from "@/components/MessageBubble";
import EmailHtmlModal from "@/components/EmailHtmlModal";
import ReplyComposer from "@/components/ReplyComposer";

interface SenderDetailProps {
  sender: Sender;
}

export default function SenderDetail({ sender }: SenderDetailProps) {
  const [emails, setEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(true);
  const [enrollModalOpen, setEnrollModalOpen] = useState(false);
  const [enrollmentInfo, setEnrollmentInfo] =
    useState<SenderEnrollmentInfo | null>(null);
  const [htmlPreviewEmail, setHtmlPreviewEmail] = useState<Email | null>(null);
  const [recipientFilter, setRecipientFilter] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [replyToEmailId, setReplyToEmailId] = useState<string | null>(null);

  // Collect unique recipient addresses from emails
  const recipients = Array.from(
    new Set(
      emails
        .map((e) => (e.type === "received" ? e.recipient : e.toAddress))
        .filter(Boolean) as string[],
    ),
  );

  function refetchEmails() {
    fetchSenderEmails(sender.id, {
      recipient: recipientFilter || undefined,
    }).then(setEmails);
  }

  useEffect(() => {
    setLoading(true);
    setRecipientFilter("");
    setReplyToEmailId(null);
    fetchSenderEmails(sender.id)
      .then((data) => {
        setEmails(data);
      })
      .finally(() => setLoading(false));
  }, [sender.id]);

  useEffect(() => {
    fetchSenderEnrollment(sender.id).then(setEnrollmentInfo);
  }, [sender.id]);

  // Refetch when recipient filter changes
  useEffect(() => {
    if (!sender.id) return;
    setLoading(true);
    fetchSenderEmails(sender.id, {
      recipient: recipientFilter || undefined,
    })
      .then(setEmails)
      .finally(() => setLoading(false));
  }, [recipientFilter, sender.id]);

  function refreshEnrollment() {
    fetchSenderEnrollment(sender.id).then(setEnrollmentInfo);
  }

  async function handleMarkRead(email: Email) {
    if (email.type !== "received" || email.isRead !== 0) return;
    await markEmailRead(email.id, true);
    setEmails((prev) =>
      prev.map((e) => (e.id === email.id ? { ...e, isRead: 1 } : e)),
    );
  }

  async function handleDelete(emailId: string) {
    if (!confirm("Permanently delete this email and all its attachments? This cannot be undone.")) return;
    await deleteEmail(emailId);
    setEmails((prev) => prev.filter((e) => e.id !== emailId));
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-tertiary">
        Loading...
      </div>
    );
  }

  // Reverse emails for chronological (oldest first) display
  const chronologicalEmails = [...emails].reverse();

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border-dark px-4 sm:px-6 py-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
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
          {/* Recipient filter */}
          {recipients.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="rounded-md border border-border-dark px-3 py-1.5 text-xs text-text-secondary hover:bg-hover">
                  {recipientFilter || "All addresses"}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="bg-card border-border-dark text-text-primary">
                <DropdownMenuItem
                  onClick={() => setRecipientFilter("")}
                  className="text-xs text-text-secondary focus:bg-hover focus:text-text-primary"
                >
                  All addresses
                </DropdownMenuItem>
                {recipients.map((r) => (
                  <DropdownMenuItem
                    key={r}
                    onClick={() => setRecipientFilter(r)}
                    className="text-xs text-text-secondary focus:bg-hover focus:text-text-primary"
                  >
                    {r}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Sequence status */}
      <div className="border-b border-border-dark px-4 sm:px-6 py-2">
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

      {/* Conversation */}
      <ScrollArea className="flex-1">
        <div className="divide-y divide-border-dark" ref={scrollRef}>
          {chronologicalEmails.length === 0 ? (
            <p className="py-4 text-center text-xs text-text-tertiary">
              No emails found.
            </p>
          ) : (
            chronologicalEmails.map((email) => (
              <MessageBubble
                key={email.id}
                email={email}
                senderEmail={sender.email}
                onOpenHtml={setHtmlPreviewEmail}
                onMarkRead={handleMarkRead}
                onReply={setReplyToEmailId}
                onDelete={handleDelete}
              />
            ))
          )}
        </div>
      </ScrollArea>

      {/* Reply Composer */}
      {replyToEmailId && (
        <ReplyComposer
          emailId={replyToEmailId}
          senderName={sender.name}
          senderEmail={sender.email}
          recipients={recipients}
          onClose={() => setReplyToEmailId(null)}
          onSent={refetchEmails}
        />
      )}

      {/* HTML Preview Modal */}
      <EmailHtmlModal
        email={htmlPreviewEmail}
        open={htmlPreviewEmail !== null}
        onClose={() => setHtmlPreviewEmail(null)}
      />

      {/* Sequence Enrollment Modal */}
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
