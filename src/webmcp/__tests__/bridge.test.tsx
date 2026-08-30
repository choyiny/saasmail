import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { WebMcpBridgeProvider, useWebMcpBridge } from "../bridge";

afterEach(cleanup);

function Consumer({ onReady }: { onReady: (b: any) => void }) {
  const bridge = useWebMcpBridge();
  onReady(bridge);
  return null;
}

describe("WebMcpBridgeProvider review dialog", () => {
  it("stageForConfirmation shows a dialog and runs the action on confirm", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    let bridge: any;
    render(
      <WebMcpBridgeProvider navigate={vi.fn()} openCompose={vi.fn()}>
        <Consumer onReady={(b) => (bridge = b)} />
      </WebMcpBridgeProvider>,
    );
    bridge.stageForConfirmation({
      title: "Send reply",
      summary: "To bob@x.com",
      run,
    });
    expect(await screen.findByText("Send reply")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  it("cancel does not run the action", async () => {
    const run = vi.fn();
    let bridge: any;
    render(
      <WebMcpBridgeProvider navigate={vi.fn()} openCompose={vi.fn()}>
        <Consumer onReady={(b) => (bridge = b)} />
      </WebMcpBridgeProvider>,
    );
    bridge.stageForConfirmation({ title: "Delete email", summary: "e1", run });
    await screen.findByText("Delete email");
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(run).not.toHaveBeenCalled();
  });
});
