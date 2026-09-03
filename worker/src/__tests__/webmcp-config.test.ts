import { beforeEach, describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { appSettings } from "../db/app-settings.schema";
import { applyPermissionsPolicyToHtml } from "../index";

beforeEach(async () => {
  await applyMigrations();
  await cleanDb();
});

describe("GET /api/config webmcpEnabled", () => {
  it("defaults to true when app_settings has no webmcp_enabled row", async () => {
    const res = await exports.default.fetch("http://localhost/api/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { webmcpEnabled: boolean };
    expect(body.webmcpEnabled).toBe(true);
  });

  it('is false when app_settings["webmcp_enabled"] is the literal string "false"', async () => {
    const db = getDb();
    await db.insert(appSettings).values({
      key: "webmcp_enabled",
      value: "false",
      updatedAt: Date.now(),
    });

    const res = await exports.default.fetch("http://localhost/api/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { webmcpEnabled: boolean };
    expect(body.webmcpEnabled).toBe(false);
  });

  it('stays true for any non-"false" value (only the literal string disables it)', async () => {
    const db = getDb();
    await db.insert(appSettings).values({
      key: "webmcp_enabled",
      value: "0",
      updatedAt: Date.now(),
    });

    const res = await exports.default.fetch("http://localhost/api/config");
    const body = (await res.json()) as { webmcpEnabled: boolean };
    expect(body.webmcpEnabled).toBe(true);
  });
});

// The SPA catch-all (`app.all("*")` in `worker/src/index.ts`) is supposed to
// attach `Permissions-Policy: tools=(self)` to HTML document responses. That
// can't be exercised end-to-end here: vitest-pool-workers runs against an
// empty `dist/client` directory (see `wrangler.jsonc.ci`, which the CI
// workflow copies over `wrangler.jsonc`, plus a `mkdir -p dist/client` step —
// there's no built SPA for the ASSETS binding to serve), so `GET /` returns a
// bare 404 with no `Content-Type` header rather than real HTML, regardless of
// what the header-setting code does. Verified by hand: fetching `/` in this
// test environment yields status 404, an empty body, and no `Content-Type`
// header at all.
//
// Instead, this tests the exact transform function the handler calls
// (`applyPermissionsPolicyToHtml`, exported from `../index`) directly against
// synthetic Response objects, which exercises the real production logic
// without depending on ASSETS serving real files.
describe("applyPermissionsPolicyToHtml", () => {
  it("adds Permissions-Policy: tools=(self) to text/html responses", () => {
    const htmlRes = new Response("<html></html>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });

    const result = applyPermissionsPolicyToHtml(htmlRes);

    expect(result.headers.get("Permissions-Policy")).toContain("tools=(self)");
  });

  it("leaves non-HTML responses untouched", () => {
    const jsRes = new Response("console.log(1)", {
      status: 200,
      headers: { "Content-Type": "application/javascript" },
    });

    const result = applyPermissionsPolicyToHtml(jsRes);

    expect(result.headers.get("Permissions-Policy")).toBeNull();
    expect(result).toBe(jsRes);
  });

  it("leaves responses with no Content-Type untouched", () => {
    const res = new Response("not found", { status: 404 });

    const result = applyPermissionsPolicyToHtml(res);

    expect(result.headers.get("Permissions-Policy")).toBeNull();
  });
});
