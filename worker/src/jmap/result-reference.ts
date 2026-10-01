export type MethodResponse = [string, Record<string, unknown>, string];

type Reference = {
  resultOf: string;
  name: string;
  path: string;
};

type ResolveResult = { ok: true; value: unknown } | { ok: false };

function unescapePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolveTokens(value: unknown, tokens: string[]): ResolveResult {
  if (tokens.length === 0) return { ok: true, value };
  const [token, ...rest] = tokens;

  if (token === "*") {
    if (!Array.isArray(value)) return { ok: false };
    const result: unknown[] = [];
    for (const item of value) {
      const resolved = resolveTokens(item, rest);
      if (!resolved.ok) return resolved;
      if (Array.isArray(resolved.value)) result.push(...resolved.value);
      else result.push(resolved.value);
    }
    return { ok: true, value: result };
  }

  if (Array.isArray(value)) {
    if (!/^\d+$/.test(token)) return { ok: false };
    const index = Number(token);
    if (index < 0 || index >= value.length) return { ok: false };
    return resolveTokens(value[index], rest);
  }

  if (typeof value !== "object" || value === null) return { ok: false };
  if (!Object.prototype.hasOwnProperty.call(value, token)) return { ok: false };
  return resolveTokens((value as Record<string, unknown>)[token], rest);
}

function resolvePointer(value: unknown, path: string): ResolveResult {
  if (path === "") return { ok: true, value };
  if (!path.startsWith("/")) return { ok: false };
  return resolveTokens(
    value,
    path.slice(1).split("/").map(unescapePointerToken),
  );
}

function isReference(value: unknown): value is Reference {
  if (typeof value !== "object" || value === null) return false;
  const object = value as Record<string, unknown>;
  return (
    typeof object.resultOf === "string" &&
    typeof object.name === "string" &&
    typeof object.path === "string"
  );
}

export function applyResultReferences(
  input: Record<string, unknown>,
  responses: MethodResponse[],
): Record<string, unknown> | null {
  const args = { ...input };

  for (const [key, value] of Object.entries(input)) {
    if (!key.startsWith("#")) continue;
    const target = key.slice(1);
    if (!target || target in input || !isReference(value)) return null;

    const response = responses.find(
      ([name, , callId]) => callId === value.resultOf && name === value.name,
    );
    if (!response) return null;

    const resolved = resolvePointer(response[1], value.path);
    if (!resolved.ok) return null;

    delete args[key];
    args[target] = resolved.value;
  }

  return args;
}
