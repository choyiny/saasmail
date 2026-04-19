// e2e/specs/templates.spec.ts
// Covers: template CRUD + iframe preview rendering.
//
// Preview mechanics: TemplateEditorPage uses a split-pane layout.
// Left pane = HTML Source (CodeMirror). Right pane = an <iframe srcDoc={bodyHtml}>.
// There are no variable-value input fields in the UI — the preview renders the
// raw HTML including any {{variable}} tokens. Variable names are shown as read-only
// badges in a "Variables" bar above the editor.
//
// The update API uses PUT /api/email-templates/:slug (not PATCH).

import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { BASE_URL } from "../support/login";
import { TEST_IDS } from "../support/selectors";

test.describe.serial("templates CRUD", () => {
  test.beforeAll(() => {
    truncateAndReseed();
  });

  // ── 1. Create template with vars — preview iframe shows the HTML ──────────

  test("create template with vars and preview iframe shows body", async ({
    page,
    uniqueName,
  }) => {
    const suffix = uniqueName("tpl");
    // Slug must match /^[a-z0-9-]+$/  — strip leading alphabetic part from uniqueName
    const slug = suffix.replace(/[^a-z0-9-]/g, "").slice(0, 40);
    const tplName = `Template ${suffix}`;
    const subject = "Hello {{name}}, enjoy {{product}}!";
    const body = "<p>Hello {{name}}, enjoy your {{product}}!</p>";

    await page.goto("/templates");
    await expect(
      page.getByRole("heading", { name: "Email Templates" }),
    ).toBeVisible();

    // Navigate to the new-template editor
    await page.getByRole("button", { name: "New Template" }).click();
    await expect(page).toHaveURL(/\/templates\/new/);

    // Fill metadata
    await page.getByPlaceholder("Untitled Template").fill(tplName);
    await page.getByPlaceholder("welcome-email").fill(slug);
    await page.getByPlaceholder("Welcome, {{name}}!").fill(subject);

    // Type body HTML into CodeMirror
    const cm = page.locator(".cm-content");
    await cm.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Delete");
    await page.keyboard.type(body);

    // Variable badges should appear in the variables bar
    await expect(
      page.locator("span.font-mono").filter({ hasText: "{{name}}" }),
    ).toBeVisible();
    await expect(
      page.locator("span.font-mono").filter({ hasText: "{{product}}" }),
    ).toBeVisible();

    // Preview iframe should contain the typed HTML
    const previewFrame = page.frameLocator('iframe[title="Email preview"]');
    await expect(previewFrame.locator("body")).toContainText("{{name}}");
    await expect(previewFrame.locator("body")).toContainText("{{product}}");

    // Save and expect redirect back to /templates
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page).toHaveURL(/\/templates$/);

    // Template row appears in the list
    const row = page.locator(
      `[data-testid="${TEST_IDS.templateRow}"][data-template-name="${tplName}"]`,
    );
    await expect(row).toBeVisible();
  });

  // ── 2. Edit HTML — persists after reload ──────────────────────────────────

  test("edit HTML persists after reload", async ({ page, api, uniqueName }) => {
    const suffix = uniqueName("edit");
    const slug = `edit-${suffix.replace(/[^a-z0-9]/g, "").slice(0, 20)}`;
    const tplName = `Edit Tpl ${suffix}`;

    // Create template via API for speed
    const createRes = await api.post(`${BASE_URL}/api/email-templates`, {
      data: {
        slug,
        name: tplName,
        subject: "Original subject",
        bodyHtml: "<p>Original body</p>",
      },
    });
    expect(createRes.ok()).toBeTruthy();

    // Open the editor
    await page.goto(`/templates/${slug}/edit`);
    await expect(page.getByPlaceholder("Untitled Template")).toHaveValue(
      tplName,
    );

    // Replace the HTML body
    const newBody = "<p>Updated body content</p>";
    const cm = page.locator(".cm-content");
    await cm.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Delete");
    await page.keyboard.type(newBody);

    // Save
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page).toHaveURL(/\/templates$/);

    // Re-open the editor and verify content persisted
    await page.goto(`/templates/${slug}/edit`);
    const cm2 = page.locator(".cm-content");
    await expect(cm2).toContainText("Updated body content");
  });

  // ── 3. Delete template — removed from list ───────────────────────────────

  test("delete template removed from list", async ({
    page,
    api,
    uniqueName,
  }) => {
    const suffix = uniqueName("del");
    const slug = `del-${suffix.replace(/[^a-z0-9]/g, "").slice(0, 20)}`;
    const tplName = `Delete Tpl ${suffix}`;

    // Create via API
    const createRes = await api.post(`${BASE_URL}/api/email-templates`, {
      data: {
        slug,
        name: tplName,
        subject: "To be deleted",
        bodyHtml: "<p>Bye</p>",
      },
    });
    expect(createRes.ok()).toBeTruthy();

    await page.goto("/templates");

    // Confirm row is visible
    const templateRow = page.locator(
      `[data-testid="${TEST_IDS.templateRow}"][data-template-name="${tplName}"]`,
    );
    await expect(templateRow).toBeVisible();

    // Accept the confirm dialog and click Delete
    page.once("dialog", (dialog) => dialog.accept());
    // Find the delete button within the row for this template
    // The row renders the name in a <p> and has Edit/Delete buttons alongside
    await templateRow.getByRole("button", { name: "Delete" }).click();

    // Row should disappear
    await expect(templateRow).not.toBeVisible();

    // Confirm via API: template should be gone (404)
    const checkRes = await api.get(`${BASE_URL}/api/email-templates/${slug}`);
    expect(checkRes.status()).toBe(404);
  });
});
