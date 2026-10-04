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

import { MemoryRouter } from "react-router-dom";
import AutomationsPage from "@/pages/AutomationsPage";

/** The page reads its URL (a prefilled rule from the Inboxes page). */
function renderPage(url = "/automations") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <AutomationsPage />
    </MemoryRouter>,
  );
}

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
    renderPage();
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
        /Move to folder, Assign, Auto-reply and AI filing are unavailable/,
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

  it("builds a reject rule: a reason, the warning, and no other action", async () => {
    await openNew();
    fireEvent.change(screen.getByLabelText("Action 1 type"), {
      target: { value: "reject" },
    });
    const reason = screen.getByLabelText("Action 1 reason") as HTMLInputElement;
    expect(reason.maxLength).toBe(200);
    expect(
      screen.getByText(
        "The sender's server is told the message was refused. Nothing is stored. This must be the rule's only action.",
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Add action" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // The dry run sends the actions and says the message would be rejected.
    api.testRule.mockResolvedValue({
      matched: true,
      wouldReject: true,
      conditionResults: [],
    });
    fireEvent.change(screen.getByLabelText("Message ref or id"), {
      target: { value: "received:e1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(
      await screen.findByText(/this message would be rejected/),
    ).toBeTruthy();
    expect(api.testRule).toHaveBeenCalledWith([], "e1", [{ type: "reject" }]);
  });

  it("tests a rule whose actions are still being filled in", async () => {
    await openNew();
    fireEvent.change(screen.getByLabelText("Scope"), {
      target: { value: "support@e2e.test" },
    });
    // An auto-reply with no body yet.
    fireEvent.change(screen.getByLabelText("Action 1 type"), {
      target: { value: "auto_reply" },
    });
    fireEvent.change(screen.getByLabelText("Message ref or id"), {
      target: { value: "e1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() =>
      expect(api.testRule).toHaveBeenCalledWith([], "e1", undefined),
    );
  });

  it("keeps a reject reason to plain ASCII", async () => {
    await openNew();
    fireEvent.change(screen.getByLabelText("Rule name"), {
      target: { value: "Refuse" },
    });
    fireEvent.change(screen.getByLabelText("Action 1 type"), {
      target: { value: "reject" },
    });
    const reason = screen.getByLabelText("Action 1 reason") as HTMLInputElement;

    // Curly quotes become plain ones as they are typed.
    fireEvent.change(reason, { target: { value: "We don\u2019t take this" } });
    expect(reason.value).toBe("We don't take this");

    // Anything else is refused before saving.
    fireEvent.change(reason, { target: { value: "Refusé" } });
    expect(
      screen.getByText("Use plain letters, digits and punctuation only."),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("automation-save"));
    expect((await screen.findAllByRole("alert")).at(-1)!.textContent).toMatch(
      /plain letters, digits and punctuation/,
    );
    expect(api.createRule).not.toHaveBeenCalled();
  });

  it("offers AI filing for one inbox, with the archive choice and the folders it files into", async () => {
    api.fetchMailboxes.mockResolvedValue([
      {
        id: "folder-1",
        inbox: "support@e2e.test",
        name: "Billing",
        role: null,
        parentId: null,
        sortOrder: 0,
        color: null,
        aiDescription: "Invoices",
        createdBy: null,
        createdAt: 1,
        updatedAt: 1,
        ruleCount: 0,
      },
    ]);
    await openNew();
    expect(
      (
        within(screen.getByLabelText("Action 1 type")).getByRole("option", {
          name: "Let the AI file into folders",
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(true);

    fireEvent.change(screen.getByLabelText("Scope"), {
      target: { value: "support@e2e.test" },
    });
    fireEvent.change(screen.getByLabelText("Action 1 type"), {
      target: { value: "ai_file" },
    });
    expect((await screen.findByTestId("ai-file-folders")).textContent).toMatch(
      /^Files into: Billing\./,
    );
    fireEvent.click(screen.getByLabelText("Action 1 also archive"));
    fireEvent.change(screen.getByLabelText("Rule name"), {
      target: { value: "File" },
    });
    fireEvent.click(screen.getByTestId("automation-save"));
    await waitFor(() =>
      expect(api.createRule).toHaveBeenCalledWith(
        expect.objectContaining({
          actions: [{ type: "ai_file", archiveWhenFiled: true }],
        }),
      ),
    );
  });

  it("opens a prefilled junk rule from the Inboxes page", async () => {
    renderPage("/automations?prefill=junk&inbox=support%40e2e.test");
    const dialog = await screen.findByRole("dialog");
    expect(
      (within(dialog).getByLabelText("Rule name") as HTMLInputElement).value,
    ).toBe("Junk (learned filter)");
    expect(
      (within(dialog).getByLabelText("Condition 1 field") as HTMLSelectElement)
        .value,
    ).toBe("spam_probability");
    expect(
      (within(dialog).getByLabelText("Condition 1 value") as HTMLInputElement)
        .value,
    ).toBe("0.9");
    expect(
      within(dialog).getByText(/Requires the inbox's learning filter/),
    ).toBeTruthy();
    expect(
      (within(dialog).getByLabelText("Action 1 type") as HTMLSelectElement)
        .value,
    ).toBe("mark_spam");
  });

  it("does not offer reject next to another action", async () => {
    await openNew();
    fireEvent.click(screen.getByRole("button", { name: "Add action" }));
    const actionType = screen.getByLabelText("Action 1 type");
    expect(
      (
        within(actionType).getByRole("option", {
          name: "Reject the message",
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(true);
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
    renderPage();

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
    renderPage();

    const rows = await screen.findAllByTestId("automation-rule-row");
    fireEvent.click(within(rows[0]).getByTestId("rule-move-down"));

    await waitFor(() =>
      expect(api.reorderRules).toHaveBeenCalledWith(["rule-2", "rule-1"]),
    );
  });
});
