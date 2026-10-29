import { sql } from "drizzle-orm";
import type { Check, DoctorContext } from "./types";

const APPLY_HINT = "Run `npx wrangler d1 migrations apply DB --remote`.";

async function appliedNames(ctx: DoctorContext): Promise<Set<string>> {
  const rows = await ctx.db.all<{ name: string }>(
    sql`SELECT name FROM d1_migrations`,
  );
  return new Set(rows.map((row) => row.name));
}

function list(names: string[]): string {
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

export const migrationChecks: Check[] = [
  {
    id: "migrations.pending",
    group: "migrations",
    mandatory: true,
    async run(ctx) {
      const known = ctx.build.migrations;
      if (known.length === 0) {
        return {
          status: "fail",
          summary: "This build lists no migration files.",
          hint: "Rebuild with `yarn build` from a checkout that has migrations/.",
        };
      }
      const applied = await appliedNames(ctx);
      const pending = known.filter((name) => !applied.has(name));
      if (pending.length > 0) {
        return {
          status: "fail",
          summary: `${pending.length} migration${pending.length === 1 ? "" : "s"} not applied: ${list(pending)}.`,
          hint: APPLY_HINT,
        };
      }
      return {
        status: "pass",
        summary: `All ${known.length} migrations are applied.`,
      };
    },
  },
  {
    id: "migrations.unknown",
    group: "migrations",
    mandatory: false,
    async run(ctx) {
      const known = new Set(ctx.build.migrations);
      const applied = await appliedNames(ctx);
      const unknown = [...applied].filter((name) => !known.has(name)).sort();
      if (unknown.length > 0) {
        return {
          status: "warn",
          summary: `The database has ${unknown.length} migration${unknown.length === 1 ? "" : "s"} this build does not know (${list(unknown)}): it is ahead of the code, so an older build was deployed.`,
          hint: "Deploy the commit that added them, or a later one.",
        };
      }
      return {
        status: "pass",
        summary: "No applied migration is unknown to this build.",
      };
    },
  },
];
