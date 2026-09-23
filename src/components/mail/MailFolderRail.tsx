import { useState } from "react";
import {
  Archive,
  Clock3,
  FileText,
  Folder,
  Inbox,
  Pencil,
  PenSquare,
  Send,
  Star,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  createMailbox,
  deleteMailbox,
  renameMailbox,
  type Mailbox,
  type Stats,
} from "@/lib/api";
import { showToast } from "@/lib/toast";
import type { SystemFolder } from "@/hooks/useMailMessages";

export const SYSTEM_FOLDERS: Array<{
  id: SystemFolder;
  label: string;
  icon: React.ElementType;
}> = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "starred", label: "Starred", icon: Star },
  { id: "snoozed", label: "Snoozed", icon: Clock3 },
  { id: "drafts", label: "Drafts", icon: FileText },
  { id: "sent", label: "Sent", icon: Send },
  { id: "archive", label: "Archive", icon: Archive },
  { id: "junk", label: "Junk", icon: TriangleAlert },
  { id: "trash", label: "Trash", icon: Trash2 },
];

interface FolderRow {
  mailbox: Mailbox;
  depth: number;
}

function orderedFolderRows(mailboxes: Mailbox[]): FolderRow[] {
  const byParent = new Map<string | null, Mailbox[]>();
  for (const mailbox of mailboxes) {
    const siblings = byParent.get(mailbox.parentId) ?? [];
    siblings.push(mailbox);
    byParent.set(mailbox.parentId, siblings);
  }

  for (const siblings of byParent.values()) {
    siblings.sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    );
  }

  const rows: FolderRow[] = [];
  const visited = new Set<string>();

  function visit(parentId: string | null, depth: number) {
    for (const mailbox of byParent.get(parentId) ?? []) {
      if (visited.has(mailbox.id)) continue;
      visited.add(mailbox.id);
      rows.push({ mailbox, depth });
      visit(mailbox.id, depth + 1);
    }
  }

  visit(null, 0);

  for (const mailbox of mailboxes) {
    if (visited.has(mailbox.id)) continue;
    visited.add(mailbox.id);
    rows.push({ mailbox, depth: 0 });
    visit(mailbox.id, 1);
  }

  return rows;
}

interface MailFolderRailProps {
  visible: boolean;
  inbox: string;
  senderIdentities: Stats["senderIdentities"];
  mailboxes: Mailbox[];
  mailboxId?: string;
  systemFolder?: SystemFolder;
  onInboxChange: (inbox: string) => void;
  onNewMessage: () => void;
  onOpenSystemFolder: (folder: SystemFolder) => void;
  onOpenMailbox: (mailboxId: string) => void;
  onMailboxCreated: (mailbox: Mailbox) => void;
  onMailboxUpdated: (mailbox: Mailbox) => void;
  onMailboxDeleted: (mailboxId: string) => void;
}

