import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  messageEmlUrl: (ref: string) => `/api/messages/${ref}/raw.eml`,
  fetchSuggestedReply: vi.fn(),
  fetchDraft: vi.fn(),
  saveDraft: vi.fn(),
  useSuggestedReply: vi.fn(),
  dismissSuggestedReply: vi.fn(),
}));

vi.mock("@/lib/api", () => api);
vi.mock("@/components/ReplyComposer", () => ({
  default: () => <div data-testid="reply-composer" />,
}));

import MailReadingPane from "@/components/mail/MailReadingPane";

const inbound = {
  ref: "received:email-1",
  direction: "inbound",
  inbox: "support@example.com",
  personId: "person-1",
  conversationId: null,
  messageId: "email-1@example.com",
  inReplyTo: null,
  from: { email: "noreply@acme.com", name: "Notifier" },
  to: { email: "support@example.com", name: "Support" },
  cc: [],
  subject: "Ticket update",
  bodyText: "Your ticket changed",
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

function renderPane(message: unknown) {
  const noop = () => {};
  return render(
    <MailReadingPane
      visible
      selectedRef="received:email-1"
      selectedMessage={message as any}
      actionBusyRef={null}
      replyRequestKey={0}
      mailboxes={[]}
      senderIdentities={[]}
      internalDomains={[]}
      onBack={noop}
      onToggleStar={noop}
      onToggleArchive={noop}
      onToggleSpam={noop}
      onToggleTrash={noop}
      onSnooze={noop}
      onAssign={noop}
      onMoveToMailbox={noop}
      onRemoveFromCurrentMailbox={noop}
      onOpenCustomer={noop}
      onRefresh={noop}
    />,
  );
}

describe("MailReadingPane Reply-To line", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchSuggestedReply.mockResolvedValue(null);
  });

  it("shows where replies go when the sender asked for another address", () => {
    renderPane({
      ...inbound,
      replyTo: [
        { email: "help@acme.com", name: "Help Desk" },
        { email: "b@acme.com", name: null },
      ],
    });
    expect(screen.getByTestId("mail-reading-reply-to").textContent).toBe(
      "Reply-To: Help Desk <help@acme.com>, b@acme.com",
    );
  });

  it("stays out of the way when replies go to the sender", () => {
    // The server sends an empty list when a reply simply goes to the sender.
    renderPane({ ...inbound, replyTo: [] });
    expect(screen.queryByTestId("mail-reading-reply-to")).toBeNull();
  });

  it("lists an address copied next to the sender", () => {
    renderPane({
      ...inbound,
      replyTo: [
        { email: "noreply@acme.com", name: null },
        { email: "desk@acme.com", name: null },
      ],
    });
    expect(screen.getByTestId("mail-reading-reply-to").textContent).toBe(
      "Reply-To: noreply@acme.com, desk@acme.com",
    );
  });

  it("does not show one on a message without the field", () => {
    renderPane(inbound);
    expect(screen.queryByTestId("mail-reading-reply-to")).toBeNull();
  });
});
