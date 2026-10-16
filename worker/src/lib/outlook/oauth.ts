/**
 * Microsoft identity platform (v2) OAuth for connecting an Outlook mailbox.
 *
 * The flow mirrors Gmail's (`lib/gmail/oauth.ts`): authorization code with a
 * signed `state`, offline access for a refresh token, and a profile read to
 * learn which mailbox was granted. Two differences matter:
 *
 *   - The authority is per tenant. "common" lets any work, school or personal
 *     Microsoft account sign in; an admin can pin a directory instead.
 *   - Microsoft ROTATES refresh tokens. A refresh usually returns a new one,
 *     and the caller must store it (see `token.ts`).
 */

const GRAPH = "https://graph.microsoft.com/v1.0";

export const OUTLOOK_SCOPES = [
  "offline_access",
  "openid",
  "email",
  "https://graph.microsoft.com/User.Read",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
] as const;

export type MicrosoftTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
};

export class MicrosoftAuthError extends Error {
  constructor(
    /**
     * The token endpoint's `error` (`invalid_grant`, `invalid_client`, …) or
     * one of our own codes. A code, never free text: it reaches logs and the
     * account row.
     */
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "MicrosoftAuthError";
  }
}

/** The authority segment: a tenant id or domain, or "common". */
function authority(tenant: string | null): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant || "common")}/oauth2/v2.0`;
}

export function buildAuthUrl(opts: {
  clientId: string;
  tenant: string | null;
  redirectUri: string;
  state: string;
  /** The mailbox being reconnected, pre-selected at sign-in. Only a hint. */
  loginHint?: string;
}): string {
  const url = new URL(`${authority(opts.tenant)}/authorize`);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", OUTLOOK_SCOPES.join(" "));
  // Always show the account picker: a silently reused session would connect
  // whichever mailbox the browser happens to be signed in to.
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("state", opts.state);
  if (opts.loginHint) url.searchParams.set("login_hint", opts.loginHint);
  return url.toString();
}

async function postToken(
  tenant: string | null,
  body: URLSearchParams,
): Promise<MicrosoftTokens> {
  const res = await fetch(`${authority(tenant)}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  let payload: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    throw new MicrosoftAuthError(
      "invalid_response",
      `Microsoft token endpoint returned ${res.status} with non-JSON body`,
    );
  }
  if (!res.ok || !payload.access_token) {
    throw new MicrosoftAuthError(
      payload.error ?? "token_request_failed",
      // Microsoft's descriptions carry trace ids and timestamps, not secrets.
      payload.error_description?.split("\r\n")[0] ??
        `Microsoft token endpoint returned ${res.status}`,
    );
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresIn: payload.expires_in ?? 3600,
  };
}

export function exchangeCode(opts: {
  code: string;
  clientId: string;
  clientSecret: string;
  tenant: string | null;
  redirectUri: string;
}): Promise<MicrosoftTokens> {
  return postToken(
    opts.tenant,
    new URLSearchParams({
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
      grant_type: "authorization_code",
      scope: OUTLOOK_SCOPES.join(" "),
    }),
  );
}

export function refreshAccessToken(opts: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  tenant: string | null;
}): Promise<MicrosoftTokens> {
  return postToken(
    opts.tenant,
    new URLSearchParams({
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      grant_type: "refresh_token",
      scope: OUTLOOK_SCOPES.join(" "),
    }),
  );
}

/**
 * The granted mailbox's addresses. `emailAddress` is its primary SMTP
 * address — `mail`, or the sign-in name for a personal account, which often
 * has no `mail`. `aliases` are the other addresses it can receive at (work
 * accounts list them in `proxyAddresses`), lowercased; mapping an inbox to
 * one of them is allowed.
 */
export async function getProfile(
  accessToken: string,
): Promise<{ emailAddress: string; aliases: string[] }> {
  const res = await fetch(
    `${GRAPH}/me?$select=mail,userPrincipalName,proxyAddresses`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    throw new MicrosoftAuthError(
      "profile_request_failed",
      `Microsoft Graph /me returned ${res.status}`,
    );
  }
  let payload: {
    mail?: string | null;
    userPrincipalName?: string | null;
    proxyAddresses?: string[] | null;
  };
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    throw new MicrosoftAuthError(
      "invalid_response",
      `Microsoft Graph /me returned ${res.status} with non-JSON body`,
    );
  }
  const primary = (payload.mail || payload.userPrincipalName || "")
    .trim()
    .toLowerCase();
  if (!primary.includes("@")) {
    throw new MicrosoftAuthError(
      "no_mailbox",
      "This Microsoft account has no mailbox address.",
    );
  }
  const aliases = (payload.proxyAddresses ?? [])
    .filter((p) => /^smtp:/i.test(p))
    .map((p) => p.slice(5).trim().toLowerCase())
    .filter((a) => a && a !== primary);
  return { emailAddress: primary, aliases: [...new Set(aliases)] };
}
