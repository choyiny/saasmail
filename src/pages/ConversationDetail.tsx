import { useState, useEffect, useMemo, useRef } from "react";
import { ArrowLeft, Users } from "lucide-react";
import {
  MailActionButtons,
  type MailActionHandlers,
  type MailStateLike,
} from "@/components/MailActions";
import MarkAllReadButton from "@/components/MarkAllReadButton";
import {
  fetchConversationEmails,
  markEmailRead,
  deleteEmail,
  type GroupedConversation,
  type Email,
  type ConversationDetail as ConversationDetailData,
} from "@/lib/api";
import EmailHtmlModal from "@/components/EmailHtmlModal";
import { type ThreadInboxGroup } from "@/components/ThreadInboxSection";
import ChatInboxSection from "@/components/ChatInboxSection";
import type { ComposePrefill } from "@/pages/ComposeModal";
import { onEmailSent } from "@/lib/email-events";
import { showToast } from "@/lib/toast";

interface ConversationDetailProps {
  conversation: GroupedConversation;
  refreshKey?: number;
  /** Domains we treat as "internal" for CC chip coloring. */
  internalDomains?: string[];
  /**
   * Called when the user clicks "open in full compose" inside a chat
   * thread — the chat section computes a prefill (from + to + cc +
   * subject) so the drawer opens with the reply context applied.
   */
  onOpenCompose?: (prefill?: ComposePrefill) => void;
  /** Star / pin / archive / snooze state and handlers for the header. */
  mailState?: MailStateLike;
  mailActions?: MailActionHandlers;
  /** Shows a back arrow in the header (mobile, table view). */
  onBack?: () => void;
}

function inboxLabel(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return email;
  return email.slice(0, at);
}

/**
 * Group-conversation timeline. Mirrors PersonDetail but for threads with
 * 2+ external participants — every bubble shows its actual sender, not
 * a single "person" identity.
 *
 * The conversation is scoped to one inbox (that's how groups are keyed),
 * so we don't show inbox tabs the way PersonDetail does.
 */
