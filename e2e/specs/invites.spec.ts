// e2e/specs/invites.spec.ts
// Covers: invite accept flow via fresh (unauthenticated) browser context,
// then verifies member inbox scoping against GET /api/stats.
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { BASE_URL } from "../support/login";

test.describe.serial("invite accept flow", () => {
  test.beforeAll(() => {
    truncateAndReseed();
  });

  // ── 1. Fresh-context invite acceptance ───────────────────────────────────────

  test("invitee accepts invite via fresh context", async ({
    api,
    browser,
    uniqueName,
  }) => {
    const inviteeEmail = `${uniqueName("invitee")}@e2e.test`;

    // Admin creates an invite for the invitee.
    const createRes = await api.post(`${BASE_URL}/api/admin/invites`, {
      data: { role: "member", email: inviteeEmail },
    });
    expect(
      createRes.ok(),
      `create invite returned ${createRes.status()}: ${await createRes.text()}`,
    ).toBeTruthy();
    const invite = (await createRes.json()) as { token: string };

    // Open a fresh context — override the project-wide admin storageState.
    const ctx = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const page = await ctx.newPage();
    try {
      await page.goto(`${BASE_URL}/invite/${invite.token}`);

      // Email field is pre-filled + disabled; fill Name + Password only.
      await page.getByLabel("Name").fill("Invitee One");
      await page.getByLabel("Password").fill("invitee-pw-123");

      await page.getByRole("button", { name: /create account/i }).click();

      // Wait until we've left the invite page.
      await page.waitForURL((url) => !url.pathname.startsWith("/invite/"), {
        timeout: 10_000,
      });

      // Dev branding disables the passkey gate, so we should land on "/".
      expect(new URL(page.url()).pathname).toBe("/");
    } finally {
      await ctx.close();
    }
  });

  // ── 2. Member sees only assigned inbox via /api/stats ────────────────────────

  test("member sees only assigned inbox", async ({
    api,
    browser,
    uniqueName,
  }) => {
    const inviteeEmail = `${uniqueName("invitee")}@e2e.test`;

    // Admin creates a second invite for a fresh member user.
    const createRes = await api.post(`${BASE_URL}/api/admin/invites`, {
      data: { role: "member", email: inviteeEmail },
    });
    expect(
      createRes.ok(),
      `create invite returned ${createRes.status()}: ${await createRes.text()}`,
    ).toBeTruthy();
    const invite = (await createRes.json()) as { token: string };

    // Fresh unauthenticated context so the invite-accept page sees no session.
    const ctx = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const page = await ctx.newPage();
    try {
      await page.goto(`${BASE_URL}/invite/${invite.token}`);
      await page.getByLabel("Name").fill("Invitee Two");
      await page.getByLabel("Password").fill("invitee-pw-456");
      await page.getByRole("button", { name: /create account/i }).click();

      await page.waitForURL((url) => !url.pathname.startsWith("/invite/"), {
        timeout: 10_000,
      });
      expect(new URL(page.url()).pathname).toBe("/");

      // Look up the newly-created user's id via the admin API.
      const usersRes = await api.get(`${BASE_URL}/api/admin/users`);
      expect(usersRes.ok()).toBeTruthy();
      const allUsers = (await usersRes.json()) as Array<{
        id: string;
        email: string;
      }>;
      const newUser = allUsers.find((u) => u.email === inviteeEmail);
      expect(
        newUser,
        `expected to find user ${inviteeEmail} in admin users list`,
      ).toBeDefined();
      const newUserId = newUser!.id;

      // Assign this user to support@e2e.test only — this endpoint replaces the
      // existing assignments, which is fine since the DB was just reseeded.
      const assignRes = await api.put(
        `${BASE_URL}/api/admin/inboxes/support@e2e.test/assignments`,
        { data: { userIds: [newUserId] } },
      );
      expect(
        assignRes.ok(),
        `assign returned ${assignRes.status()}: ${await assignRes.text()}`,
      ).toBeTruthy();

      // The page's request context inherits the cookies from the
      // browser-side signIn.email call that InviteAcceptPage performed.
      const statsRes = await ctx.request.get(`${BASE_URL}/api/stats`);
      const statsBody = await statsRes.text();
      expect(
        statsRes.ok(),
        `stats returned ${statsRes.status()}: ${statsBody}`,
      ).toBeTruthy();
      const stats = JSON.parse(statsBody) as { recipients: string[] };

      expect(stats.recipients).toContain("support@e2e.test");
      expect(stats.recipients).not.toContain("marketing@e2e.test");
    } finally {
      await ctx.close();
    }
  });
});
