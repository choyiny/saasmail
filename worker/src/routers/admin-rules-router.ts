import { AUDIT_ACTIONS } from "../lib/audit/events";
import { recordAudit } from "../lib/audit/record";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { attachments } from "../db/attachments.schema";
import { users } from "../db/auth.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { mailboxes } from "../db/mailboxes.schema";
import { emails } from "../db/emails.schema";
import { people } from "../db/people.schema";
import { rules } from "../db/rules.schema";
import { matchConditions } from "../lib/rules/match";
import {
  RuleActionSchema,
  RuleActionsSchema,
  RuleConditionSchema,
  RuleConditionsSchema,
} from "../lib/rules/types";
import { InvalidRuleError, validateRuleActions } from "../lib/rules/validation";
import type { Variables } from "../variables";

export const adminRulesRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const ErrorSchema = z.object({ error: z.string() });
const RuleWarningSchema = z.object({
  actionIndex: z.number().int().nonnegative(),
  code: z.enum(["missing_folder", "assignee_unavailable"]),
});
type RuleWarning = z.infer<typeof RuleWarningSchema>;

const RuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  inbox: z.string().nullable(),
  trigger: z.literal("message.received"),
  conditions: z.array(RuleConditionSchema),
  actions: z.array(RuleActionSchema),
  warnings: z.array(RuleWarningSchema),
  position: z.number().int(),
  stopProcessing: z.boolean(),
  enabled: z.boolean(),
  matchCount: z.number().int(),
  lastMatchedAt: z.number().int().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const inboxSchema = z.string().min(1).max(500).nullable();
const CreateRuleSchema = z.object({
  name: z.string().min(1).max(500),
  inbox: inboxSchema.default(null),
  trigger: z.literal("message.received").default("message.received"),
  conditions: RuleConditionsSchema,
  actions: RuleActionsSchema,
  position: z.number().int(),
  stopProcessing: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

const UpdateRuleSchema = z
  .object({
    name: z.string().min(1).max(500).optional(),
    inbox: inboxSchema.optional(),
    trigger: z.literal("message.received").optional(),
    conditions: RuleConditionsSchema.optional(),
    actions: RuleActionsSchema.optional(),
    position: z.number().int().optional(),
    stopProcessing: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });

const WARNING_LOOKUP_BATCH_SIZE = 40;

function apiRule(
  row: typeof rules.$inferSelect,
  warnings: RuleWarning[] = [],
): z.infer<typeof RuleSchema> {
  return {
    ...row,
    trigger: "message.received",
    warnings,
    stopProcessing: row.stopProcessing === 1,
    enabled: row.enabled === 1,
  };
}

async function computeRuleWarnings(
  db: DrizzleD1Database<any>,
  rows: Array<typeof rules.$inferSelect>,
): Promise<Map<string, RuleWarning[]>> {
  const folderIds = new Set<string>();
  const assigneeIds = new Set<string>();
  for (const row of rows) {
    for (const action of row.actions) {
      if (action.type === "move_to_folder") folderIds.add(action.mailboxId);
      if (action.type === "assign") assigneeIds.add(action.userId);
    }
  }

  const mailboxById = new Map<string, { id: string; inbox: string }>();
  const folderList = [...folderIds];
  for (
    let start = 0;
    start < folderList.length;
    start += WARNING_LOOKUP_BATCH_SIZE
  ) {
    const batch = folderList.slice(start, start + WARNING_LOOKUP_BATCH_SIZE);
    const found = await db
      .select({ id: mailboxes.id, inbox: mailboxes.inbox })
      .from(mailboxes)
      .where(inArray(mailboxes.id, batch));
    for (const mailbox of found) mailboxById.set(mailbox.id, mailbox);
  }

  const userById = new Map<string, { id: string; role: string | null }>();
  const assigneeList = [...assigneeIds];
  for (
    let start = 0;
    start < assigneeList.length;
    start += WARNING_LOOKUP_BATCH_SIZE
  ) {
    const batch = assigneeList.slice(start, start + WARNING_LOOKUP_BATCH_SIZE);
    const found = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(inArray(users.id, batch));
    for (const user of found) userById.set(user.id, user);
  }

  const permissionsByUser = new Map<string, Set<string>>();
  for (
    let start = 0;
    start < assigneeList.length;
    start += WARNING_LOOKUP_BATCH_SIZE
  ) {
    const batch = assigneeList.slice(start, start + WARNING_LOOKUP_BATCH_SIZE);
    const found = await db
      .select({
        userId: inboxPermissions.userId,
        email: inboxPermissions.email,
      })
      .from(inboxPermissions)
      .where(inArray(inboxPermissions.userId, batch));
    for (const permission of found) {
      const inboxes =
        permissionsByUser.get(permission.userId) ?? new Set<string>();
      inboxes.add(permission.email.trim().toLowerCase());
      permissionsByUser.set(permission.userId, inboxes);
    }
  }

  const result = new Map<string, RuleWarning[]>();
  for (const row of rows) {
    const ruleInbox = row.inbox?.trim().toLowerCase() ?? null;
    const warnings: RuleWarning[] = [];
    row.actions.forEach((action, actionIndex) => {
      if (action.type === "move_to_folder") {
        const mailbox = mailboxById.get(action.mailboxId);
        if (
          !ruleInbox ||
          !mailbox ||
          mailbox.inbox.trim().toLowerCase() !== ruleInbox
        ) {
          warnings.push({ actionIndex, code: "missing_folder" });
        }
      }
      if (action.type === "assign") {
        const user = userById.get(action.userId);
        const available =
          user?.role === "admin" ||
          (!!user &&
            !!ruleInbox &&
            permissionsByUser.get(user.id)?.has(ruleInbox) === true);
        if (!available)
          warnings.push({ actionIndex, code: "assignee_unavailable" });
      }
    });
    result.set(row.id, warnings);
  }
  return result;
}

function mapRuleError(error: unknown): { error: string } | null {
  return error instanceof InvalidRuleError ? { error: error.message } : null;
}

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin", "Rules"],
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "Automation rules",
      content: { "application/json": { schema: z.array(RuleSchema) } },
    },
  },
});

