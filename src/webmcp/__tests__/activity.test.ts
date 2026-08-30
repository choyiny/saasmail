import { describe, it, expect, vi, afterEach } from "vitest";
import {
  withActivity,
  labelForTool,
  WEBMCP_ACTIVITY_EVENT,
  type WebMcpActivity,
} from "../activity";
import { ok, fail } from "../result";
import type { WebMcpToolDescriptor } from "../types";

function capture() {
  const events: WebMcpActivity[] = [];
  const handler = (e: Event) =>
    events.push((e as CustomEvent<WebMcpActivity>).detail);
  window.addEventListener(WEBMCP_ACTIVITY_EVENT, handler as EventListener);
  return {
    events,
    stop: () =>
      window.removeEventListener(
        WEBMCP_ACTIVITY_EVENT,
        handler as EventListener,
      ),
  };
}

const sig = { signal: new AbortController().signal };

function tool(
  name: string,
  execute: WebMcpToolDescriptor["execute"],
): WebMcpToolDescriptor {
  return { name, description: "", inputSchema: {}, execute };
}

afterEach(() => vi.restoreAllMocks());

describe("withActivity", () => {
  it("emits running then success around a normal call, preserving the result", async () => {
    const cap = capture();
    const wrapped = withActivity(tool("list_emails", async () => ok("done")));
    const res = await wrapped.execute({}, sig);
    cap.stop();

    expect(res.content[0].text).toBe("done");
    expect(cap.events.map((e) => e.phase)).toEqual(["running", "success"]);
    // Same invocation id across the pair so the UI updates in place.
    expect(cap.events[0].id).toBe(cap.events[1].id);
    expect(cap.events[0].label).toBe(labelForTool("list_emails"));
  });

  it("reports an isError result as an error phase with the detail text", async () => {
    const cap = capture();
    const wrapped = withActivity(tool("read_email", async () => fail("Nope")));
    await wrapped.execute({}, sig);
    cap.stop();

    const settled = cap.events[1];
    expect(settled.phase).toBe("error");
    expect(settled.detail).toBe("Nope");
  });

  it("emits an error phase and rethrows when execute throws", async () => {
    const cap = capture();
    const wrapped = withActivity(
      tool("delete_email", async () => {
        throw new Error("boom");
      }),
    );
    await expect(wrapped.execute({}, sig)).rejects.toThrow("boom");
    cap.stop();

    expect(cap.events[1].phase).toBe("error");
    expect(cap.events[1].detail).toBe("boom");
  });

  it("falls back to a titleized label for unknown tools", () => {
    expect(labelForTool("some_new_tool")).toBe("Some new tool");
  });
});
