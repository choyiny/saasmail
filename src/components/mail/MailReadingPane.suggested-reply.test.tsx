import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const draftStore = vi.hoisted(() => ({
  current: {
    id: "draft-1",
    contextKey: "reply:email-1",
    fromAddress: "support@example.com",
    toAddress: "customer@example.com",
    cc: null,
    subject: null,
    bodyHtml: "<p>Existing reply</p>",
    bodyText: "Existing reply",
    replyToEmailId: "email-1",
    updatedAt: 1,
  } as any,
}));

const api = vi.hoisted(() => ({
  fetchSuggestedReply: vi.fn(),
  fetchDraft: vi.fn(),
  saveDraft: vi.fn(),
  useSuggestedReply: vi.fn(),
  dismissSuggestedReply: vi.fn(),
}));

vi.mock("@/lib/api", () => api);
vi.mock("@/components/ReplyComposer", () => ({
  default: () => (
    <div data-testid="reply-composer">{draftStore.current?.bodyText ?? ""}</div>
  ),
}));

import MailReadingPane from "@/components/mail/MailReadingPane";

const suggestion = {
  id: "suggestion-1",
  emailId: "email-1",
  inbox: "support@example.com",
  bodyText: "Suggested replacement",
  model: "test",
  status: "pending",
  createdAt: 1,
  updatedAt: 1,
};

const message = {
  ref: "received:email-1",
  direction: "inbound",
  inbox: "support@example.com",
  personId: "person-1",
  conversationId: null,
  messageId: "email-1@example.com",
  inReplyTo: null,
  from: { email: "customer@example.com", name: "Customer" },
  to: { email: "support@example.com", name: "Support" },
  cc: [],
  subject: "Question",
  bodyText: "Can you help?",
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
  state: {
    seen: false,
    starredAt: null,
    archivedAt: null,
    spamAt: null,
    trashedAt: null,
    mailboxIds: [],
    conversationKey: "p:person-1",
    snoozedUntil: null,
  },
} as any;

describe("MailReadingPane suggested reply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    draftStore.current = {
      id: "draft-1",
      contextKey: "reply:email-1",
      fromAddress: "support@example.com",
      toAddress: "customer@example.com",
      cc: null,
      subject: null,
      bodyHtml: "<p>Existing reply</p>",
      bodyText: "Existing reply",
      replyToEmailId: "email-1",
      updatedAt: 1,
    };
    api.fetchSuggestedReply.mockResolvedValue(suggestion);
    api.fetchDraft.mockImplementation(async () => draftStore.current);
    api.saveDraft.mockImplementation(async (draft: any) => {
      draftStore.current = {
        ...draftStore.current,
        ...draft,
        id: "draft-1",
        updatedAt: 2,
      };
      return draftStore.current;
    });
    api.useSuggestedReply.mockResolvedValue({
      ...suggestion,
      status: "used",
    });
    api.dismissSuggestedReply.mockResolvedValue({
      ...suggestion,
      status: "dismissed",
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("remounts an already-open composer with the suggested text after Use", async () => {
    render(
      <MailReadingPane
        visible
        selectedRef="received:email-1"
        selectedMessage={message}
        actionBusyRef={null}
        replyRequestKey={0}
        mailboxes={[]}
        senderIdentities={[
          {
            email: "support@example.com",
            displayName: "Support",
            signatureHtml: null,
          },
        ]}
        internalDomains={["example.com"]}
        onBack={() => {}}
        onToggleStar={() => {}}
        onToggleArchive={() => {}}
        onToggleSpam={() => {}}
        onToggleTrash={() => {}}
        onSnooze={() => {}}
        onAssign={() => {}}
        onMoveToMailbox={() => {}}
        onRemoveFromCurrentMailbox={() => {}}
        onOpenCustomer={() => {}}
        onRefresh={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^reply$/i }));
    expect(screen.getByTestId("reply-composer").textContent).toContain(
      "Existing reply",
    );

    fireEvent.click(await screen.findByTestId("suggested-reply-use"));

    await waitFor(() =>
      expect(screen.getByTestId("reply-composer").textContent).toContain(
        "Suggested replacement",
      ),
    );
    expect(api.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        contextKey: "reply:email-1",
        bodyText: "Suggested replacement",
      }),
    );
  });
});
