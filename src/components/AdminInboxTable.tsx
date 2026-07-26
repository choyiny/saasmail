import { useEffect, useMemo, useState } from "react";
import {
  Plus,
  Inbox as InboxIcon,
  MessageSquare,
  MessageCircle,
  Trash2,
  X,
  Loader2,
  Pen,
} from "lucide-react";
import TiptapEditor from "@/components/TiptapEditor";
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
import { cn } from "@/lib/utils";

/**
 * Admin "Inboxes" table. Real table layout with bulk select + bulk
 * actions, inline display-name editing (blur-to-save), mode toggle
 * per row, and inline member-assignment chips.
 */
export default function AdminInboxTable() {
  const [inboxes, setInboxes] = useState<AdminInbox[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [newEmail, setNewEmail] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Email of the inbox currently having its signature edited (null = none open).
  const [signatureEditingFor, setSignatureEditingFor] = useState<string | null>(
    null,
  );
  // Per-inbox validation/save errors for the forward destination, keyed by inbox.
  const [forwardErrors, setForwardErrors] = useState<Record<string, string>>(
    {},
  );

  useEffect(() => {
    Promise.all([fetchAdminInboxes(), fetchAdminUsers()])
      .then(([i, u]) => {
        setInboxes(i);
        setUsers(u);
      })
      .finally(() => setLoading(false));
  }, []);

  const members = useMemo(
    () => users.filter((u) => u.role !== "admin"),
    [users],
  );

  const allSelected =
    inboxes.length > 0 && inboxes.every((i) => selected.has(i.email));

  function toggleSelected(email: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(inboxes.map((i) => i.email)));
  }

  function clearSelection() {
    setSelected(new Set());
  }

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
      setInboxes((prev) =>
        prev.some((r) => r.email === created.email)
          ? prev.map((r) =>
              r.email === created.email
                ? {
                    ...r,
                    displayName: created.displayName,
                    displayMode: created.displayMode,
                  }
                : r,
            )
          : [...prev, created].sort((a, b) => a.email.localeCompare(b.email)),
      );
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

  async function commitName(inbox: AdminInbox, value: string) {
    const next = value.trim() === "" ? null : value.trim();
    if (next === inbox.displayName) return;
    const res = await updateInboxSettings(inbox.email, { displayName: next });
    setInboxes((prev) =>
      prev.map((r) =>
        r.email === inbox.email
          ? {
              ...r,
              displayName: res.displayName,
              displayMode: res.displayMode,
              signatureHtml: res.signatureHtml,
              forwardTo: res.forwardTo,
            }
          : r,
      ),
    );
  }

  async function commitForwardTo(inbox: AdminInbox, value: string) {
    const trimmed = value.trim().toLowerCase();
    const next = trimmed === "" ? null : trimmed;
    if (next === inbox.forwardTo) return;

    // Validate client-side so the admin gets a specific message — apiFetch
    // collapses error responses to "API error: 400".
    if (next !== null) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next)) {
        setForwardErrors((p) => ({
          ...p,
          [inbox.email]: "Enter a valid email address.",
        }));
        return;
      }
      if (next === inbox.email.toLowerCase()) {
        setForwardErrors((p) => ({
          ...p,
          [inbox.email]: "Can't forward an inbox to itself.",
        }));
        return;
      }
    }

    setForwardErrors((p) => {
      const { [inbox.email]: _drop, ...rest } = p;
      return rest;
    });
    try {
      const res = await updateInboxSettings(inbox.email, { forwardTo: next });
      setInboxes((prev) =>
        prev.map((r) =>
          r.email === inbox.email ? { ...r, forwardTo: res.forwardTo } : r,
        ),
      );
    } catch {
      setForwardErrors((p) => ({
        ...p,
        [inbox.email]: "Couldn't save. Check the address and try again.",
      }));
    }
  }

  async function commitSignature(inbox: AdminInbox, html: string) {
    // Treat an empty Tiptap doc as "no signature" so admins can clear it
    // without remembering the canonical empty form.
    const stripped = html.trim();
    const next = stripped === "" || stripped === "<p></p>" ? null : stripped;
    const res = await updateInboxSettings(inbox.email, { signatureHtml: next });
    setInboxes((prev) =>
      prev.map((r) =>
        r.email === inbox.email
          ? { ...r, signatureHtml: res.signatureHtml }
          : r,
      ),
    );
    setSignatureEditingFor(null);
  }

  async function handleSetMode(inbox: AdminInbox, next: "thread" | "chat") {
    if (inbox.displayMode === next) return;
    const before = inbox.displayMode;
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
          r.email === inbox.email ? { ...r, displayMode: before } : r,
        ),
      );
      console.error("Failed to update inbox mode", err);
    }
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

  async function handleDelete(emails: string[]) {
    const label =
      emails.length === 1
        ? `Delete inbox "${emails[0]}"?`
        : `Delete ${emails.length} inboxes?`;
    if (!window.confirm(`${label} This cannot be undone.`)) return;
    setBulkBusy(true);
    try {
      await Promise.all(emails.map((email) => deleteInbox(email)));
      setInboxes((prev) => prev.filter((r) => !emails.includes(r.email)));
      setSelected((prev) => {
        const next = new Set(prev);
        for (const e of emails) next.delete(e);
        return next;
      });
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleBulkSetMode(mode: "thread" | "chat") {
    const targets = inboxes.filter(
      (i) => selected.has(i.email) && i.displayMode !== mode,
    );
    if (targets.length === 0) return;
    setBulkBusy(true);
    setInboxes((all) =>
      all.map((r) => (selected.has(r.email) ? { ...r, displayMode: mode } : r)),
    );
    try {
      await Promise.all(
        targets.map((t) => updateInboxSettings(t.email, { displayMode: mode })),
      );
    } finally {
      setBulkBusy(false);
    }
  }

  if (loading) {
    return <p className="text-sm font-light text-text-tertiary">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      {/* Create form — always visible */}
      <form
        onSubmit={handleCreate}
        className="rounded-[8px] bg-card p-4 ring-1 ring-border"
      >
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
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
            className="h-9 flex-1 rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-text-primary/15"
          />
          <input
            type="text"
            value={newDisplayName}
            onChange={(e) => setNewDisplayName(e.currentTarget.value)}
            placeholder="Display name (optional)"
            data-testid="inbox-create-display-name"
            className="h-9 flex-1 rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-text-primary/15"
          />
          <button
            type="submit"
            data-testid="inbox-create-button"
            disabled={creating || newEmail.trim() === ""}
            className="inline-flex h-9 items-center gap-1.5 rounded-[6px] bg-text-primary px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-text-primary/90 disabled:opacity-50"
          >
            <Plus size={14} />
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
        {createError && (
          <div className="mt-2 text-xs text-destructive">{createError}</div>
        )}
      </form>

      {/* Bulk action bar — visible when selection ≥ 1 */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-[8px] bg-text-primary px-3 py-2 text-sm text-white shadow-lg ring-1 ring-text-primary/20">
          <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-white/15 px-2 text-xs font-bold tabular-nums">
            {selected.size}
          </span>
          <span className="font-medium">selected</span>

          <span className="mx-1 h-4 w-px bg-white/15" aria-hidden />

          <button
            onClick={() => handleBulkSetMode("thread")}
            disabled={bulkBusy}
            className="inline-flex items-center gap-1.5 rounded-[6px] bg-white/[0.08] px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-white/[0.14] disabled:opacity-50"
          >
            <MessageSquare size={12} />
            Thread mode
          </button>
          <button
            onClick={() => handleBulkSetMode("chat")}
            disabled={bulkBusy}
            className="inline-flex items-center gap-1.5 rounded-[6px] bg-white/[0.08] px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-white/[0.14] disabled:opacity-50"
          >
            <MessageCircle size={12} />
            Chat mode
          </button>
          <button
            onClick={() => handleDelete(Array.from(selected))}
            disabled={bulkBusy}
            className="inline-flex items-center gap-1.5 rounded-[6px] bg-red-500/[0.16] px-2.5 py-1.5 text-xs font-medium text-red-200 transition-colors hover:bg-red-500/[0.25] disabled:opacity-50"
          >
            {bulkBusy ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Trash2 size={12} />
            )}
            Delete
          </button>

          <button
            onClick={clearSelection}
            className="ml-auto inline-flex items-center gap-1 rounded-[6px] px-2 py-1.5 text-xs font-medium text-white/70 transition-colors hover:bg-white/[0.08] hover:text-white"
            aria-label="Clear selection"
          >
            <X size={12} />
            Clear
          </button>
        </div>
      )}

      {/* Empty state */}
      {inboxes.length === 0 && (
        <div className="rounded-[8px] bg-card p-10 text-center ring-1 ring-border">
          <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-violet/10">
            <InboxIcon size={20} style={{ color: "#7c5cfc" }} />
          </span>
          <p className="mb-1 text-sm font-medium text-text-primary">
            No inboxes yet
          </p>
          <p className="text-xs font-light text-text-tertiary">
            Use the form above to create your first inbox.
          </p>
        </div>
      )}

      {/* Signature editor modal — rendered above the table */}
      {signatureEditingFor &&
        (() => {
          const target = inboxes.find((i) => i.email === signatureEditingFor);
          if (!target) return null;
          return (
            <SignatureEditor
              inbox={target}
              onCancel={() => setSignatureEditingFor(null)}
              onSave={(html) => commitSignature(target, html)}
            />
          );
        })()}

      {/* Table */}
      {inboxes.length > 0 && (
        <div className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
          <div className="overflow-auto smooth-scroll">
            <table className="w-full text-left text-sm">
              <thead className="bg-bg-subtle/40">
                <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                  <th className="w-10 px-4 py-2.5">
                    <Checkbox
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      ariaLabel="Select all inboxes"
                    />
                  </th>
                  <th className="px-3 py-2.5 font-semibold">Address</th>
                  <th className="px-3 py-2.5 font-semibold">Display name</th>
                  <th className="px-3 py-2.5 font-semibold">Signature</th>
                  <th className="px-3 py-2.5 font-semibold">Mode</th>
                  <th className="px-3 py-2.5 font-semibold">Forward to</th>
                  <th className="px-3 py-2.5 font-semibold">Members</th>
                  <th className="w-16 px-3 py-2.5 text-right font-semibold">
                    {/* actions */}
                  </th>
                </tr>
              </thead>
              <tbody>
                {inboxes.map((inbox) => {
                  const isSelected = selected.has(inbox.email);
                  return (
                    <tr
                      key={inbox.email}
                      data-testid="inbox-row"
                      data-inbox-email={inbox.email}
                      className={cn(
                        "border-b border-border/60 transition-colors",
                        isSelected
                          ? "bg-text-primary/[0.04]"
                          : "hover:bg-text-primary/[0.02]",
                      )}
                    >
                      <td className="w-10 px-4 py-2.5">
                        <Checkbox
                          checked={isSelected}
                          onChange={() => toggleSelected(inbox.email)}
                          ariaLabel={`Select ${inbox.email}`}
                        />
                      </td>

                      {/* Address */}
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-bg-muted">
                            <InboxIcon
                              size={12}
                              className="text-text-tertiary"
                            />
                          </span>
                          <span className="truncate font-mono text-xs text-text-primary">
                            {inbox.email}
                          </span>
                        </div>
                      </td>

                      {/* Display name (inline editable, blur to save) */}
                      <td className="px-3 py-2.5">
                        <DisplayNameInput
                          inbox={inbox}
                          onCommit={(v) => commitName(inbox, v)}
                        />
                      </td>

                      {/* Signature — Edit button + status badge */}
                      <td className="px-3 py-2.5">
                        <button
                          type="button"
                          data-testid="inbox-signature-edit-button"
                          onClick={() => setSignatureEditingFor(inbox.email)}
                          className={cn(
                            "inline-flex h-7 items-center gap-1.5 rounded-[6px] border px-2 text-[11px] font-medium transition-colors",
                            inbox.signatureHtml
                              ? "border-violet/30 bg-violet/10 text-violet"
                              : "border-border bg-bg-muted/40 text-text-tertiary hover:border-text-primary/30 hover:text-text-secondary",
                          )}
                          style={
                            inbox.signatureHtml
                              ? { color: "#7c5cfc" }
                              : undefined
                          }
                        >
                          <Pen size={11} />
                          {inbox.signatureHtml ? "Set" : "—"}
                          <span className="ml-0.5 text-[10px] font-light opacity-70">
                            Edit
                          </span>
                        </button>
                      </td>

                      {/* Mode */}
                      <td className="px-3 py-2.5">
                        <div className="inline-flex h-7 rounded-[5px] bg-bg-muted/60 p-0.5 ring-1 ring-border">
                          {(["thread", "chat"] as const).map((m) => {
                            const active = inbox.displayMode === m;
                            const Icon =
                              m === "thread" ? MessageSquare : MessageCircle;
                            return (
                              <button
                                key={m}
                                type="button"
                                data-testid="inbox-mode-toggle"
                                data-mode={m}
                                data-active={active}
                                onClick={() => handleSetMode(inbox, m)}
                                aria-pressed={active}
                                className={cn(
                                  "inline-flex items-center gap-1 rounded-[3px] px-2 text-[11px] font-medium transition-all",
                                  active
                                    ? "bg-card text-text-primary shadow-sm"
                                    : "text-text-secondary hover:text-text-primary",
                                )}
                              >
                                <Icon size={10} />
                                {m === "thread" ? "Thread" : "Chat"}
                              </button>
                            );
                          })}
                        </div>
                      </td>

                      {/* Forward to (inline editable, blur to save) */}
                      <td className="px-3 py-2.5">
                        <ForwardToInput
                          inbox={inbox}
                          error={forwardErrors[inbox.email]}
                          onCommit={(v) => commitForwardTo(inbox, v)}
                        />
                      </td>

                      {/* Members — inline chip toggles */}
                      <td className="px-3 py-2.5">
                        {members.length === 0 ? (
                          <span className="text-xs font-light italic text-text-tertiary">
                            Admins only
                          </span>
                        ) : (
                          <div className="flex flex-wrap items-center gap-1">
                            {members.map((u) => {
                              const on = inbox.assignedUserIds.includes(u.id);
                              return (
                                <button
                                  key={u.id}
                                  type="button"
                                  data-testid="inbox-member-toggle"
                                  data-user-id={u.id}
                                  data-assigned={on}
                                  onClick={() =>
                                    handleToggleAssignment(inbox, u.id)
                                  }
                                  title={u.email}
                                  className={cn(
                                    "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors",
                                    on
                                      ? "border-violet/30 bg-violet/10 text-violet"
                                      : "border-border bg-bg-muted/40 text-text-tertiary hover:border-text-primary/30 hover:text-text-secondary",
                                  )}
                                  style={on ? { color: "#7c5cfc" } : undefined}
                                >
                                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-current/10 text-[9px] font-semibold">
                                    {(u.name || u.email)[0]?.toUpperCase()}
                                  </span>
                                  <span className="truncate max-w-[120px]">
                                    {u.name || u.email}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="px-3 py-2.5 text-right">
                        <button
                          type="button"
                          data-testid="inbox-delete-button"
                          onClick={() => handleDelete([inbox.email])}
                          aria-label={`Delete inbox ${inbox.email}`}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-[5px] text-text-tertiary opacity-60 transition-all hover:bg-destructive/10 hover:text-destructive hover:opacity-100"
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {inboxes.length > 0 && (
        <p className="px-1 text-xs font-light leading-relaxed text-text-tertiary">
          <span className="font-medium text-text-secondary">Forward to</span>{" "}
          sends a copy of every message this inbox receives on to another
          address, using your configured sending provider. Prefer it over a
          Cloudflare Email Routing forwarding rule: Email Routing relays from
          shared IPs that Outlook and Hotmail blocklist, so those forwards
          bounce with <span className="font-mono">550 5.7.1 … (S3150)</span>.
          Copies are sent from this inbox's address with the original sender in{" "}
          <span className="font-mono">Reply-To</span>, so they authenticate on
          your own domain.
        </p>
      )}
    </div>
  );
}

interface DisplayNameInputProps {
  inbox: AdminInbox;
  onCommit: (value: string) => Promise<void>;
}
function DisplayNameInput({ inbox, onCommit }: DisplayNameInputProps) {
  const [value, setValue] = useState(inbox.displayName ?? "");

  // Resync when underlying inbox displayName changes (e.g. after refresh).
  useEffect(() => {
    setValue(inbox.displayName ?? "");
  }, [inbox.displayName]);

  return (
    <input
      type="text"
      value={value}
      onChange={(e) => setValue(e.currentTarget.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.currentTarget as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setValue(inbox.displayName ?? "");
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      placeholder="Set a name…"
      data-testid="inbox-display-name-input"
      className="h-8 w-full rounded-[6px] border border-transparent bg-transparent px-2 text-sm text-text-primary placeholder:font-light placeholder:italic placeholder:text-text-tertiary hover:border-border focus:border-border focus:bg-card focus:outline-none focus:ring-2 focus:ring-text-primary/15"
    />
  );
}

interface ForwardToInputProps {
  inbox: AdminInbox;
  error?: string;
  onCommit: (value: string) => Promise<void>;
}

/**
 * Destination address for per-inbox forwarding. Blur-to-save, mirroring
 * DisplayNameInput. Empty clears the rule.
 */
function ForwardToInput({ inbox, error, onCommit }: ForwardToInputProps) {
  const [value, setValue] = useState(inbox.forwardTo ?? "");

  useEffect(() => {
    setValue(inbox.forwardTo ?? "");
  }, [inbox.forwardTo]);

  return (
    <div className="min-w-[180px]">
      <input
        type="email"
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
        onBlur={() => onCommit(value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setValue(inbox.forwardTo ?? "");
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        placeholder="No forwarding"
        aria-label={`Forward destination for ${inbox.email}`}
        aria-invalid={error ? true : undefined}
        data-testid="inbox-forward-to-input"
        className={cn(
          "h-8 w-full rounded-[6px] border bg-transparent px-2 font-mono text-xs text-text-primary placeholder:font-sans placeholder:text-sm placeholder:font-light placeholder:italic placeholder:text-text-tertiary focus:bg-card focus:outline-none focus:ring-2",
          error
            ? "border-destructive focus:ring-destructive/20"
            : "border-transparent hover:border-border focus:border-border focus:ring-text-primary/15",
        )}
      />
      {error && (
        <div
          data-testid="inbox-forward-to-error"
          className="mt-1 text-[10px] font-light text-destructive"
        >
          {error}
        </div>
      )}
    </div>
  );
}

interface SignatureEditorProps {
  inbox: AdminInbox;
  onCancel: () => void;
  onSave: (html: string) => Promise<void>;
}

/**
 * Inline rich-text editor for an inbox's auto-attached signature. Caps at
 * ~200px tall so it stays compact in the admin table view; admins typically
 * paste 2–4 lines of plain text + a link.
 */
function SignatureEditor({ inbox, onCancel, onSave }: SignatureEditorProps) {
  const [html, setHtml] = useState(inbox.signatureHtml ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(html);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      data-testid="inbox-signature-editor"
      className="rounded-[8px] bg-card p-4 ring-1 ring-border"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="mb-0.5 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
            Signature
          </div>
          <p className="truncate text-xs text-text-secondary">
            <span className="font-mono">{inbox.email}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-[6px] p-1 text-text-tertiary hover:bg-bg-muted hover:text-text-primary"
          aria-label="Close signature editor"
        >
          <X size={14} />
        </button>
      </div>
      <div className="max-h-[200px] overflow-auto rounded-[6px] border border-border bg-card">
        <TiptapEditor
          content={html}
          onUpdate={setHtml}
          placeholder="Cheers, the Team"
        />
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-[6px] border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="inbox-signature-save-button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-text-primary/90 disabled:opacity-50"
        >
          {saving ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Pen size={12} />
          )}
          Save signature
        </button>
      </div>
    </div>
  );
}

interface CheckboxProps {
  checked: boolean;
  onChange: () => void;
  ariaLabel: string;
}
function Checkbox({ checked, onChange, ariaLabel }: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
        checked
          ? "border-text-primary bg-text-primary text-white"
          : "border-border bg-card hover:border-text-primary/40",
      )}
    >
      {checked && (
        <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none">
          <path
            d="M2.5 6.5L4.75 8.75L9.5 4"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}
