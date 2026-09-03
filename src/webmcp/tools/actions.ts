import type { WebMcpToolDescriptor } from "../types";
import type { WebMcpBridge } from "../bridge";
import type { AgentPlan } from "@/lib/agent-plan";
import { ok, okJson, fail } from "../result";

export interface ActionDeps {
  bridge: WebMcpBridge;
  fetchPeople: (params: { personId?: string; limit?: number }) => Promise<any>;
  fetchEmail: (id: string) => Promise<any>;
  markEmailRead: (id: string, isRead: boolean) => Promise<void>;
  enrollPerson: (
    sequenceId: string,
    data: {
      personId: string;
      fromAddress: string;
      variables?: Record<string, string>;
    },
  ) => Promise<any>;
  saveDraft: (data: {
    contextKey: string;
    bodyHtml?: string;
    fromAddress?: string;
    replyToEmailId?: string | null;
  }) => Promise<any>;
  fetchTemplate: (slug: string) => Promise<any>;
  renderTemplate: (tpl: string, vars: Record<string, unknown>) => string;
  invalidate: () => void;
  /** Force the inbox people-list to refetch (see lib/inbox-events). */
  refreshInbox: () => void;
  /** Publish the agent's plan to the Agent Plan tab (see lib/agent-plan). */
  showPlan: (plan: AgentPlan) => void;
}

