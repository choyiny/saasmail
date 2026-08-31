import type { WebMcpToolDescriptor } from "../types";
import { ok, okJson, fail } from "../result";

const PLAYBOOK_INTRO = `You are operating saasmail — a shared customer inbox — through its in-page WebMCP tools, as the signed-in user, in their browser.

MANDATORY FIRST ACTION: before running ANY other tool for a task, call visualize_plan with every step you intend to take, each { label, status: "pending" }. Do not read, reply, or enroll until the plan is on screen — inference is slow, and the plan (on the "Agent Plan" tab) is how the user follows along. This is required, not optional.

HOW TO WORK
1. Pick a workflow below (or ask the user which).
2. Call visualize_plan FIRST (see above) with all the steps as "pending".
3. As you go, call visualize_plan again with the SAME steps, flipping each to "active" when you start it and "done" (or "error") when it finishes. Call it as often as you like — it just replaces the plan.
4. WebMCP never sends or deletes on its own. Replies become drafts the user sends; enrollment is the only direct write.

WORKFLOWS (call get_playbook again with { workflow: "<name>" } for detail)
- summarize_unread — Summarize all unread email.
- reply_unread — Draft replies to unread email.
- enroll_by_criteria — Enroll contacts matching a criterion into a sequence.`;

const PLAYBOOKS: Record<string, string> = {
  summarize_unread: `SUMMARIZE ALL UNREAD EMAIL

STEP 0 (required, do this before anything else): call visualize_plan with a "Find unread" step plus one "Summarize unread from <name>" step per contact you expect, all status "pending", then a final "Write summary" step. You may not know the contacts yet — start with { title: "Summarize unread", steps: [{ label: "Find unread mail", status: "active" }] } and expand the plan after step 1.
1. list_conversations({ unread: true }) — the contacts/threads that have unread mail. Now flesh out the plan (one step per person) via visualize_plan.
2. For each returned person: mark that step "active" (the Agent Plan tab surfaces the current recipient), list_emails({ personId }) and keep messages where isRead is false; read_email({ emailId }) for full bodies; then mark the step "done". Work through them all — don't stop at a handful.
3. Write the summary and deliver it via the final visualize_plan call's \`result\` field, so it renders on the Agent Plan tab. Mark "Write summary" done.`,
  reply_unread: `DRAFT REPLIES TO UNREAD EMAIL

STEP 0 (required, do this before anything else): call visualize_plan with a "Find unread" step (status "active") plus, once known, one "Draft reply to <name>" step per contact, all "pending".
1. list_conversations({ unread: true }) to find who has unread mail; expand the plan with a step per contact via visualize_plan.
2. For each: mark its step "active", list_emails({ personId }) for the unread message(s), read_email for context.
3. reply_email({ emailId, bodyHtml }) to draft a reply, then mark the step "done". This does NOT send — it saves a draft and opens the Drafts view for the user to review and send. Never claim a reply was sent — the user sends it.`,
  enroll_by_criteria: `ENROLL CONTACTS INTO A SEQUENCE BY CRITERIA

STEP 0 (required, do this before anything else): call visualize_plan with "Find sequence", "Find matching contacts", then one "Enroll <name>" step per match — start with the first two "pending"/"active" and add the enroll steps once you know the matches.
1. list_sequences() to find the target sequence and its id.
2. list_contacts({ q }) / list_conversations() to find contacts matching the user's criterion (e.g. a domain, unread, recent); expand the plan with one enroll step per match.
3. For each match: mark its step "active", enroll_in_sequence({ personId, sequenceId }) — enrolls immediately (no confirmation) and schedules the drip; the contact lands in the Sequenced view — then mark "done".`,
};

export interface ReadDeps {
  fetchGroupedPeople: (p?: any) => Promise<any>;
  fetchPerson: (id: string) => Promise<any>;
  fetchPersonEmails: (personId: string, p?: any) => Promise<any>;
  fetchConversationEmails: (conversationId: string) => Promise<any>;
  fetchEmail: (id: string) => Promise<any>;
  fetchTemplates: () => Promise<any>;
  fetchTemplate: (slug: string) => Promise<any>;
  fetchSequences: () => Promise<any>;
  fetchStats: (recipient?: string) => Promise<any>;
  searchEmails: (p: { q: string; [k: string]: any }) => Promise<any>;
  getSession: () => Promise<any>;
}

