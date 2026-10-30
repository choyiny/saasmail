import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { bearerSecurity } from "../lib/openapi-auth";
import {
  DEFAULT_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
  waitForTestMail,
} from "../lib/test-mail";
import type { Variables } from "../variables";

export const testMailRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const ErrorSchema = z.object({ error: z.string() });

/** One answer for "not yours" and "not a test inbox". */
const FORBIDDEN = "Not a test inbox you may read";

export const TestMailSchema = z.object({
  id: z.string().describe("The received message's id."),
  inbox: z.string(),
  detail: z
    .string()
    .nullable()
    .describe("The `+detail` of the address it was sent to, lowercased."),
  from: z.string().nullable(),
  subject: z.string().nullable(),
  receivedAt: z.number().int().describe("Epoch seconds."),
  text: z.string().nullable(),
  html: z.string().nullable(),
  links: z
    .array(z.string())
    .describe("http(s) URLs from the HTML hrefs and the text, at most 20."),
  codes: z
    .array(z.string())
    .describe("Runs of 4–8 digits in the subject and the text, at most 10."),
});

const waitRoute = createRoute({
  method: "get",
  path: "/wait",
  tags: ["Test mail"],
  security: bearerSecurity,
  description:
    "Wait for the first message to a test inbox that matches, up to `timeout` seconds. Answers 204 when none arrived in time. Refuses any inbox that is not a test inbox the caller may read (403). See docs/test-mail.md.",
  request: {
    query: z.object({
      inbox: z
        .string()
        .email()
        .describe("The test inbox's address (no +detail)."),
      detail: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Only mail sent to inbox's local+detail@ (any case)."),
      since: z.coerce
        .number()
        .int()
        .min(0)
        .describe("Epoch seconds: only mail received at or after it."),
      subject: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "Substring of the subject, case-insensitive for ASCII letters only (an accented letter matches in the case the mail uses).",
        ),
      from: z.string().email().optional().describe("Exact sender address."),
      timeout: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_WAIT_SECONDS)
        .optional()
        .describe(
          `Seconds, 1–${MAX_WAIT_SECONDS}. Default ${DEFAULT_WAIT_SECONDS}.`,
        ),
    }),
  },
  responses: {
    200: {
      description: "The first matching message",
      content: { "application/json": { schema: TestMailSchema } },
    },
    204: { description: "No matching message arrived before the timeout" },
    400: {
      description: "Invalid query",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Not a test inbox the caller may read",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

testMailRouter.openapi(waitRoute, async (c) => {
  const q = c.req.valid("query");
  const result = await waitForTestMail(
    c.get("db"),
    c.get("allowedInboxes")!,
    {
      inbox: q.inbox,
      detail: q.detail,
      since: q.since,
      subject: q.subject,
      from: q.from,
      timeout: q.timeout ?? DEFAULT_WAIT_SECONDS,
    },
    { signal: c.req.raw.signal },
  );
  if (result.error) return c.json({ error: FORBIDDEN }, 403);
  if (!result.message) return c.body(null, 204);
  return c.json(result.message, 200);
});
