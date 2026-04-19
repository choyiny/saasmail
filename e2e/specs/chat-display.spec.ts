// e2e/specs/chat-display.spec.ts
// Covers: chat-mode rendering for support@e2e.test (display_mode = 'chat').
// Alice has 2 emails in the support inbox:
//   e_s_a1 — "Help with login"       body <p>I can't log in.</p>
//   e_s_a2 — "Re: Help with login"   body <p>Tried that, still broken.</p>
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { TEST_IDS } from "../support/selectors";

test.describe.serial("chat-mode display (support@)", () => {
  test.beforeAll(() => truncateAndReseed());

  test("renders bubbles without subject headers and with inline composer", async ({
    page,
  }) => {
    // Navigate to the inbox and select Alice
    await page.goto("/");

    await expect(page.getByText("Alice Anderson")).toBeVisible();
    await page.getByText("Alice Anderson").click();

    // Chat bubbles should be rendered (2 support@ emails)
    const bubbles = page.getByTestId(TEST_IDS.chatBubble);
    await expect(bubbles).toHaveCount(2);

    // The body text of at least one bubble should be visible
    // body_text for e_s_a1 is "login", e_s_a2 is "still"
    // The chat section renders body_text (or strips HTML to text).
    // body_html is <p>I can't log in.</p> and <p>Tried that, still broken.</p>
    await expect(bubbles.first()).toContainText("login");

    // Chat mode does NOT render subjects as visible UI headers.
    // The subjects "Help with login" / "Re: Help with login" should not appear
    // as standalone text elements (they appear only as tooltip titles on the wrapper).
    // We check they are not visible as heading/paragraph text.
    await expect(
      page.getByRole("heading", { name: /Help with login/i }),
    ).not.toBeVisible();
    await expect(
      page.getByRole("heading", { name: /Re: Help with login/i }),
    ).not.toBeVisible();

    // Inline composer: ChatQuickReply renders a textarea with placeholder "Type a reply…"
    const composer = page.getByPlaceholder(/Type a reply/i);
    await expect(composer).toBeVisible();

    // The send button is inline (not inside a modal)
    const sendButton = page.getByRole("button", { name: /^Send$/ });
    await expect(sendButton).toBeVisible();
  });
});
