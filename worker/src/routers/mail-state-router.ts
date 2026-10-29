import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  MAX_SNOOZE_SECONDS,
  snoozeConversations,
} from "../lib/messages/conversation-state";
import { MESSAGE_REFS_PER_QUERY } from "../lib/messages/query";
import {
  MAX_ROW_STATE_MESSAGES,
  rowKey,
  rowMailState,
  rowMessages,
  type RowMailState,
  type RowMessage,
  type RowRef,
} from "../lib/messages/row-state";
import {
  InvalidMessageStateError,
  setMailboxState,
  setRowPins,
  setUserState,
} from "../lib/messages/state";
import { serializeMessageRef, type MessageRef } from "../lib/messages/types";
import type { Variables } from "../variables";

/**
 * Star, pin, archive, snooze and trash for inbox-list rows, written to the
 * per-message state that /mail, JMAP and the agent read (docs/mailbox-state.md
 * § Rows in the inbox list). Star and pin are the caller's own; archive,
 * snooze and trash are shared by everyone in the inbox. Every write goes
 * through lib/messages/state.ts or conversation-state.ts's snoozeConversations.
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

const UndoStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mailbox"),
    refs: z.array(z.string()),
    change: z.union([
      z.object({ archived: z.boolean() }),
      z.object({ trashed: z.boolean() }),
    ]),
  }),
  z.object({
    kind: z.literal("user"),
    refs: z.array(z.string()),
    change: z.object({ starred: z.boolean() }),
  }),
  z.object({
    kind: z.literal("snooze"),
    refs: z.array(z.string()),
    until: z.number().nullable(),
  }),
]);
type UndoStep = z.infer<typeof UndoStepSchema>;

const ErrorSchema = z.object({ error: z.string() });

const updateRoute = createRoute({
  method: "patch",
  path: "/",
  tags: ["Mail state"],
  description:
    "Star, pin, archive, snooze or trash inbox rows. Star and pin are the caller's own; archive, snooze and trash change the rows' messages for everyone in the inbox, as in /mail. New mail brings an archived or trashed row back. `snoozedUntil` is unix seconds (future, at most 366 days); `null` wakes the row. A request over 5,000 messages answers 400 and writes nothing. `undo` lists the exact changes, to replay through /api/messages. A failure after the first write answers 500 with `partial: true`: send the same request again to finish.",
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
                "Move the row's messages to (or out of) the inbox's Trash, shared by everyone in it.",
            }),
          }),
        },
      },
    },
  },
  responses: {
    500: {
      description:
        "Failed after a partial write: `{ error, partial: true }`; the same request finishes it",
    },
    200: {
      description: "State of each item after the update, and how to undo it",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(MailStateSchema),
            undo: z.array(UndoStepSchema),
          }),
        },
      },
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Invalid request; nothing was written",
    },
  },
});

function dedupeItems(items: RowRef[]): RowRef[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = rowKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const refOf = (m: RowMessage): MessageRef => ({ kind: m.kind, id: m.id });

/** Run `write` over `refs` in chunks of MESSAGE_REFS_PER_QUERY. */
async function inChunks(
  refs: MessageRef[],
  write: (chunk: MessageRef[]) => Promise<unknown>,
): Promise<void> {
  for (let start = 0; start < refs.length; start += MESSAGE_REFS_PER_QUERY) {
    await write(refs.slice(start, start + MESSAGE_REFS_PER_QUERY));
  }
}

const tooMany = `A request may touch at most ${MAX_ROW_STATE_MESSAGES} messages`;

