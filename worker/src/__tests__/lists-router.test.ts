import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestUser,
  getDb,
} from "./helpers";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { listMembers } from "../db/list-members.schema";
import { lists } from "../db/lists.schema";
import { contacts } from "../db/contacts.schema";
import { people } from "../db/people.schema";
import { asyncJobs } from "../db/async-jobs.schema";
import { env } from "cloudflare:workers";
import { sourceKey } from "../lib/list-import";

beforeAll(applyMigrations);
beforeEach(cleanDb);

const FROM = "news@example.com";

async function adminKey() {
  const { apiKey } = await createTestUser({
    id: "u-admin",
    role: "admin",
    email: "admin@example.com",
  });
  return apiKey;
}

/** A member scoped to `inbox`, or to nothing when `inbox` is omitted. */
async function memberKey(id: string, email: string, inbox?: string) {
  const { apiKey } = await createTestUser({ id, role: "member", email });
  if (inbox) {
    await getDb()
      .insert(inboxPermissions)
      .values({
        userId: id,
        email: inbox,
        createdAt: Math.floor(Date.now() / 1000),
        createdBy: "u-admin",
      });
  }
  return apiKey;
}

async function createList(apiKey: string, overrides: object = {}) {
  const res = await authFetch("/api/lists", {
    apiKey,
    method: "POST",
    body: JSON.stringify({ name: "Weekly", fromAddress: FROM, ...overrides }),
  });
  return { res, body: res.status === 201 ? await res.json<any>() : null };
}

async function peopleCount() {
  return (await getDb().select({ id: people.id }).from(people)).length;
}

