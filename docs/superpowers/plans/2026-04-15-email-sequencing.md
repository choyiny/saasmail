# Email Sequencing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an email sequencing system that enrolls senders into timed template series, with auto-cancellation on reply and Cloudflare Queue-based delivery.

**Architecture:** Outbox pattern — enrollment pre-computes all send times into `sequence_emails` rows. An hourly cron pushes due emails onto a Cloudflare Queue. The queue consumer interpolates templates and sends via Resend. Any inbound/outbound email exchange cancels the sequence.

**Tech Stack:** Hono + Zod OpenAPI (backend), Drizzle + D1 (database), Cloudflare Queues + Cron (processing), React + Tailwind (frontend), Resend (email delivery)

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `worker/src/db/sequences.schema.ts` | `sequences` table definition |
| `worker/src/db/sequence-enrollments.schema.ts` | `sequence_enrollments` table definition |
| `worker/src/db/sequence-emails.schema.ts` | `sequence_emails` outbox table definition |
| `worker/src/routers/sequences-router.ts` | CRUD routes for sequences + enrollment |
| `worker/src/lib/cancel-sequence.ts` | Shared cancellation logic |
| `worker/src/lib/sequence-processor.ts` | Cron handler + queue consumer logic |
| `migrations/0007_email_sequencing.sql` | Migration for new tables |
| `src/pages/SequencesPage.tsx` | Sequences list page |
| `src/pages/SequenceDetailPage.tsx` | Sequence detail + enrollments view |
| `src/pages/SequenceEditorPage.tsx` | Create/edit sequence form |
| `src/components/EnrollSequenceModal.tsx` | Enrollment modal for sender detail |
| `src/components/SequenceStatus.tsx` | Active sequence status display for sender detail |

### Modified files

| File | Change |
|------|--------|
| `worker/src/db/schema.ts` | Add new tables to schema aggregate |
| `worker/src/db/index.ts` | Export new schema files |
| `worker/src/index.ts` | Register sequences router, add scheduled + queue handlers |
| `worker/src/email-handler.ts` | Add cancellation check after email insert |
| `worker/src/routers/send-router.ts` | Add cancellation check after send/reply |
| `wrangler.jsonc` | Add queue bindings + cron trigger |
| `src/lib/api.ts` | Add sequence/enrollment API functions |
| `src/components/Sidebar.tsx` | Add Sequences nav item |
| `src/App.tsx` | Add sequence routes |
| `src/pages/SenderDetail.tsx` | Add sequence status + enroll button |

---

## Task 1: Database Schema — Sequences Table

**Files:**
- Create: `worker/src/db/sequences.schema.ts`

- [ ] **Step 1: Create the sequences schema file**

```typescript
// worker/src/db/sequences.schema.ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const sequences = sqliteTable("sequences", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  steps: text("steps").notNull(), // JSON: [{ order, templateSlug, delayHours }]
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
```

- [ ] **Step 2: Commit**

```bash
git add worker/src/db/sequences.schema.ts
git commit -m "feat: add sequences table schema"
```

---

## Task 2: Database Schema — Sequence Enrollments Table

**Files:**
- Create: `worker/src/db/sequence-enrollments.schema.ts`

- [ ] **Step 1: Create the sequence enrollments schema file**

```typescript
// worker/src/db/sequence-enrollments.schema.ts
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const sequenceEnrollments = sqliteTable(
  "sequence_enrollments",
  {
    id: text("id").primaryKey(),
    sequenceId: text("sequence_id").notNull(),
    senderId: text("sender_id").notNull(),
    status: text("status").notNull().default("active"), // active, completed, cancelled
    variables: text("variables").notNull().default("{}"), // JSON
    enrolledAt: integer("enrolled_at").notNull(),
    cancelledAt: integer("cancelled_at"),
  },
  (table) => [
    index("enrollments_sender_status_idx").on(table.senderId, table.status),
  ]
);
```

- [ ] **Step 2: Commit**

```bash
git add worker/src/db/sequence-enrollments.schema.ts
git commit -m "feat: add sequence_enrollments table schema"
```

---

## Task 3: Database Schema — Sequence Emails (Outbox) Table

**Files:**
- Create: `worker/src/db/sequence-emails.schema.ts`

- [ ] **Step 1: Create the sequence emails outbox schema file**

```typescript
// worker/src/db/sequence-emails.schema.ts
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const sequenceEmails = sqliteTable(
  "sequence_emails",
  {
    id: text("id").primaryKey(),
    enrollmentId: text("enrollment_id").notNull(),
    stepOrder: integer("step_order").notNull(),
    templateSlug: text("template_slug").notNull(),
    scheduledAt: integer("scheduled_at").notNull(),
    status: text("status").notNull().default("pending"), // pending, queued, sent, cancelled, failed
    sentAt: integer("sent_at"),
    sentEmailId: text("sent_email_id"),
  },
  (table) => [
    index("seq_emails_status_scheduled_idx").on(table.status, table.scheduledAt),
  ]
);
```

- [ ] **Step 2: Commit**

```bash
git add worker/src/db/sequence-emails.schema.ts
git commit -m "feat: add sequence_emails outbox table schema"
```

---

## Task 4: Register Schemas in Barrel Exports

**Files:**
- Modify: `worker/src/db/index.ts`
- Modify: `worker/src/db/schema.ts`

- [ ] **Step 1: Add exports to `worker/src/db/index.ts`**

Add these three lines before the existing `export * from "./schema";` line:

```typescript
export * from "./sequences.schema";
export * from "./sequence-enrollments.schema";
export * from "./sequence-emails.schema";
```

- [ ] **Step 2: Add tables to schema aggregate in `worker/src/db/schema.ts`**

Add imports at the top:

