import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
  getProfile,
  GoogleAuthError,
  GMAIL_SCOPES,
} from "../lib/gmail/oauth";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

function stubFetchNonJson(status: number, body: string) {
  const fn = vi.fn(
    async () =>
      new Response(body, {
        status,
        headers: { "content-type": "text/html" },
      }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("buildAuthUrl", () => {
  it("requests offline access and forces a refresh token", () => {
    const url = new URL(
      buildAuthUrl({
        clientId: "cid",
        redirectUri: "https://mail.example.com/api/admin/gmail/callback",
        state: "signed-state",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("scope")).toBe(GMAIL_SCOPES.join(" "));
  });

  it("pre-selects the mailbox being reconnected", () => {
    const url = new URL(
      buildAuthUrl({
        clientId: "cid",
        redirectUri: "https://mail.example.com/api/admin/gmail/callback",
        state: "signed-state",
        loginHint: "ops@example.com",
      }),
    );
    // The hint must be the mailbox, not the redirect or the client id — a
    // wrong argument here silently reopens the whichever-account-is-signed-in
    // path this parameter exists to close.
    expect(url.searchParams.get("login_hint")).toBe("ops@example.com");
  });

  it("omits login_hint for a first connection, where any account is valid", () => {
    const url = new URL(
      buildAuthUrl({
        clientId: "cid",
        redirectUri: "https://mail.example.com/api/admin/gmail/callback",
        state: "signed-state",
      }),
    );
    expect(url.searchParams.has("login_hint")).toBe(false);
  });

  it("requests only gmail.modify and gmail.send", () => {
    expect(GMAIL_SCOPES).toEqual([
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
    ]);
  });
});

describe("exchangeCode", () => {
  it("returns tokens on success", async () => {
    stubFetch(200, {
      access_token: "at-1",
      refresh_token: "rt-1",
      expires_in: 3599,
    });
    const tokens = await exchangeCode({
      code: "auth-code",
      clientId: "cid",
      clientSecret: "secret",
      redirectUri: "https://mail.example.com/cb",
    });
    expect(tokens).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresIn: 3599,
    });
  });

  it("raises GoogleAuthError with the reported code", async () => {
    stubFetch(400, { error: "invalid_grant" });
    await expect(
      exchangeCode({
        code: "stale",
        clientId: "cid",
        clientSecret: "secret",
        redirectUri: "https://mail.example.com/cb",
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("raises GoogleAuthError with invalid_response on non-JSON body", async () => {
    stubFetchNonJson(503, "<html><body>Service Unavailable</body></html>");
    const err = await exchangeCode({
      code: "auth-code",
      clientId: "cid",
      clientSecret: "secret",
      redirectUri: "https://mail.example.com/cb",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect(err.code).toBe("invalid_response");
  });
});

describe("refreshAccessToken", () => {
  it("returns a null refreshToken when Google omits one", async () => {
    stubFetch(200, { access_token: "at-2", expires_in: 3599 });
    const tokens = await refreshAccessToken({
      refreshToken: "rt-1",
      clientId: "cid",
      clientSecret: "secret",
    });
    expect(tokens.accessToken).toBe("at-2");
    expect(tokens.refreshToken).toBeNull();
  });

  it("surfaces a revoked grant as invalid_grant", async () => {
    stubFetch(400, { error: "invalid_grant" });
    const err = await refreshAccessToken({
      refreshToken: "revoked",
      clientId: "cid",
      clientSecret: "secret",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect(err.code).toBe("invalid_grant");
  });
});

describe("getProfile", () => {
  it("returns the mailbox address and seed historyId", async () => {
    const fetchFn = stubFetch(200, {
      emailAddress: "collector@xyspace.dev",
      historyId: "98765",
    });
    const profile = await getProfile("at-1");
    expect(profile).toEqual({
      emailAddress: "collector@xyspace.dev",
      historyId: "98765",
    });
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    );
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer at-1",
    });
  });

  it("raises GoogleAuthError with invalid_response on non-JSON body", async () => {
    stubFetchNonJson(200, "<html><body>Service Unavailable</body></html>");
    const err = await getProfile("at-1").catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect(err.code).toBe("invalid_response");
  });
});
