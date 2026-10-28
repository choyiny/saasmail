import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { InlineComposer, type InlineMode } from "@/themes/gmail/InlineComposer";
import OutlookInlineReply, {
  takePendingReopen,
  type ReplyInitial,
} from "@/themes/outlook/InlineReply";
import OutlookComposeForm from "@/themes/outlook/ComposeForm";
import type { ComposePrefill } from "@/pages/ComposeModal";
import {
  replyToEmail,
  sendEmail,
  fetchDraft,
  fetchStats,
  saveDraft,
  deleteDraft,
  type Email,
} from "@/lib/api";
import { showToast } from "@/lib/toast";

/**
 * The Gmail and Outlook layouts' composers send with the same idempotency
 * key on every attempt of one message (see docs/sending.md), so a retry
 * after a failed request cannot send it twice; a Gmail forward keys each
 * recipient, so its retry skips the recipients already reached. Their
 * replies go to the sender, the address the layout shows.
 */
vi.mock("@/lib/api", () => ({
  replyToEmail: vi.fn(),
  sendEmail: vi.fn(),
  fetchDraft: vi.fn(),
  fetchStats: vi.fn(),
  saveDraft: vi.fn(),
  deleteDraft: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ showToast: vi.fn() }));
vi.mock("@/themes/outlook/sendUndo", () => ({
  useUndoSendSetting: () => [{ undoSendSeconds: 0.05 }, () => {}],
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
const mSend = vi.mocked(sendEmail);

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
  vi.mocked(showToast).mockReset();
  // jsdom has no layout; the Outlook reply card scrolls itself into view.
  Element.prototype.scrollIntoView = vi.fn();
  sessionStorage.clear();
  mReply.mockReset().mockResolvedValue({} as never);
  mSend.mockReset().mockResolvedValue({} as never);
  vi.mocked(fetchDraft).mockReset().mockResolvedValue(null);
  vi.mocked(fetchStats)
    .mockReset()
    .mockResolvedValue({
      recipients: ["support@acme.dev"],
      senderIdentities: [],
    } as never);
  vi.mocked(saveDraft)
    .mockReset()
    .mockResolvedValue({} as never);
  vi.mocked(deleteDraft).mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

function keyOf(call: unknown[] | undefined): string | undefined {
  const payload = (call ?? []).find(
    (a) => typeof a === "object" && a !== null && "idempotencyKey" in a,
  ) as { idempotencyKey?: string } | undefined;
  return payload?.idempotencyKey;
}

/** Long enough for a 50 ms undo window to end and its send to settle. */
const afterWindow = () => act(() => new Promise((r) => setTimeout(r, 150)));

async function typeBody(text: string) {
  fireEvent.change(await screen.findByTestId("editor"), {
    target: { value: text },
  });
}

// ── Gmail layout ────────────────────────────────────────────────────────

function GmailHost({ mode }: { mode: InlineMode }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <InlineComposer
      mode={mode}
      target={original}
      party={{ name: "Buyer", email: "buyer@example.com" }}
      inboxes={["support@acme.dev"]}
      identities={[{ email: "support@acme.dev", displayName: null }]}
      internalDomains={["acme.dev"]}
      subject="Invoice"
      forwardHtml="<p>forwarded</p>"
      onModeChange={() => {}}
      onClose={() => setOpen(false)}
      onSent={() => {}}
      onPopOut={() => {}}
      onReopen={() => setOpen(true)}
      undoSeconds={0.05}
    />
  );
}

describe("Gmail layout: the send key", () => {
  it("a reply goes to the sender, and its retry after a failure reuses the key", async () => {
    mReply.mockRejectedValueOnce(new Error("network down"));
    render(<GmailHost mode="reply" />);
    await typeBody("first try");
    fireEvent.click(screen.getByTestId("gmail-inline-send"));
    await afterWindow();
    expect(mReply).toHaveBeenCalledTimes(1);

    await typeBody("first try");
    fireEvent.click(await screen.findByTestId("gmail-inline-send"));
    await afterWindow();
    expect(mReply).toHaveBeenCalledTimes(2);
    const key = keyOf(mReply.mock.calls[0]);
    expect(key).toBeTruthy();
    expect(keyOf(mReply.mock.calls[1])).toBe(key);
    expect(mReply.mock.calls[0]![1]).toMatchObject({ recipient: "sender" });
    expect(mReply.mock.calls[1]![1]).toMatchObject({ recipient: "sender" });
    // Sent: the next reply is a new message.
    expect(
      sessionStorage.getItem("saasmail:send-key:send:reply:em_1"),
    ).toBeNull();
  });

  it("a reply refused for a reused key warns to check Sent and forgets the key", async () => {
    mReply.mockRejectedValueOnce(
      Object.assign(new Error("reused"), { code: "IDEMPOTENCY_KEY_REUSED" }),
    );
    render(<GmailHost mode="reply" />);
    await typeBody("first try");
    fireEvent.click(screen.getByTestId("gmail-inline-send"));
    await afterWindow();
    expect(mReply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "error",
        description: expect.stringMatching(/Check Sent/),
      }),
    );
    // The next Send is a new message.
    expect(
      sessionStorage.getItem("saasmail:send-key:send:reply:em_1"),
    ).toBeNull();
  });

  it("a forward's retry reuses each recipient's key and skips the one already reached", async () => {
    mSend
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error("network down"));
    render(<GmailHost mode="forward" />);
    fireEvent.change(await screen.findByLabelText("To"), {
      target: { value: "a@example.com, b@example.com" },
    });
    fireEvent.click(screen.getByTestId("gmail-inline-send"));
    await afterWindow();
    expect(mSend).toHaveBeenCalledTimes(2);

    fireEvent.change(await screen.findByLabelText("To"), {
      target: { value: "a@example.com, b@example.com" },
    });
    fireEvent.click(screen.getByTestId("gmail-inline-send"));
    await afterWindow();
    expect(mSend.mock.calls.map((c) => c[0].to)).toEqual([
      "a@example.com",
      "b@example.com",
      "b@example.com",
    ]);
    const [a, b, retry] = mSend.mock.calls.map((c) => keyOf(c));
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    expect(retry).toBe(b);
  });
});

