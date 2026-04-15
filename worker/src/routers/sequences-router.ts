import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, and, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { sequences } from "../db/sequences.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { emailTemplates } from "../db/email-templates.schema";
import { senders } from "../db/senders.schema";
import { json200Response, json201Response } from "../lib/helpers";
import type { SequenceEmailMessage } from "../lib/sequence-processor";
import type { Variables } from "../variables";

export const sequencesRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

// --- Zod Schemas ---

const SequenceStepSchema = z.object({
  order: z.number().int().min(1),
  templateSlug: z.string(),
  delayHours: z.number().int().min(0),
});

const SequenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  steps: z.array(SequenceStepSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const CreateSequenceSchema = z.object({
  name: z.string().min(1),
  steps: z.array(SequenceStepSchema).min(1),
});

const EnrollSchema = z.object({
  senderId: z.string(),
  fromAddress: z.string().email(),
  variables: z.record(z.string(), z.string()).optional().default({}),
  skipSteps: z.array(z.number().int()).optional().default([]),
  delayOverrides: z
    .record(z.string(), z.number().int().min(0))
    .optional()
    .default({}),
});

const EnrollmentSchema = z.object({
  id: z.string(),
  sequenceId: z.string(),
  senderId: z.string(),
  status: z.string(),
  variables: z.any(),
  enrolledAt: z.number(),
  cancelledAt: z.number().nullable(),
});

const SequenceEmailSchema = z.object({
  id: z.string(),
  enrollmentId: z.string(),
  stepOrder: z.number(),
  templateSlug: z.string(),
  scheduledAt: z.number(),
  status: z.string(),
  sentAt: z.number().nullable(),
  sentEmailId: z.string().nullable(),
});

// --- Helper: snap to next hour ---
function snapToNextHour(timestampSeconds: number): number {
  const ms = timestampSeconds * 1000;
  const date = new Date(ms);
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
  return Math.floor(date.getTime() / 1000);
}

// --- LIST sequences ---
const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Sequences"],
  description: "List all sequences.",
  responses: {
    ...json200Response(z.array(SequenceSchema), "List of sequences"),
  },
});

sequencesRouter.openapi(listRoute, async (c) => {
  const db = c.get("db");
  const rows = await db.select().from(sequences).orderBy(sequences.createdAt);
  const result = rows.map((r) => ({
    ...r,
    steps: JSON.parse(r.steps),
  }));
  return c.json(result, 200);
});

// --- GET single sequence ---
const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Sequences"],
  description: "Get a sequence by ID.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    ...json200Response(SequenceSchema, "Sequence details"),
  },
});

sequencesRouter.openapi(getRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const rows = await db
    .select()
    .from(sequences)
    .where(eq(sequences.id, id))
    .limit(1);

  if (rows.length === 0) {
    return c.json({ error: "Sequence not found" }, 404);
  }

  return c.json({ ...rows[0], steps: JSON.parse(rows[0].steps) }, 200);
});

// --- CREATE sequence ---
const createSequenceRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Sequences"],
  description: "Create a new sequence.",
  request: {
    body: {
      content: {
        "application/json": { schema: CreateSequenceSchema },
      },
    },
  },
  responses: {
    ...json201Response(SequenceSchema, "Sequence created"),
  },
});

sequencesRouter.openapi(createSequenceRoute, async (c) => {
  const db = c.get("db");
  const { name, steps } = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);

  // Validate that all template slugs exist
  for (const step of steps) {
    const tmpl = await db
      .select({ id: emailTemplates.id })
      .from(emailTemplates)
      .where(eq(emailTemplates.slug, step.templateSlug))
      .limit(1);
    if (tmpl.length === 0) {
      return c.json(
        { error: `Template "${step.templateSlug}" not found` },
        400,
      );
    }
  }

  const id = nanoid();
  const row = {
    id,
    name,
    steps: JSON.stringify(steps),
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(sequences).values(row);

  return c.json({ ...row, steps }, 201);
});

// --- UPDATE sequence ---
const updateRoute = createRoute({
  method: "put",
  path: "/{id}",
  tags: ["Sequences"],
  description: "Update a sequence.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1).optional(),
            steps: z.array(SequenceStepSchema).min(1).optional(),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(SequenceSchema, "Sequence updated"),
  },
});

