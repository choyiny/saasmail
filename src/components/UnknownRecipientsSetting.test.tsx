import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchAdminSettings: vi.fn(),
  fetchUnknownRecipients: vi.fn(),
  updateAdminSettings: vi.fn(),
}));

vi.mock("@/lib/api", () => api);

import UnknownRecipientsSetting from "@/components/UnknownRecipientsSetting";

describe("UnknownRecipientsSetting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchAdminSettings.mockResolvedValue({
      rejectUnknownRecipients: false,
    });
    api.updateAdminSettings.mockResolvedValue({
      rejectUnknownRecipients: true,
    });
    api.fetchUnknownRecipients.mockResolvedValue({ addresses: [] });
  });

  it("shows the catch-all default and turns rejection on", async () => {
    render(<UnknownRecipientsSetting />);
    const box = (await screen.findByRole("checkbox", {
      name: /Reject mail to addresses that aren't inboxes/,
    })) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.checked).toBe(false);
    expect(screen.getByText(/stored \(catch-all\)/)).toBeTruthy();

    fireEvent.click(box);
    await waitFor(() =>
      expect(api.updateAdminSettings).toHaveBeenCalledWith({
        rejectUnknownRecipients: true,
      }),
    );
    await waitFor(() => expect(box.checked).toBe(true));
  });

  it("lists the addresses that would start bouncing and waits for a yes", async () => {
    api.fetchUnknownRecipients.mockResolvedValue({
      addresses: [
        { address: "sales@acme.com", count: 12, lastReceivedAt: 1 },
        { address: "typo@acme.com", count: 1, lastReceivedAt: 1 },
      ],
    });
    render(<UnknownRecipientsSetting />);
    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));

    fireEvent.click(box);
    const list = await screen.findByTestId("unknown-recipients-list");
    expect(list.textContent).toBe(
      "sales@acme.com (12 messages)typo@acme.com (1 message)",
    );
    expect(api.updateAdminSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("unknown-recipients-list")).toBeNull();
    expect(box.checked).toBe(false);

    fireEvent.click(box);
    fireEvent.click(
      await screen.findByRole("button", { name: "Turn on anyway" }),
    );
    await waitFor(() =>
      expect(api.updateAdminSettings).toHaveBeenCalledWith({
        rejectUnknownRecipients: true,
      }),
    );
  });
});
