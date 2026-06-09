import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { getWebhookConfig, setWebhookConfig } from "../lib/webhook-config";
import { appSettings } from "../db/app-settings.schema";

beforeEach(async () => {
  await applyMigrations();
  await cleanDb();
});

describe("webhook-config", () => {
  it("returns null when unconfigured", async () => {
    expect(await getWebhookConfig(getDb())).toBeNull();
  });

  it("round-trips url + secret", async () => {
    await setWebhookConfig(
      getDb(),
      { url: "https://hook.example.com", secret: "whsec_abc" },
      "user-1",
    );
    expect(await getWebhookConfig(getDb())).toEqual({
      url: "https://hook.example.com",
      secret: "whsec_abc",
    });
  });

  it("treats empty/whitespace url as disabled (null)", async () => {
    await setWebhookConfig(getDb(), { url: "   ", secret: "x" }, "user-1");
    expect(await getWebhookConfig(getDb())).toBeNull();
  });

  it("stores a null secret when none provided", async () => {
    await setWebhookConfig(
      getDb(),
      { url: "https://hook.example.com", secret: null },
      "user-1",
    );
    expect(await getWebhookConfig(getDb())).toEqual({
      url: "https://hook.example.com",
      secret: null,
    });
  });

  it("returns null on malformed stored JSON (no throw)", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(appSettings)
      .values({
        key: "webhook",
        value: "{not json",
        updatedAt: now,
        updatedBy: null,
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: "{not json", updatedAt: now, updatedBy: null },
      });
    expect(await getWebhookConfig(getDb())).toBeNull();
  });
});
