import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { UIMessageStreamError } from "ai";
import AgentChatSession from "@/agent/AgentChatSession";
import * as api from "@/lib/api";

const sdk = vi.hoisted(() => ({
  useAgent: vi.fn(),
  useAgentChat: vi.fn(),
  approval: vi.fn(),
  clearError: vi.fn(),
}));

vi.mock("agents/react", () => ({ useAgent: sdk.useAgent }));
vi.mock("@cloudflare/ai-chat/react", () => ({
  useAgentChat: sdk.useAgentChat,
}));
vi.mock("@/agent/AgentContext", () => ({
  useAgentContext: () => ({ context: {} }),
}));
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchAgentApprovalSummary: vi.fn(),
  };
});

const session: api.AgentSession = {
  id: "approval-session",
  title: "Approval",
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
  instanceName: "u-user-s-approval-session",
};

beforeEach(() => {
  vi.restoreAllMocks();
  sdk.approval.mockReset();
  sdk.clearError.mockReset();
  sdk.useAgent.mockReturnValue({ agent: "mail-agent" });
  vi.mocked(api.fetchAgentApprovalSummary).mockResolvedValue({
    summary: "Add jane@acme.com to list 'Beta testers'",
  });
});

function mockAgentChat(
  parts: Record<string, unknown>[],
  status: "ready" | "submitted" | "streaming" = "ready",
  error: Error | null = null,
) {
  sdk.useAgentChat.mockReturnValue({
    messages: [
      {
        id: "approval-message",
        role: "assistant",
        parts,
      },
    ],
    sendMessage: vi.fn(),
    stop: vi.fn(),
    regenerate: vi.fn(),
    addToolApprovalResponse: sdk.approval,
    clearError: sdk.clearError,
    error,
    status,
    isStreaming: status !== "ready",
  });
}

function renderWithParts(
  parts: Record<string, unknown>[],
  status: "ready" | "submitted" | "streaming" = "ready",
  error: Error | null = null,
) {
  mockAgentChat(parts, status, error);

  return render(
    <MemoryRouter>
      <AgentChatSession
        session={session}
        onOpenCompose={() => {}}
        onFirstUserMessage={() => {}}
      />
    </MemoryRouter>,
  );
}

