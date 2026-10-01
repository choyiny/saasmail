import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Workflow,
} from "lucide-react";
import {
  createRule,
  deleteRule,
  fetchAdminInboxes,
  fetchAdminUsers,
  fetchMailboxes,
  fetchRules,
  reorderRules,
  testRule,
  updateRule,
  type AdminInbox,
  type AdminUser,
  type AutomationRule,
  type AutomationRuleInput,
  type Mailbox,
  type RuleAction,
  type RuleCondition,
  type RuleTestResult,
  type RuleWarning,
} from "@/lib/api";
import { showToast } from "@/lib/toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const CONDITION_FIELDS: Array<{
  value: RuleCondition["field"];
  label: string;
}> = [
  { value: "from_address", label: "From address" },
  { value: "from_domain", label: "From domain" },
  { value: "subject", label: "Subject" },
  { value: "body", label: "Body" },
  { value: "has_attachments", label: "Has attachments" },
  { value: "spam_score", label: "Spam score" },
  { value: "header", label: "Header" },
];

const ACTION_TYPES: Array<{ value: RuleAction["type"]; label: string }> = [
  { value: "archive", label: "Archive" },
  { value: "mark_spam", label: "Mark as spam" },
  { value: "move_to_folder", label: "Move to folder" },
  { value: "snooze", label: "Snooze" },
  { value: "assign", label: "Assign" },
  { value: "auto_reply", label: "Auto-reply" },
];

const OPERATORS: Record<RuleCondition["field"], string[]> = {
  from_address: ["equals", "contains", "ends_with"],
  from_domain: ["equals"],
  subject: ["contains", "equals", "starts_with"],
  body: ["contains"],
  has_attachments: ["is"],
  spam_score: ["gte", "lte"],
  header: ["equals", "contains"],
};

function conditionFor(field: RuleCondition["field"]): RuleCondition {
  switch (field) {
    case "from_address":
      return { field, operator: "equals", value: "" };
    case "from_domain":
      return { field, operator: "equals", value: "" };
    case "subject":
      return { field, operator: "contains", value: "" };
    case "body":
      return { field, operator: "contains", value: "" };
    case "has_attachments":
      return { field, operator: "is", value: true };
    case "spam_score":
      return { field, operator: "gte", value: 5 };
    case "header":
      return { field, name: "", operator: "equals", value: "" };
  }
}

function actionFor(
  type: RuleAction["type"],
  mailboxes: Mailbox[],
  users: AdminUser[],
): RuleAction {
  if (type === "move_to_folder") {
    return { type, mailboxId: mailboxes[0]?.id ?? "" };
  }
  if (type === "snooze") return { type, hours: 24 };
  if (type === "assign") return { type, userId: users[0]?.id ?? "" };
  if (type === "auto_reply") return { type, bodyText: "" };
  return { type };
}

function relativeTime(timestamp: number | null): string {
  if (timestamp === null) return "Never";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return String(minutes) + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return String(hours) + "h ago";
  return String(Math.floor(hours / 24)) + "d ago";
}

function conditionSummary(condition: RuleCondition): string {
  if (condition.field === "has_attachments") {
    return "has attachments is " + (condition.value ? "yes" : "no");
  }
  if (condition.field === "header") {
    return (
      "header " +
      (condition.name || "(name)") +
      " " +
      condition.operator +
      " " +
      (condition.value || "…")
    );
  }
  return (
    condition.field.replaceAll("_", " ") +
    " " +
    condition.operator +
    " " +
    (String(condition.value) || "…")
  );
}

function actionSummary(action: RuleAction): string {
  if (action.type === "mark_spam") return "mark as spam";
  if (action.type === "move_to_folder") return "move to folder";
  if (action.type === "snooze") return "snooze " + String(action.hours) + "h";
  if (action.type === "auto_reply") return "auto-reply";
  return action.type;
}

