// e2e/specs/inbox-state.spec.ts
// Covers: one archive, everywhere. Archiving a row in the inbox list writes
// the per-message state that /mail reads too (docs/mailbox-state.md § Rows in
// the inbox list): the row leaves Inbox and shows in Archive, the message
// shows in /mail's Archive folder, and Undo puts it back in both Inboxes.
//
// Seed gives us p_mailbox, whose two messages to support@e2e.test include
// "Mailbox fixture message".
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { TEST_IDS } from "../support/selectors";

const SUBJECT = "Mailbox fixture message";

function row(page: Page) {
  return page.locator(
    `[data-testid="${TEST_IDS.personRow}"][data-person-id="p_mailbox"]`,
  );
}

function mailRow(page: Page) {
  return page
    .getByTestId(TEST_IDS.mailMessageRow)
    .filter({ hasText: SUBJECT })
    .first();
}

test.describe.serial("inbox row state", () => {
  test.beforeAll(() => truncateAndReseed());

  test("archive in the inbox list shows in /mail, and Undo restores both", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    await expect(row(page)).toBeVisible();
    await row(page).hover();
    // The hover bar sits next to the row, not inside it.
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(row(page)).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();

    // A second tab checks the other views while this one keeps its Undo.
    const other = await context.newPage();
    await other.goto("/?folder=archive");
    await expect(row(other)).toBeVisible();
    await other.goto("/mail/support%40e2e.test/archive");
    await expect(mailRow(other)).toBeVisible();

    // "z" undoes the most recent change, toast or not.
    await page.bringToFront();
    await page.keyboard.press("z");
    await expect(row(page)).toBeVisible();

    await other.goto("/mail/support%40e2e.test/inbox");
    await expect(mailRow(other)).toBeVisible();
    await other.goto("/mail/support%40e2e.test/archive");
    await expect(
      other.getByTestId(TEST_IDS.mailMessageRow).filter({ hasText: SUBJECT }),
    ).toHaveCount(0);
    await other.close();
  });
});
