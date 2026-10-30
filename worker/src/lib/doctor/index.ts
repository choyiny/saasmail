/**
 * The admin doctor: runtime checks of one deployment (docs/doctor.md). It
 * reports which secrets are set as booleans and never returns a value.
 */
import { createDb } from "../../db/client";
import { buildInfo, buildSummary, type BuildSummary } from "../build-info";
import { bindingChecks } from "./bindings";
import { cronChecks } from "./cron";
import { inboundChecks } from "./inbound";
import { migrationChecks } from "./migrations";
import { backupChecks, outboxChecks } from "./outbox-backups";
import { secretChecks } from "./secrets";
import type { Check, CheckResult, DoctorContext } from "./types";

export type { Check, CheckResult, CheckStatus } from "./types";
export { recordCronTick, LAST_CRON_AT_KEY } from "./cron";

export interface DoctorReport {
  build: BuildSummary;
  /** Unix seconds. */
  checkedAt: number;
  checks: CheckResult[];
}

export const DOCTOR_CHECKS: Check[] = [
  ...migrationChecks,
  ...secretChecks,
  ...bindingChecks,
  ...cronChecks,
  ...outboxChecks,
  ...backupChecks,
  ...inboundChecks,
];

async function runOne(check: Check, ctx: DoctorContext): Promise<CheckResult> {
  try {
    const result = await check.run(ctx);
    return { id: check.id, group: check.group, ...result };
  } catch (err) {
    return {
      id: check.id,
      group: check.group,
      status: check.mandatory ? "fail" : "warn",
      summary: `The check could not run: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}

export async function runDoctor(
  env: CloudflareBindings,
  options: Partial<Pick<DoctorContext, "db" | "now" | "build">> & {
    checks?: Check[];
  } = {},
): Promise<DoctorReport> {
  const build = options.build ?? buildInfo();
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const ctx: DoctorContext = {
    env,
    db: options.db ?? createDb(env),
    now,
    build,
  };
  const checks = await Promise.all(
    (options.checks ?? DOCTOR_CHECKS).map((check) => runOne(check, ctx)),
  );
  return { build: buildSummary(build), checkedAt: now, checks };
}
