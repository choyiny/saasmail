import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import MessageBubble from "@/components/MessageBubble";
import type { DeliveryProblem, Email } from "@/lib/api";

const BOUNCE: DeliveryProblem = {
  kind: "bounced",
  bounceType: "hard",
  recipient: "dead@example.net",
  smtpStatus: "550 5.1.1",
  detail: "550 5.1.1 User unknown",
  occurredAt: 1_780_000_000,
};

function sent(deliveryProblems?: DeliveryProblem[]): Email {
  return {
    id: "se-1",
    type: "sent",
    personId: "p-1",
    recipient: null,
    fromAddress: "support@example.com",
    toAddress: "dead@example.net",
    subject: "Hello",
    bodyHtml: null,
    bodyText: "Hello",
    isRead: null,
    cc: [{ email: "fine@example.com", name: null }],
    timestamp: 1_780_000_000,
    status: "sent",
    deliveryProblems,
  };
}

function renderBubble(email: Email) {
  return render(
    <MessageBubble
      email={email}
      personEmail="dead@example.net"
      onOpenHtml={() => {}}
      onMarkRead={() => {}}
      onReply={() => {}}
      onDelete={() => {}}
    />,
  );
}

describe("DeliveryProblemBadge on MessageBubble", () => {
  it("shows a bounce for one of two recipients, with the details", () => {
    renderBubble(sent([BOUNCE]));
    const badge = screen.getByTestId("message-delivery-problem-badge");
    expect(badge.textContent).toContain("Bounced for 1 of 2");
    expect(badge.getAttribute("title")).toBe(
      "dead@example.net: hard bounce · 550 5.1.1 · 550 5.1.1 User unknown",
    );
  });

  it("renders nothing without problems", () => {
    renderBubble(sent([]));
    expect(screen.queryByTestId("message-delivery-problem-badge")).toBeNull();
    renderBubble(sent(undefined));
    expect(screen.queryByTestId("message-delivery-problem-badge")).toBeNull();
  });
});
