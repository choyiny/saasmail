import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrandingProvider, useBranding } from "@/lib/branding";

function Probe() {
  const { outboundPaused, loaded } = useBranding();
  return (
    <span data-testid="probe">
      {loaded ? (outboundPaused ? "paused" : "running") : "loading"}
    </span>
  );
}

function config(outboundPaused: boolean) {
  return new Response(
    JSON.stringify({
      passkeyRequired: false,
      brandName: "saasmail",
      webmcpEnabled: true,
      outboundPaused,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

describe("BrandingProvider and the sending pause", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("picks up a pause made elsewhere when the tab gets focus again", async () => {
    fetchMock.mockResolvedValueOnce(config(false));
    render(
      <BrandingProvider>
        <Probe />
      </BrandingProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe("running"),
    );

    // Too soon after the first read: no second request.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const later = Date.now() + 10_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    fetchMock.mockResolvedValueOnce(config(true));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe("paused"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
