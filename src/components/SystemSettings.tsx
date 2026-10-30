import { useCallback, useEffect, useState } from "react";
import {
  fetchDoctorReport,
  type DoctorCheck,
  type DoctorReport,
  type DoctorStatus,
} from "@/lib/api";

const RANK: Record<DoctorStatus, number> = {
  fail: 0,
  warn: 1,
  info: 2,
  pass: 3,
};

const LABEL: Record<DoctorStatus, string> = {
  fail: "Fail",
  warn: "Warning",
  info: "Note",
  pass: "OK",
};

const BADGE: Record<DoctorStatus, string> = {
  fail: "bg-red-600/10 text-red-600",
  warn: "bg-amber-500/10 text-amber-600",
  info: "bg-text-primary/5 text-text-secondary",
  pass: "bg-emerald-600/10 text-emerald-600",
};

/** Groups ordered by their worst check, checks inside by status: fail first. */
export function groupChecks(
  checks: DoctorCheck[],
): { group: string; checks: DoctorCheck[] }[] {
  const groups = new Map<string, DoctorCheck[]>();
  for (const check of checks) {
    groups.set(check.group, [...(groups.get(check.group) ?? []), check]);
  }
  const worst = (list: DoctorCheck[]) =>
    Math.min(...list.map((c) => RANK[c.status]));
  return [...groups.entries()]
    .map(([group, list]) => ({
      group,
      checks: [...list].sort((a, b) => RANK[a.status] - RANK[b.status]),
    }))
    .sort((a, b) => worst(a.checks) - worst(b.checks));
}

function formatTime(iso: string | null): string {
  if (!iso) return "unknown";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** Settings → System (admins): the build this deployment runs, and its checks. */
export default function SystemSettings() {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [showChecks, setShowChecks] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await fetchDoctorReport());
      return true;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not load the system report.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runChecks() {
    if (await load()) setShowChecks(true);
  }

  const build = report?.build;

  return (
    <section
      id="system"
      className="scroll-mt-6 space-y-3"
      data-testid="system-settings"
    >
      <h2 className="text-base font-semibold text-text-primary">System</h2>

      <div className="rounded-[8px] bg-card p-5 ring-1 ring-border">
        <p className="text-sm font-medium text-text-primary">Build</p>
        <p className="mt-1 text-xs font-light text-text-secondary">
          The version and commit this deployment runs. Compare the commit with
          your checkout before testing or updating.
        </p>
        {build && (
          <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-text-tertiary">Version</dt>
            <dd className="text-text-primary">{build.version}</dd>
            <dt className="text-text-tertiary">Commit</dt>
            <dd
              className="select-all font-mono text-text-primary"
              title={build.commit}
              data-testid="system-commit"
            >
              {build.commitShort}
            </dd>
            <dt className="text-text-tertiary">Built</dt>
            <dd className="text-text-primary">{formatTime(build.builtAt)}</dd>
            <dt className="text-text-tertiary">Working tree</dt>
            <dd className="text-text-primary" data-testid="system-dirty">
              {build.dirty
                ? `Uncommitted changes (${build.dirtyCount})`
                : "Clean"}
            </dd>
          </dl>
        )}
        {build?.dirty && build.dirtyFiles.length > 0 && (
          <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-text-secondary">
            {build.dirtyFiles.map((file) => (
              <li key={file}>{file}</li>
            ))}
            {build.dirtyCount > build.dirtyFiles.length && (
              <li>…and {build.dirtyCount - build.dirtyFiles.length} more</li>
            )}
          </ul>
        )}
      </div>

      <div className="rounded-[8px] bg-card p-5 ring-1 ring-border">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium text-text-primary">Checks</p>
            <p className="text-xs font-light text-text-secondary">
              Migrations, secrets, bindings, the outbound provider, the cron,
              the outbox, backups and inbound mail. <code>yarn doctor</code>{" "}
              adds the Cloudflare-side checks.
            </p>
          </div>
          <button
            type="button"
            onClick={runChecks}
            disabled={busy}
            className="shrink-0 rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Checking…" : "Run checks"}
          </button>
        </div>

        {showChecks && report && (
          <div className="mt-4 space-y-4" data-testid="system-checks">
            {groupChecks(report.checks).map(({ group, checks }) => (
              <div key={group}>
                <p className="text-xs font-medium uppercase tracking-wider text-text-tertiary">
                  {group}
                </p>
                <ul className="mt-1.5 space-y-2">
                  {checks.map((check) => (
                    <li
                      key={check.id}
                      className="flex items-start gap-2 text-xs"
                      data-status={check.status}
                    >
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${BADGE[check.status]}`}
                      >
                        {LABEL[check.status]}
                      </span>
                      <span className="min-w-0">
                        <span className="text-text-primary">
                          {check.summary}
                        </span>
                        {check.hint && (
                          <span className="block text-text-tertiary">
                            {check.hint}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
