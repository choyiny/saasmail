// docs/specs/SPEC-spam-learning.md: the Inboxes page's learning-filter controls.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  setSpamFilter: vi.fn(),
  resetSpamFilter: vi.fn(),
}));
vi.mock("@/lib/api", () => api);

import SpamFilterControls from "@/components/SpamFilterControls";

function inbox(spamFilter: Record<string, unknown>) {
  return {
    email: "support@acme.com",
    displayName: null,
    displayMode: "chat",
    signatureHtml: null,
    forwardTo: null,
    spamThreshold: null,
    agentInstructions: null,
    agentAutodraft: false,
    assignedUserIds: [],
    spamFilter: {
      enabled: false,
      spamMessages: 0,
      hamMessages: 0,
      ready: false,
      ...spamFilter,
    },
  } as any;
}

function controls(filter: Record<string, unknown>, hasJunkRule = false) {
  const onChange = vi.fn();
  render(
    <MemoryRouter>
      <SpamFilterControls
        inbox={inbox(filter)}
        hasJunkRule={hasJunkRule}
        onChange={onChange}
      />
    </MemoryRouter>,
  );
  return onChange;
}

describe("SpamFilterControls", () => {
  beforeEach(() => vi.clearAllMocks());

  it("turns the filter on", async () => {
    api.setSpamFilter.mockResolvedValue({
      enabled: true,
      spamMessages: 0,
      hamMessages: 0,
      ready: false,
    });
    const onChange = controls({});
    expect(screen.getByTestId("spam-filter-status").textContent).toBe("Off");
    fireEvent.click(
      screen.getByRole("switch", {
        name: "Learn from junk marks for support@acme.com",
      }),
    );
    await waitFor(() =>
      expect(api.setSpamFilter).toHaveBeenCalledWith("support@acme.com", true),
    );
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true }),
      ),
    );
  });

  it("shows the training progress and links to the prefilled junk rule", () => {
    controls({ enabled: true, spamMessages: 12, hamMessages: 31 });
    expect(screen.getByTestId("spam-filter-status").textContent).toBe(
      "Learning — 12 of 20 junk, 31 of 20 not-junk examples",
    );
    expect(
      screen
        .getByRole("link", { name: "Create the junk rule" })
        .getAttribute("href"),
    ).toBe("/automations?prefill=junk&inbox=support%40acme.com");
  });

  it("says when it scores, and not to make a second junk rule", () => {
    controls(
      { enabled: true, spamMessages: 25, hamMessages: 40, ready: true },
      true,
    );
    expect(screen.getByTestId("spam-filter-status").textContent).toBe(
      "Scoring new mail",
    );
    expect(
      screen.queryByRole("link", { name: "Create the junk rule" }),
    ).toBeNull();
    expect(screen.getByText("Junk rule in place")).toBeTruthy();
  });

  it("shows Off for an inbox created in this session, with no status yet", () => {
    render(
      <MemoryRouter>
        <SpamFilterControls
          inbox={{ ...inbox({}), spamFilter: undefined }}
          hasJunkRule={false}
          onChange={() => {}}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("spam-filter-status").textContent).toBe("Off");
  });

  it("resets after a confirmation", async () => {
    api.resetSpamFilter.mockResolvedValue({
      enabled: true,
      spamMessages: 0,
      hamMessages: 0,
      ready: false,
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    controls({ enabled: true, spamMessages: 3, hamMessages: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() =>
      expect(api.resetSpamFilter).toHaveBeenCalledWith("support@acme.com"),
    );
    confirm.mockRestore();
  });
});
