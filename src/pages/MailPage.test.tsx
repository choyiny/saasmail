import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { AgentContextProvider, useAgentContext } from "@/agent/AgentContext";

const api = vi.hoisted(() => ({
  createMailbox: vi.fn(),
  deleteDraft: vi.fn(),
  deleteMailbox: vi.fn(),
  fetchDraftList: vi.fn(),
  fetchMailboxes: vi.fn(),
  fetchMessages: vi.fn(),
  fetchStats: vi.fn(),
  renameMailbox: vi.fn(),
  setMailboxMembership: vi.fn(),
  setMessageState: vi.fn(),
  snoozeMessages: vi.fn(),
}));

vi.mock("@/lib/api", () => api);
vi.mock("@/hooks/useRealtimeUpdates", () => ({
  useRealtimeUpdates: vi.fn(),
}));
vi.mock("@/components/ReplyComposer", () => ({
  default: () => <div data-testid="reply-composer-mock" />,
}));

import MailPage from "@/pages/MailPage";

const onCompose = vi.fn();

function AgentContextProbe() {
  const { context } = useAgentContext();
  return (
    <output data-testid="agent-context-probe">{JSON.stringify(context)}</output>
  );
}

const baseState = {
  seen: false,
  starredAt: null,
  archivedAt: null,
  spamAt: null,
  trashedAt: null,
  mailboxIds: [],
  conversationKey: "p:person-1",
  snoozedUntil: null,
};

function message(
  id: string,
  subject: string,
  options?: {
    direction?: "inbound" | "outbound";
    state?: Partial<typeof baseState>;
  },
) {
  const direction = options?.direction ?? "inbound";
  const inbound = direction === "inbound";
  return {
    ref: `${inbound ? "received" : "sent"}:${id}`,
    direction,
    inbox: "support@e2e.test",
    personId: "person-1",
    conversationId: null,
    messageId: `${id}@example.test`,
    inReplyTo: null,
    from: inbound
      ? { email: "person@example.test", name: "Person" }
      : { email: "support@e2e.test", name: "Support" },
    to: inbound
      ? { email: "support@e2e.test", name: "Support" }
      : { email: "person@example.test", name: "Person" },
    cc: [],
    subject,
    bodyText: `Body for ${subject}`,
    bodyHtml: null,
    occurredAt: 1_800_000_000,
    isRead: inbound ? false : null,
    source: {
      campaignId: null,
      sequenceId: null,
      sequenceEnrollmentId: null,
    },
    delivery: inbound ? null : { status: "sent" },
    attachmentCount: 0,
    state: {
      ...baseState,
      seen: inbound ? baseState.seen : true,
      ...options?.state,
    },
  };
}

