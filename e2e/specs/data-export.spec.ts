// e2e/specs/data-export.spec.ts
// Covers: exporting a seeded inbox as mbox (start, poll to completed,
// download), the export in Settings → Data, and one message as .eml.
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";

const INBOX = "support@e2e.test";

test.describe.serial("mailbox export", () => {
  test.beforeAll(() => truncateAndReseed());

  test("an inbox exports to an mbox file that downloads", async ({
    page,
    api,
  }) => {
    const started = await api.post("/api/exports", { data: { inbox: INBOX } });
    expect(started.status()).toBe(202);
    const { id } = (await started.json()) as { id: string };

    await expect
      .poll(
        async () => {
          const res = await api.get(`/api/exports/${id}`);
          return ((await res.json()) as { status: string }).status;
        },
        { timeout: 30_000 },
      )
      .toBe("completed");

    const download = await api.get(`/api/exports/${id}/download`);
    expect(download.status()).toBe(200);
    expect(download.headers()["content-type"]).toBe("application/mbox");
    expect(download.headers()["content-disposition"]).toContain(
      `filename="${INBOX}-`,
    );
    const mbox = (await download.body()).toString("utf8");
    expect(mbox.startsWith("From ")).toBe(true);
    const entries = mbox
      .split("\n")
      .filter((line) => /^From \S+ \w{3} \w{3} [ \d]\d /.test(line));
    expect(entries.length).toBeGreaterThan(0);
    expect(mbox).toContain(`X-Saasmail-Labels:`);

    // Settings → Data lists it, ready to download.
    await page.goto("/settings#data");
    const row = page.getByTestId("export-row").filter({ hasText: INBOX });
    await expect(row).toContainText(`${entries.length} messages`);
    await expect(row.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      `/api/exports/${id}/download`,
    );
  });

  test("a message downloads as .eml", async ({ api }) => {
    const list = await api.get(
      `/api/messages?inbox=${encodeURIComponent(INBOX)}&limit=1`,
    );
    const { messages } = (await list.json()) as {
      messages: { ref: string; subject: string }[];
    };
    const [kind, id] = messages[0].ref.split(":");
    const eml = await api.get(`/api/messages/${kind}/${id}/raw.eml`);
    expect(eml.status()).toBe(200);
    expect(eml.headers()["content-type"]).toBe("message/rfc822");
    expect((await eml.body()).toString("utf8")).toContain(
      `Subject: ${messages[0].subject}`,
    );
  });
});
