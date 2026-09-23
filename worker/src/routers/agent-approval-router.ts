import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { users } from "../db/auth.schema";
import { listMembers } from "../db/list-members.schema";
import { lists } from "../db/lists.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequences } from "../db/sequences.schema";
import { latestAllowedInboxForPerson } from "../lib/agent/crm";
import {
  inboxFilter,
  isInboxAllowed,
  resolveAllowedInboxes,
} from "../lib/inbox-permissions";
import { queryMessages } from "../lib/messages/query";
import { parseMessageRef } from "../lib/messages/types";
import { getPersonScoped } from "../lib/queries/people";
import { bearerSecurity } from "../lib/openapi-auth";
import { isSuppressed } from "../lib/suppressions";
import type { Variables } from "../variables";

export const agentApprovalRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const ApprovalToolNameSchema = z.enum([
  "enroll_in_sequence",
  "cancel_sequence_enrollment",
  "add_to_list",
  "assign_conversation",
  "link_customer",
]);

const ApprovalSummaryRequestSchema = z.object({
  toolName: ApprovalToolNameSchema,
  input: z.record(z.string(), z.unknown()),
});
const ApprovalSummaryResponseSchema = z.object({ summary: z.string() });

function notFound() {
  return { error: "Approval target not found" } as const;
}