export function createActionTools(deps: ActionDeps): WebMcpToolDescriptor[] {
  // Resolve a contact into a human label like "Ada Lovelace (ada@x.com)" for
  // the activity popup. Throws on failure so the caller falls back to the
  // generic tool label.
  const personLabel = async (personId: string): Promise<string> => {
    const { data } = await deps.fetchPeople({ personId, limit: 1 });
    const row = data?.[0];
    if (!row) throw new Error("Contact not found.");
    return row.name ? `${row.name} (${row.email})` : row.email;
  };

  return [
    {
      name: "open_contact",
      description:
        "Navigate the app to a contact's inbox thread so the user can see it.",
      inputSchema: {
        type: "object",
        properties: { personId: { type: "string" } },
        required: ["personId"],
      },
      describe: async (args) => `Opening ${await personLabel(args.personId)}`,
      execute: async (args) => {
        // GET /api/people/:id has no `recipient` — that inbox address is a
        // per-(person,inbox) value only the list query computes. Resolve the
        // contact's most-recent inbox pair the same way the inbox list does,
        // then drive the router so the user watches the thread open.
        const { data } = await deps.fetchPeople({
          personId: args.personId,
          limit: 1,
        });
        const row = data?.[0];
        if (!row?.recipient) return fail("Contact not found or has no inbox.");
        deps.bridge.navigate(
          `/inbox/${encodeURIComponent(row.recipient)}/${encodeURIComponent(row.id)}`,
        );
        return ok(`Opened ${row.email ?? row.id} in the inbox.`);
      },
    },
    {
      name: "compose_email",
      description:
        "Open the compose drawer pre-filled with a draft. The user reviews it and clicks Send — this does NOT send.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email." },
          from: { type: "string", description: "Sender inbox address." },
          subject: { type: "string" },
          bodyHtml: { type: "string", description: "HTML body." },
        },
        required: ["to"],
      },
      describe: (args) =>
        args.to ? `Drafting an email to ${args.to}` : "Drafting an email",
      execute: async (args) => {
        deps.bridge.openCompose({
          to: args.to,
          from: args.from,
          subject: args.subject,
          bodyHtml: args.bodyHtml,
        });
        return ok(
          `Prepared a draft to ${args.to}. It's open in the compose drawer for the user to review and send.`,
        );
      },
    },
    {
      name: "compose_from_template",
      description:
        "Render a template with variables and open the compose drawer pre-filled with the result for the user to review and send.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Template slug." },
          to: { type: "string" },
          from: { type: "string" },
          variables: {
            type: "object",
            description: "Values for the template's {{variables}}.",
            additionalProperties: { type: "string" },
          },
        },
        required: ["slug", "to"],
      },
      describe: (args) =>
        `Drafting the “${args.slug}” template${args.to ? ` to ${args.to}` : ""}`,
      execute: async (args) => {
        const tpl = await deps.fetchTemplate(args.slug);
        if (!tpl) return fail(`Template "${args.slug}" not found.`);
        const vars = args.variables ?? {};
        let bodyHtml: string;
        let subject: string;
        try {
          bodyHtml = deps.renderTemplate(tpl.bodyHtml ?? "", vars);
          subject = deps.renderTemplate(tpl.subject ?? "", vars);
        } catch (e) {
          return fail(`Could not render template: ${(e as Error).message}`);
        }
        deps.bridge.openCompose({
          to: args.to,
          from: args.from,
          subject,
          bodyHtml,
        });
        return ok(
          `Rendered "${args.slug}" and opened a draft to ${args.to} for the user to review and send.`,
        );
      },
    },
    {
      name: "reply_email",
      description:
        "Draft a reply to a received message. Saves the draft and shows it in the inbox's Drafts filter — the user opens it, reviews, and clicks Send. This does NOT send.",
      inputSchema: {
        type: "object",
        properties: {
          emailId: { type: "string", description: "The email to reply to." },
          bodyHtml: { type: "string", description: "HTML reply body." },
        },
        required: ["emailId", "bodyHtml"],
      },
      execute: async (args) => {
        const email = await deps.fetchEmail(args.emailId);
        if (!email) return fail("Email not found.");
        if (email.type !== "received") {
          return fail("Only received mail can be replied to.");
        }
        // Reply comes from the inbox the message was received at.
        const fromAddress = email.recipient;
        if (!fromAddress) {
          return fail("Could not determine the sending inbox for this reply.");
        }
        // WebMCP never sends on its own. Save the reply draft, then switch the
        // inbox to its Drafts filter and refresh so the conversation shows up
        // there for the user to open, review, and send.
        await deps.saveDraft({
          contextKey: `reply:${email.id}`,
          bodyHtml: args.bodyHtml,
          fromAddress,
          replyToEmailId: email.id,
        });
        deps.bridge.navigate("/?drafts=1");
        deps.refreshInbox();
        return ok(
          `Drafted a reply to "${email.subject ?? "(no subject)"}". It's in the inbox Drafts filter for you to review and send.`,
        );
      },
    },
    {
      name: "mark_read",
      description: "Mark a received message as read.",
      inputSchema: {
        type: "object",
        properties: { emailId: { type: "string" } },
        required: ["emailId"],
      },
      execute: async (args) => {
        await deps.markEmailRead(args.emailId, true);
        deps.invalidate();
        return okJson({ emailId: args.emailId, isRead: true });
      },
    },
    {
      name: "mark_unread",
      description: "Mark a received message as unread.",
      inputSchema: {
        type: "object",
        properties: { emailId: { type: "string" } },
        required: ["emailId"],
      },
      execute: async (args) => {
        await deps.markEmailRead(args.emailId, false);
        deps.invalidate();
        return okJson({ emailId: args.emailId, isRead: false });
      },
    },
    {
      name: "enroll_in_sequence",
      description:
        "Enroll a contact in a drip sequence immediately (no confirmation). Requires the sequenceId — call list_sequences first to find one. Sends from the contact's inbox unless `from` is given.",
      inputSchema: {
        type: "object",
        properties: {
          personId: { type: "string" },
          sequenceId: {
            type: "string",
            description: "Sequence id, from list_sequences.",
          },
          from: {
            type: "string",
            description:
              "Sender inbox address. Defaults to the contact's inbox.",
          },
          variables: {
            type: "object",
            description: "Values for the sequence templates' {{variables}}.",
            additionalProperties: { type: "string" },
          },
        },
        required: ["personId", "sequenceId"],
      },
      describe: async (args) =>
        `Enrolling ${await personLabel(args.personId)} in a sequence`,
      execute: async (args) => {
        if (!args.sequenceId) {
          return fail(
            "sequenceId is required — call list_sequences to find one.",
          );
        }
        const { data } = await deps.fetchPeople({
          personId: args.personId,
          limit: 1,
        });
        const row = data?.[0];
        if (!row) return fail("Contact not found.");
        const fromAddress = args.from ?? row.recipient;
        if (!fromAddress) {
          return fail("Could not determine a sending inbox — pass `from`.");
        }
        try {
          await deps.enrollPerson(args.sequenceId, {
            personId: args.personId,
            fromAddress,
            variables: args.variables ?? {},
          });
        } catch (e) {
          return fail(`Could not enroll: ${(e as Error).message}`);
        }
        // Show the contact landing in the Sequenced view.
        deps.bridge.navigate("/?sequenced=1");
        deps.refreshInbox();
        return ok(
          `Enrolled ${row.email ?? args.personId} in the sequence. They're in the inbox Sequenced view now.`,
        );
      },
    },
    {
      name: "visualize_plan",
      description:
        "Show the user the plan you're about to run (and update it as you go) on the inbox's Agent Plan tab. Call this early with all steps as status 'pending', then call it again — with the same steps — flipping each to 'active' then 'done'/'error'. Purely visual; it schedules nothing.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Plan title, e.g. “Summarize all unread email”.",
          },
          steps: {
            type: "array",
            description: "The ordered steps, each with a status.",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                status: {
                  type: "string",
                  enum: ["pending", "active", "done", "error"],
                  description: "Defaults to 'pending'.",
                },
                detail: {
                  type: "string",
                  description: "Optional note/result/error under the step.",
                },
              },
              required: ["label"],
            },
          },
          result: {
            type: "string",
            description:
              "Final output to show at the end once the work is done — e.g. the finished summary. Fill this in on your last update.",
          },
        },
        required: ["steps"],
      },
      describe: (args) => {
        const steps = Array.isArray(args.steps) ? args.steps : [];
        const done = steps.filter((s: any) => s?.status === "done").length;
        return `Updating the plan (${done}/${steps.length})`;
      },
      execute: async (args) => {
        const steps = Array.isArray(args.steps) ? args.steps : [];
        deps.showPlan({
          title: args.title,
          steps: steps.map((s: any) => ({
            label: String(s?.label ?? ""),
            status: s?.status ?? "pending",
            detail: s?.detail,
          })),
          result: args.result,
        });
        // Surface the plan on its tab so the user can watch it — but don't yank
        // them away from the Drafts/Sequenced view a reply/enroll just focused.
        const search =
          typeof window !== "undefined" ? window.location.search : "";
        const focused = /[?&](drafts|sequenced)=(1|true)\b/.test(search);
        if (!focused) deps.bridge.navigate("/?view=agent-plan");
        const done = steps.filter((s: any) => s?.status === "done").length;
        return ok(
          `Plan updated — ${done}/${steps.length} step(s) done.${
            focused ? "" : " Shown on the Agent Plan tab."
          }`,
        );
      },
    },
  ];
}
