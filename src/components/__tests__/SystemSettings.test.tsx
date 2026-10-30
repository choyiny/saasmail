// docs/doctor.md: Settings → System (admins only).
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorReport } from "@/lib/api";

const api = vi.hoisted(() => ({ fetchDoctorReport: vi.fn() }));
const session = vi.hoisted(() => ({ role: "admin" as string }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  ...api,
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { role: session.role } } }),
}));
vi.mock("@/lib/branding", () => ({
  useBranding: () => ({ brandName: "saasmail", refresh: vi.fn() }),
}));
vi.mock("@/lib/push", () => ({
  isPushSupported: () => false,
  isPushSubscribed: async () => false,
  enablePush: vi.fn(),
  disablePush: vi.fn(),
}));
vi.mock("@/lib/default-layout-settings", () => ({
  useCommonSettings: () => [
    { undoSendSeconds: 0, hideSignatures: false },
    vi.fn(),
  ],
}));
vi.mock("@/components/AppearanceSettings", () => ({ default: () => null }));
vi.mock("@/components/SendingSettings", () => ({ default: () => null }));
vi.mock("@/components/DataExports", () => ({ default: () => null }));

import SystemSettings from "@/components/SystemSettings";
import SettingsPage from "@/pages/SettingsPage";

function report(): DoctorReport {
  return {
    build: {
      version: "0.10.0",
      commit: "0123456789abcdef0123456789abcdef01234567",
      commitShort: "0123456",
      commitTime: "2026-10-29T10:00:00Z",
      dirty: true,
      dirtyFiles: ["public/logo.svg"],
      dirtyCount: 1,
      builtAt: "2026-10-29T10:05:00.000Z",
    },
    checkedAt: 1_800_000_000,
    checks: [
      {
        id: "cron.last_tick",
        group: "cron",
        status: "pass",
        summary: "Cron ok",
      },
      {
        id: "backups.recent",
        group: "backups",
        status: "warn",
        summary: "Backups stale",
      },
      {
        id: "migrations.pending",
        group: "migrations",
        status: "fail",
        summary: "1 migration not applied",
        hint: "Run `npx wrangler d1 migrations apply DB --remote`.",
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  session.role = "admin";
  api.fetchDoctorReport.mockResolvedValue(report());
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
});

describe("SystemSettings", () => {
  it("shows the build stamp from the doctor report", async () => {
    render(<SystemSettings />);
    expect((await screen.findByTestId("system-commit")).textContent).toBe(
      "0123456",
    );
    screen.getByText("0.10.0");
    expect(screen.getByTestId("system-dirty").textContent).toBe(
      "Uncommitted changes (1)",
    );
    screen.getByText("public/logo.svg");
    expect(screen.queryByTestId("system-checks")).toBeNull();
  });

  it("Run checks lists the checks grouped, fail first, with hints", async () => {
    render(<SystemSettings />);
    await screen.findByTestId("system-commit");
    fireEvent.click(screen.getByRole("button", { name: "Run checks" }));
    const list = await screen.findByTestId("system-checks");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-status"))).toEqual([
      "fail",
      "warn",
      "pass",
    ]);
    within(list).getByText(/migrations apply DB/);
    expect(api.fetchDoctorReport).toHaveBeenCalledTimes(2);
  });
});

describe("SettingsPage", () => {
  function renderPage() {
    return render(
      <MemoryRouter initialEntries={["/settings"]}>
        <SettingsPage />
      </MemoryRouter>,
    );
  }

  it("shows the System section to an admin", async () => {
    const { container } = renderPage();
    await waitFor(() =>
      expect(container.querySelector("section#system")).not.toBeNull(),
    );
    expect(api.fetchDoctorReport).toHaveBeenCalled();
  });

  it("hides it from a member, who never calls the endpoint", async () => {
    session.role = "member";
    const { container } = renderPage();
    await screen.findByText("Settings");
    expect(container.querySelector("section#system")).toBeNull();
    expect(api.fetchDoctorReport).not.toHaveBeenCalled();
  });
});
