// e2e/specs/shell-navigation.spec.ts
// Covers, in each layout (default, Gmail-style, Outlook-style): the
// navigation reaching the fork's own pages, the agent toggle and Ctrl+J,
// the sending-paused banner, and the person view by its deep links.
//
// Seed gives us Alice (p_alice) and Bob (p_bob) in support@ and marketing@,
// and Mailbox Fixture (p_mailbox) in support@.
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";

const LAYOUTS = ["default", "gmail", "outlook"] as const;
type Layout = (typeof LAYOUTS)[number];

/** The fork's pages and what each shows once it has loaded. */
const FORK_PAGES: Array<{ label: string; path: string; heading?: string }> = [
  { label: "Mail", path: "/mail" },
  { label: "Lists", path: "/lists", heading: "Lists" },
  { label: "Campaigns", path: "/campaigns", heading: "Campaigns" },
  { label: "Automations", path: "/automations", heading: "Automations" },
  { label: "Audit log", path: "/admin/audit", heading: "Audit log" },
  { label: "Contact data", path: "/admin/contacts", heading: "Contact data" },
];

/** Open the grouped inbox in a layout; `?ui=` sticks for the tab. */
async function openLayout(page: Page, layout: Layout) {
  await page.goto(`/?ui=${layout}`);
  await expect(page.locator("html")).toHaveAttribute("data-ui", layout);
}

/** Use the layout's own navigation to reach a page by its label. */
async function navigateTo(page: Page, layout: Layout, label: string) {
  if (layout === "default") {
    await page
      .getByTestId("portal-rail")
      .getByRole("link", { name: label, exact: true })
      .click();
  } else if (layout === "gmail") {
    await page.getByTestId("gmail-apps").click();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
  } else {
    await page.getByRole("button", { name: "App launcher" }).click();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
  }
}

/**
 * The open conversation: the person's heading (default layout) or a
 * message header naming them (Gmail and Outlook show the thread).
 */
function personView(page: Page, name: string, email: string) {
  return page
    .getByRole("heading", { name, exact: true })
    .or(page.getByRole("article").filter({ hasText: email }))
    .first();
}

test.describe.serial("shell navigation", () => {
  test.beforeAll(() => truncateAndReseed());

  for (const layout of LAYOUTS) {
    test.describe(`${layout} layout`, () => {
      test("the navigation reaches each of the fork's pages", async ({
        page,
      }) => {
        await openLayout(page, layout);
        for (const p of FORK_PAGES) {
          await navigateTo(page, layout, p.label);
          await expect(page).toHaveURL(new RegExp(`${p.path}(\\?|#|$)`));
          if (p.heading) {
            await expect(
              page.getByRole("heading", { name: p.heading, exact: true }),
            ).toBeVisible();
          } else {
            // /mail: the fork's own mailbox with its folders.
            await expect(page.getByTestId("mail-folder-inbox")).toBeVisible();
          }
        }
      });

      test("the agent toggle and Ctrl+J open the mail agent", async ({
        page,
      }) => {
        await page.route("**/api/agent/status", (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              configured: false,
              provider: null,
              model: null,
            }),
          }),
        );
        await openLayout(page, layout);
        const toggle = page.getByRole("button", { name: /^Toggle mail agent/ });
        await expect(toggle).toHaveAttribute("aria-pressed", "false");

        await page.keyboard.press("Control+j");
        await expect(toggle).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByTestId("agent-not-configured")).toBeVisible();

        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-pressed", "false");
        await expect(page.getByTestId("agent-not-configured")).toBeHidden();
      });

      test("the sending-paused banner shows while sending is paused", async ({
        page,
        api,
      }) => {
        const paused = await api.patch("/api/admin/settings", {
          data: { outboundPaused: true },
        });
        expect(paused.ok()).toBe(true);
        try {
          await openLayout(page, layout);
          await expect(page.getByTestId("sending-paused-banner")).toBeVisible();
        } finally {
          const resumed = await api.patch("/api/admin/settings", {
            data: { outboundPaused: false },
          });
          expect(resumed.ok()).toBe(true);
        }
      });

      test("a person opens by /inbox/:inbox/:personId and by /m/:emailId", async ({
        page,
      }) => {
        await openLayout(page, layout);
        await page.goto("/inbox/support%40e2e.test/p_alice");
        await expect(
          personView(page, "Alice Anderson", "alice@customers.test"),
        ).toBeVisible();

        await page.goto("/m/e_s_b1");
        await expect(page).toHaveURL(/\/inbox\/support(%40|@)e2e\.test\/p_bob/);
        await expect(
          personView(page, "Bob Brown", "bob@customers.test"),
        ).toBeVisible();
      });
    });
  }
});
