import ConversationModeControl from "@/components/ConversationModeControl";
import SpamFilterControls from "@/components/SpamFilterControls";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Download,
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
  fetchRules,
  fetchAdminUsers,
  fetchGmailAccounts,
  fetchOutlookAccounts,
  updateInboxAssignments,
  updateInboxSettings,
  type AdminInbox,
  type AdminUser,
  type GmailAccount,
} from "@/lib/api";
import { cn } from "@/lib/utils";

interface AdminInboxTableProps {
  /**
   * Bumped by the page when a Google mailbox is connected or disconnected.
   * A change re-reads both lists: the mailbox options here, and the inboxes
   * themselves, since disconnecting unmaps the inboxes that read from it.
   */
  gmailVersion?: number;
}

/**
 * Admin "Inboxes" table. Real table layout with bulk select + bulk
 * actions, inline display-name editing (blur-to-save), mode toggle
 * per row, and inline member-assignment chips.
 */
export default function AdminInboxTable({
  gmailVersion = 0,
}: AdminInboxTableProps = {}) {
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
  // Connected Google mailboxes an inbox can be pointed at.
  const [gmailAccounts, setGmailAccounts] = useState<GmailAccount[]>([]);
  const [gmailAccountsFailed, setGmailAccountsFailed] = useState(false);
  // And connected Outlook mailboxes, loaded the same way.
  const [outlookAccounts, setOutlookAccounts] = useState<GmailAccount[]>([]);
  const [outlookAccountsFailed, setOutlookAccountsFailed] = useState(false);
  // Per-inbox source-mapping errors, keyed by inbox. The server's message is
  // kept word for word — on a rejected mapping it is the only actionable part.
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});
  const [sourceSavingFor, setSourceSavingFor] = useState<string | null>(null);
  // Per-inbox test-inbox errors: the server says why the switch was refused.
  const [testInboxErrors, setTestInboxErrors] = useState<
    Record<string, string>
  >({});

  // Inboxes that already have a rule acting on the learning filter's score.
  const [junkRuleInboxes, setJunkRuleInboxes] = useState<Set<string>>(
    new Set(),
  );

  useEffect(() => {
    Promise.all([fetchAdminInboxes(), fetchAdminUsers()])
      .then(([i, u]) => {
        setInboxes(i);
        setUsers(u);
      })
      .finally(() => setLoading(false));
    fetchRules()
      .then((rules) =>
        setJunkRuleInboxes(
          new Set(
            rules
              .filter(
                (rule) =>
                  rule.enabled &&
                  rule.inbox &&
                  rule.conditions.some(
                    (condition) =>
                      condition.field === "spam_probability" &&
                      condition.operator === "gte",
                  ),
              )
              .map((rule) => rule.inbox!.toLowerCase()),
          ),
        ),
      )
      .catch(() => setJunkRuleInboxes(new Set()));
  }, []);

  // Separate from the load above: a Gmail outage must not stop the table
  // rendering, it just means no mailbox can be picked right now. Re-runs when
  // the page signals that the connected set changed, so the options here do
  // not go on offering a mailbox that was just disconnected.
  useEffect(() => {
    let cancelled = false;
    fetchGmailAccounts()
      .then((rows) => {
        if (!cancelled) {
          setGmailAccounts(rows);
          // A later success has to clear an earlier failure, or one blip
          // would lock every mapped row until a reload.
          setGmailAccountsFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setGmailAccountsFailed(true);
      });
    fetchOutlookAccounts()
      .then((rows) => {
        if (!cancelled) {
          setOutlookAccounts(rows);
          setOutlookAccountsFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setOutlookAccountsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [gmailVersion]);

  // A disconnect unmaps inboxes server-side, so the rows themselves are stale
  // too. Only on a change, never on first mount — the load above covers that.
  useEffect(() => {
    if (gmailVersion === 0) return;
    let cancelled = false;
    fetchAdminInboxes()
      .then((rows) => {
        if (!cancelled) setInboxes(rows);
      })
      .catch(() => {
        /* The table keeps what it has; the next action reports its own error. */
      });
    return () => {
      cancelled = true;
    };
  }, [gmailVersion]);

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
          : [
              ...prev,
              // A new inbox is always a Cloudflare one; the create response
              // doesn't carry the source fields.
              {
                ...created,
                source: "cloudflare" as const,
                gmailAccountId: null,
                outlookAccountId: null,
              },
            ].sort((a, b) => a.email.localeCompare(b.email)),
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

    // Validate client-side so the admin is told before a round trip; the
    // server's own wording is kept either way.
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

  async function commitSpamThreshold(
    inbox: AdminInbox,
    spamThreshold: number | null,
  ) {
    if (spamThreshold === inbox.spamThreshold) return;
    const res = await updateInboxSettings(inbox.email, { spamThreshold });
    setInboxes((prev) =>
      prev.map((row) =>
        row.email === inbox.email
          ? { ...row, spamThreshold: res.spamThreshold }
          : row,
      ),
    );
  }

  async function commitAgentInstructions(inbox: AdminInbox, value: string) {
    if (value === (inbox.agentInstructions ?? "")) return;
    const res = await updateInboxSettings(inbox.email, {
      agentInstructions: value,
    });
    setInboxes((prev) =>
      prev.map((row) =>
        row.email === inbox.email
          ? { ...row, agentInstructions: res.agentInstructions }
          : row,
      ),
    );
  }

  async function commitAgentAutodraft(inbox: AdminInbox, value: boolean) {
    if (value === inbox.agentAutodraft) return;
    const before = inbox.agentAutodraft;
    setInboxes((prev) =>
      prev.map((row) =>
        row.email === inbox.email ? { ...row, agentAutodraft: value } : row,
      ),
    );
    try {
      const res = await updateInboxSettings(inbox.email, {
        agentAutodraft: value,
      });
      setInboxes((prev) =>
        prev.map((row) =>
          row.email === inbox.email
            ? { ...row, agentAutodraft: res.agentAutodraft }
            : row,
        ),
      );
    } catch {
      setInboxes((prev) =>
        prev.map((row) =>
          row.email === inbox.email ? { ...row, agentAutodraft: before } : row,
        ),
      );
    }
  }

  /**
   * Turns the test-inbox switch, or sets its retention. The server refuses a
   * test inbox that holds mail (409); its message is shown and the control
   * goes back.
   */
  async function commitTestInbox(
    inbox: AdminInbox,
    patch: {
      purpose?: AdminInbox["purpose"];
      testRetentionDays?: number | null;
    },
  ) {
    const before = {
      purpose: inbox.purpose,
      testRetentionDays: inbox.testRetentionDays,
    };
    setTestInboxErrors((p) => {
      const { [inbox.email]: _drop, ...rest } = p;
      return rest;
    });
    setInboxes((prev) =>
      prev.map((row) =>
        row.email === inbox.email ? { ...row, ...patch } : row,
      ),
    );
    try {
      const res = await updateInboxSettings(inbox.email, patch);
      setInboxes((prev) =>
        prev.map((row) =>
          row.email === inbox.email
            ? {
                ...row,
                purpose: res.purpose,
                testRetentionDays: res.testRetentionDays,
              }
            : row,
        ),
      );
    } catch (err) {
      setInboxes((prev) =>
        prev.map((row) =>
          row.email === inbox.email ? { ...row, ...before } : row,
        ),
      );
      setTestInboxErrors((p) => ({
        ...p,
        [inbox.email]:
          err instanceof Error && err.message.trim() !== ""
            ? err.message
            : "Couldn't change the test inbox setting.",
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

  /**
   * Point an inbox at a connected Google mailbox, or back at Cloudflare.
   *
   * `value` is the select's value: "cloudflare", or a connected mailbox id.
   * Switching to Cloudflare clears `gmailAccountId` explicitly — leaving the
   * old id behind would store a row that claims a mailbox it no longer uses.
   *
   * The server re-checks that the mailbox can actually send as this address
   * and rejects the mapping (400/502/503) with the row untouched. Its message
   * is shown verbatim: it names the address and says what to do about it.
   */
  async function handleSetSource(inbox: AdminInbox, value: string) {
    const next = sourceFromValue(value);
    if (
      inbox.source === next.source &&
      inbox.gmailAccountId === next.gmailAccountId &&
      inbox.outlookAccountId === next.outlookAccountId
    ) {
      return;
    }

    const before = {
      source: inbox.source,
      gmailAccountId: inbox.gmailAccountId,
      outlookAccountId: inbox.outlookAccountId,
    };
    setSourceErrors((p) => {
      const { [inbox.email]: _drop, ...rest } = p;
      return rest;
    });
    setSourceSavingFor(inbox.email);
    setInboxes((all) =>
      all.map((r) => (r.email === inbox.email ? { ...r, ...next } : r)),
    );

    try {
      // Only the chosen provider's id is sent: naming both, even as null,
      // is fine, but the server reads an Outlook id with source "gmail" as a
      // contradiction.
      const res = await updateInboxSettings(inbox.email, {
        source: next.source,
        ...(next.source === "outlook"
          ? { outlookAccountId: next.outlookAccountId }
          : { gmailAccountId: next.gmailAccountId }),
      });
      setInboxes((all) =>
        all.map((r) =>
          r.email === inbox.email
            ? {
                ...r,
                source: res.source,
                gmailAccountId: res.gmailAccountId,
                outlookAccountId: res.outlookAccountId ?? null,
              }
            : r,
        ),
      );
    } catch (err) {
      // Nothing was saved, so put the control back where it was.
      setInboxes((all) =>
        all.map((r) => (r.email === inbox.email ? { ...r, ...before } : r)),
      );
      setSourceErrors((p) => ({
        ...p,
        [inbox.email]:
          err instanceof Error && err.message.trim() !== ""
            ? err.message
            : "Couldn't change the source for this inbox.",
      }));
    } finally {
      setSourceSavingFor((current) =>
        current === inbox.email ? null : current,
      );
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
    return <p className="text-sm text-text-tertiary">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      {/* Create form — always visible */}
      <form
        onSubmit={handleCreate}
        className="rounded-2xl bg-card p-4 border border-border shadow-card"
      >
        <div className="font-label mb-2 text-text-tertiary">Create inbox</div>
        <div className="flex flex-col gap-2 md:flex-row">
          <input
            type="email"
            required
            value={newEmail}
            onChange={(e) => setNewEmail(e.currentTarget.value)}
            placeholder="inbox@example.com"
            data-testid="inbox-create-email"
            className="h-9 w-full rounded-lg border border-border-strong bg-card px-3 text-sm text-text-primary shadow-card transition-[border-color,box-shadow] placeholder:text-text-tertiary hover:border-text-tertiary/60 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15 flex-1"
          />
          <input
            type="text"
            value={newDisplayName}
            onChange={(e) => setNewDisplayName(e.currentTarget.value)}
            placeholder="Display name (optional)"
            data-testid="inbox-create-display-name"
            className="h-9 w-full rounded-lg border border-border-strong bg-card px-3 text-sm text-text-primary shadow-card transition-[border-color,box-shadow] placeholder:text-text-tertiary hover:border-text-tertiary/60 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15 flex-1"
          />
          <button
            type="submit"
            data-testid="inbox-create-button"
            disabled={creating || newEmail.trim() === ""}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-4 text-sm font-medium text-accent-foreground shadow-card transition-colors hover:bg-accent-hover disabled:opacity-50"
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
        <div className="flex flex-wrap items-center gap-1 rounded-xl border border-border-strong bg-popover py-1 pl-3 pr-1 text-sm text-text-primary shadow-overlay">
          <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-accent px-2 text-xs font-semibold tabular-nums text-accent-foreground">
            {selected.size}
          </span>
          <span className="font-medium">selected</span>

          <span className="mx-1 h-5 w-px bg-border" aria-hidden />

          <button
            onClick={() => handleBulkSetMode("thread")}
            disabled={bulkBusy}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:opacity-50"
          >
            <MessageSquare size={12} />
            Thread mode
          </button>
          <button
            onClick={() => handleBulkSetMode("chat")}
            disabled={bulkBusy}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:opacity-50"
          >
            <MessageCircle size={12} />
            Chat mode
          </button>
          <button
            onClick={() => handleDelete(Array.from(selected))}
            disabled={bulkBusy}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-destructive transition-colors hover:bg-destructive-subtle disabled:opacity-50"
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
            className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:opacity-50"
            aria-label="Clear selection"
          >
            <X size={12} />
            Clear
          </button>
        </div>
      )}

      {/* Empty state */}
      {inboxes.length === 0 && (
        <div className="rounded-2xl bg-card p-10 text-center border border-border shadow-card">
          <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent-subtle">
            <InboxIcon size={20} className="text-text-secondary" />
          </span>
          <p className="mb-1 text-sm font-medium text-text-primary">
            No inboxes yet
          </p>
          <p className="text-xs text-text-tertiary">
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
        <div className="overflow-hidden rounded-2xl bg-card border border-border shadow-card">
          <div className="overflow-auto smooth-scroll">
            <table className="w-full text-left text-sm">
              <thead className="bg-bg-subtle/40">
                <tr className="font-label border-b border-border text-text-tertiary">
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
                  <th className="px-3 py-2.5 font-semibold">Source</th>
                  <th className="px-3 py-2.5 font-semibold">Forward to</th>
                  <th className="px-3 py-2.5 font-semibold">Spam threshold</th>
                  <th className="px-3 py-2.5 font-semibold">
                    Agent instructions
                  </th>
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
                        "border-b border-border-subtle transition-colors",
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
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-bg-muted">
                            <InboxIcon
                              size={12}
                              className="text-text-tertiary"
                            />
                          </span>
                          <span className="truncate font-mono text-xs text-text-primary">
                            {inbox.email}
                          </span>
                          {inbox.purpose === "test" && (
                            <span
                              data-testid="inbox-test-badge"
                              className="inline-flex h-5 shrink-0 items-center rounded-full border border-accent-subtle bg-accent-subtle px-2 text-[10px] font-semibold uppercase tracking-wide text-accent-subtle-fg"
                            >
                              Test
                            </span>
                          )}
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
                            "inline-flex h-7 items-center gap-1.5 rounded-lg border px-2 text-[11px] font-medium transition-colors",
                            inbox.signatureHtml
                              ? "border-accent-subtle bg-accent-subtle text-accent-subtle-fg"
                              : "border-border bg-bg-muted/40 text-text-tertiary hover:border-text-primary/30 hover:text-text-secondary",
                          )}
                        >
                          <Pen size={11} />
                          {inbox.signatureHtml ? "Set" : "—"}
                          <span className="ml-0.5 text-[10px] opacity-70">
                            Edit
                          </span>
                        </button>
                      </td>

                      {/* Mode */}
                      <td className="px-3 py-2.5">
                        <div className="inline-flex h-7 rounded-md bg-bg-muted/60 p-0.5 ring-1 ring-border">
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
                        <ConversationModeControl
                          inbox={inbox}
                          onChange={(next) =>
                            setInboxes((rows) =>
                              rows.map((row) =>
                                row.email === inbox.email
                                  ? { ...row, ...next }
                                  : row,
                              ),
                            )
                          }
                        />
                      </td>

                      {/* Source — Cloudflare, or a connected Google mailbox */}
                      <td className="px-3 py-2.5">
                        <SourceSelect
                          inbox={inbox}
                          accounts={gmailAccounts}
                          accountsFailed={gmailAccountsFailed}
                          outlookAccounts={outlookAccounts}
                          outlookAccountsFailed={outlookAccountsFailed}
                          saving={sourceSavingFor === inbox.email}
                          error={sourceErrors[inbox.email]}
                          onChange={(v) => handleSetSource(inbox, v)}
                        />
                        {inbox.source === "cloudflare" && (
                          <TestInboxControl
                            inbox={inbox}
                            error={testInboxErrors[inbox.email]}
                            onChange={(patch) => commitTestInbox(inbox, patch)}
                          />
                        )}
                      </td>

                      {/* Forward to (inline editable, blur to save) */}
                      <td className="px-3 py-2.5">
                        <ForwardToInput
                          inbox={inbox}
                          error={forwardErrors[inbox.email]}
                          onCommit={(v) => commitForwardTo(inbox, v)}
                        />
                      </td>

                      {/* Spam threshold */}
                      <td className="px-3 py-2.5">
                        <SpamThresholdInput
                          inbox={inbox}
                          onCommit={(value) =>
                            commitSpamThreshold(inbox, value)
                          }
                        />
                        <SpamFilterControls
                          inbox={inbox}
                          hasJunkRule={junkRuleInboxes.has(
                            inbox.email.toLowerCase(),
                          )}
                          onChange={(spamFilter) =>
                            setInboxes((rows) =>
                              rows.map((row) =>
                                row.email === inbox.email
                                  ? { ...row, spamFilter }
                                  : row,
                              ),
                            )
                          }
                        />
                      </td>

                      {/* Agent suggested replies + instructions */}
                      <td className="px-3 py-2.5 align-top">
                        <div className="min-w-[260px] space-y-2">
                          <label className="flex items-center gap-2 text-[11px] font-medium text-text-secondary">
                            <button
                              type="button"
                              role="switch"
                              aria-checked={inbox.agentAutodraft}
                              aria-label={`Auto-suggest replies for ${inbox.email}`}
                              data-testid="inbox-agent-autodraft"
                              onClick={() =>
                                void commitAgentAutodraft(
                                  inbox,
                                  !inbox.agentAutodraft,
                                )
                              }
                              className={cn(
                                "relative h-5 w-9 rounded-full transition-colors",
                                inbox.agentAutodraft
                                  ? "bg-text-primary"
                                  : "bg-bg-muted ring-1 ring-border",
                              )}
                            >
                              <span
                                className={cn(
                                  "absolute top-0.5 h-4 w-4 rounded-full bg-card shadow-sm transition-transform",
                                  inbox.agentAutodraft
                                    ? "translate-x-4"
                                    : "translate-x-0.5",
                                )}
                              />
                            </button>
                            Auto-suggest replies
                          </label>
                          <AgentInstructionsInput
                            inbox={inbox}
                            onCommit={(value) =>
                              commitAgentInstructions(inbox, value)
                            }
                          />
                        </div>
                      </td>

                      {/* Members — inline chip toggles */}
                      <td className="px-3 py-2.5">
                        {members.length === 0 ? (
                          <span className="text-xs italic text-text-tertiary">
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
                                      ? "border-accent-subtle bg-accent-subtle text-accent-subtle-fg"
                                      : "border-border bg-bg-muted/40 text-text-tertiary hover:border-text-primary/30 hover:text-text-secondary",
                                  )}
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
                      <td className="whitespace-nowrap px-3 py-2.5 text-right">
                        <Link
                          to={`/settings?export=${encodeURIComponent(inbox.email)}#data`}
                          data-testid="inbox-export-link"
                          aria-label={`Export ${inbox.email}`}
                          title="Export mailbox…"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-[5px] text-text-tertiary opacity-60 transition-all hover:bg-bg-muted hover:text-text-primary hover:opacity-100"
                        >
                          <Download size={13} />
                        </Link>
                        <button
                          type="button"
                          data-testid="inbox-delete-button"
                          onClick={() => handleDelete([inbox.email])}
                          aria-label={`Delete inbox ${inbox.email}`}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary opacity-60 transition-all hover:bg-destructive/10 hover:text-destructive hover:opacity-100"
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
        <p className="px-1 text-xs leading-relaxed text-text-tertiary">
          <span className="font-medium text-text-secondary">Forward to</span>{" "}
          sends a copy of every message this inbox receives on to another
          address, using your configured sending provider. Prefer it over a
          Cloudflare Email Routing forwarding rule: Email Routing relays from
          shared IPs that Outlook and Hotmail blocklist, so those forwards
          bounce with <span className="font-mono">550 5.7.1 … (S3150)</span>.
          Copies are sent from this inbox's address with the original sender in{" "}
          <span className="font-mono">Reply-To</span>, so they authenticate on
          your own domain.{" "}
          <span className="font-medium text-text-secondary">Source</span> picks
          where this inbox&apos;s mail comes from: Cloudflare Email Routing, or
          a connected Google mailbox that can send as this address. Google only
          accepts an address listed — and verified — under that mailbox&apos;s
          &quot;Send mail as&quot;, so a mapping it refuses is not saved.
        </p>
      )}
      {inboxes.length > 0 && (
        <p className="px-1 text-xs font-light leading-relaxed text-text-tertiary">
          <span className="font-medium text-text-secondary">Conversations</span>{" "}
          — <span className="font-medium">By customer</span> (the default) makes
          all mail with a person one conversation; snooze and assignment apply
          to the customer. <span className="font-medium">By thread</span> groups
          replies into threads by their headers, like a mail client; snooze and
          assignment apply to the thread, and JMAP clients see ordinary threads.
          Changing it regroups the inbox's mail in the background and clears its
          snoozes and assignments.
        </p>
      )}
      {inboxes.length > 0 && (
        <p className="px-1 text-xs font-light leading-relaxed text-text-tertiary">
          <span className="font-medium text-text-secondary">
            Spam threshold
          </span>{" "}
          — SpamAssassin-style score from the X-Spam-Score header (5.0 is
          typical). Only applies when incoming mail carries that header. Leave
          empty to disable.
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
      className="h-8 w-full rounded-lg border border-border-strong bg-card px-3 text-sm text-text-primary shadow-card transition-[border-color,box-shadow] placeholder:text-text-tertiary hover:border-text-tertiary/60 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15 border-transparent bg-transparent px-2 placeholder:font-light placeholder:italic hover:border-border focus:border-border focus:bg-card"
    />
  );
}

/**
 * The select's value for a mapping. A Gmail mailbox is its bare id (what the
 * value has always been); an Outlook mailbox is prefixed, so the two sets of
 * ids can never be confused.
 */
const OUTLOOK_PREFIX = "outlook:";

function sourceFromValue(value: string): {
  source: AdminInbox["source"];
  gmailAccountId: string | null;
  outlookAccountId: string | null;
} {
  if (value === "cloudflare") {
    return {
      source: "cloudflare",
      gmailAccountId: null,
      outlookAccountId: null,
    };
  }
  if (value.startsWith(OUTLOOK_PREFIX)) {
    return {
      source: "outlook",
      gmailAccountId: null,
      outlookAccountId: value.slice(OUTLOOK_PREFIX.length),
    };
  }
  return { source: "gmail", gmailAccountId: value, outlookAccountId: null };
}

interface SourceSelectProps {
  inbox: AdminInbox;
  accounts: GmailAccount[];
  accountsFailed: boolean;
  outlookAccounts?: GmailAccount[];
  outlookAccountsFailed?: boolean;
  saving: boolean;
  error?: string;
  onChange: (value: string) => void;
}

/**
 * Where an inbox's mail comes from: Cloudflare Email Routing, or one of the
 * connected Google mailboxes. Options carry the mailbox id as their value but
 * show its address — the id means nothing to an admin.
 */
function SourceSelect({
  inbox,
  accounts: gmailOptions,
  accountsFailed: gmailFailed,
  outlookAccounts = [],
  outlookAccountsFailed = false,
  saving,
  error,
  onChange,
}: SourceSelectProps) {
  // Both providers' mailboxes, as one list of select values.
  const accounts = [
    ...gmailOptions,
    ...outlookAccounts.map((a) => ({ ...a, id: `${OUTLOOK_PREFIX}${a.id}` })),
  ];
  const isOutlook = inbox.source === "outlook";
  const mappedId =
    inbox.source === "gmail"
      ? (inbox.gmailAccountId ?? null)
      : isOutlook && inbox.outlookAccountId
        ? `${OUTLOOK_PREFIX}${inbox.outlookAccountId}`
        : null;
  // Whether the list this mapping would be found in failed to load.
  const accountsFailed = isOutlook ? outlookAccountsFailed : gmailFailed;
  const grouped = gmailOptions.length > 0 && outlookAccounts.length > 0;
  // A mapping can outlive the mailbox it points at, but "the mailbox is gone"
  // and "we could not ask" are different facts and must not share a label.
  // The option text is the only thing visible on a closed <select>, so
  // labelling an unchecked mapping "no longer connected" invites the operator
  // to unmap a working inbox because of a network blip — and switching back
  // to Cloudflare is a real PATCH that really unmaps it.
  //
  // `known` matters on its own because a failed *re*-fetch keeps the rows from
  // the last good load: the list is out of date, but it can still name this
  // mapping, and showing an opaque id instead would be worse than the id-less
  // truth. Only a mapping the list cannot resolve at all is "Couldn't check".
  const known = mappedId !== null && accounts.some((a) => a.id === mappedId);
  const unverifiable = mappedId !== null && accountsFailed && !known;
  const orphaned = mappedId !== null && !accountsFailed && !known;
  // Every mapped row is locked while the list is known to be out of date,
  // named or not: changing it is a real PATCH, and a stale list cannot tell a
  // live mapping from a dead one. `accounts.length === 0` does NOT imply this
  // any more — the first load can succeed and a later one fail.
  const staleMapping = mappedId !== null && accountsFailed;
  const value = mappedId ?? "cloudflare";

  return (
    <div className="min-w-[170px]">
      <select
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        disabled={
          saving || staleMapping || (accounts.length === 0 && !orphaned)
        }
        aria-label={`Mail source for ${inbox.email}`}
        aria-invalid={error ? true : undefined}
        data-testid="inbox-source-select"
        data-inbox-email={inbox.email}
        className={cn(
          "h-8 w-full rounded-lg border bg-transparent px-2 text-xs text-text-primary focus:bg-card focus:outline-none focus:ring-2 disabled:opacity-60",
          error
            ? "border-destructive focus:ring-destructive/20"
            : "border-transparent hover:border-border focus:border-border focus:ring-text-primary/15",
        )}
      >
        <option value="cloudflare">Cloudflare</option>
        {unverifiable && mappedId !== null && (
          <option value={mappedId}>
            Couldn&apos;t check — still mapped to {mappedId}
          </option>
        )}
        {orphaned && mappedId !== null && (
          <option value={mappedId}>Mailbox no longer connected</option>
        )}
        {grouped ? (
          <>
            <optgroup label="Google">
              {gmailOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.emailAddress}
                </option>
              ))}
            </optgroup>
            <optgroup label="Microsoft">
              {outlookAccounts.map((a) => (
                <option key={a.id} value={`${OUTLOOK_PREFIX}${a.id}`}>
                  {a.emailAddress}
                </option>
              ))}
            </optgroup>
          </>
        ) : (
          accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.emailAddress}
            </option>
          ))
        )}
        {accounts.length === 0 && (
          <option value="__unavailable" disabled>
            {gmailFailed || outlookAccountsFailed
              ? "Couldn't load connected mailboxes"
              : "Connect a mailbox first"}
          </option>
        )}
      </select>
      {error && (
        // The server's rejection runs to ~220 characters and names the exact
        // Gmail setting to change, so it has to be read, not squinted at: it
        // gets body-sized text and a width of its own rather than the 170px
        // the column is sized to.
        <div
          data-testid="inbox-source-error"
          className="mt-1 w-[260px] max-w-[60vw] rounded-lg bg-destructive-subtle px-2 py-1.5 text-xs leading-relaxed text-destructive"
        >
          {error}
        </div>
      )}
    </div>
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
          "h-8 w-full rounded-lg border bg-transparent px-2 font-mono text-xs text-text-primary placeholder:font-sans placeholder:text-sm placeholder:font-light placeholder:italic placeholder:text-text-tertiary focus:bg-card focus:outline-none focus:ring-2",
          error
            ? "border-destructive focus:ring-destructive/20"
            : "border-transparent hover:border-border focus:border-border focus:ring-text-primary/15",
        )}
      />
      {error && (
        <div
          data-testid="inbox-forward-to-error"
          className="mt-1 text-[10px] text-destructive"
        >
          {error}
        </div>
      )}
    </div>
  );
}

