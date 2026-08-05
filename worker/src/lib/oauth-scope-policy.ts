/**
 * Which scope each `/api/*` route requires of an OAuth bearer caller.
 *
 * This applies **only** to `authMethod === "oauth"`. Session and API-key
 * callers hold the user's whole surface and are deliberately unscoped; nothing
 * here changes what they can do.
 *
 * Two rules make it safe:
 *
 *  1. **Classify on method plus exact path, not on router prefix.** Three
 *     routes send mail from under a router whose other routes do not:
 *     `POST /api/email-templates/{slug}/send`, `POST /api/sequences/{id}/enroll`
 *     and `POST /api/outbox/{id}/retry`. A prefix table would file all three as
 *     `email:manage`, letting a client that was never granted `email:send` send
 *     mail.
 *
 *  2. **Unmatched means denied.** A route added later is refused to OAuth
 *     callers until someone classifies it, so the failure mode of forgetting is
 *     a broken integration rather than a silent grant.
 *
 * The account and credential surface is denied outright at any scope. The
 * sharpest case is `POST /api/api-keys`, which mints an unscoped key carrying
 * the user's full API surface: honouring it for a client that asked only to
 * read mail would convert a narrow consent into total account access, and would
 * also delete whatever key the user already had.
 */
import {
  SCOPE_READ,
  SCOPE_SEND,
  SCOPE_MANAGE,
  SCOPE_ADMIN,
} from "../auth/scopes";

export { SCOPE_ADMIN };

export type RouteClass =
  | { kind: "denied" }
  | { kind: "scope"; scope: string; requiresAdminRole?: boolean };

interface Rule {
  method: string | "*";
  pattern: RegExp;
  cls: RouteClass;
}

const denied: RouteClass = { kind: "denied" };
const read: RouteClass = { kind: "scope", scope: SCOPE_READ };
const send: RouteClass = { kind: "scope", scope: SCOPE_SEND };
const manage: RouteClass = { kind: "scope", scope: SCOPE_MANAGE };
const admin: RouteClass = {
  kind: "scope",
  scope: SCOPE_ADMIN,
  requiresAdminRole: true,
};

/**
 * First match wins, so the specific entries precede the general ones. The
 * send-from-elsewhere routes are listed first for exactly that reason.
 */
