[saasmail](../README.md) › [Docs](README.md) › **Customers and linked addresses**

# Customers and linked addresses

A person row still represents one email address. The identity graph adds an optional
**customer** above people so operators can say that two or more addresses belong to
the same human or organization without collapsing, rewriting, or de-duplicating the
underlying people.

## Identity model

Unlinked people do not get customer rows. They are implicitly their own customer.
A persisted customer exists only while at least two people are linked:

- `customers` stores the identity id, optional display name, creator, and timestamps.
- `customer_people` links a person to at most one customer and records who linked it.
- Linking two unlinked people creates a customer.
- Linking an unlinked person to a linked person adds it to that customer.
- Linking two existing customers merges the smaller graph into the larger one.
- Unlinking a person removes that edge. If fewer than two people remain, the customer
  row is deleted and the last person becomes implicit again.
- Deleting a person runs the same cleanup, so one-person customer rows cannot remain.

The `people` and `contacts` tables remain unchanged and uncollapsed.

## Visibility and timelines

Identity does not expand mailbox permissions. Linking requires both people to be
visible under the existing person-visibility rule; callers get `404` rather than an
existence signal when either person is outside their scope. Customer reads expose
only people the caller can see.

The unified message service accepts a customer id by translating it to the linked
person ids. Its normal inbox predicate is still applied independently, so an address
may be linked while messages in an inbox the caller cannot access remain invisible.

The customer-centric UI enables **All addresses** by default for linked people.
Turning it off returns to the selected person's timeline. Native-agent
`customer_timeline` and automatic suggested-reply history also use the linked
customer scope while preserving their existing inbox boundaries.

## HTTP API

Authenticated callers use:

- `GET /api/customers/by-person/{personId}` — returns the linked customer and its
  visible people, or `{ "customer": null }` for an unlinked person.
- `POST /api/customers/link` with `{ "personId", "otherPersonId" }`.
- `POST /api/customers/unlink` with `{ "personId" }`.
- `PATCH /api/customers/{id}` with `{ "displayName" }` (a string or `null`).

The remote MCP surface exposes the read-only `get_customer` tool under
`email:read`. Mutating identity links remains an authenticated application API
operation rather than an MCP action.
