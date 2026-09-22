import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  Clock3,
  ExternalLink,
  Folder,
  Inbox,
  MailOpen,
  Paperclip,
  Reply,
  Search,
  Send,
  ShieldAlert,
  Star,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import ReplyComposer from "@/components/ReplyComposer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  createMailbox,
  fetchMailboxes,
  fetchMessages,
  fetchStats,
  setMailboxMembership,
  setMessageState,
  snoozeMessages,
  type MailMessage,
  type MailMessageState,
  type Mailbox,
  type Stats,
} from "@/lib/api";
import { useRealtimeUpdates } from "@/hooks/useRealtimeUpdates";
import { onMailRefresh } from "@/lib/mail-events";
import { sanitizeEmailHtml } from "@/lib/sanitize-html";
import { showToast } from "@/lib/toast";

const PAGE_SIZE = 50;

const SYSTEM_FOLDERS = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "starred", label: "Starred", icon: Star },
  { id: "snoozed", label: "Snoozed", icon: Clock3 },
  { id: "sent", label: "Sent", icon: Send },
  { id: "archive", label: "Archive", icon: Archive },
  { id: "junk", label: "Junk", icon: TriangleAlert },
  { id: "trash", label: "Trash", icon: Trash2 },
] as const;

type SystemFolder = (typeof SYSTEM_FOLDERS)[number]["id"];
type MobilePane = "folders" | "list" | "reader";

function isSystemFolder(value: string | undefined): value is SystemFolder {
  return SYSTEM_FOLDERS.some((folder) => folder.id === value);
}

function mailPath(inbox: string, folder: SystemFolder): string {
  return `/mail/${encodeURIComponent(inbox)}/${folder}`;
}

function mailboxPath(inbox: string, mailboxId: string): string {
  return `/mail/${encodeURIComponent(inbox)}/f/${encodeURIComponent(mailboxId)}`;
}

function counterparty(message: MailMessage): string {
  if (message.direction === "inbound") {
    return message.from?.name || message.from?.email || "Unknown sender";
  }
  return message.to.name || message.to.email;
}

function addressLabel(
  address: { email: string; name?: string | null } | null,
): string {
  if (!address) return "Unknown";
  return address.name ? `${address.name} <${address.email}>` : address.email;
}

