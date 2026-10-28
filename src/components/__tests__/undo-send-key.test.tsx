import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import ReplyComposer from "@/components/ReplyComposer";
import ChatQuickReply from "@/components/ChatQuickReply";
import ComposeModal, { type ComposePrefill } from "@/pages/ComposeModal";
import {
  replyToEmail,
  sendEmail,
  fetchEmail,
  fetchTemplates,
  fetchPersonEmails,
  fetchDraft,
  fetchStats,
  saveDraft,
  deleteDraft,
  publishDraft,
  type Email,
} from "@/lib/api";
import { showToast, type ToastInit } from "@/lib/toast";

/**
 * Undo Send and the send's idempotency key are one flow in each composer
 * (see docs/sending.md): Undo goes before any request and forgets the key;
 * closing the composer during the undo window still sends the message once,
 * with its key; a retry after a failed send reuses the same key.
 */
const settings = vi.hoisted(() => ({ seconds: 30 }));

vi.mock("@/lib/api", () => ({
  replyToEmail: vi.fn(),
  sendEmail: vi.fn(),
  fetchEmail: vi.fn(),
  fetchTemplates: vi.fn(),
  fetchPersonEmails: vi.fn(),
  fetchDraft: vi.fn(),
  fetchStats: vi.fn(),
  saveDraft: vi.fn(),
  deleteDraft: vi.fn(),
  publishDraft: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ showToast: vi.fn() }));