mailStateRouter.openapi(updateRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const allowed = c.get("allowedInboxes")!;
  const body = c.req.valid("json");
  const items = dedupeItems(body.items);
  const now = Math.floor(Date.now() / 1000);
  const viewer = { userId: user.id };

  // ----- Validate first: any 400 writes nothing. -----
  const until = body.snoozedUntil;
  if (
    until !== undefined &&
    until !== null &&
    (until <= now || until > now + MAX_SNOOZE_SECONDS)
  ) {
    return c.json(
      {
        error:
          "Snooze time must be in the future and no more than 366 days away",
      },
      400,
    );
  }
  const messages = await rowMessages(
    db,
    allowed,
    viewer,
    items,
    now,
    MAX_ROW_STATE_MESSAGES + 1,
  );
  if (messages.length > MAX_ROW_STATE_MESSAGES) {
    return c.json({ error: tooMany }, 400);
  }
  // Every change below runs over the eligible (non-spam) messages; each step
  // updates them in memory, so the next step sees what the previous wrote.
  const eligible = messages.filter((m) => m.spamAt === null);

  const undo: UndoStep[] = [];
  let wrote = false;
  let state: Map<string, RowMailState> = new Map();
  const write = async (fn: () => Promise<unknown>) => {
    wrote = true;
    await fn();
  };
  const mailbox = async (
    targets: RowMessage[],
    change: { archived: boolean } | { trashed: boolean },
  ) => {
    if (targets.length === 0) return;
    const refs = targets.map(refOf);
    await write(() =>
      inChunks(refs, (chunk) =>
        setMailboxState(db, allowed, user.id, chunk, change),
      ),
    );
    for (const m of targets) {
      if ("archived" in change) m.archivedAt = change.archived ? now : null;
      else m.trashedAt = change.trashed ? now : null;
    }
    undo.push({
      kind: "mailbox",
      refs: refs.map(serializeMessageRef),
      change:
        "archived" in change
          ? { archived: !change.archived }
          : { trashed: !change.trashed },
    });
  };
  const inboxState = (m: RowMessage) =>
    m.kind === "received" && m.archivedAt === null && m.trashedAt === null;

  try {
    if (body.trashed !== undefined) {
      await mailbox(
        eligible.filter((m) =>
          body.trashed ? m.trashedAt === null : m.trashedAt !== null,
        ),
        { trashed: body.trashed },
      );
    }
    if (body.archived !== undefined) {
      await mailbox(
        body.archived
          ? eligible.filter(inboxState)
          : eligible.filter(
              (m) => m.kind === "received" && m.archivedAt !== null,
            ),
        { archived: body.archived },
      );
    }
    if (until !== undefined) {
      if (until !== null) {
        // Snooze takes the row out of the archive (as upstream).
        await mailbox(
          eligible.filter(
            (m) => m.kind === "received" && m.archivedAt !== null,
          ),
          { archived: false },
        );
      }
      // One ref per conversation (inbox and conversation key) whose wake
      // time changes; the undo restores each conversation's previous one.
      const byConversation = new Map<string, RowMessage>();
      for (const m of eligible) {
        if (m.kind !== "received" || m.conversationKey === null) continue;
        if (until === null && m.snoozedUntil === null) continue;
        if (until !== null && m.snoozedUntil === until) continue;
        const key = `${m.inbox}\u0000${m.conversationKey}`;
        if (!byConversation.has(key)) byConversation.set(key, m);
      }
      const changed = [...byConversation.values()];
      if (changed.length > 0) {
        await write(() =>
          inChunks(changed.map(refOf), (chunk) =>
            snoozeConversations(db, allowed, user.id, chunk, until),
          ),
        );
        const byPrevious = new Map<number | null, string[]>();
        for (const m of changed) {
          const refs = byPrevious.get(m.snoozedUntil) ?? [];
          refs.push(serializeMessageRef(refOf(m)));
          byPrevious.set(m.snoozedUntil, refs);
        }
        for (const [previous, refs] of byPrevious) {
          undo.push({ kind: "snooze", refs, until: previous });
        }
      }
    }
    if (body.starred !== undefined) {
      let targets: RowMessage[];
      if (body.starred) {
        // The latest eligible message of each row (messages are newest first).
        const latest = new Map<string, RowMessage>();
        for (const m of eligible) {
          const key = m.conversationId
            ? `group:${m.conversationId}`
            : `person:${m.personId}`;
          if (!latest.has(key)) latest.set(key, m);
        }
        targets = [...latest.values()].filter((m) => m.starredAt === null);
      } else {
        targets = eligible.filter((m) => m.starredAt !== null);
      }
      if (targets.length > 0) {
        const refs = targets.map(refOf);
        await write(() =>
          inChunks(refs, (chunk) =>
            setUserState(db, user.id, chunk, { starred: body.starred }),
          ),
        );
        undo.push({
          kind: "user",
          refs: refs.map(serializeMessageRef),
          change: { starred: !body.starred },
        });
      }
    }
    if (body.pinned !== undefined) {
      await write(() =>
        setRowPins(db, user.id, allowed, items, body.pinned as boolean),
      );
    }
    // Inside the guard: once a write has committed, a failure here is
    // still a partial result for the client.
    state = await rowMailState(db, viewer, allowed, now, items);
  } catch (error) {
    if (!wrote && error instanceof InvalidMessageStateError) {
      return c.json({ error: error.message }, 400);
    }
    if (!wrote) throw error;
    console.error("mail-state: failed after a partial write", error);
    return c.json(
      {
        error: "Some changes were not saved. Try again.",
        partial: true as const,
      },
      500,
    );
  }

  return c.json(
    {
      data: items.map((item) => {
        const st = state.get(rowKey(item));
        return {
          type: item.type,
          id: item.id,
          starred: st?.starred ?? false,
          pinned: st?.pinned ?? false,
          archivedAt: st?.archivedAt ?? null,
          snoozedUntil: st?.snoozedUntil ?? null,
          trashedAt: st?.trashedAt ?? null,
        };
      }),
      undo,
    },
    200,
  );
});