const RULES: Rule[] = [
  // --- credential and account surface: never reachable with a bearer token ---
  { method: "*", pattern: /^\/api\/api-keys(\/|$)/, cls: denied },
  { method: "*", pattern: /^\/api\/user\/passkeys(\/|$)/, cls: denied },
  { method: "*", pattern: /^\/api\/auth(\/|$)/, cls: denied },

  // --- operations a token must not perform even holding admin:manage ---
  //
  // These escalate the principal or open a standing channel, which is a
  // different risk from an admin performing them in a browser: a token is held
  // by software, may be compromised without anyone noticing, and acts with no
  // human present. `admin:manage` is for operating the deployment, not for
  // rewriting who may operate it.
  //
  // Assignments is the sharpest: it replaces `inbox_permissions` wholesale, so
  // a token could grant its own principal every inbox and then read all of it,
  // turning a scoped grant into unscoped access in one call.
  {
    method: "*",
    pattern: /^\/api\/admin\/inboxes\/[^/]+\/assignments$/,
    cls: denied,
  },
  { method: "*", pattern: /^\/api\/admin\/users\/[^/]+\/role$/, cls: denied },
  // Invites mint and display still-usable account-creation tokens, which may
  // carry the admin role.
  { method: "*", pattern: /^\/api\/admin\/invites(\/|$)/, cls: denied },
  // The OAuth client registry is auth surface; a client could revoke rivals.
  { method: "*", pattern: /^\/api\/oauth-apps(\/|$)/, cls: denied },
  // Writing the webhook destination points every future inbound message at an
  // address of the caller's choosing.
  { method: "PUT", pattern: /^\/api\/webhook$/, cls: denied },
  { method: "POST", pattern: /^\/api\/webhook\/test$/, cls: denied },
  // Setting `forwardTo` on an inbox installs a standing relay of all future
  // inbound mail. The same route also edits display name and signature, so
  // denying it costs a client the ability to rename an inbox — accepted,
  // because the two cannot be separated by path alone and the relay is the
  // more consequential of the pair.
  { method: "PATCH", pattern: /^\/api\/admin\/inboxes\/[^/]+$/, cls: denied },

  // --- routes that send mail, wherever they happen to live ---
  { method: "POST", pattern: /^\/api\/send$/, cls: send },
  { method: "POST", pattern: /^\/api\/send\/reply\/[^/]+$/, cls: send },
  {
    method: "POST",
    pattern: /^\/api\/email-templates\/[^/]+\/send$/,
    cls: send,
  },
  { method: "POST", pattern: /^\/api\/sequences\/[^/]+\/enroll$/, cls: send },
  { method: "POST", pattern: /^\/api\/outbox\/[^/]+\/retry$/, cls: send },

  // --- admin surface ---
  { method: "*", pattern: /^\/api\/admin(\/|$)/, cls: admin },
  { method: "*", pattern: /^\/api\/oauth-apps(\/|$)/, cls: admin },
  { method: "*", pattern: /^\/api\/suppressions(\/|$)/, cls: admin },
  { method: "*", pattern: /^\/api\/webhook(\/|$)/, cls: admin },
  // Global security state: block rules apply deployment-wide and the purge
  // route deletes mail across every inbox.
  { method: "*", pattern: /^\/api\/blocklist(\/|$)/, cls: admin },

  // --- the caller's own identity ---
  { method: "GET", pattern: /^\/api\/user\/me$/, cls: read },

  // --- notifications ---
  //
  // Self-scoped: every route here is constrained to the caller's own
  // subscriptions, so `email:read` covers both reading and managing them.
  //
  // Registering a push endpoint is, strictly, a channel the caller controls —
  // but it is also the entire point of the endpoint, and a client that can read
  // mail directly gains nothing by also being notified about it. What keeps
  // that true is the payload: it must stay a wake-up rather than a copy of the
  // message, so a subscription leaks that mail arrived, not what it said.
  { method: "*", pattern: /^\/api\/notifications(\/|$)/, cls: read },

  // --- reading mail and its surrounding objects ---
  //
  // The caller's own sending identities. Read-scoped rather than send-scoped
  // on purpose: this discloses which addresses the caller already controls, it
  // does not send anything, and a read-only client still needs it to label a
  // message with the inbox that received it.
  { method: "GET", pattern: /^\/api\/inboxes$/, cls: read },
  { method: "GET", pattern: /^\/api\/people(\/|$)/, cls: read },
  { method: "GET", pattern: /^\/api\/emails(\/|$)/, cls: read },
  { method: "GET", pattern: /^\/api\/conversations(\/|$)/, cls: read },
  { method: "GET", pattern: /^\/api\/attachments(\/|$)/, cls: read },
  { method: "GET", pattern: /^\/api\/outbox(\/|$)/, cls: read },
  { method: "GET", pattern: /^\/api\/stats$/, cls: read },
  { method: "GET", pattern: /^\/api\/email-templates(\/|$)/, cls: read },
  { method: "GET", pattern: /^\/api\/sequences(\/|$)/, cls: read },

  // --- mutating without sending ---
  { method: "*", pattern: /^\/api\/people(\/|$)/, cls: manage },
  { method: "*", pattern: /^\/api\/emails(\/|$)/, cls: manage },
  { method: "*", pattern: /^\/api\/conversations(\/|$)/, cls: manage },
  { method: "*", pattern: /^\/api\/email-templates(\/|$)/, cls: manage },
  { method: "*", pattern: /^\/api\/sequences(\/|$)/, cls: manage },
  { method: "*", pattern: /^\/api\/outbox(\/|$)/, cls: manage },
];

/**
 * Classify a request. Anything unmatched is denied — see rule 2 above.
 */
export function classifyRoute(method: string, path: string): RouteClass {
  const m = method.toUpperCase();
  for (const rule of RULES) {
    if (rule.method !== "*" && rule.method !== m) continue;
    if (rule.pattern.test(path)) return rule.cls;
  }
  return denied;
}

/** Exposed so a test can assert every documented operation is classified. */
export const SCOPE_RULES = RULES;
