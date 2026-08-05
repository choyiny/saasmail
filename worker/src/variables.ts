import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { AllowedInboxes } from "./lib/inbox-permissions";

export type Variables = {
  user?: any;
  db: DrizzleD1Database<any>;
  allowedInboxes?: AllowedInboxes;
  // How the current request was authenticated. Used by middleware to decide
  // whether to enforce passkey checks (apiKey requests bypass, since issuance
  // itself is gated on passkey presence; oauth requests bypass because the
  // token resolver already checked, rather than because they are exempt).
  authMethod?: "session" | "apiKey" | "oauth";
  /**
   * Scopes carried by an OAuth access token. Only set when
   * `authMethod === "oauth"` — session and API-key callers hold the user's full
   * surface and are deliberately unscoped, so an undefined value here must
   * never be read as "no permissions".
   */
  oauthScopes?: string[];
  /** The OAuth client the token was issued to, for auditing and revocation. */
  oauthClientId?: string;
};
