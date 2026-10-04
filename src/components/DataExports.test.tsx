// docs/specs/SPEC-mail-export.md: Settings → Data, exporting a mailbox.
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type MailExport } from "@/lib/api";

const api = vi.hoisted(() => ({
  fetchExports: vi.fn(),
  fetchStats: vi.fn(),
  startExport: vi.fn(),
  deleteExport: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  ...api,
}));

import DataExports, { formatBytes } from "@/components/DataExports";
import { dispatchExportReady } from "@/lib/export-events";

function exportRow(overrides: Partial<MailExport> = {}): MailExport {
  return {
    id: "x1",
    inbox: "support@example.com",
    status: "completed",
    processedMessages: 450,
    totalMessages: 450,
    bytes: 13_212_000,
    from: null,
    to: null,
    includeTrash: false,
    includeCampaignSends: false,
    requestedBy: "u1",
    createdAt: 1_790_000_000,
    updatedAt: 1_790_000_100,
    expiresAt: 1_790_604_900,
    error: null,
    ...overrides,
  };
}

function renderAt(path = "/settings") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <DataExports />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchStats.mockResolvedValue({
    totalPeople: 0,
    totalEmails: 0,
    unreadCount: 0,
    recipients: ["support@example.com", "Sales@Example.com"],
    senderIdentities: [{ email: "billing@example.com" }],
  });
  api.fetchExports.mockResolvedValue([]);
  api.startExport.mockResolvedValue(exportRow({ status: "running" }));
  api.deleteExport.mockResolvedValue(undefined);
});

describe("DataExports", () => {
  it("starts an export of the chosen inbox with its options", async () => {
    renderAt();
    const select = await screen.findByLabelText("Inbox");
    await waitFor(() =>
      expect(
        Array.from((select as HTMLSelectElement).options).map((o) => o.value),
      ).toEqual([
        "billing@example.com",
        "sales@example.com",
        "support@example.com",
      ]),
    );
    fireEvent.change(select, { target: { value: "support@example.com" } });
    fireEvent.change(screen.getByLabelText("From (optional)"), {
      target: { value: "2026-01-01" },
    });
    fireEvent.change(screen.getByLabelText("To (optional)"), {
      target: { value: "2026-01-31" },
    });
    fireEvent.click(screen.getByLabelText("Include Trash"));
    api.fetchExports.mockResolvedValue([exportRow({ status: "running" })]);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(api.startExport).toHaveBeenCalledTimes(1));
    expect(api.startExport).toHaveBeenCalledWith({
      inbox: "support@example.com",
      from: Math.floor(new Date("2026-01-01T00:00:00").getTime() / 1000),
      to: Math.floor(new Date("2026-01-31T23:59:59").getTime() / 1000),
      includeTrash: true,
      includeCampaignSends: false,
    });
    expect((await screen.findByTestId("export-status")).textContent).toContain(
      "Exporting… 450 messages so far",
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("preselects the inbox an Export link names", async () => {
    renderAt("/settings?export=sales%40example.com#data");
    await waitFor(() =>
      expect((screen.getByLabelText("Inbox") as HTMLSelectElement).value).toBe(
        "sales@example.com",
      ),
    );
  });

  it("refuses a reversed range and explains a running export", async () => {
    renderAt();
    await screen.findByRole("option", { name: "support@example.com" });
    fireEvent.change(screen.getByLabelText("From (optional)"), {
      target: { value: "2026-02-01" },
    });
    fireEvent.change(screen.getByLabelText("To (optional)"), {
      target: { value: "2026-01-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The start date is after the end date.",
    );
    expect(api.startExport).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("From (optional)"), {
      target: { value: "" },
    });
    api.startExport.mockRejectedValue(
      new ApiError("running", 409, "EXPORT_RUNNING"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "An export of billing@example.com is already running.",
    );
  });

  it("lists finished exports with a download link, and deletes one", async () => {
    api.fetchExports.mockResolvedValue([
      exportRow(),
      exportRow({ id: "x2", status: "failed", error: "stalled" }),
      exportRow({ id: "x3", status: "expired" }),
    ]);
    renderAt();
    const rows = await screen.findAllByTestId("export-row");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("450 messages · 12.6 MB · until");
    expect(
      screen.getByRole("link", { name: "Download" }).getAttribute("href"),
    ).toBe("/api/exports/x1/download");
    expect(rows[1].textContent).toContain("Failed: stalled");
    expect(rows[2].textContent).toContain("Expired");

    api.fetchExports.mockResolvedValue([]);
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    await waitFor(() => expect(api.deleteExport).toHaveBeenCalledWith("x1"));
    await waitFor(() =>
      expect(screen.queryAllByTestId("export-row")).toHaveLength(0),
    );
  });

  it("refreshes when an export is ready", async () => {
    renderAt();
    await waitFor(() => expect(api.fetchExports).toHaveBeenCalledTimes(1));
    api.fetchExports.mockResolvedValue([exportRow()]);
    act(() =>
      dispatchExportReady({ inbox: "support@example.com", jobId: "x1" }),
    );
    expect(await screen.findByTestId("export-row")).toBeTruthy();
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(13_212_000)).toBe("12.6 MB");
    expect(formatBytes(300 * 1024 * 1024)).toBe("300 MB");
  });
});
