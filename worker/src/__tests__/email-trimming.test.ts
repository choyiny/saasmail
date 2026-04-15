import { describe, it, expect } from "vitest";
import { trimQuotedText, trimQuotedHtml } from "../lib/email-parser";

describe("trimQuotedText", () => {
  it("returns original text when no quotes are present", () => {
    const text = "Hello,\n\nHow are you?\n\nBest,\nAlice";
    expect(trimQuotedText(text)).toBe(text);
  });

  it("removes lines starting with >", () => {
    const text = "Thanks for the update.\n\n> Original message\n> Second line";
    expect(trimQuotedText(text)).toBe("Thanks for the update.");
  });

  it("removes 'On ... wrote:' header before quoted lines", () => {
    const text =
      "Sounds good!\n\nOn Mon, Jan 1, 2024 at 10:00 AM Alice <alice@example.com> wrote:\n> Hey there";
    expect(trimQuotedText(text)).toBe("Sounds good!");
  });

  it("removes '-- Original Message --' separator", () => {
    const text =
      "Got it, thanks.\n\n--- Original Message ---\nFrom: Alice\nSubject: Hello";
    expect(trimQuotedText(text)).toBe("Got it, thanks.");
  });

  it("removes Outlook-style separator", () => {
    const text =
      "Sure thing.\n\n________________________________________\nFrom: Bob";
    expect(trimQuotedText(text)).toBe("Sure thing.");
  });

  it("handles empty text", () => {
    expect(trimQuotedText("")).toBe("");
  });

  it("handles text that is entirely quoted", () => {
    const text = "> This is all quoted\n> Second line";
    expect(trimQuotedText(text)).toBe("");
  });
});

describe("trimQuotedHtml", () => {
  it("returns original HTML when no quotes are present", () => {
    const html = "<p>Hello world</p>";
    expect(trimQuotedHtml(html)).toBe(html);
  });

  it("removes Gmail quote div", () => {
    const html =
      '<p>Thanks!</p><div class="gmail_quote"><blockquote>Old content</blockquote></div>';
    expect(trimQuotedHtml(html)).toBe("<p>Thanks!</p>");
  });

  it("removes Mozilla cite prefix", () => {
    const html =
      '<p>Got it.</p><div class="moz-cite-prefix">On 2024-01-01 wrote:</div><blockquote>Quoted</blockquote>';
    expect(trimQuotedHtml(html)).toBe("<p>Got it.</p>");
  });

  it("handles empty HTML", () => {
    expect(trimQuotedHtml("")).toBe("");
  });

  it("preserves HTML with no quote markers", () => {
    const html = "<div><p>Just a normal email</p><br/><p>Second paragraph</p></div>";
    expect(trimQuotedHtml(html)).toBe(html);
  });
});
