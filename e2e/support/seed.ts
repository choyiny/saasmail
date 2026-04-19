import type { APIRequestContext, APIResponse } from "@playwright/test";

async function expectOk(res: APIResponse, label: string): Promise<unknown> {
  if (!res.ok())
    throw new Error(`${label} failed: ${res.status()} ${await res.text()}`);
  return res.json();
}

/**
 * POST /api/admin/inboxes
 * Body: { email, displayName?, displayMode? }
 * Returns 201 with the created inbox row.
 * Note: displayMode defaults to "thread" on the server if omitted.
 */
export async function createInbox(
  api: APIRequestContext,
  params: {
    email: string;
    displayName?: string | null;
    displayMode?: "thread" | "chat";
  },
): Promise<unknown> {
  const res = await api.post("/api/admin/inboxes", { data: params });
  return expectOk(res, `createInbox(${params.email})`);
}

/**
 * POST /api/email-templates
 * Body: { slug, name, subject, bodyHtml, fromAddress? }
 * Returns 201 with the created template.
 * Note: slug must match /^[a-z0-9-]+$/. fromAddress is required for non-admin users.
 */
export async function createTemplate(
  api: APIRequestContext,
  params: {
    slug: string;
    name: string;
    subject: string;
    bodyHtml: string;
    fromAddress?: string | null;
  },
): Promise<unknown> {
  const res = await api.post("/api/email-templates", { data: params });
  return expectOk(res, `createTemplate(${params.slug})`);
}

/**
 * POST /api/sequences
 * Body: { name, steps: Array<{ order, templateSlug, delayHours }> }
 * Returns 201 with the created sequence.
 *
 * DEVIATION from plan: plan described steps as `Array<{ templateSlug, delayDays }>`,
 * but the actual schema uses `delayHours` (integer, min 0) and requires an `order`
 * field (integer, min 1). There is no `delayDays` field in the router.
 */
export async function createSequence(
  api: APIRequestContext,
  params: {
    name: string;
    steps: Array<{
      order: number;
      templateSlug: string;
      delayHours: number;
    }>;
  },
): Promise<unknown> {
  const res = await api.post("/api/sequences", { data: params });
  return expectOk(res, `createSequence(${params.name})`);
}

/**
 * POST /api/sequences/:id/enroll
 * Body: { personEmail OR personId, fromAddress, variables?, skipSteps?, delayOverrides? }
 * Returns 201 with { enrollment, scheduledEmails }.
 * Note: either personId or personEmail must be provided (server enforces this).
 */
export async function enrollContact(
  api: APIRequestContext,
  sequenceId: string,
  params: {
    personEmail?: string;
    personId?: string;
    fromAddress: string;
    variables?: Record<string, string>;
    skipSteps?: number[];
    delayOverrides?: Record<string, number>;
  },
): Promise<unknown> {
  const res = await api.post(`/api/sequences/${sequenceId}/enroll`, {
    data: params,
  });
  return expectOk(res, `enrollContact(sequence=${sequenceId})`);
}

/**
 * POST /api/api-keys
 * No request body — generates (or regenerates) the authenticated user's API key.
 * Returns 201 with { key, prefix, createdAt }.
 * Note: in non-dev environments the user must have a passkey registered first.
 * In the e2e dev environment (wrangler dev) this guard is skipped.
 */
export async function createApiKey(api: APIRequestContext): Promise<unknown> {
  const res = await api.post("/api/api-keys");
  return expectOk(res, "createApiKey");
}

/**
 * POST /api/admin/invites
 * Body: { role, email?, expiresInDays? }
 * Returns 201 with the created invite including the token.
 * Matches the helper already verified in login.ts (createAndAcceptInvite).
 */
export async function createInvite(
  api: APIRequestContext,
  params: {
    role: "admin" | "member";
    email?: string;
    expiresInDays?: number;
  },
): Promise<{
  token: string;
  id: string;
  role: string;
  email: string | null;
  expiresAt: number;
}> {
  const res = await api.post("/api/admin/invites", { data: params });
  return expectOk(res, `createInvite(role=${params.role})`) as Promise<{
    token: string;
    id: string;
    role: string;
    email: string | null;
    expiresAt: number;
  }>;
}
