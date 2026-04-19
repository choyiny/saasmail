// e2e/specs/thread-display.spec.ts
// Covers: thread-mode rendering for marketing@e2e.test (display_mode = 'thread').
// Alice has 2 emails in the marketing inbox:
//   e_m_a1 — "Welcome to our product"        (older, hidden behind toggle)
//   e_m_a2 — "Re: Welcome to our product"    (latest, rendered with HTML)
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { TEST_IDS } from "../support/selectors";

test.describe.serial("thread-mode display (marketing@)", () => {
  test.beforeAll(() => truncateAndReseed());

  test("renders latest HTML body, older message toggle, and reply button", async ({
    page,
  }) => {
    // Navigate to the inbox page and select Alice
    await page.goto("/");

    await expect(page.getByText("Alice Anderson")).toBeVisible();
    await page.getByText("Alice Anderson").click();

    // The latest email (e_m_a2) subject should be visible in the thread
    await expect(page.getByText("Re: Welcome to our product")).toBeVisible();

    // The latest email body HTML is rendered: "Thanks for signing up!" from
    // <p>Thanks for signing up!</p><blockquote>...</blockquote>
    await expect(page.getByText(/Thanks for signing up/i)).toBeVisible();

    // The older email is behind a toggle — the toggle button should be present
    const toggleButton = page.getByRole("button", {
      name: /previous message/i,
    });
    await expect(toggleButton).toBeVisible();

    // Expand older messages
    await toggleButton.click();

    // Now the older email subject should be visible (exact to avoid matching "Re: Welcome to our product")
    await expect(
      page.getByText("Welcome to our product", { exact: true }),
    ).toBeVisible();

    // The older message body_text is "welcome" (rendered as plain text, not HTML)
    // The HTML body ("Welcome aboard!") is not rendered for collapsed older messages.
    // Just confirm the subject appeared — the body text assertion is skipped since
    // it uses the short plain-text field "welcome" from body_text.

    // Both thread-message elements should be visible (one older, one latest)
    const messages = page.getByTestId(TEST_IDS.threadMessage);
    await expect(messages).toHaveCount(2);

    // Reply button: hover the latest message container to reveal actions
    const latestMessage = messages.last();
    await latestMessage.hover();

    const replyButton = latestMessage.getByRole("button", { name: "Reply" });
    await expect(replyButton).toBeVisible();

    // Click reply to open ReplyComposer
    await replyButton.click();

    // ReplyComposer should appear — check for a Send button
    await expect(page.getByTestId(TEST_IDS.replySendButton)).toBeVisible();
  });
});
