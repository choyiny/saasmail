import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import app from "../index";
import { setupCodeHash } from "../lib/setup-code";
import { applyMigrations, cleanDb } from "./helpers";

const CODE = "ABCD-EFGH-JKMN-PQRS-TUVW";
const admin = {
  name: "Admin",
  email: "admin@example.com",
  password: "securepassword123",
};

// The test env bindings are fixed by the pool, so vars are overridden by
// handing the app a copy of the env.
function call(hash: string | undefined, path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { ...env, SETUP_CODE_HASH: hash } as unknown as CloudflareBindings,
    {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext,
  );
}

async function userCount() {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{
    n: number;
  }>();
  return r?.n ?? 0;
}

describe("setup code", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("hashes case-, dash- and whitespace-insensitively to lowercase hex SHA-256", async () => {
    const a = await setupCodeHash(CODE);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await setupCodeHash("abcdefghjkmnpqrstuvw")).toBe(a);
    expect(await setupCodeHash(" abcd-efgh jkmn-pqrs-tuvw \n")).toBe(a);
  });

  it("hashes a fixed vector shared with the installer CLI", async () => {
    expect(await setupCodeHash("ABCD-EFGH-JKMN-PQRS-TUVW")).toBe(
      "d1d5079c636ac8353aa6acc43178ca940837a4dbc13028a5d93376fff410df65",
    );
  });

  it("status says a code is required while the hash is set and nobody exists", async () => {
    const res = await call(await setupCodeHash(CODE), "/api/setup/status");
    expect(await res.json()).toEqual({
      setupRequired: true,
      codeRequired: true,
    });
  });

  it("rejects setup without the code", async () => {
    const res = await call(await setupCodeHash(CODE), "/api/setup", admin);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "The setup code is missing or wrong.",
    );
    expect(await userCount()).toBe(0);
  });

  it("rejects a wrong code", async () => {
    const res = await call(await setupCodeHash(CODE), "/api/setup", {
      ...admin,
      code: "ABCD-EFGH-JKMN-PQRS-TUVX",
    });
    expect(res.status).toBe(403);
    expect(await userCount()).toBe(0);
  });

  it("accepts the code in any case, with or without dashes", async () => {
    const res = await call(await setupCodeHash(CODE), "/api/setup", {
      ...admin,
      code: "abcdefghjkmnpqrstuvw",
    });
    expect(res.status).toBe(200);
    expect(await userCount()).toBe(1);
  });

  it("accepts a padded pasted code", async () => {
    const res = await call(await setupCodeHash(CODE), "/api/setup", {
      ...admin,
      code: " abcd-efgh-jkmn-pqrs-tuvw \n",
    });
    expect(res.status).toBe(200);
    expect(await userCount()).toBe(1);
  });

  it("an empty or whitespace-only hash counts as unset", async () => {
    for (const h of ["", "  \n", undefined]) {
      await cleanDb();
      const s = await call(h, "/api/setup/status");
      expect(((await s.json()) as { codeRequired: boolean }).codeRequired).toBe(
        false,
      );
      expect((await call(h, "/api/setup", admin)).status).toBe(200);
    }
  });

  it("codeRequired is false once an admin exists, and setup stays closed", async () => {
    const hash = await setupCodeHash(CODE);
    expect(
      (await call(hash, "/api/setup", { ...admin, code: CODE })).status,
    ).toBe(200);
    const s = (await (await call(hash, "/api/setup/status")).json()) as {
      setupRequired: boolean;
      codeRequired: boolean;
    };
    expect(s).toEqual({ setupRequired: false, codeRequired: false });
    // User count is checked before the code.
    const again = await call(hash, "/api/setup", admin);
    expect(again.status).toBe(403);
    expect(((await again.json()) as { error: string }).error).toBe(
      "Setup has already been completed",
    );
  });
});
