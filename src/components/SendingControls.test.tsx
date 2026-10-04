// docs/archive/SPEC-send-controls.md: the admin banner, the composer notice and
// Settings → Sending.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchAdminSettings: vi.fn(),
  updateAdminSettings: vi.fn(),
  fetchOutboxCount: vi.fn(),
  fetchSendUsage: vi.fn(),
  replyToEmail: vi.fn(),
  sendEmail: vi.fn(),
  fetchDraft: vi.fn(),
  deleteDraft: vi.fn(),
}));
const branding = vi.hoisted(() => ({
  outboundPaused: false,
  refresh: vi.fn(),
}));
const session = vi.hoisted(() => ({ role: "admin" }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  ...api,
}));
vi.mock("@/lib/branding", () => ({
  useBranding: () => ({
    passkeyRequired: false,
    brandName: "saasmail",
    webmcpEnabled: false,
    loaded: true,
    ...branding,
  }),
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { role: session.role } } }),
}));

import SendingPausedBanner from "@/components/SendingPausedBanner";
import SendingPausedNotice from "@/components/SendingPausedNotice";
import SendingSettings from "@/components/SendingSettings";
import ChatQuickReply from "@/components/ChatQuickReply";

const SINCE = Math.floor(Date.now() / 1000) - 600;

function settings(overrides: Record<string, unknown> = {}) {
  return {
    brandName: "saasmail",
    outboundPaused: false,
    outboundPause: null,
    dailySendLimits: { web: null, api: null, mcp: 200, jmap: null },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  branding.outboundPaused = false;
  session.role = "admin";
  branding.refresh.mockResolvedValue(undefined);
  api.fetchAdminSettings.mockResolvedValue(settings());
  api.fetchOutboxCount.mockResolvedValue({
    pending: 0,
    held: 0,
    paused: false,
  });
  api.fetchSendUsage.mockResolvedValue({
    day: "2026-10-04",
    limits: { web: null, api: null, mcp: 200, jmap: null },
    usage: [],
  });
  api.fetchDraft.mockResolvedValue(null);
});

describe("the composer notice", () => {
  it("says nothing while sending runs", () => {
    render(<SendingPausedNotice />);
    expect(screen.queryByTestId("sending-paused-notice")).toBeNull();
  });

  it("tells everyone a message will be queued while paused", () => {
    branding.outboundPaused = true;
    session.role = "member";
    render(<SendingPausedNotice />);
    expect(screen.getByTestId("sending-paused-notice").textContent).toBe(
      "Sending is paused; your message will be queued.",
    );
  });

  it("shows in the chat quick reply", () => {
    branding.outboundPaused = true;
    render(
      <ChatQuickReply
        inboxAddress="support@example.com"
        latestReceivedEmailId="email-1"
        personEmail="alice@example.com"
        onSent={() => {}}
      />,
    );
    expect(screen.getByTestId("sending-paused-notice")).toBeTruthy();
  });
});

describe("the paused banner", () => {
  it("shows admins who paused, since when, and resumes", async () => {
    branding.outboundPaused = true;
    api.fetchAdminSettings.mockResolvedValue(
      settings({
        outboundPaused: true,
        outboundPause: { since: SINCE, byLabel: "jane@acme.com" },
      }),
    );
    api.updateAdminSettings.mockResolvedValue(settings());
    render(<SendingPausedBanner />);

    const banner = await screen.findByTestId("sending-paused-banner");
    await waitFor(() =>
      expect(banner.textContent).toContain("by jane@acme.com"),
    );
    expect(banner.textContent).toMatch(/^Outbound sending is paused since /);

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(api.updateAdminSettings).toHaveBeenCalledWith({
        outboundPaused: false,
      }),
    );
    await waitFor(() => expect(branding.refresh).toHaveBeenCalled());
  });

  it("is not shown to members, nor while sending runs", () => {
    branding.outboundPaused = true;
    session.role = "member";
    const { unmount } = render(<SendingPausedBanner />);
    expect(screen.queryByTestId("sending-paused-banner")).toBeNull();
    unmount();

    session.role = "admin";
    branding.outboundPaused = false;
    render(<SendingPausedBanner />);
    expect(screen.queryByTestId("sending-paused-banner")).toBeNull();
    expect(api.fetchAdminSettings).not.toHaveBeenCalled();
  });
});

