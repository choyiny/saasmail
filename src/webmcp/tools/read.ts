import type { WebMcpToolDescriptor } from "../types";
import { okJson, fail } from "../result";

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
      describe: async (args) =>
        `Looking up ${await personLabel(args.personId)}`,
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
      describe: async (args) => {
        if (args.personId) {
          return `Looking at the emails for ${await personLabel(args.personId)}`;
        }
        return args.conversationId
          ? "Looking at a conversation's emails"
          : "Listing emails";
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
