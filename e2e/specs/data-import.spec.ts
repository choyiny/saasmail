// e2e/specs/data-import.spec.ts
// Covers: an admin imports a three-message mbox into the seeded inbox from
// Settings → Data; the messages appear in Mail; the same file again imports
// nothing.
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";

const INBOX = "support@e2e.test";

function mbox(tag: string): string {
  const message = (n: number) =>
    [
      `From sender${n}@example.com Sat Oct  3 14:0${n}:00 2026`,
      `From: Importer ${n} <sender${n}@example.com>`,
      `To: ${INBOX}`,
      `Subject: Imported ${tag} #${n}`,
      `Message-ID: <import-${tag}-${n}@example.com>`,
      `Date: Sat, 03 Oct 2026 14:0${n}:00 +0000`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      `Old message number ${n}.`,
      "",
    ].join("\n");
  return [1, 2, 3].map(message).join("\n");
}

test.describe.serial("mail import", () => {
  test.beforeAll(() => truncateAndReseed());

  test("an mbox imports into an inbox, once", async ({ page, api }) => {
    const tag = `t${Date.now()}`;
    const file = {
      name: "old-mail.mbox",
      mimeType: "application/mbox",
      buffer: Buffer.from(mbox(tag)),
    };

    await page.goto("/settings#data");
    const card = page.getByTestId("data-imports");
    await card.getByLabel("Into inbox").selectOption(INBOX);
    await card.getByLabel("File").setInputFiles(file);
    await card.getByRole("button", { name: "Import" }).click();
    const row = card
      .getByTestId("import-row")
      .filter({ hasText: "old-mail.mbox" })
      .first();
    await expect(row).toContainText("3 imported, 0 skipped", {
      timeout: 30_000,
    });

    // In Mail's list for the inbox.
    const list = await api.get(
      `/api/messages?inbox=${encodeURIComponent(INBOX)}&q=${encodeURIComponent(`Imported ${tag}`)}&limit=10`,
    );
    const { messages } = (await list.json()) as {
      messages: { subject: string; isRead: boolean | null }[];
    };
    expect(messages.map((m) => m.subject).sort()).toEqual([
      `Imported ${tag} #1`,
      `Imported ${tag} #2`,
      `Imported ${tag} #3`,
    ]);

    // The same file again: all three are already there.
    await card.getByLabel("File").setInputFiles(file);
    await expect(card.getByLabel("File")).toHaveValue(/old-mail\.mbox$/);
    await expect(card.getByRole("button", { name: "Import" })).toBeEnabled();
    await card.getByRole("button", { name: "Import" }).click();
    await expect(card.getByTestId("import-row")).toHaveCount(2, {
      timeout: 10_000,
    });
    await expect(card.getByTestId("import-row").first()).toContainText(
      "0 imported, 3 skipped",
      { timeout: 30_000 },
    );
  });
});
