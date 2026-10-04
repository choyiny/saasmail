// docs/specs/SPEC-backups.md: Settings → Data → Backups (admins).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type BackupRun, type BackupsOverview } from "@/lib/api";

const api = vi.hoisted(() => ({
  fetchBackups: vi.fn(),
  updateBackupSettings: vi.fn(),
  startBackupNow: vi.fn(),
  fetchBackupManifest: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  ...api,
}));

import DataBackups from "@/components/DataBackups";

function run(overrides: Partial<BackupRun> = {}): BackupRun {
  return {
    id: "b1",
    status: "completed",
    startedAt: 1_790_000_000,
    finishedAt: 1_790_000_042,
    prefix: "backups/2026-09-21T1413Z-b1/",
    bytes: 3_400_000,
    tablesDone: 62,
    tablesTotal: 62,
    rows: 12_345,
    encrypted: false,
    error: null,
    manual: false,
    prunedAt: null,
    ...overrides,
  };
}

function overview(overrides: Partial<BackupsOverview> = {}): BackupsOverview {
  return {
    settings: {
      enabled: false,
      hourUtc: 3,
      keepDays: 14,
      lastStarted: null,
      nextDue: null,
    },
    destination: "R2",
    encryption: "not_configured",
    runs: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchBackups.mockResolvedValue(overview());
  api.updateBackupSettings.mockResolvedValue(overview().settings);
  api.startBackupNow.mockResolvedValue(run({ status: "running" }));
});

describe("DataBackups", () => {
  it("turns the schedule on and saves the hour and retention", async () => {
    render(<DataBackups />);
    expect((await screen.findByTestId("backup-schedule")).textContent).toBe(
      "Off.",
    );
    expect(
      screen.getByText(/The attachments bucket \(R2\), under backups/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Not configured: the files are plain/),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Turn on daily backups" }),
    );
    await waitFor(() =>
      expect(api.updateBackupSettings).toHaveBeenCalledWith({ enabled: true }),
    );

    fireEvent.change(screen.getByLabelText("Hour (UTC)"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByLabelText("Keep for (days)"), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.updateBackupSettings).toHaveBeenCalledWith({
        hourUtc: 5,
        keepDays: 30,
      }),
    );

    fireEvent.change(screen.getByLabelText("Hour (UTC)"), {
      target: { value: "24" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("0 to 23");
  });

  it("backs up now, and says when one is running", async () => {
    render(<DataBackups />);
    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }));
    await waitFor(() => expect(api.startBackupNow).toHaveBeenCalled());

    api.startBackupNow.mockRejectedValue(
      new ApiError("running", 409, "BACKUP_RUNNING"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "A backup is already running.",
    );
  });

  it("says when backups or a manifest cannot be loaded", async () => {
    api.fetchBackups.mockRejectedValueOnce(new Error("offline"));
    const { unmount } = render(<DataBackups />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Backups could not be loaded: offline",
    );
    unmount();

    api.fetchBackups.mockResolvedValue(overview({ runs: [run()] }));
    api.fetchBackupManifest.mockRejectedValue(new Error("gone"));
    render(<DataBackups />);
    const [row] = await screen.findAllByTestId("backup-row");
    const details = row.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(
      await screen.findByText("The manifest could not be loaded."),
    ).toBeTruthy();
  });

  it("lists runs and shows a manifest", async () => {
    api.fetchBackups.mockResolvedValue(
      overview({
        settings: {
          enabled: true,
          hourUtc: 3,
          keepDays: 14,
          lastStarted: 1_790_000_000,
          nextDue: 1_790_086_400,
        },
        destination: "BACKUPS",
        encryption: "configured",
        runs: [
          run({
            id: "b3",
            status: "running",
            tablesDone: 10,
            finishedAt: null,
          }),
          run({ id: "b2", status: "failed", error: "stalled" }),
          run({ id: "b1", manual: true }),
        ],
      }),
    );
    api.fetchBackupManifest.mockResolvedValue({
      lastMigration: "0083_backup_runs",
      encryption: null,
      tables: [
        { name: "people", file: "people.ndjson.gz", rows: 7, bytes: 512 },
      ],
    });
    render(<DataBackups />);
    const rows = await screen.findAllByTestId("backup-row");
    expect(rows[0].textContent).toContain("Backing up… 10 of 62 tables");
    expect(rows[1].textContent).toContain("Failed: stalled");
    expect(rows[2].textContent).toContain(
      "62 tables · 12345 rows · 3.2 MB · 42 s",
    );
    expect(rows[2].textContent).toContain("Back up now");
    expect(screen.getByText("The BACKUPS bucket")).toBeTruthy();
    expect(
      screen.getByText(/Encrypted with BACKUP_ENCRYPTION_KEY/),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Back up now" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    const details = rows[2].querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await waitFor(() =>
      expect(api.fetchBackupManifest).toHaveBeenCalledWith("b1"),
    );
    expect((await screen.findByText(/people: 7 rows/)).textContent).toContain(
      "512 B",
    );
  });
});
