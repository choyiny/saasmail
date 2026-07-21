import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  authFetch,
  createTestUser,
  createTestPerson,
  createTestEmail,
  getDb,
  applyMigrations,
  cleanDb,
} from "./helpers";
import { blocklist } from "../db/blocklist.schema";

beforeAll(applyMigrations);
beforeEach(cleanDb);

describe("DELETE /api/blocklist/mail (purge)", () => {
  it("deletes emails + people matching a domain rule, leaves others", async () => {
    const { apiKey } = await createTestUser();

    // Blocked sender (domain rule below).
    await createTestPerson({ id: "p-spam", email: "bad@evil.com" });
    await createTestEmail({
      id: "e-spam",
      personId: "p-spam",
      messageId: "m-spam@evil.com",
    });

    // Innocent sender — must survive.
    await createTestPerson({ id: "p-ok", email: "good@nice.com" });
    await createTestEmail({
      id: "e-ok",
      personId: "p-ok",
      messageId: "m-ok@nice.com",
    });

    await getDb().insert(blocklist).values({
      id: "blk-dom",
      type: "domain",
      value: "evil.com",
      createdAt: 1,
    });

    const r = await authFetch("/api/blocklist/mail", {
      apiKey,
      method: "DELETE",
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      emailsDeleted: number;
      peopleDeleted: number;
    };
    expect(body.emailsDeleted).toBe(1);
    expect(body.peopleDeleted).toBe(1);

    const people = await getDb().query.people.findMany();
    expect(people.map((p) => p.id)).toEqual(["p-ok"]);
    const emails = await getDb().query.emails.findMany();
    expect(emails.map((e) => e.id)).toEqual(["e-ok"]);
  });

  it("matches exact email rules too", async () => {
    const { apiKey } = await createTestUser();
    await createTestPerson({ id: "p-x", email: "x@mixed.com" });
    await createTestEmail({
      id: "e-x",
      personId: "p-x",
      messageId: "m-x@mixed.com",
    });
    await createTestPerson({ id: "p-y", email: "y@mixed.com" });
    await createTestEmail({
      id: "e-y",
      personId: "p-y",
      messageId: "m-y@mixed.com",
    });

    await getDb().insert(blocklist).values({
      id: "blk-email",
      type: "email",
      value: "x@mixed.com",
      createdAt: 1,
    });

    await authFetch("/api/blocklist/mail", { apiKey, method: "DELETE" });
    const people = await getDb().query.people.findMany();
    expect(people.map((p) => p.id).sort()).toEqual(["p-y"]);
  });
});
