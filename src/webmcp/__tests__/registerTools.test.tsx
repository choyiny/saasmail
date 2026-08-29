import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { __setModelContextForTests } from "../runtime";
import { WebMcpBridgeProvider } from "../bridge";
import { WebMcpTools, WEBMCP_TOOL_COUNT } from "../registerTools";

afterEach(() => {
  cleanup();
  __setModelContextForTests(null);
});

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient();
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <WebMcpBridgeProvider navigate={() => {}} openCompose={() => {}}>
          {ui}
        </WebMcpBridgeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("WebMcpTools", () => {
  it("registers exactly WEBMCP_TOOL_COUNT tools when enabled and a model context exists", async () => {
    const names: string[] = [];
    __setModelContextForTests({ registerTool: (d: any) => names.push(d.name) });
    render(wrap(<WebMcpTools enabled={true} />));
    await new Promise((r) => setTimeout(r, 0));
    expect(names).toContain("search_emails");
    expect(names).toContain("compose_email");
    expect(names.length).toBe(WEBMCP_TOOL_COUNT);
    // No duplicate tool names.
    expect(new Set(names).size).toBe(names.length);
  });

  it("registers nothing when disabled", async () => {
    const names: string[] = [];
    __setModelContextForTests({ registerTool: (d: any) => names.push(d.name) });
    render(wrap(<WebMcpTools enabled={false} />));
    await new Promise((r) => setTimeout(r, 0));
    expect(names).toHaveLength(0);
  });
});
