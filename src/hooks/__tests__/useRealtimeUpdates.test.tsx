import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRealtimeUpdates } from "@/hooks/useRealtimeUpdates";
import { onInboxRefresh } from "@/lib/inbox-events";

class FakeSocket {
  static last: FakeSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
  close() {}
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useRealtimeUpdates", () => {
  it("reloads lists and open conversations once for a burst of mail_refresh", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    const onEmail = vi.fn();
    const onRefresh = vi.fn();
    const off = onInboxRefresh(onRefresh);
    const { unmount } = renderHook(() => useRealtimeUpdates(onEmail));

    const frame = {
      data: JSON.stringify({ type: "mail_refresh", inbox: "a@x" }),
    };
    FakeSocket.last!.onmessage!(frame);
    FakeSocket.last!.onmessage!(frame);
    expect(onRefresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_500);

    expect(onEmail).toHaveBeenCalledTimes(1);
    expect(onEmail).toHaveBeenCalledWith({ inbox: "a@x" });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    off();
    unmount();
  });
});
