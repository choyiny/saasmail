import type { WebMcpToolDescriptor } from "../types";
import type { WebMcpBridge } from "../bridge";
import { ok, okJson, fail } from "../result";

export interface ActionDeps {
  bridge: WebMcpBridge;
  fetchPeople: (params: { personId?: string; limit?: number }) => Promise<any>;
  fetchEmail: (id: string) => Promise<any>;
  markEmailRead: (id: string, isRead: boolean) => Promise<void>;
  deleteEmail: (id: string) => Promise<any>;
  replyToEmail: (emailId: string, data: any) => Promise<any>;
  fetchTemplate: (slug: string) => Promise<any>;
  renderTemplate: (tpl: string, vars: Record<string, unknown>) => string;
  invalidate: () => void;
}

export function createActionTools(deps: ActionDeps): WebMcpToolDescriptor[] {
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
        "Draft a threaded reply to a received message. Shows the user a confirmation before sending.",
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
        deps.bridge.stageForConfirmation({
          title: "Send reply",
          summary: `Reply to "${email.subject ?? "(no subject)"}" from ${fromAddress}.`,
          run: async () => {
            await deps.replyToEmail(args.emailId, {
              bodyHtml: args.bodyHtml,
              fromAddress,
            });
            deps.invalidate();
          },
        });
        return ok("Prepared a reply. The user must confirm before it sends.");
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
      name: "delete_email",
      description:
        "Delete an email. Shows the user a confirmation dialog first — it does NOT delete immediately.",
      inputSchema: {
        type: "object",
        properties: { emailId: { type: "string" } },
        required: ["emailId"],
      },
      execute: async (args) => {
        deps.bridge.stageForConfirmation({
          title: "Delete email",
          summary: `Permanently delete email ${args.emailId} and its attachments.`,
          run: async () => {
            await deps.deleteEmail(args.emailId);
            deps.invalidate();
          },
        });
        return ok(
          "Prepared a delete. The user must confirm before it happens.",
        );
      },
    },
    {
      name: "enroll_in_sequence",
      description:
        "Open the enrollment dialog for a contact so the user can pick a sequence and confirm.",
      inputSchema: {
        type: "object",
        properties: { personId: { type: "string" } },
        required: ["personId"],
      },
      execute: async (args) => {
        deps.bridge.openEnroll(args.personId);
        return ok(
          "Opened the sequence enrollment dialog for the user to complete.",
        );
      },
    },
  ];
}