describe("lists CRUD", () => {
  it("creates a list", async () => {
    const apiKey = await adminKey();
    const { res, body } = await createList(apiKey);
    expect(res.status).toBe(201);
    expect(body.name).toBe("Weekly");
    expect(body.fromAddress).toBe(FROM);
    expect(body.doubleOptIn).toBe(false);
    expect(body.archivedAt).toBeNull();
  });

  it("lowercases the sending identity so authorization is case-insensitive", async () => {
    const apiKey = await adminKey();
    const { body } = await createList(apiKey, {
      fromAddress: "News@Example.COM",
    });
    expect(body.fromAddress).toBe(FROM);
  });

  it("rejects a sending identity the caller is not scoped to", async () => {
    await adminKey();
    const key = await memberKey("u-m1", "m1@example.com", "other@example.com");
    const { res } = await createList(key);
    expect(res.status).toBe(403);
  });

  it("lets a scoped member create a list for their own identity", async () => {
    await adminKey();
    const key = await memberKey("u-m2", "m2@example.com", FROM);
    const { res } = await createList(key);
    expect(res.status).toBe(201);
  });

  it("returns member counts by status on the detail endpoint", async () => {
    const apiKey = await adminKey();
    const { body: list } = await createList(apiKey);

    await authFetch(`/api/lists/${list.id}/members`, {
      apiKey,
      method: "POST",
      body: JSON.stringify({ email: "a@example.com" }),
    });
    const add = await authFetch(`/api/lists/${list.id}/members`, {
      apiKey,
      method: "POST",
      body: JSON.stringify({ email: "b@example.com" }),
    });
    const member = await add.json<any>();
    await authFetch(`/api/lists/${list.id}/members/${member.id}`, {
      apiKey,
      method: "DELETE",
    });

    const res = await authFetch(`/api/lists/${list.id}`, { apiKey });
    const body = await res.json<any>();
    expect(body.memberCounts).toEqual({
      subscribed: 1,
      pending: 0,
      unsubscribed: 1,
    });
  });

  it("hides archived lists unless includeArchived=true", async () => {
    const apiKey = await adminKey();
    const { body: list } = await createList(apiKey);
    await getDb()
      .update(lists)
      .set({ archivedAt: Math.floor(Date.now() / 1000) })
      .where(eq(lists.id, list.id));

    const hidden = await (
      await authFetch("/api/lists", { apiKey })
    ).json<any>();
    expect(hidden.items).toHaveLength(0);

    const shown = await (
      await authFetch("/api/lists?includeArchived=true", { apiKey })
    ).json<any>();
    expect(shown.items).toHaveLength(1);
  });

  it("updates settings but refuses to touch an archived list", async () => {
    const apiKey = await adminKey();
    const { body: list } = await createList(apiKey);

    const ok = await authFetch(`/api/lists/${list.id}`, {
      apiKey,
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed", doubleOptIn: true }),
    });
    expect(ok.status).toBe(200);
    const updated = await ok.json<any>();
    expect(updated.name).toBe("Renamed");
    expect(updated.doubleOptIn).toBe(true);

    await getDb()
      .update(lists)
      .set({ archivedAt: Math.floor(Date.now() / 1000) })
      .where(eq(lists.id, list.id));

    const blocked = await authFetch(`/api/lists/${list.id}`, {
      apiKey,
      method: "PATCH",
      body: JSON.stringify({ name: "Nope" }),
    });
    expect(blocked.status).toBe(409);
  });

  it("404s for a list that does not exist", async () => {
    const apiKey = await adminKey();
    const res = await authFetch("/api/lists/does-not-exist", { apiKey });
    expect(res.status).toBe(404);
  });

  it("403s rather than 404s when the list exists but is out of scope", async () => {
    const apiKey = await adminKey();
    const { body: list } = await createList(apiKey);
    const key = await memberKey("u-m3", "m3@example.com", "other@example.com");

    const res = await authFetch(`/api/lists/${list.id}`, { apiKey: key });
    // Distinct from 404 on purpose: a scoped member must not be able to probe
    // for the existence of another team's lists.
    expect(res.status).toBe(403);
  });

  /**
   * The `campaigns` table does not exist yet, so `listHasCampaignHistory` is
   * false and this is always the hard-delete branch. The archive branch gets
   * its test when campaigns land.
   */
  it("hard-deletes a list with no campaign history, and its memberships", async () => {
    const apiKey = await adminKey();
    const { body: list } = await createList(apiKey);
    await authFetch(`/api/lists/${list.id}/members`, {
      apiKey,
      method: "POST",
      body: JSON.stringify({ email: "a@example.com" }),
    });

    const res = await authFetch(`/api/lists/${list.id}`, {
      apiKey,
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect((await res.json<any>()).outcome).toBe("deleted");

    expect(await getDb().select().from(lists)).toHaveLength(0);
    expect(await getDb().select().from(listMembers)).toHaveLength(0);
  });
});

describe("list members", () => {
  it("creates a contacts row and never a people row", async () => {
    const apiKey = await adminKey();
    const { body: list } = await createList(apiKey);
    expect(await peopleCount()).toBe(0);

    const res = await authFetch(`/api/lists/${list.id}/members`, {
      apiKey,
      method: "POST",
      body: JSON.stringify({ email: "Sub@Example.com", name: "Sub" }),
    });
    expect(res.status).toBe(201);
    const member = await res.json<any>();
    expect(member.email).toBe("sub@example.com");
    expect(member.status).toBe("subscribed");
    expect(member.consentSource).toBe("api");

    const storedContacts = await getDb().select().from(contacts);
    expect(storedContacts).toHaveLength(1);
    expect(storedContacts[0].email).toBe("sub@example.com");
    expect(storedContacts[0].personId).toBeNull();

    // The whole reason `contacts` exists (SPEC.md Decision 23).
    expect(await peopleCount()).toBe(0);
  });

  it("strips control characters from a submitted name", async () => {
    const apiKey = await adminKey();
    const { body: list } = await createList(apiKey);
    await authFetch(`/api/lists/${list.id}/members`, {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        email: "x@example.com",
        name: "Bad\r\nBcc: attacker@evil.com",
      }),
    });
    const stored = await getDb().select().from(contacts);
    expect(stored[0].name).toBe("Bad Bcc: attacker@evil.com");
    expect(stored[0].name).not.toContain("\n");
  });

  it("returns the contact name on the member list, not a hardcoded null", async () => {
    const apiKey = await adminKey();
    const { body: list } = await createList(apiKey);
    await authFetch(`/api/lists/${list.id}/members`, {
      apiKey,
      method: "POST",
      body: JSON.stringify({ email: "named@example.com", name: "Ada" }),
    });

    const listed = await (
      await authFetch(`/api/lists/${list.id}/members`, { apiKey })
    ).json<any>();
    expect(listed.items[0].name).toBe("Ada");

    const removed = await (
      await authFetch(`/api/lists/${list.id}/members/${listed.items[0].id}`, {
        apiKey,
        method: "DELETE",
      })
    ).json<any>();
    expect(removed.name).toBe("Ada");
  });

  it("is idempotent when the same address is added twice", async () => {
    const apiKey = await adminKey();
    const { body: list } = await createList(apiKey);
    const body = JSON.stringify({ email: "dupe@example.com" });

    const first = await authFetch(`/api/lists/${list.id}/members`, {
      apiKey,
      method: "POST",
      body,
    });
    const second = await authFetch(`/api/lists/${list.id}/members`, {
      apiKey,
      method: "POST",
      body,
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await first.json<any>()).id).toBe((await second.json<any>()).id);
    expect(await getDb().select().from(listMembers)).toHaveLength(1);
  });

  it("unsubscribes as a status change, keeping the consent record", async () => {
    const apiKey = await adminKey();
    const { body: list } = await createList(apiKey);
    const added = await (
      await authFetch(`/api/lists/${list.id}/members`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({ email: "bye@example.com" }),
      })
    ).json<any>();

    const res = await authFetch(`/api/lists/${list.id}/members/${added.id}`, {
      apiKey,
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.status).toBe("unsubscribed");
    expect(body.unsubscribedAt).not.toBeNull();
    // Never a row delete — the row carries the consent provenance.
    expect(body.consentSource).toBe("api");
    expect(await getDb().select().from(listMembers)).toHaveLength(1);
  });

  it("re-subscribes a previously unsubscribed member", async () => {
    const apiKey = await adminKey();
    const { body: list } = await createList(apiKey);
    const payload = JSON.stringify({ email: "back@example.com" });
    const added = await (
      await authFetch(`/api/lists/${list.id}/members`, {
        apiKey,
        method: "POST",
        body: payload,
      })
    ).json<any>();
    await authFetch(`/api/lists/${list.id}/members/${added.id}`, {
      apiKey,
      method: "DELETE",
    });

    const again = await (
      await authFetch(`/api/lists/${list.id}/members`, {
        apiKey,
        method: "POST",
        body: payload,
      })
    ).json<any>();
    expect(again.status).toBe("subscribed");
    expect(again.unsubscribedAt).toBeNull();
  });

  it("filters the member list by status", async () => {
    const apiKey = await adminKey();
    const { body: list } = await createList(apiKey);
    for (const email of ["a@example.com", "b@example.com"]) {
      await authFetch(`/api/lists/${list.id}/members`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({ email }),
      });
    }
    const all = await getDb().select().from(listMembers);
    await authFetch(`/api/lists/${list.id}/members/${all[0].id}`, {
      apiKey,
      method: "DELETE",
    });

    const subscribed = await (
      await authFetch(`/api/lists/${list.id}/members?status=subscribed`, {
        apiKey,
      })
    ).json<any>();
    expect(subscribed.items).toHaveLength(1);

    const unsubscribed = await (
      await authFetch(`/api/lists/${list.id}/members?status=unsubscribed`, {
        apiKey,
      })
    ).json<any>();
    expect(unsubscribed.items).toHaveLength(1);
  });
});

