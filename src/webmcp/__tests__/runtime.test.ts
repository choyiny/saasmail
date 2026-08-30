import { describe, it, expect, afterEach } from "vitest";
import { ok, okJson, fail } from "../result";
import { registerTool, __setModelContextForTests } from "../runtime";

afterEach(() => __setModelContextForTests(null));

describe("result helpers", () => {
  it("ok wraps text", () => {
    expect(ok("hi")).toEqual({ content: [{ type: "text", text: "hi" }] });
  });
  it("okJson stringifies", () => {
    expect(okJson({ a: 1 })).toEqual({
      content: [{ type: "text", text: JSON.stringify({ a: 1 }, null, 2) }],
    });
  });
  it("fail marks isError", () => {
    expect(fail("bad")).toEqual({
      content: [{ type: "text", text: "bad" }],
      isError: true,
    });
  });
});

describe("registerTool", () => {
  it("registers against the model context and returns an unregister fn", async () => {
    const registered: any[] = [];
    __setModelContextForTests({
      registerTool: (d: any) => registered.push(d),
    });
    const unregister = await registerTool({
      name: "t",
      description: "d",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ok("x"),
    });
    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe("t");
    expect(typeof unregister).toBe("function");
  });

  it("no-ops (returns a fn) when no model context is available", async () => {
    __setModelContextForTests(null);
    const unregister = await registerTool({
      name: "t",
      description: "d",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ok("x"),
    });
    expect(typeof unregister).toBe("function");
  });
});