interface SpamThresholdInputProps {
  inbox: AdminInbox;
  onCommit: (value: number | null) => Promise<void>;
}

function SpamThresholdInput({ inbox, onCommit }: SpamThresholdInputProps) {
  const [value, setValue] = useState(
    inbox.spamThreshold === null ? "" : String(inbox.spamThreshold),
  );

  useEffect(() => {
    setValue(inbox.spamThreshold === null ? "" : String(inbox.spamThreshold));
  }, [inbox.spamThreshold]);

  async function commit() {
    const trimmed = value.trim();
    if (trimmed === "") {
      await onCommit(null);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      setValue(inbox.spamThreshold === null ? "" : String(inbox.spamThreshold));
      return;
    }
    await onCommit(parsed);
  }

  return (
    <input
      type="number"
      min="0"
      max="100"
      step="0.1"
      value={value}
      onChange={(event) => setValue(event.currentTarget.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          setValue(
            inbox.spamThreshold === null ? "" : String(inbox.spamThreshold),
          );
          event.currentTarget.blur();
        }
      }}
      placeholder="Disabled"
      aria-label={`Spam threshold for ${inbox.email}`}
      data-testid="inbox-spam-threshold-input"
      className="h-8 w-28 rounded-[6px] border border-transparent bg-transparent px-2 font-mono text-xs text-text-primary placeholder:font-sans placeholder:font-light placeholder:italic placeholder:text-text-tertiary hover:border-border focus:border-border focus:bg-card focus:outline-none focus:ring-2 focus:ring-text-primary/15"
    />
  );
}

