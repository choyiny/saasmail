import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchMessages,
  setMailboxMembership,
  setMessageState,
  snoozeMessages,
  type MailMessage,
  type MailMessageState,
} from "@/lib/api";
import { useRealtimeUpdates } from "@/hooks/useRealtimeUpdates";
import { onMailRefresh } from "@/lib/mail-events";
import { showToast } from "@/lib/toast";

const PAGE_SIZE = 50;
export const MAIL_BULK_CHUNK_SIZE = 500;

export function chunkMailRefs(refs: string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < refs.length; index += MAIL_BULK_CHUNK_SIZE) {
    chunks.push(refs.slice(index, index + MAIL_BULK_CHUNK_SIZE));
  }
  return chunks;
}

export type SystemFolder =
  | "inbox"
  | "starred"
  | "snoozed"
  | "sent"
  | "archive"
  | "junk"
  | "trash";

interface UseMailMessagesOptions {
  inbox?: string;
  allowedInboxes: string[];
  mailboxId?: string;
  systemFolder?: SystemFolder;
  query: string;
  selectedRef: string | null;
  onClearSelected: () => void;
}

function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function patchMessageState(
  message: MailMessage,
  patch: Partial<MailMessageState>,
): MailMessage {
  return { ...message, state: { ...message.state, ...patch } };
}

