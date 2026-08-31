import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { WebMcpBridgeProvider, useWebMcpBridge } from "../bridge";

afterEach(cleanup);

function Consumer({ onReady }: { onReady: (b: any) => void }) {
  const bridge = useWebMcpBridge();
  onReady(bridge);
  return <div>child</div>;
}

describe("WebMcpBridgeProvider", () => {
  it("renders children and exposes the bridge surface", () => {
    let bridge: any;
    render(
      <WebMcpBridgeProvider navigate={vi.fn()} openCompose={vi.fn()}>
        <Consumer onReady={(b) => (bridge = b)} />
      </WebMcpBridgeProvider>,
    );
    expect(screen.getByText("child")).toBeTruthy();
    // The bridge drives only the reused app surfaces — navigate, the compose
    // drawer, and the enroll modal. It renders no bespoke dialog of its own.
    expect(Object.keys(bridge).sort()).toEqual([
      "navigate",
      "openCompose",
      "openEnroll",
    ]);
  });

  it("throws when used outside the provider", () => {
    function Orphan() {
      useWebMcpBridge();
      return null;
    }
    // React logs the error; assert the hook guard fires.
    expect(() => render(<Orphan />)).toThrow(/WebMcpBridgeProvider/);
  });
});
