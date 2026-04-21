// e2e/specs/reply-to-own.spec.ts
// Covers: replying to your own sent message. The Reply button used to be
// gated behind `email.type === "received"`; that guard was removed so
// we can now reply to sent bubbles too. The backend /api/send/reply/:id
// falls through to sent_emails when the id isn't in the emails table.
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { TEST_IDS } from "../support/selectors";
import { BASE_URL } from "../support/login";

test.describe.serial("reply to own sent message", () => {
  test.beforeEach(() => truncateAndReseed());

  test("reply to own sent email threads correctly in DEMO_MODE", async ({
    page,
    api,
  }) => {
    await page.goto("/");

    // Wait for the inbox page to finish loading
    await expect(page.getByText("Alice Anderson")).toBeVisible();

    // Open Alice's person detail
    await page.getByText("Alice Anderson").click();

    // ── Step 1: send an initial email via the Compose modal ───────────────
    await page.getByRole("button", { name: "Compose" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Compose" }),
    ).toBeVisible();

    await dialog.getByLabel("To").fill("alice@customers.test");
    await dialog.getByLabel("Subject").fill("Initial outreach to Alice");

    const composeProseMirror = dialog.locator(".ProseMirror");
    await composeProseMirror.click();
    await page.keyboard.type("Hello Alice, this is our first contact.");

    const sendResponsePromise = page.waitForResponse(
      (res) =>
        res.url().includes("/api/send") &&
        !res.url().includes("/reply/") &&
        res.request().method() === "POST",
    );

    const composeSendButton = dialog.getByTestId(TEST_IDS.composeSendButton);
    await expect(composeSendButton).toBeEnabled();
    await composeSendButton.click();

    const sendResponse = await sendResponsePromise;
    expect(sendResponse.ok()).toBeTruthy();

    await expect(dialog).not.toBeVisible();

    // The global Compose modal does not trigger a re-fetch on the
    // PersonDetail thread view, so reload the page to pick up the newly
    // sent email. Then reopen Alice's person detail.
    await page.reload();
    await expect(page.getByText("Alice Anderson")).toBeVisible();
    await page.getByText("Alice Anderson").click();

    // ── Step 2: find the new sent bubble and click Reply ──────────────────
    // Inbox groups render only the latest email per group as a MessageBubble.
    // The initial send becomes the latest in its inbox group, so filter by
    // its unique subject to target it unambiguously.
    const emailContainer = page
      .getByTestId(TEST_IDS.threadMessage)
      .filter({ hasText: "Initial outreach to Alice" });
    await expect(emailContainer).toBeVisible();

    await emailContainer.hover();
    const replyButton = emailContainer.getByRole("button", { name: "Reply" });
    await expect(replyButton).toBeVisible();
    await replyButton.click();

    // ── Step 3: ReplyComposer appears ─────────────────────────────────────
    const replyComposer = page.getByTestId(TEST_IDS.replyComposer);
    await expect(replyComposer).toBeVisible();

    const freeformTab = page.getByRole("button", { name: "Freeform" });
    await expect(freeformTab).toBeVisible();

    // ── Step 4: type into the reply's ProseMirror ─────────────────────────
    const replyProseMirror = replyComposer.locator(".ProseMirror");
    await replyProseMirror.click();
    await page.keyboard.type("Following up on my previous note.");

    // ── Step 5: send the reply ────────────────────────────────────────────
    const replyResponsePromise = page.waitForResponse(
      (res) =>
        res.url().includes("/api/send/reply/") &&
        res.request().method() === "POST",
    );

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

    // Reply composer should close
    await expect(replyComposer).not.toBeVisible();

    // ── Step 6: assert the new sent bubble appears in the DOM ─────────────
    // MessageBubble renders the subject as a <p> inside the thread-message
    // container, so filtering thread messages by the Re: subject targets
    // the newly sent reply bubble.
    await expect(
      page
        .getByTestId(TEST_IDS.threadMessage)
        .filter({ hasText: "Re: Initial outreach to Alice" }),
    ).toBeVisible();

    // ── Step 7: verify via backend that a Re: sent row now exists ─────────
    const emailsRes = await api.get(`${BASE_URL}/api/emails/by-person/p_alice`);
    expect(emailsRes.ok()).toBeTruthy();
    const payload = (await emailsRes.json()) as {
      emails: Array<{
        type: string;
        subject: string | null;
        inReplyTo?: string | null;
      }>;
    };
    const replyRow = payload.emails.find(
      (e) => e.type === "sent" && e.subject === "Re: Initial outreach to Alice",
    );
    expect(replyRow).toBeTruthy();
  });
});
