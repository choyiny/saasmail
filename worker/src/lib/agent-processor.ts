import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createWorkersAI } from "workers-ai-provider";
import { generateObject, jsonSchema } from "ai";
import { schema } from "../db/schema";
import { agentRuns } from "../db/agent-runs.schema";
import { agentAssignments } from "../db/agent-assignments.schema";
import { agentDefinitions } from "../db/agent-definitions.schema";
import { emailTemplates } from "../db/email-templates.schema";
import { emails } from "../db/emails.schema";
import { people } from "../db/people.schema";
import { drafts } from "../db/drafts.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { createEmailSender } from "./email-sender";
import { interpolate } from "./interpolate";
import { formatFromAddress } from "./format-from-address";
import { generateMessageId } from "./message-id";

export interface AgentRunMessage {
  runId: string;
  assignmentId: string;
  emailId: string;
}

type Db = ReturnType<typeof drizzle>;

export async function handleAgentQueueBatch(
  batch: MessageBatch<AgentRunMessage>,
  env: CloudflareBindings,
): Promise<void> {
  const db = drizzle(env.DB, { schema });
  const sender = createEmailSender(env);

  for (const msg of batch.messages) {
    try {
      await processAgentRun(db, sender, env, msg.body);
      msg.ack();
    } catch (err) {
      console.error(`Failed to process agent run ${msg.body.runId}:`, err);
      const now = Math.floor(Date.now() / 1000);
      await db
        .update(agentRuns)
        .set({
          status: "failed",
          errorMessage: err instanceof Error ? err.message : String(err),
          updatedAt: now,
        })
        .where(eq(agentRuns.id, msg.body.runId))
        .catch(() => undefined);
      msg.retry();
    }
  }
}