vi.mock("@/lib/default-layout-settings", () => ({
  useCommonSettings: () => [
    { undoSendSeconds: settings.seconds, hideSignatures: false },
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
const mSend = vi.mocked(sendEmail);
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

const REPLY_KEY = "saasmail:send-key:send:reply:em_1";
const COMPOSE_KEY = "saasmail:send-key:send:compose";

beforeEach(() => {
  sessionStorage.clear();
  settings.seconds = 30;
  mReply.mockReset().mockResolvedValue({} as never);
  mSend.mockReset().mockResolvedValue({} as never);
  mToast.mockReset();
  vi.mocked(fetchEmail).mockReset().mockResolvedValue(original);
  vi.mocked(fetchTemplates).mockReset().mockResolvedValue([]);
  vi.mocked(fetchPersonEmails)
    .mockReset()
    .mockResolvedValue({ emails: [], inboxes: [] });
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
  vi.mocked(publishDraft)
    .mockReset()
    .mockResolvedValue({} as never);
});

afterEach(cleanup);

function pressUndo() {
  const t = mToast.mock.calls
    .map((c) => c[0] as ToastInit)
    .find((x) => x.action?.label === "Undo");
  expect(t).toBeTruthy();
  act(() => t!.action!.onClick(() => {}));
}

function keyOf(call: unknown[] | undefined): string | undefined {
  const payload = (call ?? []).find(
    (a) => typeof a === "object" && a !== null && "idempotencyKey" in a,
  ) as { idempotencyKey?: string } | undefined;
  return payload?.idempotencyKey;
}

/** Long enough for a 50 ms undo window to end and its send to settle. */
const afterWindow = () => act(() => new Promise((r) => setTimeout(r, 150)));

// ── ReplyComposer ───────────────────────────────────────────────────────

function renderReply() {
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

async function typeReply(text: string) {
  fireEvent.change(await screen.findByTestId("editor"), {
    target: { value: text },
  });
}

describe("ReplyComposer: Undo Send and the send key", () => {
  it("Undo comes before any request and forgets the key", async () => {
    renderReply();
    await typeReply("Thanks");
    fireEvent.click(screen.getByTestId("reply-send-button"));
    expect(sessionStorage.getItem(REPLY_KEY)).toBeTruthy();

    pressUndo();
    expect(mReply).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(REPLY_KEY)).toBeNull();
  });

  it("closing during the undo window still sends once, with the key", async () => {
    settings.seconds = 0.05;
    const view = renderReply();
    await typeReply("Thanks");
    fireEvent.click(screen.getByTestId("reply-send-button"));
    const key = sessionStorage.getItem(REPLY_KEY);
    expect(key).toBeTruthy();

    view.unmount();
    // The held send still owns its key.
    expect(sessionStorage.getItem(REPLY_KEY)).toBe(key);

    await afterWindow();
    expect(mReply).toHaveBeenCalledTimes(1);
    expect(keyOf(mReply.mock.calls[0])).toBe(key);
    expect(sessionStorage.getItem(REPLY_KEY)).toBeNull();
  });

  it("a retry after a failed send reuses the same key", async () => {
    settings.seconds = 0;
    mReply.mockRejectedValueOnce(new Error("network down"));
    renderReply();
    await typeReply("Thanks");
    fireEvent.click(screen.getByTestId("reply-send-button"));
    await waitFor(() => expect(mReply).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByTestId("reply-send-button"));
    await waitFor(() => expect(mReply).toHaveBeenCalledTimes(2));
    expect(keyOf(mReply.mock.calls[1])).toBe(keyOf(mReply.mock.calls[0]));
    expect(keyOf(mReply.mock.calls[0])).toBeTruthy();
  });
});

// ── ComposeModal ────────────────────────────────────────────────────────

const PREFILL: ComposePrefill = {
  from: "support@acme.dev",
  to: "buyer@example.com",
  subject: "Hello",
  bodyHtml: "<p>Hello there</p>",
  bodyText: "Hello there",
};

/** A compose window whose owner reopens it on Undo or a failed send. */
function ComposeHarness() {
  const [state, setState] = useState<{
    open: boolean;
    prefill: ComposePrefill | null;
  }>({ open: true, prefill: PREFILL });
  return (
    <ComposeModal
      open={state.open}
      prefill={state.prefill}
      onClose={() => setState((s) => ({ ...s, open: false }))}
      onReopen={(prefill) => setState({ open: true, prefill })}
    />
  );
}

async function pressComposeSend() {
  const button = await screen.findByTestId("compose-send-button");
  await waitFor(() =>
    expect((button as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(button);
}

describe("ComposeModal: Undo Send and the send key", () => {
  it("Undo comes before any request and forgets the key", async () => {
    render(<ComposeHarness />);
    await pressComposeSend();
    expect(screen.queryByTestId("compose-send-button")).toBeNull();
    expect(sessionStorage.getItem(COMPOSE_KEY)).toBeTruthy();

    pressUndo();
    expect(mSend).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(COMPOSE_KEY)).toBeNull();
    // The window comes back with the message.
    expect(await screen.findByTestId("compose-send-button")).toBeTruthy();
  });

  it("closing during the undo window still sends once, with the key", async () => {
    settings.seconds = 0.05;
    const view = render(<ComposeHarness />);
    await pressComposeSend();
    const key = sessionStorage.getItem(COMPOSE_KEY);
    expect(key).toBeTruthy();

    // Send closed the window; now its owner goes away too.
    view.unmount();
    expect(sessionStorage.getItem(COMPOSE_KEY)).toBe(key);

    await afterWindow();
    expect(mSend).toHaveBeenCalledTimes(1);
    expect(keyOf(mSend.mock.calls[0])).toBe(key);
    expect(sessionStorage.getItem(COMPOSE_KEY)).toBeNull();
  });

  it("a retry after a failed send reuses the same key", async () => {
    settings.seconds = 0;
    mSend.mockRejectedValueOnce(new Error("network down"));
    render(<ComposeHarness />);
    await pressComposeSend();
    await waitFor(() => expect(mSend).toHaveBeenCalledTimes(1));

    // The window reopens with the message and the error.
    await pressComposeSend();
    await waitFor(() => expect(mSend).toHaveBeenCalledTimes(2));
    expect(keyOf(mSend.mock.calls[1])).toBe(keyOf(mSend.mock.calls[0]));
    expect(keyOf(mSend.mock.calls[0])).toBeTruthy();
  });

  it("a message from a named draft slot fails after the undo window and its retry reuses that slot's key", async () => {
    // The dashboard resets the window to the "compose" slot when it closes
    // (Send closes it at once), and reopens it on the slot it was sent from.
    settings.seconds = 0.05;
    mSend.mockRejectedValueOnce(new Error("network down"));
    function DashboardHost() {
      const [state, setState] = useState<{
        open: boolean;
        prefill: ComposePrefill | null;
        contextKey: string;
      }>({ open: true, prefill: PREFILL, contextKey: "draft:x1" });
      return (
        <ComposeModal
          open={state.open}
          prefill={state.prefill}
          contextKey={state.contextKey}
          onClose={() =>
            setState({ open: false, prefill: null, contextKey: "compose" })
          }
          onReopen={(prefill, contextKey = "compose") =>
            setState({ open: true, prefill, contextKey })
          }
        />
      );
    }
    render(<DashboardHost />);
    const SLOT_KEY = "saasmail:send-key:send:draft:x1";

    await pressComposeSend();
    const key = sessionStorage.getItem(SLOT_KEY);
    expect(key).toBeTruthy();
    await afterWindow();
    expect(mSend).toHaveBeenCalledTimes(1);
    // Back on its own slot, still owning its key.
    expect(sessionStorage.getItem(SLOT_KEY)).toBe(key);
    expect(sessionStorage.getItem(COMPOSE_KEY)).toBeNull();

    await pressComposeSend();
    await afterWindow();
    expect(mSend).toHaveBeenCalledTimes(2);
    expect(keyOf(mSend.mock.calls[0])).toBe(key);
    expect(keyOf(mSend.mock.calls[1])).toBe(key);
    expect(sessionStorage.getItem(SLOT_KEY)).toBeNull();
    // The sent message's own draft slot is the one removed.
    expect(vi.mocked(deleteDraft)).toHaveBeenCalledWith("draft:x1");
  });
});

describe("a /mail draft sent while a new message is open", () => {
  it("still deletes the sent message's own draft slot", async () => {
    settings.seconds = 0.05;
    let api: { open: (k: string) => void } | null = null;
    function Host() {
      const [state, setState] = useState<{
        open: boolean;
        prefill: ComposePrefill | null;
        contextKey: string;
      }>({ open: true, prefill: PREFILL, contextKey: "draft:A" });
      api = {
        open: (k) => setState({ open: true, prefill: null, contextKey: k }),
      };
      return (
        <ComposeModal
          open={state.open}
          prefill={state.prefill}
          contextKey={state.contextKey}
          onClose={() =>
            setState({ open: false, prefill: null, contextKey: "compose" })
          }
          onReopen={(prefill, contextKey = "compose") =>
            setState({ open: true, prefill, contextKey })
          }
        />
      );
    }
    render(<Host />);
    await pressComposeSend();
    act(() => api!.open("draft:B"));
    await afterWindow();
    expect(mSend).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deleteDraft)).toHaveBeenCalledWith("draft:A");
  });
});

// ── ChatQuickReply ──────────────────────────────────────────────────────

function renderQuick() {
  return render(
    <ChatQuickReply
      inboxAddress="support@acme.dev"
      latestReceivedEmailId="em_1"
      personEmail="buyer@example.com"
      onSent={() => {}}
    />,
  );
}

async function sendQuick(text: string) {
  const box = (await screen.findByPlaceholderText(
    /type a reply/i,
  )) as HTMLTextAreaElement;
  if (text) fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
  return box;
}

describe("ChatQuickReply: Undo Send and the send key", () => {
  it("Undo comes before any request and forgets the key", async () => {
    renderQuick();
    await sendQuick("see you then");
    expect(sessionStorage.getItem(REPLY_KEY)).toBeTruthy();

    pressUndo();
    expect(mReply).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(REPLY_KEY)).toBeNull();
  });

  it("closing during the undo window still sends once, with the key", async () => {
    settings.seconds = 0.05;
    const view = renderQuick();
    await sendQuick("see you then");
    const key = sessionStorage.getItem(REPLY_KEY);
    expect(key).toBeTruthy();

    view.unmount();
    expect(sessionStorage.getItem(REPLY_KEY)).toBe(key);

    await afterWindow();
    expect(mReply).toHaveBeenCalledTimes(1);
    expect(keyOf(mReply.mock.calls[0])).toBe(key);
    expect(sessionStorage.getItem(REPLY_KEY)).toBeNull();
  });

  it("a retry after a failed send reuses the same key", async () => {
    settings.seconds = 0;
    mReply.mockRejectedValueOnce(new Error("network down"));
    renderQuick();
    const box = await sendQuick("see you then");
    await waitFor(() => expect(mReply).toHaveBeenCalledTimes(1));
    // The failed message is back in the box.
    await waitFor(() => expect(box.value).toBe("see you then"));

    await sendQuick("");
    await waitFor(() => expect(mReply).toHaveBeenCalledTimes(2));
    expect(keyOf(mReply.mock.calls[1])).toBe(keyOf(mReply.mock.calls[0]));
    expect(keyOf(mReply.mock.calls[0])).toBeTruthy();
  });

  it("a second message sent during the first's undo window gets its own key; the first fails and its retry keeps the first key", async () => {
    settings.seconds = 0.05;
    mReply.mockRejectedValueOnce(new Error("network down"));
    renderQuick();
    const box = await sendQuick("first");
    const first = sessionStorage.getItem(REPLY_KEY);
    await sendQuick("second");
    const second = sessionStorage.getItem(REPLY_KEY);
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    await afterWindow();
    // Each went out once, with its own key: the first failed, the second
    // was sent.
    expect(mReply).toHaveBeenCalledTimes(2);
    const byText = new Map(
      mReply.mock.calls.map((c) => [
        (c[1] as { bodyText?: string }).bodyText,
        keyOf(c),
      ]),
    );
    expect(byText.get("first")).toBe(first);
    expect(byText.get("second")).toBe(second);
    // The failed message is back in the box and still owns its key.
    await waitFor(() => expect(box.value).toBe("first"));
    expect(sessionStorage.getItem(REPLY_KEY)).toBe(first);

    await sendQuick("");
    await afterWindow();
    expect(mReply).toHaveBeenCalledTimes(3);
    expect(keyOf(mReply.mock.calls[2])).toBe(first);
    expect(sessionStorage.getItem(REPLY_KEY)).toBeNull();
  });

  it("two overlapping sends that both fail come back together with a warning to check Sent, and their retry gets a new key", async () => {
    settings.seconds = 0.05;
    mReply
      .mockRejectedValueOnce(new Error("network down"))
      .mockRejectedValueOnce(new Error("network down"));
    renderQuick();
    const box = await sendQuick("first");
    await sendQuick("second");

    await afterWindow();
    expect(mReply).toHaveBeenCalledTimes(2);
    const [first, second] = mReply.mock.calls.map((c) => keyOf(c));
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
    // Both are back in the box; no one key covers the two of them.
    await waitFor(() => expect(box.value).toContain("first"));
    expect(box.value).toContain("second");
    expect(sessionStorage.getItem(REPLY_KEY)).toBeNull();
    expect(await screen.findByText(/Check Sent/)).toBeTruthy();

    await sendQuick("");
    await afterWindow();
    expect(mReply).toHaveBeenCalledTimes(3);
    const retry = keyOf(mReply.mock.calls[2]);
    expect(retry).toBeTruthy();
    expect(retry).not.toBe(first);
    expect(retry).not.toBe(second);
  });
});
