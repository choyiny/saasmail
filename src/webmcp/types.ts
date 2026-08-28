import type { McpResult } from "./result";

export interface WebMcpToolDescriptor {
  name: string;
  description: string;
  inputSchema: object; // JSON Schema
  execute: (args: any, opts: { signal: AbortSignal }) => Promise<McpResult>;
}
