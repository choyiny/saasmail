export type McpResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export function ok(text: string): McpResult {
  return { content: [{ type: "text", text }] };
}

export function okJson(value: unknown): McpResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function fail(message: string): McpResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
