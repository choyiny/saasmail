import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

const api = vi.hoisted(() => ({
  createMailbox: vi.fn(),
  fetchMailboxes: vi.fn(),
  fetchMessages: vi.fn(),
  fetchStats: vi.fn(),
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

function message(id: string, subject: string) {
  return {
    ref: `received:${id}`,
    direction: "inbound" as const,
    inbox: "support@e2e.test",
    personId: "person-1",
    conversationId: null,
    messageId: `${id}@example.test`,
    inReplyTo: null,
    from: { email: "person@example.test", name: "Person" },
    to: { email: "support@e2e.test", name: "Support" },
    cc: [],
    subject,
    bodyText: `Body for ${subject}`,
    bodyHtml: null,
    occurredAt: 1_800_000_000,
    isRead: false,
    source: {
      campaignId: null,
      sequenceId: null,
      sequenceEnrollmentId: null,
    },
    delivery: null,
    attachmentCount: 0,
    state: { ...baseState },
  };
}

function renderMail(path = "/mail/support%40e2e.test/inbox") {
  const router = createMemoryRouter(
    [
      { path: "/mail/:inbox/:folder", element: <MailPage /> },
      { path: "/mail/:inbox/f/:mailboxId", element: <MailPage /> },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("MailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    api.fetchMailboxes.mockResolvedValue([]);
    api.fetchMessages.mockResolvedValue({ messages: [], nextCursor: null });
    api.createMailbox.mockResolvedValue({
      id: "mailbox-1",
      inbox: "support@e2e.test",
      name: "Projects",
      role: null,
      parentId: null,
      sortOrder: 0,
      createdBy: null,
      createdAt: 1,
      updatedAt: 1,
    });
    api.setMailboxMembership.mockResolvedValue({ success: true });
    api.setMessageState.mockResolvedValue({ success: true });
    api.snoozeMessages.mockResolvedValue({ conversations: 1 });
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
});
