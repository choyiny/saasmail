import type { DrizzleD1Database } from "drizzle-orm/d1";

export type Variables = {
  user?: any;
  db: DrizzleD1Database<any>;
};
