import { useState, useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { CheckCheck, ShieldBan } from "lucide-react";
import {
  fetchPersonEmails,
  markEmailRead,
  markPeopleRead,
  deleteEmail,
  fetchPersonEnrollment,
  fetchStats,
  addBlock,
  type GroupedPerson,
  type Email,
  type PersonEnrollmentInfo,
  type InboxDisplayMode,
  type ReassignPersonResult,
} from "@/lib/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { messageDomId, readMessageHash } from "@/lib/message-link";
import EnrollSequenceModal from "@/components/EnrollSequenceModal";
import ReassignPersonModal from "@/components/ReassignPersonModal";
import SequenceStatus from "@/components/SequenceStatus";
import EmailHtmlModal from "@/components/EmailHtmlModal";
import ReplyComposer from "@/components/ReplyComposer";
import ThreadInboxSection, {
  type ThreadInboxGroup,
} from "@/components/ThreadInboxSection";
import ChatInboxSection from "@/components/ChatInboxSection";
import type { ComposePrefill } from "@/pages/ComposeModal";
import { onEmailSent } from "@/lib/email-events";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

interface PersonDetailProps {
  person: GroupedPerson;
  onEmailRead: (personId: string) => void;
  onEmailDelete: (personId: string, wasUnread: boolean) => void;
  refreshKey?: number;
  /**
   * Called when the user clicks "open in full compose" inside a chat
   * thread — the chat section computes a prefill (from + to + cc +
   * subject) so the drawer opens with the reply context applied.
   */
  onOpenCompose?: (prefill?: ComposePrefill) => void;
}

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
    const latestReceivedTs =
      list.find((e) => e.type === "received")?.timestamp ?? 0;
    const latestAnyTs = list[0]?.timestamp ?? 0;
    groups.push({
      inbox,
      emails: list,
      latestTimestamp: latestReceivedTs || latestAnyTs,
    });
  }
  groups.sort((a, b) => b.latestTimestamp - a.latestTimestamp);
  return groups;
}

function inboxColor(seed: string) {
  // Stable but per-inbox accent so the active tab feels distinct.
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const palette = [
    "#7c5cfc",
    "#0f766e",
    "#0369a1",
    "#a16207",
    "#be185d",
    "#7e22ce",
  ];
  return palette[h % palette.length];
}

function unreadIn(group: ThreadInboxGroup): number {
  return group.emails.filter((e) => e.type === "received" && e.isRead === 0)
    .length;
}

/** Strip the @domain — every inbox shares the same domain, so the tab
 *  just shows the local-part (e.g., "support" instead of "support@example.com").
 *  Falls back to the full string if there's no @. */
function inboxLabel(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return email;
  return email.slice(0, at);
}

