import { describe, expect, it } from "vitest";
import { transformAiResumeSource } from "./patch-ai-resume.mjs";

const FIXTURE = `
  async makeRequest({ trigger }) {
    const abortController = new AbortController();
    const activeResumeRequest = trigger === "resume-stream" ? { abortController } : void 0;
    const response = {
      state: createStreamingUIMessageState({
        lastMessage: trigger === "resume-stream" || trigger === "regenerate-message" ? void 0 : this.state.snapshot(lastMessage),
        messageId: this.generateId()
      })
    };
  }
`;

describe("patch-ai-resume", () => {
  it("applies the scoped continuation seed exactly once", () => {
    const patched = transformAiResumeSource(FIXTURE);

    expect(patched).toContain(
      'const seedToolContinuation = trigger === "resume-stream" && this.transport?._expectToolContinuation === true;',
    );
    expect(patched).toContain(
      'lastMessage: trigger === "regenerate-message" || (trigger === "resume-stream" && !seedToolContinuation) ? void 0 : this.state.snapshot(lastMessage),',
    );
    expect(transformAiResumeSource(patched)).toBe(patched);
  });

  it("throws when the resume anchor is missing", () => {
    expect(() =>
      transformAiResumeSource(
        FIXTURE.replace(
          'const activeResumeRequest = trigger === "resume-stream"',
          'const activeResumeRequest = trigger === "other"',
        ),
      ),
    ).toThrow(/exactly one AI SDK resume anchor/);
  });

  it("throws when the last-message anchor is missing", () => {
    expect(() =>
      transformAiResumeSource(
        FIXTURE.replace(
          'lastMessage: trigger === "resume-stream" || trigger === "regenerate-message" ? void 0 : this.state.snapshot(lastMessage),',
          "lastMessage: undefined,",
        ),
      ),
    ).toThrow(/anchors are inconsistent/);
  });
});