adminRulesRouter.openapi(listRoute, async (c) => {
  const db = c.get("db");
  const rows = await db
    .select()
    .from(rules)
    .orderBy(asc(rules.position), asc(rules.id));
  const warnings = await computeRuleWarnings(db, rows);
  return c.json(
    rows.map((row) => apiRule(row, warnings.get(row.id) ?? [])),
    200,
  );
});

const getRuleRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Admin", "Rules"],
  request: { params: z.object({ id: z.string().min(1) }) },
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "Automation rule",
      content: { "application/json": { schema: RuleSchema } },
    },
    404: {
      description: "Rule not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminRulesRouter.openapi(getRuleRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const [row] = await db.select().from(rules).where(eq(rules.id, id)).limit(1);
  if (!row) return c.json({ error: "Rule not found" }, 404);
  const warnings = await computeRuleWarnings(db, [row]);
  return c.json(apiRule(row, warnings.get(row.id) ?? []), 200);
});

const createRuleRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin", "Rules"],
  request: {
    body: {
      content: { "application/json": { schema: CreateRuleSchema } },
    },
  },
  responses: {
    500: { description: "Internal server error" },
    201: {
      description: "Rule created",
      content: { "application/json": { schema: RuleSchema } },
    },
    400: {
      description: "Invalid rule",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminRulesRouter.openapi(createRuleRoute, async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  const inbox = body.inbox?.trim().toLowerCase() ?? null;

  try {
    await validateRuleActions(db, { inbox, actions: body.actions });
  } catch (error) {
    const mapped = mapRuleError(error);
    if (mapped) return c.json(mapped, 400);
    throw error;
  }

  const now = Math.floor(Date.now() / 1000);
  const row = {
    id: nanoid(),
    name: body.name.trim(),
    inbox,
    trigger: body.trigger,
    conditions: body.conditions,
    actions: body.actions,
    position: body.position,
    stopProcessing: body.stopProcessing ? 1 : 0,
    enabled: body.enabled ? 1 : 0,
    matchCount: 0,
    lastMatchedAt: null,
    createdBy: c.get("user").id,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(rules).values(row);
  await recordAudit(db, {
    action: AUDIT_ACTIONS.ruleCreated,
    targetType: "rule",
    targetId: row.id,
    inbox,
    summary: `Created the rule '${row.name}'`,
    details: {
      enabled: row.enabled === 1,
      actions: row.actions.map((action: { type: string }) => action.type),
    },
  });
  const [created] = await db
    .select()
    .from(rules)
    .where(eq(rules.id, row.id))
    .limit(1);
  return c.json(apiRule(created!), 201);
});

const updateRuleRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Admin", "Rules"],
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: {
      content: { "application/json": { schema: UpdateRuleSchema } },
    },
  },
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "Rule updated",
      content: { "application/json": { schema: RuleSchema } },
    },
    400: {
      description: "Invalid rule",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Rule not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminRulesRouter.openapi(updateRuleRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const [existing] = await db
    .select()
    .from(rules)
    .where(eq(rules.id, id))
    .limit(1);
  if (!existing) return c.json({ error: "Rule not found" }, 404);

  const inbox =
    body.inbox === undefined
      ? existing.inbox
      : (body.inbox?.trim().toLowerCase() ?? null);
  const actions = body.actions ?? existing.actions;

  try {
    await validateRuleActions(db, { inbox, actions });
  } catch (error) {
    const mapped = mapRuleError(error);
    if (mapped) return c.json(mapped, 400);
    throw error;
  }

  await db
    .update(rules)
    .set({
      ...(body.name === undefined ? {} : { name: body.name.trim() }),
      ...(body.inbox === undefined ? {} : { inbox }),
      ...(body.trigger === undefined ? {} : { trigger: body.trigger }),
      ...(body.conditions === undefined ? {} : { conditions: body.conditions }),
      ...(body.actions === undefined ? {} : { actions: body.actions }),
      ...(body.position === undefined ? {} : { position: body.position }),
      ...(body.stopProcessing === undefined
        ? {}
        : { stopProcessing: body.stopProcessing ? 1 : 0 }),
      ...(body.enabled === undefined ? {} : { enabled: body.enabled ? 1 : 0 }),
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(rules.id, id));

  const [updated] = await db
    .select()
    .from(rules)
    .where(eq(rules.id, id))
    .limit(1);

  // Switching a rule on or off, alone, is its own event; anything else is an
  // update that lists the fields the request carried.
  const fields = Object.keys(body).filter(
    (key) => (body as Record<string, unknown>)[key] !== undefined,
  );
  const toggled = fields.length === 1 && fields[0] === "enabled";
  if (toggled) {
    if ((existing.enabled === 1) !== body.enabled) {
      await recordAudit(db, {
        action: AUDIT_ACTIONS.ruleToggled,
        targetType: "rule",
        targetId: id,
        inbox: updated!.inbox,
        summary: `Turned the rule '${updated!.name}' ${body.enabled ? "on" : "off"}`,
        details: { enabled: body.enabled },
      });
    }
  } else if (fields.length > 0) {
    await recordAudit(db, {
      action: AUDIT_ACTIONS.ruleUpdated,
      targetType: "rule",
      targetId: id,
      inbox: updated!.inbox,
      summary: `Changed ${fields.join(", ")} of the rule '${updated!.name}'`,
      details: { fields },
    });
  }
  return c.json(apiRule(updated!), 200);
});

const deleteRuleRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin", "Rules"],
  request: { params: z.object({ id: z.string().min(1) }) },
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "Rule deleted",
      content: {
        "application/json": { schema: z.object({ success: z.literal(true) }) },
      },
    },
    404: {
      description: "Rule not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminRulesRouter.openapi(deleteRuleRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const [existing] = await db
    .select({ id: rules.id, name: rules.name, inbox: rules.inbox })
    .from(rules)
    .where(eq(rules.id, id))
    .limit(1);
  if (!existing) return c.json({ error: "Rule not found" }, 404);
  await db.delete(rules).where(eq(rules.id, id));
  await recordAudit(db, {
    action: AUDIT_ACTIONS.ruleDeleted,
    targetType: "rule",
    targetId: id,
    inbox: existing.inbox,
    summary: `Deleted the rule '${existing.name}'`,
  });
  return c.json({ success: true as const }, 200);
});

