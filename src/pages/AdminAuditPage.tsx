import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Download, ScrollText } from "lucide-react";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { SectionHeader } from "@/components/PageForm";
import {
  auditExportUrl,
  fetchAdminInboxes,
  fetchAdminUsers,
  fetchAuditActions,
  fetchAuditEvents,
  type AdminUser,
  type AuditEvent,
  type AuditFilters,
} from "@/lib/api";

interface FilterForm {
  /** "" for all, "prefix:mail." for a group, "action:mail.sent" for one. */
  action: string;
  actorUserId: string;
  inbox: string;
  fromDate: string;
  toDate: string;
  q: string;
}

const EMPTY: FilterForm = {
  action: "",
  actorUserId: "",
  inbox: "",
  fromDate: "",
  toDate: "",
  q: "",
};

/** The start (or the end) of a local calendar day, in unix seconds. */
function dayBoundary(date: string, end: boolean): number | undefined {
  if (!date) return undefined;
  const time = new Date(`${date}T${end ? "23:59:59" : "00:00:00"}`).getTime();
  return Number.isNaN(time) ? undefined : Math.floor(time / 1000);
}

function toFilters(form: FilterForm): AuditFilters {
  return {
    ...(form.action.startsWith("prefix:")
      ? { actionPrefix: form.action.slice("prefix:".length) }
      : form.action.startsWith("action:")
        ? { action: form.action.slice("action:".length) }
        : {}),
    ...(form.actorUserId ? { actorUserId: form.actorUserId } : {}),
    ...(form.inbox ? { inbox: form.inbox } : {}),
    from: dayBoundary(form.fromDate, false),
    to: dayBoundary(form.toDate, true),
    ...(form.q.trim() ? { q: form.q.trim() } : {}),
  };
}

