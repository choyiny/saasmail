import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useDraftAutosave, type DraftValues } from "@/lib/use-draft-autosave";
import { fetchDraft, saveDraft, deleteDraft, type Draft } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  fetchDraft: vi.fn(),
  saveDraft: vi.fn(),
  deleteDraft: vi.fn(),
}));

const mFetch = vi.mocked(fetchDraft);
const mSave = vi.mocked(saveDraft);
const mDelete = vi.mocked(deleteDraft);

type Props = Parameters<typeof useDraftAutosave>[0];
const baseProps = (over: Partial<Props> = {}): Props => ({
  contextKey: "compose",
  enabled: true,
  isEmpty: false,
  restore: false,
  values: { to: "a@b.com", subject: "Hi", bodyHtml: "<p>x</p>" } as DraftValues,
  onRestore: () => {},
  debounceMs: 1000,
  ...over,
});

beforeEach(() => {
  mFetch.mockReset().mockResolvedValue(null);
  mSave.mockReset().mockResolvedValue({} as Draft);
  mDelete.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useDraftAutosave", () => {
  it("debounced-saves when there's content", () => {
    vi.useFakeTimers();
    renderHook((p: Props) => useDraftAutosave(p), {
      initialProps: baseProps(),
    });
    expect(mSave).not.toHaveBeenCalled(); // not until the debounce elapses
    act(() => vi.advanceTimersByTime(1000));
    expect(mSave).toHaveBeenCalledWith({
      contextKey: "compose",
      to: "a@b.com",
      subject: "Hi",
      bodyHtml: "<p>x</p>",
    });
  });

  it("does not save an empty draft", () => {
    vi.useFakeTimers();
    renderHook((p: Props) => useDraftAutosave(p), {
      initialProps: baseProps({ isEmpty: true, values: {} }),
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(mSave).not.toHaveBeenCalled();
  });

  it("restores a saved draft on open", async () => {
    const draft: Draft = {
      id: "d1",
      contextKey: "compose",
      fromAddress: null,
      toAddress: "restored@x.com",
      cc: null,
      subject: "Restored",
      bodyHtml: "<p>restored</p>",
      bodyText: "restored",
      replyToEmailId: null,
      updatedAt: 1,
    };
    mFetch.mockResolvedValue(draft);
    const onRestore = vi.fn();
    renderHook((p: Props) => useDraftAutosave(p), {
      initialProps: baseProps({ restore: true, onRestore }),
    });
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith(draft));
    expect(mFetch).toHaveBeenCalledWith("compose");
  });

  it("keeps (flushes) the draft when the composer closes", () => {
    vi.useFakeTimers();
    const { rerender } = renderHook((p: Props) => useDraftAutosave(p), {
      initialProps: baseProps(),
    });
    mSave.mockClear();
    // Close: enabled → false. The final state is flushed, not discarded.
    act(() => rerender(baseProps({ enabled: false })));
    expect(mSave).toHaveBeenCalledWith({
      contextKey: "compose",
      to: "a@b.com",
      subject: "Hi",
      bodyHtml: "<p>x</p>",
    });
    expect(mDelete).not.toHaveBeenCalled();
  });

  it("clear() deletes the draft and the following close does not re-save it", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook((p: Props) => useDraftAutosave(p), {
      initialProps: baseProps(),
    });
    // Simulate a send: content was autosaved, then cleared.
    act(() => vi.advanceTimersByTime(1000));
    mSave.mockClear();
    mDelete.mockClear();
    act(() => result.current.clear());
    expect(mDelete).toHaveBeenCalledWith("compose");
    // Closing afterwards must NOT resurrect the just-sent draft.
    act(() => rerender(baseProps({ enabled: false })));
    expect(mSave).not.toHaveBeenCalled();
  });
});
