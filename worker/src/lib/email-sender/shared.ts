export function parseFrom(input: string): { name?: string; address: string } {
  const match = input.match(/^\s*(.*)\s*<([^>]+)>\s*$/);
  if (match && match[2]) {
    // Trim before unquoting: the greedy capture keeps the space before `<`, so
    // a quoted name (see encodeDisplayName) would otherwise keep its closing quote.
    let name = match[1].trim();
    if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
      name = name.slice(1, -1).replace(/\\(.)/g, "$1");
    }
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
