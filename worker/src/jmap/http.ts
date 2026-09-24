import type { OpenAPIHono } from "@hono/zod-openapi";
import { sanitizeFilename } from "../lib/sanitize-filename";
import { findReadableAttachment } from "../routers/attachments-router";
import type { Variables } from "../variables";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import { authenticateJmap, problem } from "./auth";
import {
  CORE_CAPABILITY,
  MAIL_CAPABILITY,
  MAX_CALLS_IN_REQUEST,
  MAX_SIZE_REQUEST,
  SUPPORTED_CAPABILITIES,
} from "./constants";
import { executeMethod, makeSession } from "./methods";
import { applyResultReferences, type MethodResponse } from "./result-reference";

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
  executor: typeof executeMethod = executeMethod,
): Promise<MethodResponse[]> {
  const methodResponses: MethodResponse[] = [];
  for (const [name, rawArgs, callId] of methodCalls) {
    if (name !== "Core/echo" && !using.includes(MAIL_CAPABILITY)) {
      methodResponses.push(["error", { type: "unknownMethod" }, callId]);
      continue;
    }

    const args = applyResultReferences(rawArgs, methodResponses);
    if (!args) {
      methodResponses.push([
        "error",
        { type: "invalidResultReference" },
        callId,
      ]);
      continue;
    }

    try {
      const result = await executor(db, allowed, user, name, args);
      if (result.ok) {
        methodResponses.push([result.name, result.result, callId]);
      } else {
        methodResponses.push(["error", result.error, callId]);
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
      await makeSession(c.get("db"), auth.allowed, auth.user),
    );
  });

  app.post("/jmap/api", async (c) => {
    const auth = await authenticateJmap(c.req.raw, c.env, c.get("db"));
    if (auth instanceof Response) return auth;

    const request = await readJmapRequest(c.req.raw);
    if (request instanceof Response) return request;

    const methodResponses = await executeJmapCalls(
      c.get("db"),
      auth.allowed,
      auth.user,
      request.using,
      request.methodCalls,
    );

    const session = await makeSession(c.get("db"), auth.allowed, auth.user);
    return jsonResponse({
      methodResponses,
      ...(request.createdIds ? { createdIds: request.createdIds } : {}),
      sessionState: session.state,
    });
  });

  app.get("/jmap/download/:accountId/:blobId/:name", async (c) => {
    const auth = await authenticateJmap(c.req.raw, c.env, c.get("db"));
    if (auth instanceof Response) return auth;

    if (c.req.param("accountId") !== auth.user.id) {
      return problem(404, "about:blank", "Not found");
    }

    const attachment = await findReadableAttachment(
      c.get("db"),
      auth.allowed,
      c.req.param("blobId"),
    );
    if (!attachment) {
      return problem(404, "about:blank", "Not found");
    }

    const object = await c.env.R2.get(attachment.r2Key);
    if (!object) {
      return problem(404, "about:blank", "Not found");
    }

    const safeFilename = sanitizeFilename(attachment.filename).replaceAll(
      '"',
      "_",
    );
    return new Response(object.body, {
      headers: {
        "Content-Type": attachment.contentType,
        "Content-Disposition": `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`,
        "Content-Length": attachment.size.toString(),
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