```typescript
import { sequences } from "./sequences.schema";
import { sequenceEnrollments } from "./sequence-enrollments.schema";
import { sequenceEmails } from "./sequence-emails.schema";
```

Add to the schema object:

```typescript
export const schema = {
  ...authSchema,
  invitations,
  senders,
  emails,
  sentEmails,
  attachments,
  emailTemplates,
  apiKeys,
  sequences,
  sequenceEnrollments,
  sequenceEmails,
} as const;
```

- [ ] **Step 3: Commit**

```bash
git add worker/src/db/index.ts worker/src/db/schema.ts
git commit -m "feat: register sequence schemas in barrel exports"
```

---

## Task 5: Generate and Apply Migration

**Files:**
- Create: `migrations/0007_email_sequencing.sql` (generated by drizzle-kit)

- [ ] **Step 1: Generate the migration**

Run: `npm run db:generate`

Expected: A new migration file in `migrations/` with CREATE TABLE statements for `sequences`, `sequence_enrollments`, and `sequence_emails`.

- [ ] **Step 2: Verify the generated SQL**

Read the generated migration file and confirm it creates all three tables with the correct columns and indexes.

- [ ] **Step 3: Apply migration locally**

Run: `npm run db:migrate:dev`

Expected: Migration applied successfully.

- [ ] **Step 4: Commit**

```bash
git add migrations/
git commit -m "feat: add migration for sequence tables"
```

---

## Task 6: Cancellation Helper

**Files:**
- Create: `worker/src/lib/cancel-sequence.ts`

- [ ] **Step 1: Create the shared cancellation function**

```typescript
// worker/src/lib/cancel-sequence.ts
import { eq, and, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";

/**
 * Cancel all active sequence enrollments for a given sender.
 * Called when any email exchange occurs (inbound or outbound).
 */
export async function cancelSequencesForSender(
  db: DrizzleD1Database<any>,
  senderId: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  // Find active enrollments for this sender
  const activeEnrollments = await db
    .select({ id: sequenceEnrollments.id })
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.senderId, senderId),
        eq(sequenceEnrollments.status, "active")
      )
    );

  if (activeEnrollments.length === 0) return;

  const enrollmentIds = activeEnrollments.map((e) => e.id);

  // Cancel the enrollments
  for (const enrollmentId of enrollmentIds) {
    await db
      .update(sequenceEnrollments)
      .set({ status: "cancelled", cancelledAt: now })
      .where(eq(sequenceEnrollments.id, enrollmentId));
  }

  // Cancel pending/queued outbox emails for those enrollments
  for (const enrollmentId of enrollmentIds) {
    await db
      .update(sequenceEmails)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(sequenceEmails.enrollmentId, enrollmentId),
          inArray(sequenceEmails.status, ["pending", "queued"])
        )
      );
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add worker/src/lib/cancel-sequence.ts
git commit -m "feat: add shared sequence cancellation helper"
```

---

## Task 7: Add Cancellation to Email Handler (Inbound)

**Files:**
- Modify: `worker/src/email-handler.ts`

- [ ] **Step 1: Add cancellation check after email insert**

Add import at top of `email-handler.ts`:

```typescript
import { cancelSequencesForSender } from "./lib/cancel-sequence";
```

Add after the email insert block (after line 79, before the attachments loop), using `actualSenderId` which is already resolved:

```typescript
  // Cancel any active sequences for this sender
  await cancelSequencesForSender(db, actualSenderId);
```

- [ ] **Step 2: Commit**

```bash
git add worker/src/email-handler.ts
git commit -m "feat: cancel sequences on inbound email"
```

---

## Task 8: Add Cancellation to Send Router (Outbound)

**Files:**
- Modify: `worker/src/routers/send-router.ts`

- [ ] **Step 1: Add cancellation check to compose-send handler**

Add import at top of `send-router.ts`:

```typescript
import { cancelSequencesForSender } from "../lib/cancel-sequence";
```

In the `sendEmailRoute` handler, after storing the sent email (after line 88), add:

```typescript
  // Cancel any active sequences for this recipient
  if (senderId) {
    await cancelSequencesForSender(db, senderId);
  }
```

Note: `senderId` is the variable already declared on line 72 as `existingSender[0]?.id ?? null`.

- [ ] **Step 2: Add cancellation check to reply handler**

In the `replyEmailRoute` handler, after storing the sent email (after line 182), add:

```typescript
  // Cancel any active sequences for this sender
  await cancelSequencesForSender(db, orig.senderId);
```

`orig.senderId` is the sender ID from the original email being replied to.

- [ ] **Step 3: Commit**

```bash
git add worker/src/routers/send-router.ts
git commit -m "feat: cancel sequences on outbound email"
```

---

## Task 9: Sequences CRUD Router

**Files:**
- Create: `worker/src/routers/sequences-router.ts`

- [ ] **Step 1: Create the router with sequence CRUD and enrollment endpoints**