function mailbox(id: string, name: string, parentId: string | null = null) {
  return {
    id,
    inbox: "support@e2e.test",
    name,
    role: null,
    parentId,
    sortOrder: 0,
    createdBy: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function renderMail(path = "/mail/support%40e2e.test/inbox") {
  const router = createMemoryRouter(
    [
      {
        element: (
          <>
            <AgentContextProbe />
            <Outlet context={{ onCompose }} />
          </>
        ),
        children: [
          { path: "/mail/:inbox/:folder", element: <MailPage /> },
          { path: "/mail/:inbox/f/:mailboxId", element: <MailPage /> },
          { path: "/settings", element: <div>Settings page</div> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(
    <AgentContextProvider>
      <RouterProvider router={router} />
    </AgentContextProvider>,
  );
  return router;
}

describe("MailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onCompose.mockReset();
    api.fetchStats.mockResolvedValue({
      totalPeople: 1,
      totalEmails: 2,
      unreadCount: 1,
      recipients: ["support@e2e.test"],
      senderIdentities: [
        {
          email: "support@e2e.test",
          displayName: "Support",
          signatureHtml: null,
        },
      ],
    });
    api.fetchDraftList.mockResolvedValue({ drafts: [] });
    api.fetchMailboxes.mockResolvedValue([]);
    api.fetchMessages.mockResolvedValue({ messages: [], nextCursor: null });
    api.createMailbox.mockResolvedValue(mailbox("mailbox-1", "Projects"));
    api.deleteDraft.mockResolvedValue(undefined);
    api.deleteMailbox.mockResolvedValue({ success: true });
    api.renameMailbox.mockImplementation(async (id: string, name: string) => ({
      ...mailbox(id, name),
      updatedAt: 2,
    }));
    api.setMailboxMembership.mockResolvedValue({ success: true });
    api.setMessageState.mockResolvedValue({ success: true });
    api.snoozeMessages.mockResolvedValue({ conversations: 1 });
  });

  it("clears published agent context when navigating away", async () => {
    const router = renderMail(
      "/mail/support%40e2e.test/inbox?m=received%3Aone",
    );

    await waitFor(() =>
      expect(screen.getByTestId("agent-context-probe").textContent).toContain(
        "support@e2e.test",
      ),
    );
    await router.navigate("/settings");
    await screen.findByText("Settings page");

    await waitFor(() =>
      expect(screen.getByTestId("agent-context-probe").textContent).toBe("{}"),
    );
  });

  it("lists inbox drafts and opens compose and draft contexts", async () => {
    api.fetchDraftList.mockResolvedValue({
      drafts: [
        {
          id: "draft-compose",
          contextKey: "compose",
          fromAddress: "support@e2e.test",
          toAddress: "alice@example.test",
          subject: "Legacy compose",
          replyToEmailId: null,
          updatedAt: 1_800_000_000,
        },
        {
          id: "draft-new",
          contextKey: "draft:new-1",
          fromAddress: null,
          toAddress: "bob@example.test",
          subject: "Independent draft",
          replyToEmailId: null,
          updatedAt: 1_799_999_000,
        },
      ],
    });

    renderMail("/mail/support%40e2e.test/drafts");

    await waitFor(() =>
      expect(api.fetchDraftList).toHaveBeenCalledWith({
        inbox: "support@e2e.test",
      }),
    );
    expect(await screen.findByText("To: alice@example.test")).toBeTruthy();

    fireEvent.click(screen.getByText("Legacy compose"));
    expect(onCompose).toHaveBeenLastCalledWith(undefined, "compose");

    fireEvent.click(screen.getByText("Independent draft"));
    expect(onCompose).toHaveBeenLastCalledWith(undefined, "draft:new-1");

    fireEvent.click(screen.getByTestId("mail-new-message"));
    expect(onCompose.mock.calls.at(-1)?.[0]).toEqual({
      from: "support@e2e.test",
    });
    expect(onCompose.mock.calls.at(-1)?.[1]).toMatch(/^draft:[A-Za-z0-9_-]+$/);
  });

  it("opens reply drafts on the received message and restores the reply composer", async () => {
    api.fetchDraftList.mockResolvedValue({
      drafts: [
        {
          id: "draft-reply",
          contextKey: "reply:reply-target",
          fromAddress: "support@e2e.test",
          toAddress: "person@example.test",
          subject: "Reply draft",
          replyToEmailId: "reply-target",
          updatedAt: 1_800_000_000,
        },
      ],
    });
    api.fetchMessages.mockResolvedValue({
      messages: [
        message("reply-target", "Original message", {
          state: { seen: true },
        }),
      ],
      nextCursor: null,
    });
    const router = renderMail("/mail/support%40e2e.test/drafts");

    fireEvent.click(await screen.findByText("Reply draft"));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/mail/support%40e2e.test/inbox",
      ),
    );
    await waitFor(() =>
      expect(router.state.location.search).toContain(
        "m=received%3Areply-target",
      ),
    );
    expect(await screen.findByTestId("reply-composer-mock")).toBeTruthy();
  });

  it("deletes a draft after confirmation", async () => {
    api.fetchDraftList.mockResolvedValue({
      drafts: [
        {
          id: "draft-delete",
          contextKey: "draft:delete-me",
          fromAddress: "support@e2e.test",
          toAddress: "person@example.test",
          subject: "Delete me",
          replyToEmailId: null,
          updatedAt: 1_800_000_000,
        },
      ],
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderMail("/mail/support%40e2e.test/drafts");

    await screen.findByText("Delete me");
    fireEvent.click(
      screen.getByRole("button", { name: "Delete draft Delete me" }),
    );

    await waitFor(() =>
      expect(api.deleteDraft).toHaveBeenCalledWith("draft:delete-me"),
    );
    await waitFor(() => expect(screen.queryByText("Delete me")).toBeNull());
    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("switches folders using the matching message query", async () => {
    renderMail();
    await waitFor(() => expect(api.fetchMessages).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("mail-folder-starred"));

    await waitFor(() =>
      expect(api.fetchMessages).toHaveBeenLastCalledWith(
        expect.objectContaining({
          inbox: "support@e2e.test",
          starred: true,
          includeTrashed: false,
          includeSpam: false,
        }),
      ),
    );
  });

  it("appends Load more results and stops when nextCursor is null", async () => {
    api.fetchMessages
      .mockResolvedValueOnce({
        messages: [message("one", "First subject")],
        nextCursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        messages: [message("two", "Second subject")],
        nextCursor: null,
      });

    renderMail();

    await screen.findByText("First subject");
    fireEvent.click(screen.getByTestId("mail-load-more"));

    await screen.findByText("Second subject");
    expect(screen.getByText("First subject")).toBeTruthy();
    expect(screen.queryByTestId("mail-load-more")).toBeNull();
  });

  it("wires reading-pane seen, star, and archive actions to state APIs", async () => {
    api.fetchMessages.mockResolvedValue({
      messages: [message("one", "Action subject")],
      nextCursor: null,
    });

    renderMail("/mail/support%40e2e.test/inbox?m=received%3Aone");

    await screen.findByTestId("mail-reading-pane");
    await waitFor(() =>
      expect(api.setMessageState).toHaveBeenCalledWith({
        refs: ["received:one"],
        seen: true,
      }),
    );

    fireEvent.click(screen.getByTestId("mail-reading-star"));
    await waitFor(() =>
      expect(api.setMessageState).toHaveBeenCalledWith({
        refs: ["received:one"],
        starred: true,
      }),
    );

    fireEvent.click(screen.getByTestId("mail-reading-archive"));
    await waitFor(() =>
      expect(api.setMessageState).toHaveBeenCalledWith({
        refs: ["received:one"],
        archived: true,
      }),
    );
  });

  it("hides archive and spam bulk actions when any selected message is sent", async () => {
    api.fetchMessages.mockResolvedValue({
      messages: [
        message("received-one", "Inbound", {
          state: { seen: true },
        }),
        message("sent-one", "Outbound", {
          direction: "outbound",
        }),
      ],
      nextCursor: null,
    });

    renderMail();

    const rows = await screen.findAllByTestId("mail-message-row");
    fireEvent.click(
      within(rows[0]!).getByRole("checkbox", { name: "Select message" }),
    );
    fireEvent.click(
      within(rows[1]!).getByRole("checkbox", { name: "Select message" }),
    );

    await screen.findByTestId("mail-selection-bar");
    expect(screen.queryByTestId("mail-bulk-archive")).toBeNull();
    expect(screen.queryByTestId("mail-bulk-spam")).toBeNull();
  });

  it("chunks bulk refs at 500 and refetches authoritative state after a later chunk fails", async () => {
    const loaded = Array.from({ length: 501 }, (_, index) =>
      message(`bulk-${index}`, `Bulk ${index}`),
    );
    api.fetchMessages
      .mockResolvedValueOnce({ messages: loaded, nextCursor: null })
      .mockResolvedValue({
        messages: [
          message("authoritative", "Authoritative state", {
            state: { seen: false },
          }),
        ],
        nextCursor: null,
      });
    api.setMessageState
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error("second chunk failed"));

    renderMail();

    await screen.findByText("Bulk 0");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all loaded messages" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Seen" }));

    await waitFor(() => expect(api.setMessageState).toHaveBeenCalledTimes(2));
    expect(api.setMessageState.mock.calls[0]?.[0].refs).toHaveLength(500);
    expect(api.setMessageState.mock.calls[1]?.[0].refs).toHaveLength(1);
    await screen.findByText("Authoritative state");
    expect(api.fetchMessages.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it("wires child create, rename, and confirmed delete folder actions", async () => {
    api.fetchMailboxes.mockResolvedValue([
      mailbox("root", "Root"),
      mailbox("child", "Child", "root"),
    ]);
    const promptSpy = vi
      .spyOn(window, "prompt")
      .mockReturnValue("Renamed Root");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderMail();

    await screen.findByRole("button", { name: "Root" });
    fireEvent.change(screen.getByTestId("mail-create-folder-parent"), {
      target: { value: "root" },
    });
    fireEvent.change(screen.getByTestId("mail-create-folder-input"), {
      target: { value: "Nested" },
    });
    fireEvent.click(screen.getByTestId("mail-create-folder-button"));

    await waitFor(() =>
      expect(api.createMailbox).toHaveBeenCalledWith({
        inbox: "support@e2e.test",
        name: "Nested",
        parentId: "root",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename Root" }));
    await waitFor(() =>
      expect(api.renameMailbox).toHaveBeenCalledWith("root", "Renamed Root"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete Child" }));
    await waitFor(() =>
      expect(api.deleteMailbox).toHaveBeenCalledWith("child"),
    );
    expect(confirmSpy).toHaveBeenCalled();

    promptSpy.mockRestore();
    confirmSpy.mockRestore();
  });

  it("supports j/k navigation, Enter/o open, and u back", async () => {
    api.fetchMessages.mockResolvedValue({
      messages: [
        message("one", "Keyboard one", { state: { seen: true } }),
        message("two", "Keyboard two", { state: { seen: true } }),
      ],
      nextCursor: null,
    });
    const router = renderMail();

    await screen.findByText("Keyboard one");
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() =>
      expect(router.state.location.search).toContain("m=received%3Aone"),
    );

    fireEvent.keyDown(window, { key: "u" });
    await waitFor(() =>
      expect(router.state.location.search).not.toContain("m="),
    );

    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "k" });
    fireEvent.keyDown(window, { key: "o" });
    await waitFor(() =>
      expect(router.state.location.search).toContain("m=received%3Aone"),
    );
  });

  it("uses x to toggle selection", async () => {
    api.fetchMessages.mockResolvedValue({
      messages: [message("one", "Keyboard select", { state: { seen: true } })],
      nextCursor: null,
    });
    renderMail();

    await screen.findByText("Keyboard select");
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "x" });

    expect(await screen.findByTestId("mail-selection-bar")).toBeTruthy();
  });

  it.each([
    ["e", { archived: true }],
    ["s", { starred: true }],
    ["#", { trashed: true }],
  ])("uses %s for the matching message action", async (key, expectedState) => {
    api.fetchMessages.mockResolvedValue({
      messages: [message("one", "Keyboard action", { state: { seen: true } })],
      nextCursor: null,
    });
    renderMail("/mail/support%40e2e.test/inbox?m=received%3Aone");

    await screen.findByTestId("mail-reading-pane");
    api.setMessageState.mockClear();
    fireEvent.keyDown(window, { key, shiftKey: key === "#" });

    await waitFor(() =>
      expect(api.setMessageState).toHaveBeenCalledWith({
        refs: ["received:one"],
        ...expectedState,
      }),
    );
  });

  it("uses r to reply to the open received message", async () => {
    api.fetchMessages.mockResolvedValue({
      messages: [message("one", "Keyboard reply", { state: { seen: true } })],
      nextCursor: null,
    });
    renderMail("/mail/support%40e2e.test/inbox?m=received%3Aone");

    await screen.findByTestId("mail-reading-pane");
    fireEvent.keyDown(window, { key: "r" });

    expect(await screen.findByTestId("reply-composer-mock")).toBeTruthy();
  });

  it("uses ? to open the shortcuts dialog", async () => {
    renderMail();
    await waitFor(() => expect(api.fetchMessages).toHaveBeenCalled());

    fireEvent.keyDown(window, { key: "?", shiftKey: true });

    expect(await screen.findByTestId("mail-shortcuts-dialog")).toBeTruthy();
  });

  it("ignores shortcuts in editable controls and with command modifiers", async () => {
    api.fetchMessages.mockResolvedValue({
      messages: [message("one", "Keyboard guard", { state: { seen: true } })],
      nextCursor: null,
    });
    renderMail();

    await screen.findByText("Keyboard guard");
    fireEvent.keyDown(window, { key: "j" });

    const agentInput = document.createElement("textarea");
    const agentPanel = document.createElement("div");
    agentPanel.setAttribute("data-agent-panel", "");
    agentPanel.appendChild(agentInput);
    document.body.appendChild(agentPanel);

    const editableElements: HTMLElement[] = [
      screen.getByLabelText("Search mail"),
      document.createElement("textarea"),
      document.createElement("select"),
      document.createElement("div"),
      agentInput,
    ];
    editableElements[3]!.setAttribute("contenteditable", "true");

    for (const element of editableElements.slice(1, 4)) {
      document.body.appendChild(element);
    }

    for (const element of editableElements) {
      element.focus();
      fireEvent.keyDown(element, { key: "s" });
    }
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    expect(api.setMessageState).not.toHaveBeenCalled();

    for (const element of editableElements.slice(1, 4)) element.remove();
    agentPanel.remove();
  });
});
