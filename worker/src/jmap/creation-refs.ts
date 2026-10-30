/**
 * Creation references (RFC 8620 §3.3, §5.3). One map per request, from the
 * client's creation id (without "#") to the id the server assigned. Seeded
 * from the request's `createdIds`; every successful `/set` create is added.
 */
export type CreatedIds = Map<string, string>;

/**
 * "#c1" -> the id created for c1, or null when c1 is unknown. Values that
 * don't start with "#" are returned unchanged.
 */
export function resolveCreationRef(
  value: string,
  createdIds: CreatedIds,
): string | null {
  if (!value.startsWith("#")) return value;
  return createdIds.get(value.slice(1)) ?? null;
}

function resolveIdList(value: unknown, createdIds: CreatedIds): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) =>
    typeof item === "string"
      ? (resolveCreationRef(item, createdIds) ?? item)
      : item,
  );
}

/**
 * Replace references to creates from EARLIER calls in the id-typed method
 * arguments every method shares: `ids`, `destroy` and the keys of `update`.
 * Unknown references stay as they are, so the method reports them like any
 * unknown id. Property values inside create/update, and references to
 * creates earlier in the same call, are each /set's job: a creation id this
 * call's `create` reuses is left alone, because its creates run first (RFC
 * 8620 §5.3) and "#id" then means the new object.
 */
export function resolveCallCreationRefs(
  args: Record<string, unknown>,
  createdIds: CreatedIds,
): Record<string, unknown> {
  if (createdIds.size === 0) return args;
  const create =
    args.create && typeof args.create === "object" ? args.create : {};
  const earlier: CreatedIds = new Map(
    [...createdIds].filter(
      ([creationId]) =>
        !Object.prototype.hasOwnProperty.call(create, creationId),
    ),
  );
  const resolved: Record<string, unknown> = { ...args };
  if ("ids" in args) resolved.ids = resolveIdList(args.ids, earlier);
  if ("destroy" in args) {
    resolved.destroy = resolveIdList(args.destroy, earlier);
  }
  const update = args.update;
  if (update && typeof update === "object" && !Array.isArray(update)) {
    resolved.update = Object.fromEntries(
      Object.entries(update as Record<string, unknown>).map(([key, patch]) => [
        resolveCreationRef(key, earlier) ?? key,
        patch,
      ]),
    );
  }
  return resolved;
}

/** Add a /set response's creates to the map (a reused creation id is overwritten). */
export function recordCreated(
  result: Record<string, unknown>,
  createdIds: CreatedIds,
): void {
  const created = result.created;
  if (!created || typeof created !== "object" || Array.isArray(created)) {
    return;
  }
  for (const [creationId, object] of Object.entries(
    created as Record<string, unknown>,
  )) {
    const id =
      object && typeof object === "object"
        ? (object as { id?: unknown }).id
        : undefined;
    if (typeof id === "string") createdIds.set(creationId, id);
  }
}