sequencesRouter.openapi(updateRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);

  const existing = await db
    .select()
    .from(sequences)
    .where(eq(sequences.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json({ error: "Sequence not found" }, 404);
  }

  // Validate template slugs if steps are being updated
  if (body.steps) {
    for (const step of body.steps) {
      const tmpl = await db
        .select({ id: emailTemplates.id })
        .from(emailTemplates)
        .where(eq(emailTemplates.slug, step.templateSlug))
        .limit(1);
      if (tmpl.length === 0) {
        return c.json(
          { error: `Template "${step.templateSlug}" not found` },
          400,
        );
      }
    }
  }

  const updates: Record<string, any> = { updatedAt: now };
  if (body.name) updates.name = body.name;
  if (body.steps) updates.steps = JSON.stringify(body.steps);

  await db.update(sequences).set(updates).where(eq(sequences.id, id));

  const updated = await db
    .select()
    .from(sequences)
    .where(eq(sequences.id, id))
    .limit(1);

  return c.json({ ...updated[0], steps: JSON.parse(updated[0].steps) }, 200);
});

// --- DELETE sequence ---
const deleteRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Sequences"],
  description: "Delete a sequence (only if no active enrollments).",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "Sequence deleted"),
  },
});

sequencesRouter.openapi(deleteRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");

  // Check for active enrollments
  const active = await db
    .select({ id: sequenceEnrollments.id })
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.sequenceId, id),
        eq(sequenceEnrollments.status, "active"),
      ),
    )
    .limit(1);

  if (active.length > 0) {
    return c.json(
      { error: "Cannot delete sequence with active enrollments" },
      400,
    );
  }

  await db.delete(sequences).where(eq(sequences.id, id));
  return c.json({ success: true }, 200);
});

// --- ENROLL a sender ---
const enrollRoute = createRoute({
  method: "post",
  path: "/{id}/enroll",
  tags: ["Sequences"],
  description:
    "Enroll a sender into a sequence. Computes all scheduled send times upfront.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": { schema: EnrollSchema },
      },
    },
  },
  responses: {
    ...json201Response(
      z.object({
        enrollment: EnrollmentSchema,
        scheduledEmails: z.array(SequenceEmailSchema),
      }),
      "Sender enrolled",
    ),
  },
});

sequencesRouter.openapi(enrollRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const { senderId, fromAddress, variables, skipSteps, delayOverrides } =
    c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);

  // Validate sequence exists
  const seqRows = await db
    .select()
    .from(sequences)
    .where(eq(sequences.id, id))
    .limit(1);

  if (seqRows.length === 0) {
    return c.json({ error: "Sequence not found" }, 404);
  }

  // Validate sender exists
  const senderRows = await db
    .select({ id: senders.id })
    .from(senders)
    .where(eq(senders.id, senderId))
    .limit(1);

  if (senderRows.length === 0) {
    return c.json({ error: "Sender not found" }, 404);
  }

  // Check sender is not already in an active sequence
  const existingEnrollment = await db
    .select({ id: sequenceEnrollments.id })
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.senderId, senderId),
        eq(sequenceEnrollments.status, "active"),
      ),
    )
    .limit(1);

  if (existingEnrollment.length > 0) {
    return c.json({ error: "Sender is already in an active sequence" }, 400);
  }

  const steps: Array<{
    order: number;
    templateSlug: string;
    delayHours: number;
  }> = JSON.parse(seqRows[0].steps);

  // Filter out skipped steps
  const activeSteps = steps.filter((s) => !skipSteps.includes(s.order));

  if (activeSteps.length === 0) {
    return c.json(
      { error: "At least one step must remain after skipping" },
      400,
    );
  }

  // Create enrollment
  const enrollmentId = nanoid();
  const enrollment = {
    id: enrollmentId,
    sequenceId: id,
    senderId,
    fromAddress,
    status: "active",
    variables: JSON.stringify(variables),
    enrolledAt: now,
    cancelledAt: null,
  };
  await db.insert(sequenceEnrollments).values(enrollment);

  // Create outbox emails with computed schedule
  // First email sends immediately; subsequent emails use snapToNextHour as base
  const baseTime = snapToNextHour(now);
  const scheduledEmails = activeSteps.map((step, index) => {
    const delayHours =
      step.order.toString() in delayOverrides
        ? delayOverrides[step.order.toString()]
        : step.delayHours;

    const isFirstEmail = index === 0;
    return {
      id: nanoid(),
      enrollmentId,
      stepOrder: step.order,
      templateSlug: step.templateSlug,
      scheduledAt: isFirstEmail ? now : baseTime + delayHours * 3600,
      status: isFirstEmail ? "queued" : "pending",
      sentAt: null,
      sentEmailId: null,
    };
  });

  await db.insert(sequenceEmails).values(scheduledEmails);

  // Immediately queue the first email so it sends without waiting for cron
  const firstEmail = scheduledEmails[0];
  const message: SequenceEmailMessage = { sequenceEmailId: firstEmail.id };
  await c.env.EMAIL_QUEUE.send(message);

  return c.json(
    {
      enrollment: { ...enrollment, variables },
      scheduledEmails,
    },
    201,
  );
});

