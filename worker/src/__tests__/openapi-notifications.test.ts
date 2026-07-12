import { describe, it, expect, beforeAll } from "vitest";
import { exports } from "cloudflare:workers";
import { applyMigrations } from "./helpers";

describe("OpenAPI notifications routes", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  it("GET /doc documents all /api/notifications paths", async () => {
    const res = await exports.default.fetch("http://localhost/doc");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      paths: Record<
        string,
        {
          get?: { tags?: string[]; security?: unknown };
          post?: { tags?: string[]; security?: unknown };
          delete?: { tags?: string[]; security?: unknown };
        }
      >;
    };

    const paths = Object.keys(doc.paths).filter((p) =>
      p.startsWith("/api/notifications"),
    );
    expect(paths.sort()).toEqual(
      [
        "/api/notifications/config",
        "/api/notifications/stream",
        "/api/notifications/subscribe",
        "/api/notifications/subscriptions",
        "/api/notifications/subscriptions/{id}",
      ].sort(),
    );

    for (const path of paths) {
      const op =
        doc.paths[path].get ?? doc.paths[path].post ?? doc.paths[path].delete;
      expect(op?.tags).toContain("Notifications");
      expect(op?.security).toEqual([{ BearerAuth: [] }]);
    }

    const stream = doc.paths["/api/notifications/stream"]?.get?.responses;
    expect(stream?.["426"]).toBeDefined();
    expect(stream?.["403"]).toBeDefined();
    expect(stream?.["101"]).toBeDefined();

    const subscribe =
      doc.paths["/api/notifications/subscribe"]?.post?.responses;
    expect(subscribe?.["201"]).toBeDefined();
    expect(subscribe?.["503"]).toBeDefined();
  });
});
