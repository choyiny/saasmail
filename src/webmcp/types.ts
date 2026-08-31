import type { McpResult } from "./result";

export interface WebMcpToolDescriptor {
  name: string;
  description: string;
  inputSchema: object; // JSON Schema
  execute: (args: any, opts: { signal: AbortSignal }) => Promise<McpResult>;
  /**
   * Optional human phrase describing this specific call, shown in the activity
   * popup instead of the generic per-tool label. May resolve context (e.g. a
   * contact's name) asynchronously; if it throws, the generic label is used.
   */
  describe?: (args: any) => string | Promise<string>;
}
