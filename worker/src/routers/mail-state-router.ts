import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import { mailItemStates } from "../db/mail-item-states.schema";
import { json200Response } from "../lib/helpers";
import type { Variables } from "../variables";

/**
 * Per-user star / pin / archive / snooze state for inbox rows.
 *
 * The state only ever touches the caller's own rows and the response
 * reveals nothing about the item, so no inbox-scope check is needed: an id
 * the caller can't see just gets a state row that no list will surface.
 */
export const mailStateRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const ItemRefSchema = z.object({
  type: z.enum(["person", "group"]),
  id: z.string().min(1),
});

const MailStateSchema = z.object({
  type: z.enum(["person", "group"]),
  id: z.string(),
  starred: z.boolean(),
  pinned: z.boolean(),
  archivedAt: z.number().nullable(),
  snoozedUntil: z.number().nullable(),
  trashedAt: z.number().nullable(),
});

const updateRoute = createRoute({
  method: "patch",
  path: "/",
  tags: ["Mail state"],
  description:
    "Star, pin, archive or snooze one or more inbox rows for the signed-in user. Omitted fields keep their value. `archived: true` archives as of now; new mail brings the row back to the inbox. `snoozedUntil` is unix seconds; `null` wakes a snoozed row. All timestamps are unix seconds.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(ItemRefSchema).min(1).max(100),
            starred: z.boolean().optional(),
            pinned: z.boolean().optional(),
            archived: z.boolean().optional(),
            snoozedUntil: z.number().int().nullable().optional(),
            trashed: z.boolean().optional().openapi({
              description:
                "Move to (or out of) the caller's Trash. Trash is per user and hides the row everywhere else; new mail brings it back. Permanent deletion is DELETE /api/people/{id}.",
            }),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(
      z.object({ data: z.array(MailStateSchema) }),
      "State of each item after the update",
    ),
  },
});

mailStateRouter.openapi(updateRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const body = c.req.valid("json");
  // Unix seconds, like emails.received_at, so archive can be compared
  // with a row's lastEmailAt.
  const now = Math.floor(Date.now() / 1000);

  const set: Record<string, unknown> = { updatedAt: now };
  if (body.starred !== undefined) set.starred = body.starred ? 1 : 0;
  if (body.pinned !== undefined) set.pinned = body.pinned ? 1 : 0;
  if (body.archived !== undefined) {
    set.archivedAt = body.archived ? now : null;
    // Archiving also clears a snooze, as in Gmail.
    if (body.archived && body.snoozedUntil === undefined)
      set.snoozedUntil = null;
  }
  if (body.trashed !== undefined) {
    set.trashedAt = body.trashed ? now : null;
  }
  if (body.snoozedUntil !== undefined) {
    set.snoozedUntil = body.snoozedUntil;
    // Snoozing takes the row out of the archive.
    if (body.snoozedUntil !== null && body.archived === undefined)
      set.archivedAt = null;
  }

  // De-dupe so one batch can't write the same row twice.
  const seen = new Set<string>();
  const items = body.items.filter((i) => {
    const k = `${i.type}:${i.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  await db.batch(
    items.map((item) =>
      db
        .insert(mailItemStates)
        .values({
          userId: user.id,
          itemType: item.type,
          itemId: item.id,
          starred: 0,
          pinned: 0,
          archivedAt: null,
          snoozedUntil: null,
          trashedAt: null,
          ...set,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            mailItemStates.userId,
            mailItemStates.itemType,
            mailItemStates.itemId,
          ],
          set,
        }),
    ) as any,
  );

  const rows = await db
    .select()
    .from(mailItemStates)
    .where(
      and(
        eq(mailItemStates.userId, user.id),
        sql`(${mailItemStates.itemType} || ':' || ${mailItemStates.itemId}) IN ${[...seen]}`,
      ),
    );
  return c.json(
    {
      data: rows.map((r) => ({
        type: r.itemType as "person" | "group",
        id: r.itemId,
        starred: r.starred === 1,
        pinned: r.pinned === 1,
        archivedAt: r.archivedAt,
        snoozedUntil: r.snoozedUntil,
        trashedAt: r.trashedAt,
      })),
    },
    200,
  );
});
