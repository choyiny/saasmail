import { describe, expect, it } from "vitest";
import {
  isAutomatedInbound,
  shouldEnqueueSuggestedReply,
} from "../email-handler";

const eligible = {
  agentAutodraft: 1,
  autoFiledSpam: false,
  modelConfigured: true,
  headers: {},
};

describe("suggested reply enqueue gates", () => {
  it("enqueues when every gate passes", () => {
    expect(shouldEnqueueSuggestedReply(eligible)).toBe(true);
  });

  it("does not enqueue when per-inbox autodraft is off", () => {
    expect(
      shouldEnqueueSuggestedReply({ ...eligible, agentAutodraft: 0 }),
    ).toBe(false);
  });

  it("does not enqueue auto-junked mail", () => {
    expect(
      shouldEnqueueSuggestedReply({ ...eligible, autoFiledSpam: true }),
    ).toBe(false);
  });

  it("does not enqueue when no model provider is configured", () => {
    expect(
      shouldEnqueueSuggestedReply({ ...eligible, modelConfigured: false }),
    ).toBe(false);
  });

  it.each([
    [{ "Auto-Submitted": "auto-generated" }],
    [{ "Auto-Submitted": "auto-replied" }],
    [{ Precedence: "bulk" }],
    [{ Precedence: "LIST" }],
    [{ Precedence: "junk" }],
    [{ "List-Id": "<newsletter.example.com>" }],
    [{ "List-Unsubscribe": "<mailto:leave@example.com>" }],
  ])("does not enqueue automated mail with headers %o", (headers) => {
    expect(isAutomatedInbound(headers)).toBe(true);
    expect(shouldEnqueueSuggestedReply({ ...eligible, headers })).toBe(false);
  });

  it("allows Auto-Submitted: no", () => {
    const headers = { "Auto-Submitted": "no" };
    expect(isAutomatedInbound(headers)).toBe(false);
    expect(shouldEnqueueSuggestedReply({ ...eligible, headers })).toBe(true);
  });
});
