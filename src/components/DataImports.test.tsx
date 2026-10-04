// docs/specs/SPEC-mail-import.md: Settings → Data → Import mail (admins).
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MailImport } from "@/lib/api";

const api = vi.hoisted(() => ({
  fetchImports: vi.fn(),
  startImport: vi.fn(),
  uploadImportPart: vi.fn(),
  completeImport: vi.fn(),
  deleteImport: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  ...api,
}));

import DataImports, { UPLOAD_TIMING } from "@/components/DataImports";
import { ApiError } from "@/lib/api";
import { dispatchImportDone } from "@/lib/export-events";

function importRow(overrides: Partial<MailImport> = {}): MailImport {
  return {
    id: "i1",
    inbox: "support@example.com",
    filename: "takeout.mbox",
    status: "completed",
    size: 2_000_000,
    bytesRead: 2_000_000,
    processedMessages: 12,
    importedMessages: 10,
    skippedMessages: 2,
    direction: "strict",
    createFoldersFromLabels: true,
    partSize: 4,
    partsExpected: 2,
    partsUploaded: 2,
    notes: [],
    createdAt: 1_790_000_000,
    updatedAt: 1_790_000_100,
    ...overrides,
  };
}

function pickFile(content: string, name = "mail.mbox") {
  const file = new File([content], name, { type: "application/mbox" });
  fireEvent.change(screen.getByLabelText("File"), {
    target: { files: [file] },
  });
  return file;
}

beforeEach(() => {
  vi.clearAllMocks();
  UPLOAD_TIMING.retryMs = 0;
  api.fetchImports.mockResolvedValue([]);
  api.startImport.mockResolvedValue(
    importRow({ status: "uploading", partsUploaded: 0 }),
  );
  api.uploadImportPart.mockResolvedValue(undefined);
  api.completeImport.mockResolvedValue(importRow({ status: "running" }));
  api.deleteImport.mockResolvedValue(undefined);
});

const INBOXES = ["sales@example.com", "support@example.com"];

describe("DataImports", () => {
  it("uploads the file in parts, then starts the import", async () => {
    render(<DataImports inboxes={INBOXES} />);
    pickFile("abcdef");
    fireEvent.change(screen.getByLabelText("Into inbox"), {
      target: { value: "support@example.com" },
    });
    fireEvent.click(screen.getByLabelText(/Everything as received/));
    fireEvent.click(screen.getByLabelText("Create folders from labels"));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(api.completeImport).toHaveBeenCalledWith("i1"));
    expect(api.startImport).toHaveBeenCalledWith({
      inbox: "support@example.com",
      filename: "mail.mbox",
      size: 6,
      direction: "all_received",
      createFoldersFromLabels: false,
    });
    expect(api.uploadImportPart).toHaveBeenCalledTimes(2);
    const [first, second] = api.uploadImportPart.mock.calls;
    expect(first[1]).toBe(1);
    expect(await (first[2] as Blob).text()).toBe("abcd");
    expect(second[1]).toBe(2);
    expect(await (second[2] as Blob).text()).toBe("ef");
  });

  it("retries a part, and gives up after three tries", async () => {
    api.uploadImportPart
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(undefined);
    render(<DataImports inboxes={INBOXES} />);
    pickFile("abcdef");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(api.completeImport).toHaveBeenCalled());
    expect(api.uploadImportPart).toHaveBeenCalledTimes(3);

    api.uploadImportPart.mockReset();
    api.uploadImportPart.mockRejectedValue(new Error("network down"));
    api.completeImport.mockClear();
    pickFile("abcdef");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "network down",
    );
    expect(api.uploadImportPart).toHaveBeenCalledTimes(3);
    expect(api.completeImport).not.toHaveBeenCalled();
  });

  it("does not resend a part the server refused", async () => {
    api.uploadImportPart.mockRejectedValue(
      new ApiError("This import is not uploading", 400, "NOT_UPLOADING"),
    );
    render(<DataImports inboxes={INBOXES} />);
    pickFile("abcdef");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "This import is not uploading",
    );
    expect(api.uploadImportPart).toHaveBeenCalledTimes(1);
  });

  it("cancels an upload, deleting the import", async () => {
    let release: () => void = () => {};
    api.uploadImportPart.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    render(<DataImports inboxes={INBOXES} />);
    pickFile("abcdef");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel upload" }),
    );
    release();
    await waitFor(() => expect(api.deleteImport).toHaveBeenCalledWith("i1"));
    expect(api.uploadImportPart).toHaveBeenCalledTimes(1);
    expect(api.completeImport).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refuses an empty file", async () => {
    render(<DataImports inboxes={INBOXES} />);
    pickFile("");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "That file is empty.",
    );
    expect(api.startImport).not.toHaveBeenCalled();
  });

  it("lists imports with their progress, counts and notes", async () => {
    api.fetchImports.mockResolvedValue([
      importRow({ id: "i1", status: "running", bytesRead: 500_000 }),
      importRow({
        id: "i2",
        notes: [{ row: 3, reason: "not addressed to support@example.com: Hi" }],
      }),
      importRow({
        id: "i3",
        status: "failed",
        notes: [{ row: 7, reason: "stalled" }],
      }),
    ]);
    render(<DataImports inboxes={INBOXES} />);
    const rows = await screen.findAllByTestId("import-row");
    expect(rows[0].textContent).toContain(
      "Importing… 25% · 10 imported, 2 skipped",
    );
    expect(rows[1].textContent).toContain("10 imported, 2 skipped");
    expect(rows[1].textContent).toContain(
      "Message 3: not addressed to support@example.com: Hi",
    );
    expect(rows[2].textContent).toContain("Failed: stalled");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(api.deleteImport).toHaveBeenCalledWith("i1"));
  });

  it("refreshes when an import is done", async () => {
    render(<DataImports inboxes={INBOXES} />);
    await waitFor(() => expect(api.fetchImports).toHaveBeenCalledTimes(1));
    api.fetchImports.mockResolvedValue([importRow()]);
    act(() =>
      dispatchImportDone({ inbox: "support@example.com", jobId: "i1" }),
    );
    expect(await screen.findByTestId("import-row")).toBeTruthy();
  });
});
