import type { WebMcpToolDescriptor } from "../types";
import { ok, okJson, fail } from "../result";
import { PLAYBOOK_INTRO, PLAYBOOKS } from "@worker/lib/agent/playbook";

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
  fetchMessages?: (p?: any) => Promise<any>;
  getSession: () => Promise<any>;
  fetchLists: (p?: any) => Promise<any>;
  fetchList: (id: string) => Promise<any>;
  fetchCampaigns: () => Promise<any>;
  fetchCampaign: (id: string) => Promise<any>;
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
      name: "list_messages",
      description:
        "List unified received and sent messages with state, folder filters, cursor pagination, and attachment counts.",
      inputSchema: {
        type: "object",
        properties: {
          inbox: { type: "string" },
          folder: {
            type: "string",
            enum: ["inbox", "sent", "archive", "junk", "trash", "snoozed"],
          },
          mailboxId: { type: "string" },
          starred: { type: "boolean" },
          unseen: { type: "boolean" },
          personId: { type: "string" },
          q: { type: "string" },
          cursor: { type: "string" },
          limit: { type: "number" },
          excludeCampaignSends: { type: "boolean" },
        },
      },
      execute: async (args) => {
        if (!deps.fetchMessages) return fail("Message listing is unavailable.");
        return okJson(await deps.fetchMessages(args));
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
      group: "Opening emails",
      subject: async (args) => {
        const e = await deps.fetchEmail(args.emailId);
        const subj = typeof e?.subject === "string" ? e.subject.trim() : "";
        // The counterpart address: who it's from (received) or who it's to.
        const who = e?.fromAddress || e?.recipient || "";
        if (subj) return who ? `“${subj}” — ${who}` : `“${subj}”`;
        return who || "an email";
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
    // --- Newsletters: read only ---------------------------------------------
    //
    // There are deliberately no newsletter *action* tools. Sending is
    // irreversible and reaches thousands of strangers at once; an agent that
    // can trigger a blast is precisely the capability that should stay behind
    // a human click. These four let an agent report on newsletters, not run
    // them.
    {
      name: "list_newsletter_lists",
      description:
        "List the newsletter subscriber lists. Read-only: WebMCP cannot create lists, add members, or send campaigns.",
      inputSchema: {
        type: "object",
        properties: {
          includeArchived: {
            type: "boolean",
            description:
              "Include lists that were archived because they have campaign history.",
          },
        },
      },
      execute: async (args: any) =>
        okJson(
          await deps.fetchLists({ includeArchived: !!args?.includeArchived }),
        ),
    },
    {
      name: "get_newsletter_list",
      description:
        "Get one subscriber list with its member counts by status (subscribed, pending, unsubscribed).",
      inputSchema: {
        type: "object",
        properties: {
          listId: { type: "string", description: "The list's id." },
        },
        required: ["listId"],
      },
      execute: async (args: any) => {
        if (!args?.listId) return fail("listId is required");
        return okJson(await deps.fetchList(args.listId));
      },
    },
    {
      name: "list_campaigns",
      description:
        "List newsletter campaigns, newest first, with their current status (draft, scheduled, sending, sent, completed_with_failures, stalled, cancelled).",
      inputSchema: { type: "object", properties: {} },
      execute: async () => okJson(await deps.fetchCampaigns()),
    },
    {
      name: "get_campaign_stats",
      description:
        "Get one campaign's live stats: targeted, delivered, suppressed, failures, unsubscribes, and approximate unique opens and clicks. Opens and clicks are best-effort — Apple Mail Privacy Protection pre-fetches tracking pixels and some proxies pre-fetch links, so both over-count. Report them as approximate.",
      inputSchema: {
        type: "object",
        properties: {
          campaignId: { type: "string", description: "The campaign's id." },
        },
        required: ["campaignId"],
      },
      execute: async (args: any) => {
        if (!args?.campaignId) return fail("campaignId is required");
        return okJson(await deps.fetchCampaign(args.campaignId));
      },
    },
  ];
}
