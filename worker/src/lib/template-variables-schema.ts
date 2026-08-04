import { z } from "@hono/zod-openapi";

/**
 * A template variable value. Recursive so arrays of objects can reach
 * `{{#section}}` bodies; `z.lazy` is what lets the schema refer to itself.
 *
 * The `.openapi("TemplateValue")` name is required, not decorative: without a
 * registered ref id, `@asteasolutions/zod-to-openapi` has no way to stop
 * expanding a self-referencing lazy schema and either recurses forever while
 * building `/doc` or (depending on version) silently degrades to an opaque
 * `{}` schema. Naming it turns the self-reference into a proper
 * `$ref: '#/components/schemas/TemplateValue'` — verified against
 * `openapi-doc.test.ts` and `openapi-bootstrap.test.ts`.
 *
 * This lives in `lib/` rather than in a router because every route that
 * forwards `variables` to `renderTemplate` needs the identical shape AND the
 * identical depth guard. A second copy would also re-register the same
 * `TemplateValue` component name from a different schema object.
 */
export const templateValueSchema: z.ZodType<unknown> = z
  .lazy(() =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(templateValueSchema),
      z.record(z.string(), templateValueSchema),
    ]),
  )
  .openapi("TemplateValue");

/**
 * Maximum nesting depth allowed in a send request's `variables` payload.
 *
 * `templateValueSchema` is unbounded on its own: Zod's recursive descent
 * through a self-referencing `z.lazy` has no depth limit, so a payload of
 * only a few KB but thousands of levels deep blows Zod's own call stack —
 * a `RangeError` with no app-level `onError` handler to catch it, surfacing
 * as an unhandled 500 for any authenticated caller. A `.superRefine`
 * attached directly to the recursive schema does not help: Zod crashes
 * descending into the lazy schema before any refinement on it ever runs.
 *
 * The fix (`templateVariablesSchema` below) walks the raw, not-yet-parsed
 * value ITERATIVELY — an explicit stack, not a recursive function, so the
 * guard itself cannot be the thing that overflows — before Zod ever
 * descends into the recursive schema. 32 is generous: real templates nest a
 * handful of section/object levels at most.
 */
export const MAX_VARIABLE_DEPTH = 32;

/**
 * Iteratively finds the first depth (if any) that exceeds `maxDepth` in
 * `root`. Depth 0 is `root` itself; each array item or object property adds
 * one level. Returns `null` when every value is within bounds.
 */
function findExcessiveDepth(root: unknown, maxDepth: number): number | null {
  const stack: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 0 },
  ];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (depth > maxDepth) return depth;
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
    } else if (value !== null && typeof value === "object") {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        stack.push({
          value: (value as Record<string, unknown>)[key],
          depth: depth + 1,
        });
      }
    }
  }
  return null;
}

/**
 * The `variables` schema for every route that renders a template.
 *
 * Composed with `z.preprocess`, not `.superRefine().pipe(...)`. Both run the
 * depth guard before the recursive schema, but they differ in how
 * `@asteasolutions/zod-to-openapi` documents them: for a plain `.pipe(x)`,
 * the generator documents the PRE-pipe ("in") schema, which here is just
 * `z.record(z.string(), z.unknown())` — an unhelpful `{}` shape that drops
 * the `TemplateValue` ref entirely (verified against the real `/doc` output
 * while building this). `z.preprocess(fn, schema)` is internally the same
 * pipe machinery but with the check function on the "in" side wrapped as a
 * `ZodTransform`, and for exactly that shape the generator documents the
 * POST-pipe ("out") schema instead — `schema` here, i.e. the recursive,
 * named `templateValueSchema`. That's the one difference that makes this
 * composition preserve the OpenAPI component; confirmed against `/doc` in
 * `openapi-doc.test.ts`.
 *
 * The preprocess function returns `z.NEVER` on failure specifically so the
 * inner schema's own (recursive) parse never runs against the
 * still-too-deep raw value — returning the original value instead would
 * just move the crash one step later.
 */
export const templateVariablesSchema = z.preprocess(
  (raw, ctx) => {
    const excess = findExcessiveDepth(raw, MAX_VARIABLE_DEPTH);
    if (excess !== null) {
      ctx.addIssue({
        code: "custom",
        message: `Template variables are nested too deeply — the limit is ${MAX_VARIABLE_DEPTH} levels.`,
      });
      return z.NEVER;
    }
    return raw;
  },
  z.record(z.string(), templateValueSchema),
);