const ReorderSchema = z.object({
  ids: z.array(z.string().min(1).max(500)).max(1000),
});

const reorderRoute = createRoute({
  method: "post",
  path: "/reorder",
  tags: ["Admin", "Rules"],
  request: {
    body: { content: { "application/json": { schema: ReorderSchema } } },
  },
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "Rules reordered",
      content: {
        "application/json": { schema: z.object({ success: z.literal(true) }) },
      },
    },
    400: {
      description: "Invalid rule ids",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminRulesRouter.openapi(reorderRoute, async (c) => {
  const db = c.get("db");
  const { ids } = c.req.valid("json");
  const existing = await db.select({ id: rules.id }).from(rules);
  const existingIds = new Set(existing.map((row) => row.id));
  const requestedIds = new Set(ids);
  if (
    ids.length !== existing.length ||
    requestedIds.size !== ids.length ||
    ids.some((id) => !existingIds.has(id))
  ) {
    return c.json(
      { error: "Rule ids must be an exact permutation of all rule ids" },
      400,
    );
  }

  if (ids.length > 0) {
    const now = Math.floor(Date.now() / 1000);
    const [firstId, ...restIds] = ids;
    await db.batch([
      db
        .update(rules)
        .set({ position: 0, updatedAt: now })
        .where(eq(rules.id, firstId!)),
      ...restIds.map((id, index) =>
        db
          .update(rules)
          .set({ position: index + 1, updatedAt: now })
          .where(eq(rules.id, id)),
      ),
    ]);
  }
  return c.json({ success: true as const }, 200);
});

const TestRuleSchema = z.object({
  rule: z
    .object({
      conditions: RuleConditionsSchema,
      // Optional: given, the answer says whether the rule would reject.
      actions: z.array(RuleActionSchema).optional(),
    })
    .passthrough(),
  emailId: z.string().min(1).max(500),
});

const testRuleRoute = createRoute({
  method: "post",
  path: "/test",
  tags: ["Admin", "Rules"],
  request: {
    body: { content: { "application/json": { schema: TestRuleSchema } } },
  },
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "Dry-run condition results",
      content: {
        "application/json": {
          schema: z.object({
            matched: z.boolean(),
            wouldReject: z.boolean().openapi({
              description:
                "The rule matches and has a reject action: the message would be refused at SMTP time. A dry run never rejects anything.",
            }),
            conditionResults: z.array(
              z.object({
                condition: RuleConditionSchema,
                matched: z.boolean(),
              }),
            ),
          }),
        },
      },
    },
    404: {
      description: "Email not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminRulesRouter.openapi(testRuleRoute, async (c) => {
  const db = c.get("db");
  const { rule, emailId } = c.req.valid("json");
  const [email] = await db
    .select()
    .from(emails)
    .where(eq(emails.id, emailId))
    .limit(1);
  if (!email) return c.json({ error: "Email not found" }, 404);

  const [person] = await db
    .select({ email: people.email })
    .from(people)
    .where(eq(people.id, email.personId))
    .limit(1);
  const [attachment] = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(
      and(eq(attachments.kind, "inbound"), eq(attachments.emailId, emailId)),
    )
    .limit(1);

  let headers: Record<string, string> = {};
  if (email.rawHeaders) {
    try {
      const parsed = JSON.parse(email.rawHeaders) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        headers = Object.fromEntries(
          Object.entries(parsed).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
      }
    } catch {
      headers = {};
    }
  }

  const result = matchConditions(rule.conditions, {
    fromAddress: person?.email ?? "",
    subject: email.subject,
    bodyText: email.bodyText,
    bodyHtml: email.bodyHtml,
    hasAttachments: attachment !== undefined,
    spamScore: email.spamScore,
    headers,
  });
  return c.json(
    {
      ...result,
      wouldReject:
        result.matched &&
        (rule.actions ?? []).some((action) => action.type === "reject"),
    },
    200,
  );
});