function bodySnippet(message: MailMessage): string {
  const text = (message.bodyText ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function compactTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
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

function snoozeInHours(hours: number): number {
  return unixSeconds(new Date(Date.now() + hours * 60 * 60 * 1000));
}

function tomorrowAtEight(): number {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(8, 0, 0, 0);
  return unixSeconds(date);
}

function nextMondayAtEight(): number {
  const date = new Date();
  const days = (8 - date.getDay()) % 7 || 7;
  date.setDate(date.getDate() + days);
  date.setHours(8, 0, 0, 0);
  return unixSeconds(date);
}

function toLocalDateTimeInput(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function patchMessageState(
  message: MailMessage,
  patch: Partial<MailMessageState>,
): MailMessage {
  return { ...message, state: { ...message.state, ...patch } };
}

export default function MailPage() {
  const navigate = useNavigate();
  const params = useParams<{
    inbox?: string;
    folder?: string;
    mailboxId?: string;
  }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [stats, setStats] = useState<Stats | null>(null);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showCampaignSends, setShowCampaignSends] = useState(false);
  const [showNewMessages, setShowNewMessages] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [actionBusyRef, setActionBusyRef] = useState<string | null>(null);
  const [replyOpen, setReplyOpen] = useState(false);
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  const [customSnoozeValue, setCustomSnoozeValue] = useState("");
  const seenAttemptedRef = useRef(new Set<string>());
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const [mobilePane, setMobilePane] = useState<MobilePane>(
    searchParams.get("m") ? "reader" : "list",
  );

  const inbox = params.inbox;
  const folder = params.folder;
  const mailboxId = params.mailboxId;
  const selectedRef = searchParams.get("m");
  const query = searchParams.get("q") ?? "";
  const systemFolder = isSystemFolder(folder) ? folder : undefined;

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

  const loadMessages = useCallback(
    async (cursor: string | null, append: boolean) => {
      if (!inbox || !allowedInboxes.includes(inbox)) return;
      if (!mailboxId && !systemFolder) return;

      if (append) setLoadingMore(true);
      else setLoading(true);

      try {
        const request = mailboxId
          ? fetchMessages({
              inbox,
              mailboxId,
              q: query || undefined,
              cursor: cursor || undefined,
              limit: PAGE_SIZE,
            })
          : systemFolder === "starred"
            ? fetchMessages({
                inbox,
                starred: true,
                includeTrashed: false,
                includeSpam: false,
                q: query || undefined,
                cursor: cursor || undefined,
                limit: PAGE_SIZE,
              })
            : fetchMessages({
                inbox,
                folder: systemFolder,
                q: query || undefined,
                cursor: cursor || undefined,
                limit: PAGE_SIZE,
                excludeCampaignSends:
                  systemFolder === "sent" ? !showCampaignSends : undefined,
              });

        const result = await request;
        setMessages((current) =>
          append ? [...current, ...result.messages] : result.messages,
        );
        setNextCursor(result.nextCursor);
        if (!append) setShowNewMessages(false);
      } catch (error) {
        if (!append) {
          setMessages([]);
          setNextCursor(null);
        }
        showToast({
          kind: "error",
          message: "Couldn’t load mail",
          description: error instanceof Error ? error.message : undefined,
        });
      } finally {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [allowedInboxes, inbox, mailboxId, query, showCampaignSends, systemFolder],
  );

  useEffect(() => {
    void loadMessages(null, false);
  }, [loadMessages]);

  useRealtimeUpdates((event) => {
    if (
      !inbox ||
      (event.inbox && event.inbox.toLowerCase() !== inbox.toLowerCase())
    ) {
      return;
    }

    const list = listScrollRef.current;
    if (!list || list.scrollTop <= 4) {
      void loadMessages(null, false);
    } else {
      setShowNewMessages(true);
    }
  });

  useEffect(
    () =>
      onMailRefresh(() => {
        void loadMessages(null, false);
      }),
    [loadMessages],
  );

  useEffect(() => {
    if (selectedRef) setMobilePane("reader");
    setReplyOpen(false);
    setCustomSnoozeOpen(false);
  }, [selectedRef]);

  const selectedMessage =
    messages.find((message) => message.ref === selectedRef) ?? null;
  const currentMailbox = mailboxId
    ? (mailboxes.find((mailbox) => mailbox.id === mailboxId) ?? null)
    : null;
  const currentFolderLabel =
    currentMailbox?.name ??
    SYSTEM_FOLDERS.find((entry) => entry.id === systemFolder)?.label ??
    "Mail";

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

  function optimisticUpdate(
    ref: string,
    update: (message: MailMessage) => MailMessage,
  ) {
    setMessages((current) =>
      current.map((message) =>
        message.ref === ref ? update(message) : message,
      ),
    );
  }

  async function runOptimisticAction(
    message: MailMessage,
    update: (current: MailMessage) => MailMessage,
    request: () => Promise<unknown>,
    options?: { removeAfterSuccess?: boolean; errorMessage?: string },
  ) {
    optimisticUpdate(message.ref, update);
    setActionBusyRef(message.ref);
    try {
      await request();
      if (options?.removeAfterSuccess) {
        setMessages((current) =>
          current.filter((item) => item.ref !== message.ref),
        );
        if (selectedRef === message.ref) clearSelection();
      }
    } catch (error) {
      await loadMessages(null, false);
      showToast({
        kind: "error",
        message: options?.errorMessage ?? "Couldn’t update message",
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setActionBusyRef((current) => (current === message.ref ? null : current));
    }
  }

  async function toggleStar(message: MailMessage) {
    const starred = message.state.starredAt === null;
    await runOptimisticAction(
      message,
      (current) =>
        patchMessageState(current, {
          starredAt: starred ? unixSeconds(new Date()) : null,
        }),
      () => setMessageState({ refs: [message.ref], starred }),
      {
        removeAfterSuccess: systemFolder === "starred" && !starred,
        errorMessage: "Couldn’t update star",
      },
    );
  }

  async function toggleArchive(message: MailMessage) {
    const archived = message.state.archivedAt === null;
    await runOptimisticAction(
      message,
      (current) =>
        patchMessageState(current, {
          archivedAt: archived ? unixSeconds(new Date()) : null,
        }),
      () => setMessageState({ refs: [message.ref], archived }),
      {
        removeAfterSuccess:
          (systemFolder === "inbox" && archived) ||
          (systemFolder === "archive" && !archived),
        errorMessage: archived
          ? "Couldn’t archive message"
          : "Couldn’t unarchive message",
      },
    );
  }

  async function toggleSpam(message: MailMessage) {
    const spam = message.state.spamAt === null;
    await runOptimisticAction(
      message,
      (current) =>
        patchMessageState(current, {
          spamAt: spam ? unixSeconds(new Date()) : null,
        }),
      () => setMessageState({ refs: [message.ref], spam }),
      {
        removeAfterSuccess:
          (systemFolder === "junk" && !spam) ||
          ((systemFolder === "inbox" || systemFolder === "archive") && spam),
        errorMessage: spam
          ? "Couldn’t mark message as spam"
          : "Couldn’t remove message from spam",
      },
    );
  }

  async function toggleTrash(message: MailMessage) {
    const trashed = message.state.trashedAt === null;
    await runOptimisticAction(
      message,
      (current) =>
        patchMessageState(current, {
          trashedAt: trashed ? unixSeconds(new Date()) : null,
        }),
      () => setMessageState({ refs: [message.ref], trashed }),
      {
        removeAfterSuccess:
          (systemFolder === "trash" && !trashed) ||
          (systemFolder !== "trash" && trashed) ||
          Boolean(mailboxId && trashed),
        errorMessage: trashed
          ? "Couldn’t move message to trash"
          : "Couldn’t restore message",
      },
    );
  }

  async function snoozeMessage(message: MailMessage, until: number) {
    await runOptimisticAction(
      message,
      (current) => patchMessageState(current, { snoozedUntil: until }),
      () => snoozeMessages([message.ref], until),
      {
        removeAfterSuccess: systemFolder === "inbox",
        errorMessage: "Couldn’t snooze message",
      },
    );
  }

  async function moveToMailbox(message: MailMessage, targetId: string) {
    const remove = message.state.mailboxIds.filter((id) => id !== targetId);
    await runOptimisticAction(
      message,
      (current) =>
        patchMessageState(current, {
          mailboxIds: [targetId],
        }),
      () =>
        setMailboxMembership({
          refs: [message.ref],
          add: message.state.mailboxIds.includes(targetId)
            ? undefined
            : [targetId],
          remove: remove.length > 0 ? remove : undefined,
        }),
      {
        removeAfterSuccess: Boolean(mailboxId && mailboxId !== targetId),
        errorMessage: "Couldn’t move message",
      },
    );
  }

  async function removeFromCurrentMailbox(message: MailMessage) {
    if (!mailboxId) return;
    await runOptimisticAction(
      message,
      (current) =>
        patchMessageState(current, {
          mailboxIds: current.state.mailboxIds.filter((id) => id !== mailboxId),
        }),
      () =>
        setMailboxMembership({
          refs: [message.ref],
          remove: [mailboxId],
        }),
      {
        removeAfterSuccess: true,
        errorMessage: "Couldn’t remove message from folder",
      },
    );
  }

  useEffect(() => {
    if (
      !selectedMessage ||
      selectedMessage.direction !== "inbound" ||
      selectedMessage.state.seen ||
      seenAttemptedRef.current.has(selectedMessage.ref)
    ) {
      return;
    }

    seenAttemptedRef.current.add(selectedMessage.ref);
    optimisticUpdate(selectedMessage.ref, (current) =>
      patchMessageState(current, { seen: true }),
    );
    setMessageState({ refs: [selectedMessage.ref], seen: true }).catch(
      (error) => {
        void loadMessages(null, false);
        showToast({
          kind: "error",
          message: "Couldn’t mark message as read",
          description: error instanceof Error ? error.message : undefined,
        });
      },
    );
  }, [loadMessages, selectedMessage]);

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
    void snoozeMessage(message, unixSeconds(date));
  }

  async function createCustomFolder() {
    const name = newFolderName.trim();
    if (!inbox || !name || creatingFolder) return;

    setCreatingFolder(true);
    try {
      const mailbox = await createMailbox({ inbox, name });
      setMailboxes((current) => [...current, mailbox]);
      setNewFolderName("");
    } catch (error) {
      showToast({
        kind: "error",
        message: "Couldn’t create folder",
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setCreatingFolder(false);
    }
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
              onSelect={() => void moveToMailbox(message, mailbox.id)}
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
          <aside
            className={`${mobilePane === "folders" ? "flex" : "hidden"} w-full shrink-0 flex-col border-r border-border bg-bg-subtle md:flex md:w-56`}
          >
            <div className="border-b border-border p-3">
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
                Inbox
              </label>
              <select
                aria-label="Mail inbox"
                value={inbox}
                onChange={(event) => {
                  navigate(mailPath(event.target.value, "inbox"));
                  setMobilePane("list");
                }}
                className="w-full rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary outline-none focus:border-text-tertiary"
              >
                {stats.senderIdentities.map((identity) => (
                  <option key={identity.email} value={identity.email}>
                    {identity.displayName || identity.email}
                  </option>
                ))}
              </select>
            </div>

            <nav className="min-h-0 flex-1 overflow-y-auto p-2">
              {SYSTEM_FOLDERS.map((entry) => {
                const Icon = entry.icon;
                const active = !mailboxId && systemFolder === entry.id;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => openSystemFolder(entry.id)}
                    data-testid={`mail-folder-${entry.id}`}
                    className={`flex w-full items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-sm transition-colors ${
                      active
                        ? "bg-bg-muted font-medium text-text-primary"
                        : "text-text-secondary hover:bg-bg-muted/70 hover:text-text-primary"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {entry.label}
                  </button>
                );
              })}

              <div className="my-2 border-t border-border" />
              <p className="px-2.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
                Folders
              </p>
              <div className="mb-2 flex gap-1 px-1">
                <input
                  aria-label="New folder name"
                  data-testid="mail-create-folder-input"
                  value={newFolderName}
                  onChange={(event) => setNewFolderName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void createCustomFolder();
                    }
                  }}
                  placeholder="New folder"
                  className="min-w-0 flex-1 rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary outline-none focus:border-text-tertiary"
                />
                <button
                  type="button"
                  data-testid="mail-create-folder-button"
                  disabled={!newFolderName.trim() || creatingFolder}
                  onClick={() => void createCustomFolder()}
                  className="rounded-[6px] border border-border px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-muted disabled:opacity-50"
                >
                  {creatingFolder ? "…" : "Add"}
                </button>
              </div>
              {mailboxes.length === 0 ? (
                <p className="px-2.5 py-2 text-xs text-text-tertiary">
                  No custom folders
                </p>
              ) : (
                mailboxes.map((mailbox) => (
                  <button
                    key={mailbox.id}
                    type="button"
                    onClick={() => openMailbox(mailbox.id)}
                    data-testid="mail-custom-folder"
                    data-mailbox-id={mailbox.id}
                    className={`flex w-full items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-sm transition-colors ${
                      mailbox.id === mailboxId
                        ? "bg-bg-muted font-medium text-text-primary"
                        : "text-text-secondary hover:bg-bg-muted/70 hover:text-text-primary"
                    }`}
                  >
                    <Folder className="h-4 w-4" />
                    <span className="truncate">{mailbox.name}</span>
                  </button>
                ))
              )}
            </nav>
          </aside>

          <section
            className={`${mobilePane === "list" ? "flex" : "hidden"} w-full min-w-0 flex-col border-r border-border md:flex md:w-[390px] md:shrink-0`}
          >
            <div className="border-b border-border p-3">
              <div className="mb-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setMobilePane("folders")}
                  className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1 text-xs text-text-secondary hover:bg-bg-muted md:hidden"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Folders
                </button>
                <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
                  {currentFolderLabel}
                </h1>
                {systemFolder === "sent" && (
                  <label className="flex shrink-0 items-center gap-1.5 text-[10px] text-text-secondary">
                    <input
                      type="checkbox"
                      checked={showCampaignSends}
                      onChange={(event) =>
                        setShowCampaignSends(event.target.checked)
                      }
                      className="h-3 w-3 rounded border-border"
                    />
                    Show campaign sends
                  </label>
                )}
              </div>
              <label className="relative block">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
                <input
                  aria-label="Search mail"
                  value={query}
                  onChange={(event) => updateSearch(event.target.value)}
                  placeholder="Search this folder"
                  className="w-full rounded-[6px] border border-border bg-bg-subtle py-2 pl-8 pr-3 text-xs text-text-primary outline-none placeholder:text-text-tertiary focus:border-text-tertiary"
                />
              </label>
            </div>

            {showNewMessages && (
              <div className="border-b border-border bg-bg-subtle p-2">
                <button
                  type="button"
                  data-testid="mail-new-messages"
                  onClick={() => {
                    listScrollRef.current?.scrollTo({ top: 0 });
                    void loadMessages(null, false);
                  }}
                  className="w-full rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-background"
                >
                  New messages
                </button>
              </div>
            )}

            <div
              ref={listScrollRef}
              onScroll={(event) => {
                if (event.currentTarget.scrollTop <= 4) {
                  setShowNewMessages(false);
                }
              }}
              className="min-h-0 flex-1 overflow-y-auto"
            >
              {loading ? (
                <p className="p-4 text-sm text-text-tertiary">
                  Loading messages…
                </p>
              ) : messages.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
                  <MailOpen className="h-6 w-6 text-text-tertiary" />
                  <p className="text-sm text-text-tertiary">
                    No messages here.
                  </p>
                </div>
              ) : (
                <>
                  {messages.map((message) => {
                    const unseen =
                      message.direction === "inbound" && !message.state.seen;
                    const snippet = bodySnippet(message);
                    const busy = actionBusyRef === message.ref;
                    return (
                      <div
                        key={message.ref}
                        role="button"
                        tabIndex={0}
                        data-testid="mail-message-row"
                        data-message-ref={message.ref}
                        onClick={() => selectMessage(message.ref)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            selectMessage(message.ref);
                          }
                        }}
                        className={`border-b border-border px-3 py-3 text-left transition-colors hover:bg-bg-subtle ${
                          selectedRef === message.ref ? "bg-bg-muted" : ""
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`min-w-0 flex-1 truncate text-xs text-text-primary ${
                              unseen ? "font-bold" : "font-medium"
                            }`}
                          >
                            {counterparty(message)}
                          </span>
                          {message.attachmentCount ? (
                            <Paperclip className="h-3 w-3 shrink-0 text-text-tertiary" />
                          ) : null}
                          <button
                            type="button"
                            disabled={busy}
                            aria-label={
                              message.state.starredAt
                                ? "Remove star"
                                : "Add star"
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              void toggleStar(message);
                            }}
                            className="rounded p-0.5 text-text-tertiary hover:bg-bg-muted hover:text-text-primary disabled:opacity-50"
                          >
                            <Star
                              className={`h-3.5 w-3.5 ${
                                message.state.starredAt ? "fill-current" : ""
                              }`}
                            />
                          </button>
                          <span className="shrink-0 text-[10px] text-text-tertiary">
                            {compactTime(message.occurredAt)}
                          </span>
                        </div>
                        <p
                          className={`mt-1 truncate text-sm text-text-primary ${
                            unseen ? "font-semibold" : "font-normal"
                          }`}
                        >
                          {message.subject || "(no subject)"}
                        </p>
                        {snippet && (
                          <p className="mt-1 line-clamp-2 text-xs leading-4 text-text-tertiary">
                            {snippet}
                          </p>
                        )}
                        <div className="mt-1.5 flex flex-wrap items-center gap-1">
                          {message.source.campaignId && (
                            <span className="rounded bg-bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-text-secondary">
                              Campaign
                            </span>
                          )}
                          {message.source.sequenceId && (
                            <span className="rounded bg-bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-text-secondary">
                              Sequence
                            </span>
                          )}
                          {message.state.snoozedUntil &&
                            message.state.snoozedUntil >
                              unixSeconds(new Date()) && (
                              <span className="rounded bg-bg-muted px-1.5 py-0.5 text-[9px] text-text-secondary">
                                {snoozedLabel(message.state.snoozedUntil)}
                              </span>
                            )}
                        </div>
                      </div>
                    );
                  })}
                  {nextCursor && (
                    <div className="p-3">
                      <button
                        type="button"
                        disabled={loadingMore}
                        data-testid="mail-load-more"
                        onClick={() => void loadMessages(nextCursor, true)}
                        className="w-full rounded-[6px] border border-border bg-card px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-subtle hover:text-text-primary disabled:opacity-50"
                      >
                        {loadingMore ? "Loading…" : "Load more"}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </section>

          <section
            className={`${mobilePane === "reader" ? "flex" : "hidden"} min-w-0 flex-1 flex-col bg-card md:flex`}
          >
            {selectedRef ? (
              <>
                <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                  <button
                    type="button"
                    onClick={clearSelection}
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
                        onClick={() => void toggleStar(selectedMessage)}
                        data-testid="mail-reading-star"
                        className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-muted hover:text-text-primary disabled:opacity-50"
                      >
                        <Star
                          className={`h-3.5 w-3.5 ${
                            selectedMessage.state.starredAt
                              ? "fill-current"
                              : ""
                          }`}
                        />
                        {selectedMessage.state.starredAt ? "Unstar" : "Star"}
                      </button>
                      {selectedMessage.direction === "inbound" && (
                        <>
                          <button
                            type="button"
                            disabled={actionBusyRef === selectedMessage.ref}
                            onClick={() => void toggleArchive(selectedMessage)}
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
                            onClick={() => void toggleSpam(selectedMessage)}
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
                        onClick={() => void toggleTrash(selectedMessage)}
                        data-testid="mail-reading-trash"
                        className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-muted hover:text-text-primary disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {selectedMessage.state.trashedAt ? "Restore" : "Trash"}
                      </button>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            disabled={actionBusyRef === selectedMessage.ref}
                            className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-muted hover:text-text-primary disabled:opacity-50"
                          >
                            <Clock3 className="h-3.5 w-3.5" />
                            Snooze
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
                          <DropdownMenuItem
                            onSelect={() =>
                              void snoozeMessage(
                                selectedMessage,
                                snoozeInHours(3),
                              )
                            }
                          >
                            In 3 hours
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              void snoozeMessage(
                                selectedMessage,
                                tomorrowAtEight(),
                              )
                            }
                          >
                            Tomorrow at 08:00
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              void snoozeMessage(
                                selectedMessage,
                                nextMondayAtEight(),
                              )
                            }
                          >
                            Next Monday at 08:00
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={openCustomSnooze}>
                            Custom…
                          </DropdownMenuItem>
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
                                    void removeFromCurrentMailbox(
                                      selectedMessage,
                                    )
                                  }
                                >
                                  Remove from {currentMailbox?.name ?? "folder"}
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}

                      {selectedMessage.personId && (
                        <button
                          type="button"
                          onClick={() =>
                            navigate(
                              `/inbox/${encodeURIComponent(
                                selectedMessage.inbox,
                              )}/${encodeURIComponent(
                                selectedMessage.personId!,
                              )}`,
                            )
                          }
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

                    <article
                      data-testid="mail-reading-pane"
                      className="p-5 md:p-7"
                    >
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

                      <div className="py-6">
                        {selectedMessage.bodyHtml ? (
                          <div
                            className="prose prose-sm max-w-none break-words text-text-primary"
                            dangerouslySetInnerHTML={{
                              __html: sanitizeEmailHtml(
                                selectedMessage.bodyHtml,
                              ),
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
        </div>
      </div>

      {replyOpen &&
        selectedMessage?.direction === "inbound" &&
        selectedMessage.from && (
          <ReplyComposer
            emailId={selectedMessage.ref.slice("received:".length)}
            personName={selectedMessage.from.name ?? null}
            personEmail={selectedMessage.from.email}
            recipients={[selectedMessage.inbox]}
            senderIdentities={stats.senderIdentities}
            internalDomains={internalDomains}
            onClose={() => setReplyOpen(false)}
            onSent={() => {
              setReplyOpen(false);
              void loadMessages(null, false);
            }}
          />
        )}
    </>
  );
}
