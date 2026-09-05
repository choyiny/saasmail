import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { newsletterAssets } from "../db/newsletter-assets.schema";
import type { Variables } from "../variables";

/**
 * Public delivery for newsletter images.
 *
 * The mount point is `/newsletter-images`, **not** `/assets`: Vite emits the
 * SPA bundle to `dist/client/assets/`, so a router there would sit on top of
 * the app's own JavaScript. Whichever of the two won would depend on static-
 * asset ordering, which is not a thing to leave to chance.
 *
 * It sits outside `/api`, so it never meets the session / passkey / inbox
 * middleware — the same placement `/track` and `/unsubscribe` use. A
 * subscriber's mail client fetches these with no credentials at all.
 *
 * Serving user-uploaded bytes from the application's own origin is a
 * stored-XSS surface. Three controls, all of which have to hold together:
 *
 *   1. The upload route allowlists four formats by **magic bytes**, so an HTML
 *      or SVG payload never reaches storage in the first place.
 *   2. The response carries the `Content-Type` recorded at upload — never one
 *      sniffed at serve time — plus `nosniff`, so a file that somehow slipped
 *      through cannot be re-interpreted as a document.
 *   3. A `Content-Security-Policy` of `default-src 'none'`, so even a document
 *      that did render would execute nothing.
 *
 * A separate asset hostname would be the strongest control and is deliberately
 * out of scope for v1: it needs DNS the operator must configure. The route is
 * written so the public base URL comes from configuration rather than from the
 * request host, which is what keeps that move cheap later.
 */
export const publicAssetsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const serveRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Newsletter assets"],
  description:
    "Serve a newsletter image. Public and unauthenticated — mail clients fetch these with no session. Immutable and cacheable for a year.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "The image bytes" },
    404: { description: "No such asset" },
  },
});

publicAssetsRouter.openapi(serveRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");

  // No distinction between "never existed" and "deleted": the id is the only
  // secret this route has, so the 404 must not confirm one for a wrong guess.
  const rows = await db
    .select()
    .from(newsletterAssets)
    .where(eq(newsletterAssets.id, id))
    .limit(1);

  const asset = rows[0];
  if (!asset) return c.body(null, 404);

  const object = await c.env.R2.get(asset.r2Key);
  if (!object) return c.body(null, 404);

  return new Response(object.body, {
    headers: {
      "Content-Type": asset.contentType,
      "Content-Length": String(asset.size),
      "Content-Disposition": "inline",
      // The bytes never change — the id is derived from randomness, and a
      // re-upload of different bytes gets a different id.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
});
