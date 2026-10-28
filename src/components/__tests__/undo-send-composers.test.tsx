import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import ReplyComposer from "@/components/ReplyComposer";
import ChatQuickReply from "@/components/ChatQuickReply";
import {
  replyToEmail,
  fetchEmail,
  fetchTemplates,
  fetchPersonEmails,
  fetchDraft,
  saveDraft,
  deleteDraft,
  type Email,
} from "@/lib/api";
import { showToast, type ToastInit } from "@/lib/toast";

/**
 * Undo Send in the shared composers: Send hides the composer at once and
 * holds the message; Undo brings the composer back with what was written,
 * and nothing is sent.
 */
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
vi.mock("@/lib/toast", () => ({ showToast: vi.fn() }));
vi.mock("@/lib/default-layout-settings", () => ({
  useCommonSettings: () => [
    { undoSendSeconds: 30, hideSignatures: false },
    () => {},
  ],
}));
vi.mock("@/components/TiptapEditor", () => ({
  default: ({
    content,
    onUpdate,
  }: {
    content: string;
    onUpdate: (html: string, text: string) => void;
  }) => (
    <textarea
      data-testid="editor"
      value={content}
      onChange={(e) => onUpdate(`<p>${e.target.value}</p>`, e.target.value)}
    />
  ),
}));

const mReply = vi.mocked(replyToEmail);
const mToast = vi.mocked(showToast);

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
  mReply.mockReset().mockResolvedValue({} as never);
  mToast.mockReset();
  vi.mocked(fetchEmail).mockReset().mockResolvedValue(original);
  vi.mocked(fetchTemplates).mockReset().mockResolvedValue([]);
  vi.mocked(fetchPersonEmails)
    .mockReset()
    .mockResolvedValue({ emails: [], inboxes: [] });
  vi.mocked(fetchDraft).mockReset().mockResolvedValue(null);
  vi.mocked(saveDraft)
    .mockReset()
    .mockResolvedValue({} as never);
  vi.mocked(deleteDraft).mockReset().mockResolvedValue(undefined);
});

function pressUndo() {
  const t = mToast.mock.calls
    .map((c) => c[0] as ToastInit)
    .find((x) => x.action?.label === "Undo");
  expect(t).toBeTruthy();
  act(() => t!.action!.onClick(() => {}));
}

describe("ReplyComposer with Undo Send", () => {
  it("hides on Send, and Undo brings it back with the reply", async () => {
    const onClose = vi.fn();
    render(
      <ReplyComposer
        emailId="em_1"
        personName="Buyer"
        personEmail="buyer@example.com"
        recipients={["support@acme.dev"]}
        senderIdentities={[
          { email: "support@acme.dev", displayName: null, signatureHtml: null },
        ]}
        onClose={onClose}
        onSent={() => {}}
      />,
    );
    fireEvent.change(await screen.findByTestId("editor"), {
      target: { value: "Thanks, on its way" },
    });
    fireEvent.click(screen.getByTestId("reply-send-button"));

    expect(screen.queryByTestId("reply-composer")).toBeNull();
    expect(mReply).not.toHaveBeenCalled();

    pressUndo();
    const editor = (await screen.findByTestId("editor")) as HTMLTextAreaElement;
    expect(editor.value).toBe("<p>Thanks, on its way</p>");
    expect(mReply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("ChatQuickReply with Undo Send", () => {
  it("clears the box on Send, and Undo puts the text back", async () => {
    render(
      <ChatQuickReply
        inboxAddress="support@acme.dev"
        latestReceivedEmailId="em_1"
        personEmail="buyer@example.com"
        onSent={() => {}}
      />,
    );
    const box = (await screen.findByPlaceholderText(
      /type a reply/i,
    )) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "see you then" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(box.value).toBe("");

    pressUndo();
    expect(box.value).toBe("see you then");
    expect(mReply).not.toHaveBeenCalled();
    // The saved draft is kept: only a real send removes it.
    expect(vi.mocked(deleteDraft)).not.toHaveBeenCalled();
  });
});
