// e2e/specs/reply-to-header.spec.ts
// Covers: a received message whose sender asked for replies at another
// address (Reply-To). The reading pane names that address, the reply composer
// says where the reply will go, and the user can answer the sender instead.
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/test";
import { execLocalSql, truncateAndReseed } from "../support/reset-db";
import { TEST_IDS } from "../support/selectors";

const REPLY_TO = "helpdesk@customers.test";
const SENDER = "mailbox@customers.test";

async function openReply(page: Page) {
  await page.goto("/mail/support%40e2e.test/inbox");
  await page
    .getByTestId(TEST_IDS.mailMessageRow)
    .filter({ hasText: "Mailbox fixture message" })
    .first()
    .click();
  await expect(page.getByTestId("mail-reading-reply-to")).toHaveText(
    `Reply-To: Help Desk <${REPLY_TO}>`,
  );

  await page.getByRole("button", { name: "Reply", exact: true }).click();
  const composer = page.getByTestId(TEST_IDS.replyComposer);
  await expect(composer.getByTestId("reply-to-hint")).toContainText(
    `Replies go to ${REPLY_TO} (the sender asked for replies there)`,
  );
  return composer;
}

async function sendReply(page: Page, text: string) {
  const composer = page.getByTestId(TEST_IDS.replyComposer);
  await composer.locator(".ProseMirror").click();
  await page.keyboard.type(text);
  const responsePromise = page.waitForResponse(
    (res) =>
      res.url().includes("/api/send/reply/") &&
      res.request().method() === "POST",
  );
  await page.getByTestId(TEST_IDS.replySendButton).click();
  const response = await responsePromise;
  expect(response.ok()).toBeTruthy();
  await expect(composer).not.toBeVisible();
  return (await response.json()) as { to: string; repliedTo: string };
}

test.describe.serial("replies follow Reply-To", () => {
  test.beforeEach(() => {
    truncateAndReseed();
    execLocalSql(
      `UPDATE emails SET reply_to = '[{"email":"${REPLY_TO}","name":"Help Desk"}]' WHERE id = 'e_mailbox_1'`,
    );
  });

  test("a reply goes to the Reply-To address by default", async ({ page }) => {
    const composer = await openReply(page);
    await expect(composer.getByTestId("reply-to-address")).toHaveText(REPLY_TO);

    const sent = await sendReply(page, "Answering where you asked.");
    expect(sent.to).toBe(REPLY_TO);
    expect(sent.repliedTo).toBe("reply_to");
  });

  test("the user can answer the sender instead", async ({ page }) => {
    const composer = await openReply(page);
    await composer.getByLabel("Reply to the sender instead").check();
    await expect(composer.getByTestId("reply-to-hint")).toContainText(
      "This reply is addressed to the sender",
    );
    await expect(composer.getByTestId("reply-to-address")).toContainText(
      SENDER,
    );

    const sent = await sendReply(page, "Answering the sender.");
    expect(sent.to).toBe(SENDER);
    expect(sent.repliedTo).toBe("sender");
  });
});
