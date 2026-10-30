import { drizzle } from "drizzle-orm/d1";
import { schema } from "./schema";

export type DbEnv = {
  DB: D1Database;
  DB_LOG_QUERIES?: string;
};

export function drizzleOptions(env: Pick<DbEnv, "DB_LOG_QUERIES">): {
  schema: typeof schema;
  logger: boolean;
} {
  return {
    schema,
    logger: env.DB_LOG_QUERIES === "true",
  };
}

export function createDb(env: DbEnv) {
  return drizzle(env.DB, drizzleOptions(env));
}