describe("Settings → Sending", () => {
  it("shows the limits, blank for unlimited, and saves them", async () => {
    api.updateAdminSettings.mockImplementation(async (changes) =>
      settings({ dailySendLimits: changes.dailySendLimits }),
    );
    render(<SendingSettings />);

    const mcp = (await screen.findByLabelText(
      "MCP agents",
    )) as HTMLInputElement;
    const apiKeys = screen.getByLabelText("API keys") as HTMLInputElement;
    expect(mcp.value).toBe("200");
    expect(apiKeys.value).toBe("");
    expect(screen.getByTestId("sending-pause-status").textContent).toBe(
      "Sending is running.",
    );

    fireEvent.change(apiKeys, { target: { value: "50" } });
    fireEvent.change(mcp, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));

    await waitFor(() =>
      expect(api.updateAdminSettings).toHaveBeenCalledWith({
        dailySendLimits: { web: null, api: 50, mcp: null, jmap: null },
      }),
    );
    expect(await screen.findByTestId("sending-success")).toBeTruthy();
    expect(mcp.value).toBe("");
    expect(apiKeys.value).toBe("50");
  });

  it("refuses a limit that is not a whole number", async () => {
    render(<SendingSettings />);
    const web = await screen.findByLabelText("Web app");
    fireEvent.change(web, { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Web app: enter a whole number",
    );
    expect(api.updateAdminSettings).not.toHaveBeenCalled();
  });

  it("pauses, then shows who, when and how many are held", async () => {
    api.updateAdminSettings.mockResolvedValue(
      settings({
        outboundPaused: true,
        outboundPause: { since: SINCE, byLabel: "jane@acme.com" },
      }),
    );
    render(<SendingSettings />);
    await screen.findByText("Sending is running.");
    api.fetchOutboxCount.mockResolvedValue({
      pending: 2,
      held: 2,
      paused: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Pause sending" }));

    await waitFor(() =>
      expect(api.updateAdminSettings).toHaveBeenCalledWith({
        outboundPaused: true,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("sending-pause-status").textContent).toMatch(
        /^Paused since .+ by jane@acme\.com\. 2 messages held\.$/,
      ),
    );
    expect(branding.refresh).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Resume sending" })).toBeTruthy();
  });

  it("reloads when sending is paused or resumed elsewhere", async () => {
    branding.outboundPaused = true;
    api.fetchAdminSettings.mockResolvedValue(
      settings({
        outboundPaused: true,
        outboundPause: { since: SINCE, byLabel: "jane@acme.com" },
      }),
    );
    const { rerender } = render(<SendingSettings />);
    await screen.findByText(/^Paused since /);
    expect(api.fetchAdminSettings).toHaveBeenCalledTimes(1);

    // Resumed from the banner: the context flips, the card follows.
    branding.outboundPaused = false;
    api.fetchAdminSettings.mockResolvedValue(settings());
    rerender(<SendingSettings />);
    await screen.findByText("Sending is running.");
    expect(api.fetchAdminSettings).toHaveBeenCalledTimes(2);
  });

  it("lists today's counts against the limits", async () => {
    api.fetchSendUsage.mockResolvedValue({
      day: "2026-10-04",
      limits: { web: null, api: null, mcp: 200, jmap: null },
      usage: [
        { channel: "mcp", userId: "u1", email: "jane@acme.com", count: 12 },
      ],
    });
    render(<SendingSettings />);
    const cell = await screen.findByText("jane@acme.com");
    const row = cell.closest("tr")!;
    expect(row.textContent).toBe("jane@acme.comMCP agents12 / 200");
  });
});
