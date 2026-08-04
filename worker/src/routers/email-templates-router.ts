import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, inArray, isNull, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { assertInboxAllowed, isInboxAllowed } from "../lib/inbox-permissions";
import { emailTemplates } from "../db/email-templates.schema";
import { json200Response, json201Response } from "../lib/helpers";
import { analyzeTemplate, TemplateParseError } from "../lib/interpolate";
import { sendTemplate } from "../lib/send-template";
import type { Variables } from "../variables";
import { bearerSecurity } from "../lib/openapi-auth";
import {
  ErrorSchema,
  inboxForbiddenResponse,
  SendPathErrorSchema,
} from "../lib/openapi-send-errors";

export const emailTemplatesRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

/**
 * A template variable value. Recursive so arrays of objects can reach
 * `{{#section}}` bodies; `z.lazy` is what lets the schema refer to itself.
 *
 * The `.openapi("TemplateValue")` name is required, not decorative: without a
 * registered ref id, `@asteasolutions/zod-to-openapi` has no way to stop
 * expanding a self-referencing lazy schema and either recurses forever while
 * building `/doc` or (depending on version) silently degrades to an opaque
 * `{}` schema. Naming it turns the self-reference into a proper
 * `$ref: '#/components/schemas/TemplateValue'` — verified against
 * `openapi-doc.test.ts` and `openapi-bootstrap.test.ts`.
 */
const templateValueSchema: z.ZodType<unknown> = z
  .lazy(() =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(templateValueSchema),
      z.record(z.string(), templateValueSchema),
    ]),
  )
  .openapi("TemplateValue");

/**
 * Maximum nesting depth allowed in a send request's `variables` payload.
 *
 * `templateValueSchema` is unbounded on its own: Zod's recursive descent
 * through a self-referencing `z.lazy` has no depth limit, so a payload of
 * only a few KB but thousands of levels deep blows Zod's own call stack —
 * a `RangeError` with no app-level `onError` handler to catch it, surfacing
 * as an unhandled 500 for any authenticated caller. A `.superRefine`
 * attached directly to the recursive schema does not help: Zod crashes
 * descending into the lazy schema before any refinement on it ever runs.
 *
 * The fix (`templateVariablesSchema` below) walks the raw, not-yet-parsed
 * value ITERATIVELY — an explicit stack, not a recursive function, so the
 * guard itself cannot be the thing that overflows — before Zod ever
 * descends into the recursive schema. 32 is generous: real templates nest a
 * handful of section/object levels at most.
 */
export const MAX_VARIABLE_DEPTH = 32;

/**
 * Iteratively finds the first depth (if any) that exceeds `maxDepth` in
 * `root`. Depth 0 is `root` itself; each array item or object property adds
 * one level. Returns `null` when every value is within bounds.
 */
function findExcessiveDepth(root: unknown, maxDepth: number): number | null {
  const stack: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 0 },
  ];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (depth > maxDepth) return depth;
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
    } else if (value !== null && typeof value === "object") {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        stack.push({
          value: (value as Record<string, unknown>)[key],
          depth: depth + 1,
        });
      }
    }
  }
  return null;
}

/**
 * The send route's `variables` schema.
 *
 * Composed with `z.preprocess`, not `.superRefine().pipe(...)`. Both run the
 * depth guard before the recursive schema, but they differ in how
 * `@asteasolutions/zod-to-openapi` documents them: for a plain `.pipe(x)`,
 * the generator documents the PRE-pipe ("in") schema, which here is just
 * `z.record(z.string(), z.unknown())` — an unhelpful `{}` shape that drops
 * the `TemplateValue` ref entirely (verified against the real `/doc` output
 * while building this). `z.preprocess(fn, schema)` is internally the same
 * pipe machinery but with the check function on the "in" side wrapped as a
 * `ZodTransform`, and for exactly that shape the generator documents the
 * POST-pipe ("out") schema instead — `schema` here, i.e. the recursive,
 * named `templateValueSchema`. That's the one difference that makes this
 * composition preserve the OpenAPI component; confirmed against `/doc` in
 * `openapi-doc.test.ts`.
 *
 * The preprocess function returns `z.NEVER` on failure specifically so the
 * inner schema's own (recursive) parse never runs against the
 * still-too-deep raw value — returning the original value instead would
 * just move the crash one step later.
 */
