// docs/archive/SPEC-header-threading.md: the Inboxes page's conversation mode.
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchAdminInboxes: vi.fn(),
  updateInboxSettings: vi.fn(),
}));
vi.mock("@/lib/api", () => api);

import ConversationModeControl, {
  conversationModeConsequences,
} from "@/components/ConversationModeControl";

function inbox(overrides: Record<string, unknown> = {}) {
  return {
    email: "support@acme.com",
    displayName: null,
    displayMode: "chat",
    threadingMode: "relationship",
    threadBackfill: null,
    signatureHtml: null,
    forwardTo: null,
    spamThreshold: null,
    agentInstructions: null,
    agentAutodraft: false,
    assignedUserIds: [],
    spamFilter: {
      enabled: false,
      spamMessages: 0,
      hamMessages: 0,
      ready: false,
    },
    ...overrides,
  } as any;
}

const running = {
  id: "job-1",
  mode: "headers",
  status: "running",
  processed: 120,
  total: 4000,
};

describe("ConversationModeControl", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it("asks first, listing what changes, then switches to threads", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    api.updateInboxSettings.mockResolvedValue({
      threadingMode: "headers",
      threadBackfill: { ...running, processed: 0 },
    });
    const onChange = vi.fn();
    render(<ConversationModeControl inbox={inbox()} onChange={onChange} />);
    fireEvent.change(
      screen.getByRole("combobox", {
        name: "Conversations of support@acme.com",
      }),
      { target: { value: "headers" } },
    );
    expect(confirm).toHaveBeenCalledWith(
      conversationModeConsequences("headers"),
    );
    const text = conversationModeConsequences("headers");
    expect(text).toContain("regrouped in the background");
    expect(text).toContain("Snoozes and assignments in this inbox are cleared");
    expect(text).toContain("JMAP resync");
    await waitFor(() =>
      expect(api.updateInboxSettings).toHaveBeenCalledWith("support@acme.com", {
        threadingMode: "headers",
      }),
    );
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        threadingMode: "headers",
        threadBackfill: { ...running, processed: 0 },
      }),
    );
  });

  it("changes nothing when the confirmation is declined", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ConversationModeControl inbox={inbox()} onChange={vi.fn()} />);
    fireEvent.change(screen.getByTestId("inbox-threading-mode"), {
      target: { value: "headers" },
    });
    expect(api.updateInboxSettings).not.toHaveBeenCalled();
  });

  it("shows the regrouping's progress and polls until it ends", async () => {
    vi.useFakeTimers();
    api.fetchAdminInboxes.mockResolvedValue([
      inbox({
        threadingMode: "headers",
        threadBackfill: { ...running, status: "completed", processed: 4000 },
      }),
    ]);
    const onChange = vi.fn();
    render(
      <ConversationModeControl
        inbox={inbox({ threadingMode: "headers", threadBackfill: running })}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("inbox-threading-progress").textContent).toBe(
      "Regrouping… 120 of 4,000",
    );
    expect(
      (screen.getByTestId("inbox-threading-mode") as HTMLSelectElement)
        .disabled,
    ).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(onChange).toHaveBeenCalledWith({
      threadingMode: "headers",
      threadBackfill: expect.objectContaining({ status: "completed" }),
    });
  });

  it("offers to run a regrouping that stopped again", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    api.updateInboxSettings.mockResolvedValue({
      threadingMode: "headers",
      threadBackfill: { ...running, id: "job-2", processed: 0 },
    });
    render(
      <ConversationModeControl
        inbox={inbox({
          threadingMode: "headers",
          threadBackfill: { ...running, status: "failed" },
        })}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("inbox-threading-failed").textContent).toContain(
      "Regrouping stopped part-way.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(api.updateInboxSettings).toHaveBeenCalledWith("support@acme.com", {
        threadingMode: "headers",
      }),
    );
  });

  it("shows why a change was refused", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    api.updateInboxSettings.mockRejectedValue(
      new Error("This inbox's conversations are still being regrouped"),
    );
    render(<ConversationModeControl inbox={inbox()} onChange={vi.fn()} />);
    fireEvent.change(screen.getByTestId("inbox-threading-mode"), {
      target: { value: "headers" },
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This inbox's conversations are still being regrouped",
    );
  });
});
