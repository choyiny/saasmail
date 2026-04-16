import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { AllowedInboxes } from "./lib/inbox-permissions";

export type Variables = {
  user?: any;
  db: DrizzleD1Database<any>;
  allowedInboxes?: AllowedInboxes;
};