const templateVariablesSchema = z.preprocess(
  (raw, ctx) => {
    const excess = findExcessiveDepth(raw, MAX_VARIABLE_DEPTH);
    if (excess !== null) {
      ctx.addIssue({
        code: "custom",
        message: `Template variables are nested too deeply — the limit is ${MAX_VARIABLE_DEPTH} levels.`,
      });
      return z.NEVER;
    }
    return raw;
  },
  z.record(z.string(), templateValueSchema),
);

const EmailTemplateSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  subject: z.string(),
  bodyHtml: z.string(),
  fromAddress: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const createTemplateRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Email Templates"],
  description: "Create a new email template.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            slug: z.string().regex(/^[a-z0-9-]+$/),
            name: z.string(),
            subject: z.string(),
            bodyHtml: z.string(),
            fromAddress: z.string().email().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(EmailTemplateSchema, "Created email template"),
  },
});

emailTemplatesRouter.openapi(createTemplateRoute, async (c) => {
  const db = c.get("db");
  const { slug, name, subject, bodyHtml, fromAddress } = c.req.valid("json");

  const allowed = c.get("allowedInboxes")!;
  if (fromAddress != null) {
    assertInboxAllowed(allowed, fromAddress);
  } else if (!allowed.isAdmin) {
    // Members cannot create global (null) templates.
    return c.json({ error: "from_address is required for members" }, 403);
  }

  const now = Math.floor(Date.now() / 1000);
  const template = {
    id: nanoid(),
    slug,
    name,
    subject,
    bodyHtml,
    fromAddress: fromAddress ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(emailTemplates).values(template);
  return c.json(template, 201);
});

const listTemplatesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Email Templates"],
  description: "List all email templates.",
  responses: {
    ...json200Response(z.array(EmailTemplateSchema), "List of email templates"),
  },
});

emailTemplatesRouter.openapi(listTemplatesRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  let rows;
  if (allowed.isAdmin) {
    rows = await db.select().from(emailTemplates);
  } else if (allowed.inboxes.length === 0) {
    rows = await db
      .select()
      .from(emailTemplates)
      .where(isNull(emailTemplates.fromAddress));
  } else {
    rows = await db
      .select()
      .from(emailTemplates)
      .where(
        or(
          isNull(emailTemplates.fromAddress),
          inArray(emailTemplates.fromAddress, allowed.inboxes),
        ),
      );
  }
  return c.json(rows, 200);
});

const getTemplateRoute = createRoute({
  method: "get",
  path: "/{slug}",
  tags: ["Email Templates"],
  description: "Get an email template by slug.",
  request: {
    params: z.object({
      slug: z.string(),
    }),
  },
  responses: {
    ...json200Response(EmailTemplateSchema, "Email template"),
  },
});

emailTemplatesRouter.openapi(getTemplateRoute, async (c) => {
  const db = c.get("db");
  const { slug } = c.req.valid("param");
  const rows = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.slug, slug))
    .limit(1);
  if (rows.length === 0) {
    return c.json({ error: "Template not found" }, 404);
  }
  const allowed = c.get("allowedInboxes")!;
  if (!allowed.isAdmin && rows[0].fromAddress !== null) {
    if (!isInboxAllowed(allowed, rows[0].fromAddress)) {
      return c.json({ error: "Template not found" }, 404);
    }
  }
  return c.json(rows[0], 200);
});

const updateTemplateRoute = createRoute({
  method: "put",
  path: "/{slug}",
  tags: ["Email Templates"],
  description: "Update an email template by slug.",
  request: {
    params: z.object({
      slug: z.string(),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional(),
            subject: z.string().optional(),
            bodyHtml: z.string().optional(),
            fromAddress: z.string().email().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(EmailTemplateSchema, "Updated email template"),
  },
});

emailTemplatesRouter.openapi(updateTemplateRoute, async (c) => {
  const db = c.get("db");
  const { slug } = c.req.valid("param");
  const updates = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);

  const existing = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.slug, slug))
    .limit(1);
  if (existing.length === 0) {
    return c.json({ error: "Template not found" }, 404);
  }

  const allowed = c.get("allowedInboxes")!;
  if (updates.fromAddress !== undefined && updates.fromAddress !== null) {
    assertInboxAllowed(allowed, updates.fromAddress);
  }

  await db
    .update(emailTemplates)
    .set({ ...updates, updatedAt: now })
    .where(eq(emailTemplates.slug, slug));

  const updated = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.slug, slug))
    .limit(1);
  return c.json(updated[0], 200);
});

