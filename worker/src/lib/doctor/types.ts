import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { BuildStamp } from "../build-info";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = DrizzleD1Database<any>;

export type CheckStatus = "pass" | "warn" | "fail" | "info";

export interface CheckResult {
  id: string;
  group: string;
  status: CheckStatus;
  summary: string;
  /** What to run or set, in one line. */
  hint?: string;
}

export interface DoctorContext {
  env: CloudflareBindings;
  db: Db;
  /** Unix seconds. */
  now: number;
  build: BuildStamp;
}

export interface Check {
  id: string;
  group: string;
  /**
   * A mandatory check that cannot run fails (an unknown state must not pass a
   * deploy); any other check that throws warns.
   */
  mandatory: boolean;
  run(
    ctx: DoctorContext,
  ): Promise<{ status: CheckStatus; summary: string; hint?: string }>;
}

/** `BASE_URL` points at this machine (the doctor's own rule, not is-dev.ts's). */
export function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  );
}

/** One number from a `SELECT COUNT(*) AS n …`-style row. */
export function count(row: { n: number | null } | undefined): number {
  return Number(row?.n ?? 0);
}
