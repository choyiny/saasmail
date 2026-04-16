import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createEmailSender } from "../lib/email-sender";
import { emailTemplates } from "../db/email-templates.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { people } from "../db/people.schema";
import { json200Response, json201Response } from "../lib/helpers";
import { interpolate, extractVariables } from "../lib/interpolate";
import type { Variables } from "../variables";

export const emailTemplatesRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const EmailTemplateSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  subject: z.string(),
  bodyHtml: z.string(),
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
  const { slug, name, subject, bodyHtml } = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);
  const template = {
    id: nanoid(),
    slug,
    name,
    subject,
    bodyHtml,
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
  const rows = await db.select().from(emailTemplates);
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
      z.object({ variables: z.array(z.string()) }),
      "Template variables",
    ),
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
  const subjectVars = extractVariables(template.subject);
  const bodyVars = extractVariables(template.bodyHtml);
  const allVars = Array.from(new Set([...subjectVars, ...bodyVars]));

  return c.json({ variables: allVars }, 200);
});

// --- SEND ---
const sendTemplateRoute = createRoute({
  method: "post",
  path: "/{slug}/send",
  tags: ["Email Templates"],
  description: "Send an email using a template.",
  request: {
    params: z.object({ slug: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            to: z.string().email(),
            fromAddress: z.string().email(),
            variables: z.record(z.string(), z.string()).optional().default({}),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(
      z.object({
        id: z.string(),
        resendId: z.string().nullable(),
        status: z.string(),
      }),
      "Email sent",
    ),
    400: {
      description: "Missing required template variables",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
            missingVariables: z.array(z.string()),
            requiredVariables: z.array(z.string()),
          }),
        },
      },
    },
  },
});

emailTemplatesRouter.openapi(sendTemplateRoute, async (c) => {
  const db = c.get("db");
  const { slug } = c.req.valid("param");
  const { to, fromAddress, variables } = c.req.valid("json");

  // Look up template
  const rows = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.slug, slug))
    .limit(1);

  if (rows.length === 0) {
    return c.json({ error: "Template not found" }, 404);
  }

  const template = rows[0];

  // Validate all required variables are provided
  const subjectVars = extractVariables(template.subject);
  const bodyVars = extractVariables(template.bodyHtml);
  const requiredVars = Array.from(new Set([...subjectVars, ...bodyVars]));
  const missingVars = requiredVars.filter((v) => !(v in variables));

  if (missingVars.length > 0) {
    return c.json(
      {
        error: "Missing required template variables",
        missingVariables: missingVars,
        requiredVariables: requiredVars,
      },
      400,
    );
  }

  const renderedSubject = interpolate(template.subject, variables);
  const renderedHtml = interpolate(template.bodyHtml, variables);

  const sender = createEmailSender(c.env);
  const result = await sender.send({
    from: fromAddress,
    to,
    subject: renderedSubject,
    html: renderedHtml,
  });

  // Find person if they exist
  const existingPerson = await db
    .select({ id: people.id })
    .from(people)
    .where(eq(people.email, to))
    .limit(1);

  const personId = existingPerson[0]?.id ?? null;

  // Store sent email
  const id = nanoid();
  const now = Math.floor(Date.now() / 1000);
  await db.insert(sentEmails).values({
    id,
    personId,
    fromAddress,
    toAddress: to,
    subject: renderedSubject,
    bodyHtml: renderedHtml,
    bodyText: null,
    resendId: result.id,
    status: result.error ? "failed" : "sent",
    sentAt: now,
    createdAt: now,
  });

  return c.json(
    {
      id,
      resendId: result.id,
      status: result.error ? "failed" : "sent",
    },
    201,
  );
});