const deleteTemplateRoute = createRoute({
  method: "delete",
  path: "/{slug}",
  tags: ["Email Templates"],
  description: "Delete an email template by slug.",
  request: {
    params: z.object({
      slug: z.string(),
    }),
  },
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "Deletion result"),
  },
});

emailTemplatesRouter.openapi(deleteTemplateRoute, async (c) => {
  const db = c.get("db");
  const { slug } = c.req.valid("param");

  const existing = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.slug, slug))
    .limit(1);
  if (existing.length === 0) {
    return c.json({ error: "Template not found" }, 404);
  }

  await db.delete(emailTemplates).where(eq(emailTemplates.slug, slug));
  return c.json({ success: true }, 200);
});

// --- VARIABLES ---
const getTemplateVariablesRoute = createRoute({
  method: "get",
  path: "/{slug}/variables",
  tags: ["Email Templates"],
  description: "Get all template variables required for sending.",
  request: {
    params: z.object({ slug: z.string() }),
  },
  responses: {
    ...json200Response(
      z.object({
        variables: z.array(z.string()).openapi({
          description: "Variables the caller must supply, or the send fails.",
        }),
        optional: z.array(z.string()).openapi({
          description:
            "Variables that render empty when absent — `{{key?}}` tags and inverted sections.",
        }),
        sections: z
          .array(
            z.object({
              name: z.string(),
              inverted: z.boolean(),
              variables: z.array(z.string()),
            }),
          )
          .openapi({
            description:
              "Sections and the names their bodies reference. Those names resolve per-item and are not required at the top level.",
          }),
      }),
      "Template variables",
    ),
    400: {
      description: "Template has an unbalanced section",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

emailTemplatesRouter.openapi(getTemplateVariablesRoute, async (c) => {
  const db = c.get("db");
  const { slug } = c.req.valid("param");

  const rows = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.slug, slug))
    .limit(1);

  if (rows.length === 0) {
    return c.json({ error: "Template not found" }, 404);
  }

  const template = rows[0];
  let analysis;
  try {
    analysis = analyzeTemplate(template.subject, template.bodyHtml);
  } catch (err) {
    if (err instanceof TemplateParseError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }

  return c.json(
    {
      variables: analysis.required,
      optional: analysis.optional,
      sections: analysis.sections,
    },
    200,
  );
});

// --- SEND ---
const sendTemplateRoute = createRoute({
  method: "post",
  path: "/{slug}/send",
  tags: ["Email Templates"],
  security: bearerSecurity,
  description: "Send an email using a template.",
  request: {
    params: z.object({ slug: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            to: z.string().email(),
            fromAddress: z.string().email(),
            variables: templateVariablesSchema.optional().default({}),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(
      z.object({
        id: z.string().nullable(),
        resendId: z.string().nullable(),
        status: z.string().openapi({
          description:
            'Delivery status. "sent" = delivered; "retrying" = transient provider failure — saasmail queues this in the outbox and retries automatically; "failed" = provider permanently rejected; "suppressed" = every recipient was on the suppression list.',
        }),
        delivered: z.array(z.string()),
        suppressed: z.array(z.string()),
      }),
      "Email sent",
    ),
    400: {
      description:
        "Missing required template variables, or the template has an unbalanced section.",
      content: {
        "application/json": { schema: SendPathErrorSchema },
      },
    },
    ...inboxForbiddenResponse,
    404: {
      description: "Template slug not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

emailTemplatesRouter.openapi(sendTemplateRoute, async (c) => {
  const db = c.get("db");
  const { slug } = c.req.valid("param");
  const { to, fromAddress, variables } = c.req.valid("json");

  const result = await sendTemplate({
    db,
    env: c.env,
    slug,
    to,
    fromAddress,
    variables,
    allowed: c.get("allowedInboxes")!,
  });

  if (!result.ok) {
    if (result.code === "TEMPLATE_NOT_FOUND") {
      return c.json({ error: result.message }, 404);
    }
    if (result.code === "TEMPLATE_PARSE_ERROR") {
      return c.json({ error: result.message }, 400);
    }
    return c.json(
      {
        error: result.message,
        missingVariables: result.missingVariables,
        requiredVariables: result.requiredVariables,
      },
      400,
    );
  }

  return c.json(
    {
      id: result.id,
      resendId: result.resendId,
      status: result.status,
      delivered: result.delivered,
      suppressed: result.suppressed,
    },
    201,
  );
});
