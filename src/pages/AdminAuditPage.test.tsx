import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchAuditEvents: vi.fn(),
  fetchAuditActions: vi.fn(),
  fetchAdminUsers: vi.fn(),
  fetchAdminInboxes: vi.fn(),
}));

// The fetchers are faked; the pure helpers (the export URL) stay real.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  ...api,
}));

import AdminAuditPage from "@/pages/AdminAuditPage";

function event(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    at: 1_800_000_000,
    actorType: "user",
    actorUserId: "u-jane",
    actorLabel: "jane@acme.com",
    channel: "web",
    action: "mail.archived",
    targetType: "message",
    targetId: "received:e1",
    inbox: "support@acme.com",
    summary: `Archived 1 message (${id})`,
    details: null,
    ip: "203.0.113.7",
    userAgent: "Firefox",
    ...overrides,
  };
}

describe("AdminAuditPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchAuditActions.mockResolvedValue({
      actions: ["mail.archived", "mail.deleted", "rule.created"],
    });
    api.fetchAdminUsers.mockResolvedValue([
      { id: "u-jane", name: "Jane", email: "jane@acme.com", role: "admin" },
    ]);
    api.fetchAdminInboxes.mockResolvedValue([{ email: "support@acme.com" }]);
    api.fetchAuditEvents.mockResolvedValue({
      events: [
        event("a", {
          action: "mail.deleted",
          summary: "Deleted 3 messages from support@acme.com",
          details: { count: 3, refs: ["received:e1", "received:e2"] },
        }),
        event("b"),
      ],
      nextCursor: null,
    });
  });

  it("renders the events and opens a row to show its details", async () => {
    render(<AdminAuditPage />);

    const table = await screen.findByTestId("audit-table");
    const rows = within(table).getAllByTestId("audit-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("jane@acme.com");
    expect(rows[0].textContent).toContain("mail.deleted");
    expect(rows[0].textContent).toContain("message received:e1");
    expect(rows[0].textContent).toContain("support@acme.com");
    expect(rows[0].textContent).toContain(
      "Deleted 3 messages from support@acme.com",
    );
    expect(screen.queryByTestId("audit-event-details")).toBeNull();

    fireEvent.click(rows[0]);
    const details = within(table).getByTestId("audit-event-details");
    expect(details.textContent).toContain('"count": 3');
    expect(details.textContent).toContain("203.0.113.7");
    expect(rows[0].getAttribute("aria-expanded")).toBe("true");

    // A row without details says so rather than showing an empty box.
    fireEvent.click(rows[1]);
    expect(
      within(table)
        .getAllByTestId("audit-event-details")
        .some((node) => node.textContent?.includes("No further details")),
    ).toBe(true);

    fireEvent.click(rows[0]);
    expect(within(table).getAllByTestId("audit-event-details")).toHaveLength(1);
  });

  it("applies the filters to the list and to the CSV link", async () => {
    render(<AdminAuditPage />);
    await screen.findByTestId("audit-table");
    expect(api.fetchAuditEvents).toHaveBeenLastCalledWith({});
    expect(screen.getByTestId("audit-export").getAttribute("href")).toBe(
      "/api/admin/audit/export.csv",
    );

    // The choices come from the log, the users and the inboxes.
    await screen.findByRole("option", { name: "mail.*" });
    fireEvent.change(screen.getByLabelText("Action"), {
      target: { value: "prefix:mail." },
    });
    fireEvent.change(screen.getByLabelText("Person"), {
      target: { value: "u-jane" },
    });
    fireEvent.change(screen.getByLabelText("Inbox"), {
      target: { value: "support@acme.com" },
    });
    fireEvent.change(screen.getByLabelText("Text"), {
      target: { value: " invoice " },
    });
    // Nothing is fetched until the filters are applied.
    expect(api.fetchAuditEvents).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => expect(api.fetchAuditEvents).toHaveBeenCalledTimes(2));
    expect(api.fetchAuditEvents).toHaveBeenLastCalledWith({
      actionPrefix: "mail.",
      actorUserId: "u-jane",
      inbox: "support@acme.com",
      q: "invoice",
    });
    await waitFor(() =>
      expect(screen.getByTestId("audit-export").getAttribute("href")).toBe(
        "/api/admin/audit/export.csv?actionPrefix=mail.&actorUserId=u-jane&inbox=support%40acme.com&q=invoice",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() =>
      expect(api.fetchAuditEvents).toHaveBeenLastCalledWith({}),
    );
  });

  it("loads the next page after the ones on screen", async () => {
    api.fetchAuditEvents
      .mockResolvedValueOnce({ events: [event("a")], nextCursor: "1800:9" })
      .mockResolvedValueOnce({ events: [event("b")], nextCursor: null });
    render(<AdminAuditPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() =>
      expect(screen.getAllByTestId("audit-row")).toHaveLength(2),
    );
    expect(api.fetchAuditEvents).toHaveBeenLastCalledWith({}, "1800:9");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("drops a page that arrives after the filters changed", async () => {
    let finishOldPage: (value: unknown) => void = () => {};
    api.fetchAuditEvents
      .mockResolvedValueOnce({ events: [event("a")], nextCursor: "1800:9" })
      // The "Load more" of the first list, still on its way...
      .mockImplementationOnce(
        () => new Promise((resolve) => (finishOldPage = resolve)),
      )
      // ...when new filters fetch a different list.
      .mockResolvedValueOnce({
        events: [event("fresh", { summary: "Fresh result" })],
        nextCursor: null,
      });
    render(<AdminAuditPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    fireEvent.change(screen.getByLabelText("Text"), {
      target: { value: "fresh" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() =>
      expect(screen.getByTestId("audit-table").textContent).toContain(
        "Fresh result",
      ),
    );

    finishOldPage({
      events: [event("stale", { summary: "Stale result" })],
      nextCursor: "1700:1",
    });
    await waitFor(() => expect(api.fetchAuditEvents).toHaveBeenCalledTimes(3));
    // Give the late page a chance to be (wrongly) appended.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("Stale result")).toBeNull();
    expect(screen.getAllByTestId("audit-row")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("says so when nothing matches, and when loading fails", async () => {
    api.fetchAuditEvents.mockResolvedValueOnce({
      events: [],
      nextCursor: null,
    });
    const { unmount } = render(<AdminAuditPage />);
    expect(
      await screen.findByText("No events match these filters."),
    ).toBeTruthy();
    unmount();

    api.fetchAuditEvents.mockRejectedValueOnce(new Error("boom"));
    render(<AdminAuditPage />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Failed to load the audit log.",
    );
  });
});