function formatTime(at: number): string {
  return new Date(at * 1000).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

function targetLabel(event: AuditEvent): string {
  if (!event.targetType) return "";
  return event.targetId
    ? `${event.targetType} ${event.targetId}`
    : event.targetType;
}

const inputClass =
  "w-full rounded-[6px] border border-border bg-card px-2.5 py-1.5 text-xs text-text-primary outline-none focus:ring-2 focus:ring-text-primary/15";
const labelClass =
  "mb-1 block text-[11px] font-medium uppercase tracking-wider text-text-tertiary";

/** What a row shows when it is opened: the context and the details. */
function EventDetails({ event }: { event: AuditEvent }) {
  return (
    <div
      data-testid="audit-event-details"
      className="space-y-2 bg-bg-subtle/60 px-4 py-3 text-xs text-text-secondary"
    >
      <p>
        <span className="font-medium text-text-primary">Channel:</span>{" "}
        {event.channel} · {event.actorType}
        {event.ip ? ` · ${event.ip}` : ""}
      </p>
      {event.userAgent && <p className="break-words">{event.userAgent}</p>}
      {event.details ? (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-[6px] bg-card p-3 font-mono text-[11px] text-text-primary ring-1 ring-border">
          {JSON.stringify(event.details, null, 2)}
        </pre>
      ) : (
        <p className="text-text-tertiary">No further details.</p>
      )}
    </div>
  );
}

export default function AdminAuditPage() {
  const [form, setForm] = useState<FilterForm>(EMPTY);
  // The filters of the list on screen; `form` is what is being edited.
  const [applied, setApplied] = useState<FilterForm>(EMPTY);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const [actions, setActions] = useState<string[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [inboxes, setInboxes] = useState<string[]>([]);

  // The choices of the filter bar. Each is optional: the log still loads
  // without them.
  useEffect(() => {
    fetchAuditActions()
      .then((res) => setActions(res.actions))
      .catch(() => {});
    fetchAdminUsers()
      .then(setUsers)
      .catch(() => {});
    fetchAdminInboxes()
      .then((rows) => setInboxes(rows.map((row) => row.email)))
      .catch(() => {});
  }, []);

  const filters = useMemo(() => toFilters(applied), [applied]);
  // The filters of the latest list, to drop a page that was asked for under
  // older ones and comes back late.
  const currentFilters = useRef(filters);
  currentFilters.current = filters;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchAuditEvents(filters)
      .then((res) => {
        if (cancelled) return;
        setEvents(res.events);
        setNextCursor(res.nextCursor);
        setOpen(new Set());
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load the audit log.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    const requested = filters;
    try {
      const res = await fetchAuditEvents(requested, nextCursor);
      // The filters changed while this page was loading: it belongs to a
      // list that is no longer on screen.
      if (currentFilters.current !== requested) return;
      setEvents((previous) => [...previous, ...res.events]);
      setNextCursor(res.nextCursor);
    } catch {
      if (currentFilters.current === requested)
        setError("Failed to load more.");
    } finally {
      setLoadingMore(false);
    }
  }

  function toggle(id: string) {
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const groups = useMemo(
    () => [...new Set(actions.map((action) => action.split(".")[0]))].sort(),
    [actions],
  );

  const set =
    (key: keyof FilterForm) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>): void =>
      setForm((previous) => ({ ...previous, [key]: event.target.value }));

  return (
    <PageContainer>
      <PageHeader
        title="Audit log"
        subtitle="Who did what: sends, deletions, shared mail state, settings, access and credentials."
        action={
          <a
            href={auditExportUrl(filters)}
            download
            data-testid="audit-export"
            className="inline-flex items-center gap-1.5 rounded-[8px] border border-border bg-card px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
          >
            <Download size={14} />
            Download CSV
          </a>
        }
      />

      <div className="space-y-6">
        <form
          data-testid="audit-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied(form);
          }}
          className="grid gap-3 rounded-[8px] bg-card p-4 ring-1 ring-border sm:grid-cols-2 lg:grid-cols-6"
        >
          <div>
            <label htmlFor="audit-action" className={labelClass}>
              Action
            </label>
            <select
              id="audit-action"
              value={form.action}
              onChange={set("action")}
              className={inputClass}
            >
              <option value="">All actions</option>
              {groups.length > 0 && (
                <optgroup label="Groups">
                  {groups.map((group) => (
                    <option key={group} value={`prefix:${group}.`}>
                      {group}.*
                    </option>
                  ))}
                </optgroup>
              )}
              {actions.length > 0 && (
                <optgroup label="Actions">
                  {actions.map((action) => (
                    <option key={action} value={`action:${action}`}>
                      {action}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <div>
            <label htmlFor="audit-actor" className={labelClass}>
              Person
            </label>
            <select
              id="audit-actor"
              value={form.actorUserId}
              onChange={set("actorUserId")}
              className={inputClass}
            >
              <option value="">Anyone</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.email}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="audit-inbox" className={labelClass}>
              Inbox
            </label>
            <select
              id="audit-inbox"
              value={form.inbox}
              onChange={set("inbox")}
              className={inputClass}
            >
              <option value="">All inboxes</option>
              {inboxes.map((inbox) => (
                <option key={inbox} value={inbox}>
                  {inbox}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="audit-from" className={labelClass}>
              From
            </label>
            <input
              id="audit-from"
              type="date"
              value={form.fromDate}
              onChange={set("fromDate")}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="audit-to" className={labelClass}>
              To
            </label>
            <input
              id="audit-to"
              type="date"
              value={form.toDate}
              onChange={set("toDate")}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="audit-q" className={labelClass}>
              Text
            </label>
            <input
              id="audit-q"
              type="search"
              value={form.q}
              onChange={set("q")}
              placeholder="Summary or actor"
              className={inputClass}
            />
          </div>
          <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-6">
            <button
              type="submit"
              className="rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-text-primary/90"
            >
              Apply filters
            </button>
            <button
              type="button"
              onClick={() => {
                setForm(EMPTY);
                setApplied(EMPTY);
              }}
              className="rounded-[6px] border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
            >
              Reset
            </button>
          </div>
        </form>

        <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
          <div className="border-b border-border px-5 py-4">
            <SectionHeader
              icon={ScrollText}
              title={`Events (${events.length}${nextCursor ? "+" : ""})`}
              subtitle="Newest first. Open a row for its details."
            />
          </div>

          {error && (
            <div
              role="alert"
              className="border-b border-border bg-rose-50/60 px-5 py-2 text-xs font-medium text-rose-700"
            >
              {error}
            </div>
          )}

          {loading ? (
            <p className="px-5 py-8 text-center text-sm text-text-tertiary">
              Loading…
            </p>
          ) : events.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-text-tertiary">
              No events match these filters.
            </p>
          ) : (
            <>
              {/* Wide screens: a table. */}
              <table
                data-testid="audit-table"
                className="hidden w-full table-fixed text-left text-xs md:table"
              >
                <thead className="border-b border-border text-[11px] uppercase tracking-wider text-text-tertiary">
                  <tr>
                    <th className="w-[15%] px-4 py-2 font-medium">Time</th>
                    <th className="w-[17%] px-4 py-2 font-medium">Actor</th>
                    <th className="w-[13%] px-4 py-2 font-medium">Action</th>
                    <th className="w-[14%] px-4 py-2 font-medium">Target</th>
                    <th className="w-[14%] px-4 py-2 font-medium">Inbox</th>
                    <th className="px-4 py-2 font-medium">Summary</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {events.map((event) => (
                    <Fragment key={event.id}>
                      <tr
                        data-testid="audit-row"
                        onClick={() => toggle(event.id)}
                        aria-expanded={open.has(event.id)}
                        className="cursor-pointer align-top text-text-secondary hover:bg-bg-muted/60"
                      >
                        <td className="px-4 py-2 text-text-tertiary">
                          {formatTime(event.at)}
                        </td>
                        <td className="break-words px-4 py-2 text-text-primary">
                          {event.actorLabel}
                        </td>
                        <td className="break-words px-4 py-2 font-mono text-[11px]">
                          {event.action}
                        </td>
                        <td className="break-words px-4 py-2">
                          {targetLabel(event)}
                        </td>
                        <td className="break-words px-4 py-2">
                          {event.inbox ?? ""}
                        </td>
                        <td className="break-words px-4 py-2 text-text-primary">
                          {event.summary}
                        </td>
                      </tr>
                      {open.has(event.id) && (
                        <tr>
                          <td colSpan={6} className="p-0">
                            <EventDetails event={event} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>

              {/* Narrow screens: one card per event. */}
              <ul className="divide-y divide-border md:hidden">
                {events.map((event) => (
                  <li key={event.id}>
                    <button
                      type="button"
                      onClick={() => toggle(event.id)}
                      aria-expanded={open.has(event.id)}
                      className="block w-full px-4 py-3 text-left"
                    >
                      <span className="block text-sm text-text-primary">
                        {event.summary}
                      </span>
                      <span className="mt-1 block text-[11px] text-text-tertiary">
                        {formatTime(event.at)} · {event.actorLabel} ·{" "}
                        <span className="font-mono">{event.action}</span>
                        {event.inbox ? ` · ${event.inbox}` : ""}
                      </span>
                    </button>
                    {open.has(event.id) && <EventDetails event={event} />}
                  </li>
                ))}
              </ul>

              {nextCursor && (
                <div className="border-t border-border px-5 py-3">
                  <button
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="w-full rounded-[6px] border border-border bg-card py-2 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {loadingMore ? "Loading…" : "Load more"}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </PageContainer>
  );
}