export function createReadTools(deps: ReadDeps): WebMcpToolDescriptor[] {
  // Resolve a contact into a human label like "Ada Lovelace (ada@x.com)" for
  // the activity popup. Throws on failure so the caller falls back to the
  // generic tool label.
  const personLabel = async (personId: string): Promise<string> => {
    const p = await deps.fetchPerson(personId);
    return p?.name ? `${p.name} (${p.email})` : p.email;
  };

  return [
    {
      name: "get_playbook",
      description:
        "READ THIS FIRST, before any other tool. Returns how to operate saasmail plus step-by-step plans for common workflows (summarize unread, reply to unread, enroll contacts by criteria). Pass a `workflow` for its steps. It requires you to call visualize_plan with your intended steps BEFORE you read, reply, or enroll anything.",
      inputSchema: {
        type: "object",
        properties: {
          workflow: {
            type: "string",
            enum: ["summarize_unread", "reply_unread", "enroll_by_criteria"],
            description: "Which workflow's step-by-step detail to return.",
          },
        },
      },
      execute: async (args) => {
        if (args.workflow) {
          const body = PLAYBOOKS[args.workflow];
          if (!body) return fail(`Unknown workflow "${args.workflow}".`);
          return ok(body);
        }
        return ok(PLAYBOOK_INTRO);
      },
    },
    {
      name: "whoami",
      description:
        "Return the signed-in user (name, email) and the inbox addresses they can act on.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        const [session, stats] = await Promise.all([
          deps.getSession(),
          deps.fetchStats(),
        ]);
        return okJson({
          user: session?.data?.user ?? null,
          inboxes: stats?.recipients ?? [],
        });
      },
    },
    {
      name: "list_inboxes",
      description:
        "List inbox addresses and sender identities available to the user.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        const stats = await deps.fetchStats();
        return okJson({
          inboxes: stats?.recipients ?? [],
          senderIdentities: stats?.senderIdentities ?? [],
        });
      },
    },
    {
      name: "list_conversations",
      description:
        "List inbox rows (contacts and multi-party conversations), newest first. Optional text query and unread filter.",
      inputSchema: {
        type: "object",
        properties: {
          q: {
            type: "string",
            description: "Filter by contact name/email/subject.",
          },
          unread: {
            type: "boolean",
            description: "Only rows with unread mail.",
          },
          limit: { type: "number", description: "Max rows (default 25)." },
        },
      },
      describe: (args) =>
        args.q
          ? `Searching your conversations for “${args.q}”`
          : "Browsing your conversations",
      execute: async (args) => {
        const res = await deps.fetchGroupedPeople({
          q: args.q,
          unread: args.unread,
          limit: args.limit ?? 25,
        });
        return okJson(res);
      },
    },
    {
      name: "list_contacts",
      description: "Search contacts (people) by name or email.",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "Name or email to search for." },
          limit: { type: "number", description: "Max results (default 25)." },
        },
      },
      describe: (args) =>
        args.q
          ? `Searching contacts for “${args.q}”`
          : "Browsing your contacts",
      execute: async (args) => {
        const res = await deps.fetchGroupedPeople({
          q: args.q,
          limit: args.limit ?? 25,
        });
        return okJson(res);
      },
    },
    {
      name: "get_contact",
      description: "Get one contact with unread/total counts.",
      inputSchema: {
        type: "object",
        properties: { personId: { type: "string" } },
        required: ["personId"],
      },
      group: "Looking up contacts",
      subject: async (args) => personLabel(args.personId),
      execute: async (args) => okJson(await deps.fetchPerson(args.personId)),
    },
    {
      name: "list_emails",
      description:
        "List messages for one contact (personId) or one conversation (conversationId). Provide exactly one.",
      inputSchema: {
        type: "object",
        properties: {
          personId: { type: "string" },
          conversationId: { type: "string" },
          q: {
            type: "string",
            description: "Text filter (personId mode only).",
          },
          limit: { type: "number" },
        },
      },
      group: "Reading emails",
      subject: async (args) => {
        if (args.personId) return personLabel(args.personId);
        return args.conversationId ? "a conversation" : "the inbox";
      },
      execute: async (args) => {
        if (args.conversationId) {
          return okJson(
            await deps.fetchConversationEmails(args.conversationId),
          );
        }
        if (args.personId) {
          return okJson(
            await deps.fetchPersonEmails(args.personId, {
              q: args.q,
              limit: args.limit ?? 50,
            }),
          );
        }
        return fail("Provide either personId or conversationId.");
      },
    },
    {
      name: "read_email",
      description: "Get one email in full, including body and attachments.",
      inputSchema: {
        type: "object",
        properties: { emailId: { type: "string" } },
        required: ["emailId"],
      },
      execute: async (args) => okJson(await deps.fetchEmail(args.emailId)),
    },
    {
      name: "search_emails",
      description:
        "Full-text search across received and sent mail when you don't already know the contact. Returns message-level hits with a snippet; call read_email for the full message.",
      inputSchema: {
        type: "object",
        properties: {
          q: {
            type: "string",
            description: "Words to find in subject and body.",
          },
          inbox: { type: "string" },
          limit: { type: "number" },
        },
        required: ["q"],
      },
      describe: (args) =>
        args.q ? `Searching your mail for “${args.q}”` : "Searching your mail",
      execute: async (args) => {
        if (!args.q || !String(args.q).trim()) return fail("q is required.");
        return okJson(
          await deps.searchEmails({
            q: args.q,
            inbox: args.inbox,
            limit: args.limit ?? 25,
          }),
        );
      },
    },
    {
      name: "list_templates",
      description: "List email templates (slug, name, subject).",
      inputSchema: { type: "object", properties: {} },
      execute: async () => okJson(await deps.fetchTemplates()),
    },
    {
      name: "get_template",
      description:
        "Get one template by slug, including its body and variables.",
      inputSchema: {
        type: "object",
        properties: { slug: { type: "string" } },
        required: ["slug"],
      },
      describe: (args) =>
        args.slug
          ? `Opening the “${args.slug}” template`
          : "Opening a template",
      execute: async (args) => okJson(await deps.fetchTemplate(args.slug)),
    },
    {
      name: "list_sequences",
      description: "List drip sequences the user can enroll contacts into.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => okJson(await deps.fetchSequences()),
    },
  ];
}
