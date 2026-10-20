import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  recordClick,
  recordOpen,
  resolveClickDestination,
  verifyClickToken,
  verifyOpenToken,
} from "../lib/campaign-tracking";
import type { Variables } from "../variables";

export const publicTrackRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

/**
 * A 1x1 transparent GIF, the smallest thing a mail client will render.
 *
 * Inlined as base64 rather than served from R2 or the asset pipeline: the
 * response has to be immediate and dependency-free, since a slow pixel shows
 * up as a slow-loading email.
 */
const PIXEL_BASE64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function pixelBytes(): Uint8Array {
  const bin = atob(PIXEL_BASE64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pixelResponse(): Response {
  return new Response(pixelBytes(), {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      // Minimises proxy caching so a second open has a chance to be seen. It
      // cannot defeat Apple Mail Privacy Protection, which pre-fetches every
      // pixel regardless — see the accuracy caveat in the docs.
      "Cache-Control": "no-store, must-revalidate",
      Pragma: "no-cache",
      "Content-Length": String(pixelBytes().length),
    },
  });
}

// --- GET /track/open/:token ---

const openRoute = createRoute({
  method: "get",
  path: "/open/{token}",
  tags: ["Tracking"],
  description:
    "Open-tracking pixel. Public and token-authenticated; always returns a 1x1 GIF.",
  request: { params: z.object({ token: z.string() }) },
  responses: {
    200: {
      description: "1x1 transparent GIF",
      content: { "image/gif": { schema: z.string() } },
    },
  },
});

publicTrackRouter.openapi(openRoute, async (c) => {
  const { token } = c.req.valid("param");
  const verified = await verifyOpenToken(token, c.env.UNSUBSCRIBE_SECRET);

  if (verified) {
    // The write is deferred so analytics never sit between the reader and
    // their image. Nothing downstream depends on it having landed.
    c.executionCtx.waitUntil(recordOpen(c.get("db"), verified));
  }

  // An unverified token still gets the GIF. There is no useful error to show
  // inside an email client, and a distinguishable response would confirm to a
  // prober which tokens are real.
  return pixelResponse();
});

// --- GET /track/click/:token ---

const clickRoute = createRoute({
  method: "get",
  path: "/click/{token}",
  tags: ["Tracking"],
  description:
    "Click-tracking redirect. Public and token-authenticated; resolves the destination server-side — the URL is never inside the token.",
  request: { params: z.object({ token: z.string() }) },
  responses: {
    302: { description: "Redirect to the destination URL" },
    404: { description: "Invalid token, or the link no longer exists" },
  },
});

publicTrackRouter.openapi(clickRoute, async (c) => {
  const { token } = c.req.valid("param");
  const verified = await verifyClickToken(token, c.env.UNSUBSCRIBE_SECRET);
  if (!verified) return c.text("Not found", 404);

  const db = c.get("db");
  // Resolved before responding — unlike the pixel, this one *is* the response.
  const destination = await resolveClickDestination(db, verified);
  if (!destination) return c.text("Not found", 404);

  c.executionCtx.waitUntil(recordClick(db, verified));

  return c.redirect(destination, 302);
});
