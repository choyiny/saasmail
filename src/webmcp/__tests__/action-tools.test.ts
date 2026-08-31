import { describe, it, expect, vi } from "vitest";
import { createActionTools } from "../tools/actions";

function makeDeps(overrides: any = {}) {
  const bridge = {
    navigate: vi.fn(),
    openCompose: vi.fn(),
  };
  return {
    bridge,
    // /api/people?personId=… returns per-(person,inbox) rows carrying a real
    // recipient inbox — unlike GET /api/people/:id, which has none.
    fetchPeople: vi.fn().mockResolvedValue({
      data: [{ id: "p1", email: "bob@ext.com", recipient: "team@x.com" }],
      total: 1,
    }),
    fetchEmail: vi.fn().mockResolvedValue({
      id: "e1",
      type: "received",
      recipient: "team@x.com",
      fromAddress: "bob@ext.com",
      personId: "p1",
      subject: "Hello",
    }),
    markEmailRead: vi.fn().mockResolvedValue(undefined),
    enrollPerson: vi
      .fn()
      .mockResolvedValue({ enrollment: {}, scheduledEmails: [] }),
    saveDraft: vi.fn().mockResolvedValue({ contextKey: "reply:e1" }),
    fetchTemplate: vi.fn().mockResolvedValue({
      slug: "welcome",
      bodyHtml: "<p>Hi {{name}}</p>",
      subject: "Hi",
    }),
    renderTemplate: vi.fn().mockReturnValue("<p>Hi Al</p>"),
    invalidate: vi.fn(),
    refreshInbox: vi.fn(),
    ...overrides,
  };
}
const t = (tools: any[], n: string) => tools.find((x) => x.name === n)!;
const sig = { signal: new AbortController().signal };

describe("action tools", () => {
  it("open_contact resolves the contact's inbox and navigates (URL-encoded)", async () => {
    const deps = makeDeps();
    const tools = createActionTools(deps as any);
    await t(tools, "open_contact").execute({ personId: "p1" }, sig);
    expect(deps.fetchPeople).toHaveBeenCalledWith(
      expect.objectContaining({ personId: "p1" }),
    );
    // recipient + personId are encoded — the "@" in the inbox must not sit raw
    // in the path segment.
    expect(deps.bridge.navigate).toHaveBeenCalledWith("/inbox/team%40x.com/p1");
  });

  it("open_contact fails cleanly when the contact has no visible inbox", async () => {
    const deps = makeDeps({
      fetchPeople: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    });
    const tools = createActionTools(deps as any);
    const res = await t(tools, "open_contact").execute(
      { personId: "ghost" },
      sig,
    );
    expect(deps.bridge.navigate).not.toHaveBeenCalled();
    expect(res.content[0].text.toLowerCase()).toContain("not found");
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

  it("reply_email saves a draft and switches to the Drafts filter without sending", async () => {
    const deps = makeDeps();
    const tools = createActionTools(deps as any);
    const res = await t(tools, "reply_email").execute(
      { emailId: "e1", bodyHtml: "<p>Thanks!</p>" },
      sig,
    );
    // Draft-only: it writes the reply draft...
    expect(deps.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        contextKey: "reply:e1",
        bodyHtml: "<p>Thanks!</p>",
        fromAddress: "team@x.com",
        replyToEmailId: "e1",
      }),
    );
    // ...then surfaces it in the inbox Drafts filter and refreshes. No send.
    expect(deps.bridge.navigate).toHaveBeenCalledWith("/?drafts=1");
    expect(deps.refreshInbox).toHaveBeenCalled();
    expect(res.content[0].text.toLowerCase()).toContain("draft");
  });

  it("reply_email refuses to reply to a non-received message", async () => {
    const deps = makeDeps({
      fetchEmail: vi.fn().mockResolvedValue({ id: "s1", type: "sent" }),
    });
    const tools = createActionTools(deps as any);
    const res = await t(tools, "reply_email").execute(
      { emailId: "s1", bodyHtml: "<p>nope</p>" },
      sig,
    );
    expect(deps.saveDraft).not.toHaveBeenCalled();
    expect(deps.bridge.navigate).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
  });

  it("enroll_in_sequence enrolls immediately, then shows the sequenced view", async () => {
    const deps = makeDeps();
    const tools = createActionTools(deps as any);
    const res = await t(tools, "enroll_in_sequence").execute(
      { personId: "p1", sequenceId: "seq1" },
      sig,
    );
    // Enrolls directly — no confirmation dialog. Defaults from to the
    // contact's inbox (recipient) when not given.
    expect(deps.enrollPerson).toHaveBeenCalledWith(
      "seq1",
      expect.objectContaining({ personId: "p1", fromAddress: "team@x.com" }),
    );
    expect(deps.bridge.navigate).toHaveBeenCalledWith("/?sequenced=1");
    expect(deps.refreshInbox).toHaveBeenCalled();
    expect(res.isError).toBeFalsy();
  });

  it("enroll_in_sequence fails without a sequenceId", async () => {
    const deps = makeDeps();
    const tools = createActionTools(deps as any);
    const res = await t(tools, "enroll_in_sequence").execute(
      { personId: "p1" },
      sig,
    );
    expect(deps.enrollPerson).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
  });
});
