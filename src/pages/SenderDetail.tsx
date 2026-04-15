import { useState, useEffect } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import ThreadSidebar from "@/components/ThreadSidebar";
import { MessageSquare } from "lucide-react";

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
  const [replyToEmailId, setReplyToEmailId] = useState<string | null>(null);
  const [threadOpen, setThreadOpen] = useState(false);

  function refetchEmails() {
    fetchSenderEmails(sender.id, {
      recipient: sender.recipient,
    }).then(setEmails);
  }

  useEffect(() => {
    setLoading(true);
    setReplyToEmailId(null);
    setThreadOpen(false);
    fetchSenderEmails(sender.id, { recipient: sender.recipient })
      .then(setEmails)
      .finally(() => setLoading(false));
  }, [sender.id, sender.recipient]);

  useEffect(() => {
    fetchSenderEnrollment(sender.id).then(setEnrollmentInfo);
  }, [sender.id]);

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
    if (
      !confirm(
        "Permanently delete this email and all its attachments? This cannot be undone.",
      )
    )
      return;
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

  // Latest email is first in the array (API returns newest first)
  const latestEmail = emails[0] ?? null;
  const threadEmails = emails.slice(1); // older emails for sidebar

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border-dark px-4 sm:px-6 py-3">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">
            {sender.name || sender.email}
          </h2>
          {sender.name && (
            <p className="text-xs text-text-secondary">{sender.email}</p>
          )}
          <p className="text-[11px] text-text-tertiary">
            &rarr; {sender.recipient} &middot; {sender.totalCount} email
            {sender.totalCount !== 1 ? "s" : ""}
          </p>
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

      {/* Conversation — main email + thread sidebar */}
      <div className="relative flex flex-1 overflow-hidden">
        {/* Main email area */}
        <div className="flex flex-1 flex-col min-w-0">
          <ScrollArea className="flex-1">
            {latestEmail ? (
              <div className="px-4 sm:px-6 py-4">
                {/* Thread indicator */}
                {threadEmails.length > 0 && (
                  <button
                    onClick={() => setThreadOpen(!threadOpen)}
                    className="mb-3 flex items-center gap-1.5 text-xs text-accent hover:underline"
                  >
                    <MessageSquare size={12} />
                    {threadEmails.length} earlier message
                    {threadEmails.length !== 1 ? "s" : ""}
                  </button>
                )}

                {/* Latest email display */}
                <MessageBubble
                  email={latestEmail}
                  senderEmail={sender.email}
                  onOpenHtml={setHtmlPreviewEmail}
                  onMarkRead={handleMarkRead}
                  onReply={setReplyToEmailId}
                  onDelete={handleDelete}
                />
              </div>
            ) : (
              <p className="py-4 text-center text-xs text-text-tertiary">
                No emails found.
              </p>
            )}
          </ScrollArea>

          {/* Reply Composer stays in main area */}
          {replyToEmailId && (
            <ReplyComposer
              emailId={replyToEmailId}
              senderName={sender.name}
              senderEmail={sender.email}
              recipients={[sender.recipient]}
              onClose={() => setReplyToEmailId(null)}
              onSent={refetchEmails}
            />
          )}
        </div>

        {/* Thread sidebar */}
        {threadOpen && threadEmails.length > 0 && (
          <ThreadSidebar
            emails={threadEmails}
            senderEmail={sender.email}
            onOpenHtml={setHtmlPreviewEmail}
            onMarkRead={handleMarkRead}
            onReply={setReplyToEmailId}
            onDelete={handleDelete}
            onClose={() => setThreadOpen(false)}
          />
        )}
      </div>

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
        recipients={[sender.recipient]}
        open={enrollModalOpen}
        onClose={() => setEnrollModalOpen(false)}
        onEnrolled={refreshEnrollment}
      />
    </div>
  );
}
