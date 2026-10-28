import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import DashboardLayout from "@/components/DashboardLayout";

// Each layout's shell renders the shared toggle in its global actions; the
// stand-in shell here renders just that and the page.
vi.mock("@/components/shell/PortalShell", async () => {
  const { AgentToggleButton } = await import("@/agent/AgentPanelToggle");
  return {
    default: ({ children }: { children: React.ReactNode }) => (
      <div>
        <AgentToggleButton>Agent</AgentToggleButton>
        {children}
      </div>
    ),
  };
});
vi.mock("@/lib/preferences", () => ({ useUiTheme: () => "default" }));
vi.mock("@/components/SendingPausedBanner", () => ({ default: () => null }));
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
  it("toggles from the shell's agent button and persists open state", () => {
    renderLayout();

    expect(screen.queryByTestId("agent-panel")).toBeNull();
    const toggle = screen.getByRole("button", { name: /Toggle mail agent/ });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByTestId("agent-panel")).toBeTruthy();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
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