export default function MailFolderRail({
  visible,
  inbox,
  senderIdentities,
  mailboxes,
  mailboxId,
  systemFolder,
  onInboxChange,
  onNewMessage,
  onOpenSystemFolder,
  onOpenMailbox,
  onMailboxCreated,
  onMailboxUpdated,
  onMailboxDeleted,
}: MailFolderRailProps) {
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderParentId, setNewFolderParentId] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderActionId, setFolderActionId] = useState<string | null>(null);
  const folderRows = orderedFolderRows(mailboxes);

  async function createCustomFolder() {
    const name = newFolderName.trim();
    if (!name || creatingFolder) return;

    setCreatingFolder(true);
    try {
      const mailbox = await createMailbox({
        inbox,
        name,
        parentId: newFolderParentId || null,
      });
      onMailboxCreated(mailbox);
      setNewFolderName("");
      setNewFolderParentId("");
    } catch (error) {
      showToast({
        kind: "error",
        message: "Couldn’t create folder",
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setCreatingFolder(false);
    }
  }

  async function renameCustomFolder(mailbox: Mailbox) {
    const nextName = window.prompt("Rename folder", mailbox.name)?.trim();
    if (!nextName || nextName === mailbox.name) return;

    setFolderActionId(mailbox.id);
    try {
      onMailboxUpdated(await renameMailbox(mailbox.id, nextName));
    } catch (error) {
      showToast({
        kind: "error",
        message: "Couldn’t rename folder",
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setFolderActionId(null);
    }
  }

  async function deleteCustomFolder(mailbox: Mailbox) {
    if (!window.confirm(`Delete folder "${mailbox.name}"?`)) return;

    setFolderActionId(mailbox.id);
    try {
      await deleteMailbox(mailbox.id);
      onMailboxDeleted(mailbox.id);
    } catch (error) {
      showToast({
        kind: "error",
        message: "Couldn’t delete folder",
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setFolderActionId(null);
    }
  }

  return (
    <aside
      className={`${visible ? "flex" : "hidden"} w-full shrink-0 flex-col border-r border-border bg-bg-subtle md:flex md:w-56`}
    >
      <div className="border-b border-border p-3">
        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
          Inbox
        </label>
        <select
          aria-label="Mail inbox"
          value={inbox}
          onChange={(event) => onInboxChange(event.target.value)}
          className="w-full rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary outline-none focus:border-text-tertiary"
        >
          {senderIdentities.map((identity) => (
            <option key={identity.email} value={identity.email}>
              {identity.displayName || identity.email}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="mail-new-message"
          onClick={onNewMessage}
          className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-[6px] bg-text-primary px-3 py-2 text-xs font-medium text-background transition-opacity hover:opacity-90"
        >
          <PenSquare className="h-3.5 w-3.5" />
          New message
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto p-2">
        {SYSTEM_FOLDERS.map((entry) => {
          const Icon = entry.icon;
          const active = !mailboxId && systemFolder === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => onOpenSystemFolder(entry.id)}
              data-testid={`mail-folder-${entry.id}`}
              className={`flex w-full items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-sm transition-colors ${
                active
                  ? "bg-bg-muted font-medium text-text-primary"
                  : "text-text-secondary hover:bg-bg-muted/70 hover:text-text-primary"
              }`}
            >
              <Icon className="h-4 w-4" />
              {entry.label}
            </button>
          );
        })}

        <div className="my-2 border-t border-border" />
        <p className="px-2.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
          Folders
        </p>
        <div className="mb-2 space-y-1 px-1">
          <div className="flex gap-1">
            <input
              aria-label="New folder name"
              data-testid="mail-create-folder-input"
              value={newFolderName}
              onChange={(event) => setNewFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void createCustomFolder();
                }
              }}
              placeholder="New folder"
              className="min-w-0 flex-1 rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary outline-none focus:border-text-tertiary"
            />
            <button
              type="button"
              data-testid="mail-create-folder-button"
              disabled={!newFolderName.trim() || creatingFolder}
              onClick={() => void createCustomFolder()}
              className="rounded-[6px] border border-border px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-muted disabled:opacity-50"
            >
              {creatingFolder ? "…" : "Add"}
            </button>
          </div>
          <select
            aria-label="Parent folder"
            data-testid="mail-create-folder-parent"
            value={newFolderParentId}
            onChange={(event) => setNewFolderParentId(event.target.value)}
            className="w-full rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-secondary outline-none focus:border-text-tertiary"
          >
            <option value="">Root folder</option>
            {folderRows.map(({ mailbox, depth }) => (
              <option key={mailbox.id} value={mailbox.id}>
                {`${"— ".repeat(depth)}${mailbox.name}`}
              </option>
            ))}
          </select>
        </div>

        {mailboxes.length === 0 ? (
          <p className="px-2.5 py-2 text-xs text-text-tertiary">
            No custom folders
          </p>
        ) : (
          folderRows.map(({ mailbox, depth }) => (
            <div
              key={mailbox.id}
              className={`group flex items-center rounded-[6px] transition-colors ${
                mailbox.id === mailboxId
                  ? "bg-bg-muted text-text-primary"
                  : "text-text-secondary hover:bg-bg-muted/70 hover:text-text-primary"
              }`}
              style={{ paddingLeft: `${depth * 12}px` }}
            >
              <button
                type="button"
                onClick={() => onOpenMailbox(mailbox.id)}
                data-testid="mail-custom-folder"
                data-mailbox-id={mailbox.id}
                className={`flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-sm ${
                  mailbox.id === mailboxId ? "font-medium" : ""
                }`}
              >
                <Folder className="h-4 w-4 shrink-0" />
                <span className="truncate">{mailbox.name}</span>
              </button>
              <button
                type="button"
                aria-label={`Rename ${mailbox.name}`}
                data-testid="mail-rename-folder"
                data-mailbox-id={mailbox.id}
                disabled={folderActionId === mailbox.id}
                onClick={() => void renameCustomFolder(mailbox)}
                className="rounded p-1 text-text-tertiary opacity-70 hover:bg-bg-muted hover:text-text-primary disabled:opacity-40 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label={`Delete ${mailbox.name}`}
                data-testid="mail-delete-folder"
                data-mailbox-id={mailbox.id}
                disabled={folderActionId === mailbox.id}
                onClick={() => void deleteCustomFolder(mailbox)}
                className="mr-1 rounded p-1 text-text-tertiary opacity-70 hover:bg-bg-muted hover:text-text-primary disabled:opacity-40 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}
      </nav>
    </aside>
  );
}
