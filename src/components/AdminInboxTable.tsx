import { useEffect, useState } from "react";
import {
  createInbox,
  deleteInbox,
  fetchAdminInboxes,
  fetchAdminUsers,
  updateInboxAssignments,
  updateInboxSettings,
  type AdminInbox,
  type AdminUser,
} from "@/lib/api";

export default function AdminInboxTable() {
  const [inboxes, setInboxes] = useState<AdminInbox[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [newEmail, setNewEmail] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchAdminInboxes(), fetchAdminUsers()]).then(([i, u]) => {
      setInboxes(i);
      setUsers(u);
      setLoading(false);
    });
  }, []);

  const members = users.filter((u) => u.role !== "admin");

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const email = newEmail.trim().toLowerCase();
    if (!email) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createInbox({
        email,
        displayName: newDisplayName.trim() || null,
      });
      setInboxes((prev) => {
        if (prev.some((r) => r.email === created.email)) {
          return prev.map((r) =>
            r.email === created.email
              ? {
                  ...r,
                  displayName: created.displayName,
                  displayMode: created.displayMode,
                }
              : r,
          );
        }
        return [...prev, created].sort((a, b) =>
          a.email.localeCompare(b.email),
        );
      });
      setNewEmail("");
      setNewDisplayName("");
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Failed to create inbox",
      );
    } finally {
      setCreating(false);
    }
  }

  async function handleNameBlur(inbox: AdminInbox, value: string) {
    const next = value.trim() === "" ? null : value.trim();
    if (next === inbox.displayName) return;
    const res = await updateInboxSettings(inbox.email, { displayName: next });
    setInboxes((prev) =>
      prev.map((r) =>
        r.email === inbox.email
          ? { ...r, displayName: res.displayName, displayMode: res.displayMode }
          : r,
      ),
    );
  }

  async function handleToggleAssignment(inbox: AdminInbox, userId: string) {
    const has = inbox.assignedUserIds.includes(userId);
    const nextIds = has
      ? inbox.assignedUserIds.filter((x) => x !== userId)
      : [...inbox.assignedUserIds, userId];
    const res = await updateInboxAssignments(inbox.email, nextIds);
    setInboxes((prev) =>
      prev.map((r) =>
        r.email === inbox.email
          ? { ...r, assignedUserIds: res.assignedUserIds }
          : r,
      ),
    );
  }

  async function handleSetMode(inbox: AdminInbox, next: "thread" | "chat") {
    if (inbox.displayMode === next) return;
    // Optimistic update with rollback on error.
    const prev = inbox.displayMode;
    setInboxes((all) =>
      all.map((r) =>
        r.email === inbox.email ? { ...r, displayMode: next } : r,
      ),
    );
    try {
      const res = await updateInboxSettings(inbox.email, { displayMode: next });
      setInboxes((all) =>
        all.map((r) =>
          r.email === inbox.email ? { ...r, displayMode: res.displayMode } : r,
        ),
      );
    } catch (err) {
      setInboxes((all) =>
        all.map((r) =>
          r.email === inbox.email ? { ...r, displayMode: prev } : r,
        ),
      );
      console.error("Failed to update inbox mode", err);
    }
  }

  async function handleDelete(inbox: AdminInbox) {
    if (
      !window.confirm(`Delete inbox "${inbox.email}"? This cannot be undone.`)
    )
      return;
    await deleteInbox(inbox.email);
    setInboxes((prev) => prev.filter((r) => r.email !== inbox.email));
  }

  if (loading) {
    return <p className="text-text-secondary">Loading…</p>;
  }

  const createForm = (
    <form
      onSubmit={handleCreate}
      className="rounded-lg border border-border bg-white ring-1 ring-gray-200 p-4"
    >
      <div className="mb-2 text-xs uppercase tracking-wide text-text-tertiary">
        Create inbox
      </div>
      <div className="flex flex-col gap-2 md:flex-row">
        <input
          type="email"
          required
          value={newEmail}
          onChange={(e) => setNewEmail(e.currentTarget.value)}
          placeholder="inbox@example.com"
          data-testid="inbox-create-email"
          className="flex-1 rounded bg-white ring-1 ring-gray-200 px-2 py-1 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent"
        />
        <input
          type="text"
          value={newDisplayName}
          onChange={(e) => setNewDisplayName(e.currentTarget.value)}
          placeholder="Display name (optional)"
          data-testid="inbox-create-display-name"
          className="flex-1 rounded bg-white ring-1 ring-gray-200 px-2 py-1 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent"
        />
        <button
          type="submit"
          data-testid="inbox-create-button"
          disabled={creating || newEmail.trim() === ""}
          className="rounded bg-accent px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create"}
        </button>
      </div>
      {createError && (
        <div className="mt-2 text-xs text-red-600">{createError}</div>
      )}
    </form>
  );

  if (inboxes.length === 0) {
    return (
      <div className="space-y-6">
        {createForm}
        <p className="text-text-secondary">
          No inboxes yet. Once you receive email or create one above, inboxes
          will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {createForm}
      {inboxes.map((inbox) => (
        <div
          key={inbox.email}
          data-testid="inbox-row"
          data-inbox-email={inbox.email}
          className="rounded-lg border border-border bg-white ring-1 ring-gray-200 p-4"
        >
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex-1">
              <div className="text-sm font-medium text-text-primary">
                {inbox.email}
              </div>
              <input
                type="text"
                defaultValue={inbox.displayName ?? ""}
                placeholder="Display name (optional)"
                onBlur={(e) => handleNameBlur(inbox, e.currentTarget.value)}
                data-testid="inbox-display-name-input"
                className="mt-1 w-full rounded bg-white ring-1 ring-gray-200 px-2 py-1 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
            <button
              type="button"
              data-testid="inbox-delete-button"
              onClick={() => handleDelete(inbox)}
              className="self-start rounded px-2 py-1 text-xs text-red-500 hover:bg-red-50"
              aria-label={`Delete inbox ${inbox.email}`}
            >
              Delete
            </button>
          </div>
          <div className="mt-3">
            <div className="mb-1 text-xs uppercase tracking-wide text-text-tertiary">
              Mode
            </div>
            <div className="inline-flex rounded-md border border-border overflow-hidden">
              {(["thread", "chat"] as const).map((m) => {
                const active = inbox.displayMode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    data-testid="inbox-mode-toggle"
                    data-mode={m}
                    data-active={active}
                    onClick={() => handleSetMode(inbox, m)}
                    className={`px-3 py-1 text-xs font-medium ${
                      active
                        ? "bg-accent text-white"
                        : "bg-white text-text-secondary hover:bg-bg-muted"
                    }`}
                    aria-pressed={active}
                  >
                    {m === "thread" ? "Thread" : "Chat"}
                  </button>
                );
              })}
            </div>
            <div className="mt-1 text-xs text-text-tertiary">
              Chat mode shows the last 5 messages as bubbles with an inline
              reply.
            </div>
          </div>
          <div className="mt-4">
            <div className="mb-2 text-xs uppercase tracking-wide text-text-tertiary">
              Members
            </div>
            <div className="mb-2 text-xs text-text-secondary">
              Admins have access to every inbox automatically.
            </div>
            <div className="flex flex-wrap gap-2">
              {members.map((u) => {
                const on = inbox.assignedUserIds.includes(u.id);
                return (
                  <button
                    key={u.id}
                    data-testid="inbox-member-toggle"
                    data-user-id={u.id}
                    data-assigned={on}
                    onClick={() => handleToggleAssignment(inbox, u.id)}
                    className={`rounded-full px-3 py-1 text-xs ${
                      on
                        ? "bg-accent text-white"
                        : "bg-bg-muted text-text-secondary"
                    }`}
                  >
                    {u.name || u.email}
                  </button>
                );
              })}
              {members.length === 0 && (
                <span className="text-xs text-text-tertiary">
                  No members to assign.
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
