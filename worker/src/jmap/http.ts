import { collectAudit } from "../lib/audit/record";
import { jmapActor } from "../lib/audit/actors";
import { runWithAudit } from "../lib/audit/context";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Variables } from "../variables";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import { createEmailSender } from "../lib/email-sender";
import { authenticateJmap, problem } from "./auth";
import {
  CORE_CAPABILITY,
  MAIL_CAPABILITY,
  MAX_CALLS_IN_REQUEST,
  MAX_SIZE_REQUEST,
  SUBMISSION_CAPABILITY,
  SUPPORTED_CAPABILITIES,
} from "./constants";
import { executeMethod, makeSession, type JmapMethodContext } from "./methods";
import { openEventSource } from "./event-source";
import { publicAccountId } from "./public-ids";
import { applyResultReferences, type MethodResponse } from "./result-reference";
import { recordCreated, resolveCallCreationRefs } from "./creation-refs";
import {
  parseDeclaredLength,
  storeUpload,
  uploadTooLargeProblem,
} from "./upload";
import {
  downloadContentType,
  downloadFilename,
  resolveReadableBlob,
} from "./blobs";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function requestError(
  status: number,
  type: string,
  title: string,
  detail?: string,
  extra: Record<string, unknown> = {},
): Response {
  return problem(
    status,
    `urn:ietf:params:jmap:error:${type}`,
    title,
    detail,
    extra,
  );
}

export function configuredOrigins(env: CloudflareBindings): Set<string> {
  const values = [
    env.BASE_URL,
    ...String(env.TRUSTED_ORIGINS ?? "").split(","),
  ];
  const origins = new Set<string>();
  for (const value of values) {
    const candidate = String(value).trim();
    if (!candidate) continue;
    try {
      origins.add(new URL(candidate).origin);
    } catch {
      // Ignore malformed configuration entries; they cannot authorize an Origin.
    }
  }
  return origins;
}

export function validateJmapPostRequest(
  request: Request,
  env: CloudflareBindings,
  authMethod: "session" | "apiKey",
): Response | null {
  if (authMethod !== "session") return null;

  const mediaType = request.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return requestError(
      400,
      "notJSON",
      "Invalid JSON",
      "Session-authenticated JMAP requests require Content-Type application/json.",
    );
  }

  const origin = request.headers.get("Origin");
  if (origin && !configuredOrigins(env).has(origin)) {
    return problem(
      403,
      "about:blank",
      "Forbidden",
      "The request Origin is not trusted.",
    );
  }

  return null;
}

/**
 * Uploads are not JSON, so the API guard doesn't fit. A session cookie is
 * ambient authority: require an Origin, and a trusted one (spec §6). Bearer
 * callers are not browsers and may omit it.
 */
export function validateJmapUploadOrigin(
  request: Request,
  env: CloudflareBindings,
  authMethod: "session" | "apiKey",
): Response | null {
  if (authMethod !== "session") return null;
  const origin = request.headers.get("Origin");
  if (!origin || !configuredOrigins(env).has(origin)) {
    return problem(
      403,
      "about:blank",
      "Forbidden",
      "Session-authenticated uploads require a trusted Origin.",
    );
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateMethodCall(
  value: unknown,
): value is [string, Record<string, unknown>, string] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    typeof value[0] === "string" &&
    isObject(value[1]) &&
    typeof value[2] === "string"
  );
}

async function readJmapRequest(request: Request): Promise<
  | {
      using: string[];
      methodCalls: [string, Record<string, unknown>, string][];
      createdIds?: Record<string, string>;
    }
  | Response
> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength) {
    const size = Number(declaredLength);
    if (Number.isFinite(size) && size > MAX_SIZE_REQUEST) {
      return requestError(
        413,
        "requestTooLarge",
        "Request too large",
        `JMAP requests are limited to ${MAX_SIZE_REQUEST} bytes.`,
      );
    }
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_SIZE_REQUEST) {
    return requestError(
      413,
      "requestTooLarge",
      "Request too large",
      `JMAP requests are limited to ${MAX_SIZE_REQUEST} bytes.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return requestError(400, "notJSON", "Invalid JSON");
  }
  if (!isObject(parsed)) {
    return requestError(400, "notRequest", "Invalid JMAP request");
  }

  const using = parsed.using;
  const methodCalls = parsed.methodCalls;
  const createdIds = parsed.createdIds;
  if (
    !Array.isArray(using) ||
    !using.every((capability) => typeof capability === "string") ||
    !Array.isArray(methodCalls) ||
    !methodCalls.every(validateMethodCall) ||
    (createdIds !== undefined &&
      (!isObject(createdIds) ||
        !Object.values(createdIds).every((id) => typeof id === "string")))
  ) {
    return requestError(400, "notRequest", "Invalid JMAP request");
  }

  if (methodCalls.length > MAX_CALLS_IN_REQUEST) {
    return requestError(
      400,
      "limit",
      "Request limit exceeded",
      `A request may contain at most ${MAX_CALLS_IN_REQUEST} method calls.`,
      { limit: "maxCallsInRequest" },
    );
  }

  const unknownCapability = using.find(
    (capability) => !SUPPORTED_CAPABILITIES.has(capability),
  );
  if (unknownCapability) {
    return requestError(
      400,
      "unknownCapability",
      "Unknown capability",
      `Unsupported JMAP capability: ${unknownCapability}`,
    );
  }

  if (!using.includes(CORE_CAPABILITY)) {
    return requestError(
      400,
      "unknownCapability",
      "Core capability required",
      `${CORE_CAPABILITY} must be listed in using.`,
    );
  }

  return {
    using: using as string[],
    methodCalls: methodCalls as [string, Record<string, unknown>, string][],
    ...(createdIds ? { createdIds: createdIds as Record<string, string> } : {}),
  };
}

export async function executeJmapCalls(
  db: Variables["db"],
  allowed: AllowedInboxes,
  user: any,
  using: string[],
  methodCalls: [string, Record<string, unknown>, string][],
  ctx: JmapMethodContext,
  executor: typeof executeMethod = executeMethod,
): Promise<MethodResponse[]> {
  const methodResponses: MethodResponse[] = [];
  for (const [name, rawArgs, callId] of methodCalls) {
    if (name !== "Core/echo" && !using.includes(MAIL_CAPABILITY)) {
      methodResponses.push(["error", { type: "unknownMethod" }, callId]);
      continue;
    }

    // RFC 8621 §2: a method whose capability isn't in `using` is unknown.
    // `Identity/get` stays on `mail`, so only the submission methods move.
    if (
      (name.startsWith("EmailSubmission/") || name === "Identity/set") &&
      !using.includes(SUBMISSION_CAPABILITY)
    ) {
      methodResponses.push(["error", { type: "unknownMethod" }, callId]);
      continue;
    }

    const referenced = applyResultReferences(rawArgs, methodResponses);
    if (!referenced) {
      methodResponses.push([
        "error",
        { type: "invalidResultReference" },
        callId,
      ]);
      continue;
    }
    // Creates from earlier calls (RFC 8620 §5.3); each /set handles its own
    // same-call references.
    const args = resolveCallCreationRefs(referenced, ctx.createdIds);

    try {
      const result = await executor(db, allowed, user, name, args, ctx);
      if ("error" in result) {
        methodResponses.push(["error", result.error, callId]);
      } else {
        methodResponses.push([result.name, result.result, callId]);
        if (result.name.endsWith("/set") || result.name === "Email/import") {
          recordCreated(result.result, ctx.createdIds);
        }
        // RFC 8621 §7.5: the implicit Email/set answers after the
        // EmailSubmission/set response, under the same method call id.
        for (const followUp of result.followUps ?? []) {
          methodResponses.push([followUp.name, followUp.result, callId]);
        }
      }
    } catch {
      methodResponses.push(["error", { type: "serverFail" }, callId]);
    }
  }
  return methodResponses;
}

export function registerJmapRoutes(
  app: OpenAPIHono<{
    Bindings: CloudflareBindings;
    Variables: Variables;
  }>,
): void {
  app.get("/.well-known/jmap", async (c) => {
    const auth = await authenticateJmap(c.req.raw, c.env, c.get("db"));
    if (auth instanceof Response) return auth;
    return jsonResponse(
      await makeSession(
        c.get("db"),
        auth.allowed,
        auth.user,
        c.env,
        new URL(c.req.url).origin,
      ),
    );
  });

  // The advertised template ends with a slash; accept both spellings.
  for (const path of ["/jmap/eventsource/", "/jmap/eventsource"]) {
    app.get(path, async (c) => {
      let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
      try {
        const ctx = c.executionCtx;
        waitUntil = (promise) => ctx.waitUntil(promise);
      } catch {
        // No execution context (some test harnesses): the stream still runs.
      }
      return openEventSource(c.req.raw, c.env, { waitUntil });
    });
  }

  app.post("/jmap/api", async (c) => {
    const auth = await authenticateJmap(c.req.raw, c.env, c.get("db"));
    if (auth instanceof Response) return auth;

    const requestGuard = validateJmapPostRequest(
      c.req.raw,
      c.env,
      auth.authMethod,
    );
    if (requestGuard) return requestGuard;

    const request = await readJmapRequest(c.req.raw);
    if (request instanceof Response) return request;

    const ctx: JmapMethodContext = {
      env: c.env,
      createdIds: new Map(Object.entries(request.createdIds ?? {})),
    };
    // Sends and state changes made by these calls are audited as this client.
    // Email/set changes one message per service call; the rows of one request
    // are merged into one per kind.
    const methodResponses = await runWithAudit(jmapActor(auth, c.req.raw), () =>
      collectAudit(c.get("db"), () =>
        executeJmapCalls(
          c.get("db"),
          auth.allowed,
          auth.user,
          request.using,
          request.methodCalls,
          ctx,
        ),
      ),
    );

    const session = await makeSession(
      c.get("db"),
      auth.allowed,
      auth.user,
      c.env,
      new URL(c.req.url).origin,
    );
    return jsonResponse({
      methodResponses,
      // RFC 8620 §3.4: only when the request sent createdIds, with every
      // id it passed plus the ones created here.
      ...(request.createdIds
        ? { createdIds: Object.fromEntries(ctx.createdIds) }
        : {}),
      sessionState: session.state,
    });
  });

  // Hono is strict about trailing slashes, and the advertised template ends
  // with one, so register both spellings.
  for (const path of ["/jmap/upload/:accountId", "/jmap/upload/:accountId/"]) {
    app.post(path, async (c) => {
      const auth = await authenticateJmap(c.req.raw, c.env, c.get("db"));
      if (auth instanceof Response) return auth;

      const originGuard = validateJmapUploadOrigin(
        c.req.raw,
        c.env,
        auth.authMethod,
      );
      if (originGuard) return originGuard;

      const accountId = publicAccountId(auth.user.id);
      if (c.req.param("accountId") !== accountId) {
        return problem(
          403,
          "about:blank",
          "Forbidden",
          "Uploads are only accepted for your own account.",
        );
      }

      const result = await storeUpload(c.get("db"), c.env, {
        userId: auth.user.id,
        accountId,
        contentType: c.req.header("Content-Type") ?? null,
        declaredLength: parseDeclaredLength(c.req.header("Content-Length")),
        body: c.req.raw.body,
        maxBytes: createEmailSender(c.env).maxAttachmentBytes(),
      });
      if (result.tooLargeLimit !== null) {
        return uploadTooLargeProblem(result.tooLargeLimit);
      }
      return jsonResponse(result.blob, 201);
    });
  }

  app.get("/jmap/download/:accountId/:blobId/:name", async (c) => {
    const auth = await authenticateJmap(c.req.raw, c.env, c.get("db"));
    if (auth instanceof Response) return auth;

    if (c.req.param("accountId") !== publicAccountId(auth.user.id)) {
      return problem(404, "about:blank", "Not found");
    }

    const blob = await resolveReadableBlob(
      c.get("db"),
      auth.allowed,
      auth.user.id,
      c.req.param("blobId"),
    );
    if (!blob) return problem(404, "about:blank", "Not found");

    // Strict mode is off: read the union through an explicit shape.
    const source = blob.source as { r2Key?: string; bytes?: Uint8Array };
    let body: BodyInit;
    let length: number;
    if (source.bytes) {
      body = source.bytes as BodyInit;
      length = source.bytes.byteLength;
    } else {
      const object = await c.env.R2.get(source.r2Key!);
      if (!object) return problem(404, "about:blank", "Not found");
      body = object.body;
      length = object.size;
    }

    const filename = downloadFilename(c.req.param("name"), blob.name);
    return new Response(body, {
      headers: {
        "Content-Type": downloadContentType(c.req.query("type"), blob.type),
        "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Content-Length": length.toString(),
        "Cache-Control": "private, immutable, max-age=31536000",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