describe("member export", () => {
  it("streams CSV with a header row", async () => {
    const apiKey = await adminKey();
    const { body: list } = await createList(apiKey);
    await authFetch(`/api/lists/${list.id}/members`, {
      apiKey,
      method: "POST",
      body: JSON.stringify({ email: "a@example.com" }),
    });

    const res = await authFetch(`/api/lists/${list.id}/members/export`, {
      apiKey,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");

    const text = await res.text();
    const rows = text.trim().split("\r\n");
    expect(rows[0]).toBe(
      "email,status,source,consent_source,consent_at,subscribed_at,unsubscribed_at",
    );
    expect(rows[1]).toContain("a@example.com");
    expect(rows[1]).toContain("subscribed");
  });

  it("neutralizes a formula smuggled in through an address", async () => {
    const apiKey = await adminKey();
    const { body: list } = await createList(apiKey);
    // Insert directly: the API validates the address format, but an import or a
    // future ingestion path might not, and the export must be safe regardless.
    const ts = Math.floor(Date.now() / 1000);
    await getDb().insert(contacts).values({
      id: "c-evil",
      email: "=cmd()@example.com",
      name: null,
      personId: null,
      createdAt: ts,
      updatedAt: ts,
    });
    await getDb().insert(listMembers).values({
      id: "m-evil",
      listId: list.id,
      contactId: "c-evil",
      email: "=cmd()@example.com",
      status: "subscribed",
      source: "import",
      formId: null,
      submittedIp: null,
      consentSource: "import",
      consentAt: ts,
      importJobId: null,
      subscribedAt: ts,
      confirmedAt: null,
      unsubscribedAt: null,
      unsubscribeReason: null,
      createdAt: ts,
    });

    const text = await (
      await authFetch(`/api/lists/${list.id}/members/export`, { apiKey })
    ).text();
    expect(text).toContain("'=cmd()@example.com");
  });

  it("honours the status filter", async () => {
    const apiKey = await adminKey();
    const { body: list } = await createList(apiKey);
    const added = await (
      await authFetch(`/api/lists/${list.id}/members`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({ email: "gone@example.com" }),
      })
    ).json<any>();
    await authFetch(`/api/lists/${list.id}/members/${added.id}`, {
      apiKey,
      method: "DELETE",
    });

    const text = await (
      await authFetch(
        `/api/lists/${list.id}/members/export?status=subscribed`,
        { apiKey },
      )
    ).text();
    expect(text.trim().split("\r\n")).toHaveLength(1); // header only
  });
});

describe("CSV import endpoints", () => {
  function upload(apiKey: string, listId: string, csv: string) {
    return authFetch(`/api/lists/${listId}/members/import`, {
      apiKey,
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: csv,
    });
  }

  it("stores the upload, creates a job and returns 202 without parsing inline", async () => {
    const apiKey = await adminKey();
    const { body: list } = await createList(apiKey);

    const res = await upload(apiKey, list.id, "email\na@example.com\n");
    expect(res.status).toBe(202);
    const { jobId } = await res.json<any>();

    // The R2 object exists...
    const stored = await env.R2.get(sourceKey(jobId));
    expect(stored).not.toBeNull();

    // ...and the job is queued but untouched — a 10k import must not run inside
    // the request that accepted it.
    const jobs = await getDb().select().from(asyncJobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("running");
    expect(jobs[0].cursor).toBeNull();
    expect(jobs[0].refId).toBe(list.id);
    expect(await getDb().select().from(listMembers)).toHaveLength(0);
  });

  it("reports progress and errors on the status endpoint", async () => {
    const apiKey = await adminKey();
    const { body: list } = await createList(apiKey);
    const { jobId } = await (
      await upload(apiKey, list.id, "email\na@example.com\n")
    ).json<any>();

    const res = await authFetch(
      `/api/lists/${list.id}/members/import/${jobId}`,
      { apiKey },
    );
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body).toMatchObject({
      jobId,
      status: "running",
      importedCount: 0,
      errors: [],
    });
  });

  it("cancels a running job", async () => {
    const apiKey = await adminKey();
    const { body: list } = await createList(apiKey);
    const { jobId } = await (
      await upload(apiKey, list.id, "email\na@example.com\n")
    ).json<any>();

    const res = await authFetch(
      `/api/lists/${list.id}/members/import/${jobId}`,
      { apiKey, method: "DELETE" },
    );
    expect(res.status).toBe(200);
    expect((await res.json<any>()).status).toBe("cancelled");
  });

  it("refuses an import into an archived list", async () => {
    const apiKey = await adminKey();
    const { body: list } = await createList(apiKey);
    await getDb()
      .update(lists)
      .set({ archivedAt: Math.floor(Date.now() / 1000) })
      .where(eq(lists.id, list.id));

    const res = await upload(apiKey, list.id, "email\na@example.com\n");
    expect(res.status).toBe(409);
  });

  it("404s for a job belonging to another list", async () => {
    const apiKey = await adminKey();
    const { body: listA } = await createList(apiKey);
    const { body: listB } = await createList(apiKey, { name: "Other" });
    const { jobId } = await (
      await upload(apiKey, listA.id, "email\na@example.com\n")
    ).json<any>();

    // The job id is real, but it is not this list's job.
    const res = await authFetch(
      `/api/lists/${listB.id}/members/import/${jobId}`,
      { apiKey },
    );
    expect(res.status).toBe(404);
  });
});