export default function PersonDetail({
  person,
  onEmailRead,
  onEmailDelete,
  refreshKey,
  onOpenCompose,
}: PersonDetailProps) {
  const navigate = useNavigate();
  const [emails, setEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(true);
  const [enrollModalOpen, setEnrollModalOpen] = useState(false);
  const [enrollmentInfo, setEnrollmentInfo] =
    useState<PersonEnrollmentInfo | null>(null);
  const [htmlPreviewEmail, setHtmlPreviewEmail] = useState<Email | null>(null);
  const [reassignEmail, setReassignEmail] = useState<Email | null>(null);
  const [replyToEmailId, setReplyToEmailId] = useState<string | null>(null);
  const [expandedOlder, setExpandedOlder] = useState<Record<string, boolean>>(
    {},
  );
  const [inboxModeMap, setInboxModeMap] = useState<
    Map<string, InboxDisplayMode>
  >(new Map());
  const [senderIdentities, setSenderIdentities] = useState<
    Array<{ email: string; displayName: string | null }>
  >([]);
  const [activeInbox, setActiveInbox] = useState<string | null>(null);

  async function handleBlock(type: "email" | "domain") {
    const email = person.email.toLowerCase();
    const value =
      type === "email" ? email : email.slice(email.lastIndexOf("@") + 1);
    if (!value) return;
    try {
      await addBlock({ type, value });
      navigate("/"); // thread is now hidden; return to the inbox
    } catch {
      // Most likely a self-block guard rejection; leave the user on the thread.
    }
  }

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
    setActiveInbox(null);
    fetchPersonEmails(person.id)
      .then((res) => {
        setEmails(res.emails);
        setInboxModeMap(
          new Map(res.inboxes.map((i) => [i.email, i.displayMode])),
        );
      })
      .finally(() => setLoading(false));
  }, [person.id]);

  useEffect(() => {
    if (refreshKey) refetchEmails();
  }, [refreshKey]);

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
    onEmailRead(person.id);
  }

  async function handleMarkInboxRead(inboxAddress: string) {
    // Optimistic local update on the active inbox's emails.
    setEmails((prev) =>
      prev.map((e) =>
        e.recipient === inboxAddress && e.type === "received" && e.isRead === 0
          ? { ...e, isRead: 1 }
          : e,
      ),
    );
    try {
      await markPeopleRead([person.id], inboxAddress);
      onEmailRead(person.id);
    } catch {
      refetchEmails();
    }
  }

  async function handleDelete(emailId: string) {
    if (
      !confirm(
        "Permanently delete this email and all its attachments? This cannot be undone.",
      )
    )
      return;
    const target = emails.find((e) => e.id === emailId);
    const wasUnread = target?.type === "received" && target.isRead === 0;
    await deleteEmail(emailId);
    setEmails((prev) => prev.filter((e) => e.id !== emailId));
    onEmailDelete(person.id, wasUnread);
  }

  function handleReassignDone(result: ReassignPersonResult) {
    const moved = reassignEmail;
    if (moved) {
      const wasUnread = moved.type === "received" && moved.isRead === 0;
      // The message now belongs to another person — drop it from this thread
      // and let the parent decrement this person's counts (same as a delete
      // from this view's perspective).
      setEmails((prev) => prev.filter((e) => e.id !== moved.id));
      onEmailDelete(person.id, wasUnread);
    }
    const target = result.person?.email ?? result.email.toAddress;
    showToast({
      kind: "success",
      message: target ? `Moved to ${target}` : "Message re-targeted",
      description: result.person?.created
        ? "Created a new person and moved this message to them."
        : "Replies to this message now go to them.",
      durationMs: 5000,
    });
  }

  const inboxGroups = useMemo(() => groupEmailsByInbox(emails), [emails]);
  const distinctInboxes = useMemo(
    () => inboxGroups.map((g) => g.inbox).filter((i) => i !== "(unknown)"),
    [inboxGroups],
  );

  // Domains we own — used to flag internal vs external CC contacts.
  // Pulled from sender_identities (the inboxes the operator has set up).
  const internalDomains = useMemo(() => {
    const set = new Set<string>();
    for (const s of senderIdentities) {
      const at = s.email.lastIndexOf("@");
      if (at >= 0) set.add(s.email.slice(at + 1).toLowerCase());
    }
    return Array.from(set);
  }, [senderIdentities]);

  // Auto-pick the first (most-recent) inbox as active when person/emails load.
  useEffect(() => {
    if (inboxGroups.length === 0) {
      setActiveInbox(null);
      return;
    }
    if (!activeInbox || !inboxGroups.find((g) => g.inbox === activeInbox)) {
      setActiveInbox(inboxGroups[0].inbox);
    }
  }, [inboxGroups, activeInbox]);

  // Deep-link landing: if the URL has `#m=<emailId>` and that message
  // belongs to this person, switch to its inbox tab, auto-expand the
  // older-messages drawer when needed (thread mode), and scroll/flash
  // the bubble. Fires once per (person, hash) pair so paging or
  // re-renders don't keep yanking the scroll position.
  const location = useLocation();
  const lastHashHandled = useRef<string | null>(null);
  useEffect(() => {
    if (emails.length === 0) return;
    const targetEmailId = readMessageHash(location.hash);
    if (!targetEmailId) return;
    const key = `${person.id}:${targetEmailId}`;
    if (lastHashHandled.current === key) return;
    const target = emails.find((e) => e.id === targetEmailId);
    if (!target) return;
    lastHashHandled.current = key;

    const targetInbox = inboxOf(target);
    setActiveInbox(targetInbox);

    // Thread mode collapses older messages behind a toggle. If the
    // target isn't the latest in its group, force the drawer open so
    // the bubble is actually in the DOM when we try to scroll to it.
    const group = inboxGroups.find((g) => g.inbox === targetInbox);
    if (group && group.emails[0]?.id !== target.id) {
      setExpandedOlder((prev) =>
        prev[targetInbox] ? prev : { ...prev, [targetInbox]: true },
      );
    }

    // Two rAFs: first lets React commit the tab switch / expand; second
    // lets the new bubble mount before we measure for scrollIntoView.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.getElementById(messageDomId(target.id));
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.remove("message-link-flash");
        // Reflow so re-adding the class restarts the animation.
        void el.offsetWidth;
        el.classList.add("message-link-flash");
        window.setTimeout(() => {
          el.classList.remove("message-link-flash");
        }, 2400);
      });
    });
  }, [emails, location.hash, inboxGroups, person.id]);

  // Listen for the global "email sent" event so we can:
  //   1) Refetch emails immediately — already happens via the existing
  //      onSent callbacks in compose surfaces, but the event-based path
  //      catches sends initiated from anywhere (FAB compose, chat
  //      quick reply, reply drawer).
  //   2) Auto-switch the active inbox tab when the user replied from a
  //      different inbox than the one they were viewing — otherwise the
  //      sent message lands in a tab they aren't looking at and they
  //      have no clue what happened.
  //   3) Toast the user so they have an artifact telling them where the
  //      reply landed.
  useEffect(() => {
    const off = onEmailSent((detail) => {
      // Always refetch — picks up the new sent_emails row.
      refetchEmails();
      const sentInbox = detail.fromAddress;
      // We only act on this person's inbox tabs. Compose-from-FAB to a
      // different person fires the same event but isn't relevant here.
      const isOurInbox = distinctInboxes.includes(sentInbox);
      if (!isOurInbox) return;
      const previous = activeInbox;
      if (previous && previous !== sentInbox) {
        setActiveInbox(sentInbox);
        showToast({
          kind: "info",
          message: `Reply landed in ${inboxLabel(sentInbox)}`,
          description: `You were viewing ${inboxLabel(previous)} — switched tabs so you can see it.`,
          durationMs: 5500,
        });
      }
    });
    return off;
    // We intentionally close over the latest activeInbox + inbox list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeInbox, distinctInboxes.join("|")]);

  const activeGroup =
    inboxGroups.find((g) => g.inbox === activeInbox) ?? inboxGroups[0] ?? null;

  const replyInboxForEmail = (email: Email) => {
    const ib = inboxOf(email);
    return ib === "(unknown)" ? distinctInboxes : [ib];
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-tertiary">
        <span className="text-sm">Loading…</span>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Person header — name + email + meta on a single visual block */}
      <div className="shrink-0 border-b border-border bg-card px-4 pb-2.5 pt-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h2 className="truncate text-base font-extrabold tracking-tight text-text-primary">
              {person.name || person.email}
            </h2>
            {person.name && (
              <span className="truncate text-xs font-light text-text-tertiary">
                {person.email}
              </span>
            )}
            <span className="text-[11px] text-text-tertiary">
              · {person.totalCount} message
              {person.totalCount !== 1 ? "s" : ""}
              {inboxGroups.length > 1 ? ` · ${inboxGroups.length} inboxes` : ""}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {enrollmentInfo?.enrollment ? (
              <SequenceStatus
                personId={person.id}
                onStatusChange={refreshEnrollment}
              />
            ) : (
              <button
                onClick={() => setEnrollModalOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-[6px] border border-border bg-card px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
              >
                Add to sequence
              </button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  aria-label="Block sender"
                  className="inline-flex items-center gap-1.5 rounded-[6px] border border-border bg-card px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-rose-50 hover:text-rose-600"
                >
                  <ShieldBan size={13} />
                  Block
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => handleBlock("email")}
                >
                  Block {person.email}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => handleBlock("domain")}
                >
                  Block entire domain
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Inbox tabs — short label (local-part only), counts + mode dot.
          Tooltip on the tab shows the full address.
          On mobile: horizontal scroll with snap (native-app feel).
          On desktop: wraps onto multiple lines. */}
      {inboxGroups.length > 0 && (
        <div className="shrink-0 border-b border-border bg-card/60">
          <div
            className="smooth-scroll flex gap-0.5 overflow-x-auto px-2 py-1 sm:flex-wrap sm:overflow-visible"
            style={{ scrollSnapType: "x proximity" }}
          >
            {inboxGroups.map((group) => {
              const mode = inboxModeMap.get(group.inbox) ?? "chat";
              const unread = unreadIn(group);
              const isActive = activeGroup?.inbox === group.inbox;
              const accent = inboxColor(group.inbox);
              const label = inboxLabel(group.inbox);
              return (
                <button
                  key={group.inbox}
                  data-testid="inbox-tab"
                  onClick={() => setActiveInbox(group.inbox)}
                  title={`${group.inbox} · ${mode} mode`}
                  style={{ scrollSnapAlign: "start" }}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 rounded-[5px] px-2 py-1 text-xs transition-all",
                    isActive
                      ? "bg-text-primary/[0.05] text-text-primary ring-1 ring-text-primary/10"
                      : "text-text-secondary hover:bg-bg-muted/70 hover:text-text-primary",
                  )}
                >
                  {/* Mode-aware accent dot — color stable per inbox */}
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      mode === "chat" ? "" : "opacity-60",
                    )}
                    style={{ backgroundColor: accent }}
                    aria-hidden
                  />
                  <span className="font-medium">{label}</span>
                  <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-bg-muted px-1 text-[10px] font-semibold tabular-nums text-text-secondary">
                    {group.emails.length}
                  </span>
                  {unread > 0 && (
                    <span
                      className="inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold tabular-nums text-white"
                      style={{ backgroundColor: "#7c5cfc" }}
                      aria-label={`${unread} unread`}
                    >
                      {unread}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Per-inbox action row — visible when the active tab has unread emails */}
      {activeGroup && unreadIn(activeGroup) > 0 && (
        <div className="shrink-0 border-b border-border bg-bg-subtle/40 px-4 py-2">
          <button
            type="button"
            onClick={() => handleMarkInboxRead(activeGroup.inbox)}
            className="inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
          >
            <CheckCheck size={12} />
            Mark all in {inboxLabel(activeGroup.inbox)} as read
            <span className="ml-1 rounded-full bg-text-primary/[0.06] px-1.5 text-[10px] font-bold tabular-nums text-text-secondary">
              {unreadIn(activeGroup)}
            </span>
          </button>
        </div>
      )}

      {/* Active inbox section — fills remaining height */}
      <div className="flex min-h-0 flex-1 flex-col">
        {activeGroup ? (
          (() => {
            const mode = inboxModeMap.get(activeGroup.inbox) ?? "chat";
            if (mode === "chat") {
              return (
                <ChatInboxSection
                  key={activeGroup.inbox}
                  group={activeGroup}
                  personEmail={person.email}
                  internalDomains={internalDomains}
                  onOpenHtml={setHtmlPreviewEmail}
                  onMarkRead={handleMarkRead}
                  onDelete={handleDelete}
                  onReassign={setReassignEmail}
                  onSent={refetchEmails}
                  onOpenCompose={onOpenCompose}
                />
              );
            }
            return (
              <ThreadPaneScroller key={activeGroup.inbox}>
                <ThreadInboxSection
                  group={activeGroup}
                  personEmail={person.email}
                  internalDomains={internalDomains}
                  isOlderExpanded={!!expandedOlder[activeGroup.inbox]}
                  onToggleOlder={() =>
                    setExpandedOlder((prev) => ({
                      ...prev,
                      [activeGroup.inbox]: !prev[activeGroup.inbox],
                    }))
                  }
                  onOpenHtml={setHtmlPreviewEmail}
                  onMarkRead={handleMarkRead}
                  onReply={setReplyToEmailId}
                  onDelete={handleDelete}
                  onReassign={setReassignEmail}
                />
              </ThreadPaneScroller>
            );
          })()
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-text-tertiary">
            No emails found.
          </div>
        )}

        {/* Reply composer (thread mode) */}
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
            internalDomains={internalDomains}
            onClose={() => setReplyToEmailId(null)}
            onSent={refetchEmails}
          />
        )}
      </div>

      <EmailHtmlModal
        email={htmlPreviewEmail}
        open={htmlPreviewEmail !== null}
        onClose={() => setHtmlPreviewEmail(null)}
        onUpdated={refetchEmails}
      />

      <ReassignPersonModal
        email={reassignEmail}
        currentSender={person.name || person.email}
        open={reassignEmail !== null}
        onClose={() => setReassignEmail(null)}
        onDone={handleReassignDone}
      />

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

/** Scroll wrapper for thread-mode inbox content. */
function ThreadPaneScroller({ children }: { children: React.ReactNode }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  return (
    <div
      ref={scrollRef}
      className="smooth-scroll min-h-0 flex-1 overflow-y-auto"
    >
      {children}
    </div>
  );
}
