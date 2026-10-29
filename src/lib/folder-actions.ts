import {
  fetchGroupedIds,
  markConversationsRead,
  markPeopleRead,
  undoMailState,
  updateMailState,
  type GroupedQuery,
  type MailItemRef,
  type MailStateUndoStep,
} from "@/lib/api";

/** Split into chunks the API accepts (100 per call). */
function chunks<T>(xs: T[], n = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * Mark every unread row matching a list query as read — the whole folder,
 * not just the loaded page. Returns how many rows were affected.
 */
export async function markFolderRead(
  query: Omit<GroupedQuery, "page" | "limit" | "withTabCounts">,
): Promise<number> {
  const { data } = await fetchGroupedIds({ ...query, unread: true });
  const people = data.filter((r) => r.type === "person").map((r) => r.id);
  const groups = data.filter((r) => r.type === "group").map((r) => r.id);
  await Promise.all([
    ...chunks(people).map((ids) => markPeopleRead(ids)),
    ...chunks(groups).map((ids) => markConversationsRead(ids)),
  ]);
  return data.length;
}

/** The pins a whole-folder change flipped, and the value to put back. */
export type FolderPinUndo = { items: MailItemRef[]; pinned: boolean } | null;

/**
 * Apply a mail-state patch to every row matching a list query. Returns how
 * many rows it covered, the undo steps of every call (for `undoMailState`)
 * and the pins it flipped (the server's undo steps don't carry pins), so
 * `undoFolderChange` can put both back.
 */
export async function applyToFolder(
  query: Omit<GroupedQuery, "page" | "limit" | "withTabCounts">,
  patch: Parameters<typeof updateMailState>[1],
): Promise<{ rows: number; undo: MailStateUndoStep[]; pins: FolderPinUndo }> {
  const { data } = await fetchGroupedIds(query);
  const undo: MailStateUndoStep[] = [];
  const flipped: MailItemRef[] = [];
  for (const batch of chunks(data)) {
    const refs = batch.map(({ type, id }) => ({ type, id }));
    undo.push(...(await updateMailState(refs, patch)).undo);
    flipped.push(...(pinUndo(batch, patch.pinned)?.items ?? []));
  }
  const pins: FolderPinUndo =
    flipped.length > 0 && patch.pinned !== undefined
      ? { items: flipped, pinned: !patch.pinned }
      : null;
  return { rows: data.length, undo, pins };
}

/** Undo an `applyToFolder` change: its state steps, then its pins. */
export async function undoFolderChange(res: {
  undo: MailStateUndoStep[];
  pins: FolderPinUndo;
}): Promise<void> {
  await undoMailState(res.undo);
  if (!res.pins) return;
  for (const c of chunks(res.pins.items))
    await updateMailState(c, { pinned: res.pins.pinned });
}

/**
 * The pin half of an exact Undo: the rows whose pin a change flipped, and
 * the value to put back (pins are the caller's own, so nothing else moved).
 */
export function pinUndo(
  rows: Array<MailItemRef & { pinned: boolean }>,
  pinned: boolean | undefined,
): { items: MailItemRef[]; pinned: boolean } | null {
  if (pinned === undefined) return null;
  const items = rows
    .filter((r) => r.pinned !== pinned)
    .map(({ type, id }) => ({ type, id }));
  return items.length > 0 ? { items, pinned: !pinned } : null;
}

/**
 * Delete forever every person row matching a list query (Empty Trash).
 * Group conversations can't be hard-deleted, so they are left as they are
 * and counted in `skippedGroups`. Admins only (the server refuses others).
 */
export async function deleteFolderForever(
  query: Omit<GroupedQuery, "page" | "limit" | "withTabCounts">,
  deleteOne: (personId: string) => Promise<unknown>,
): Promise<{ deleted: number; failed: number; skippedGroups: number }> {
  const { data } = await fetchGroupedIds(query);
  const people = data.filter((r) => r.type === "person").map((r) => r.id);
  let deleted = 0;
  let failed = 0;
  // A few at a time: each delete also removes the person's attachments.
  for (const batch of chunks(people, 4)) {
    const results = await Promise.allSettled(batch.map((id) => deleteOne(id)));
    for (const r of results) {
      if (r.status === "fulfilled") deleted++;
      else failed++;
    }
  }
  return {
    deleted,
    failed,
    skippedGroups: data.length - people.length,
  };
}
