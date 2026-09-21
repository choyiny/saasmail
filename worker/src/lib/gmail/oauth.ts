const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const PROFILE_ENDPOINT =
  "https://gmail.googleapis.com/gmail/v1/users/me/profile";

/**
 * gmail.modify covers reading messages and marking them read; gmail.send
 * covers replying. Both are restricted scopes, which is why the operator's
 * OAuth consent screen must be Internal — see the spec.
 */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
] as const;

export type GoogleTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
};

export class GoogleAuthError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

export function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SCOPES.join(" "));
  // offline + consent together are what actually yield a refresh token:
  // Google omits it on repeat authorisations without prompt=consent.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", opts.state);
  return url.toString();
}

async function postToken(body: URLSearchParams): Promise<GoogleTokens> {
  const res = await fetch(TOKEN_ENDPOINT, {
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
    throw new GoogleAuthError(
      "invalid_response",
      `Google token endpoint returned ${res.status} with non-JSON body`,
    );
  }
  if (!res.ok || !payload.access_token) {
    throw new GoogleAuthError(
      payload.error ?? "token_request_failed",
      payload.error_description ??
        `Google token endpoint returned ${res.status}`,
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
  redirectUri: string;
}): Promise<GoogleTokens> {
  return postToken(
    new URLSearchParams({
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
      grant_type: "authorization_code",
    }),
  );
}

export function refreshAccessToken(opts: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<GoogleTokens> {
  return postToken(
    new URLSearchParams({
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      grant_type: "refresh_token",
    }),
  );
}

/**
 * Identifies which mailbox was just connected and supplies the seed history
 * cursor in the same call, so connecting costs one request rather than two.
 */
export async function getProfile(
  accessToken: string,
): Promise<{ emailAddress: string; historyId: string }> {
  const res = await fetch(PROFILE_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new GoogleAuthError(
      "profile_request_failed",
      `Gmail profile endpoint returned ${res.status}`,
    );
  }
  let payload: {
    emailAddress: string;
    historyId: string;
  };
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    throw new GoogleAuthError(
      "invalid_response",
      `Gmail profile endpoint returned ${res.status} with non-JSON body`,
    );
  }
  return {
    emailAddress: payload.emailAddress,
    historyId: String(payload.historyId),
  };
}