```typescript
// worker/src/routers/sequences-router.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { sequences } from "../db/sequences.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { emailTemplates } from "../db/email-templates.schema";
import { senders } from "../db/senders.schema";
import { json200Response, json201Response } from "../lib/helpers";
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
        400
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
          400
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
        eq(sequenceEnrollments.status, "active")
      )
    )
    .limit(1);

  if (active.length > 0) {
    return c.json(
      { error: "Cannot delete sequence with active enrollments" },
      400
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
      "Sender enrolled"
    ),
  },
});

sequencesRouter.openapi(enrollRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const { senderId, variables, skipSteps, delayOverrides } =
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
        eq(sequenceEnrollments.status, "active")
      )
    )
    .limit(1);

  if (existingEnrollment.length > 0) {
    return c.json(
      { error: "Sender is already in an active sequence" },
      400
    );
  }

  const steps: Array<{
    order: number;
    templateSlug: string;
    delayHours: number;
  }> = JSON.parse(seqRows[0].steps);

  // Filter out skipped steps
  const activeSteps = steps.filter((s) => !skipSteps.includes(s.order));

  if (activeSteps.length === 0) {
    return c.json({ error: "At least one step must remain after skipping" }, 400);
  }

  // Create enrollment
  const enrollmentId = nanoid();
  const enrollment = {
    id: enrollmentId,
    sequenceId: id,
    senderId,
    status: "active",
    variables: JSON.stringify(variables),
    enrolledAt: now,
    cancelledAt: null,
  };
  await db.insert(sequenceEnrollments).values(enrollment);

  // Create outbox emails with computed schedule
  const baseTime = snapToNextHour(now);
  const scheduledEmails = [];

  for (const step of activeSteps) {
    const delayHours =
      step.order.toString() in delayOverrides
        ? delayOverrides[step.order.toString()]
        : step.delayHours;

    const scheduledAt = baseTime + delayHours * 3600;
    const emailId = nanoid();

    const emailRow = {
      id: emailId,
      enrollmentId,
      stepOrder: step.order,
      templateSlug: step.templateSlug,
      scheduledAt,
      status: "pending",
      sentAt: null,
      sentEmailId: null,
    };

    await db.insert(sequenceEmails).values(emailRow);
    scheduledEmails.push(emailRow);
  }

  return c.json(
    {
      enrollment: { ...enrollment, variables },
      scheduledEmails,
    },
    201
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
      "Enrollment details"
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
        eq(sequenceEnrollments.status, "active")
      )
    )
    .limit(1);

  if (enrollments.length === 0) {
    return c.json(
      { enrollment: null, scheduledEmails: [], sequenceName: null },
      200
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
    200
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
      "Enrollment cancelled"
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
        inArray(sequenceEmails.status, ["pending", "queued"])
      )
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
        })
      ),
      "Enrollment list"
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
```

Note: The `inArray` import is needed for the cancel enrollment route. Add it to the imports:

```typescript
import { eq, and, inArray } from "drizzle-orm";
```

- [ ] **Step 2: Commit**

```bash
git add worker/src/routers/sequences-router.ts
git commit -m "feat: add sequences CRUD and enrollment router"
```

---

## Task 10: Sequence Processor (Cron + Queue Consumer)

**Files:**
- Create: `worker/src/lib/sequence-processor.ts`

- [ ] **Step 1: Create the cron handler and queue consumer**

```typescript
// worker/src/lib/sequence-processor.ts
import { drizzle } from "drizzle-orm/d1";
import { eq, and, lte } from "drizzle-orm";
import { nanoid } from "nanoid";
import { Resend } from "resend";
import { schema } from "../db/schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { emailTemplates } from "../db/email-templates.schema";
import { senders } from "../db/senders.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { interpolate } from "./interpolate";

export interface SequenceEmailMessage {
  sequenceEmailId: string;
}

/**
 * Cron handler: find due pending emails and push them onto the queue.
 */
export async function handleScheduled(
  env: CloudflareBindings
): Promise<void> {
  const db = drizzle(env.DB, { schema });
  const now = Math.floor(Date.now() / 1000);

  // Find pending emails that are due
  const dueEmails = await db
    .select({ id: sequenceEmails.id })
    .from(sequenceEmails)
    .where(
      and(
        eq(sequenceEmails.status, "pending"),
        lte(sequenceEmails.scheduledAt, now)
      )
    );

  if (dueEmails.length === 0) return;

  // Push to queue and mark as queued
  for (const email of dueEmails) {
    const message: SequenceEmailMessage = { sequenceEmailId: email.id };
    await env.EMAIL_QUEUE.send(message);

    await db
      .update(sequenceEmails)
      .set({ status: "queued" })
      .where(eq(sequenceEmails.id, email.id));
  }

  console.log(`Queued ${dueEmails.length} sequence emails`);
}

/**
 * Queue consumer: process a batch of sequence email messages.
 */
export async function handleQueueBatch(
  batch: MessageBatch<SequenceEmailMessage>,
  env: CloudflareBindings
): Promise<void> {
  const db = drizzle(env.DB, { schema });
  const resend = new Resend(env.RESEND_API_KEY);
  const fromAddress = env.RESEND_EMAIL_FROM;

  for (const msg of batch.messages) {
    try {
      await processSequenceEmail(
        db,
        resend,
        fromAddress,
        msg.body.sequenceEmailId
      );
      msg.ack();
    } catch (err) {
      console.error(
        `Failed to process sequence email ${msg.body.sequenceEmailId}:`,
        err
      );
      msg.retry();
    }
  }
}

async function processSequenceEmail(
  db: ReturnType<typeof drizzle>,
  resend: Resend,
  fromAddress: string,
  sequenceEmailId: string
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

  // Fetch sender for auto-variables
  const senderRows = await db
    .select()
    .from(senders)
    .where(eq(senders.id, enrollment.senderId))
    .limit(1);

  if (senderRows.length === 0) {
    await db
      .update(sequenceEmails)
      .set({ status: "failed" })
      .where(eq(sequenceEmails.id, sequenceEmailId));
    return;
  }

  const sender = senderRows[0];

  // Merge variables: sender auto-vars + enrollment custom vars (custom wins)
  const customVars: Record<string, string> = JSON.parse(enrollment.variables);
  const mergedVars: Record<string, string> = {
    name: sender.name ?? "",
    email: sender.email,
    ...customVars,
  };

  // Interpolate template
  const renderedSubject = interpolate(template.subject, mergedVars);
  const renderedHtml = interpolate(template.bodyHtml, mergedVars);

  // Send via Resend
  const result = await resend.emails.send({
    from: fromAddress,
    to: sender.email,
    subject: renderedSubject,
    html: renderedHtml,
  });

  // Store sent email record
  const sentId = nanoid();
  await db.insert(sentEmails).values({
    id: sentId,
    senderId: sender.id,
    fromAddress,
    toAddress: sender.email,
    subject: renderedSubject,
    bodyHtml: renderedHtml,
    bodyText: null,
    resendId: result.data?.id ?? null,
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
        eq(sequenceEmails.status, "pending")
      )
    )
    .limit(1);

  // Also check for queued (other steps may still be in-flight)
  const remainingQueued = await db
    .select({ id: sequenceEmails.id })
    .from(sequenceEmails)
    .where(
      and(
        eq(sequenceEmails.enrollmentId, enrollment.id),
        eq(sequenceEmails.status, "queued")
      )
    )
    .limit(1);

  if (remainingPending.length === 0 && remainingQueued.length === 0) {
    await db
      .update(sequenceEnrollments)
      .set({ status: "completed" })
      .where(eq(sequenceEnrollments.id, enrollment.id));
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add worker/src/lib/sequence-processor.ts
git commit -m "feat: add sequence cron handler and queue consumer"
```