// --- GET enrollment for a sender ---
const getEnrollmentRoute = createRoute({
  method: "get",
  path: "/senders/{senderId}/enrollment",
  tags: ["Sequences"],
  description: "Get active enrollment and scheduled emails for a sender.",
  request: {
    params: z.object({ senderId: z.string() }),
  },
  responses: {
    ...json200Response(
      z.object({
        enrollment: EnrollmentSchema.nullable(),
        scheduledEmails: z.array(SequenceEmailSchema),
        sequenceName: z.string().nullable(),
      }),
      "Enrollment details",
    ),
  },
});

sequencesRouter.openapi(getEnrollmentRoute, async (c) => {
  const db = c.get("db");
  const { senderId } = c.req.valid("param");

  const enrollments = await db
    .select()
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.senderId, senderId),
        eq(sequenceEnrollments.status, "active"),
      ),
    )
    .limit(1);

  if (enrollments.length === 0) {
    return c.json(
      { enrollment: null, scheduledEmails: [], sequenceName: null },
      200,
    );
  }

  const enrollment = enrollments[0];

  const emails = await db
    .select()
    .from(sequenceEmails)
    .where(eq(sequenceEmails.enrollmentId, enrollment.id))
    .orderBy(sequenceEmails.stepOrder);

  // Get sequence name
  const seqRow = await db
    .select({ name: sequences.name })
    .from(sequences)
    .where(eq(sequences.id, enrollment.sequenceId))
    .limit(1);

  return c.json(
    {
      enrollment: {
        ...enrollment,
        variables: JSON.parse(enrollment.variables),
      },
      scheduledEmails: emails,
      sequenceName: seqRow[0]?.name ?? null,
    },
    200,
  );
});

// --- CANCEL enrollment ---
const cancelEnrollmentRoute = createRoute({
  method: "delete",
  path: "/enrollments/{enrollmentId}",
  tags: ["Sequences"],
  description: "Manually cancel an enrollment.",
  request: {
    params: z.object({ enrollmentId: z.string() }),
  },
  responses: {
    ...json200Response(
      z.object({ success: z.boolean() }),
      "Enrollment cancelled",
    ),
  },
});

sequencesRouter.openapi(cancelEnrollmentRoute, async (c) => {
  const db = c.get("db");
  const { enrollmentId } = c.req.valid("param");
  const now = Math.floor(Date.now() / 1000);

  const rows = await db
    .select()
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.id, enrollmentId))
    .limit(1);

  if (rows.length === 0) {
    return c.json({ error: "Enrollment not found" }, 404);
  }

  if (rows[0].status !== "active") {
    return c.json({ error: "Enrollment is not active" }, 400);
  }

  await db
    .update(sequenceEnrollments)
    .set({ status: "cancelled", cancelledAt: now })
    .where(eq(sequenceEnrollments.id, enrollmentId));

  await db
    .update(sequenceEmails)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(sequenceEmails.enrollmentId, enrollmentId),
        inArray(sequenceEmails.status, ["pending", "queued"]),
      ),
    );

  return c.json({ success: true }, 200);
});

// --- LIST enrollments for a sequence ---
const listEnrollmentsRoute = createRoute({
  method: "get",
  path: "/{id}/enrollments",
  tags: ["Sequences"],
  description: "List all enrollments for a sequence.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    ...json200Response(
      z.array(
        EnrollmentSchema.extend({
          senderEmail: z.string(),
          senderName: z.string().nullable(),
          totalSteps: z.number(),
          sentSteps: z.number(),
        }),
      ),
      "Enrollment list",
    ),
  },
});

sequencesRouter.openapi(listEnrollmentsRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");

  const enrollments = await db
    .select()
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.sequenceId, id))
    .orderBy(sequenceEnrollments.enrolledAt);

  const result = [];
  for (const enrollment of enrollments) {
    // Get sender info
    const senderRow = await db
      .select({ email: senders.email, name: senders.name })
      .from(senders)
      .where(eq(senders.id, enrollment.senderId))
      .limit(1);

    // Get email counts
    const emailRows = await db
      .select({ status: sequenceEmails.status })
      .from(sequenceEmails)
      .where(eq(sequenceEmails.enrollmentId, enrollment.id));

    result.push({
      ...enrollment,
      variables: JSON.parse(enrollment.variables),
      senderEmail: senderRow[0]?.email ?? "unknown",
      senderName: senderRow[0]?.name ?? null,
      totalSteps: emailRows.length,
      sentSteps: emailRows.filter((e) => e.status === "sent").length,
    });
  }

  return c.json(result, 200);
});
