import { is } from "drizzle-orm";
import { SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";
import * as tables from "../../db";

/**
 * Tables a backup leaves out: sessions and tokens (a restore signs everyone
 * out), the OAuth signing keys (made again on first use), and short-lived
 * counters, change logs and rate limits that mean nothing in another
 * instance.
 */
export const EXCLUDED_TABLES: ReadonlySet<string> = new Set([
  "sessions",
  "verifications",
  "oauth_access_tokens",
  "oauth_refresh_tokens",
  "jwkss",
  "auth_rate_limits",
  "jmap_changes",
  "send_idempotency",
  "send_counters",
  "subscribe_attempts",
  // The backups' own history describes this instance's bucket.
  "backup_runs",
]);

export interface BackupTable {
  name: string;
  /** The table's columns, in schema order. */
  columns: string[];
  /** Its primary key's columns (empty when it has none). */
  primaryKey: string[];
  /** Its references to other tables, for a restore to drop orphans. */
  foreignKeys: { columns: string[]; table: string; references: string[] }[];
}

/** Every table the schema defines, by name. */
export function allTables(): Map<string, SQLiteTable> {
  const found = new Map<string, SQLiteTable>();
  for (const value of Object.values(tables)) {
    if (is(value, SQLiteTable)) found.set(getTableConfig(value).name, value);
  }
  return found;
}

/**
 * The tables a backup dumps, parents before the tables that reference them,
 * so a restore can insert in this order and delete in the reverse one.
 * Ties are broken by name, so the order is the same every time.
 */
export function backupTables(): BackupTable[] {
  const defined = allTables();
  const included = [...defined.keys()]
    .filter((name) => !EXCLUDED_TABLES.has(name))
    .sort();
  const parents = new Map<string, Set<string>>();
  for (const name of included) {
    const config = getTableConfig(defined.get(name)!);
    parents.set(
      name,
      new Set(
        config.foreignKeys
          .map((key) => getTableConfig(key.reference().foreignTable).name)
          .filter((parent) => parent !== name),
      ),
    );
  }
  const ordered: string[] = [];
  const placed = new Set<string>();
  while (ordered.length < included.length) {
    const ready = included.find(
      (name) =>
        !placed.has(name) &&
        [...parents.get(name)!].every(
          (parent) => placed.has(parent) || !parents.has(parent),
        ),
    );
    // A cycle (none today) falls back to name order for what is left.
    const next = ready ?? included.find((name) => !placed.has(name))!;
    ordered.push(next);
    placed.add(next);
  }
  return ordered.map((name) => {
    const config = getTableConfig(defined.get(name)!);
    const primaryKey = config.columns
      .filter((column) => column.primary)
      .map((column) => column.name);
    return {
      name,
      foreignKeys: config.foreignKeys.map((key) => {
        const reference = key.reference();
        return {
          columns: reference.columns.map((column) => column.name),
          table: getTableConfig(reference.foreignTable).name,
          references: reference.foreignColumns.map((column) => column.name),
        };
      }),
      columns: config.columns.map((column) => column.name),
      primaryKey:
        primaryKey.length > 0
          ? primaryKey
          : (config.primaryKeys[0]?.columns.map((column) => column.name) ?? []),
    };
  });
}