function warningMessage(warning: RuleWarning): string {
  return warning.code === "missing_folder"
    ? "Folder was deleted; this action does nothing"
    : "Assignee is unavailable; this action does nothing";
}

function emptyDraft(position: number): AutomationRuleInput {
  return {
    name: "",
    inbox: null,
    conditions: [],
    actions: [{ type: "archive" }],
    position,
    stopProcessing: false,
    enabled: true,
  };
}

function messageIdFromInput(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("received:")
    ? trimmed.slice("received:".length)
    : trimmed;
}

export default function AutomationsPage() {
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [inboxes, setInboxes] = useState<AdminInbox[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [actionWarnings, setActionWarnings] = useState<RuleWarning[]>([]);
  const [draft, setDraft] = useState<AutomationRuleInput>(() => emptyDraft(0));
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState("");
  const [testResult, setTestResult] = useState<RuleTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchRules(), fetchAdminInboxes(), fetchAdminUsers()])
      .then(([nextRules, nextInboxes, nextUsers]) => {
        if (cancelled) return;
        setRules(nextRules);
        setInboxes(nextInboxes);
        setUsers(nextUsers);
      })
      .catch((error) => {
        if (!cancelled) {
          showToast({
            kind: "error",
            message: "Couldn’t load automations",
            description: error instanceof Error ? error.message : undefined,
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!dialogOpen || !draft.inbox) {
      setMailboxes([]);
      return;
    }
    let cancelled = false;
    fetchMailboxes(draft.inbox)
      .then((rows) => {
        if (!cancelled) setMailboxes(rows);
      })
      .catch(() => {
        if (!cancelled) setMailboxes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [dialogOpen, draft.inbox]);

  const scopedUsers = useMemo(() => {
    if (!draft.inbox) return [];
    const scopedInbox = inboxes.find((inbox) => inbox.email === draft.inbox);
    const assigned = new Set(scopedInbox?.assignedUserIds ?? []);
    return users.filter(
      (user) => user.role === "admin" || assigned.has(user.id),
    );
  }, [draft.inbox, inboxes, users]);

  function openCreate() {
    const nextPosition =
      rules.reduce((max, rule) => Math.max(max, rule.position), -1) + 1;
    setEditingId(null);
    setActionWarnings([]);
    setDraft(emptyDraft(nextPosition));
    setServerError(null);
    setTestMessage("");
    setTestResult(null);
    setDialogOpen(true);
  }

  function openEdit(rule: AutomationRule) {
    setEditingId(rule.id);
    setActionWarnings(rule.warnings);
    setDraft({
      name: rule.name,
      inbox: rule.inbox,
      conditions: rule.conditions,
      actions: rule.actions,
      position: rule.position,
      stopProcessing: rule.stopProcessing,
      enabled: rule.enabled,
    });
    setServerError(null);
    setTestMessage("");
    setTestResult(null);
    setDialogOpen(true);
  }

  function updateCondition(
    index: number,
    update: (condition: RuleCondition) => RuleCondition,
  ) {
    setDraft((current) => ({
      ...current,
      conditions: current.conditions.map((condition, currentIndex) =>
        currentIndex === index ? update(condition) : condition,
      ),
    }));
  }

  function updateAction(
    index: number,
    update: (action: RuleAction) => RuleAction,
  ) {
    setDraft((current) => ({
      ...current,
      actions: current.actions.map((action, currentIndex) =>
        currentIndex === index ? update(action) : action,
      ),
    }));
    setActionWarnings((current) =>
      current.filter((warning) => warning.actionIndex !== index),
    );
  }

  function changeScope(inbox: string | null) {
    setDraft((current) => ({
      ...current,
      inbox,
      actions:
        inbox === null
          ? current.actions.map((action) =>
              action.type === "move_to_folder" ||
              action.type === "assign" ||
              action.type === "auto_reply"
                ? ({ type: "archive" } as const)
                : action,
            )
          : current.actions,
    }));
    setActionWarnings([]);
    setServerError(null);
  }

  async function saveRule() {
    setSaving(true);
    setServerError(null);
    try {
      if (editingId) {
        const updated = await updateRule(editingId, {
          name: draft.name,
          inbox: draft.inbox,
          conditions: draft.conditions,
          actions: draft.actions,
          position: draft.position,
          stopProcessing: draft.stopProcessing,
          enabled: draft.enabled,
        });
        setRules((current) =>
          current.map((rule) => (rule.id === editingId ? updated : rule)),
        );
      } else {
        const created = await createRule(draft);
        setRules((current) =>
          [...current, created].sort(
            (a, b) => a.position - b.position || a.id.localeCompare(b.id),
          ),
        );
      }
      setDialogOpen(false);
    } catch (error) {
      setServerError(
        error instanceof Error ? error.message : "Couldn’t save automation",
      );
    } finally {
      setSaving(false);
    }
  }

  async function toggleRule(rule: AutomationRule) {
    const enabled = !rule.enabled;
    setRules((current) =>
      current.map((item) =>
        item.id === rule.id ? { ...item, enabled } : item,
      ),
    );
    try {
      const updated = await updateRule(rule.id, { enabled });
      setRules((current) =>
        current.map((item) => (item.id === rule.id ? updated : item)),
      );
    } catch (error) {
      setRules((current) =>
        current.map((item) => (item.id === rule.id ? rule : item)),
      );
      showToast({
        kind: "error",
        message: "Couldn’t update automation",
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }

  async function moveRule(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= rules.length) return;
    const previous = rules;
    const reordered = [...rules];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved!);
    const positioned = reordered.map((rule, position) => ({
      ...rule,
      position,
    }));
    setRules(positioned);
    try {
      await reorderRules(positioned.map((rule) => rule.id));
    } catch (error) {
      setRules(previous);
      showToast({
        kind: "error",
        message: "Couldn’t reorder automations",
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }

  async function removeRule(rule: AutomationRule) {
    if (!window.confirm('Delete automation "' + rule.name + '"?')) return;
    try {
      await deleteRule(rule.id);
      setRules((current) => current.filter((item) => item.id !== rule.id));
    } catch (error) {
      showToast({
        kind: "error",
        message: "Couldn’t delete automation",
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }

  async function runTest() {
    const emailId = messageIdFromInput(testMessage);
    if (!emailId) return;
    setTesting(true);
    setServerError(null);
    setTestResult(null);
    try {
      setTestResult(await testRule(draft.conditions, emailId));
    } catch (error) {
      setServerError(
        error instanceof Error ? error.message : "Couldn’t test automation",
      );
    } finally {
      setTesting(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 md:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Workflow className="h-5 w-5 text-text-secondary" />
            <h1 className="text-xl font-semibold text-text-primary">
              Automations
            </h1>
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            Route new messages with ordered rules.
          </p>
        </div>
        <button
          type="button"
          data-testid="automation-new"
          onClick={openCreate}
          className="inline-flex items-center gap-1.5 rounded-[6px] bg-text-primary px-3 py-2 text-sm font-medium text-background"
        >
          <Plus className="h-4 w-4" />
          New automation
        </button>
      </div>

      <div className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
        {loading ? (
          <p className="p-6 text-sm text-text-tertiary">Loading automations…</p>
        ) : rules.length === 0 ? (
          <p className="p-6 text-sm text-text-tertiary">
            No automations yet. Create one to route inbound mail.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {rules.map((rule, index) => (
              <div
                key={rule.id}
                data-testid="automation-rule-row"
                data-rule-id={rule.id}
                className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,2fr)_auto]"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-text-primary">
                      {rule.name}
                    </span>
                    <span className="rounded bg-bg-muted px-1.5 py-0.5 text-[10px] text-text-secondary">
                      {rule.inbox ?? "All inboxes"}
                    </span>
                    {rule.warnings.length > 0 && (
                      <span
                        data-testid="automation-warning-badge"
                        className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                      >
                        {rule.warnings.length}{" "}
                        {rule.warnings.length === 1 ? "warning" : "warnings"}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-text-tertiary">
                    {rule.conditions.length === 0
                      ? "Every message"
                      : rule.conditions.map(conditionSummary).join(" · ")}
                  </p>
                  <p className="mt-1 text-xs text-text-tertiary">
                    {rule.actions.map(actionSummary).join(" → ")}
                    {rule.stopProcessing ? " · then stop" : ""}
                  </p>
                </div>

                <div className="flex items-center gap-5 text-xs text-text-secondary">
                  <span>
                    <strong className="font-medium text-text-primary">
                      {rule.matchCount}
                    </strong>{" "}
                    matches
                  </span>
                  <span>Last matched {relativeTime(rule.lastMatchedAt)}</span>
                </div>

                <div className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={rule.enabled}
                    aria-label={
                      (rule.enabled ? "Disable " : "Enable ") + rule.name
                    }
                    onClick={() => void toggleRule(rule)}
                    className={
                      "rounded-full px-2 py-1 text-[11px] font-medium " +
                      (rule.enabled
                        ? "bg-emerald-500/15 text-emerald-700"
                        : "bg-bg-muted text-text-tertiary")
                    }
                  >
                    {rule.enabled ? "On" : "Off"}
                  </button>
                  <button
                    type="button"
                    aria-label={"Move " + rule.name + " up"}
                    data-testid="rule-move-up"
                    disabled={index === 0}
                    onClick={() => void moveRule(index, -1)}
                    className="rounded p-1.5 text-text-secondary hover:bg-bg-muted disabled:opacity-30"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={"Move " + rule.name + " down"}
                    data-testid="rule-move-down"
                    disabled={index === rules.length - 1}
                    onClick={() => void moveRule(index, 1)}
                    className="rounded p-1.5 text-text-secondary hover:bg-bg-muted disabled:opacity-30"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={"Edit " + rule.name}
                    onClick={() => openEdit(rule)}
                    className="rounded p-1.5 text-text-secondary hover:bg-bg-muted"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={"Delete " + rule.name}
                    onClick={() => void removeRule(rule)}
                    className="rounded p-1.5 text-text-secondary hover:bg-bg-muted hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingId ? "Edit automation" : "New automation"}
            </DialogTitle>
            <DialogDescription>
              Rules run in order when a new message is received.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm text-text-secondary">
                Name
                <input
                  aria-label="Rule name"
                  value={draft.name}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  className="mt-1 w-full rounded-[6px] border border-border bg-card px-3 py-2 text-sm text-text-primary outline-none focus:border-text-tertiary"
                />
              </label>
              <label className="text-sm text-text-secondary">
                Scope
                <select
                  aria-label="Scope"
                  value={draft.inbox ?? ""}
                  onChange={(event) => changeScope(event.target.value || null)}
                  className="mt-1 w-full rounded-[6px] border border-border bg-card px-3 py-2 text-sm text-text-primary outline-none focus:border-text-tertiary"
                >
                  <option value="">All inboxes</option>
                  {inboxes.map((inbox) => (
                    <option key={inbox.email} value={inbox.email}>
                      {inbox.displayName
                        ? inbox.displayName + " — " + inbox.email
                        : inbox.email}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-text-primary">
                    Conditions
                  </h2>
                  <p className="text-xs text-text-tertiary">
                    All conditions must match. Up to 10.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={draft.conditions.length >= 10}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      conditions: [
                        ...current.conditions,
                        conditionFor("subject"),
                      ],
                    }))
                  }
                  className="rounded-[6px] border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:bg-bg-muted disabled:opacity-50"
                >
                  Add condition
                </button>
              </div>

              {draft.conditions.length === 0 && (
                <div
                  role="status"
                  className="mb-3 rounded-[6px] border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800"
                >
                  This rule matches every message in its scope
                </div>
              )}

              <div className="space-y-2">
                {draft.conditions.map((condition, index) => (
                  <div
                    key={index}
                    className="grid gap-2 rounded-[6px] border border-border bg-bg-subtle p-2 md:grid-cols-[1.1fr_1fr_1.4fr_auto]"
                  >
                    <select
                      aria-label={"Condition " + String(index + 1) + " field"}
                      value={condition.field}
                      onChange={(event) =>
                        updateCondition(index, () =>
                          conditionFor(
                            event.target.value as RuleCondition["field"],
                          ),
                        )
                      }
                      className="rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary"
                    >
                      {CONDITION_FIELDS.map((field) => (
                        <option key={field.value} value={field.value}>
                          {field.label}
                        </option>
                      ))}
                    </select>

                    <select
                      aria-label={
                        "Condition " + String(index + 1) + " operator"
                      }
                      value={condition.operator}
                      onChange={(event) =>
                        updateCondition(
                          index,
                          (current) =>
                            ({
                              ...current,
                              operator: event.target.value,
                            }) as RuleCondition,
                        )
                      }
                      className="rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary"
                    >
                      {OPERATORS[condition.field].map((operator) => (
                        <option key={operator} value={operator}>
                          {operator.replaceAll("_", " ")}
                        </option>
                      ))}
                    </select>

                    <div className="flex min-w-0 gap-2">
                      {condition.field === "header" && (
                        <input
                          aria-label={
                            "Condition " + String(index + 1) + " header name"
                          }
                          placeholder="Header name"
                          value={condition.name}
                          onChange={(event) =>
                            updateCondition(index, (current) =>
                              current.field === "header"
                                ? { ...current, name: event.target.value }
                                : current,
                            )
                          }
                          className="min-w-0 flex-1 rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary"
                        />
                      )}

                      {condition.field === "has_attachments" ? (
                        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-secondary">
                          <input
                            aria-label={
                              "Condition " + String(index + 1) + " value"
                            }
                            type="checkbox"
                            checked={condition.value}
                            onChange={(event) =>
                              updateCondition(index, (current) =>
                                current.field === "has_attachments"
                                  ? {
                                      ...current,
                                      value: event.target.checked,
                                    }
                                  : current,
                              )
                            }
                          />
                          Has attachments
                        </label>
                      ) : condition.field === "spam_score" ? (
                        <input
                          aria-label={
                            "Condition " + String(index + 1) + " value"
                          }
                          type="number"
                          value={condition.value}
                          onChange={(event) =>
                            updateCondition(index, (current) =>
                              current.field === "spam_score"
                                ? {
                                    ...current,
                                    value: Number(event.target.value),
                                  }
                                : current,
                            )
                          }
                          className="min-w-0 flex-1 rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary"
                        />
                      ) : (
                        <input
                          aria-label={
                            "Condition " + String(index + 1) + " value"
                          }
                          value={condition.value}
                          onChange={(event) =>
                            updateCondition(index, (current) =>
                              current.field === "has_attachments" ||
                              current.field === "spam_score"
                                ? current
                                : { ...current, value: event.target.value },
                            )
                          }
                          className="min-w-0 flex-1 rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary"
                        />
                      )}
                    </div>

                    <button
                      type="button"
                      aria-label={"Remove condition " + String(index + 1)}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          conditions: current.conditions.filter(
                            (_, currentIndex) => currentIndex !== index,
                          ),
                        }))
                      }
                      className="rounded p-1.5 text-text-tertiary hover:bg-bg-muted hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-text-primary">
                    Actions
                  </h2>
                  <p className="text-xs text-text-tertiary">
                    Run 1–5 actions in order.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={draft.actions.length >= 5}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      actions: [...current.actions, { type: "archive" }],
                    }))
                  }
                  className="rounded-[6px] border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:bg-bg-muted disabled:opacity-50"
                >
                  Add action
                </button>
              </div>

              {!draft.inbox && (
                <p className="mb-3 rounded-[6px] bg-bg-subtle px-3 py-2 text-xs text-text-tertiary">
                  Move to folder, Assign, and Auto-reply are unavailable for All
                  inboxes. Choose a specific inbox to use those actions.
                </p>
              )}

              <div className="space-y-2">
                {draft.actions.map((action, index) => (
                  <div
                    key={index}
                    className="grid gap-2 rounded-[6px] border border-border bg-bg-subtle p-2 md:grid-cols-[1.1fr_1.7fr_auto]"
                  >
                    <select
                      aria-label={"Action " + String(index + 1) + " type"}
                      value={action.type}
                      onChange={(event) =>
                        updateAction(index, () =>
                          actionFor(
                            event.target.value as RuleAction["type"],
                            mailboxes,
                            scopedUsers,
                          ),
                        )
                      }
                      className="rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary"
                    >
                      {ACTION_TYPES.map((type) => (
                        <option
                          key={type.value}
                          value={type.value}
                          disabled={
                            !draft.inbox &&
                            (type.value === "move_to_folder" ||
                              type.value === "assign" ||
                              type.value === "auto_reply")
                          }
                        >
                          {type.label}
                        </option>
                      ))}
                    </select>

                    <div>
                      {actionWarnings
                        .filter((warning) => warning.actionIndex === index)
                        .map((warning) => (
                          <p
                            key={warning.code}
                            className="mb-2 text-[11px] font-medium text-amber-700"
                          >
                            {warningMessage(warning)}
                          </p>
                        ))}
                      {action.type === "move_to_folder" && (
                        <select
                          aria-label={"Action " + String(index + 1) + " folder"}
                          value={action.mailboxId}
                          onChange={(event) =>
                            updateAction(index, (current) =>
                              current.type === "move_to_folder"
                                ? {
                                    ...current,
                                    mailboxId: event.target.value,
                                  }
                                : current,
                            )
                          }
                          className="w-full rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary"
                        >
                          {mailboxes.length === 0 && (
                            <option value="">No folders available</option>
                          )}
                          {mailboxes.map((mailbox) => (
                            <option key={mailbox.id} value={mailbox.id}>
                              {mailbox.name}
                            </option>
                          ))}
                        </select>
                      )}
                      {action.type === "snooze" && (
                        <input
                          aria-label={"Action " + String(index + 1) + " hours"}
                          type="number"
                          min={1}
                          max={720}
                          value={action.hours}
                          onChange={(event) =>
                            updateAction(index, (current) =>
                              current.type === "snooze"
                                ? {
                                    ...current,
                                    hours: Number(event.target.value),
                                  }
                                : current,
                            )
                          }
                          className="w-full rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary"
                        />
                      )}
                      {action.type === "assign" && (
                        <select
                          aria-label={"Action " + String(index + 1) + " user"}
                          value={action.userId}
                          onChange={(event) =>
                            updateAction(index, (current) =>
                              current.type === "assign"
                                ? {
                                    ...current,
                                    userId: event.target.value,
                                  }
                                : current,
                            )
                          }
                          className="w-full rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary"
                        >
                          {scopedUsers.length === 0 && (
                            <option value="">No users available</option>
                          )}
                          {scopedUsers.map((user) => (
                            <option key={user.id} value={user.id}>
                              {user.name || user.email}
                            </option>
                          ))}
                        </select>
                      )}
                      {action.type === "auto_reply" && (
                        <div className="space-y-2">
                          <input
                            aria-label={
                              "Action " + String(index + 1) + " subject"
                            }
                            maxLength={200}
                            placeholder="Subject (optional)"
                            value={action.subject ?? ""}
                            onChange={(event) =>
                              updateAction(index, (current) =>
                                current.type === "auto_reply"
                                  ? {
                                      ...current,
                                      subject: event.target.value || undefined,
                                    }
                                  : current,
                              )
                            }
                            className="w-full rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary"
                          />
                          <div>
                            <textarea
                              aria-label={
                                "Action " + String(index + 1) + " body"
                              }
                              maxLength={5000}
                              rows={5}
                              value={action.bodyText}
                              onChange={(event) =>
                                updateAction(index, (current) =>
                                  current.type === "auto_reply"
                                    ? {
                                        ...current,
                                        bodyText: event.target.value,
                                      }
                                    : current,
                                )
                              }
                              className="w-full resize-y rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary"
                            />
                            <p className="mt-1 text-right text-[10px] text-text-tertiary">
                              {action.bodyText.length}/5000
                            </p>
                          </div>
                          <p className="text-[11px] leading-4 text-text-tertiary">
                            Won&apos;t reply to automated mail, your own
                            addresses, blocked/suppressed senders, or the same
                            sender more than once per 24h.
                          </p>
                        </div>
                      )}
                      {(action.type === "archive" ||
                        action.type === "mark_spam") && (
                        <span className="inline-flex h-8 items-center text-xs text-text-tertiary">
                          No additional settings
                        </span>
                      )}
                    </div>

                    <button
                      type="button"
                      aria-label={"Remove action " + String(index + 1)}
                      disabled={draft.actions.length <= 1}
                      onClick={() => {
                        setDraft((current) => ({
                          ...current,
                          actions: current.actions.filter(
                            (_, currentIndex) => currentIndex !== index,
                          ),
                        }));
                        setActionWarnings([]);
                      }}
                      className="rounded p-1.5 text-text-tertiary hover:bg-bg-muted hover:text-red-600 disabled:opacity-30"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </section>

            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={draft.stopProcessing}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    stopProcessing: event.target.checked,
                  }))
                }
              />
              Stop processing after this rule matches
            </label>

            <section className="rounded-[6px] border border-border bg-bg-subtle p-3">
              <h2 className="text-sm font-semibold text-text-primary">
                Test against a message
              </h2>
              <p className="mt-1 text-xs text-text-tertiary">
                Paste a received message ref or id. Testing never runs actions.
              </p>
              <div className="mt-2 flex gap-2">
                <input
                  aria-label="Message ref or id"
                  value={testMessage}
                  onChange={(event) => setTestMessage(event.target.value)}
                  placeholder="received:abc123 or abc123"
                  className="min-w-0 flex-1 rounded-[6px] border border-border bg-card px-3 py-2 text-xs text-text-primary"
                />
                <button
                  type="button"
                  disabled={testing || !testMessage.trim()}
                  onClick={() => void runTest()}
                  className="rounded-[6px] border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-muted disabled:opacity-50"
                >
                  {testing ? "Testing…" : "Test"}
                </button>
              </div>
              {testResult && (
                <div className="mt-3 text-xs text-text-secondary">
                  <p className="font-medium text-text-primary">
                    {testResult.matched ? "Matched" : "Did not match"}
                  </p>
                  <ul className="mt-1 space-y-1">
                    {testResult.conditionResults.map((result, index) => (
                      <li key={index}>
                        {result.matched ? "✓" : "✕"}{" "}
                        {conditionSummary(result.condition)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            {serverError && (
              <p
                role="alert"
                className="rounded-[6px] border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700"
              >
                {serverError}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDialogOpen(false)}
                className="rounded-[6px] border border-border px-3 py-2 text-sm text-text-secondary hover:bg-bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="automation-save"
                disabled={saving}
                onClick={() => void saveRule()}
                className="inline-flex items-center gap-1.5 rounded-[6px] bg-text-primary px-3 py-2 text-sm font-medium text-background disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                Save automation
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
