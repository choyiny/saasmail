import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import ReplyComposer from "@/components/ReplyComposer";
import ChatQuickReply from "@/components/ChatQuickReply";
import {
  replyToEmail,
  sendEmail,
  fetchEmail,
  fetchTemplates,
  fetchPersonEmails,
  fetchDraft,
  saveDraft,
  deleteDraft,
  type Email,
} from "@/lib/api";

/**
 * A reply sent from a Gmail-mapped inbox that Gmail refuses comes back as a
 * 502 whose body says the one thing the user has to act on: it was NOT
 * queued, so nothing will retry it and they must send it again. Showing
 * "Failed to send reply" instead tells them the opposite of what is true —
 * they wait for a retry that will never happen.
 */
const GMAIL_502 =
  "Gmail did not accept this reply, and it was not queued for retry: " +
  "Invalid To header. Send it again to retry.";

/** What a failure with nothing useful in the body reduces to. */
const BARE_STATUS = "API error: 500";

vi.mock("@/lib/api", () => ({
  replyToEmail: vi.fn(),
  sendEmail: vi.fn(),
  fetchEmail: vi.fn(),
  fetchTemplates: vi.fn(),
  fetchPersonEmails: vi.fn(),
  fetchDraft: vi.fn(),
  saveDraft: vi.fn(),
  deleteDraft: vi.fn(),
}));

// The real editor pulls in ProseMirror; this suite only cares about what the
// footer says after a send fails.
vi.mock("@/components/TiptapEditor", () => ({
  default: ({ content }: { content: string }) => (
    <div data-testid="editor">{content}</div>
  ),
}));

const mReply = vi.mocked(replyToEmail);
const mSend = vi.mocked(sendEmail);
const mFetchEmail = vi.mocked(fetchEmail);
const mFetchTemplates = vi.mocked(fetchTemplates);
const mFetchPersonEmails = vi.mocked(fetchPersonEmails);
const mFetchDraft = vi.mocked(fetchDraft);
const mSaveDraft = vi.mocked(saveDraft);
const mDeleteDraft = vi.mocked(deleteDraft);

const original: Email = {
  id: "em_1",
  type: "received",
  personId: null,
  recipient: "support@acme.dev",
  fromAddress: "buyer@example.com",
  toAddress: "support@acme.dev",
  subject: "Invoice",
  bodyHtml: "<p>hi</p>",
  bodyText: "hi",
  isRead: 1,
  cc: [],
  timestamp: Date.now(),
};

beforeEach(() => {
  mReply.mockReset();
  mSend.mockReset();
  mFetchEmail.mockReset().mockResolvedValue(original);
  mFetchTemplates.mockReset().mockResolvedValue([]);
  mFetchPersonEmails.mockReset().mockResolvedValue({ emails: [], inboxes: [] });
  mFetchDraft.mockReset().mockResolvedValue(null);
  mSaveDraft.mockReset().mockResolvedValue({} as never);
  mDeleteDraft.mockReset().mockResolvedValue(undefined);
});

function renderComposer() {
  return render(
    <ReplyComposer
      emailId="em_1"
      personName="Buyer"
      personEmail="buyer@example.com"
      recipients={["support@acme.dev"]}
      senderIdentities={[
        { email: "support@acme.dev", displayName: null, signatureHtml: null },
      ]}
      onClose={() => {}}
      onSent={() => {}}
    />,
  );
}

async function sendFromComposer() {
  const button = await screen.findByTestId("reply-send-button");
  fireEvent.click(button);
}

function renderQuickReply() {
  return render(
    <ChatQuickReply
      inboxAddress="support@acme.dev"
      latestReceivedEmailId="em_1"
      personEmail="buyer@example.com"
      onSent={() => {}}
    />,
  );
}

async function typeAndSendQuickReply(text = "on its way") {
  const box = await screen.findByPlaceholderText(/type a reply/i);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
  return box as HTMLTextAreaElement;
}

describe("ReplyComposer — why the reply could not be sent", () => {
  it("shows the server's message when Gmail refuses the reply", async () => {
    mReply.mockRejectedValue(new Error(GMAIL_502));
    renderComposer();
    await sendFromComposer();

    const alert = await screen.findByRole("alert");
    // Word for word: "not queued" and "send it again" are the instructions.
    expect(alert.textContent).toBe(GMAIL_502);
    expect(screen.queryByText("Failed to send reply")).toBeNull();
  });

  it("does not substitute some other failure's wording", async () => {
    mReply.mockRejectedValue(
      new Error("support@acme.dev is not allowed to send as ops@acme.dev."),
    );
    renderComposer();
    await sendFromComposer();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "support@acme.dev is not allowed to send as ops@acme.dev.",
    );
  });

  it("falls back to the generic string when the failure says nothing useful", async () => {
    mReply.mockRejectedValue(new Error(BARE_STATUS));
    renderComposer();
    await sendFromComposer();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Failed to send reply");
    // A raw status code is not an explanation — never show it.
    expect(screen.queryByText(/API error/i)).toBeNull();
  });

  it("falls back to the generic string when the failure is not an Error", async () => {
    mReply.mockRejectedValue("boom");
    renderComposer();
    await sendFromComposer();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Failed to send reply");
  });

  it("keeps the draft when the send fails, so it can be sent again", async () => {
    mReply.mockRejectedValue(new Error(GMAIL_502));
    renderComposer();
    await sendFromComposer();

    await screen.findByRole("alert");
    // clearDraft() runs only on a successful send — a failed one must leave
    // the saved draft alone or "send it again" is impossible.
    expect(mDeleteDraft).not.toHaveBeenCalled();
  });
});

describe("ChatQuickReply — why the message could not be sent", () => {
  it("shows the server's message when Gmail refuses the reply", async () => {
    mReply.mockRejectedValue(new Error(GMAIL_502));
    renderQuickReply();
    await typeAndSendQuickReply();

    await waitFor(() => expect(screen.getByText(GMAIL_502)).toBeTruthy());
    expect(screen.queryByText("Failed to send message")).toBeNull();
  });

  it("shows the server's message when a fresh send is refused", async () => {
    mSend.mockRejectedValue(new Error(GMAIL_502));
    render(
      <ChatQuickReply
        inboxAddress="support@acme.dev"
        latestReceivedEmailId={null}
        personEmail="buyer@example.com"
        onSent={() => {}}
      />,
    );
    const box = await screen.findByPlaceholderText(/type a message/i);
    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => expect(screen.getByText(GMAIL_502)).toBeTruthy());
  });

  it("does not substitute some other failure's wording", async () => {
    mReply.mockRejectedValue(new Error("Attachment too large."));
    renderQuickReply();
    await typeAndSendQuickReply();

    await waitFor(() =>
      expect(screen.getByText("Attachment too large.")).toBeTruthy(),
    );
  });

  it("falls back to the generic string when the failure says nothing useful", async () => {
    mReply.mockRejectedValue(new Error(BARE_STATUS));
    renderQuickReply();
    await typeAndSendQuickReply();

    await waitFor(() =>
      expect(screen.getByText("Failed to send message")).toBeTruthy(),
    );
    expect(screen.queryByText(/API error/i)).toBeNull();
  });

  it("keeps the typed text when the send fails, so it can be sent again", async () => {
    mReply.mockRejectedValue(new Error(GMAIL_502));
    renderQuickReply();
    const box = await typeAndSendQuickReply("please resend this");

    await waitFor(() => expect(screen.getByText(GMAIL_502)).toBeTruthy());
    expect(box.value).toBe("please resend this");
    expect(mDeleteDraft).not.toHaveBeenCalled();
  });
});
