import { describe, it, expect, vi } from "vitest";
import { createActionTools } from "../tools/actions";

function makeDeps(overrides: any = {}) {
  const bridge = {
    navigate: vi.fn(),
    openCompose: vi.fn(),
    openEnroll: vi.fn(),
    stageForConfirmation: vi.fn(),
  };
  return {
    bridge,
    fetchPerson: vi
      .fn()
      .mockResolvedValue({ id: "p1", recipient: "team@x.com" }),
    fetchEmail: vi.fn().mockResolvedValue({
      id: "e1",
      type: "received",
      recipient: "team@x.com",
      fromAddress: "bob@ext.com",
      subject: "Hello",
    }),
    markEmailRead: vi.fn().mockResolvedValue(undefined),
    deleteEmail: vi
      .fn()
      .mockResolvedValue({ success: true, attachmentsDeleted: 0 }),
    replyToEmail: vi.fn().mockResolvedValue({ id: "r1", status: "sent" }),
    fetchTemplate: vi.fn().mockResolvedValue({
      slug: "welcome",
      bodyHtml: "<p>Hi {{name}}</p>",
      subject: "Hi",
    }),
    renderTemplate: vi.fn().mockReturnValue("<p>Hi Al</p>"),
    invalidate: vi.fn(),
    ...overrides,
  };
}
const t = (tools: any[], n: string) => tools.find((x) => x.name === n)!;
const sig = { signal: new AbortController().signal };

describe("action tools", () => {
  it("open_contact navigates to the person's inbox thread", async () => {
    const deps = makeDeps();
    const tools = createActionTools(deps as any);
    await t(tools, "open_contact").execute({ personId: "p1" }, sig);
    expect(deps.bridge.navigate).toHaveBeenCalledWith("/inbox/team@x.com/p1");
  });

  it("compose_email opens the compose drawer pre-filled (no send)", async () => {
    const deps = makeDeps();
    const tools = createActionTools(deps as any);
    const res = await t(tools, "compose_email").execute(
      {
        to: "bob@ext.com",
        subject: "Hi",
        bodyHtml: "<p>yo</p>",
        from: "team@x.com",
      },
      sig,
    );
    expect(deps.bridge.openCompose).toHaveBeenCalledWith(
      expect.objectContaining({ to: "bob@ext.com", subject: "Hi" }),
    );
    expect(res.content[0].text.toLowerCase()).toContain("review");
  });

  it("mark_read calls the api immediately and invalidates", async () => {
    const deps = makeDeps();
    const tools = createActionTools(deps as any);
    await t(tools, "mark_read").execute({ emailId: "e1" }, sig);
    expect(deps.markEmailRead).toHaveBeenCalledWith("e1", true);
    expect(deps.invalidate).toHaveBeenCalled();
  });

  it("delete_email stages a confirmation instead of deleting", async () => {
    const deps = makeDeps();
    const tools = createActionTools(deps as any);
    await t(tools, "delete_email").execute({ emailId: "e1" }, sig);
    expect(deps.bridge.stageForConfirmation).toHaveBeenCalledTimes(1);
    expect(deps.deleteEmail).not.toHaveBeenCalled();
    // running the staged action performs the delete
    const staged = deps.bridge.stageForConfirmation.mock.calls[0][0];
    await staged.run();
    expect(deps.deleteEmail).toHaveBeenCalledWith("e1");
  });

  it("reply_email stages a confirmation that calls replyToEmail on confirm", async () => {
    const deps = makeDeps();
    const tools = createActionTools(deps as any);
    await t(tools, "reply_email").execute(
      { emailId: "e1", bodyHtml: "<p>Thanks!</p>" },
      sig,
    );
    const staged = deps.bridge.stageForConfirmation.mock.calls[0][0];
    await staged.run();
    expect(deps.replyToEmail).toHaveBeenCalledWith(
      "e1",
      expect.objectContaining({
        bodyHtml: "<p>Thanks!</p>",
        fromAddress: "team@x.com",
      }),
    );
  });

  it("enroll_in_sequence opens the enroll modal for the contact", async () => {
    const deps = makeDeps();
    const tools = createActionTools(deps as any);
    await t(tools, "enroll_in_sequence").execute({ personId: "p1" }, sig);
    expect(deps.bridge.openEnroll).toHaveBeenCalledWith("p1");
  });
});
