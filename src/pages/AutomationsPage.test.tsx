import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createRule: vi.fn(),
  deleteRule: vi.fn(),
  fetchAdminInboxes: vi.fn(),
  fetchAdminUsers: vi.fn(),
  fetchMailboxes: vi.fn(),
  fetchRules: vi.fn(),
  reorderRules: vi.fn(),
  testRule: vi.fn(),
  updateRule: vi.fn(),
}));

vi.mock("@/lib/api", () => api);

import AutomationsPage from "@/pages/AutomationsPage";

function rule(id: string, name: string, position: number) {
  return {
    id,
    name,
    inbox: "support@e2e.test",
    trigger: "message.received" as const,
    conditions: [
      {
        field: "subject" as const,
        operator: "contains" as const,
        value: "help",
      },
    ],
    actions: [{ type: "archive" as const }],
    warnings: [],
    position,
    stopProcessing: false,
    enabled: true,
    matchCount: 0,
    lastMatchedAt: null,
    createdBy: "admin",
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("AutomationsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchRules.mockResolvedValue([]);
    api.fetchAdminInboxes.mockResolvedValue([
      {
        email: "support@e2e.test",
        displayName: "Support",
        displayMode: "chat",
        signatureHtml: null,
        forwardTo: null,
        spamThreshold: null,
        agentInstructions: null,
        agentAutodraft: false,
        assignedUserIds: ["member-1"],
      },
    ]);
    api.fetchAdminUsers.mockResolvedValue([
      {
        id: "admin-1",
        name: "Admin",
        email: "admin@e2e.test",
        role: "admin",
      },
      {
        id: "member-1",
        name: "Member",
        email: "member@e2e.test",
        role: "member",
      },
      {
        id: "other-1",
        name: "Other",
        email: "other@e2e.test",
        role: "member",
      },
    ]);
    api.fetchMailboxes.mockResolvedValue([
      {
        id: "folder-1",
        inbox: "support@e2e.test",
        name: "Priority",
        role: null,
        parentId: null,
        sortOrder: 0,
        createdBy: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    api.createRule.mockImplementation(
      async (input: Record<string, unknown>) => ({
        ...rule("new-rule", String(input.name), Number(input.position)),
        ...input,
      }),
    );
    api.updateRule.mockImplementation(
      async (id: string, patch: Record<string, unknown>) => ({
        ...rule(id, "Updated", 0),
        ...patch,
      }),
    );
    api.deleteRule.mockResolvedValue({ success: true });
    api.reorderRules.mockResolvedValue({ success: true });
    api.testRule.mockResolvedValue({
      matched: true,
      conditionResults: [],
    });
  });

  async function openNew() {
    render(<AutomationsPage />);
    await waitFor(() => expect(api.fetchRules).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("automation-new"));
    await screen.findByRole("dialog");
  }

  it("filters operators when the condition field changes", async () => {
    await openNew();
    fireEvent.click(screen.getByRole("button", { name: "Add condition" }));

    const field = screen.getByLabelText("Condition 1 field");
    const operator = screen.getByLabelText("Condition 1 operator");

    fireEvent.change(field, { target: { value: "from_domain" } });
    expect(
      within(operator)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["equals"]);

    fireEvent.change(field, { target: { value: "spam_score" } });
    expect(
      within(operator)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["gte", "lte"]);
    expect(
      (screen.getByLabelText("Condition 1 value") as HTMLInputElement).type,
    ).toBe("number");
  });

  it("disables scoped-only actions for All inboxes", async () => {
    await openNew();
    const actionType = screen.getByLabelText("Action 1 type");
    expect(
      (
        within(actionType).getByRole("option", {
          name: "Move to folder",
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        within(actionType).getByRole("option", {
          name: "Assign",
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        within(actionType).getByRole("option", {
          name: "Auto-reply",
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByText(
        /Move to folder, Assign, and Auto-reply are unavailable/,
      ),
    ).toBeTruthy();
  });

  it("renders auto-reply subject, body counter, and guard note", async () => {
    await openNew();
    fireEvent.change(screen.getByLabelText("Scope"), {
      target: { value: "support@e2e.test" },
    });
    fireEvent.change(screen.getByLabelText("Action 1 type"), {
      target: { value: "auto_reply" },
    });

    const subject = screen.getByLabelText("Action 1 subject");
    const body = screen.getByLabelText("Action 1 body");
    expect((subject as HTMLInputElement).maxLength).toBe(200);
    expect((body as HTMLTextAreaElement).maxLength).toBe(5000);

    fireEvent.change(subject, { target: { value: "Thanks" } });
    fireEvent.change(body, { target: { value: "Hello there" } });

    expect(screen.getByText("11/5000")).toBeTruthy();
    expect(
      screen.getByText(
        "Won't reply to automated mail, your own addresses, blocked/suppressed senders, or the same sender more than once per 24h.",
      ),
    ).toBeTruthy();
  });

  it("shows a warning badge and dangling action message", async () => {
    api.fetchRules.mockResolvedValue([
      {
        ...rule("dangling-rule", "Dangling", 0),
        actions: [
          { type: "move_to_folder" as const, mailboxId: "missing-folder" },
        ],
        warnings: [{ actionIndex: 0, code: "missing_folder" as const }],
      },
    ]);
    render(<AutomationsPage />);

    const badge = await screen.findByTestId("automation-warning-badge");
    expect(badge.textContent).toContain("1 warning");

    fireEvent.click(screen.getByRole("button", { name: "Edit Dangling" }));
    expect(
      await screen.findByText("Folder was deleted; this action does nothing"),
    ).toBeTruthy();
  });

  it("warns when a rule has zero conditions", async () => {
    await openNew();
    expect(
      screen.getByText("This rule matches every message in its scope"),
    ).toBeTruthy();
  });

  it("renders server validation errors inline", async () => {
    api.createRule.mockRejectedValueOnce(
      new Error("Folder does not belong to the rule inbox"),
    );
    await openNew();

    fireEvent.change(screen.getByLabelText("Rule name"), {
      target: { value: "Invalid rule" },
    });
    fireEvent.click(screen.getByTestId("automation-save"));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Folder does not belong to the rule inbox",
    );
  });

  it("reorders with the complete id list", async () => {
    api.fetchRules.mockResolvedValue([
      rule("rule-1", "First", 0),
      rule("rule-2", "Second", 1),
    ]);
    render(<AutomationsPage />);

    const rows = await screen.findAllByTestId("automation-rule-row");
    fireEvent.click(within(rows[0]).getByTestId("rule-move-down"));

    await waitFor(() =>
      expect(api.reorderRules).toHaveBeenCalledWith(["rule-2", "rule-1"]),
    );
  });
});
