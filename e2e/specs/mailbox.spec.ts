import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { TEST_IDS } from "../support/selectors";

test.describe.serial("conventional mailbox", () => {
  test.beforeAll(() => truncateAndReseed());

  test("mailbox state flows and custom folders work end to end", async ({
    page,
    api,
  }) => {
    await page.goto("/mail");
    await expect(page).toHaveURL(/\/mail\/[^/]+\/inbox$/);

    await page.goto("/mail/support%40e2e.test/inbox");
    const row = page
      .getByTestId(TEST_IDS.mailMessageRow)
      .filter({ hasText: "Mailbox fixture message" })
      .first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByTestId(TEST_IDS.mailReadingPane)).toBeVisible();

    await expect
      .poll(async () => {
        const response = await api.get(
          "/api/messages?inbox=support%40e2e.test&folder=inbox",
        );
        const body = (await response.json()) as {
          messages: Array<{ ref: string; state: { seen: boolean } }>;
        };
        return body.messages.find(
          (message) => message.ref === "received:e_mailbox_1",
        )?.state.seen;
      })
      .toBe(true);

    await page.getByTestId(TEST_IDS.mailReadingStar).click();
    await page.getByTestId("mail-folder-starred").click();
    await expect(
      page
        .getByTestId(TEST_IDS.mailMessageRow)
        .filter({ hasText: "Mailbox fixture message" }),
    ).toBeVisible();

    await page.getByTestId("mail-folder-inbox").click();
    await page
      .getByTestId(TEST_IDS.mailMessageRow)
      .filter({ hasText: "Mailbox fixture message" })
      .first()
      .click();
    await page.getByTestId(TEST_IDS.mailReadingArchive).click();

    await page.getByTestId("mail-folder-archive").click();
    const archived = page
      .getByTestId(TEST_IDS.mailMessageRow)
      .filter({ hasText: "Mailbox fixture message" })
      .first();
    await expect(archived).toBeVisible();
    await archived.click();
    await expect(page.getByTestId(TEST_IDS.mailReadingArchive)).toHaveText(
      "Unarchive",
    );
    await page.getByTestId(TEST_IDS.mailReadingArchive).click();

    await page.getByTestId("mail-folder-inbox").click();
    await page
      .getByTestId(TEST_IDS.mailMessageRow)
      .filter({ hasText: "Mailbox fixture message" })
      .first()
      .click();
    await page.getByTestId(TEST_IDS.mailReadingTrash).click();

    await page.getByTestId("mail-folder-trash").click();
    const trashed = page
      .getByTestId(TEST_IDS.mailMessageRow)
      .filter({ hasText: "Mailbox fixture message" })
      .first();
    await expect(trashed).toBeVisible();
    await trashed.click();
    await expect(page.getByTestId(TEST_IDS.mailReadingTrash)).toHaveText(
      "Restore",
    );
    await page.getByTestId(TEST_IDS.mailReadingTrash).click();

    await page.getByTestId("mail-folder-inbox").click();
    await page.getByTestId(TEST_IDS.mailCreateFolderInput).fill("Projects");
    await page.getByTestId(TEST_IDS.mailCreateFolderButton).click();
    await expect(
      page.getByTestId("mail-custom-folder").filter({ hasText: "Projects" }),
    ).toBeVisible();

    await page
      .getByTestId(TEST_IDS.mailMessageRow)
      .filter({ hasText: "Mailbox fixture message" })
      .first()
      .click();
    await page.getByRole("button", { name: "Folder" }).click();
    await page.getByText("Move to folder", { exact: true }).hover();
    const projectFolder = page
      .getByTestId(TEST_IDS.mailMoveFolder)
      .filter({ hasText: "Projects" });
    await expect(projectFolder).toBeVisible();
    await projectFolder.press("Enter");

    await page
      .getByTestId("mail-custom-folder")
      .filter({ hasText: "Projects" })
      .click();
    await expect(
      page
        .getByTestId(TEST_IDS.mailMessageRow)
        .filter({ hasText: "Mailbox fixture message" }),
    ).toBeVisible();

    await page.getByTestId("mail-folder-sent").click();
    await expect(
      page
        .getByTestId(TEST_IDS.mailMessageRow)
        .filter({ hasText: "Mailbox fixture message" }),
    ).toBeVisible();
  });
});
