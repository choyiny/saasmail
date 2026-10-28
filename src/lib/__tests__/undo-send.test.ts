import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendWithUndo } from "@/lib/undo-send";
import { showToast, type ToastInit } from "@/lib/toast";

vi.mock("@/lib/toast", () => ({ showToast: vi.fn() }));
const mToast = vi.mocked(showToast);

/** The toast that carries the Undo button. */
function undoToast(): ToastInit {
  const t = mToast.mock.calls
    .map((c) => c[0])
    .find((x) => x.action?.label === "Undo");
  if (!t) throw new Error("no Undo toast");
  return t;
}

beforeEach(() => {
  vi.useFakeTimers();
  mToast.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("sendWithUndo", () => {
  it("holds the send for the delay, then sends", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const onSent = vi.fn();
    sendWithUndo({ seconds: 5, send, onUndo: vi.fn(), onSent });

    expect(send).not.toHaveBeenCalled();
    expect(undoToast().durationMs).toBe(5000);
    await vi.advanceTimersByTimeAsync(4999);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(mToast).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "success", message: "Message sent" }),
    );
  });

  it("Undo cancels the send and calls onUndo", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const onUndo = vi.fn();
    const onSent = vi.fn();
    sendWithUndo({ seconds: 10, send, onUndo, onSent });

    const dismiss = vi.fn();
    undoToast().action!.onClick(dismiss);
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
  });

  it("0 seconds sends at once, with no Undo", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    sendWithUndo({ seconds: 0, send, onUndo: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(mToast.mock.calls.some((c) => c[0].action)).toBe(false);
  });

  it("a failed send calls onError and says so, not onSent", async () => {
    const send = vi
      .fn()
      .mockRejectedValue(new Error("Invalid To header. Send it again."));
    const onSent = vi.fn();
    const onError = vi.fn();
    sendWithUndo({ seconds: 5, send, onUndo: vi.fn(), onSent, onError });
    await vi.advanceTimersByTimeAsync(5000);

    expect(onSent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(mToast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "error",
        message: "Message not sent",
        description: "Invalid To header. Send it again.",
      }),
    );
  });

  it("never shows a bare status code as the reason", async () => {
    const send = vi.fn().mockRejectedValue(new Error("API error: 500"));
    sendWithUndo({ seconds: 0, send, onUndo: vi.fn(), onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(mToast).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "error", description: undefined }),
    );
  });

  it("guards the tab while a send is held, and releases it after", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    sendWithUndo({
      seconds: 5,
      send: vi.fn().mockResolvedValue(undefined),
      onUndo: vi.fn(),
    });
    expect(add).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    await vi.advanceTimersByTimeAsync(5000);
    expect(remove).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    add.mockRestore();
    remove.mockRestore();
  });
});
