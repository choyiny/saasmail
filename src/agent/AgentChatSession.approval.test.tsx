import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import AgentChatSession from "@/agent/AgentChatSession";
import * as api from "@/lib/api";

const sdk = vi.hoisted(() => ({
  useAgent: vi.fn(),
  useAgentChat: vi.fn(),
  approval: vi.fn(),
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
  sdk.useAgent.mockReturnValue({ agent: "mail-agent" });
  vi.mocked(api.fetchAgentApprovalSummary).mockResolvedValue({
    summary: "Add jane@acme.com to list 'Beta testers'",
  });
});

function renderWithParts(
  parts: Record<string, unknown>[],
  status: "ready" | "submitted" | "streaming" = "ready",
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
    error: null,
    status,
    isStreaming: status !== "ready",
  });

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
    },
  );

  const toolPart = {
    type: "tool-list_messages",
    toolCallId: "functions.list_messages:1::cf-wai-tool-call::reasoning-test",
    state: "output-available",
    input: { inbox: "support@example.com" },
    output: { messages: [] },
  };

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
