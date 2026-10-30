import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DeliveryBadge from "@/components/mail/DeliveryBadge";

const api = vi.hoisted(() => ({
  fetchOutbox: vi.fn(),
  fetchScheduledSends: vi.fn(),
  cancelScheduledSend: vi.fn(),
  retryOutboxItem: vi.fn(),
  cancelOutboxItem: vi.fn(),
}));

vi.mock("@/lib/api", () => api);

import OutboxPage from "./OutboxPage";

const SEND_AT = Math.floor(Date.now() / 1000) + 3600;
const ITEM = {
  id: "sub-1",
  sentEmailId: "sent-1",
  fromAddress: "hello@saasmail.test",
  toAddress: "alice@example.com",
  subject: "Quarterly numbers",
  sendAt: SEND_AT,
};

describe("Outbox scheduled sends", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.fetchOutbox.mockResolvedValue({ items: [], nextCursor: null });
    api.fetchScheduledSends.mockResolvedValue({ items: [ITEM] });
  });

  it("lists a scheduled send and cancels it back to Drafts", async () => {
    api.cancelScheduledSend.mockResolvedValue({
      canceled: true,
      movedToDrafts: true,
      willMove: false,
    });
    render(<OutboxPage />);

    const section = await screen.findByTestId("outbox-scheduled");
    expect(section.textContent).toContain("Quarterly numbers");
    expect(section.textContent).toContain("Scheduled for");

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() =>
      expect(api.cancelScheduledSend).toHaveBeenCalledWith("sub-1"),
    );
    expect(
      await screen.findByText(/"Quarterly numbers" is back in Drafts/),
    ).toBeTruthy();
    expect(screen.queryByTestId("outbox-scheduled")).toBeNull();
  });

  it("shows why a cancel failed once the send has started", async () => {
    api.cancelScheduledSend.mockRejectedValue(
      new Error("The message is already being sent or was sent"),
    );
    render(<OutboxPage />);
    await screen.findByTestId("outbox-scheduled");
    api.fetchScheduledSends.mockResolvedValue({ items: [] });

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(
      await screen.findByText("The message is already being sent or was sent"),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByTestId("outbox-scheduled")).toBeNull(),
    );
  });
});

describe("DeliveryBadge", () => {
  it("marks scheduled and canceled sends only", () => {
    const { rerender, container } = render(
      <DeliveryBadge status="scheduled" sendAt={SEND_AT} />,
    );
    expect(screen.getByTestId("message-scheduled-badge").textContent).toMatch(
      /^Scheduled for /,
    );
    rerender(<DeliveryBadge status="canceled" sendAt={SEND_AT} />);
    expect(screen.getByTestId("message-canceled-badge").textContent).toBe(
      "Canceled",
    );
    rerender(<DeliveryBadge status="sent" sendAt={SEND_AT} />);
    expect(container.textContent).toBe("");
  });
});
