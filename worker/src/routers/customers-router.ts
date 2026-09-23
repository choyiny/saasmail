import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { customerPeople, customers } from "../db/customers.schema";
import {
  getCustomerByPerson,
  linkPeople,
  unlinkPerson,
} from "../lib/customers";
import { json200Response } from "../lib/helpers";
import { getPersonScoped } from "../lib/queries/people";
import type { Variables } from "../variables";

export const customersRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const CustomerSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  people: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      name: z.string().nullable(),
    }),
  ),
});

const getByPersonRoute = createRoute({
  method: "get",
  path: "/by-person/{personId}",
  tags: ["Customers"],
  request: { params: z.object({ personId: z.string().min(1) }) },
  responses: {
    ...json200Response(
      z.object({ customer: CustomerSchema.nullable() }),
      "Linked customer for this person",
    ),
    404: { description: "Person not found" },
  },
});

customersRouter.openapi(getByPersonRoute, async (c) => {
  const { personId } = c.req.valid("param");
  try {
    const customer = await getCustomerByPerson(
      c.get("db"),
      c.get("allowedInboxes")!,
      personId,
    );
    return c.json({ customer }, 200);
  } catch (error: any) {
    if (error?.status === 404)
      return c.json({ error: "Person not found" }, 404);
    throw error;
  }
});

const linkRoute = createRoute({
  method: "post",
  path: "/link",
  tags: ["Customers"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            personId: z.string().min(1),
            otherPersonId: z.string().min(1),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(CustomerSchema, "Linked customer"),
    404: { description: "Person not found" },
  },
});

customersRouter.openapi(linkRoute, async (c) => {
  const { personId, otherPersonId } = c.req.valid("json");
  try {
    await linkPeople(
      c.get("db"),
      c.get("allowedInboxes")!,
      c.get("user")?.id ?? null,
      personId,
      otherPersonId,
    );
    const customer = await getCustomerByPerson(
      c.get("db"),
      c.get("allowedInboxes")!,
      personId,
    );
    if (!customer) return c.json({ error: "Person not found" }, 404);
    return c.json(customer, 200);
  } catch (error: any) {
    if (error?.status === 404)
      return c.json({ error: "Person not found" }, 404);
    throw error;
  }
});

const unlinkRoute = createRoute({
  method: "post",
  path: "/unlink",
  tags: ["Customers"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ personId: z.string().min(1) }),
        },
      },
    },
  },
  responses: {
    ...json200Response(z.object({ success: z.literal(true) }), "Unlinked"),
    404: { description: "Person not found" },
  },
});

customersRouter.openapi(unlinkRoute, async (c) => {
  const { personId } = c.req.valid("json");
  try {
    await unlinkPerson(
      c.get("db"),
      c.get("allowedInboxes")!,
      c.get("user")?.id ?? null,
      personId,
    );
    return c.json({ success: true as const }, 200);
  } catch (error: any) {
    if (error?.status === 404)
      return c.json({ error: "Person not found" }, 404);
    throw error;
  }
});

const patchRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Customers"],
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            displayName: z.string().trim().max(200).nullable(),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(CustomerSchema, "Updated customer"),
    404: { description: "Customer not found" },
  },
});

customersRouter.openapi(patchRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { id } = c.req.valid("param");
  const { displayName } = c.req.valid("json");
  const rows = await db
    .select({ personId: customerPeople.personId })
    .from(customerPeople)
    .where(eq(customerPeople.customerId, id));

  let visiblePersonId: string | null = null;
  for (const row of rows) {
    if (await getPersonScoped(db, row.personId, allowed)) {
      visiblePersonId = row.personId;
      break;
    }
  }
  if (!visiblePersonId) return c.json({ error: "Customer not found" }, 404);

  await db
    .update(customers)
    .set({ displayName, updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(customers.id, id));
  const customer = await getCustomerByPerson(db, allowed, visiblePersonId);
  if (!customer) return c.json({ error: "Customer not found" }, 404);
  return c.json(customer, 200);
});
