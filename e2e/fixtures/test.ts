import { test as base, expect, type APIRequestContext } from "@playwright/test";
import { customAlphabet } from "nanoid";
import { BASE_URL } from "../support/login";

const nano = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);

type Fixtures = {
  uniqueName: (prefix: string) => string;
  api: APIRequestContext;
};

export const test = base.extend<Fixtures>({
  uniqueName: async ({}, use, testInfo) => {
    const slug = testInfo.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 24);
    await use((prefix) => `${prefix}-${slug}-${nano()}`);
  },
  api: async ({ playwright }, use) => {
    const ctx = await playwright.request.newContext({
      baseURL: BASE_URL,
      storageState: "e2e/.auth/admin.json",
    });
    await use(ctx);
    await ctx.dispose();
  },
});

export { expect };
