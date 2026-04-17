import { useState, useEffect, useMemo, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  fetchPersonEmails,
  markEmailRead,
  deleteEmail,
  fetchPersonEnrollment,
  fetchStats,
  type GroupedPerson,
  type Email,
  type PersonEnrollmentInfo,
  type InboxDisplayMode,
} from "@/lib/api";
import EnrollSequenceModal from "@/components/EnrollSequenceModal";
import SequenceStatus from "@/components/SequenceStatus";
import EmailHtmlModal from "@/components/EmailHtmlModal";
import ReplyComposer from "@/components/ReplyComposer";
import ThreadInboxSection, {
  type ThreadInboxGroup,
} from "@/components/ThreadInboxSection";
import ChatInboxSection from "@/components/ChatInboxSection";

interface PersonDetailProps {
  person: GroupedPerson;
}

// Each email is associated with an "inbox" address:
//   - received: the recipient address (who the sender wrote to)
//   - sent:     the fromAddress (which of our inboxes sent it)
function inboxOf(email: Email): string {
  return (
    (email.type === "received" ? email.recipient : email.fromAddress) ??
    "(unknown)"
  );
}

function groupEmailsByInbox(emails: Email[]): ThreadInboxGroup[] {
  const byInbox = new Map<string, Email[]>();
  for (const email of emails) {
    const key = inboxOf(email);
    const list = byInbox.get(key);
    if (list) list.push(email);
    else byInbox.set(key, [email]);
  }
  const groups: ThreadInboxGroup[] = [];
  for (const [inbox, list] of byInbox) {
    // Emails come newest-first from the API; keep that order within a group.
    groups.push({
      inbox,
      emails: list,
      latestTimestamp: list[0]?.timestamp ?? 0,
    });
  }
  // Sort inbox groups by most recent activity.
  groups.sort((a, b) => b.latestTimestamp - a.latestTimestamp);
  return groups;
}

export default function PersonDetail({ person }: PersonDetailProps) {
  const [emails, setEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(true);
  const [enrollModalOpen, setEnrollModalOpen] = useState(false);
  const [enrollmentInfo, setEnrollmentInfo] =
    useState<PersonEnrollmentInfo | null>(null);
  const [htmlPreviewEmail, setHtmlPreviewEmail] = useState<Email | null>(null);
  const [replyToEmailId, setReplyToEmailId] = useState<string | null>(null);
  const [expandedOlder, setExpandedOlder] = useState<Record<string, boolean>>(
    {},
  );
  const [inboxModeMap, setInboxModeMap] = useState<
    Map<string, InboxDisplayMode>
  >(new Map());
  const [senderIdentities, setSenderIdentities] = useState<
    Array<{ email: string; displayName: string }>
  >([]);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  function refetchEmails() {
    fetchPersonEmails(person.id).then((res) => {
      setEmails(res.emails);
      setInboxModeMap(
        new Map(res.inboxes.map((i) => [i.email, i.displayMode])),
      );
    });
  }

  useEffect(() => {
    setLoading(true);
    setReplyToEmailId(null);
    setExpandedOlder({});
    fetchPersonEmails(person.id)
      .then((res) => {
        setEmails(res.emails);
        setInboxModeMap(
          new Map(res.inboxes.map((i) => [i.email, i.displayMode])),
        );
      })
      .finally(() => setLoading(false));
  }, [person.id]);

  // Auto-scroll to latest (bottom) whenever the email list or expansion changes
  useEffect(() => {
    if (loading) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [emails, expandedOlder, loading]);

  useEffect(() => {
    fetchPersonEnrollment(person.id).then(setEnrollmentInfo);
  }, [person.id]);

  useEffect(() => {
    fetchStats().then((stats) => {
      setSenderIdentities(stats.senderIdentities ?? []);
    });
  }, []);

  function refreshEnrollment() {
    fetchPersonEnrollment(person.id).then(setEnrollmentInfo);
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

  const inboxGroups = useMemo(() => groupEmailsByInbox(emails), [emails]);
  const distinctInboxes = useMemo(
    () => inboxGroups.map((g) => g.inbox).filter((i) => i !== "(unknown)"),
    [inboxGroups],
  );
  const replyInboxForEmail = (email: Email) => {
    const ib = inboxOf(email);
    return ib === "(unknown)" ? distinctInboxes : [ib];
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-tertiary">
        Loading...
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border px-4 sm:px-6 py-3">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">
            {person.name || person.email}
          </h2>
          {person.name && (
            <p className="text-xs text-text-secondary">{person.email}</p>
          )}
          <p className="text-[11px] text-text-tertiary">
            {person.totalCount} email{person.totalCount !== 1 ? "s" : ""}
            {inboxGroups.length > 1
              ? ` across ${inboxGroups.length} inboxes`
              : ""}
          </p>
        </div>
      </div>

      {/* Sequence status */}
      <div className="border-b border-border px-4 sm:px-6 py-2">
        {enrollmentInfo?.enrollment ? (
          <SequenceStatus
            personId={person.id}
            onStatusChange={refreshEnrollment}
          />
        ) : (
          <button
            onClick={() => setEnrollModalOpen(true)}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-muted"
          >
            Add to Sequence
          </button>
        )}
      </div>

      {/* Conversation — grouped by inbox */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        <ScrollArea className="flex-1">
          {inboxGroups.length === 0 ? (
            <p className="py-4 text-center text-xs text-text-tertiary">
              No emails found.
            </p>
          ) : (
            inboxGroups.map((group) => {
              const mode = inboxModeMap.get(group.inbox) ?? "thread";
              if (mode === "chat") {
                return (
                  <ChatInboxSection
                    key={group.inbox}
                    group={group}
                    personEmail={person.email}
                    onOpenHtml={setHtmlPreviewEmail}
                    onMarkRead={handleMarkRead}
                    onDelete={handleDelete}
                    onSent={refetchEmails}
                  />
                );
              }
              return (
                <ThreadInboxSection
                  key={group.inbox}
                  group={group}
                  personEmail={person.email}
                  isOlderExpanded={!!expandedOlder[group.inbox]}
                  onToggleOlder={() =>
                    setExpandedOlder((prev) => ({
                      ...prev,
                      [group.inbox]: !prev[group.inbox],
                    }))
                  }
                  onOpenHtml={setHtmlPreviewEmail}
                  onMarkRead={handleMarkRead}
                  onReply={setReplyToEmailId}
                  onDelete={handleDelete}
                />
              );
            })
          )}
          <div ref={bottomRef} />
        </ScrollArea>

        {/* Reply Composer */}
        {replyToEmailId && (
          <ReplyComposer
            emailId={replyToEmailId}
            personName={person.name}
            personEmail={person.email}
            recipients={(() => {
              const target = emails.find((e) => e.id === replyToEmailId);
              return target ? replyInboxForEmail(target) : distinctInboxes;
            })()}
            senderIdentities={senderIdentities}
            onClose={() => setReplyToEmailId(null)}
            onSent={refetchEmails}
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
        personId={person.id}
        personName={person.name}
        personEmail={person.email}
        recipients={distinctInboxes}
        open={enrollModalOpen}
        onClose={() => setEnrollModalOpen(false)}
        onEnrolled={refreshEnrollment}
      />
    </div>
  );
}