// ── Outlook layout ──────────────────────────────────────────────────────

describe("Outlook layout: the send key", () => {
  it("a reply goes to the sender, and its retry after a failure reuses the key", async () => {
    mReply.mockRejectedValueOnce(new Error("network down"));
    function Host() {
      const [state, setState] = useState<{
        open: boolean;
        initial?: ReplyInitial;
      }>({ open: true });
      return (
        <>
          <button
            type="button"
            onClick={() =>
              setState({
                open: true,
                initial: takePendingReopen("item_1")?.initial,
              })
            }
          >
            reopen
          </button>
          {state.open && (
            <OutlookInlineReply
              email={original}
              mode="reply"
              itemKey="item_1"
              counterpart="buyer@example.com"
              initial={state.initial}
              onClose={() => setState({ open: false })}
              onSent={() => {}}
            />
          )}
        </>
      );
    }
    render(<Host />);
    await typeBody("first try");
    fireEvent.click(screen.getByTestId("ol-reply-send"));
    await afterWindow();
    expect(mReply).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "reopen" }));
    fireEvent.click(await screen.findByTestId("ol-reply-send"));
    await afterWindow();
    expect(mReply).toHaveBeenCalledTimes(2);
    const key = keyOf(mReply.mock.calls[0]);
    expect(key).toBeTruthy();
    expect(keyOf(mReply.mock.calls[1])).toBe(key);
    expect(mReply.mock.calls[0]![1]).toMatchObject({ recipient: "sender" });
    expect(mReply.mock.calls[1]![1]).toMatchObject({ recipient: "sender" });
  });

  it("a new message's retry after a failure reuses the key", async () => {
    mSend.mockRejectedValueOnce(new Error("network down"));
    function Host() {
      const [state, setState] = useState<{
        open: boolean;
        prefill: ComposePrefill | null;
      }>({
        open: true,
        prefill: {
          to: "buyer@example.com",
          subject: "Hello",
          bodyHtml: "<p>hi</p>",
        },
      });
      if (!state.open) return null;
      return (
        <OutlookComposeForm
          variant="pane"
          prefill={state.prefill}
          onClose={() => setState((s) => ({ ...s, open: false }))}
          onReopen={(prefill) => setState({ open: true, prefill })}
        />
      );
    }
    render(<Host />);
    // The From address comes from the account's inboxes once they load.
    await act(() => new Promise((r) => setTimeout(r, 20)));
    fireEvent.click(await screen.findByTestId("ol-compose-send"));
    await afterWindow();
    expect(mSend).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByTestId("ol-compose-send"));
    await afterWindow();
    expect(mSend).toHaveBeenCalledTimes(2);
    const key = keyOf(mSend.mock.calls[0]);
    expect(key).toBeTruthy();
    expect(keyOf(mSend.mock.calls[1])).toBe(key);
    expect(sessionStorage.getItem("saasmail:send-key:send:compose")).toBeNull();
  });
});
