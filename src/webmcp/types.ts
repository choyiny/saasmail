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
   * Use this for one-off actions. For tools that fire in bursts, prefer
   * `group` + `subject` so the popup collapses them into one card.
   */
  describe?: (args: any) => string | Promise<string>;
  /**
   * Static header for grouping. When set, concurrent calls to this tool are
   * collapsed into a single card titled with this text, one bullet per call
   * (see `subject`). Known up front so the card groups from the first frame.
   */
  group?: string;
  /**
   * Per-call bullet text under a grouped card — e.g. the contact being read.
   * May resolve asynchronously; only used when `group` is set.
   */
  subject?: (args: any) => string | Promise<string>;
}
