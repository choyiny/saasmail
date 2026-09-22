import { describe, expect, it, vi } from "vitest";
import { createActionTools } from "../tools/actions";
import { createReadTools } from "../tools/read";

const signal = { signal: new AbortController().signal };

function byName(tools: any[], name: string) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

describe("WebMCP message state tools", () => {
  it("list_messages delegates to the message API", async () => {
    const fetchMessages = vi.fn().mockResolvedValue({
      messages: [{ ref: "received:e1" }],
      nextCursor: null,
    });
    const tools = createReadTools({ fetchMessages } as any);
    const result = await byName(tools, "list_messages").execute(
      { folder: "inbox", limit: 25 },
      signal,
    );
    expect(fetchMessages).toHaveBeenCalledWith({
      folder: "inbox",
      limit: 25,
    });
    expect(result.content[0].text).toContain("received:e1");
  });

  it("set_message_state excludes trash and delegates allowed state", async () => {
    const setMessageState = vi.fn().mockResolvedValue({ success: true });
    const invalidate = vi.fn();
    const tools = createActionTools({ setMessageState, invalidate } as any);
    const tool = byName(tools, "set_message_state");
    expect(tool.inputSchema.properties.trashed).toBeUndefined();

    const result = await tool.execute(
      {
        refs: ["received:e1"],
        seen: true,
        starred: true,
        archived: false,
        spam: false,
      },
      signal,
    );
    expect(setMessageState).toHaveBeenCalledWith({
      refs: ["received:e1"],
      seen: true,
      starred: true,
      archived: false,
      spam: false,
    });
    expect(invalidate).toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
  });
});