export default function ConversationDetail({
  conversation,
  refreshKey,
  internalDomains = [],
  onOpenCompose,
  mailState,
  mailActions,
  onBack,
}: ConversationDetailProps) {
  const [data, setData] = useState<ConversationDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [htmlPreviewEmail, setHtmlPreviewEmail] = useState<Email | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Only the response for the conversation on screen is applied; a slower
  // request from before the user switched rows is dropped.
  const currentIdRef = useRef(conversation.id);
  currentIdRef.current = conversation.id;

  function refetch() {
    const forId = conversation.id;
    fetchConversationEmails(forId).then((d) => {
      if (currentIdRef.current === forId) setData(d);
    });
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    fetchConversationEmails(conversation.id)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversation.id]);

  useEffect(() => {
    if (refreshKey) refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Listen for email-sent events so we can refetch immediately and
  // surface a toast if the user replied from a different inbox than
  // this conversation. Group conversation_ids are keyed by
  // (inbox, sorted-externals) — so a reply from a different inbox
  // lives in an entirely different conversation; the user needs to
  // know rather than wonder where their reply went.
  useEffect(() => {
    const off = onEmailSent((detail) => {
      refetch();
      if (
        detail.fromAddress.toLowerCase() !== conversation.inbox.toLowerCase()
      ) {
        showToast({
          kind: "warning",
          message: `Reply went to ${inboxLabel(detail.fromAddress)}`,
          description: `This thread is on ${inboxLabel(conversation.inbox)} — replies from another inbox start a new thread.`,
          durationMs: 6500,
        });
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.inbox, conversation.id]);

  async function handleMarkRead(email: Email) {
    if (email.type !== "received" || email.isRead !== 0) return;
    await markEmailRead(email.id, true);
    setData((prev) =>
      prev
        ? {
            ...prev,
            emails: prev.emails.map((e) =>
              e.id === email.id ? { ...e, isRead: 1 } : e,
            ),
          }
        : prev,
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
    setData((prev) =>
      prev
        ? {
            ...prev,
            emails: prev.emails.filter((e) => e.id !== emailId),
          }
        : prev,
    );
  }

  // Adapter: ChatInboxSection / ThreadInboxSection both expect a
  // ThreadInboxGroup (one inbox, newest-first emails). We only have one
  // inbox per conversation, so the adapter is straightforward — but the
  // section orders newest-first while the API returns chronological, so
  // we reverse here.
  const group: ThreadInboxGroup | null = useMemo(() => {
    if (!data) return null;
    const newestFirst = [...data.emails].reverse();
    const latestTimestamp = newestFirst[0]?.timestamp ?? 0;
    return {
      inbox: conversation.inbox,
      emails: newestFirst,
      latestTimestamp,
    };
  }, [data, conversation.inbox]);

  // Map personId → {name, email} so each bubble can resolve its actual
  // sender. The conversation endpoint already returns participants —
  // we just denormalize into a Map for O(1) lookup.
  const senderById = useMemo(() => {
    const m = new Map<string, { email: string; name: string | null }>();
    for (const p of conversation.participants) {
      m.set(p.id, { email: p.email, name: p.name });
    }
    return m;
  }, [conversation.participants]);

  if (loading || !data || !group) {
    return (
      <div
        className="flex h-full flex-col gap-4 p-5"
        aria-busy="true"
        aria-label="Loading conversation"
      >
        <span className="pt-skel h-5 w-1/3" />
        <span className="pt-skel h-3 w-1/4" />
        <span className="pt-skel mt-4 h-20 w-3/4 rounded-xl" />
        <span className="pt-skel ml-auto h-20 w-2/3 rounded-xl" />
      </div>
    );
  }

  const totalUnread = group.emails.filter(
    (e) => e.type === "received" && e.isRead === 0,
  ).length;

  const participantNames = conversation.participants
    .map((p) => p.name?.split(/\s+/)[0] ?? p.email.split("@")[0])
    .join(", ");

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Conversation header — names, inbox and meta; actions on the right. */}
      <div className="shrink-0 border-b border-border bg-card px-4 py-3 sm:px-5">
        <div className="flex items-start gap-3">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back to list"
              className="-ml-1.5 mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-muted hover:text-text-primary"
            >
              <ArrowLeft size={17} />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 truncate text-[17px] font-semibold leading-snug tracking-[-0.015em] text-text-primary">
              <Users size={16} className="shrink-0 text-text-secondary" />
              <span className="truncate">
                {participantNames || "Group conversation"}
              </span>
            </h2>
            <p className="tabular mt-0.5 truncate text-[13px] text-text-tertiary">
              <span className="text-text-secondary">
                {inboxLabel(conversation.inbox)}
              </span>
              {" · "}
              {data.emails.length} message
              {data.emails.length !== 1 ? "s" : ""}
              {" · "}
              {conversation.participants.length} participants
            </p>
          </div>
          {mailState && mailActions && (
            <MailActionButtons
              state={mailState}
              handlers={mailActions}
              className="-mr-1 shrink-0"
            />
          )}
        </div>
        {totalUnread > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <MarkAllReadButton
              unreadCount={totalUnread}
              scopeLabel={conversation.inbox}
              onMarkAllRead={() => {
                // Mark every unread received email read sequentially.
                for (const e of data.emails) {
                  if (e.type === "received" && e.isRead === 0) {
                    handleMarkRead(e);
                  }
                }
              }}
            />
          </div>
        )}
      </div>

      {/* The merged timeline. Use chat-mode by default for groups since it
          handles "rapid back-and-forth between multiple people" better than
          the thread-mode collapsed view. */}
      {/* Group conversations always render in chat mode. The reply
          path is the same as PersonDetail's chat path — ChatQuickReply
          inline, or "open in full compose" via onOpenCompose. */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col">
        <ChatInboxSection
          key={conversation.id}
          group={group}
          personEmail={conversation.participants[0]?.email ?? ""}
          internalDomains={internalDomains}
          senderResolver={(e) => {
            if (e.type === "sent") return null; // bubble shows "You"
            if (e.personId) {
              const r = senderById.get(e.personId);
              if (r) return r;
            }
            if (e.fromAddress) return { email: e.fromAddress, name: null };
            return null;
          }}
          onOpenHtml={setHtmlPreviewEmail}
          onMarkRead={handleMarkRead}
          onDelete={handleDelete}
          onSent={refetch}
          onOpenCompose={onOpenCompose}
        />
      </div>

      <EmailHtmlModal
        email={htmlPreviewEmail}
        open={htmlPreviewEmail !== null}
        onClose={() => setHtmlPreviewEmail(null)}
        onUpdated={refetch}
      />
    </div>
  );
}
