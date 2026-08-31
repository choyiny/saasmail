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

  it("enriches the label from an async describe, updating the same card", async () => {
    const cap = capture();
    const rich = "Looking at the emails for Ada (ada@x.com)";
    const wrapped = withActivity({
      name: "list_emails",
      description: "",
      inputSchema: {},
      describe: async () => rich,
      execute: async () => ok("done"),
    });
    await wrapped.execute({ personId: "p1" }, sig);
    cap.stop();

    expect(cap.events.map((e) => e.phase)).toEqual([
      "running",
      "running",
      "success",
    ]);
    // One invocation id across all three events.
    expect(new Set(cap.events.map((e) => e.id)).size).toBe(1);
    // Generic first, then the enriched label wins on the update and the settle.
    expect(cap.events[0].label).toBe(labelForTool("list_emails"));
    expect(cap.events[1].label).toBe(rich);
    expect(cap.events[2].label).toBe(rich);
  });

  it("carries a group header from the first frame and fills the subject in", async () => {
    const cap = capture();
    const wrapped = withActivity({
      name: "list_emails",
      description: "",
      inputSchema: {},
      group: "Reading emails",
      subject: async () => "Ada (ada@x.com)",
      execute: async () => ok("done"),
    });
    await wrapped.execute({ personId: "p1" }, sig);
    cap.stop();

    expect(cap.events.map((e) => e.phase)).toEqual([
      "running",
      "running",
      "success",
    ]);
    // Grouped from the start; the per-call subject resolves on the update.
    expect(cap.events[0].group).toBe("Reading emails");
    expect(cap.events[0].subject).toBeUndefined();
    expect(cap.events[1].subject).toBe("Ada (ada@x.com)");
    expect(cap.events[2].group).toBe("Reading emails");
    expect(cap.events[2].subject).toBe("Ada (ada@x.com)");
  });

  it("falls back to the generic label when describe rejects", async () => {
    const cap = capture();
    const wrapped = withActivity({
      name: "list_emails",
      description: "",
      inputSchema: {},
      describe: async () => {
        throw new Error("no such person");
      },
      execute: async () => ok("done"),
    });
    await wrapped.execute({}, sig);
    cap.stop();

    expect(cap.events.map((e) => e.phase)).toEqual(["running", "success"]);
    expect(cap.events[1].label).toBe(labelForTool("list_emails"));
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
      tool("mark_read", async () => {
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