export function useMailMessages({
  inbox,
  allowedInboxes,
  mailboxId,
  systemFolder,
  query,
  selectedRef,
  onClearSelected,
}: UseMailMessagesOptions) {
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showCampaignSends, setShowCampaignSends] = useState(false);
  const [showNewMessages, setShowNewMessages] = useState(false);
  const [actionBusyRef, setActionBusyRef] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const seenAttemptedRef = useRef(new Set<string>());
  const listScrollRef = useRef<HTMLDivElement | null>(null);

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

  const selectedMessage =
    messages.find((message) => message.ref === selectedRef) ?? null;

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
        if (selectedRef === message.ref) onClearSelected();
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

  async function runBulkAction(
    selectedMessages: MailMessage[],
    update: (current: MailMessage) => MailMessage,
    request: (refs: string[]) => Promise<unknown>,
    options?: { removeAfterSuccess?: boolean; errorMessage?: string },
  ): Promise<boolean> {
    if (selectedMessages.length === 0) return false;

    const selectedRefs = new Set(
      selectedMessages.map((message) => message.ref),
    );
    setMessages((current) =>
      current.map((message) =>
        selectedRefs.has(message.ref) ? update(message) : message,
      ),
    );
    setBulkBusy(true);
    try {
      const refs = selectedMessages.map((message) => message.ref);
      await request(refs);
      if (options?.removeAfterSuccess) {
        setMessages((current) =>
          current.filter((message) => !selectedRefs.has(message.ref)),
        );
        if (selectedRef && selectedRefs.has(selectedRef)) onClearSelected();
      }
      return true;
    } catch (error) {
      await loadMessages(null, false);
      showToast({
        kind: "error",
        message: options?.errorMessage ?? "Couldn’t update selected messages",
        description: error instanceof Error ? error.message : undefined,
      });
      return false;
    } finally {
      setBulkBusy(false);
    }
  }

  async function forEachRefChunk(
    refs: string[],
    request: (chunk: string[]) => Promise<unknown>,
  ) {
    for (const chunk of chunkMailRefs(refs)) {
      await request(chunk);
    }
  }

  async function bulkSetSeen(
    selectedMessages: MailMessage[],
    seen: boolean,
  ): Promise<boolean> {
    return runBulkAction(
      selectedMessages,
      (current) => patchMessageState(current, { seen }),
      (refs) =>
        forEachRefChunk(refs, (chunk) =>
          setMessageState({ refs: chunk, seen }),
        ),
      {
        errorMessage: seen
          ? "Couldn’t mark messages as seen"
          : "Couldn’t mark messages as unseen",
      },
    );
  }

  async function bulkSetStarred(
    selectedMessages: MailMessage[],
    starred: boolean,
  ): Promise<boolean> {
    const starredAt = starred ? unixSeconds(new Date()) : null;
    return runBulkAction(
      selectedMessages,
      (current) => patchMessageState(current, { starredAt }),
      (refs) =>
        forEachRefChunk(refs, (chunk) =>
          setMessageState({ refs: chunk, starred }),
        ),
      {
        removeAfterSuccess: systemFolder === "starred" && !starred,
        errorMessage: "Couldn’t update selected stars",
      },
    );
  }

  async function bulkSetArchived(
    selectedMessages: MailMessage[],
    archived: boolean,
  ): Promise<boolean> {
    const archivedAt = archived ? unixSeconds(new Date()) : null;
    return runBulkAction(
      selectedMessages,
      (current) => patchMessageState(current, { archivedAt }),
      (refs) =>
        forEachRefChunk(refs, (chunk) =>
          setMessageState({ refs: chunk, archived }),
        ),
      {
        removeAfterSuccess:
          (systemFolder === "inbox" && archived) ||
          (systemFolder === "archive" && !archived),
        errorMessage: archived
          ? "Couldn’t archive selected messages"
          : "Couldn’t unarchive selected messages",
      },
    );
  }

  async function bulkSetSpam(
    selectedMessages: MailMessage[],
    spam: boolean,
  ): Promise<boolean> {
    const spamAt = spam ? unixSeconds(new Date()) : null;
    return runBulkAction(
      selectedMessages,
      (current) => patchMessageState(current, { spamAt }),
      (refs) =>
        forEachRefChunk(refs, (chunk) =>
          setMessageState({ refs: chunk, spam }),
        ),
      {
        removeAfterSuccess:
          (systemFolder === "junk" && !spam) ||
          ((systemFolder === "inbox" || systemFolder === "archive") && spam),
        errorMessage: spam
          ? "Couldn’t mark selected messages as spam"
          : "Couldn’t remove selected messages from spam",
      },
    );
  }

  async function bulkSetTrashed(
    selectedMessages: MailMessage[],
    trashed: boolean,
  ): Promise<boolean> {
    const trashedAt = trashed ? unixSeconds(new Date()) : null;
    return runBulkAction(
      selectedMessages,
      (current) => patchMessageState(current, { trashedAt }),
      (refs) =>
        forEachRefChunk(refs, (chunk) =>
          setMessageState({ refs: chunk, trashed }),
        ),
      {
        removeAfterSuccess:
          (systemFolder === "trash" && !trashed) ||
          (systemFolder !== "trash" && trashed) ||
          Boolean(mailboxId && trashed),
        errorMessage: trashed
          ? "Couldn’t trash selected messages"
          : "Couldn’t restore selected messages",
      },
    );
  }

  async function bulkSnooze(
    selectedMessages: MailMessage[],
    until: number,
  ): Promise<boolean> {
    return runBulkAction(
      selectedMessages,
      (current) => patchMessageState(current, { snoozedUntil: until }),
      (refs) => forEachRefChunk(refs, (chunk) => snoozeMessages(chunk, until)),
      {
        removeAfterSuccess: systemFolder === "inbox",
        errorMessage: "Couldn’t snooze selected messages",
      },
    );
  }

  async function bulkMoveToMailbox(
    selectedMessages: MailMessage[],
    targetId: string,
  ): Promise<boolean> {
    const remove = Array.from(
      new Set(
        selectedMessages.flatMap((message) =>
          message.state.mailboxIds.filter((id) => id !== targetId),
        ),
      ),
    );
    return runBulkAction(
      selectedMessages,
      (current) =>
        patchMessageState(current, {
          mailboxIds: [targetId],
        }),
      (refs) =>
        forEachRefChunk(refs, (chunk) =>
          setMailboxMembership({
            refs: chunk,
            add: [targetId],
            remove: remove.length > 0 ? remove : undefined,
          }),
        ),
      {
        removeAfterSuccess: Boolean(mailboxId && mailboxId !== targetId),
        errorMessage: "Couldn’t move selected messages",
      },
    );
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

  return {
    messages,
    selectedMessage,
    nextCursor,
    loading,
    loadingMore,
    showCampaignSends,
    setShowCampaignSends,
    showNewMessages,
    setShowNewMessages,
    actionBusyRef,
    bulkBusy,
    listScrollRef,
    loadMessages,
    toggleStar,
    toggleArchive,
    toggleSpam,
    toggleTrash,
    snoozeMessage,
    moveToMailbox,
    removeFromCurrentMailbox,
    bulkSetSeen,
    bulkSetStarred,
    bulkSetArchived,
    bulkSetSpam,
    bulkSetTrashed,
    bulkSnooze,
    bulkMoveToMailbox,
  };
}