---

## Task 11: Register Router and Export Handlers in Worker Entry

**Files:**
- Modify: `worker/src/index.ts`

- [ ] **Step 1: Add imports**

Add to the import block at the top of `worker/src/index.ts`:

```typescript
import { sequencesRouter } from "./routers/sequences-router";
import { handleScheduled, handleQueueBatch } from "./lib/sequence-processor";
import type { SequenceEmailMessage } from "./lib/sequence-processor";
```

- [ ] **Step 2: Register the router**

Add after line 121 (`app.route("/api/invites", invitesRouter);`):

```typescript
app.route("/api/sequences", sequencesRouter);
```

- [ ] **Step 3: Add scheduled and queue handlers to the export**

Replace the export block (lines 142-145) with:

```typescript
export default {
  fetch: app.fetch,
  email: handleEmail,
  async scheduled(event: ScheduledEvent, env: CloudflareBindings, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(env));
  },
  async queue(batch: MessageBatch<SequenceEmailMessage>, env: CloudflareBindings) {
    await handleQueueBatch(batch, env);
  },
};
```

- [ ] **Step 4: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat: register sequences router and export cron/queue handlers"
```

---

## Task 12: Configure Wrangler — Queue Bindings and Cron Trigger

**Files:**
- Modify: `wrangler.jsonc`

- [ ] **Step 1: Add queue and cron configuration**

Add the following top-level properties to `wrangler.jsonc` (after the `observability` block):

```jsonc
  "queues": {
    "producers": [
      {
        "binding": "EMAIL_QUEUE",
        "queue": "cmail-sequence-emails"
      }
    ],
    "consumers": [
      {
        "queue": "cmail-sequence-emails",
        "max_batch_size": 10,
        "max_retries": 3
      }
    ]
  },
  "triggers": {
    "crons": ["0 * * * *"]
  }
```

- [ ] **Step 2: Commit**

```bash
git add wrangler.jsonc
git commit -m "feat: add queue bindings and hourly cron trigger to wrangler config"
```

---

## Task 13: Frontend API Client — Sequence Functions

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add types and API functions for sequences**

Add at the end of `src/lib/api.ts`:

```typescript
// --- Sequences ---

export interface SequenceStep {
  order: number;
  templateSlug: string;
  delayHours: number;
}

export interface Sequence {
  id: string;
  name: string;
  steps: SequenceStep[];
  createdAt: number;
  updatedAt: number;
}

export interface SequenceEmail {
  id: string;
  enrollmentId: string;
  stepOrder: number;
  templateSlug: string;
  scheduledAt: number;
  status: string;
  sentAt: number | null;
  sentEmailId: string | null;
}

export interface SequenceEnrollment {
  id: string;
  sequenceId: string;
  senderId: string;
  status: string;
  variables: Record<string, string>;
  enrolledAt: number;
  cancelledAt: number | null;
}

export interface EnrollmentWithDetails extends SequenceEnrollment {
  senderEmail: string;
  senderName: string | null;
  totalSteps: number;
  sentSteps: number;
}

export interface SenderEnrollmentInfo {
  enrollment: SequenceEnrollment | null;
  scheduledEmails: SequenceEmail[];
  sequenceName: string | null;
}

export async function fetchSequences(): Promise<Sequence[]> {
  return apiFetch("/api/sequences");
}

export async function fetchSequence(id: string): Promise<Sequence> {
  return apiFetch(`/api/sequences/${id}`);
}

