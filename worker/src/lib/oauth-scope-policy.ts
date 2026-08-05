/**
 * What an OAuth bearer caller may reach under `/api/*`: which scope each route
 * requires, and which fields of a body a token may set on the routes where the
 * path alone does not settle it.
 *
 * This applies **only** to `authMethod === "oauth"`. Session and API-key
 * callers hold the user's whole surface and are deliberately unscoped; nothing
 * here changes what they can do.
 *
 * Three rules make it safe:
 *
 *  1. **Classify on method plus exact path, not on router prefix.** Three
 *     routes send mail from under a router whose other routes do not:
 *     `POST /api/email-templates/{slug}/send`, `POST /api/sequences/{id}/enroll`
 *     and `POST /api/outbox/{id}/retry`. A prefix table would file all three as
 *     `email:manage`, letting a client that was never granted `email:send` send
 *     mail.
 *
 *  2. **Unmatched means denied** — for a path in `RULES`, and equally for a
 *     field in `BODY_GUARDS`. Whatever is added later is refused to OAuth
 *     callers until someone classifies it, so the failure mode of forgetting is
 *     a broken integration rather than a silent grant.
 *
 *  3. **Refuse durable privilege and standing channels, and nothing else.** A
 *     route is closed to a token when it creates a privilege that survives
 *     revoking the client and expiring the token, or points a copy of future
 *     mail somewhere the caller chose. Sounding administrative is not the test:
 *     `DELETE /api/admin/users/{id}` and `DELETE /api/blocklist/mail` are open
 *     at `admin:manage` and destroy more than anything that used to be denied
 *     here, so a line drawn around the category rather than the damage was both
 *     too broad and too narrow.
 *
 * Under that rule two things stay closed outright:
 *
 *  - **`/api/api-keys`.** An `sk_` key authenticates as `authMethod: "apiKey"`,
 *    which skips this policy and `requirePasskey` entirely, never expires, and
 *    is not revoked by `DELETE /api/oauth-apps/{clientId}`. One call would buy
 *    permanent unscoped access, which is the definition of durable.
 *    `/api/user/passkeys` and `/api/auth/*` are the rest of that surface and go
 *    with it.
 *
 *  - **`GET /api/admin/invites`**, alone on the invites surface. It returns the
 *    token of every live invite, and an admin-role invite created in a browser
 *    need not pin an email, so reading that list can be as good as minting an
 *    admin account. Creating and revoking invites are open.
 *
 * Four more are reachable only in a shape that cannot escalate, and the clamp
 * rather than the classification is what makes them safe — see `BODY_GUARDS`.
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
 * send-from-elsewhere routes are listed first for exactly that reason, and the
 * invite-listing denial for the same one: it sits under `/api/admin`, so the
 * general admin rule would swallow it from one line lower.
 */