describe("AgentChatSession approvals", () => {
  it("renders the database summary and sends the approval id for approve and deny", async () => {
    renderWithParts([
      {
        type: "tool-add_to_list",
        toolCallId: "approval-call",
        state: "approval-requested",
        input: { personId: "person-1", listId: "list-1" },
        approval: { id: "approval-id-1" },
      },
    ]);

    expect(
      await screen.findByText("Add jane@acme.com to list 'Beta testers'"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(sdk.approval).toHaveBeenCalledWith({
      id: "approval-id-1",
      approved: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(sdk.approval).toHaveBeenCalledWith({
      id: "approval-id-1",
      approved: false,
    });
  });

  it("shows only Dismiss when the database says the action is blocked", async () => {
    vi.mocked(api.fetchAgentApprovalSummary).mockResolvedValue({
      summary: "Can't add: jane@acme.com unsubscribed from 'Beta testers'",
    });
    renderWithParts([
      {
        type: "tool-add_to_list",
        toolCallId: "approval-call-blocked",
        state: "approval-requested",
        input: { personId: "person-1", listId: "list-1" },
        approval: { id: "approval-id-blocked" },
      },
    ]);

    expect(
      await screen.findByText(
        "Can't add: jane@acme.com unsubscribed from 'Beta testers'",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(sdk.approval).toHaveBeenCalledWith({
      id: "approval-id-blocked",
      approved: false,
    });
  });

  it("shows the persisted reason for an expired denied approval", async () => {
    vi.mocked(api.fetchAgentApprovalSummary).mockRejectedValue(
      new Error("not found"),
    );
    renderWithParts([
      {
        type: "tool-link_customer",
        toolCallId: "approval-call-expired",
        state: "approval-responded",
        input: { personId: "person-1", otherPersonId: "person-2" },
        approval: {
          id: "approval-id-expired",
          approved: false,
          reason: "This approval expired. Ask the agent again.",
        },
      },
    ]);

    expect(
      screen.getByText("This approval expired. Ask the agent again."),
    ).toBeTruthy();
    expect(screen.queryByText("Denied")).toBeNull();
  });

  it("shows the persisted reason for an output-denied expired approval", async () => {
    vi.mocked(api.fetchAgentApprovalSummary).mockRejectedValue(
      new Error("not found"),
    );
    renderWithParts([
      {
        type: "tool-link_customer",
        toolCallId: "approval-call-output-denied",
        state: "output-denied",
        input: { personId: "person-1", otherPersonId: "person-2" },
        approval: {
          id: "approval-id-output-denied",
          approved: false,
          reason: "This approval expired. Ask the agent again.",
        },
      },
    ]);

    expect(
      screen.getByText("This approval expired. Ask the agent again."),
    ).toBeTruthy();
    expect(screen.queryByText("Denied")).toBeNull();
  });

  it("falls back to tool args and shows the recorded decision", async () => {
    vi.mocked(api.fetchAgentApprovalSummary).mockRejectedValue(
      new Error("not found"),
    );
    renderWithParts([
      {
        type: "tool-link_customer",
        toolCallId: "approval-call-2",
        state: "approval-responded",
        input: { personId: "person-1", otherPersonId: "person-2" },
        approval: { id: "approval-id-2", approved: false },
      },
    ]);

    expect(screen.getByText("Denied")).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByTestId("agent-approval-link_customer").textContent,
      ).toContain("link_customer"),
    );
  });
});

describe("AgentChatSession continuation errors and scrolling", () => {
  it("hides a stale missing-tool error once that tool call is terminal", async () => {
    const toolCallId =
      "functions.assign_conversation:3::cf-wai-tool-call::terminal-test";
    const error = new UIMessageStreamError({
      chunkType: "tool-invocation",
      chunkId: toolCallId,
      message: `No tool invocation found for tool call ID "${toolCallId}".`,
    });

    renderWithParts(
      [
        {
          type: "tool-assign_conversation",
          toolCallId,
          state: "output-available",
          input: { inbox: "support@example.com", personId: "person-1" },
          output: { assigned: true },
          approval: { id: "approval-terminal", approved: true },
        },
      ],
      "ready",
      error,
    );

    expect(screen.queryByTestId("agent-chat-error")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await waitFor(() => expect(sdk.clearError).toHaveBeenCalledTimes(1));
  });

  it("renders an approval-signature continuation error from useAgentChat", () => {
    renderWithParts(
      [],
      "ready",
      new Error("This approval expired. Ask the agent again."),
    );

    expect(
      screen.getByText("This approval expired. Ask the agent again."),
    ).toBeTruthy();
  });

  it("auto-scrolls new content unless the user has scrolled up", () => {
    const view = renderWithParts([{ type: "text", text: "First answer." }]);
    const transcript = screen.getByTestId("agent-transcript") as HTMLDivElement;
    let scrollHeight = 1000;
    Object.defineProperty(transcript, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(transcript, "clientHeight", {
      configurable: true,
      value: 200,
    });

    transcript.scrollTop = 790;
    fireEvent.scroll(transcript);
    scrollHeight = 1200;
    mockAgentChat([{ type: "text", text: "First answer.\nSecond chunk." }]);
    view.rerender(
      <MemoryRouter>
        <AgentChatSession
          session={session}
          onOpenCompose={() => {}}
          onFirstUserMessage={() => {}}
        />
      </MemoryRouter>,
    );
    expect(transcript.scrollTop).toBe(1200);

    transcript.scrollTop = 100;
    fireEvent.scroll(transcript);
    scrollHeight = 1400;
    mockAgentChat([
      { type: "text", text: "First answer.\nSecond chunk.\nThird chunk." },
    ]);
    view.rerender(
      <MemoryRouter>
        <AgentChatSession
          session={session}
          onOpenCompose={() => {}}
          onFirstUserMessage={() => {}}
        />
      </MemoryRouter>,
    );
    expect(transcript.scrollTop).toBe(100);
  });
});

describe("AgentChatSession reasoning fallback", () => {
  it("renders a reasoning-only assistant answer without tool calls", () => {
    renderWithParts([
      { type: "reasoning", text: "The answer came back as reasoning." },
    ]);

    expect(screen.getByText("The answer came back as reasoning.")).toBeTruthy();
  });

  it.each(["submitted", "streaming"] as const)(
    "does not render reasoning fallback while the last message is %s",
    (status) => {
      renderWithParts(
        [{ type: "reasoning", text: "Still thinking about the answer." }],
        status,
      );

      expect(screen.queryByText("Still thinking about the answer.")).toBeNull();
      expect(screen.getByText("Thinking…")).toBeTruthy();
      expect(
        screen.getByTestId("agent-thinking").getAttribute("aria-live"),
      ).toBe("polite");
    },
  );

  const toolPart = {
    type: "tool-list_messages",
    toolCallId: "functions.list_messages:1::cf-wai-tool-call::reasoning-test",
    state: "output-available",
    input: { inbox: "support@example.com" },
    output: { messages: [] },
  };

  it("shows Thinking after a tool while the final answer has not started", () => {
    renderWithParts([toolPart], "submitted");

    expect(screen.getByText("Thinking…")).toBeTruthy();
  });

  it("hides Thinking once visible text arrives after the last tool", () => {
    renderWithParts(
      [
        toolPart,
        { type: "reasoning", text: "Hidden chain.", state: "done" },
        { type: "text", text: "Visible answer." },
      ],
      "streaming",
    );

    expect(screen.queryByText("Thinking…")).toBeNull();
    expect(screen.queryByText("Hidden chain.")).toBeNull();
    expect(screen.getByText("Visible answer.")).toBeTruthy();
  });

  it("renders trailing reasoning when a tool has no final text", () => {
    renderWithParts([
      toolPart,
      { type: "reasoning", text: "The mailbox is currently empty." },
    ]);

    expect(screen.getByText("The mailbox is currently empty.")).toBeTruthy();
  });

  it("renders final text instead of trailing reasoning when both exist", () => {
    renderWithParts([
      toolPart,
      { type: "reasoning", text: "Hidden analysis answer." },
      { type: "text", text: "Visible final answer." },
    ]);

    expect(screen.getByText("Visible final answer.")).toBeTruthy();
    expect(screen.queryByText("Hidden analysis answer.")).toBeNull();
  });

  it("does not render reasoning that appears before the last tool call", () => {
    renderWithParts([
      { type: "reasoning", text: "Early hidden analysis." },
      toolPart,
    ]);

    expect(screen.queryByText("Early hidden analysis.")).toBeNull();
  });
});
