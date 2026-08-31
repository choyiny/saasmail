import { describe, it, expect, vi } from "vitest";
import { createReadTools } from "../tools/read";

function makeDeps(overrides: any = {}) {
  return {
    fetchGroupedPeople: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    fetchPerson: vi.fn().mockResolvedValue({ id: "p1", email: "a@x.com" }),
    fetchPersonEmails: vi.fn().mockResolvedValue({ data: [] }),
    fetchConversationEmails: vi.fn().mockResolvedValue({ emails: [] }),
    fetchEmail: vi.fn().mockResolvedValue({ id: "e1", subject: "Hi" }),
    fetchTemplates: vi.fn().mockResolvedValue([]),
    fetchTemplate: vi.fn().mockResolvedValue({ slug: "welcome" }),
    fetchSequences: vi.fn().mockResolvedValue([]),
    fetchStats: vi
      .fn()
      .mockResolvedValue({ recipients: ["a@x.com"], senderIdentities: [] }),
    searchEmails: vi
      .fn()
      .mockResolvedValue({ hits: [], hasMore: false, truncated: false }),
    getSession: vi
      .fn()
      .mockResolvedValue({ data: { user: { name: "Al", email: "a@x.com" } } }),
    ...overrides,
  };
}

function byName(tools: any[], name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe("read tools", () => {
  it("exposes the expected read tools", () => {
    const tools = createReadTools(makeDeps());
    for (const n of [
      "get_playbook",
      "whoami",
      "list_inboxes",
      "list_conversations",
      "list_contacts",
      "get_contact",
      "list_emails",
      "read_email",
      "search_emails",
      "list_templates",
      "get_template",
      "list_sequences",
    ]) {
      expect(byName(tools, n)).toBeTruthy();
    }
  });

  it("get_playbook returns the intro, or a specific workflow", async () => {
    const tools = createReadTools(makeDeps());
    const sig = { signal: new AbortController().signal };
    const intro = await byName(tools, "get_playbook").execute({}, sig);
    expect(intro.content[0].text).toContain("WORKFLOWS");
    const wf = await byName(tools, "get_playbook").execute(
      { workflow: "reply_unread" },
      sig,
    );
    expect(wf.content[0].text.toLowerCase()).toContain("draft");
    const bad = await byName(tools, "get_playbook").execute(
      { workflow: "nope" },
      sig,
    );
    expect(bad.isError).toBe(true);
  });

  it("search_emails calls the api and returns JSON", async () => {
    const deps = makeDeps({
      searchEmails: vi.fn().mockResolvedValue({
        hits: [{ id: "e1", subject: "Invoice" }],
        hasMore: false,
        truncated: false,
      }),
    });
    const tools = createReadTools(deps);
    const res = await byName(tools, "search_emails").execute(
      { q: "invoice" },
      { signal: new AbortController().signal },
    );
    expect(deps.searchEmails).toHaveBeenCalledWith(
      expect.objectContaining({ q: "invoice" }),
    );
    expect(res.content[0].text).toContain("Invoice");
  });

  it("list_emails requires personId or conversationId", async () => {
    const tools = createReadTools(makeDeps());
    const res = await byName(tools, "list_emails").execute(
      {},
      { signal: new AbortController().signal },
    );
    expect(res.isError).toBe(true);
  });

  it("get_contact reads one person", async () => {
    const deps = makeDeps();
    const tools = createReadTools(deps);
    await byName(tools, "get_contact").execute(
      { personId: "p1" },
      { signal: new AbortController().signal },
    );
    expect(deps.fetchPerson).toHaveBeenCalledWith("p1");
  });
});
