import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { newsletterAssets } from "../db/newsletter-assets.schema";
import { readImageHeader } from "../lib/image-header";
import { isDemoMode } from "../lib/is-dev";
import type { Variables } from "../variables";

export const newsletterAssetsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

/** Ceiling on one image. Newsletter imagery, not a photo library. */
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;

/**
 * Public URL prefix for a stored asset. A constant rather than an inline
 * string so the eventual move to a dedicated asset hostname is one edit —
 * see the note in `public-assets-router.ts`.
 */
export const PUBLIC_ASSET_PATH = "/newsletter-images";

/** R2 key namespace, kept distinct from `attachments` in the shared bucket. */
export const assetKey = (id: string) => `newsletter-assets/${id}`;

/**
 * 128 bits of randomness, hex-encoded.
 *
 * The serve route performs no authorization, so this id is the only thing
 * standing between a stranger and someone's newsletter imagery. `nanoid()` is
 * used elsewhere in this codebase for row ids that sit behind an authenticated
 * endpoint; here the id *is* the access control, so it is generated from the
 * platform CSPRNG at full width.
 */
function assetId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const AssetResponse = z.object({
  id: z.string(),
  url: z.string(),
  contentType: z.string(),
  width: z.number(),
  height: z.number(),
  size: z.number(),
});

const uploadRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Newsletter assets"],
  description:
    "Upload an image for use in a block-authored newsletter template. Send the raw bytes as the request body. The format is determined from the file header, not from Content-Type. Returns a public, immutable URL.",
  request: {
    body: {
      content: { "application/octet-stream": { schema: z.string() } },
      description: "Raw image bytes (PNG, JPEG, GIF or WebP), max 5MB.",
    },
  },
  responses: {
    201: {
      description: "Stored, or an existing asset with identical bytes",
      content: { "application/json": { schema: AssetResponse } },
    },
    400: { description: "Not a supported image format" },
    403: { description: "Uploads are disabled in demo mode" },
    413: { description: "Image exceeds the 5MB limit" },
  },
});

newsletterAssetsRouter.openapi(uploadRoute, async (c) => {
  // A public upload endpoint on a demo deployment is an open file drop. Demo
  // instances cannot send mail anyway (`isDemoMode` short-circuits the queue),
  // so there is nothing legitimate to upload for.
  if (isDemoMode(c.env)) {
    return c.json({ error: "Uploads are disabled in demo mode" }, 403);
  }

  const db = c.get("db");
  const body = await c.req.arrayBuffer();

  if (body.byteLength === 0) {
    return c.json({ error: "Empty request body" }, 400);
  }
  if (body.byteLength > MAX_ASSET_BYTES) {
    return c.json({ error: "Image exceeds the 5MB limit" }, 413);
  }

  // The allowlist check and the dimension read are the same pass over the
  // header. A file whose bytes are not one of the four permitted formats is
  // refused here, before anything is written.
  const info = readImageHeader(new Uint8Array(body));
  if (!info) {
    return c.json(
      { error: "Unsupported image format — use PNG, JPEG, GIF or WebP" },
      400,
    );
  }

  const sha256 = await sha256Hex(body);
  const existing = await db
    .select()
    .from(newsletterAssets)
    .where(eq(newsletterAssets.sha256, sha256))
    .limit(1);

  if (existing[0]) {
    const row = existing[0];
    return c.json(
      {
        id: row.id,
        url: `${PUBLIC_ASSET_PATH}/${row.id}`,
        contentType: row.contentType,
        width: row.width,
        height: row.height,
        size: row.size,
      },
      201,
    );
  }

  const id = assetId();
  const key = assetKey(id);

  // Store the bytes first. A row pointing at an object that does not exist is
  // a broken image in a newsletter; an orphaned object is invisible.
  await c.env.R2.put(key, body, {
    httpMetadata: { contentType: info.contentType },
  });

  await db.insert(newsletterAssets).values({
    id,
    r2Key: key,
    contentType: info.contentType,
    size: body.byteLength,
    width: info.width,
    height: info.height,
    sha256,
    createdBy: c.get("user")?.id ?? "unknown",
    createdAt: Date.now(),
  });

  return c.json(
    {
      id,
      url: `${PUBLIC_ASSET_PATH}/${id}`,
      contentType: info.contentType,
      width: info.width,
      height: info.height,
      size: body.byteLength,
    },
    201,
  );
});
