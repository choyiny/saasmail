// e2e/support/login.ts
import type { APIRequestContext } from "@playwright/test";

export const ADMIN = {
  name: "E2E Admin",
  email: "admin@e2e.test",
  password: "e2e-admin-pw",
} as const;

export const MEMBER = {
  name: "E2E Member",
  email: "member@e2e.test",
  password: "e2e-member-pw",
} as const;

export const BASE_URL = "http://localhost:8788";

/**
 * Creates the first admin user via POST /api/setup.
 * Only works when the DB has no users (returns 403 otherwise).
 * Body: { name, email, password }
 */
export async function createAdmin(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${BASE_URL}/api/setup`, {
    data: {
      name: ADMIN.name,
      email: ADMIN.email,
      password: ADMIN.password,
    },
  });
  if (!res.ok()) {
    const body = await res.text();
    throw new Error(
      `createAdmin: POST /api/setup failed with ${res.status()}: ${body}`,
    );
  }
}

/**
 * Logs in via BetterAuth email/password sign-in.
 * Endpoint: POST /api/auth/sign-in/email
 * Body: { email, password }
 * Cookies are persisted on the Playwright request context automatically.
 *
 * Note: On non-dev deployments this endpoint is blocked for users who have a
 * registered passkey (returns 403). In the e2e environment (wrangler dev), that
 * guard is skipped via isDevEnvironment(), so this works as expected.
 */
export async function loginViaApi(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<void> {
  const res = await request.post(`${BASE_URL}/api/auth/sign-in/email`, {
    data: { email, password },
    headers: { origin: BASE_URL },
  });
  if (!res.ok()) {
    const body = await res.text();
    throw new Error(
      `loginViaApi: POST /api/auth/sign-in/email failed with ${res.status()}: ${body}`,
    );
  }
}

/**
 * Creates an invitation as admin (POST /api/admin/invites), then accepts it
 * with the invitee request context (POST /api/invites/accept).
 *
 * Invite-create endpoint: POST /api/admin/invites
 *   Body: { role, email?, expiresInDays? }
 *   Note: the server has no concept of per-user inbox scoping at invite time;
 *   the inboxEmails param is accepted here for API symmetry but is not sent to
 *   the server (there is no corresponding server field).
 *
 * Invite-accept endpoint: POST /api/invites/accept
 *   Body: { token, name, email, password }
 */
export async function createAndAcceptInvite(
  adminRequest: APIRequestContext,
  inviteeRequest: APIRequestContext,
  params: {
    email: string;
    password: string;
    name: string;
    role: "admin" | "member";
    inboxEmails: string[];
  },
): Promise<void> {
  // Step 1: Admin creates the invite.
  // The server accepts: { role, email?, expiresInDays? }
  // inboxEmails has no server-side field — inbox access is managed separately.
  const createRes = await adminRequest.post(`${BASE_URL}/api/admin/invites`, {
    data: {
      role: params.role,
      email: params.email,
    },
  });
  if (!createRes.ok()) {
    const body = await createRes.text();
    throw new Error(
      `createAndAcceptInvite: POST /api/admin/invites failed with ${createRes.status()}: ${body}`,
    );
  }
  const invite = (await createRes.json()) as { token: string };

  // Step 2: Invitee accepts the invite.
  // Body: { token, name, email, password }
  const acceptRes = await inviteeRequest.post(
    `${BASE_URL}/api/invites/accept`,
    {
      data: {
        token: invite.token,
        name: params.name,
        email: params.email,
        password: params.password,
      },
    },
  );
  if (!acceptRes.ok()) {
    const body = await acceptRes.text();
    throw new Error(
      `createAndAcceptInvite: POST /api/invites/accept failed with ${acceptRes.status()}: ${body}`,
    );
  }
}
