import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  replyToEmail: vi.fn(),
  fetchTemplates: vi.fn(),
  fetchEmail: vi.fn(),
  fetchPersonEmails: vi.fn(),
}));

vi.mock("@/lib/api", () => api);
vi.mock("@/lib/use-draft-autosave", () => ({
  useDraftAutosave: () => ({ clear: () => {} }),
}));
vi.mock("@/components/TiptapEditor", () => ({
  default: ({
    onUpdate,
  }: {
    onUpdate: (html: string, text: string) => void;
  }) => (
    <textarea
      data-testid="editor"
      onChange={(event) =>
        onUpdate(`<p>${event.target.value}</p>`, event.target.value)
      }
    />
  ),
}));

import ReplyComposer from "@/components/ReplyComposer";

const original = {
  id: "email-1",
  type: "received",
  personId: "person-1",
  recipient: "support@example.com",
  fromAddress: "noreply@acme.com",
  toAddress: null,
  subject: "Ticket update",
  bodyHtml: null,
  bodyText: "Your ticket changed",
  isRead: 0,
  cc: [],
  timestamp: 1_800_000_000,
  replyTo: null,
  replyRecipients: [],
};

const SENDER_LABEL = "Notifier <noreply@acme.com>";

function renderComposer() {
  return render(
    <ReplyComposer
      emailId="email-1"
      personName="Notifier"
      personEmail="noreply@acme.com"
      recipients={["support@example.com"]}
      senderIdentities={[
        {
          email: "support@example.com",
          displayName: "Support",
          signatureHtml: null,
        },
      ]}
      onClose={() => {}}
      onSent={() => {}}
    />,
  );
}

async function send() {
  api.replyToEmail.mockClear();
  fireEvent.click(screen.getByTestId("reply-send-button"));
  await waitFor(() => expect(api.replyToEmail).toHaveBeenCalledTimes(1));
  return api.replyToEmail.mock.calls[0][1] as Record<string, unknown>;
}

const toRow = () => screen.getByTestId("reply-to-address").textContent;

describe("ReplyComposer and Reply-To", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchPersonEmails.mockResolvedValue({ emails: [], inboxes: [] });
    api.fetchTemplates.mockResolvedValue([]);
    api.replyToEmail.mockResolvedValue({
      id: "sent-1",
      attachmentIds: [],
      status: "sent",
      to: "help@acme.com",
      cc: [],
      repliedTo: "reply_to",
    });
  });

  it("shows no hint when replies simply go to the sender", async () => {
    api.fetchEmail.mockResolvedValue(original);
    renderComposer();

    // The original has loaded once its "Replying to" card is up.
    await screen.findByText("Replying to");
    expect(screen.queryByTestId("reply-to-hint")).toBeNull();
    expect(toRow()).toBe(SENDER_LABEL);
    expect((await send()).recipient).toBe("sender");
  });

  it("addresses the reply to the Reply-To and lets the user pick the sender", async () => {
    api.fetchEmail.mockResolvedValue({
      ...original,
      replyTo: "help@acme.com",
      replyRecipients: [{ email: "help@acme.com", name: null }],
    });
    renderComposer();

    const hint = await screen.findByTestId("reply-to-hint");
    expect(hint.textContent).toContain(
      "Replies go to help@acme.com (the sender asked for replies there)",
    );
    expect(toRow()).toBe("help@acme.com");
    expect((await send()).recipient).toBe("reply_to");

    fireEvent.click(screen.getByLabelText("Reply to the sender instead"));
    expect(toRow()).toBe(SENDER_LABEL);
    expect((await send()).recipient).toBe("sender");

    // Flipping it back follows the Reply-To again.
    fireEvent.click(screen.getByLabelText("Reply to the sender instead"));
    expect((await send()).recipient).toBe("reply_to");
  });

  it("names an address that is copied next to the sender", async () => {
    // Reply-To lists the sender first and someone else after: the reply still
    // goes To the sender, and the other address gets a copy the user must see.
    api.fetchEmail.mockResolvedValue({
      ...original,
      replyTo: null,
      replyRecipients: [
        { email: "noreply@acme.com", name: null },
        { email: "desk@acme.com", name: null },
      ],
    });
    renderComposer();

    const hint = await screen.findByTestId("reply-to-hint");
    expect(hint.textContent).toContain(
      "Replies go to noreply@acme.com, with desk@acme.com in Cc (the sender asked for replies there)",
    );
    expect((await send()).recipient).toBe("reply_to");

    fireEvent.click(screen.getByLabelText("Reply to the sender instead"));
    expect((await send()).recipient).toBe("sender");
  });

  it("asks for the sender when the original could not be loaded", async () => {
    api.fetchEmail.mockRejectedValue(new Error("boom"));
    renderComposer();

    // The composer tells the user the context is missing, shows the sender in
    // To, and must then send to the sender, not to a Reply-To it never showed.
    await screen.findByText(/Couldn't load the original message/);
    expect(screen.queryByTestId("reply-to-hint")).toBeNull();
    expect(toRow()).toBe(SENDER_LABEL);
    expect((await send()).recipient).toBe("sender");
  });

  it("shows where a reply to one of our sent messages goes", async () => {
    // A sent message on this person's timeline that went to another address
    // (it followed a Reply-To): the follow-up goes there too.
    api.fetchEmail.mockResolvedValue({
      ...original,
      type: "sent",
      recipient: null,
      fromAddress: "support@example.com",
      toAddress: "help@acme.com",
    });
    renderComposer();

    await screen.findByText("Replying to");
    expect(toRow()).toBe("help@acme.com");
    expect(screen.queryByTestId("reply-to-hint")).toBeNull();
  });
});
