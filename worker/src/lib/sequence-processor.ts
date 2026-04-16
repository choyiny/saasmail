import { drizzle } from "drizzle-orm/d1";
import { eq, and, lte } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createEmailSender, type EmailSender } from "./email-sender";
import { schema } from "../db/schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { emailTemplates } from "../db/email-templates.schema";
import { people } from "../db/people.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { interpolate } from "./interpolate";
import { formatFromAddress } from "./format-from-address";

export interface SequenceEmailMessage {
  sequenceEmailId: string;
}

/**
 * Cron handler: find due pending emails and push them onto the queue.
 */
export async function handleScheduled(env: CloudflareBindings): Promise<void> {
  const db = drizzle(env.DB, { schema });
  const now = Math.floor(Date.now() / 1000);

  // Find pending emails that are due
  const dueEmails = await db
    .select({ id: sequenceEmails.id })
    .from(sequenceEmails)
    .where(
      and(
        eq(sequenceEmails.status, "pending"),
        lte(sequenceEmails.scheduledAt, now),
      ),
    );

  if (dueEmails.length === 0) return;

  // Mark as queued first (prevents re-pickup on crash), then push to queue
  for (const email of dueEmails) {
    await db
      .update(sequenceEmails)
      .set({ status: "queued" })
      .where(eq(sequenceEmails.id, email.id));

    const message: SequenceEmailMessage = { sequenceEmailId: email.id };
    await env.EMAIL_QUEUE.send(message);
  }

  console.log(`Queued ${dueEmails.length} sequence emails`);
}

/**
 * Queue consumer: process a batch of sequence email messages.
 */
export async function handleQueueBatch(
  batch: MessageBatch<SequenceEmailMessage>,
  env: CloudflareBindings,
): Promise<void> {
  const db = drizzle(env.DB, { schema });
  const sender = createEmailSender(env);

  for (const msg of batch.messages) {
    try {
      await processSequenceEmail(db, sender, msg.body.sequenceEmailId);
      msg.ack();
    } catch (err) {
      console.error(
        `Failed to process sequence email ${msg.body.sequenceEmailId}:`,
        err,
      );
      msg.retry();
    }
  }
}

async function processSequenceEmail(
  db: ReturnType<typeof drizzle>,
  sender: EmailSender,
  sequenceEmailId: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  // Fetch the outbox row
  const emailRows = await db
    .select()
    .from(sequenceEmails)
    .where(eq(sequenceEmails.id, sequenceEmailId))
    .limit(1);

  if (emailRows.length === 0) return;
  const seqEmail = emailRows[0];

  // Bail if not queued (already cancelled or sent)
  if (seqEmail.status !== "queued") return;

  // Fetch enrollment — bail if not active
  const enrollmentRows = await db
    .select()
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.id, seqEmail.enrollmentId))
    .limit(1);

  if (enrollmentRows.length === 0) return;
  const enrollment = enrollmentRows[0];

  const fromAddress = enrollment.fromAddress;

  if (enrollment.status !== "active") {
    // Enrollment was cancelled while queued — mark email as cancelled
    await db
      .update(sequenceEmails)
      .set({ status: "cancelled" })
      .where(eq(sequenceEmails.id, sequenceEmailId));
    return;
  }

  // Fetch the template
  const templateRows = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.slug, seqEmail.templateSlug))
    .limit(1);

  if (templateRows.length === 0) {
    await db
      .update(sequenceEmails)
      .set({ status: "failed" })
      .where(eq(sequenceEmails.id, sequenceEmailId));
    return;
  }

  const template = templateRows[0];

  // Fetch person for auto-variables
  const personRows = await db
    .select()
    .from(people)
    .where(eq(people.id, enrollment.personId))
    .limit(1);

  if (personRows.length === 0) {
    await db
      .update(sequenceEmails)
      .set({ status: "failed" })
      .where(eq(sequenceEmails.id, sequenceEmailId));
    return;
  }

  const person = personRows[0];

  // Merge variables: person auto-vars + enrollment custom vars (custom wins)
  const customVars: Record<string, string> = JSON.parse(enrollment.variables);
  const mergedVars: Record<string, string> = {
    name: person.name ?? "",
    email: person.email,
    ...customVars,
  };

  // Interpolate template
  const renderedSubject = interpolate(template.subject, mergedVars);
  const renderedHtml = interpolate(template.bodyHtml, mergedVars);

  const formattedFrom = await formatFromAddress(db, fromAddress);
  const result = await sender.send({
    from: formattedFrom,
    to: person.email,
    subject: renderedSubject,
    html: renderedHtml,
  });

  // Store sent email record
  const sentId = nanoid();
  await db.insert(sentEmails).values({
    id: sentId,
    personId: person.id,
    fromAddress,
    toAddress: person.email,
    subject: renderedSubject,
    bodyHtml: renderedHtml,
    bodyText: null,
    resendId: result.id,
    status: result.error ? "failed" : "sent",
    sentAt: now,
    createdAt: now,
  });

  // Update outbox row
  if (result.error) {
    await db
      .update(sequenceEmails)
      .set({ status: "failed" })
      .where(eq(sequenceEmails.id, sequenceEmailId));
    return;
  }

  await db
    .update(sequenceEmails)
    .set({ status: "sent", sentAt: now, sentEmailId: sentId })
    .where(eq(sequenceEmails.id, sequenceEmailId));

  // Check if this was the last step — if so, mark enrollment completed
  const remainingPending = await db
    .select({ id: sequenceEmails.id })
    .from(sequenceEmails)
    .where(
      and(
        eq(sequenceEmails.enrollmentId, enrollment.id),
        eq(sequenceEmails.status, "pending"),
      ),
    )
    .limit(1);

  const remainingQueued = await db
    .select({ id: sequenceEmails.id })
    .from(sequenceEmails)
    .where(
      and(
        eq(sequenceEmails.enrollmentId, enrollment.id),
        eq(sequenceEmails.status, "queued"),
      ),
    )
    .limit(1);

  if (remainingPending.length === 0 && remainingQueued.length === 0) {
    await db
      .update(sequenceEnrollments)
      .set({ status: "completed" })
      .where(eq(sequenceEnrollments.id, enrollment.id));
  }
}
