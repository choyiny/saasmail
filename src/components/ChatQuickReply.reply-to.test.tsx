import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  replyToEmail: vi.fn(),
  sendEmail: vi.fn(),
  fetchDraft: vi.fn(),
  deleteDraft: vi.fn(),
}));

vi.mock("@/lib/api", () => api);

import ChatQuickReply from "@/components/ChatQuickReply";

function renderReply(replyRecipients?: { email: string }[]) {
  return render(
    <ChatQuickReply
      inboxAddress="support@example.com"
      latestReceivedEmailId="email-1"
      personEmail="noreply@acme.com"
      replyRecipients={replyRecipients}
      onSent={() => {}}
    />,
  );
}

async function send(text: string) {
  fireEvent.change(screen.getByPlaceholderText("Type a reply…"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(api.replyToEmail).toHaveBeenCalled());
  return api.replyToEmail.mock.calls.at(-1)![1] as Record<string, unknown>;
}

describe("ChatQuickReply and Reply-To", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchDraft.mockResolvedValue(null);
    api.deleteDraft.mockResolvedValue(undefined);
    api.replyToEmail.mockResolvedValue({
      id: "sent-1",
      attachmentIds: [],
      status: "sent",
      to: "help@acme.com",
      cc: [],
      repliedTo: "reply_to",
    });
  });

  it("with no hint on screen, asks for the sender", async () => {
    renderReply();
    expect(screen.queryByTestId("reply-to-hint")).toBeNull();

    // Never left to the server's default, which follows a Reply-To.
    const payload = await send("hello");
    expect(payload.recipient).toBe("sender");
  });

  it("says where the reply goes and follows the Reply-To by default", async () => {
    renderReply([{ email: "help@acme.com" }]);
    expect(screen.getByTestId("reply-to-hint").textContent).toContain(
      "Replies go to help@acme.com (the sender asked for replies there)",
    );

    const payload = await send("hello");
    expect(payload.recipient).toBe("reply_to");
  });

  it("names every address that will get a copy", () => {
    renderReply([
      { email: "noreply@acme.com" },
      { email: "desk@acme.com" },
      { email: "b@acme.com" },
    ]);
    expect(screen.getByTestId("reply-to-hint").textContent).toContain(
      "Replies go to noreply@acme.com, with desk@acme.com, b@acme.com in Cc (the sender asked for replies there)",
    );
  });

  it("tells the user when an earlier attempt already went out", async () => {
    sessionStorage.clear();
    api.replyToEmail.mockRejectedValueOnce(
      Object.assign(new Error("used"), { code: "IDEMPOTENCY_KEY_REUSED" }),
    );
    renderReply();
    fireEvent.change(screen.getByPlaceholderText("Type a reply…"), {
      target: { value: "hello again" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(
      await screen.findByText(
        "This message was not sent: an earlier attempt from this window may already have gone out. Check Sent, then send again to send this one.",
      ),
    ).toBeTruthy();

    // Sending again uses a new key, so the message as it is now goes out.
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.replyToEmail).toHaveBeenCalledTimes(2));
    const [before, after] = api.replyToEmail.mock.calls.map(
      (call) => call[1].idempotencyKey,
    );
    expect(after).not.toBe(before);
  });

  it("retries with the same key, and shares it with the full reply composer", async () => {
    sessionStorage.clear();
    api.replyToEmail.mockRejectedValueOnce(new Error("network timeout"));
    renderReply();
    fireEvent.change(screen.getByPlaceholderText("Type a reply…"), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Failed to send message");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.replyToEmail).toHaveBeenCalledTimes(2));
    const [attempt, retry] = api.replyToEmail.mock.calls.map(
      (call) => call[1].idempotencyKey,
    );
    expect(retry).toBe(attempt);
    // After the send it is forgotten; it was the reply composer's key too.
    expect(
      sessionStorage.getItem("saasmail:send-key:send:reply:email-1"),
    ).toBeNull();
  });

  it('sends recipient: "sender" once the toggle is on', async () => {
    renderReply([{ email: "help@acme.com" }]);
    fireEvent.click(screen.getByLabelText("Reply to the sender instead"));
    expect(screen.getByTestId("reply-to-hint").textContent).toContain(
      "This reply is addressed to the sender",
    );

    const payload = await send("hello");
    expect(payload.recipient).toBe("sender");
  });
});
