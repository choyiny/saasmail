// e2e/specs/block-templates.spec.ts
// Covers: authoring a template with the block editor, and the compiled preview.
//
// How this differs from templates.spec.ts: that spec drives the raw-HTML
// editor (a CodeMirror `.cm-content` pane). A block template has no HTML pane
// at all — the left side is a ProseMirror surface, and the right side is the
// same iframe preview, fed by HTML the browser compiles with the *same* module
// the worker runs on save.
//
// Entry point: "New block template" on /templates, which navigates to
// /templates/new?format=block. It does not match the /new template/i regex the
// other spec uses, so the two buttons stay unambiguous.
//
// Image upload is deliberately NOT exercised here. The e2e environment runs
// with DEMO_MODE=1 (see AGENTS.md), and uploads are refused in demo mode by
// design — a public upload endpoint on a demo deploy is an open file drop.
// The refusal itself is asserted at the bottom of this file.

import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { TEST_IDS } from "../support/selectors";

test.describe.serial("block templates", () => {
  test.beforeAll(() => {
    truncateAndReseed();
  });

  test("author a block template and see the compiled preview", async ({
    page,
    uniqueName,
  }) => {
    const suffix = uniqueName("blk");
    const slug = suffix.replace(/[^a-z0-9-]/g, "").slice(0, 40);
    const tplName = `Block ${suffix}`;

    await page.goto("/templates");
    await expect(
      page.getByRole("heading", { name: "Email Templates" }),
    ).toBeVisible();

    await page.getByRole("button", { name: /new block template/i }).click();
    await expect(page).toHaveURL(/\/templates\/new\?format=block/);

    await page.getByPlaceholder("Welcome email").fill(tplName);
    await page.getByPlaceholder("welcome-email").fill(slug);
    await page
      .getByPlaceholder("Welcome, {{name}}!")
      .fill("This week, {{first_name}}");

    // The block surface is a ProseMirror editor, not a textarea.
    const editor = page.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.type("Hello {{first_name}}, here is the news.");

    // Heading, from the toolbar rather than markdown shorthand, so the test
    // fails if the toolbar wiring breaks rather than only the input rules.
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Heading 1" }).click();
    await page.keyboard.type("Highlights");

    // A separator is an atom node — it proves a non-text block serializes.
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Separator" }).click();

    // Variable chips come from analysing the *compiled* HTML, so seeing
    // `{{first_name}}` here proves the browser-side compile ran.
    await expect(
      page.locator("code").filter({ hasText: "{{first_name}}" }).first(),
    ).toBeVisible();

    // The preview iframe renders the compiled email with sample values
    // substituted, exactly as the HTML editor's preview does.
    const preview = page.frameLocator('iframe[title="Email preview"]');
    await expect(preview.locator("body")).toContainText("<first_name>");
    await expect(preview.locator("body")).toContainText("Highlights");
    // Compiled output is a table-based email document, not the editor's DOM.
    await expect(preview.locator("table").first()).toBeVisible();

    await page.getByRole("button", { name: "Create template" }).click();
    await expect(page).toHaveURL(/\/templates$/);

    const row = page.locator(
      `[data-testid="${TEST_IDS.templateRow}"][data-template-name="${tplName}"]`,
    );
    await expect(row).toBeVisible();
  });

  test("a saved block template reopens in the block editor", async ({
    page,
  }) => {
    await page.goto("/templates");
    await page
      .locator(`[data-testid="${TEST_IDS.templateRow}"]`)
      .first()
      .getByRole("link")
      .first()
      .click();

    // Reopening deserializes the stored document back into the editor; the
    // HTML pane must not appear for a block template.
    await expect(page.locator(".ProseMirror")).toBeVisible();
    await expect(page.locator(".cm-content")).toHaveCount(0);
    await expect(
      page.getByText("Blocks", { exact: true }).first(),
    ).toBeVisible();
  });

  test("image uploads are refused in demo mode", async ({ page }) => {
    // Asserted through the API rather than the UI: the e2e run sets
    // DEMO_MODE=1, so this is the behaviour a demo deployment actually has.
    // A demo instance cannot send mail either, so there is nothing to upload
    // an image *for* — the endpoint is closed rather than left as a file drop.
    // `page.evaluate` needs an origin to resolve a relative URL against, and a
    // freshly-created page sits on about:blank.
    await page.goto("/templates");

    const status = await page.evaluate(async () => {
      const res = await fetch("/api/newsletter-assets", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      });
      return res.status;
    });
    expect(status).toBe(403);
  });
});
