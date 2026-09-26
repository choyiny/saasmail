import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SuggestedReplyCard from "@/components/SuggestedReplyCard";
import * as api from "@/lib/api";
import { showToast } from "@/lib/toast";

vi.mock("@/lib/toast", () => ({ showToast: vi.fn() }));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchSuggestedReply: vi.fn(),
    fetchDraft: vi.fn(),
    saveDraft: vi.fn(),
    useSuggestedReply: vi.fn(),
    dismissSuggestedReply: vi.fn(),
  };
});

const suggestion: api.SuggestedReply = {
  id: "suggestion-1",
  emailId: "email-1",
  inbox: "support@example.com",
  bodyText: "Thanks for reaching out. I can help with that.",
  model: "test-model",
  status: "pending",
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.mocked(api.fetchSuggestedReply).mockResolvedValue(suggestion);
  vi.mocked(api.fetchDraft).mockResolvedValue(null);
  vi.mocked(api.saveDraft).mockResolvedValue({} as api.Draft);
  vi.mocked(api.useSuggestedReply).mockResolvedValue({
    ...suggestion,
    status: "used",
  });
  vi.mocked(api.dismissSuggestedReply).mockResolvedValue({
    ...suggestion,
    status: "dismissed",
  });
});

describe("SuggestedReplyCard", () => {
  it("loads a suggestion into a new reply draft when Use is clicked", async () => {
    const onUse = vi.fn();
    render(<SuggestedReplyCard emailId="email-1" onUse={onUse} />);

    fireEvent.click(await screen.findByTestId("suggested-reply-use"));

    await waitFor(() =>
      expect(api.saveDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          contextKey: "reply:email-1",
          bodyText: suggestion.bodyText,
          replyToEmailId: "email-1",
        }),
      ),
    );
    expect(api.useSuggestedReply).toHaveBeenCalledWith("suggestion-1");
    expect(onUse).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("suggested-reply-card")).toBeNull();
  });

  it("asks before replacing a non-empty existing reply draft", async () => {
    vi.mocked(api.fetchDraft).mockResolvedValue({
      id: "draft-1",
      contextKey: "reply:email-1",
      fromAddress: "support@example.com",
      toAddress: "customer@example.com",
      cc: null,
      subject: null,
      bodyHtml: "<p>My existing reply</p>",
      bodyText: "My existing reply",
      replyToEmailId: "email-1",
      updatedAt: 1,
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const onUse = vi.fn();

    render(<SuggestedReplyCard emailId="email-1" onUse={onUse} />);
    fireEvent.click(await screen.findByTestId("suggested-reply-use"));

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(api.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        contextKey: "reply:email-1",
        fromAddress: "support@example.com",
        to: "customer@example.com",
        bodyText: suggestion.bodyText,
      }),
    );
    expect(api.useSuggestedReply).toHaveBeenCalledWith("suggestion-1");
    expect(onUse).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing draft when replacement is declined", async () => {
    vi.mocked(api.fetchDraft).mockResolvedValue({
      id: "draft-2",
      contextKey: "reply:email-1",
      fromAddress: null,
      toAddress: null,
      cc: null,
      subject: null,
      bodyHtml: null,
      bodyText: "Keep this",
      replyToEmailId: "email-1",
      updatedAt: 1,
    });
    vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<SuggestedReplyCard emailId="email-1" onUse={() => {}} />);
    fireEvent.click(await screen.findByTestId("suggested-reply-use"));

    await waitFor(() => expect(api.fetchDraft).toHaveBeenCalled());
    expect(api.saveDraft).not.toHaveBeenCalled();
    expect(api.useSuggestedReply).not.toHaveBeenCalled();
    expect(screen.getByTestId("suggested-reply-card")).toBeTruthy();
  });

  it("dismisses and hides the suggestion", async () => {
    render(<SuggestedReplyCard emailId="email-1" onUse={() => {}} />);

    fireEvent.click(await screen.findByTestId("suggested-reply-dismiss"));

    await waitFor(() =>
      expect(api.dismissSuggestedReply).toHaveBeenCalledWith("suggestion-1"),
    );
    expect(screen.queryByTestId("suggested-reply-card")).toBeNull();
  });

  it("keeps the card visible when Use fails", async () => {
    vi.mocked(api.saveDraft).mockRejectedValue(new Error("save failed"));
    render(<SuggestedReplyCard emailId="email-1" onUse={() => {}} />);

    fireEvent.click(await screen.findByTestId("suggested-reply-use"));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(screen.getByTestId("suggested-reply-card")).toBeTruthy();
  });

  it("keeps the card visible when Dismiss fails", async () => {
    vi.mocked(api.dismissSuggestedReply).mockRejectedValue(
      new Error("dismiss failed"),
    );
    render(<SuggestedReplyCard emailId="email-1" onUse={() => {}} />);

    fireEvent.click(await screen.findByTestId("suggested-reply-dismiss"));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(screen.getByTestId("suggested-reply-card")).toBeTruthy();
  });
});
