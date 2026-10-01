// Two races in the conventional mailbox list, found through a flaky e2e test
// (mailbox.spec.ts "custom folders"): an action that finishes after the user
// moved to another folder, and an older list response landing after a newer one.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useMailMessages } from "@/hooks/useMailMessages";
import {
  fetchMessages,
  setMessageState,
  type MailMessage,
  type MailMessageState,
} from "@/lib/api";

vi.mock("@/lib/api", () => ({
  fetchMessages: vi.fn(),
  setMessageState: vi.fn(),
  setMailboxMembership: vi.fn(),
  snoozeMessages: vi.fn(),
  assignMessages: vi.fn(),
}));
vi.mock("@/hooks/useRealtimeUpdates", () => ({
  useRealtimeUpdates: () => {},
}));
vi.mock("@/lib/toast", () => ({ showToast: vi.fn() }));

const mFetch = vi.mocked(fetchMessages);
const mSetState = vi.mocked(setMessageState);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function message(ref: string, state: Partial<MailMessageState> = {}) {
  return {
    ref,
    direction: "inbound",
    inbox: "support@x.test",
    personId: null,
    conversationId: null,
    messageId: null,
    inReplyTo: null,
    from: null,
    to: { email: "support@x.test" },
    cc: [],
    subject: ref,
    bodyText: null,
    bodyHtml: null,
    occurredAt: 1,
    isRead: true,
    source: { campaignId: null, sequenceId: null, sequenceEnrollmentId: null },
    delivery: null,
    state: { trashedAt: null, archivedAt: null, ...state },
  } as unknown as MailMessage;
}

type Props = Parameters<typeof useMailMessages>[0];
const props = (systemFolder: Props["systemFolder"]): Props => ({
  inbox: "support@x.test",
  allowedInboxes: ["support@x.test"],
  systemFolder,
  query: "",
  selectedRef: null,
  onClearSelected: () => {},
});

const page = (messages: MailMessage[]) => ({ messages, nextCursor: null });

beforeEach(() => {
  mFetch.mockReset();
  mSetState.mockReset();
});

describe("useMailMessages races", () => {
  it("reloads the folder the user moved to when an action finishes after the move", async () => {
    const trashed = message("received:m1", { trashedAt: 10 });
    const restored = message("received:m1");
    mFetch.mockResolvedValueOnce(page([trashed]) as never);
    const { result, rerender } = renderHook((p: Props) => useMailMessages(p), {
      initialProps: props("trash"),
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    // Restore, then open Inbox before the server has committed the restore.
    const request = deferred<unknown>();
    mSetState.mockReturnValueOnce(request.promise as never);
    mFetch.mockResolvedValueOnce(page([]) as never);
    let restore!: Promise<void>;
    act(() => {
      restore = result.current.toggleTrash(trashed);
    });
    rerender(props("inbox"));
    await waitFor(() => expect(mFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.messages).toEqual([]));

    // The restore lands: Inbox must reload and show the message.
    mFetch.mockResolvedValueOnce(page([restored]) as never);
    await act(async () => {
      request.resolve({});
      await restore;
    });
    await waitFor(() =>
      expect(result.current.messages.map((m) => m.ref)).toEqual([
        "received:m1",
      ]),
    );
    expect(mFetch).toHaveBeenCalledTimes(3);
  });

  it("does not reload when the action finishes on the view it started in", async () => {
    const m = message("received:m1");
    mFetch.mockResolvedValue(page([m]) as never);
    mSetState.mockResolvedValue({} as never);
    const { result } = renderHook((p: Props) => useMailMessages(p), {
      initialProps: props("inbox"),
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    await act(async () => {
      await result.current.toggleStar(m);
    });
    expect(mFetch).toHaveBeenCalledTimes(1);
  });

  it("ignores a list response that arrives after a newer one", async () => {
    const slowTrash = deferred<ReturnType<typeof page>>();
    mFetch.mockReturnValueOnce(slowTrash.promise as never);
    const { result, rerender } = renderHook((p: Props) => useMailMessages(p), {
      initialProps: props("trash"),
    });
    mFetch.mockResolvedValueOnce(page([message("received:inbox-1")]) as never);
    rerender(props("inbox"));
    await waitFor(() =>
      expect(result.current.messages.map((m) => m.ref)).toEqual([
        "received:inbox-1",
      ]),
    );

    await act(async () => {
      slowTrash.resolve(page([message("received:trash-1", { trashedAt: 5 })]));
      await slowTrash.promise;
    });
    expect(result.current.messages.map((m) => m.ref)).toEqual([
      "received:inbox-1",
    ]);
  });
});
