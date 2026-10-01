import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestUser,
  getDb,
} from "./helpers";
import { CORE_CAPABILITY, MAIL_CAPABILITY } from "../jmap/constants";
import {
  recordCreated,
  resolveCallCreationRefs,
  resolveCreationRef,
  type CreatedIds,
} from "../jmap/creation-refs";
import { executeJmapCalls } from "../jmap/http";
import type { JmapMethodContext, MethodResult } from "../jmap/methods";

const USING = [CORE_CAPABILITY, MAIL_CAPABILITY];

function context(seed: Record<string, string> = {}): JmapMethodContext {
  return {
    env: env as unknown as CloudflareBindings,
    createdIds: new Map(Object.entries(seed)),
  };
}

describe("creation-id helpers", () => {
  it("resolves known creation ids and leaves other values alone", () => {
    const ids: CreatedIds = new Map([["c1", "X1"]]);
    expect(resolveCreationRef("#c1", ids)).toBe("X1");
    expect(resolveCreationRef("#zz", ids)).toBeNull();
    expect(resolveCreationRef("#", ids)).toBeNull();
    expect(resolveCreationRef("plain", ids)).toBe("plain");
  });

  it("rewrites ids, destroy and update keys, and nothing else", () => {
    const ids: CreatedIds = new Map([["c1", "X1"]]);
    const args = {
      accountId: "#c1",
      ids: ["#c1", "#zz", "R1", 7],
      destroy: ["#c1"],
      update: { "#c1": { "keywords/$seen": true }, R2: {} },
      create: { k: { note: "#c1" } },
    };
    expect(resolveCallCreationRefs(args, ids)).toEqual({
      accountId: "#c1",
      ids: ["X1", "#zz", "R1", 7],
      destroy: ["X1"],
      update: { X1: { "keywords/$seen": true }, R2: {} },
      create: { k: { note: "#c1" } },
    });
    // The input is not mutated.
    expect(args.ids[0]).toBe("#c1");
  });

  it("leaves a reference to a creation id this same call reuses for the /set", () => {
    // RFC 8620 §5.3: creates run first, so "#c1" in this call's update or
    // destroy means this call's c1, not the c1 an earlier call created.
    const ids: CreatedIds = new Map([
      ["c1", "X1"],
      ["c2", "X2"],
    ]);
    const args = {
      create: { c1: {} },
      update: { "#c1": { "keywords/$flagged": true }, "#c2": {} },
      destroy: ["#c1", "#c2"],
    };
    expect(resolveCallCreationRefs(args, ids)).toEqual({
      create: { c1: {} },
      update: { "#c1": { "keywords/$flagged": true }, X2: {} },
      destroy: ["#c1", "X2"],
    });
  });

  it("keeps an update key named __proto__ as an ordinary entry", () => {
    const ids: CreatedIds = new Map([["c1", "X1"]]);
    const update = JSON.parse('{"__proto__": {"keywords/$seen": true}}');
    const resolved = resolveCallCreationRefs({ update }, ids);
    expect(Object.keys(resolved.update as object)).toEqual(["__proto__"]);
  });

  it("records created ids, the latest creation winning", () => {
    const ids: CreatedIds = new Map();
    recordCreated(
      { created: { c1: { id: "X1" }, bad: null, noId: { size: 1 } } },
      ids,
    );
    expect(Object.fromEntries(ids)).toEqual({ c1: "X1" });
    recordCreated({ created: { c1: { id: "X2" } } }, ids);
    expect(ids.get("c1")).toBe("X2");
    recordCreated({ created: null }, ids);
    recordCreated({}, ids);
    expect(ids.size).toBe(1);
  });
});

describe("executeJmapCalls creation references", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  function fakeExecutor(seen: Record<string, unknown>[]) {
    return async (
      _db: unknown,
      _allowed: unknown,
      _user: unknown,
      name: string,
      args: Record<string, unknown>,
    ): Promise<MethodResult> => {
      seen.push(args);
      if (name === "Foo/set") {
        return {
          ok: true,
          name,
          result: {
            created:
              args.create === "second"
                ? { c1: { id: "X2" } }
                : { c1: { id: "X1" } },
          },
        };
      }
      if (name === "Foo/fail") {
        return { ok: false, error: { type: "invalidArguments" } };
      }
      if (name === "Foo/get") {
        // A /get that happens to return `created` must not be recorded.
        return { ok: true, name, result: { created: { g1: { id: "G1" } } } };
      }
      return { ok: true, name, result: args };
    };
  }

  it("substitutes ids created by earlier calls and seeded ids", async () => {
    const seen: Record<string, unknown>[] = [];
    const ctx = context({ c0: "Y0" });
    await executeJmapCalls(
      getDb(),
      { isAdmin: true },
      { id: "u1" },
      USING,
      [
        ["Foo/set", { create: "first" }, "a"],
        ["Foo/echo", { ids: ["#c1", "#c0", "#zz"], destroy: ["#c1"] }, "b"],
      ],
      ctx,
      fakeExecutor(seen),
    );
    expect(seen[1]).toEqual({ ids: ["X1", "Y0", "#zz"], destroy: ["X1"] });
    expect(Object.fromEntries(ctx.createdIds)).toEqual({ c0: "Y0", c1: "X1" });
  });

  it("maps a reused creation id to the most recent record", async () => {
    const seen: Record<string, unknown>[] = [];
    const ctx = context();
    await executeJmapCalls(
      getDb(),
      { isAdmin: true },
      { id: "u1" },
      USING,
      [
        ["Foo/set", { create: "first" }, "a"],
        ["Foo/set", { create: "second" }, "b"],
        ["Foo/echo", { update: { "#c1": {} } }, "c"],
      ],
      ctx,
      fakeExecutor(seen),
    );
    expect(seen[2]).toEqual({ update: { X2: {} } });
  });

  it("records nothing from failed calls or non-/set responses", async () => {
    const ctx = context();
    await executeJmapCalls(
      getDb(),
      { isAdmin: true },
      { id: "u1" },
      USING,
      [
        ["Foo/fail", {}, "a"],
        ["Foo/get", {}, "b"],
      ],
      ctx,
      fakeExecutor([]),
    );
    expect(ctx.createdIds.size).toBe(0);
  });
});

describe("createdIds in the HTTP response", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  async function post(apiKey: string, body: Record<string, unknown>) {
    const response = await authFetch("/jmap/api", {
      method: "POST",
      apiKey,
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, any>;
  }

  it("echoes createdIds only when the request sent them", async () => {
    const { apiKey } = await createTestUser({ id: "aaa-refs" });
    const seeded = await post(apiKey, {
      using: USING,
      methodCalls: [["Core/echo", { ids: ["#k1"] }, "e"]],
      createdIds: { k1: "Z1" },
    });
    expect(seeded.createdIds).toEqual({ k1: "Z1" });
    // The seeded map resolves references in later calls.
    expect(seeded.methodResponses[0][1]).toEqual({ ids: ["Z1"] });

    const empty = await post(apiKey, {
      using: USING,
      methodCalls: [["Core/echo", {}, "e"]],
      createdIds: {},
    });
    expect(empty.createdIds).toEqual({});

    const absent = await post(apiKey, {
      using: USING,
      methodCalls: [["Core/echo", {}, "e"]],
    });
    expect(absent).not.toHaveProperty("createdIds");
  });
});
