import { useEffect, useState } from "react";
import {
  fetchAdminInboxes,
  fetchAdminUsers,
  updateInboxAssignments,
  updateInboxDisplayName,
  type AdminInbox,
  type AdminUser,
} from "@/lib/api";

export default function AdminInboxTable() {
  const [inboxes, setInboxes] = useState<AdminInbox[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([fetchAdminInboxes(), fetchAdminUsers()]).then(([i, u]) => {
      setInboxes(i);
      setUsers(u);
      setLoading(false);
    });
  }, []);

  const members = users.filter((u) => u.role !== "admin");

  async function handleNameBlur(inbox: AdminInbox, value: string) {
    const next = value.trim() === "" ? null : value.trim();
    if (next === inbox.displayName) return;
    const res = await updateInboxDisplayName(inbox.email, next);
    setInboxes((prev) =>
      prev.map((r) =>
        r.email === inbox.email ? { ...r, displayName: res.displayName } : r,
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

  if (loading) {
    return <p className="text-text-secondary">Loading…</p>;
  }

  if (inboxes.length === 0) {
    return (
      <p className="text-text-secondary">
        No inboxes yet. Once you receive email, inboxes will appear here.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {inboxes.map((inbox) => (
        <div
          key={inbox.email}
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
                className="mt-1 w-full rounded bg-white ring-1 ring-gray-200 px-2 py-1 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent"
              />
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
