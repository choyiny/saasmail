import { useEffect, useMemo, useState } from "react";
import {
  useNavigate,
  useOutletContext,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { nanoid } from "nanoid";
import MailFolderRail, {
  SYSTEM_FOLDERS,
} from "@/components/mail/MailFolderRail";
import MailDraftList from "@/components/mail/MailDraftList";
import MailMessageList from "@/components/mail/MailMessageList";
import MailReadingPane from "@/components/mail/MailReadingPane";
import MailSelectionBar from "@/components/mail/MailSelectionBar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  deleteDraft,
  fetchDraftList,
  fetchMailboxes,
  fetchStats,
  type DraftListItem,
  type Mailbox,
  type Stats,
} from "@/lib/api";
import type { ComposePrefill } from "@/pages/ComposeModal";
import { showToast } from "@/lib/toast";
import { type SystemFolder, useMailMessages } from "@/hooks/useMailMessages";
import { useAgentContext } from "@/agent/AgentContext";

type MobilePane = "folders" | "list" | "reader";

interface MailOutletContext {
  onCompose: (prefill?: ComposePrefill, contextKey?: string) => void;
}

function isSystemFolder(value: string | undefined): value is SystemFolder {
  return SYSTEM_FOLDERS.some((folder) => folder.id === value);
}

function mailPath(inbox: string, folder: SystemFolder): string {
  return `/mail/${encodeURIComponent(inbox)}/${folder}`;
}

function mailboxPath(inbox: string, mailboxId: string): string {
  return `/mail/${encodeURIComponent(inbox)}/f/${encodeURIComponent(mailboxId)}`;
}

