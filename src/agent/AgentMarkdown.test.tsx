import { describe, expect, it } from "vitest";
import { renderAgentMarkdown } from "@/agent/AgentMarkdown";

describe("agent markdown sanitizer", () => {
  it("strips images and unsafe elements", () => {
    const html = renderAgentMarkdown(
      'hello <img src="https://tracker.example/pixel"> <script>alert(1)</script>',
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("hello");
  });

  it("removes javascript links and hardens allowed links", () => {
    const unsafe = renderAgentMarkdown("[bad](javascript:alert(1))");
    expect(unsafe).not.toContain("javascript:");
    expect(unsafe).not.toContain("href=");

    const safe = renderAgentMarkdown("[good](https://example.com)");
    expect(safe).toContain('href="https://example.com"');
    expect(safe).toContain('target="_blank"');
    expect(safe).toContain('rel="noopener noreferrer"');
  });
});
