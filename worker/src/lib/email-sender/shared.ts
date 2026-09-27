export function parseFrom(input: string): { name?: string; address: string } {
  const match = input.match(/^\s*(.*)\s*<([^>]+)>\s*$/);
  if (match && match[2]) {
    const rawName = match[1].trim();
    const name =
      rawName.length >= 2 && rawName.startsWith('"') && rawName.endsWith('"')
        ? rawName.slice(1, -1).replace(/\\(["\\])/g, "$1")
        : rawName;
    return { name: name || undefined, address: match[2].trim() };
  }
  return { address: input.trim() };
}

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // btoa expects a binary string; chunk to avoid call-stack overflow on
  // large buffers.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(u8.subarray(i, i + chunk)),
    );
  }
  return btoa(binary);
}

/** A copy of `headers` without `name` (case-insensitive); undefined when empty. */
export function withoutHeader(
  headers: Record<string, string> | undefined,
  name: string,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  const entries = Object.entries(headers).filter(
    ([key]) => key.toLowerCase() !== lower,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Plain text as a minimal HTML body, for providers whose API has no text-only mode. */
export function textAsHtml(text: string | undefined): string {
  if (!text) return "";
  const escaped = text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<pre style="white-space:pre-wrap">${escaped}</pre>`;
}