const RULES: Rule[] = [
  // --- credential surface: never reachable with a bearer token ---
  { method: "*", pattern: /^\/api\/api-keys(\/|$)/, cls: denied },
  { method: "*", pattern: /^\/api\/user\/passkeys(\/|$)/, cls: denied },
  { method: "*", pattern: /^\/api\/auth(\/|$)/, cls: denied },

  // Listing invites returns still-usable account-creation tokens, and an
  // admin-role invite need not pin an email — whoever reads that token becomes
  // an admin. Minting one is clamped to `role: "member"` instead of denied, but
  // no clamp can un-print a token a human already created in the browser.
  { method: "GET", pattern: /^\/api\/admin\/invites(\/|$)/, cls: denied },

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
  // Read-only inventory plus a revocation that destroys a capability rather
  // than creating one. Registration is open to any caller, so an operator's
  // view of who registered is the control that bounds it.
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

/**
 * A field of a guarded route's body. `"free"` may be set to anything; a
 * function returns the refusal for a value a token may not set, or null.
 */
type FieldRule = "free" | ((value: unknown) => string | null);

interface BodyGuard {
  method: string;
  pattern: RegExp;
  /**
   * Every field of the route's zod schema, classified. A field that is not
   * listed is refused, so this is the body-level counterpart of
   * `classifyRoute`'s trailing `return denied`: a field added to the schema
   * next year reaches bearer callers only once someone decides it should.
   */
  fields: Record<string, FieldRule>;
  /**
   * Fields whose *absence* would leave the clamp unenforced, checked as if the
   * caller had sent them undefined. A body with no `Content-Type` reaches the
   * route validator as `{}` and picks up the schema's defaults, so "omit it"
   * would otherwise be the way around a required field.
   */
  required?: readonly string[];
}

/** Long enough to accept an invite, short enough to outlive little else. */
const MAX_BEARER_INVITE_DAYS = 7;

/** Empty or null clears the field; anything else arms the channel. */
function clearOnly(refusal: string): FieldRule {
  return (value) =>
    value === null || (typeof value === "string" && value.trim() === "")
      ? null
      : refusal;
}

/**
 * The four routes whose path is safe and whose body is not. Each clamp exists
 * to remove the durable-privilege property that would otherwise close the
 * route, so weakening one re-opens the hole the denial used to cover.
 */
export const BODY_GUARDS: BodyGuard[] = [
  // Three clamps turn "mint an account-creation token" into "invite one named
  // person to be a member for a week": the invite cannot carry the admin role,
  // cannot be redeemed by anyone but the address it names (`POST
  // /api/invites/accept` rejects a mismatch), and expires inside the window a
  // compromised token is plausibly noticed in. Admin invites stay browser-only.
  {
    method: "POST",
    pattern: /^\/api\/admin\/invites$/,
    required: ["email"],
    fields: {
      role: (v) =>
        v === "member" ? null : "OAuth clients may only create member invites",
      email: (v) =>
        typeof v === "string" && v.trim() !== ""
          ? null
          : "OAuth clients must pin an invite to an email address",
      expiresInDays: (v) =>
        typeof v === "number" && v <= MAX_BEARER_INVITE_DAYS
          ? null
          : `OAuth clients may only create invites lasting ${MAX_BEARER_INVITE_DAYS} days or fewer`,
    },
  },
  // Demotion is de-privileging, and the account deletion it is a weaker form of
  // is already open at admin:manage. Promotion is the durable half.
  {
    method: "PATCH",
    pattern: /^\/api\/admin\/users\/[^/]+\/role$/,
    fields: {
      role: (v) =>
        v === "member"
          ? null
          : "OAuth clients may demote users but not promote them",
    },
  },
  // Renaming an inbox and setting its signature are ordinary admin work. The
  // one field here that is not is `forwardTo`, which installs a standing relay
  // of all future inbound mail. Clearing stays open, so an app keeps a kill
  // switch it can never use to arm.
  {
    method: "PATCH",
    pattern: /^\/api\/admin\/inboxes\/[^/]+$/,
    fields: {
      displayName: "free",
      displayMode: "free",
      signatureHtml: "free",
      forwardTo: clearOnly(
        "OAuth clients may clear an inbox's forwarding address but not set one",
      ),
    },
  },
  // The same split, and the sharper case: the webhook payload carries subject
  // and body text, so a URL set here copies every future inbound message to an
  // address of the caller's choosing — exfiltration without ever holding
  // `email:read`. Rotating or clearing the signing secret escalates nothing.
  {
    method: "PUT",
    pattern: /^\/api\/webhook$/,
    fields: {
      url: clearOnly("OAuth clients may clear the webhook URL but not set one"),
      secret: "free",
    },
  },
];

/**
 * Apply a route's body clamp, if it has one. Returns the refusal message, or
 * null when the body is one a bearer caller may send.
 *
 * `readBody` is a thunk because reading a body caches it on the request: doing
 * that for a route with no guard would leave the cached text as the only copy,
 * and a multipart send cannot be re-parsed from text alone.
 */
export async function guardBearerBody(
  method: string,
  path: string,
  readBody: () => Promise<unknown>,
): Promise<string | null> {
  const m = method.toUpperCase();
  const guard = BODY_GUARDS.find((g) => g.method === m && g.pattern.test(path));
  if (!guard) return null;

  const parsed = await readBody();
  const body: Record<string, unknown> =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};

  for (const name of Object.keys(body)) {
    if (!Object.hasOwn(guard.fields, name)) {
      return `OAuth clients may not set \`${name}\` on this route`;
    }
  }

  for (const [name, rule] of Object.entries(guard.fields)) {
    if (rule === "free") continue;
    const present = Object.hasOwn(body, name);
    if (!present && !guard.required?.includes(name)) continue;
    const refusal = rule(present ? body[name] : undefined);
    if (refusal) return refusal;
  }

  return null;
}
