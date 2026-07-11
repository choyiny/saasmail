import { describe, it, expect } from "vitest";
import {
  transientFromStatus,
  classifyErrorMessage,
} from "../lib/email-sender/classify";

describe("transientFromStatus", () => {
  it("marks 429 and 5xx transient", () => {
    expect(transientFromStatus(429)).toBe(true);
    expect(transientFromStatus(500)).toBe(true);
    expect(transientFromStatus(503)).toBe(true);
  });

  it("marks other 4xx permanent", () => {
    expect(transientFromStatus(400)).toBe(false);
    expect(transientFromStatus(403)).toBe(false);
    expect(transientFromStatus(422)).toBe(false);
  });
});

describe("classifyErrorMessage", () => {
  it("marks quota / rate / timeout / network errors transient", () => {
    expect(classifyErrorMessage("daily quota exceeded")).toBe(true);
    expect(classifyErrorMessage("rate limit exceeded")).toBe(true);
    expect(classifyErrorMessage("Too Many Requests")).toBe(true);
    expect(classifyErrorMessage("connection timed out")).toBe(true);
    expect(classifyErrorMessage("network error")).toBe(true);
    expect(classifyErrorMessage("upstream returned 503")).toBe(true);
  });

  it("marks clear hard rejects permanent", () => {
    expect(classifyErrorMessage("invalid recipient address")).toBe(false);
    expect(classifyErrorMessage("550 mailbox unavailable... rejected")).toBe(
      false,
    );
    expect(classifyErrorMessage("authentication failed")).toBe(false);
    expect(classifyErrorMessage("validation_error: missing to field")).toBe(
      false,
    );
  });

  it("defaults unknown errors to transient", () => {
    expect(classifyErrorMessage("something odd happened")).toBe(true);
  });

  it("prefers transient when both patterns match", () => {
    // "550" would be permanent, but the quota keyword wins.
    expect(classifyErrorMessage("550 over quota, retry later")).toBe(true);
  });

  it("marks Postmark inactive-recipient errors permanent", () => {
    expect(
      classifyErrorMessage(
        "You tried to send to a recipient that has been marked as inactive.",
      ),
    ).toBe(false);
    expect(classifyErrorMessage("sender signature not confirmed")).toBe(false);
  });

  it("transient keywords win over inactive in a combined message", () => {
    expect(
      classifyErrorMessage("recipient inactive, rate limit hit, try again"),
    ).toBe(true);
  });
});
