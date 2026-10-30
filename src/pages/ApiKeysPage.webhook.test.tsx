// docs/webhooks.md: the event checkboxes, the pause banner and Re-enable.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchApiKeyInfo: vi.fn(),
  fetchWebhookConfig: vi.fn(),
  fetchWebhookDeliveries: vi.fn(),
  saveWebhookConfig: vi.fn(),
  enableWebhook: vi.fn(),
  testWebhook: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  ...api,
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { role: "admin" } } }),
}));

import ApiKeysPage from "@/pages/ApiKeysPage";

function config(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://hook.example.com",
    hasSecret: true,
    events: ["message.received", "message.sent"],
    disabledAt: null,
    disabledReason: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchApiKeyInfo.mockResolvedValue({ key: null });
  api.fetchWebhookDeliveries.mockResolvedValue({
    deliveries: [
      {
        id: "wd_1",
        event: "message.sent",
        messageId: "se-1",
        status: "failed",
        attempts: 4,
        lastStatus: 503,
        lastError: null,
        createdAt: 1_800_000_000,
        finishedAt: 1_800_002_000,
      },
    ],
  });
});

describe("WebhookSection", () => {
  it("shows the pause banner, and Re-enable clears it", async () => {
    api.fetchWebhookConfig.mockResolvedValue(
      config({
        disabledAt: 1_800_000_000,
        disabledReason: "20 deliveries in a row failed (last: HTTP 503)",
      }),
    );
    api.enableWebhook.mockResolvedValue(config());
    render(<ApiKeysPage />);

    const banner = await screen.findByTestId("webhook-paused-banner");
    expect(banner.textContent).toContain(
      "Delivery events paused after 20 failed deliveries",
    );
    expect(banner.textContent).toContain("HTTP 503");

    fireEvent.click(screen.getByRole("button", { name: "Re-enable" }));
    await waitFor(() =>
      expect(screen.queryByTestId("webhook-paused-banner")).toBeNull(),
    );
    expect(api.enableWebhook).toHaveBeenCalledOnce();
    expect(screen.getByText("Delivery events re-enabled.")).toBeTruthy();
  });

  it("saves the ticked events and lists recent deliveries", async () => {
    api.fetchWebhookConfig.mockResolvedValue(config());
    api.saveWebhookConfig.mockImplementation(async (body) => config(body));
    render(<ApiKeysPage />);

    const bounced = await screen.findByRole("checkbox", {
      name: /message\.bounced/,
    });
    await waitFor(() =>
      expect(
        (
          screen.getByRole("checkbox", {
            name: /message\.sent/,
          }) as HTMLInputElement
        ).checked,
      ).toBe(true),
    );
    expect((bounced as HTMLInputElement).checked).toBe(false);
    fireEvent.click(bounced);
    fireEvent.click(
      screen.getByRole("checkbox", { name: /message\.received/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.saveWebhookConfig).toHaveBeenCalledOnce());
    expect(api.saveWebhookConfig.mock.calls[0][0]).toEqual({
      url: "https://hook.example.com",
      events: ["message.sent", "message.bounced"],
    });

    const table = await screen.findByTestId("webhook-deliveries");
    expect(table.textContent).toContain("message.sent");
    expect(table.textContent).toContain("HTTP 503");
  });
});
