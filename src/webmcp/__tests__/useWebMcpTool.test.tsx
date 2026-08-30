import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { ok } from "../result";
import { __setModelContextForTests } from "../runtime";
import { useWebMcpTools } from "../useWebMcpTool";

afterEach(() => {
  cleanup();
  __setModelContextForTests(null);
});

function Harness() {
  useWebMcpTools([
    {
      name: "ping",
      description: "d",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ok("pong"),
    },
  ]);
  return null;
}

describe("useWebMcpTools", () => {
  it("registers on mount and aborts on unmount", async () => {
    const aborts: AbortSignal[] = [];
    __setModelContextForTests({
      registerTool: (_d, opts) => {
        if (opts?.signal) aborts.push(opts.signal);
      },
    });
    const { unmount } = render(<Harness />);
    // registration is async (awaits getModelContext); flush microtasks
    await Promise.resolve();
    await Promise.resolve();
    expect(aborts).toHaveLength(1);
    expect(aborts[0].aborted).toBe(false);
    unmount();
    expect(aborts[0].aborted).toBe(true);
  });
});