async function processAgentRun(
  db: Db,
  sender: ReturnType<typeof createEmailSender>,
  env: CloudflareBindings,
  { runId, assignmentId, emailId }: AgentRunMessage,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  // Mark running
  await db
    .update(agentRuns)
    .set({ status: "running", updatedAt: now })
    .where(eq(agentRuns.id, runId));

  // Load assignment
  const [assignment] = await db
    .select()
    .from(agentAssignments)
    .where(eq(agentAssignments.id, assignmentId))
    .limit(1);
  if (!assignment) throw new Error(`Assignment ${assignmentId} not found`);

  // Load agent definition
  const [def] = await db
    .select()
    .from(agentDefinitions)
    .where(eq(agentDefinitions.id, assignment.agentId))
    .limit(1);
  if (!def) throw new Error(`Agent definition ${assignment.agentId} not found`);

  // Load trigger email
  const [email] = await db
    .select()
    .from(emails)
    .where(eq(emails.id, emailId))
    .limit(1);
  if (!email) throw new Error(`Email ${emailId} not found`);

  // Load person
  const [person] = await db
    .select()
    .from(people)
    .where(eq(people.id, email.personId))
    .limit(1);
  if (!person) throw new Error(`Person ${email.personId} not found`);

  // Thread context: last 10 emails from same person to same mailbox, excluding trigger
  const allThread = await db
    .select({
      id: emails.id,
      subject: emails.subject,
      bodyText: emails.bodyText,
      receivedAt: emails.receivedAt,
    })
    .from(emails)
    .where(
      and(
        eq(emails.personId, person.id),
        eq(emails.recipient, email.recipient),
      ),
    )
    .orderBy(desc(emails.receivedAt))
    .limit(11);
  const thread = allThread.filter((r) => r.id !== emailId).slice(0, 10);

  // Build LLM prompt messages
  const messages = buildMessages(def.systemPrompt, email, person, thread);

  // Reconstruct JSON Schema for generateObject
  const outputSchema = jsonSchema<Record<string, string>>(
    JSON.parse(def.outputSchemaJson),
  );

  // Call Workers AI via AI Gateway
  const gatewayOpts = env.AI_GATEWAY_SLUG
    ? {
        gateway: {
          id: env.AI_GATEWAY_SLUG,
          skipCache: false,
          cacheTtl: 3600,
        },
      }
    : {};

  const workersAI = createWorkersAI({ binding: env.AI });
  const { object, usage } = await generateObject({
    model: workersAI(def.modelId, gatewayOpts),
    schema: outputSchema,
    messages,
  });

  // Load template and interpolate
  const [template] = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.slug, assignment.templateSlug))
    .limit(1);
  if (!template)
    throw new Error(`Template ${assignment.templateSlug} not found`);

  const renderedSubject = interpolate(template.subject, object);
  const renderedHtml = interpolate(template.bodyHtml, object);

  const fromAddress = template.fromAddress ?? email.recipient;
  const formattedFrom = await formatFromAddress(db, fromAddress);
  const inputTokens =
    (usage as { promptTokens?: number } | undefined)?.promptTokens ?? null;
  const outputTokens =
    (usage as { completionTokens?: number } | undefined)?.completionTokens ??
    null;

  if (assignment.mode === "draft_only") {
    const draftId = nanoid();
    await db.insert(drafts).values({
      id: draftId,
      personId: person.id,
      agentRunId: runId,
      fromAddress,
      toAddress: person.email,
      subject: renderedSubject,
      bodyHtml: renderedHtml,
      inReplyTo: email.messageId,
      createdAt: now,
      updatedAt: now,
    });
    await db
      .update(agentRuns)
      .set({
        status: "succeeded",
        action: "draft",
        draftId,
        modelId: def.modelId,
        inputTokens,
        outputTokens,
        updatedAt: now,
      })
      .where(eq(agentRuns.id, runId));
  } else {
    const messageId = generateMessageId(fromAddress);
    const result = await sender.send({
      from: formattedFrom,
      to: person.email,
      subject: renderedSubject,
      html: renderedHtml,
      headers: {
        "Message-ID": messageId,
        "Auto-Submitted": "auto-replied",
        ...(email.messageId ? { "In-Reply-To": email.messageId } : {}),
      },
    });

    const sentId = nanoid();
    await db.insert(sentEmails).values({
      id: sentId,
      personId: person.id,
      fromAddress,
      toAddress: person.email,
      subject: renderedSubject,
      bodyHtml: renderedHtml,
      bodyText: null,
      inReplyTo: email.messageId,
      messageId,
      resendId: result.id,
      status: result.error ? "failed" : "sent",
      sentAt: now,
      createdAt: now,
    });

    if (result.error) throw new Error(`Send failed: ${result.error}`);

    await db
      .update(agentRuns)
      .set({
        status: "succeeded",
        action: "sent",
        sentEmailId: sentId,
        modelId: def.modelId,
        inputTokens,
        outputTokens,
        updatedAt: now,
      })
      .where(eq(agentRuns.id, runId));
  }
}

function buildMessages(
  systemPrompt: string,
  email: {
    subject: string | null;
    bodyText: string | null;
    receivedAt: number;
  },
  person: { email: string; name: string | null },
  thread: {
    subject: string | null;
    bodyText: string | null;
    receivedAt: number;
  }[],
): { role: "system" | "user"; content: string }[] {
  const threadSection =
    thread.length > 0
      ? `\n\n**Previous messages in thread (${thread.length} shown):**\n${thread
          .map(
            (t) =>
              `[${new Date(t.receivedAt * 1000).toISOString()}] ${t.subject ?? "(no subject)"}: ${(t.bodyText ?? "").slice(0, 500)}`,
          )
          .join("\n---\n")}`
      : "";

  return [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content:
        `You have received an email. Analyze it and provide the requested output.

**Sender:** ${person.name ?? person.email} <${person.email}>
**Subject:** ${email.subject ?? "(no subject)"}
**Received:** ${new Date(email.receivedAt * 1000).toISOString()}

**Email body:**
${email.bodyText ?? "(no plain text body)"}${threadSection}

Provide the output fields as specified.`.trim(),
    },
  ];
}
