// worker/src/lib/multipart-send.ts
import { z } from "@hono/zod-openapi";
import type { ZodType } from "zod";
import type { Context } from "hono";
import { sanitizeFilename } from "./sanitize-filename";

export const MAX_ATTACHMENTS = 50;

export interface ParsedSendBody<T> {
  payload: T;
  files: ParsedFile[];
}

export interface ParsedFile {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  size: number;
}

export type SendParseError =
  | {
      kind: "invalid-payload";
      message: string;
    }
  | { kind: "too-many-files"; limit: number; provided: number }
  | { kind: "too-large"; limitBytes: number; providedBytes: number }
  | { kind: "missing-payload" };

/**
 * Parse a multipart/form-data body for the send routes.
 *
 * Expects:
 *   - `payload`: a single string field containing JSON to validate
 *     against `schema`.
 *   - `files`: zero or more file fields.
 *
 * Enforces MAX_ATTACHMENTS and a caller-supplied byte cap.
 */
export async function parseSendBody<T>(
  c: Context,
  schema: ZodType<T>,
  maxBytes: number,
): Promise<
  { ok: true; value: ParsedSendBody<T> } | { ok: false; err: SendParseError }
> {
  const form = await c.req.formData();

  const payloadRaw = form.get("payload");
  if (typeof payloadRaw !== "string") {
    return { ok: false, err: { kind: "missing-payload" } };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(payloadRaw);
  } catch (e) {
    return {
      ok: false,
      err: {
        kind: "invalid-payload",
        message: e instanceof Error ? e.message : "JSON parse failed",
      },
    };
  }

  const result = schema.safeParse(parsedJson);
  if (!result.success) {
    return {
      ok: false,
      err: {
        kind: "invalid-payload",
        message: result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
    };
  }

  const rawFiles = form
    .getAll("files")
    .filter((f): f is File => f instanceof File);
  if (rawFiles.length > MAX_ATTACHMENTS) {
    return {
      ok: false,
      err: {
        kind: "too-many-files",
        limit: MAX_ATTACHMENTS,
        provided: rawFiles.length,
      },
    };
  }

  let total = 0;
  const files: ParsedFile[] = [];
  for (const f of rawFiles) {
    total += f.size;
    if (total > maxBytes) {
      return {
        ok: false,
        err: {
          kind: "too-large",
          limitBytes: maxBytes,
          providedBytes: total,
        },
      };
    }
    const buf = new Uint8Array(await f.arrayBuffer());
    files.push({
      filename: sanitizeFilename(f.name || "unnamed"),
      contentType: f.type || "application/octet-stream",
      bytes: buf,
      size: buf.byteLength,
    });
  }

  return { ok: true, value: { payload: result.data, files } };
}

/** Translate a parse error into an HTTP response payload + status. */
export function sendParseErrorResponse(err: SendParseError): {
  status: 400 | 413;
  body: Record<string, unknown>;
} {
  switch (err.kind) {
    case "missing-payload":
      return { status: 400, body: { error: "Missing 'payload' field" } };
    case "invalid-payload":
      return {
        status: 400,
        body: { error: "Invalid payload", detail: err.message },
      };
    case "too-many-files":
      return {
        status: 400,
        body: {
          error: "Too many attachments",
          limit: err.limit,
          provided: err.provided,
        },
      };
    case "too-large":
      return {
        status: 413,
        body: {
          error: "Attachments exceed size limit",
          limitBytes: err.limitBytes,
          providedBytes: err.providedBytes,
        },
      };
  }
}

// Re-exported so `z` is available where we declare schemas inline.
export { z };
