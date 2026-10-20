import { describe, it, expect } from "vitest";
import { messagePreview, pushBody } from "../lib/push-preview";

describe("messagePreview", () => {
  it("flattens the text body to one line", () => {
    expect(messagePreview("Hi Jane,\n\n  Can we meet\ttomorrow?\n", null)).toBe(
      "Hi Jane, Can we meet tomorrow?",
    );
  });

  it("falls back to the HTML when there is no text part", () => {
    const html =
      "<html><head><style>p{color:red}</style></head><body>" +
      "<!-- tracking --><p>Hello&nbsp;there &amp; welcome</p><p>Line&#39;s two</p>" +
      "<script>alert(1)</script></body></html>";
    expect(messagePreview(null, html)).toBe("Hello there & welcome Line's two");
    expect(messagePreview("   ", html)).toBe(
      "Hello there & welcome Line's two",
    );
  });

  it("prefers the text part over the HTML", () => {
    expect(messagePreview("plain", "<p>html</p>")).toBe("plain");
  });

  it("cuts long bodies at a word boundary with an ellipsis", () => {
    const out = messagePreview("word ".repeat(100), null, 23);
    expect(out).toBe("word word word word…");
  });

  it("never splits an emoji", () => {
    expect(messagePreview("😀😀😀😀", null, 2)).toBe("😀😀…");
  });

  it("is empty when the message has no body", () => {
    expect(messagePreview(null, null)).toBe("");
  });
});

describe("pushBody", () => {
  it("puts the subject above the preview", () => {
    expect(pushBody("Lunch?", "Are you free at noon")).toBe(
      "Lunch?\nAre you free at noon",
    );
  });

  it("drops whichever part is missing", () => {
    expect(pushBody("", "Just the body")).toBe("Just the body");
    expect(pushBody("Just the subject", "")).toBe("Just the subject");
  });
});