export default function MailPage() {
  const navigate = useNavigate();
  const outlet = useOutletContext<MailOutletContext | null>();
  const onCompose = outlet?.onCompose ?? (() => {});
  const params = useParams<{
    inbox?: string;
    folder?: string;
    mailboxId?: string;
  }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [stats, setStats] = useState<Stats | null>(null);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [drafts, setDrafts] = useState<DraftListItem[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [mobilePane, setMobilePane] = useState<MobilePane>(
    searchParams.get("m") ? "reader" : "list",
  );
  const [selectedRefs, setSelectedRefs] = useState<Set<string>>(new Set());
  const [keyboardRef, setKeyboardRef] = useState<string | null>(
    searchParams.get("m"),
  );
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [replyRequestKey, setReplyRequestKey] = useState(0);
  const { publish: publishAgentContext, clear: clearAgentContext } =
    useAgentContext();

  const inbox = params.inbox;
  const folder = params.folder;
  const mailboxId = params.mailboxId;
  const selectedRef = searchParams.get("m");
  const query = searchParams.get("q") ?? "";
  const systemFolder = isSystemFolder(folder) ? folder : undefined;

  useEffect(() => {
    publishAgentContext({
      inbox,
      folder: systemFolder ?? (mailboxId ? `mailbox:${mailboxId}` : undefined),
      selectedMessageRef: selectedRef ?? undefined,
    });
    return clearAgentContext;
  }, [
    clearAgentContext,
    inbox,
    mailboxId,
    publishAgentContext,
    selectedRef,
    systemFolder,
  ]);

  const allowedInboxes = useMemo(
    () => stats?.senderIdentities.map((identity) => identity.email) ?? [],
    [stats],
  );

  const internalDomains = useMemo(
    () =>
      stats?.senderIdentities
        .map((identity) => identity.email.split("@")[1]?.toLowerCase())
        .filter((domain): domain is string => Boolean(domain)) ?? [],
    [stats],
  );

  useEffect(() => {
    fetchStats()
      .then(setStats)
      .catch(() =>
        setStats({
          totalPeople: 0,
          totalEmails: 0,
          unreadCount: 0,
          recipients: [],
          senderIdentities: [],
        }),
      );
  }, []);

  useEffect(() => {
    if (!stats) return;
    const firstInbox = allowedInboxes[0];

    if (!inbox) {
      if (firstInbox) {
        navigate(mailPath(firstInbox, "inbox"), { replace: true });
      }
      return;
    }

    if (!allowedInboxes.includes(inbox)) {
      if (firstInbox) {
        navigate(mailPath(firstInbox, "inbox"), { replace: true });
      }
      return;
    }

    if (!mailboxId && !systemFolder) {
      navigate(mailPath(inbox, "inbox"), { replace: true });
    }
  }, [allowedInboxes, inbox, mailboxId, navigate, stats, systemFolder]);

  useEffect(() => {
    if (!inbox || !allowedInboxes.includes(inbox)) return;
    fetchMailboxes(inbox)
      .then(setMailboxes)
      .catch(() => setMailboxes([]));
  }, [allowedInboxes, inbox]);

  useEffect(() => {
    if (selectedRef) setMobilePane("reader");
  }, [selectedRef]);

  useEffect(() => {
    if (systemFolder !== "drafts" || !inbox) return;
    let cancelled = false;
    setDraftsLoading(true);
    fetchDraftList({ inbox })
      .then((result) => {
        if (!cancelled) setDrafts(result.drafts);
      })
      .catch((error) => {
        if (cancelled) return;
        setDrafts([]);
        showToast({
          kind: "error",
          message: "Couldn’t load drafts",
          description: error instanceof Error ? error.message : undefined,
        });
      })
      .finally(() => {
        if (!cancelled) setDraftsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [inbox, systemFolder]);

  function updateSearch(value: string) {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value) next.set("q", value);
        else next.delete("q");
        next.delete("m");
        return next;
      },
      { replace: true },
    );
  }

  function selectMessage(ref: string) {
    setKeyboardRef(ref);
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set("m", ref);
        return next;
      },
      { replace: true },
    );
    setMobilePane("reader");
  }

  function clearSelection() {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete("m");
        return next;
      },
      { replace: true },
    );
    setMobilePane("list");
  }

  useEffect(() => {
    setSelectedRefs(new Set());
    setKeyboardRef(null);
  }, [inbox, mailboxId, systemFolder]);

  function openSystemFolder(nextFolder: SystemFolder) {
    if (!inbox) return;
    navigate({
      pathname: mailPath(inbox, nextFolder),
      search: query ? `?q=${encodeURIComponent(query)}` : "",
    });
    setMobilePane("list");
  }

  function openMailbox(nextMailboxId: string) {
    if (!inbox) return;
    navigate({
      pathname: mailboxPath(inbox, nextMailboxId),
      search: query ? `?q=${encodeURIComponent(query)}` : "",
    });
    setMobilePane("list");
  }

  function openDraft(draft: DraftListItem) {
    if (draft.contextKey.startsWith("reply:")) {
      const emailId =
        draft.replyToEmailId ?? draft.contextKey.slice("reply:".length);
      if (!emailId || !inbox) return;
      navigate({
        pathname: mailPath(inbox, "inbox"),
        search: `?m=${encodeURIComponent(`received:${emailId}`)}&reply=1`,
      });
      setMobilePane("reader");
      return;
    }

    onCompose(undefined, draft.contextKey);
  }

  async function removeDraft(draft: DraftListItem) {
    if (!window.confirm(`Delete draft "${draft.subject || "(no subject)"}"?`)) {
      return;
    }
    try {
      await deleteDraft(draft.contextKey);
      setDrafts((current) => current.filter((item) => item.id !== draft.id));
    } catch (error) {
      showToast({
        kind: "error",
        message: "Couldn’t delete draft",
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }

  const mail = useMailMessages({
    inbox,
    allowedInboxes,
    mailboxId,
    systemFolder,
    query,
    selectedRef,
    onClearSelected: clearSelection,
  });

  const selectedMessages = mail.messages.filter((message) =>
    selectedRefs.has(message.ref),
  );
  const allSelected =
    mail.messages.length > 0 &&
    mail.messages.every((message) => selectedRefs.has(message.ref));
  const canArchiveSpam =
    selectedMessages.length > 0 &&
    selectedMessages.every((message) => message.direction === "inbound");
  const markSeen =
    selectedMessages.length > 0 &&
    !selectedMessages.every((message) => message.state.seen);
  const star =
    selectedMessages.length > 0 &&
    !selectedMessages.every((message) => message.state.starredAt !== null);
  const archive =
    selectedMessages.length > 0 &&
    !selectedMessages.every((message) => message.state.archivedAt !== null);
  const spam =
    selectedMessages.length > 0 &&
    !selectedMessages.every((message) => message.state.spamAt !== null);
  const trash =
    selectedMessages.length > 0 &&
    !selectedMessages.every((message) => message.state.trashedAt !== null);

  function toggleSelected(ref: string) {
    setKeyboardRef(ref);
    setSelectedRefs((current) => {
      const next = new Set(current);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedRefs((current) => {
      const next = new Set(current);
      if (allSelected) {
        for (const message of mail.messages) next.delete(message.ref);
      } else {
        for (const message of mail.messages) next.add(message.ref);
      }
      return next;
    });
  }

  async function runBulk(action: () => Promise<boolean>) {
    if (await action()) setSelectedRefs(new Set());
  }

  useEffect(() => {
    if (
      searchParams.get("reply") !== "1" ||
      !mail.selectedMessage ||
      mail.selectedMessage.direction !== "inbound"
    ) {
      return;
    }

    setReplyRequestKey((current) => current + 1);
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete("reply");
        return next;
      },
      { replace: true },
    );
  }, [mail.selectedMessage, searchParams, setSearchParams]);

  useEffect(() => {
    function editableTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target.isContentEditable ||
        Boolean(target.closest("[contenteditable='true']"))
      );
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-agent-panel]")
      ) {
        return;
      }
      if (editableTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.shiftKey && event.key !== "?" && event.key !== "#") return;

      const currentRef = keyboardRef ?? selectedRef;
      const currentIndex = currentRef
        ? mail.messages.findIndex((message) => message.ref === currentRef)
        : -1;

      if (event.key === "j" || event.key === "k") {
        if (mail.messages.length === 0) return;
        event.preventDefault();
        const nextIndex =
          event.key === "j"
            ? Math.min(
                currentIndex < 0 ? 0 : currentIndex + 1,
                mail.messages.length - 1,
              )
            : Math.max(
                currentIndex < 0 ? mail.messages.length - 1 : currentIndex - 1,
                0,
              );
        setKeyboardRef(mail.messages[nextIndex]?.ref ?? null);
        setMobilePane("list");
        return;
      }

      const targetMessage =
        mail.messages.find(
          (message) => message.ref === (keyboardRef ?? selectedRef),
        ) ?? null;

      if (event.key === "Enter" || event.key === "o") {
        if (!targetMessage) return;
        event.preventDefault();
        selectMessage(targetMessage.ref);
        return;
      }
      if (event.key === "u") {
        if (!selectedRef) return;
        event.preventDefault();
        clearSelection();
        return;
      }
      if (event.key === "x") {
        if (!targetMessage) return;
        event.preventDefault();
        toggleSelected(targetMessage.ref);
        return;
      }
      if (event.key === "e") {
        if (!targetMessage || targetMessage.direction !== "inbound") return;
        event.preventDefault();
        void mail.toggleArchive(targetMessage);
        return;
      }
      if (event.key === "s") {
        if (!targetMessage) return;
        event.preventDefault();
        void mail.toggleStar(targetMessage);
        return;
      }
      if (event.key === "#") {
        if (!targetMessage) return;
        event.preventDefault();
        void mail.toggleTrash(targetMessage);
        return;
      }
      if (event.key === "r") {
        if (
          !mail.selectedMessage ||
          mail.selectedMessage.direction !== "inbound"
        ) {
          return;
        }
        event.preventDefault();
        setReplyRequestKey((current) => current + 1);
        return;
      }
      if (event.key === "?") {
        event.preventDefault();
        setShortcutsOpen(true);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [keyboardRef, mail.messages, mail.selectedMessage, selectedRef]);

  const currentMailbox = mailboxId
    ? (mailboxes.find((mailbox) => mailbox.id === mailboxId) ?? null)
    : null;
  const currentFolderLabel =
    currentMailbox?.name ??
    SYSTEM_FOLDERS.find((entry) => entry.id === systemFolder)?.label ??
    "Mail";

  if (stats && allowedInboxes.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-[1600px] flex-1 items-center justify-center px-4 py-16 md:px-6">
        <div className="rounded-[8px] bg-card p-10 text-center ring-1 ring-border">
          <h2 className="text-base font-semibold text-text-primary">
            No inboxes assigned yet
          </h2>
          <p className="mt-2 text-sm text-text-secondary">
            Ask an admin to grant you access to an inbox.
          </p>
        </div>
      </div>
    );
  }

  if (!inbox || !stats) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-text-tertiary">
        Loading mail…
      </div>
    );
  }

  return (
    <>
      <div className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 px-0 pb-3 pt-2 sm:px-4 md:px-6">
        <div className="flex min-h-[420px] flex-1 overflow-hidden bg-card sm:rounded-[8px] sm:ring-1 sm:ring-border">
          <MailFolderRail
            visible={mobilePane === "folders"}
            inbox={inbox}
            senderIdentities={stats.senderIdentities}
            mailboxes={mailboxes}
            mailboxId={mailboxId}
            systemFolder={systemFolder}
            onInboxChange={(nextInbox) => {
              navigate(mailPath(nextInbox, "inbox"));
              setMobilePane("list");
            }}
            onNewMessage={() => onCompose({ from: inbox }, `draft:${nanoid()}`)}
            onOpenSystemFolder={openSystemFolder}
            onOpenMailbox={openMailbox}
            onMailboxCreated={(mailbox) =>
              setMailboxes((current) => [...current, mailbox])
            }
            onMailboxUpdated={(mailbox) =>
              setMailboxes((current) =>
                current.map((item) =>
                  item.id === mailbox.id ? mailbox : item,
                ),
              )
            }
            onMailboxDeleted={(deletedId) => {
              const removed = new Set([deletedId]);
              let changed = true;
              while (changed) {
                changed = false;
                for (const mailbox of mailboxes) {
                  if (
                    mailbox.parentId &&
                    removed.has(mailbox.parentId) &&
                    !removed.has(mailbox.id)
                  ) {
                    removed.add(mailbox.id);
                    changed = true;
                  }
                }
              }
              setMailboxes((current) =>
                current.filter((mailbox) => !removed.has(mailbox.id)),
              );
              if (mailboxId && removed.has(mailboxId)) {
                navigate(mailPath(inbox, "inbox"));
                setMobilePane("list");
              }
            }}
          />

          {systemFolder === "drafts" ? (
            <MailDraftList
              visible={mobilePane === "list"}
              drafts={drafts}
              loading={draftsLoading}
              onBackToFolders={() => setMobilePane("folders")}
              onOpenDraft={openDraft}
              onDeleteDraft={(draft) => void removeDraft(draft)}
            />
          ) : (
            <MailMessageList
              visible={mobilePane === "list"}
              currentFolderLabel={currentFolderLabel}
              systemFolder={systemFolder}
              query={query}
              showCampaignSends={mail.showCampaignSends}
              onShowCampaignSendsChange={mail.setShowCampaignSends}
              showNewMessages={mail.showNewMessages}
              listScrollRef={mail.listScrollRef}
              loading={mail.loading}
              loadingMore={mail.loadingMore}
              messages={mail.messages}
              nextCursor={mail.nextCursor}
              selectedRef={selectedRef}
              activeRef={keyboardRef}
              actionBusyRef={mail.actionBusyRef}
              selectedRefs={selectedRefs}
              selectionBar={
                <MailSelectionBar
                  count={selectedMessages.length}
                  busy={mail.bulkBusy}
                  canArchiveSpam={canArchiveSpam}
                  markSeen={markSeen}
                  star={star}
                  archive={archive}
                  spam={spam}
                  trash={trash}
                  mailboxes={mailboxes}
                  onSeen={() =>
                    void runBulk(() =>
                      mail.bulkSetSeen(selectedMessages, markSeen),
                    )
                  }
                  onStar={() =>
                    void runBulk(() =>
                      mail.bulkSetStarred(selectedMessages, star),
                    )
                  }
                  onArchive={() =>
                    void runBulk(() =>
                      mail.bulkSetArchived(selectedMessages, archive),
                    )
                  }
                  onSpam={() =>
                    void runBulk(() => mail.bulkSetSpam(selectedMessages, spam))
                  }
                  onTrash={() =>
                    void runBulk(() =>
                      mail.bulkSetTrashed(selectedMessages, trash),
                    )
                  }
                  onSnooze={(until) =>
                    void runBulk(() => mail.bulkSnooze(selectedMessages, until))
                  }
                  onMove={(targetId) =>
                    void runBulk(() =>
                      mail.bulkMoveToMailbox(selectedMessages, targetId),
                    )
                  }
                  onClear={() => setSelectedRefs(new Set())}
                />
              }
              onBackToFolders={() => setMobilePane("folders")}
              onSearch={updateSearch}
              onReachedTop={() => mail.setShowNewMessages(false)}
              onRefreshNewMessages={() => {
                mail.listScrollRef.current?.scrollTo({ top: 0 });
                void mail.loadMessages(null, false);
              }}
              onSelectMessage={selectMessage}
              onToggleSelected={toggleSelected}
              onToggleSelectAll={toggleSelectAll}
              onToggleStar={(message) => void mail.toggleStar(message)}
              onLoadMore={(cursor) => void mail.loadMessages(cursor, true)}
            />
          )}

          {systemFolder !== "drafts" && (
            <MailReadingPane
              visible={mobilePane === "reader"}
              selectedRef={selectedRef}
              selectedMessage={mail.selectedMessage}
              actionBusyRef={mail.actionBusyRef}
              replyRequestKey={replyRequestKey}
              mailboxes={mailboxes}
              mailboxId={mailboxId}
              currentMailboxName={currentMailbox?.name}
              senderIdentities={stats.senderIdentities}
              internalDomains={internalDomains}
              onBack={clearSelection}
              onToggleStar={(message) => void mail.toggleStar(message)}
              onToggleArchive={(message) => void mail.toggleArchive(message)}
              onToggleSpam={(message) => void mail.toggleSpam(message)}
              onToggleTrash={(message) => void mail.toggleTrash(message)}
              onSnooze={(message, until) =>
                void mail.snoozeMessage(message, until)
              }
              onMoveToMailbox={(message, targetId) =>
                void mail.moveToMailbox(message, targetId)
              }
              onRemoveFromCurrentMailbox={(message) =>
                void mail.removeFromCurrentMailbox(message)
              }
              onOpenCustomer={(message) => {
                if (!message.personId) return;
                navigate(
                  `/inbox/${encodeURIComponent(message.inbox)}/${encodeURIComponent(message.personId)}`,
                );
              }}
              onRefresh={() => void mail.loadMessages(null, false)}
            />
          )}
        </div>
      </div>

      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent data-testid="mail-shortcuts-dialog" className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Mail keyboard shortcuts</DialogTitle>
            <DialogDescription>
              Shortcuts work while focus is outside form fields and editors.
            </DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {[
              ["j / k", "Next / previous message"],
              ["Enter / o", "Open message"],
              ["u", "Back to list"],
              ["x", "Toggle selection"],
              ["e", "Archive"],
              ["s", "Star"],
              ["#", "Trash"],
              ["r", "Reply"],
              ["?", "Show shortcuts"],
            ].map(([keys, label]) => (
              <div key={keys} className="contents">
                <dt className="font-mono text-xs font-semibold text-text-primary">
                  {keys}
                </dt>
                <dd className="text-text-secondary">{label}</dd>
              </div>
            ))}
          </dl>
        </DialogContent>
      </Dialog>
    </>
  );
}
