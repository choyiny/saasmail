import { deletePerson, fetchGroupedIds } from "@/lib/api";
import { markFolderRead as markQueryRead } from "@/lib/folder-actions";
import { dispatchInboxRefresh } from "@/lib/inbox-events";
import { showToast } from "@/lib/toast";
import { folderQuery } from "./lib";
import type { FolderTarget } from "./FolderList";

/** Mark every unread conversation in a folder read (folder right-click). */
export async function markFolderRead(t: FolderTarget): Promise<number> {
  try {
    const n = await markQueryRead({
      ...folderQuery(t.folder),
      recipient: t.label,
    });
    showToast({
      kind: n ? "success" : "info",
      message: n
        ? `Marked ${n} conversation${n === 1 ? "" : "s"} as read`
        : "Everything here is already read",
    });
    dispatchInboxRefresh();
    return n;
  } catch {
    showToast({ kind: "error", message: "Couldn't mark all as read" });
    return 0;
  }
}

/**
 * Empty Deleted Items: permanently delete every person in the user's Trash
 * and their mail, for the whole team (asks first; admin-only on the server,
 * so callers offer it to admins only). Group conversations can't be purged
 * by the server and stay.
 */
export async function emptyTrash(): Promise<number> {
  try {
    const { data } = await fetchGroupedIds({ folder: "trash" });
    const people = data.filter((r) => r.type === "person");
    if (!data.length) {
      showToast({ kind: "info", message: "Deleted Items is already empty" });
      return 0;
    }
    const groups = data.length - people.length;
    if (
      !window.confirm(
        `Permanently delete the ${people.length} ${people.length === 1 ? "person" : "people"} in Deleted Items and all of their mail? This removes it for everyone on the team and can't be undone.` +
          (groups
            ? ` ${groups} group conversation${groups === 1 ? "" : "s"} can't be deleted permanently and will stay.`
            : ""),
      )
    )
      return 0;
    for (const p of people) await deletePerson(p.id);
    showToast({
      kind: "success",
      message: `Deleted ${people.length} conversation${people.length === 1 ? "" : "s"} permanently`,
    });
    dispatchInboxRefresh();
    return people.length;
  } catch (e) {
    showToast({
      kind: "error",
      message: e instanceof Error ? e.message : "Couldn't empty Deleted Items",
    });
    dispatchInboxRefresh();
    return 0;
  }
}
