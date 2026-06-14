import { Fragment } from "react";
import { MessageSquare, Inbox } from "lucide-react";
import MessageBubble from "@/components/MessageBubble";
import { RosterDiffNotice } from "@/components/CcChips";
import { rosterOf } from "@/lib/roster";
import type { Email } from "@/lib/api";

export interface ThreadInboxGroup {
  inbox: string;
  emails: Email[]; // newest first
  latestTimestamp: number;
}

interface ThreadInboxSectionProps {
  group: ThreadInboxGroup;
  personEmail: string;
  internalDomains?: string[];
  /**
   * Per-bubble sender override — used in group conversations where
   * each bubble has a different sender.
   */
  senderResolver?: (
    email: Email,
  ) => { email: string; name: string | null } | null;
  isOlderExpanded: boolean;
  onToggleOlder: () => void;
  onOpenHtml: (email: Email) => void;
  onMarkRead: (email: Email) => void;
  onReply: (emailId: string) => void;
  onDelete: (emailId: string) => void;
  onReassign?: (email: Email) => void;
}

export default function ThreadInboxSection({
  group,
  personEmail,
  internalDomains = [],
  senderResolver,
  isOlderExpanded,
  onToggleOlder,
  onOpenHtml,
  onMarkRead,
  onReply,
  onDelete,
  onReassign,
}: ThreadInboxSectionProps) {
  // Within a group, emails arrive newest-first. Show the latest expanded (HTML)
  // and collapse older messages behind a toggle.
  const latest = group.emails[0];
  const olderChronological = group.emails.slice(1).reverse();

  return (
    <section className="border-b-4 border-border-subtle">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-bg-subtle px-4 sm:px-6 py-2">
        <Inbox size={12} className="text-text-tertiary" />
        <span className="text-[11px] font-medium text-text-secondary">
          {group.inbox}
        </span>
        <span className="text-[11px] text-text-tertiary">
          · {group.emails.length} email{group.emails.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="divide-y divide-border-subtle">
        {olderChronological.length > 0 && (
          <div className="px-4 sm:px-6 py-2">
            <button
              onClick={onToggleOlder}
              className="flex items-center gap-1.5 text-xs text-accent hover:underline"
            >
              <MessageSquare size={12} />
              {isOlderExpanded ? "Hide" : "Show"} {olderChronological.length}{" "}
              previous message{olderChronological.length !== 1 ? "s" : ""}
            </button>
          </div>
        )}
        {isOlderExpanded &&
          olderChronological.map((email, idx) => {
            const prev = olderChronological[idx - 1];
            return (
              <Fragment key={email.id}>
                {prev && (
                  <RosterDiffNotice
                    prev={rosterOf(prev, senderResolver)}
                    next={rosterOf(email, senderResolver)}
                    internalDomains={internalDomains}
                  />
                )}
                <MessageBubble
                  email={email}
                  personEmail={personEmail}
                  internalDomains={internalDomains}
                  senderResolver={senderResolver}
                  onOpenHtml={onOpenHtml}
                  onMarkRead={onMarkRead}
                  onReply={onReply}
                  onDelete={onDelete}
                  onReassign={onReassign}
                />
              </Fragment>
            );
          })}
        {latest && (
          <Fragment>
            {/* Roster diff between the last "older" email shown and the latest */}
            {isOlderExpanded && olderChronological.length > 0 && (
              <RosterDiffNotice
                prev={rosterOf(
                  olderChronological[olderChronological.length - 1],
                  senderResolver,
                )}
                next={rosterOf(latest, senderResolver)}
                internalDomains={internalDomains}
              />
            )}
            <MessageBubble
              key={latest.id}
              email={latest}
              personEmail={personEmail}
              internalDomains={internalDomains}
              senderResolver={senderResolver}
              onOpenHtml={onOpenHtml}
              onMarkRead={onMarkRead}
              onReply={onReply}
              onDelete={onDelete}
              onReassign={onReassign}
              renderHtml
            />
          </Fragment>
        )}
      </div>
    </section>
  );
}
