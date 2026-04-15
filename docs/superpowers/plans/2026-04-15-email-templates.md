# Email Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add API-managed email templates with slug-based lookup and `{{variable}}` interpolation, sent via Resend.

**Architecture:** New `email_templates` table in D1 with CRUD endpoints and a send endpoint. Templates store HTML with `{{var}}` placeholders. A shared interpolation utility renders templates before sending via the existing Resend integration. Sent emails are recorded in `sent_emails`.

**Tech Stack:** Hono + Zod OpenAPI, Drizzle ORM, D1, Resend, nanoid

---

## File Structure

| File                                           | Action | Responsibility                             |
| ---------------------------------------------- | ------ | ------------------------------------------ |
| `worker/src/db/email-templates.schema.ts`      | Create | Drizzle schema for `email_templates` table |
| `worker/src/db/schema.ts`                      | Modify | Add `emailTemplates` to schema object      |
| `worker/src/db/index.ts`                       | Modify | Re-export new schema                       |
| `worker/src/lib/interpolate.ts`                | Create | `{{var}}` interpolation utility            |
| `worker/src/routers/email-templates-router.ts` | Create | CRUD + send endpoints                      |
| `worker/src/index.ts`                          | Modify | Mount the new router                       |

---

### Task 1: Database Schema

**Files:**

- Create: `worker/src/db/email-templates.schema.ts`
- Modify: `worker/src/db/schema.ts`
- Modify: `worker/src/db/index.ts`

- [ ] **Step 1: Create the email_templates schema file**

Create `worker/src/db/email-templates.schema.ts`:

```ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const emailTemplates = sqliteTable("email_templates", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  bodyHtml: text("body_html").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
```

- [ ] **Step 2: Add emailTemplates to the schema object**

In `worker/src/db/schema.ts`, import and add `emailTemplates`:

```ts
import { emailTemplates } from "./email-templates.schema";

export const schema = {
  ...authSchema,
  senders,
  emails,
  sentEmails,
  attachments,
  emailTemplates,
} as const;
```

- [ ] **Step 3: Re-export from db/index.ts**

Add to `worker/src/db/index.ts`:

```ts
export * from "./email-templates.schema";
```

- [ ] **Step 4: Generate and apply migration**

Run:

```bash
npx drizzle-kit generate
npx wrangler d1 migrations apply cmail-db --local
```

Expected: A new migration file is created in `migrations/` with `CREATE TABLE email_templates`.

- [ ] **Step 5: Commit**

```bash
git add worker/src/db/email-templates.schema.ts worker/src/db/schema.ts worker/src/db/index.ts migrations/
git commit -m "feat: add email_templates database schema"
```

---

### Task 2: Interpolation Utility

**Files:**

- Create: `worker/src/lib/interpolate.ts`

- [ ] **Step 1: Create the interpolation utility**

Create `worker/src/lib/interpolate.ts`:

```ts
/**
 * Replace {{variableName}} tokens with values from the variables object.
 * Unmatched tokens are left as-is.
 */
export function interpolate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return key in variables ? variables[key] : match;
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add worker/src/lib/interpolate.ts
git commit -m "feat: add template interpolation utility"
```

---

### Task 3: Email Templates Router — CRUD Endpoints

**Files:**

- Create: `worker/src/routers/email-templates-router.ts`

- [ ] **Step 1: Create router with CRUD routes**

Create `worker/src/routers/email-templates-router.ts`:

```ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { emailTemplates } from "../db/email-templates.schema";
import { json200Response, json201Response } from "../lib/helpers";
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

// --- CREATE ---
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
            slug: z
              .string()
              .regex(
                /^[a-z0-9-]+$/,
                "Slug must be lowercase alphanumeric with hyphens",
              ),
            name: z.string(),
            subject: z.string(),
            bodyHtml: z.string(),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(EmailTemplateSchema, "Template created"),
  },
});

emailTemplatesRouter.openapi(createTemplateRoute, async (c) => {
  const db = c.get("db");
  const { slug, name, subject, bodyHtml } = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);
  const id = nanoid();

  const template = {
    id,
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

// --- LIST ---
const listTemplatesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Email Templates"],
  description: "List all email templates.",
  responses: {
    ...json200Response(z.array(EmailTemplateSchema), "List of templates"),
  },
});

emailTemplatesRouter.openapi(listTemplatesRoute, async (c) => {
  const db = c.get("db");
  const rows = await db.select().from(emailTemplates);
  return c.json(rows, 200);
});

// --- GET BY SLUG ---
const getTemplateRoute = createRoute({
  method: "get",
  path: "/{slug}",
  tags: ["Email Templates"],
  description: "Get an email template by slug.",
  request: {
    params: z.object({ slug: z.string() }),
  },
  responses: {
    ...json200Response(EmailTemplateSchema, "Template detail"),
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

// --- UPDATE ---
const updateTemplateRoute = createRoute({
  method: "put",
  path: "/{slug}",
  tags: ["Email Templates"],
  description: "Update an email template.",
  request: {
    params: z.object({ slug: z.string() }),
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
    ...json200Response(EmailTemplateSchema, "Template updated"),
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

// --- DELETE ---
const deleteTemplateRoute = createRoute({
  method: "delete",
  path: "/{slug}",
  tags: ["Email Templates"],
  description: "Delete an email template.",
  request: {
    params: z.object({ slug: z.string() }),
  },
  responses: {
    200: {
      description: "Template deleted",
      content: {
        "application/json": {
          schema: z.object({ success: z.boolean() }),
        },
      },
    },
  },
});

emailTemplatesRouter.openapi(deleteTemplateRoute, async (c) => {
  const db = c.get("db");
  const { slug } = c.req.valid("param");

  const existing = await db
    .select({ id: emailTemplates.id })
    .from(emailTemplates)
    .where(eq(emailTemplates.slug, slug))
    .limit(1);

  if (existing.length === 0) {
    return c.json({ error: "Template not found" }, 404);
  }

  await db.delete(emailTemplates).where(eq(emailTemplates.slug, slug));

  return c.json({ success: true }, 200);
});
```

- [ ] **Step 2: Commit**

```bash
git add worker/src/routers/email-templates-router.ts
git commit -m "feat: add email templates CRUD router"
```

---

### Task 4: Send Templated Email Endpoint

**Files:**

- Modify: `worker/src/routers/email-templates-router.ts`

- [ ] **Step 1: Add the send route to the email templates router**

Add the following to the bottom of `worker/src/routers/email-templates-router.ts` (add the necessary imports at the top: `Resend`, `sentEmails`, `senders`, `interpolate`):

New imports at top of file:

```ts
import { Resend } from "resend";
import { sentEmails } from "../db/sent-emails.schema";
import { senders } from "../db/senders.schema";
import { interpolate } from "../lib/interpolate";
```

Send route:

```ts
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
  },
});

emailTemplatesRouter.openapi(sendTemplateRoute, async (c) => {
  const db = c.get("db");
  const { slug } = c.req.valid("param");
  const { to, variables } = c.req.valid("json");

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
  const renderedSubject = interpolate(template.subject, variables);
  const renderedHtml = interpolate(template.bodyHtml, variables);

  // Send via Resend
  const fromAddress = c.env.RESEND_EMAIL_FROM;
  const resend = new Resend(c.env.RESEND_API_KEY);
  const result = await resend.emails.send({
    from: fromAddress,
    to,
    subject: renderedSubject,
    html: renderedHtml,
  });

  // Find sender if they exist
  const existingSender = await db
    .select({ id: senders.id })
    .from(senders)
    .where(eq(senders.email, to))
    .limit(1);

  const senderId = existingSender[0]?.id ?? null;

  // Store sent email
  const id = nanoid();
  const now = Math.floor(Date.now() / 1000);
  await db.insert(sentEmails).values({
    id,
    senderId,
    fromAddress,
    toAddress: to,
    subject: renderedSubject,
    bodyHtml: renderedHtml,
    bodyText: null,
    resendId: result.data?.id ?? null,
    status: result.error ? "failed" : "sent",
    sentAt: now,
    createdAt: now,
  });

  return c.json(
    {
      id,
      resendId: result.data?.id ?? null,
      status: result.error ? "failed" : "sent",
    },
    201,
  );
});
```

- [ ] **Step 2: Commit**

```bash
git add worker/src/routers/email-templates-router.ts
git commit -m "feat: add send-via-template endpoint"
```

---

### Task 5: Mount Router and Verify Build

**Files:**

- Modify: `worker/src/index.ts`

- [ ] **Step 1: Mount the email templates router**

In `worker/src/index.ts`, add the import:

```ts
import { emailTemplatesRouter } from "./routers/email-templates-router";
```

Add the route after the existing routes (before the health check):

```ts
app.route("/api/email-templates", emailTemplatesRouter);
```

- [ ] **Step 2: Verify the project builds**

Run:

```bash
npx wrangler deploy --dry-run
```

Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat: mount email templates router"
```
