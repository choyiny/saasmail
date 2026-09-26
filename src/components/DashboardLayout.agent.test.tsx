import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import DashboardLayout from "@/components/DashboardLayout";

vi.mock("@/hooks/useReducedAnimations", () => ({
  useReducedAnimations: () => true,
}));

vi.mock("@/components/TopNav", () => ({
  default: ({
    agentOpen,
    onAgentToggle,
  }: {
    agentOpen: boolean;
    onAgentToggle: () => void;
  }) => (
    <button
      type="button"
      aria-label="Toggle mail agent"
      aria-pressed={agentOpen}
      onClick={onAgentToggle}
    >
      Agent
    </button>
  ),
}));
vi.mock("@/components/Breadcrumbs", () => ({ default: () => null }));
vi.mock("@/components/Footer", () => ({ default: () => null }));
vi.mock("@/components/ComposeFab", () => ({ default: () => null }));
vi.mock("@/pages/ComposeModal", () => ({ default: () => null }));
vi.mock("@/components/Toaster", () => ({ default: () => null }));
vi.mock("@/webmcp/registerTools", () => ({
  WebMcpTools: () => null,
}));
vi.mock("@/lib/branding", () => ({
  useBranding: () => ({ webmcpEnabled: false }),
}));
vi.mock("@/components/AgentPanel", () => ({
  default: ({ onClose }: { onClose: () => void; onOpenCompose: unknown }) => (
    <aside data-testid="agent-panel">
      <textarea aria-label="Message the mail agent" />
      <button onClick={onClose}>Close</button>
    </aside>
  ),
}));

function Page() {
  return <Outlet />;
}

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={["/mail"]}>
      <Routes>
        <Route element={<DashboardLayout />}>
          <Route path="/mail" element={<Page />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("DashboardLayout agent panel", () => {
  it("toggles from TopNav and persists open state", () => {
    renderLayout();

    expect(screen.queryByTestId("agent-panel")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Toggle mail agent" }));
    expect(screen.getByTestId("agent-panel")).toBeTruthy();
    expect(window.localStorage.getItem("saasmail.agentPanelOpen")).toBe("true");

    fireEvent.click(screen.getByText("Close"));
    expect(screen.queryByTestId("agent-panel")).toBeNull();
  });

  it("toggles with Mod+J, prevents default, and ignores IME composition", () => {
    renderLayout();

    const event = new KeyboardEvent("keydown", {
      key: "j",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(window, event);
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByTestId("agent-panel")).toBeTruthy();

    const composing = new KeyboardEvent("keydown", {
      key: "j",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(composing, "isComposing", { value: true });
    fireEvent(window, composing);
    expect(screen.getByTestId("agent-panel")).toBeTruthy();
  });
});
