import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  authFetch,
  getDb,
} from "./helpers";
import { newsletterAssets } from "../db/newsletter-assets.schema";
import { MAX_ASSET_BYTES } from "../routers/newsletter-assets-router";

/** A minimal but structurally valid PNG header, padded to a given size. */
function pngBytes(width = 600, height = 315, pad = 0): Uint8Array {
  const be32 = (n: number) => [
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ];
  const head = [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    ...[..."IHDR"].map((c) => c.charCodeAt(0)),
    ...be32(width),
    ...be32(height),
    8,
    6,
    0,
    0,
    0,
  ];
  return new Uint8Array([...head, ...new Array(pad).fill(0)]);
}

const upload = (apiKey: string, body: BodyInit) =>
  authFetch("/api/newsletter-assets", {
    apiKey,
    method: "POST",
    body,
    headers: { "Content-Type": "application/octet-stream" },
  });

describe("newsletter assets", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  describe("POST /api/newsletter-assets", () => {
    it("stores an image and returns a public url with dimensions", async () => {
      const res = await upload(apiKey, pngBytes(600, 315));
      expect(res.status).toBe(201);

      const body = (await res.json()) as any;
      expect(body).toMatchObject({
        contentType: "image/png",
        width: 600,
        height: 315,
      });
      expect(body.url).toBe(`/newsletter-images/${body.id}`);

      const rows = await getDb().select().from(newsletterAssets);
      expect(rows).toHaveLength(1);
      expect(await env.R2.get(rows[0].r2Key)).not.toBeNull();
    });

    /**
     * The declared content type and the filename are attacker-controlled; the
     * bytes are not. A payload that claims to be a PNG must still be refused.
     */
    it("refuses HTML bytes regardless of the declared content type", async () => {
      const res = await authFetch("/api/newsletter-assets", {
        apiKey,
        method: "POST",
        body: "<!doctype html><script>alert(1)</script>",
        headers: { "Content-Type": "image/png" },
      });
      expect(res.status).toBe(400);
      expect(await getDb().select().from(newsletterAssets)).toHaveLength(0);
    });

    it("refuses SVG", async () => {
      const res = await upload(apiKey, '<svg onload="alert(1)"></svg>');
      expect(res.status).toBe(400);
    });

    it("refuses an empty body", async () => {
      expect((await upload(apiKey, new Uint8Array())).status).toBe(400);
    });

    it("refuses an oversize image with 413 and writes nothing", async () => {
      const tooBig = pngBytes(600, 315, MAX_ASSET_BYTES);
      const res = await upload(apiKey, tooBig);
      expect(res.status).toBe(413);
      expect(await getDb().select().from(newsletterAssets)).toHaveLength(0);
    });

    it("requires authentication", async () => {
      const res = await authFetch("/api/newsletter-assets", {
        method: "POST",
        body: pngBytes(),
      });
      expect(res.status).toBe(401);
    });

    it("reuses the existing row when the same bytes are uploaded twice", async () => {
      const first = (await (await upload(apiKey, pngBytes())).json()) as any;
      const second = (await (await upload(apiKey, pngBytes())).json()) as any;

      expect(second.id).toBe(first.id);
      expect(await getDb().select().from(newsletterAssets)).toHaveLength(1);
    });

    it("gives different bytes a different id", async () => {
      const a = (await (
        await upload(apiKey, pngBytes(600, 315))
      ).json()) as any;
      const b = (await (
        await upload(apiKey, pngBytes(601, 315))
      ).json()) as any;
      expect(b.id).not.toBe(a.id);
    });

    describe("demo mode", () => {
      beforeEach(() => {
        (env as any).DEMO_MODE = "1";
      });
      afterEach(() => {
        (env as any).DEMO_MODE = "0";
      });

      it("refuses uploads — a demo deploy would be an open file drop", async () => {
        const res = await upload(apiKey, pngBytes());
        expect(res.status).toBe(403);
        expect(await getDb().select().from(newsletterAssets)).toHaveLength(0);
      });
    });
  });

  /**
   * The serve route has no authorization at all: a subscriber's mail client
   * fetches it months after the send with no session and no API key. The id is
   * the only secret, and the response headers are the whole defence against
   * the bytes being interpreted as a document on our own origin.
   */
  describe("GET /newsletter-images/{id}", () => {
    it("serves the image with no credentials", async () => {
      const { id } = (await (await upload(apiKey, pngBytes())).json()) as any;

      const res = await authFetch(`/newsletter-images/${id}`);
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(pngBytes());
    });

    it("carries every hardening header", async () => {
      const { id } = (await (await upload(apiKey, pngBytes())).json()) as any;
      const res = await authFetch(`/newsletter-images/${id}`);

      expect(res.headers.get("Content-Type")).toBe("image/png");
      expect(res.headers.get("Content-Disposition")).toBe("inline");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Content-Security-Policy")).toContain(
        "default-src 'none'",
      );
      expect(res.headers.get("Cache-Control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });

    it("answers an unknown id with an empty 404", async () => {
      const res = await authFetch(
        "/newsletter-images/deadbeef".padEnd(40, "0"),
      );
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    });
  });

  /**
   * The id is the access control. `nanoid()` is used elsewhere for row ids that
   * sit behind an authenticated endpoint; here an id that is short, sequential
   * or time-ordered would make every operator's imagery walkable.
   */
  describe("ids are unguessable", () => {
    it("are 128 bits of hex with no shared prefix", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) {
        const res = await upload(apiKey, pngBytes(600, 300 + i));
        ids.push(((await res.json()) as any).id);
      }

      for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(new Set(ids).size).toBe(ids.length);
      // No two ids share even a two-character prefix by construction; assert
      // the population is spread rather than counter-like.
      expect(new Set(ids.map((i) => i.slice(0, 2))).size).toBeGreaterThan(6);
    });
  });
});
