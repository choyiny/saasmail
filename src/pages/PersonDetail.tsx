import { useState, useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, Link2, ListPlus, ShieldBan, X } from "lucide-react";
import {
  fetchPersonEmails,
  markEmailRead,
  markPeopleRead,
  deleteEmail,
  fetchPersonEnrollment,
  fetchStats,
  addBlock,
  fetchCustomerByPerson,
  fetchPeople,
  linkCustomerPeople,
  unlinkCustomerPerson,
  type Customer,
  type Person,
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
import PersonListMemberships from "@/components/PersonListMemberships";
import ReassignPersonModal from "@/components/ReassignPersonModal";
import SequenceStatus from "@/components/SequenceStatus";
import EmailHtmlModal from "@/components/EmailHtmlModal";
import ReplyComposer from "@/components/ReplyComposer";
import SuggestedReplyCard from "@/components/SuggestedReplyCard";
import ThreadInboxSection, {
  type ThreadInboxGroup,
} from "@/components/ThreadInboxSection";
import ChatInboxSection from "@/components/ChatInboxSection";
import MarkAllReadButton from "@/components/MarkAllReadButton";
import type { ComposePrefill } from "@/pages/ComposeModal";
import { onEmailSent } from "@/lib/email-events";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useAgentContext } from "@/agent/AgentContext";
import {
  MailActionButtons,
  type MailActionHandlers,
  type MailStateLike,
} from "@/components/MailActions";
import { Button } from "@/components/ui/button";

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
  /**
   * Called after the sender (or their whole domain) is blocked. The parent
   * uses this to clear the current selection so the view falls back to
   * "no mail selected" — the thread is now hidden from the inbox.
   */
  onBlock?: () => void;
  /** Star / pin / archive / snooze state and handlers for the header. */
  mailState?: MailStateLike;
  mailActions?: MailActionHandlers;
  /** Shows a back arrow in the header (mobile, table view). */
  onBack?: () => void;
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
  return `var(--sm-av-${(h % 8) + 1}-fg)`;
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
  onBlock,
  mailState,
  mailActions,
  onBack,
}: PersonDetailProps) {
  const navigate = useNavigate();
  const { publish: publishAgentContext, clear: clearAgentContext } =
    useAgentContext();
  const [emails, setEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(true);
  const [enrollModalOpen, setEnrollModalOpen] = useState(false);
  const [enrollmentInfo, setEnrollmentInfo] =
    useState<PersonEnrollmentInfo | null>(null);
  const [htmlPreviewEmail, setHtmlPreviewEmail] = useState<Email | null>(null);
  const [reassignEmail, setReassignEmail] = useState<Email | null>(null);
  const [replyToEmailId, setReplyToEmailId] = useState<string | null>(null);
  const [replyComposerKey, setReplyComposerKey] = useState(0);
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
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [allAddresses, setAllAddresses] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkQuery, setLinkQuery] = useState("");
  const [linkResults, setLinkResults] = useState<Person[]>([]);
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  async function handleBlock(type: "email" | "domain") {
    const email = person.email.toLowerCase();
    const value =
      type === "email" ? email : email.slice(email.lastIndexOf("@") + 1);
    if (!value) return;
    try {
      await addBlock({ type, value });
      showToast({
        kind: "success",
        message: `Blocked ${value}`,
        description:
          type === "domain"
            ? "Future mail from this domain is dropped and its threads are hidden."
            : "Future mail from this address is dropped and its threads are hidden.",
        durationMs: 5000,
      });
      // The thread is now hidden. Clear the parent's selection so the view
      // falls back to "no mail selected"; fall back to a route change when
      // the component is used standalone.
      if (onBlock) onBlock();
      else navigate("/");
    } catch {
      // Most likely a self-block guard rejection; leave the user on the
      // thread, but tell them the block didn't go through.
      showToast({
        kind: "error",
        message: "Couldn't block",
        description:
          type === "domain"
            ? "This domain couldn't be blocked. It may be one of your own."
            : "This address couldn't be blocked. It may be one of your own.",
      });
    }
  }

  // The person whose emails should be on screen. Responses for any other
  // person (a slower request from before the user switched rows) are
  // dropped, so a reply can never target the previous person's email.
  const currentPersonRef = useRef(person.id);
  currentPersonRef.current = person.id;

  async function refetchEmails(useAllAddresses = allAddresses) {
    const forId = person.id;
    const res = await fetchPersonEmails(forId, {
      allAddresses: useAllAddresses,
    });
    if (currentPersonRef.current !== forId) return;
    setEmails(res.emails);
    setInboxModeMap(new Map(res.inboxes.map((i) => [i.email, i.displayMode])));
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setEmails([]);
    setReplyToEmailId(null);
    setExpandedOlder({});
    setActiveInbox(null);
    setLinkOpen(false);
    setLinkQuery("");
    setLinkError(null);

    void (async () => {
      try {
        const identity = await fetchCustomerByPerson(person.id);
        if (cancelled) return;
        setCustomer(identity.customer);
        const useAllAddresses = identity.customer !== null;
        setAllAddresses(useAllAddresses);
        const res = await fetchPersonEmails(person.id, {
          allAddresses: useAllAddresses,
        });
        if (cancelled) return;
        setEmails(res.emails);
        setInboxModeMap(
          new Map(res.inboxes.map((i) => [i.email, i.displayMode])),
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [person.id]);

  useEffect(() => {
    if (refreshKey) refetchEmails();
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    setEnrollmentInfo(null);
    fetchPersonEnrollment(person.id).then((info) => {
      if (!cancelled) setEnrollmentInfo(info);
    });
    return () => {
      cancelled = true;
    };
  }, [person.id]);

  useEffect(() => {
    fetchStats().then((stats) => {
      setSenderIdentities(stats.senderIdentities ?? []);
    });
  }, []);

  useEffect(() => {
    if (!linkOpen) {
      setLinkResults([]);
      return;
    }
    let cancelled = false;
    const linkedIds = new Set(customer?.people.map((entry) => entry.id) ?? []);
    linkedIds.add(person.id);
    fetchPeople({ q: linkQuery.trim() || undefined, limit: 20 })
      .then((result) => {
        if (!cancelled) {
          setLinkResults(
            result.data.filter((entry) => !linkedIds.has(entry.id)),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setLinkResults([]);
      });
    return () => {
      cancelled = true;
    };
  }, [customer, linkOpen, linkQuery, person.id]);

  async function handleLink(otherPersonId: string) {
    setLinking(true);
    setLinkError(null);
    try {
      const next = await linkCustomerPeople(person.id, otherPersonId);
      setCustomer(next);
      setAllAddresses(true);
      setLinkOpen(false);
      setLinkQuery("");
      await refetchEmails(true);
    } catch (error) {
      setLinkError(
        error instanceof Error ? error.message : "Couldn't link addresses",
      );
    } finally {
      setLinking(false);
    }
  }

  async function handleUnlink(personId: string) {
    await unlinkCustomerPerson(personId);
    const identity = await fetchCustomerByPerson(person.id);
    setCustomer(identity.customer);
    const useAllAddresses = identity.customer !== null;
    setAllAddresses(useAllAddresses);
    await refetchEmails(useAllAddresses);
  }

  async function handleAllAddressesChange(value: boolean) {
    setAllAddresses(value);
    setLoading(true);
    try {
      await refetchEmails(value);
    } finally {
      setLoading(false);
    }
  }

  function refreshEnrollment() {
    const forId = person.id;
    fetchPersonEnrollment(forId).then((info) => {
      if (currentPersonRef.current === forId) setEnrollmentInfo(info);
    });
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
  const linkedMessageId = readMessageHash(location.hash);
  const linkedMessage = linkedMessageId
    ? emails.find((email) => email.id === linkedMessageId)
    : undefined;

  useEffect(() => {
    publishAgentContext({
      inbox: activeInbox ?? undefined,
      selectedMessageRef: linkedMessage
        ? `${linkedMessage.type}:${linkedMessage.id}`
        : undefined,
      personId: person.id,
    });
    return clearAgentContext;
  }, [
    activeInbox,
    clearAgentContext,
    linkedMessage,
    person.id,
    publishAgentContext,
  ]);

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
  const latestReceived =
    activeGroup?.emails.find((email) => email.type === "received") ?? null;
  const activePersonEmail =
    latestReceived?.fromAddress ??
    activeGroup?.emails.find((email) => email.type === "sent")?.toAddress ??
    person.email;

  const replyInboxForEmail = (email: Email) => {
    const ib = inboxOf(email);
    return ib === "(unknown)" ? distinctInboxes : [ib];
  };

  if (loading) {
    return (
      <div
        className="flex h-full flex-col gap-4 p-5"
        aria-busy="true"
        aria-label="Loading conversation"
      >
        <span className="pt-skel h-5 w-1/3" />
        <span className="pt-skel h-3 w-1/4" />
        <span className="pt-skel mt-4 h-24 w-full rounded-xl" />
        <span className="pt-skel h-24 w-5/6 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Person header — name, address and meta, actions on the right. */}
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
            <h2 className="truncate text-[17px] font-semibold leading-snug tracking-[-0.015em] text-text-primary">
              {person.name || person.email}
            </h2>
            <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] text-text-secondary">
              {person.name && <span className="truncate">{person.email}</span>}
              {person.name && <span aria-hidden>·</span>}
              <span className="tabular text-text-tertiary">
                {person.totalCount} message
                {person.totalCount !== 1 ? "s" : ""}
                {inboxGroups.length > 1
                  ? ` · ${inboxGroups.length} inboxes`
                  : ""}
              </span>
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

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <PersonListMemberships email={person.email} />
          {activeGroup && (
            <MarkAllReadButton
              unreadCount={unreadIn(activeGroup)}
              scopeLabel={activeGroup.inbox}
              onMarkAllRead={() => handleMarkInboxRead(activeGroup.inbox)}
            />
          )}
          {enrollmentInfo?.enrollment ? (
            <SequenceStatus
              personId={person.id}
              onStatusChange={refreshEnrollment}
            />
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEnrollModalOpen(true)}
            >
              <ListPlus />
              Add to sequence
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                aria-label="Block sender"
                className="hover:text-destructive"
              >
                <ShieldBan />
                Block
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => handleBlock("email")}>
                Block {person.email}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleBlock("domain")}>
                Block entire domain
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div
          data-testid="linked-addresses"
          className="mt-2 flex flex-wrap items-center gap-1.5"
        >
          <span className="mr-1 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
            Linked addresses
          </span>
          {(
            customer?.people ?? [
              { id: person.id, email: person.email, name: person.name },
            ]
          ).map((entry) => (
            <span
              key={entry.id}
              className="inline-flex items-center gap-1 rounded-full bg-bg-muted px-2 py-1 text-[11px] text-text-secondary"
              title={entry.name ?? entry.email}
            >
              {entry.email}
              {customer && (
                <button
                  type="button"
                  data-testid={`unlink-address-${entry.id}`}
                  aria-label={`Unlink ${entry.email}`}
                  onClick={() => void handleUnlink(entry.id)}
                  className="rounded-full p-0.5 hover:bg-border"
                >
                  <X size={10} />
                </button>
              )}
            </span>
          ))}
          <button
            type="button"
            data-testid="link-address-button"
            onClick={() => setLinkOpen((open) => !open)}
            className="inline-flex items-center gap-1 rounded-[6px] border border-border bg-card px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-bg-muted"
          >
            <Link2 size={11} />
            Link
          </button>
          {customer && (
            <label className="ml-1 inline-flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-text-secondary">
              <input
                data-testid="all-addresses-toggle"
                type="checkbox"
                checked={allAddresses}
                onChange={(event) =>
                  void handleAllAddressesChange(event.target.checked)
                }
              />
              All addresses
            </label>
          )}
        </div>

        {linkOpen && (
          <div
            data-testid="link-address-picker"
            className="mt-2 rounded-[8px] border border-border bg-bg-subtle p-2"
          >
            <input
              autoFocus
              aria-label="Search people to link"
              value={linkQuery}
              onChange={(event) => {
                setLinkQuery(event.target.value);
                setLinkError(null);
              }}
              placeholder="Search people by name or email"
              className="w-full rounded-[6px] border border-border bg-card px-2.5 py-1.5 text-xs text-text-primary outline-none focus:border-text-tertiary"
            />
            {linkError && (
              <p
                data-testid="link-address-error"
                className="mt-1 px-2 py-1 text-[11px] text-rose-600"
              >
                {linkError}
              </p>
            )}
            <div className="mt-1 max-h-36 overflow-y-auto">
              {linkResults.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  disabled={linking}
                  data-testid={`link-candidate-${candidate.id}`}
                  onClick={() => void handleLink(candidate.id)}
                  className="flex w-full items-center justify-between rounded-[5px] px-2 py-1.5 text-left text-xs hover:bg-bg-muted disabled:opacity-50"
                >
                  <span className="truncate text-text-primary">
                    {candidate.name || candidate.email}
                  </span>
                  {candidate.name && (
                    <span className="ml-2 truncate text-text-tertiary">
                      {candidate.email}
                    </span>
                  )}
                </button>
              ))}
              {linkResults.length === 0 && (
                <p className="px-2 py-1.5 text-[11px] text-text-tertiary">
                  No people found.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Inbox tabs — short label (local-part only), counts + mode dot.
          Tooltip on the tab shows the full address.
          On mobile: horizontal scroll with snap (native-app feel).
          On desktop: wraps onto multiple lines. */}
      {inboxGroups.length > 0 && (
        <div className="shrink-0 border-b border-border bg-card">
          <div
            className="smooth-scroll flex gap-1 overflow-x-auto px-3 py-1.5 sm:flex-wrap sm:overflow-visible sm:px-4"
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
                    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] transition-colors",
                    isActive
                      ? "bg-card text-text-primary shadow-card ring-1 ring-border-strong"
                      : "text-text-secondary hover:bg-bg-muted hover:text-text-primary",
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
                  <span className="tabular inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-bg-muted px-1 text-[11px] font-medium text-text-secondary">
                    {group.emails.length}
                  </span>
                  {unread > 0 && (
                    <span
                      className="tabular inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[11px] font-semibold text-accent-foreground"
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

      {/* Active inbox section — fills remaining height */}
      <div className="flex min-h-0 flex-1 flex-col">
        {latestReceived && (
          <div className="shrink-0 border-b border-border bg-card px-4 py-3">
            <SuggestedReplyCard
              emailId={latestReceived.id}
              onUse={() => {
                setReplyComposerKey((key) => key + 1);
                setReplyToEmailId(latestReceived.id);
              }}
            />
          </div>
        )}
        {activeGroup ? (
          (() => {
            const mode = inboxModeMap.get(activeGroup.inbox) ?? "chat";
            if (mode === "chat") {
              return (
                <ChatInboxSection
                  key={activeGroup.inbox}
                  group={activeGroup}
                  personEmail={activePersonEmail}
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
                  personEmail={activePersonEmail}
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
          <div className="pt-empty flex-1">
            No messages with this person yet.
          </div>
        )}

        {/* Reply composer (thread mode) */}
        {replyToEmailId && (
          <ReplyComposer
            key={`${replyToEmailId}:${replyComposerKey}`}
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
