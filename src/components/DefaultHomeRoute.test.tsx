import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

vi.mock("@/pages/InboxPage", () => ({
  default: () => <div data-testid="customer-view">Customers</div>,
}));

import DefaultHomeRoute from "@/components/DefaultHomeRoute";
import { DEFAULT_VIEW_STORAGE_KEY } from "@/lib/default-view";

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

describe("DefaultHomeRoute", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("redirects exactly / to /mail when mailbox is the default", async () => {
    localStorage.setItem(DEFAULT_VIEW_STORAGE_KEY, "mailbox");
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<DefaultHomeRoute />} />
          <Route path="/mail" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/mail"),
    );
  });

  it("keeps the customer view as the default when unset", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<DefaultHomeRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("customer-view")).toBeTruthy();
  });

  it("does not redirect deep URLs", () => {
    localStorage.setItem(DEFAULT_VIEW_STORAGE_KEY, "mailbox");
    render(
      <MemoryRouter initialEntries={["/inbox/support/person-1"]}>
        <Routes>
          <Route path="/" element={<DefaultHomeRoute />} />
          <Route path="/inbox/:inbox/:personId" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("location").textContent).toBe(
      "/inbox/support/person-1",
    );
  });
});