function stringInput(
  input: Record<string, unknown>,
  key: string,
): string | null {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sequenceDuration(steps: Array<{ delayHours?: number }>): string {
  if (steps.length <= 1) return "";
  const hours = steps.reduce(
    (sum, step) =>
      sum +
      (typeof step.delayHours === "number" && step.delayHours > 0
        ? step.delayHours
        : 0),
    0,
  );
  if (hours === 0) return "";
  if (hours % 24 === 0) {
    const days = hours / 24;
    return ` over ${days} day${days === 1 ? "" : "s"}`;
  }
  return ` over ${hours} hour${hours === 1 ? "" : "s"}`;
}

const summaryRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Agent"],
  security: bearerSecurity,
  description:
    "Build a permission-checked, database-derived summary for a pending CRM tool approval.",
  request: {
    body: {
      content: {
        "application/json": { schema: ApprovalSummaryRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Approval summary",
      content: {
        "application/json": { schema: ApprovalSummaryResponseSchema },
      },
    },
    404: {
      description: "Unknown or invisible approval target",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
  },
});

agentApprovalRouter.openapi(summaryRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const user = c.get("user");
  const { toolName, input } = c.req.valid("json");

  if (toolName === "enroll_in_sequence") {
    const personId = stringInput(input, "personId");
    const sequenceId = stringInput(input, "sequenceId");
    if (!personId || !sequenceId) return c.json(notFound(), 404);
    const [person, sequenceRows] = await Promise.all([
      getPersonScoped(db, personId, allowed),
      db
        .select({ name: sequences.name, steps: sequences.steps })
        .from(sequences)
        .where(eq(sequences.id, sequenceId))
        .limit(1),
    ]);
    const sequence = sequenceRows[0];
    if (!person || !sequence) return c.json(notFound(), 404);

    let fromAddress: string;
    try {
      fromAddress = await latestAllowedInboxForPerson(db, personId, allowed);
    } catch {
      return c.json(notFound(), 404);
    }

    let steps: Array<{ delayHours?: number }> = [];
    try {
      steps = JSON.parse(sequence.steps);
    } catch {
      return c.json(notFound(), 404);
    }
    const count = steps.length;
    return c.json(
      {
        summary: `Enroll ${person.email} in '${sequence.name}' from ${fromAddress} (${count} email${count === 1 ? "" : "s"}${sequenceDuration(steps)})`,
      },
      200,
    );
  }

  if (toolName === "cancel_sequence_enrollment") {
    const personId = stringInput(input, "personId");
    if (!personId) return c.json(notFound(), 404);
    const person = await getPersonScoped(db, personId, allowed);
    if (!person) return c.json(notFound(), 404);

    const rows = await db
      .select({ sequenceId: sequenceEnrollments.sequenceId })
      .from(sequenceEnrollments)
      .where(
        and(
          eq(sequenceEnrollments.personId, personId),
          eq(sequenceEnrollments.status, "active"),
          inboxFilter(allowed, sequenceEnrollments.fromAddress),
        ),
      )
      .limit(1);
    if (!rows[0]) {
      return c.json(
        { summary: `Cancel active sequence enrollment for ${person.email}` },
        200,
      );
    }
    const [sequence] = await db
      .select({ name: sequences.name })
      .from(sequences)
      .where(eq(sequences.id, rows[0].sequenceId))
      .limit(1);
    return c.json(
      {
        summary: sequence
          ? `Cancel ${person.email} from '${sequence.name}'`
          : `Cancel active sequence enrollment for ${person.email}`,
      },
      200,
    );
  }

  if (toolName === "add_to_list") {
    const personId = stringInput(input, "personId");
    const listId = stringInput(input, "listId");
    if (!personId || !listId) return c.json(notFound(), 404);
    const [person, listRows] = await Promise.all([
      getPersonScoped(db, personId, allowed),
      db
        .select({
          name: lists.name,
          fromAddress: lists.fromAddress,
          archivedAt: lists.archivedAt,
        })
        .from(lists)
        .where(eq(lists.id, listId))
        .limit(1),
    ]);
    const list = listRows[0];
    if (
      !person ||
      !list ||
      list.archivedAt !== null ||
      !isInboxAllowed(allowed, list.fromAddress)
    ) {
      return c.json(notFound(), 404);
    }
    const normalizedEmail = person.email.trim().toLowerCase();
    const [existing] = await db
      .select({ status: listMembers.status })
      .from(listMembers)
      .where(
        and(
          eq(listMembers.listId, listId),
          eq(listMembers.email, normalizedEmail),
        ),
      )
      .limit(1);

    if (existing?.status === "unsubscribed") {
      return c.json(
        {
          summary: `Can't add: ${person.email} unsubscribed from '${list.name}'`,
        },
        200,
      );
    }
    if (await isSuppressed(db, normalizedEmail)) {
      return c.json(
        {
          summary: `Can't add: ${person.email} is suppressed from '${list.name}'`,
        },
        200,
      );
    }
    if (existing?.status === "subscribed") {
      return c.json(
        {
          summary: `${person.email} is already subscribed to list '${list.name}'`,
        },
        200,
      );
    }
    if (existing?.status === "pending") {
      return c.json(
        {
          summary: `${person.email} is already pending on list '${list.name}'`,
        },
        200,
      );
    }

    return c.json(
      { summary: `Add ${person.email} to list '${list.name}'` },
      200,
    );
  }

  if (toolName === "assign_conversation") {
    const refValue = stringInput(input, "ref");
    if (!refValue) return c.json(notFound(), 404);
    const ref = parseMessageRef(refValue);
    if (!ref) return c.json(notFound(), 404);
    const page = await queryMessages(db, allowed, {
      messageRef: ref,
      limit: 1,
      viewer: { userId: user.id },
    });
    const message = page.messages[0];
    if (!message) return c.json(notFound(), 404);

    const userIdValue = input.userId;
    if (userIdValue === null) {
      return c.json({ summary: "Unassign this conversation" }, 200);
    }
    if (typeof userIdValue !== "string" || !userIdValue.trim()) {
      return c.json(notFound(), 404);
    }
    const [assignee] = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
      })
      .from(users)
      .where(eq(users.id, userIdValue))
      .limit(1);
    if (!assignee) return c.json(notFound(), 404);
    const assigneeAllowed = await resolveAllowedInboxes(db, assignee);
    if (!isInboxAllowed(assigneeAllowed, message.inbox)) {
      return c.json(notFound(), 404);
    }
    return c.json(
      {
        summary: `Assign this conversation to ${assignee.name || assignee.email}`,
      },
      200,
    );
  }

  const personId = stringInput(input, "personId");
  const otherPersonId = stringInput(input, "otherPersonId");
  if (!personId || !otherPersonId) return c.json(notFound(), 404);
  const [person, other] = await Promise.all([
    getPersonScoped(db, personId, allowed),
    getPersonScoped(db, otherPersonId, allowed),
  ]);
  if (!person || !other) return c.json(notFound(), 404);
  return c.json(
    {
      summary: `Link ${person.email} and ${other.email} as one customer`,
    },
    200,
  );
});
