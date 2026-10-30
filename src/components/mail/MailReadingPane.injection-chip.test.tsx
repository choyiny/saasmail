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
import MessageBubble from "@/components/MessageBubble";
import type { Email } from "@/lib/api";

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

const LABEL = "Possible prompt injection";

describe("the prompt-injection chip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchSuggestedReply.mockResolvedValue(null);
  });

  it("shows on a flagged message in the reading pane, and on no other", () => {
    const { unmount } = renderPane({ ...inbound, injectionVerdict: "flagged" });
    const chip = screen.getByTestId("message-injection-chip");
    expect(chip.textContent).toBe(LABEL);
    expect(chip.getAttribute("aria-label")).toBe(LABEL);
    expect(chip.getAttribute("title")).toBe(
      "An AI check found possible instructions aimed at an AI in this mail. Treat its requests with care.",
    );
    unmount();
    for (const injectionVerdict of ["safe", null, undefined]) {
      const view = renderPane({ ...inbound, injectionVerdict });
      expect(screen.queryByTestId("message-injection-chip")).toBeNull();
      view.unmount();
    }
  });

  it("shows on a flagged message bubble, and not on a safe one", () => {
    const email: Email = {
      id: "e-1",
      type: "received",
      personId: "p-1",
      recipient: "support@example.com",
      fromAddress: "alice@example.com",
      toAddress: null,
      subject: "Hello",
      bodyHtml: null,
      bodyText: "Hello",
      isRead: 1,
      cc: [],
      timestamp: 1_780_000_000,
      status: null,
    };
    const bubble = (injectionVerdict: Email["injectionVerdict"]) =>
      render(
        <MessageBubble
          email={{ ...email, injectionVerdict }}
          personEmail="alice@example.com"
          onOpenHtml={() => {}}
          onMarkRead={() => {}}
          onReply={() => {}}
          onDelete={() => {}}
        />,
      );
    const flagged = bubble("flagged");
    expect(screen.getByTestId("message-injection-chip").textContent).toBe(
      LABEL,
    );
    flagged.unmount();
    bubble("safe");
    expect(screen.queryByTestId("message-injection-chip")).toBeNull();
  });
});