export async function createSequence(data: {
  name: string;
  steps: SequenceStep[];
}): Promise<Sequence> {
  return apiFetch("/api/sequences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function updateSequence(
  id: string,
  data: { name?: string; steps?: SequenceStep[] }
): Promise<Sequence> {
  return apiFetch(`/api/sequences/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function deleteSequence(
  id: string
): Promise<{ success: boolean }> {
  return apiFetch(`/api/sequences/${id}`, { method: "DELETE" });
}

export async function enrollSender(
  sequenceId: string,
  data: {
    senderId: string;
    variables?: Record<string, string>;
    skipSteps?: number[];
    delayOverrides?: Record<string, number>;
  }
): Promise<{
  enrollment: SequenceEnrollment;
  scheduledEmails: SequenceEmail[];
}> {
  return apiFetch(`/api/sequences/${sequenceId}/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function fetchSenderEnrollment(
  senderId: string
): Promise<SenderEnrollmentInfo> {
  return apiFetch(`/api/sequences/senders/${senderId}/enrollment`);
}

export async function cancelEnrollment(
  enrollmentId: string
): Promise<{ success: boolean }> {
  return apiFetch(`/api/sequences/enrollments/${enrollmentId}`, {
    method: "DELETE",
  });
}

export async function fetchSequenceEnrollments(
  sequenceId: string
): Promise<EnrollmentWithDetails[]> {
  return apiFetch(`/api/sequences/${sequenceId}/enrollments`);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat: add sequence API client functions"
```

---

## Task 14: Sidebar Navigation — Add Sequences

**Files:**
- Modify: `src/components/Sidebar.tsx`

- [ ] **Step 1: Add Sequences nav item**

Add `ListOrdered` to the lucide-react import on line 2:

```typescript
import { Mail, FileText, Key, Users, PenSquare, LogOut, ListOrdered } from "lucide-react";
```

Add to the `navItems` array (after the Templates entry, before API):

```typescript
  { icon: ListOrdered, label: "Sequences", path: "/sequences" },
```

- [ ] **Step 2: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat: add sequences to sidebar navigation"
```

---

## Task 15: React Router — Add Sequence Routes

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add imports for sequence pages**

Add to the import block:

```typescript
import SequencesPage from "@/pages/SequencesPage";
import SequenceDetailPage from "@/pages/SequenceDetailPage";
import SequenceEditorPage from "@/pages/SequenceEditorPage";
```

- [ ] **Step 2: Add routes inside the DashboardLayout group**

Add after the templates routes (after line 74):

```typescript
              <Route path="/sequences" element={<SequencesPage />} />
              <Route path="/sequences/new" element={<SequenceEditorPage />} />
              <Route path="/sequences/:id/edit" element={<SequenceEditorPage />} />
              <Route path="/sequences/:id" element={<SequenceDetailPage />} />
```

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat: add sequence page routes"
```

---

## Task 16: Sequences List Page

**Files:**
- Create: `src/pages/SequencesPage.tsx`

- [ ] **Step 1: Create the sequences list page**

```tsx
// src/pages/SequencesPage.tsx
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { fetchSequences, deleteSequence, type Sequence } from "@/lib/api";

export default function SequencesPage() {
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetchSequences()
      .then(setSequences)
      .finally(() => setLoading(false));
  }, []);

  async function handleDelete(id: string) {
    if (!confirm("Delete this sequence?")) return;
    try {
      await deleteSequence(id);
      setSequences((prev) => prev.filter((s) => s.id !== id));
    } catch {
      alert("Cannot delete — sequence may have active enrollments.");
    }
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Sequences</h1>
        <button
          onClick={() => navigate("/sequences/new")}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90"
        >
          New Sequence
        </button>
      </div>

      {loading ? (
        <p className="text-text-secondary">Loading...</p>
      ) : sequences.length === 0 ? (
        <p className="text-text-secondary">No sequences yet.</p>
      ) : (
        <div className="space-y-2">
          {sequences.map((seq) => (
            <div
              key={seq.id}
              className="flex items-center justify-between rounded-lg border border-border-dark bg-card px-4 py-3"
            >
              <div
                className="cursor-pointer"
                onClick={() => navigate(`/sequences/${seq.id}`)}
              >
                <p className="font-medium text-text-primary">{seq.name}</p>
                <p className="text-xs text-text-secondary">
                  {seq.steps.length} step{seq.steps.length !== 1 ? "s" : ""}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => navigate(`/sequences/${seq.id}/edit`)}
                  className="rounded-md border border-border-dark px-2 py-1 text-xs text-text-secondary hover:bg-hover"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(seq.id)}
                  className="rounded-md border border-border-dark px-2 py-1 text-xs text-red-400 hover:bg-hover"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/SequencesPage.tsx
git commit -m "feat: add sequences list page"
```

---

## Task 17: Sequence Editor Page (Create/Edit)

**Files:**
- Create: `src/pages/SequenceEditorPage.tsx`

- [ ] **Step 1: Create the sequence editor page**

```tsx
// src/pages/SequenceEditorPage.tsx
import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  fetchSequence,
  fetchTemplates,
  createSequence,
  updateSequence,
  type SequenceStep,
  type EmailTemplate,
} from "@/lib/api";

export default function SequenceEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEditing = Boolean(id);

  const [name, setName] = useState("");
  const [steps, setSteps] = useState<SequenceStep[]>([
    { order: 1, templateSlug: "", delayHours: 0 },
  ]);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const load = async () => {
      const tmpls = await fetchTemplates();
      setTemplates(tmpls);

      if (id) {
        const seq = await fetchSequence(id);
        setName(seq.name);
        setSteps(seq.steps);
      }
      setLoading(false);
    };
    load();
  }, [id]);

  function addStep() {
    const maxOrder = steps.length > 0 ? Math.max(...steps.map((s) => s.order)) : 0;
    setSteps([...steps, { order: maxOrder + 1, templateSlug: "", delayHours: 24 }]);
  }

  function removeStep(order: number) {
    if (steps.length <= 1) return;
    setSteps(steps.filter((s) => s.order !== order));
  }

  function updateStep(order: number, field: keyof SequenceStep, value: any) {
    setSteps(
      steps.map((s) => (s.order === order ? { ...s, [field]: value } : s))
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || steps.some((s) => !s.templateSlug)) return;

    setSaving(true);
    try {
      if (isEditing && id) {
        await updateSequence(id, { name, steps });
      } else {
        await createSequence({ name, steps });
      }
      navigate("/sequences");
    } catch (err) {
      alert("Failed to save sequence.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex-1 p-6">
        <p className="text-text-secondary">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <h1 className="mb-6 text-xl font-semibold text-text-primary">
        {isEditing ? "Edit Sequence" : "New Sequence"}
      </h1>

      <form onSubmit={handleSubmit} className="max-w-2xl space-y-6">
        <div>
          <label className="mb-1 block text-sm font-medium text-text-secondary">
            Sequence Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Welcome Sequence"
            className="w-full rounded-md border border-border-dark bg-card px-3 py-2 text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none"
            required
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-text-secondary">
            Steps
          </label>
          <div className="space-y-3">
            {steps.map((step, idx) => (
              <div
                key={step.order}
                className="flex items-center gap-3 rounded-lg border border-border-dark bg-card p-3"
              >
                <span className="text-xs font-medium text-text-tertiary">
                  #{idx + 1}
                </span>
                <select
                  value={step.templateSlug}
                  onChange={(e) =>
                    updateStep(step.order, "templateSlug", e.target.value)
                  }
                  className="flex-1 rounded-md border border-border-dark bg-main px-2 py-1.5 text-sm text-text-primary"
                  required
                >
                  <option value="">Select template...</option>
                  {templates.map((t) => (
                    <option key={t.slug} value={t.slug}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={0}
                    value={step.delayHours}
                    onChange={(e) =>
                      updateStep(
                        step.order,
                        "delayHours",
                        parseInt(e.target.value) || 0
                      )
                    }
                    className="w-20 rounded-md border border-border-dark bg-main px-2 py-1.5 text-sm text-text-primary"
                  />
                  <span className="text-xs text-text-tertiary">hrs delay</span>
                </div>
                <button
                  type="button"
                  onClick={() => removeStep(step.order)}
                  className="text-xs text-red-400 hover:text-red-300"
                  disabled={steps.length <= 1}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={addStep}
            className="mt-2 text-xs text-accent hover:underline"
          >
            + Add step
          </button>
        </div>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {saving ? "Saving..." : isEditing ? "Update" : "Create"}
          </button>
          <button
            type="button"
            onClick={() => navigate("/sequences")}
            className="rounded-md border border-border-dark px-4 py-2 text-sm text-text-secondary hover:bg-hover"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/SequenceEditorPage.tsx
git commit -m "feat: add sequence editor page (create/edit)"
```

---

## Task 18: Sequence Detail Page (Enrollments View)

**Files:**
- Create: `src/pages/SequenceDetailPage.tsx`

- [ ] **Step 1: Create the sequence detail page**

```tsx
// src/pages/SequenceDetailPage.tsx
import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  fetchSequence,
  fetchSequenceEnrollments,
  cancelEnrollment,
  type Sequence,
  type EnrollmentWithDetails,
} from "@/lib/api";

function statusBadge(status: string) {
  const colors: Record<string, string> = {
    active: "bg-green-900/50 text-green-400",
    completed: "bg-blue-900/50 text-blue-400",
    cancelled: "bg-red-900/50 text-red-400",
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${colors[status] ?? "bg-gray-800 text-gray-400"}`}
    >
      {status}
    </span>
  );
}

export default function SequenceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [sequence, setSequence] = useState<Sequence | null>(null);
  const [enrollments, setEnrollments] = useState<EnrollmentWithDetails[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    Promise.all([fetchSequence(id), fetchSequenceEnrollments(id)])
      .then(([seq, enrs]) => {
        setSequence(seq);
        setEnrollments(enrs);
      })
      .finally(() => setLoading(false));
  }, [id]);

  async function handleCancel(enrollmentId: string) {
    if (!confirm("Cancel this enrollment?")) return;
    await cancelEnrollment(enrollmentId);
    setEnrollments((prev) =>
      prev.map((e) =>
        e.id === enrollmentId ? { ...e, status: "cancelled" } : e
      )
    );
  }

  if (loading || !sequence) {
    return (
      <div className="flex-1 p-6">
        <p className="text-text-secondary">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mb-6">
        <button
          onClick={() => navigate("/sequences")}
          className="mb-2 text-xs text-text-tertiary hover:text-text-secondary"
        >
          &larr; Back to Sequences
        </button>
        <h1 className="text-xl font-semibold text-text-primary">
          {sequence.name}
        </h1>
        <p className="text-sm text-text-secondary">
          {sequence.steps.length} step{sequence.steps.length !== 1 ? "s" : ""}
        </p>
      </div>

      {/* Steps preview */}
      <div className="mb-8">
        <h2 className="mb-3 text-sm font-medium text-text-secondary">Steps</h2>
        <div className="space-y-1">
          {sequence.steps.map((step, idx) => (
            <div
              key={step.order}
              className="flex items-center gap-3 rounded border border-border-dark bg-card px-3 py-2 text-sm"
            >
              <span className="text-text-tertiary">#{idx + 1}</span>
              <span className="text-text-primary">{step.templateSlug}</span>
              <span className="text-text-tertiary">
                {step.delayHours === 0
                  ? "immediately"
                  : `after ${step.delayHours}h`}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Enrollments */}
      <div>
        <h2 className="mb-3 text-sm font-medium text-text-secondary">
          Enrollments ({enrollments.length})
        </h2>
        {enrollments.length === 0 ? (
          <p className="text-sm text-text-tertiary">No enrollments yet.</p>
        ) : (
          <div className="space-y-2">
            {enrollments.map((enr) => (
              <div
                key={enr.id}
                className="flex items-center justify-between rounded-lg border border-border-dark bg-card px-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium text-text-primary">
                    {enr.senderName ?? enr.senderEmail}
                  </p>
                  <p className="text-xs text-text-secondary">
                    {enr.senderEmail} &middot; {enr.sentSteps}/{enr.totalSteps}{" "}
                    sent
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {statusBadge(enr.status)}
                  {enr.status === "active" && (
                    <button
                      onClick={() => handleCancel(enr.id)}
                      className="text-xs text-red-400 hover:text-red-300"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/SequenceDetailPage.tsx
git commit -m "feat: add sequence detail page with enrollments view"
```

---

## Task 19: Enrollment Modal Component

**Files:**
- Create: `src/components/EnrollSequenceModal.tsx`

- [ ] **Step 1: Create the enrollment modal**

```tsx
// src/components/EnrollSequenceModal.tsx
import { useState, useEffect } from "react";
import {
  fetchSequences,
  enrollSender,
  type Sequence,
  type SequenceStep,
} from "@/lib/api";

interface EnrollSequenceModalProps {
  senderId: string;
  senderName: string | null;
  senderEmail: string;
  open: boolean;
  onClose: () => void;
  onEnrolled: () => void;
}

export default function EnrollSequenceModal({
  senderId,
  senderName,
  senderEmail,
  open,
  onClose,
  onEnrolled,
}: EnrollSequenceModalProps) {
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [skipSteps, setSkipSteps] = useState<number[]>([]);
  const [delayOverrides, setDelayOverrides] = useState<Record<string, number>>(
    {}
  );
  const [variables, setVariables] = useState<Array<{ key: string; value: string }>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open) return;
    setSelectedId("");
    setSkipSteps([]);
    setDelayOverrides({});
    setVariables([]);
    fetchSequences()
      .then(setSequences)
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  const selectedSequence = sequences.find((s) => s.id === selectedId);

  function toggleSkip(order: number) {
    setSkipSteps((prev) =>
      prev.includes(order)
        ? prev.filter((o) => o !== order)
        : [...prev, order]
    );
  }

  function setDelay(order: number, hours: number) {
    setDelayOverrides((prev) => ({ ...prev, [order.toString()]: hours }));
  }

  function addVariable() {
    setVariables([...variables, { key: "", value: "" }]);
  }

  function updateVariable(idx: number, field: "key" | "value", val: string) {
    setVariables(
      variables.map((v, i) => (i === idx ? { ...v, [field]: val } : v))
    );
  }

  function removeVariable(idx: number) {
    setVariables(variables.filter((_, i) => i !== idx));
  }

  async function handleSubmit() {
    if (!selectedId) return;
    setSubmitting(true);

    const varsObj: Record<string, string> = {};
    for (const v of variables) {
      if (v.key.trim()) varsObj[v.key.trim()] = v.value;
    }

    try {
      await enrollSender(selectedId, {
        senderId,
        variables: varsObj,
        skipSteps,
        delayOverrides,
      });
      onEnrolled();
      onClose();
    } catch (err: any) {
      alert(err.message || "Failed to enroll sender.");
    } finally {
      setSubmitting(false);
    }
  }

  const activeStepCount = selectedSequence
    ? selectedSequence.steps.filter((s) => !skipSteps.includes(s.order)).length
    : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-lg rounded-xl border border-border-dark bg-card p-6">
        <h2 className="mb-1 text-lg font-semibold text-text-primary">
          Add to Sequence
        </h2>
        <p className="mb-4 text-sm text-text-secondary">
          {senderName ?? senderEmail}
        </p>

        {loading ? (
          <p className="text-text-secondary">Loading sequences...</p>
        ) : (
          <>
            {/* Sequence picker */}
            <select
              value={selectedId}
              onChange={(e) => {
                setSelectedId(e.target.value);
                setSkipSteps([]);
                setDelayOverrides({});
              }}
              className="mb-4 w-full rounded-md border border-border-dark bg-main px-3 py-2 text-sm text-text-primary"
            >
              <option value="">Select a sequence...</option>
              {sequences.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.steps.length} steps)
                </option>
              ))}
            </select>

            {/* Step preview with overrides */}
            {selectedSequence && (
              <div className="mb-4">
                <p className="mb-2 text-xs font-medium text-text-secondary">
                  Steps
                </p>
                <div className="space-y-2">
                  {selectedSequence.steps.map((step, idx) => {
                    const skipped = skipSteps.includes(step.order);
                    const delay =
                      step.order.toString() in delayOverrides
                        ? delayOverrides[step.order.toString()]
                        : step.delayHours;
                    return (
                      <div
                        key={step.order}
                        className={`flex items-center gap-2 rounded border border-border-dark px-3 py-2 text-sm ${skipped ? "opacity-40" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={!skipped}
                          onChange={() => toggleSkip(step.order)}
                          className="accent-accent"
                        />
                        <span className="text-text-tertiary">#{idx + 1}</span>
                        <span className="flex-1 text-text-primary">
                          {step.templateSlug}
                        </span>
                        <input
                          type="number"
                          min={0}
                          value={delay}
                          onChange={(e) =>
                            setDelay(step.order, parseInt(e.target.value) || 0)
                          }
                          className="w-16 rounded border border-border-dark bg-main px-1 py-0.5 text-xs text-text-primary"
                          disabled={skipped}
                        />
                        <span className="text-xs text-text-tertiary">hrs</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Custom variables */}
            <div className="mb-4">
              <p className="mb-2 text-xs font-medium text-text-secondary">
                Custom Variables
              </p>
              {variables.map((v, idx) => (
                <div key={idx} className="mb-1 flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="key"
                    value={v.key}
                    onChange={(e) => updateVariable(idx, "key", e.target.value)}
                    className="w-28 rounded border border-border-dark bg-main px-2 py-1 text-xs text-text-primary"
                  />
                  <input
                    type="text"
                    placeholder="value"
                    value={v.value}
                    onChange={(e) =>
                      updateVariable(idx, "value", e.target.value)
                    }
                    className="flex-1 rounded border border-border-dark bg-main px-2 py-1 text-xs text-text-primary"
                  />
                  <button
                    type="button"
                    onClick={() => removeVariable(idx)}
                    className="text-xs text-red-400"
                  >
                    &times;
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addVariable}
                className="text-xs text-accent hover:underline"
              >
                + Add variable
              </button>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3">
              <button
                onClick={onClose}
                className="rounded-md border border-border-dark px-3 py-1.5 text-sm text-text-secondary hover:bg-hover"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={!selectedId || submitting || activeStepCount === 0}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
              >
                {submitting ? "Enrolling..." : "Enroll"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/EnrollSequenceModal.tsx
git commit -m "feat: add enrollment modal component"
```

---

## Task 20: Sequence Status Component

**Files:**
- Create: `src/components/SequenceStatus.tsx`

- [ ] **Step 1: Create the sequence status display**

```tsx
// src/components/SequenceStatus.tsx
import { useState, useEffect } from "react";
import {
  fetchSenderEnrollment,
  cancelEnrollment,
  type SenderEnrollmentInfo,
} from "@/lib/api";

interface SequenceStatusProps {
  senderId: string;
  onStatusChange: () => void;
}

export default function SequenceStatus({
  senderId,
  onStatusChange,
}: SequenceStatusProps) {
  const [info, setInfo] = useState<SenderEnrollmentInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchSenderEnrollment(senderId)
      .then(setInfo)
      .finally(() => setLoading(false));
  }, [senderId]);

  if (loading || !info || !info.enrollment) return null;

  const sent = info.scheduledEmails.filter((e) => e.status === "sent").length;
  const total = info.scheduledEmails.length;
  const nextPending = info.scheduledEmails.find(
    (e) => e.status === "pending" || e.status === "queued"
  );

  async function handleCancel() {
    if (!info?.enrollment) return;
    if (!confirm("Cancel this sequence?")) return;
    await cancelEnrollment(info.enrollment.id);
    onStatusChange();
    setInfo({ ...info, enrollment: null, scheduledEmails: [], sequenceName: null });
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-green-800/50 bg-green-900/20 px-3 py-2 text-sm">
      <div className="flex-1">
        <p className="font-medium text-green-400">
          Sequence: {info.sequenceName}
        </p>
        <p className="text-xs text-text-secondary">
          {sent}/{total} sent
          {nextPending &&
            ` · Next: ${new Date(nextPending.scheduledAt * 1000).toLocaleString()}`}
        </p>
      </div>
      <button
        onClick={handleCancel}
        className="text-xs text-red-400 hover:text-red-300"
      >
        Cancel
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/SequenceStatus.tsx
git commit -m "feat: add sequence status component for sender detail"
```

---

## Task 21: Integrate Sequence UI into Sender Detail

**Files:**
- Modify: `src/pages/SenderDetail.tsx`

- [ ] **Step 1: Add imports**

Add to the imports:

```typescript
import EnrollSequenceModal from "@/components/EnrollSequenceModal";
import SequenceStatus from "@/components/SequenceStatus";
import { fetchSenderEnrollment, type SenderEnrollmentInfo } from "@/lib/api";
```

- [ ] **Step 2: Add state for sequence modal and enrollment status**

Inside the `SenderDetail` component, add after the existing state declarations:

```typescript
  const [enrollModalOpen, setEnrollModalOpen] = useState(false);
  const [enrollmentInfo, setEnrollmentInfo] = useState<SenderEnrollmentInfo | null>(null);
```

- [ ] **Step 3: Add effect to load enrollment status**

Add after the existing useEffect:

```typescript
  useEffect(() => {
    fetchSenderEnrollment(sender.id).then(setEnrollmentInfo);
  }, [sender.id]);

  function refreshEnrollment() {
    fetchSenderEnrollment(sender.id).then(setEnrollmentInfo);
  }
```

- [ ] **Step 4: Add sequence UI to the sender detail header area**

Find the header/toolbar area of SenderDetail (the section showing the sender's name and email at the top). Add after it:

```tsx
      {/* Sequence status or enroll button */}
      <div className="px-4 py-2">
        {enrollmentInfo?.enrollment ? (
          <SequenceStatus
            senderId={sender.id}
            onStatusChange={refreshEnrollment}
          />
        ) : (
          <button
            onClick={() => setEnrollModalOpen(true)}
            className="rounded-md border border-border-dark px-3 py-1.5 text-xs text-text-secondary hover:bg-hover"
          >
            Add to Sequence
          </button>
        )}
      </div>
```

- [ ] **Step 5: Add the enrollment modal**

Add before the closing fragment or at the end of the component JSX:

```tsx
      <EnrollSequenceModal
        senderId={sender.id}
        senderName={sender.name}
        senderEmail={sender.email}
        open={enrollModalOpen}
        onClose={() => setEnrollModalOpen(false)}
        onEnrolled={refreshEnrollment}
      />
```

- [ ] **Step 6: Commit**

```bash
git add src/pages/SenderDetail.tsx
git commit -m "feat: integrate sequence status and enrollment into sender detail"
```

---

## Task 22: Verify Build

- [ ] **Step 1: Run the build**

Run: `npm run build`

Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 2: Fix any build errors**

If there are errors, fix them and re-run. Common issues:
- Missing `inArray` import in sequences-router (should be imported from `drizzle-orm`)
- CloudflareBindings type may need `EMAIL_QUEUE` added — check if there's a `worker-configuration.d.ts` or similar type file that auto-generates from wrangler.jsonc

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve build errors"
```

---

## Task 23: Create Cloudflare Queue (Production)

- [ ] **Step 1: Create the queue on Cloudflare**

Run: `npx wrangler queues create cmail-sequence-emails`

Expected: Queue created successfully.

- [ ] **Step 2: Apply migration to production**

Run: `npm run db:migrate:prod`

Expected: Migration applied successfully.

- [ ] **Step 3: Deploy**

Run: `npx wrangler deploy`

Expected: Worker deployed with queue bindings and cron trigger active.
