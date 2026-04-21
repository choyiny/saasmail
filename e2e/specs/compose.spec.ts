// e2e/specs/compose.spec.ts
// Covers: compose (Compose modal) + reply (ReplyComposer) in DEMO_MODE.
// Asserts demo_ resendId returned from /api/send and /api/send/reply/:emailId,
// and that an empty-body compose send is blocked (Send button disabled).
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { TEST_IDS } from "../support/selectors";
import { BASE_URL } from "../support/login";

test.describe.serial("compose & send", () => {
  // Re-seed before every test: test 1 ("compose modal sends email") adds a
  // new sent email to Alice's marketing@ inbox, which would shift test 2's
  // `getByTestId('thread-message').last()` onto that sent email (no Reply
  // button). A fresh seed per test keeps each case independent.
  test.beforeEach(() => truncateAndReseed());

  // ── 1. Compose modal: sends email in DEMO_MODE, records demo_ resendId ──────

  test("compose modal sends email in DEMO_MODE, resendId starts with demo_", async ({
    page,
    api,
  }) => {
    await page.goto("/");

    // Wait for the inbox page to finish loading
    await expect(page.getByText("Alice Anderson")).toBeVisible();

    // Click Compose button in sidebar
    await page.getByRole("button", { name: "Compose" }).click();

    // Wait for the compose dialog to open
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Compose" }),
    ).toBeVisible();

    // Fill in To field
    await dialog.getByLabel("To").fill("alice@customers.test");

    // Fill in Subject
    await dialog.getByLabel("Subject").fill("E2E compose subject");

    // Fill in body via ProseMirror (TipTap contenteditable)
    const proseMirror = dialog.locator(".ProseMirror");
    await proseMirror.click();
    await page.keyboard.type("Hello from E2E compose test");

    // Capture the send response before clicking
    const sendResponsePromise = page.waitForResponse(
      (res) =>
        res.url().includes("/api/send") &&
        !res.url().includes("/reply/") &&
        res.request().method() === "POST",
    );

    // Send button should be enabled now (body is filled)
    const sendButton = dialog.getByTestId(TEST_IDS.composeSendButton);
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    const sendResponse = await sendResponsePromise;
    expect(sendResponse.ok()).toBeTruthy();

    const body = (await sendResponse.json()) as {
      id: string;
      resendId: string | null;
      status: string;
    };
    expect(body.resendId).toMatch(/^demo_/);
    expect(body.status).toBe("sent");

    // Dialog should close after successful send
    await expect(dialog).not.toBeVisible();

    // Confirm via backend: the sent email appears in alice's email list
    const emailsRes = await api.get(`${BASE_URL}/api/emails/by-person/p_alice`);
    expect(emailsRes.ok()).toBeTruthy();
    const payload = (await emailsRes.json()) as {
      emails: Array<{ type: string; id: string; subject: string | null }>;
    };
    const sentEmail = payload.emails.find(
      (e) => e.type === "sent" && e.subject === "E2E compose subject",
    );
    expect(sentEmail).toBeTruthy();
  });

  // ── 2. Reply composer: sends reply in DEMO_MODE, resendId starts with demo_ ──

  test("reply composer sends reply in DEMO_MODE, resendId starts with demo_", async ({
    page,
  }) => {
    await page.goto("/");

    // Select alice from PersonList
    await expect(page.getByText("Alice Anderson")).toBeVisible();
    await page.getByText("Alice Anderson").click();

    // Wait for her emails to load in the right panel
    // The latest marketing@ email is e_m_a2 "Re: Welcome to our product"
    // MessageBubble renders with a Reply button hidden behind group-hover
    // Hover the email container to reveal the button
    const emailContainer = page.getByTestId(TEST_IDS.threadMessage).last();

    await emailContainer.hover();
    const replyButton = emailContainer.getByRole("button", { name: "Reply" });
    await expect(replyButton).toBeVisible();
    await replyButton.click();

    // ReplyComposer should appear — verify via "Freeform" tab
    const freeformTab = page.getByRole("button", { name: "Freeform" });
    await expect(freeformTab).toBeVisible();

    // Type reply body in the ProseMirror inside the reply composer
    const proseMirror = page
      .getByTestId(TEST_IDS.replyComposer)
      .locator(".ProseMirror");
    await proseMirror.click();
    await page.keyboard.type("This is a reply from E2E test");

    // Capture the reply response
    const replyResponsePromise = page.waitForResponse(
      (res) =>
        res.url().includes("/api/send/reply/") &&
        res.request().method() === "POST",
    );

    // Click Send in ReplyComposer
    const replySendButton = page.getByTestId(TEST_IDS.replySendButton);
    await expect(replySendButton).toBeVisible();
    await replySendButton.click();

    const replyResponse = await replyResponsePromise;
    expect(replyResponse.ok()).toBeTruthy();

    const body = (await replyResponse.json()) as {
      id: string;
      resendId: string | null;
      status: string;
    };
    expect(body.resendId).toMatch(/^demo_/);
    expect(body.status).toBe("sent");

    // ReplyComposer should close (Freeform tab disappears)
    await expect(freeformTab).not.toBeVisible();
  });

  // ── 3. Empty body → Send button is disabled ──────────────────────────────────

  test("compose modal Send button is disabled when body is empty", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText("Alice Anderson")).toBeVisible();

    // Open Compose
    await page.getByRole("button", { name: "Compose" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Fill in To and Subject but leave body empty
    await dialog.getByLabel("To").fill("alice@customers.test");
    await dialog.getByLabel("Subject").fill("Empty body test");

    // The Send button should be disabled while body is empty
    const sendButton = dialog.getByTestId(TEST_IDS.composeSendButton);
    await expect(sendButton).toBeDisabled();

    // Type something in the body
    const proseMirror = dialog.locator(".ProseMirror");
    await proseMirror.click();
    await page.keyboard.type("x");

    // Now the Send button should be enabled
    await expect(sendButton).toBeEnabled();

    // Clear the text (select all, delete)
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");

    // Send button should be disabled again
    await expect(sendButton).toBeDisabled();

    // Close the dialog
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).not.toBeVisible();
  });
});