interface TestInboxControlProps {
  inbox: AdminInbox;
  error: string | undefined;
  onChange: (patch: {
    purpose?: AdminInbox["purpose"];
    testRetentionDays?: number | null;
  }) => Promise<void>;
}

/** Days a test inbox keeps its mail when none is set. */
const DEFAULT_TEST_RETENTION_DAYS = 3;

/** The "Test inbox" switch and, when it is on, its retention in days. */
function TestInboxControl({ inbox, error, onChange }: TestInboxControlProps) {
  const on = inbox.purpose === "test";
  const days = inbox.testRetentionDays ?? DEFAULT_TEST_RETENTION_DAYS;
  const [value, setValue] = useState(String(days));

  useEffect(() => {
    setValue(String(days));
  }, [days]);

  async function commitDays() {
    const parsed = Number(value.trim());
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 30) {
      setValue(String(days));
      return;
    }
    if (parsed === days) return;
    await onChange({ testRetentionDays: parsed });
  }

  return (
    <div className="mt-2 max-w-[220px] space-y-1">
      <label className="flex items-center gap-2 text-[11px] font-medium text-text-secondary">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={`Test inbox ${inbox.email}`}
          data-testid="inbox-test-toggle"
          onClick={() => void onChange({ purpose: on ? "mail" : "test" })}
          className={cn(
            "relative h-5 w-9 shrink-0 rounded-full transition-colors",
            on ? "bg-text-primary" : "bg-bg-muted ring-1 ring-border",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 h-4 w-4 rounded-full bg-card shadow-sm transition-transform",
              on ? "translate-x-4" : "translate-x-0.5",
            )}
          />
        </button>
        Test inbox
      </label>
      {on && (
        <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
          Keep mail
          <input
            type="number"
            min="1"
            max="30"
            step="1"
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
            onBlur={() => void commitDays()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                setValue(String(days));
                event.currentTarget.blur();
              }
            }}
            aria-label={`Days ${inbox.email} keeps test mail`}
            data-testid="inbox-test-retention"
            className="h-7 w-14 rounded-[6px] border border-border bg-card px-2 font-mono text-xs text-text-primary focus:outline-none focus:ring-2 focus:ring-text-primary/15"
          />
          days
        </label>
      )}
      {on && (
        <p className="text-[11px] font-light leading-snug text-text-tertiary">
          Mail here skips rules, spam, notifications, webhooks and forwarding,
          and is deleted after {days} days.
        </p>
      )}
      {error && (
        <p
          role="alert"
          data-testid="inbox-test-error"
          className="text-[11px] leading-snug text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  );
}

interface AgentInstructionsInputProps {
  inbox: AdminInbox;
  onCommit: (value: string) => Promise<void>;
}

function AgentInstructionsInput({
  inbox,
  onCommit,
}: AgentInstructionsInputProps) {
  const [value, setValue] = useState(inbox.agentInstructions ?? "");

  useEffect(() => {
    setValue(inbox.agentInstructions ?? "");
  }, [inbox.agentInstructions]);

  return (
    <div className="min-w-[260px]">
      <textarea
        value={value}
        maxLength={4000}
        rows={3}
        onChange={(event) => setValue(event.currentTarget.value)}
        onBlur={() => void onCommit(value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setValue(inbox.agentInstructions ?? "");
            event.currentTarget.blur();
          }
        }}
        placeholder="Guidance for the mail agent…"
        aria-label={`Agent instructions for ${inbox.email}`}
        data-testid="inbox-agent-instructions"
        className="w-full resize-y rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs leading-relaxed text-text-primary placeholder:font-light placeholder:italic placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-text-primary/15"
      />
      <div
        data-testid="inbox-agent-instructions-count"
        className="mt-1 text-right text-[10px] tabular-nums text-text-tertiary"
      >
        {value.length}/4000
      </div>
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
      className="rounded-2xl bg-card p-4 border border-border shadow-card"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="font-label mb-0.5 text-text-tertiary">Signature</div>
          <p className="truncate text-xs text-text-secondary">
            <span className="font-mono">{inbox.email}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg p-1 text-text-tertiary hover:bg-bg-muted hover:text-text-primary"
          aria-label="Close signature editor"
        >
          <X size={14} />
        </button>
      </div>
      <div className="max-h-[200px] overflow-auto rounded-lg border border-border bg-card">
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
          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border-strong bg-card font-medium text-text-primary transition-colors hover:bg-bg-subtle hover:text-text-primary h-8 px-3 text-[13px] shadow-card"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="inbox-signature-save-button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent font-medium text-accent-foreground shadow-card transition-colors hover:bg-accent-hover disabled:opacity-50 h-8 px-3 text-[13px]"
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
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-md border transition-colors",
        checked
          ? "border-text-primary bg-accent text-accent-foreground"
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
