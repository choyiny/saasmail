import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { HTTPException } from "hono/http-exception";
import { nanoid } from "nanoid";
import { customerPeople, customers } from "../db/customers.schema";
import { people } from "../db/people.schema";
import type { AllowedInboxes } from "./inbox-permissions";
import { getPersonScoped } from "./queries/people";

export type CustomerScope = {
  customerId: string | null;
  personIds: string[];
};

export type CustomerView = {
  id: string;
  displayName: string | null;
  people: Array<{ id: string; email: string; name: string | null }>;
};

async function requireVisiblePerson(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  personId: string,
) {
  const person = await getPersonScoped(db, personId, allowed);
  if (!person) {
    throw new HTTPException(404, { message: "Person not found" });
  }
  return person;
}

async function membership(
  db: DrizzleD1Database<any>,
  personId: string,
): Promise<string | null> {
  const rows = await db
    .select({ customerId: customerPeople.customerId })
    .from(customerPeople)
    .where(eq(customerPeople.personId, personId))
    .limit(1);
  return rows[0]?.customerId ?? null;
}

async function customerSize(
  db: DrizzleD1Database<any>,
  customerId: string,
): Promise<number> {
  const rows = await db
    .select({ personId: customerPeople.personId })
    .from(customerPeople)
    .where(eq(customerPeople.customerId, customerId));
  return rows.length;
}

function isUniquePersonMembershipError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    const message =
      current instanceof Error ? current.message : String(current ?? "");
    if (
      /unique constraint failed:\s*customer_people\.person_id/i.test(message) ||
      /customer_people_person_id_unique/i.test(message)
    ) {
      return true;
    }
    current =
      current instanceof Error
        ? (current as Error & { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

async function removeMembershipAndCleanup(
  db: DrizzleD1Database<any>,
  customerId: string,
  personId: string,
): Promise<void> {
  const size = await customerSize(db, customerId);
  const removeMembership = db
    .delete(customerPeople)
    .where(eq(customerPeople.personId, personId));

  if (size <= 2) {
    await db.batch([
      removeMembership,
      db.delete(customers).where(eq(customers.id, customerId)),
    ]);
    return;
  }

  await db.batch([
    removeMembership,
    db
      .update(customers)
      .set({ updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(customers.id, customerId)),
  ]);
}

export async function resolveCustomerScope(
  db: DrizzleD1Database<any>,
  personId: string,
): Promise<CustomerScope> {
  const customerId = await membership(db, personId);
  if (!customerId) {
    return { customerId: null, personIds: [personId] };
  }
  const rows = await db
    .select({ personId: customerPeople.personId })
    .from(customerPeople)
    .where(eq(customerPeople.customerId, customerId));
  return { customerId, personIds: rows.map((row) => row.personId) };
}

async function linkPeopleDecision(
  db: DrizzleD1Database<any>,
  actor: string | null,
  a: string,
  b: string,
): Promise<CustomerScope> {
  const [aCustomer, bCustomer] = await Promise.all([
    membership(db, a),
    membership(db, b),
  ]);
  if (aCustomer && aCustomer === bCustomer) {
    return resolveCustomerScope(db, a);
  }

  const now = Math.floor(Date.now() / 1000);
  if (!aCustomer && !bCustomer) {
    const customerId = nanoid();
    await db.batch([
      db.insert(customers).values({
        id: customerId,
        displayName: null,
        createdBy: actor,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(customerPeople).values({
        customerId,
        personId: a,
        linkedBy: actor,
        linkedAt: now,
      }),
      db.insert(customerPeople).values({
        customerId,
        personId: b,
        linkedBy: actor,
        linkedAt: now,
      }),
    ]);
    return resolveCustomerScope(db, a);
  }

  if (!aCustomer || !bCustomer) {
    const customerId = aCustomer ?? bCustomer!;
    const personId = aCustomer ? b : a;
    await db.batch([
      db.insert(customerPeople).values({
        customerId,
        personId,
        linkedBy: actor,
        linkedAt: now,
      }),
      db
        .update(customers)
        .set({ updatedAt: now })
        .where(eq(customers.id, customerId)),
    ]);
    return resolveCustomerScope(db, a);
  }

  const [aSize, bSize] = await Promise.all([
    customerSize(db, aCustomer),
    customerSize(db, bCustomer),
  ]);
  const winner = aSize >= bSize ? aCustomer : bCustomer;
  const loser = winner === aCustomer ? bCustomer : aCustomer;
  await db.batch([
    db
      .update(customerPeople)
      .set({ customerId: winner })
      .where(eq(customerPeople.customerId, loser)),
    db.delete(customers).where(eq(customers.id, loser)),
    db
      .update(customers)
      .set({ updatedAt: now })
      .where(eq(customers.id, winner)),
  ]);
  return resolveCustomerScope(db, a);
}

export async function linkPeople(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  actor: string | null,
  a: string,
  b: string,
): Promise<CustomerScope> {
  await Promise.all([
    requireVisiblePerson(db, allowed, a),
    a === b ? Promise.resolve(null) : requireVisiblePerson(db, allowed, b),
  ]);
  if (a === b) return resolveCustomerScope(db, a);

  try {
    return await linkPeopleDecision(db, actor, a, b);
  } catch (error) {
    if (!isUniquePersonMembershipError(error)) throw error;
    return linkPeopleDecision(db, actor, a, b);
  }
}

export async function unlinkPerson(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  _actor: string | null,
  personId: string,
): Promise<CustomerScope> {
  await requireVisiblePerson(db, allowed, personId);
  const customerId = await membership(db, personId);
  if (!customerId) return { customerId: null, personIds: [personId] };

  await removeMembershipAndCleanup(db, customerId, personId);
  return { customerId: null, personIds: [personId] };
}

export async function cleanupCustomerForPersonDeletion(
  db: DrizzleD1Database<any>,
  personId: string,
): Promise<void> {
  const customerId = await membership(db, personId);
  if (!customerId) return;
  await removeMembershipAndCleanup(db, customerId, personId);
}

export async function getCustomerByPerson(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  personId: string,
): Promise<CustomerView | null> {
  await requireVisiblePerson(db, allowed, personId);
  const { customerId } = await resolveCustomerScope(db, personId);
  if (!customerId) return null;

  const customerRows = await db
    .select({ id: customers.id, displayName: customers.displayName })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  if (!customerRows[0]) return null;

  const members = await db
    .select({ id: people.id, email: people.email, name: people.name })
    .from(customerPeople)
    .innerJoin(people, eq(people.id, customerPeople.personId))
    .where(eq(customerPeople.customerId, customerId));

  const visible: CustomerView["people"] = [];
  for (const member of members) {
    if (await getPersonScoped(db, member.id, allowed)) visible.push(member);
  }
  return {
    id: customerRows[0].id,
    displayName: customerRows[0].displayName,
    people: visible,
  };
}
