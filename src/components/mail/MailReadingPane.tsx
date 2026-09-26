import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  ExternalLink,
  Folder,
  MailOpen,
  Paperclip,
  Reply,
  ShieldAlert,
  Star,
  Trash2,
  UserRoundCheck,
} from "lucide-react";
import ReplyComposer from "@/components/ReplyComposer";
import SuggestedReplyCard from "@/components/SuggestedReplyCard";
import SnoozeMenu, {
  snoozeInHours,
  toLocalDateTimeInput,
} from "@/components/mail/SnoozeMenu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { InboxAssignee, MailMessage, Mailbox, Stats } from "@/lib/api";
import { sanitizeEmailHtml } from "@/lib/sanitize-html";
import { showToast } from "@/lib/toast";

function addressLabel(
  address: { email: string; name?: string | null } | null,
): string {
  if (!address) return "Unknown";
  return address.name ? `${address.name} <${address.email}>` : address.email;
}

function fullTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function snoozedLabel(timestamp: number): string {
  return `Snoozed until ${new Date(timestamp * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

interface MailReadingPaneProps {
  visible: boolean;
  selectedRef: string | null;
  selectedMessage: MailMessage | null;
  actionBusyRef: string | null;
  replyRequestKey: number;
  mailboxes: Mailbox[];
  assignees?: InboxAssignee[];
  mailboxId?: string;
  currentMailboxName?: string;
  senderIdentities: Stats["senderIdentities"];
  internalDomains: string[];
  onBack: () => void;
  onToggleStar: (message: MailMessage) => void;
  onToggleArchive: (message: MailMessage) => void;
  onToggleSpam: (message: MailMessage) => void;
  onToggleTrash: (message: MailMessage) => void;
  onSnooze: (message: MailMessage, until: number) => void;
  onAssign: (message: MailMessage, userId: string | null) => void;
  onMoveToMailbox: (message: MailMessage, mailboxId: string) => void;
  onRemoveFromCurrentMailbox: (message: MailMessage) => void;
  onOpenCustomer: (message: MailMessage) => void;
  onRefresh: () => void;
}

export default function MailReadingPane({
  visible,
  selectedRef,
  selectedMessage,
  actionBusyRef,
  replyRequestKey,
  mailboxes,
  assignees = [],
  mailboxId,
  currentMailboxName,
  senderIdentities,
  internalDomains,
  onBack,
  onToggleStar,
  onToggleArchive,
  onToggleSpam,
  onToggleTrash,
  onSnooze,
  onAssign,
  onMoveToMailbox,
  onRemoveFromCurrentMailbox,
  onOpenCustomer,
  onRefresh,
}: MailReadingPaneProps) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyComposerKey, setReplyComposerKey] = useState(0);
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  const [customSnoozeValue, setCustomSnoozeValue] = useState("");
  const lastReplyRequestKey = useRef(0);

  useEffect(() => {
    setReplyOpen(false);
    setCustomSnoozeOpen(false);
  }, [selectedRef]);

  useEffect(() => {
    if (
      replyRequestKey === 0 ||
      replyRequestKey === lastReplyRequestKey.current
    ) {
      return;
    }
    lastReplyRequestKey.current = replyRequestKey;
    if (selectedMessage?.direction === "inbound") {
      setReplyOpen(true);
    }
  }, [replyRequestKey, selectedMessage?.direction, selectedMessage?.ref]);

  function openCustomSnooze() {
    setCustomSnoozeValue(toLocalDateTimeInput(snoozeInHours(3)));
    setCustomSnoozeOpen(true);
  }

  function submitCustomSnooze(message: MailMessage) {
    const date = new Date(customSnoozeValue);
    if (
      !customSnoozeValue ||
      Number.isNaN(date.getTime()) ||
      date.getTime() <= Date.now()
    ) {
      showToast({
        kind: "warning",
        message: "Choose a future snooze time",
      });
      return;
    }
    setCustomSnoozeOpen(false);
    onSnooze(message, unixSeconds(date));
  }

  function moveMenu(message: MailMessage) {
    if (mailboxes.length === 0) return null;
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Folder className="h-4 w-4" />
          Move to folder
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {mailboxes.map((mailbox) => (
            <DropdownMenuItem
              key={mailbox.id}
              disabled={
                message.state.mailboxIds.length === 1 &&
                message.state.mailboxIds[0] === mailbox.id
              }
              onSelect={() => onMoveToMailbox(message, mailbox.id)}
              data-testid="mail-move-folder"
              data-mailbox-id={mailbox.id}
            >
              <Folder className="h-4 w-4" />
              {mailbox.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }

  return (
    <>
      <section
        className={`${visible ? "flex" : "hidden"} min-w-0 flex-1 flex-col bg-card md:flex`}
      >
        {selectedRef ? (
          <>
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1 text-xs text-text-secondary hover:bg-bg-muted md:hidden"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back
              </button>
              {selectedMessage && (
                <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
                  {selectedMessage.direction === "inbound" && (
                    <button
                      type="button"
                      disabled={actionBusyRef === selectedMessage.ref}
                      onClick={() => setReplyOpen(true)}
                      className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-muted hover:text-text-primary disabled:opacity-50"
                    >
                      <Reply className="h-3.5 w-3.5" />
                      Reply
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={actionBusyRef === selectedMessage.ref}
                    onClick={() => onToggleStar(selectedMessage)}
                    data-testid="mail-reading-star"
                    className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-muted hover:text-text-primary disabled:opacity-50"
                  >
                    <Star
                      className={`h-3.5 w-3.5 ${
                        selectedMessage.state.starredAt ? "fill-current" : ""
                      }`}
                    />
                    {selectedMessage.state.starredAt ? "Unstar" : "Star"}
                  </button>
                  {selectedMessage.direction === "inbound" && (
                    <>
                      <button
                        type="button"
                        disabled={actionBusyRef === selectedMessage.ref}
                        onClick={() => onToggleArchive(selectedMessage)}
                        data-testid="mail-reading-archive"
                        className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-muted hover:text-text-primary disabled:opacity-50"
                      >
                        <Archive className="h-3.5 w-3.5" />
                        {selectedMessage.state.archivedAt
                          ? "Unarchive"
                          : "Archive"}
                      </button>
                      <button
                        type="button"
                        disabled={actionBusyRef === selectedMessage.ref}
                        onClick={() => onToggleSpam(selectedMessage)}
                        className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-muted hover:text-text-primary disabled:opacity-50"
                      >
                        <ShieldAlert className="h-3.5 w-3.5" />
                        {selectedMessage.state.spamAt ? "Not spam" : "Spam"}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    disabled={actionBusyRef === selectedMessage.ref}
                    onClick={() => onToggleTrash(selectedMessage)}
                    data-testid="mail-reading-trash"
                    className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-muted hover:text-text-primary disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {selectedMessage.state.trashedAt ? "Restore" : "Trash"}
                  </button>

                  <SnoozeMenu
                    disabled={actionBusyRef === selectedMessage.ref}
                    onSnooze={(until) => onSnooze(selectedMessage, until)}
                    onCustom={openCustomSnooze}
                  />

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        data-testid="mail-assign-menu"
                        disabled={actionBusyRef === selectedMessage.ref}
                        className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-muted hover:text-text-primary disabled:opacity-50"
                      >
                        <UserRoundCheck className="h-3.5 w-3.5" />
                        Assign
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        data-testid="mail-assign-option"
                        data-user-id=""
                        onSelect={() => onAssign(selectedMessage, null)}
                      >
                        Unassign
                      </DropdownMenuItem>
                      {assignees.length > 0 && <DropdownMenuSeparator />}
                      {assignees.map((user) => (
                        <DropdownMenuItem
                          key={user.id}
                          data-testid="mail-assign-option"
                          data-user-id={user.id}
                          onSelect={() => onAssign(selectedMessage, user.id)}
                        >
                          {user.name || user.email}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {mailboxes.length > 0 && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          disabled={actionBusyRef === selectedMessage.ref}
                          className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-muted hover:text-text-primary disabled:opacity-50"
                        >
                          <Folder className="h-3.5 w-3.5" />
                          Folder
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {moveMenu(selectedMessage)}
                        {mailboxId && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onSelect={() =>
                                onRemoveFromCurrentMailbox(selectedMessage)
                              }
                            >
                              Remove from {currentMailboxName ?? "folder"}
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}

                  {selectedMessage.personId && (
                    <button
                      type="button"
                      onClick={() => onOpenCustomer(selectedMessage)}
                      className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-muted hover:text-text-primary"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Open customer
                    </button>
                  )}
                </div>
              )}
            </div>

            {selectedMessage ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                {customSnoozeOpen && (
                  <div className="flex flex-wrap items-end gap-2 border-b border-border bg-bg-subtle px-5 py-3">
                    <label className="text-xs text-text-secondary">
                      Custom snooze
                      <input
                        type="datetime-local"
                        value={customSnoozeValue}
                        onChange={(event) =>
                          setCustomSnoozeValue(event.target.value)
                        }
                        className="mt-1 block rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary outline-none focus:border-text-tertiary"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => submitCustomSnooze(selectedMessage)}
                      className="rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-background"
                    >
                      Snooze
                    </button>
                    <button
                      type="button"
                      onClick={() => setCustomSnoozeOpen(false)}
                      className="rounded-[6px] px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-muted"
                    >
                      Cancel
                    </button>
                  </div>
                )}

                <article data-testid="mail-reading-pane" className="p-5 md:p-7">
                  <div className="border-b border-border pb-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="text-lg font-semibold text-text-primary">
                          {selectedMessage.subject || "(no subject)"}
                        </h2>
                        <p className="mt-2 text-xs text-text-secondary">
                          <span className="font-medium text-text-primary">
                            From:
                          </span>{" "}
                          {addressLabel(selectedMessage.from)}
                        </p>
                        <p className="mt-1 text-xs text-text-secondary">
                          <span className="font-medium text-text-primary">
                            To:
                          </span>{" "}
                          {addressLabel(selectedMessage.to)}
                        </p>
                        {selectedMessage.cc.length > 0 && (
                          <p className="mt-1 text-xs text-text-secondary">
                            <span className="font-medium text-text-primary">
                              Cc:
                            </span>{" "}
                            {selectedMessage.cc
                              .map((entry) => addressLabel(entry))
                              .join(", ")}
                          </p>
                        )}
                      </div>
                      <time className="shrink-0 text-xs text-text-tertiary">
                        {fullTime(selectedMessage.occurredAt)}
                      </time>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-1">
                      {selectedMessage.source.campaignId && (
                        <span className="rounded bg-bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary">
                          Campaign
                        </span>
                      )}
                      {selectedMessage.source.sequenceId && (
                        <span className="rounded bg-bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary">
                          Sequence
                        </span>
                      )}
                      {selectedMessage.attachmentCount ? (
                        <span className="inline-flex items-center gap-1 rounded bg-bg-muted px-1.5 py-0.5 text-[10px] text-text-secondary">
                          <Paperclip className="h-3 w-3" />
                          {selectedMessage.attachmentCount} attachment
                          {selectedMessage.attachmentCount === 1 ? "" : "s"}
                        </span>
                      ) : null}
                      {selectedMessage.state.snoozedUntil && (
                        <span className="rounded bg-bg-muted px-1.5 py-0.5 text-[10px] text-text-secondary">
                          {snoozedLabel(selectedMessage.state.snoozedUntil)}
                        </span>
                      )}
                    </div>
                  </div>

                  {selectedMessage.direction === "inbound" && (
                    <div className="pt-5">
                      <SuggestedReplyCard
                        emailId={selectedMessage.ref.slice("received:".length)}
                        onUse={() => {
                          setReplyComposerKey((key) => key + 1);
                          setReplyOpen(true);
                        }}
                      />
                    </div>
                  )}

                  <div className="py-6">
                    {selectedMessage.bodyHtml ? (
                      <div
                        className="prose prose-sm max-w-none break-words text-text-primary"
                        dangerouslySetInnerHTML={{
                          __html: sanitizeEmailHtml(selectedMessage.bodyHtml),
                        }}
                      />
                    ) : (
                      <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-text-primary">
                        {selectedMessage.bodyText || "(no text)"}
                      </pre>
                    )}
                  </div>
                </article>
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center px-8 text-center text-sm text-text-tertiary">
                The selected message is not in the loaded pages.
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
            <MailOpen className="h-7 w-7 text-text-tertiary" />
            <p className="max-w-xs text-sm text-text-tertiary">
              Select a message to open it in the reading pane.
            </p>
          </div>
        )}
      </section>

      {replyOpen &&
        selectedMessage?.direction === "inbound" &&
        selectedMessage.from && (
          <ReplyComposer
            key={`${selectedMessage.ref}:${replyRequestKey}:${replyComposerKey}`}
            emailId={selectedMessage.ref.slice("received:".length)}
            personName={selectedMessage.from.name ?? null}
            personEmail={selectedMessage.from.email}
            recipients={[selectedMessage.inbox]}
            senderIdentities={senderIdentities}
            internalDomains={internalDomains}
            onClose={() => setReplyOpen(false)}
            onSent={() => {
              setReplyOpen(false);
              onRefresh();
            }}
          />
        )}
    </>
  );
}
