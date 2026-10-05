import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { lists } from "../db/lists.schema";
import { subscribeForms } from "../db/subscribe-forms.schema";
import { json200Response, json201Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const subscribeFormsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const FormSchema = z.object({
  id: z.string(),
  listId: z.string(),
  name: z.string(),
  showNameField: z.boolean(),
  nameRequired: z.boolean(),
  successMessage: z.string(),
  redirectUrl: z.string().nullable(),
  allowedOrigins: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const FormWithSnippetSchema = FormSchema.extend({ embedSnippet: z.string() });

const CreateFormSchema = z.object({
  listId: z.string(),
  name: z.string().min(1).max(200),
  showNameField: z.boolean().optional(),
  nameRequired: z.boolean().optional(),
  successMessage: z.string().max(500).optional(),
  redirectUrl: z.string().url().nullable().optional(),
  allowedOrigins: z.string().max(2000).nullable().optional(),
});

const UpdateFormSchema = CreateFormSchema.omit({ listId: true }).partial();

const ErrorSchema = z.object({ error: z.string() });

function now() {
  return Math.floor(Date.now() / 1000);
}

function serialize(row: typeof subscribeForms.$inferSelect) {
  return {
    id: row.id,
    listId: row.listId,
    name: row.name,
    showNameField: row.showNameField === 1,
    nameRequired: row.nameRequired === 1,
    successMessage: row.successMessage,
    redirectUrl: row.redirectUrl,
    allowedOrigins: row.allowedOrigins,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Copy-paste embed markup.
 *
 * The `_hp` input is a honeypot: hidden from people, filled in by naive bots.
 * It is positioned off-screen rather than `display:none` because some bots skip
 * fields that are outright hidden, and marked `aria-hidden` + `tabindex="-1"`
 * so it is skipped by screen readers and keyboard navigation.
 */
function buildEmbedSnippet(
  baseUrl: string,
  form: typeof subscribeForms.$inferSelect,
): string {
  const action = `${baseUrl.replace(/\/+$/, "")}/subscribe/${form.id}`;
  const nameField =
    form.showNameField === 1
      ? `\n  <input type="text" name="name" placeholder="Your name"${
          form.nameRequired === 1 ? " required" : ""
        } />`
      : "";
  return `<form action="${action}" method="POST">
  <input type="email" name="email" required placeholder="your@email.com" />${nameField}
  <input type="text" name="_hp" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true" />
  <button type="submit">Subscribe</button>
</form>`;
}

// --- GET / ---

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Subscribe forms"],
  description: "List subscribe forms, newest first.",
  responses: {
    ...json200Response(z.object({ items: z.array(FormSchema) }), "Forms"),
  },
});

subscribeFormsRouter.openapi(listRoute, async (c) => {
  const db = c.get("db");
  const rows = await db
    .select()
    .from(subscribeForms)
    .orderBy(desc(subscribeForms.createdAt));
  return c.json({ items: rows.map(serialize) });
});

// --- POST / ---

const createFormRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Subscribe forms"],
  description: "Create a subscribe form bound to a list.",
  request: {
    body: {
      content: { "application/json": { schema: CreateFormSchema } },
      required: true,
    },
  },
  responses: {
    ...json201Response(FormWithSnippetSchema, "Created form"),
    404: {
      description: "List not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

subscribeFormsRouter.openapi(createFormRoute, async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");

  const list = await db
    .select()
    .from(lists)
    .where(eq(lists.id, body.listId))
    .limit(1);
  if (!list[0]) return c.json({ error: "List not found" }, 404);

  const ts = now();
  const row = {
    id: nanoid(),
    listId: body.listId,
    name: body.name,
    showNameField: body.showNameField === false ? 0 : 1,
    nameRequired: body.nameRequired ? 1 : 0,
    successMessage: body.successMessage ?? "Thanks for subscribing!",
    redirectUrl: body.redirectUrl ?? null,
    allowedOrigins: body.allowedOrigins ?? null,
    createdAt: ts,
    updatedAt: ts,
  } satisfies typeof subscribeForms.$inferInsert;

  await db.insert(subscribeForms).values(row);
  return c.json(
    {
      ...serialize(row as typeof subscribeForms.$inferSelect),
      embedSnippet: buildEmbedSnippet(
        c.env.BASE_URL,
        row as typeof subscribeForms.$inferSelect,
      ),
    },
    201,
  );
});

// --- GET /:id ---

const getFormRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Subscribe forms"],
  description: "Get a form with its copy-paste embed snippet.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(FormWithSnippetSchema, "Form"),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

subscribeFormsRouter.openapi(getFormRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const rows = await db
    .select()
    .from(subscribeForms)
    .where(eq(subscribeForms.id, id))
    .limit(1);
  if (!rows[0]) return c.json({ error: "Form not found" }, 404);
  return c.json({
    ...serialize(rows[0]),
    embedSnippet: buildEmbedSnippet(c.env.BASE_URL, rows[0]),
  });
});

// --- PATCH /:id ---

const updateFormRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Subscribe forms"],
  description: "Update form settings. The bound list is immutable.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: UpdateFormSchema } },
      required: true,
    },
  },
  responses: {
    ...json200Response(FormSchema, "Updated form"),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

subscribeFormsRouter.openapi(updateFormRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const existing = await db
    .select()
    .from(subscribeForms)
    .where(eq(subscribeForms.id, id))
    .limit(1);
  if (!existing[0]) return c.json({ error: "Form not found" }, 404);

  const patch: Partial<typeof subscribeForms.$inferInsert> = {
    updatedAt: now(),
  };
  if (body.name !== undefined) patch.name = body.name;
  if (body.showNameField !== undefined) {
    patch.showNameField = body.showNameField ? 1 : 0;
  }
  if (body.nameRequired !== undefined) {
    patch.nameRequired = body.nameRequired ? 1 : 0;
  }
  if (body.successMessage !== undefined) {
    patch.successMessage = body.successMessage;
  }
  if (body.redirectUrl !== undefined) patch.redirectUrl = body.redirectUrl;
  if (body.allowedOrigins !== undefined) {
    patch.allowedOrigins = body.allowedOrigins;
  }

  await db.update(subscribeForms).set(patch).where(eq(subscribeForms.id, id));
  const updated = await db
    .select()
    .from(subscribeForms)
    .where(eq(subscribeForms.id, id))
    .limit(1);
  return c.json(serialize(updated[0]!));
});

// --- DELETE /:id ---

const deleteFormRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Subscribe forms"],
  description:
    "Delete a form. Memberships it created are untouched — their consent record names the form id, which stays meaningful as provenance.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(z.object({ deleted: z.literal(true) }), "Deleted"),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

subscribeFormsRouter.openapi(deleteFormRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const existing = await db
    .select()
    .from(subscribeForms)
    .where(eq(subscribeForms.id, id))
    .limit(1);
  if (!existing[0]) return c.json({ error: "Form not found" }, 404);
  await db.delete(subscribeForms).where(eq(subscribeForms.id, id));
  return c.json({ deleted: true as const });
});
