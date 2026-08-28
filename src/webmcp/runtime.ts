import type { WebMcpToolDescriptor } from "./types";

export type ModelContextLike = {
  registerTool(descriptor: object, opts?: { signal?: AbortSignal }): unknown;
};

let testOverride: ModelContextLike | null | undefined;

/** Test seam: force the resolved model context (null = "unavailable"). */
export function __setModelContextForTests(mc: ModelContextLike | null) {
  testOverride = mc;
}

function nativeModelContext(): ModelContextLike | null {
  const d = globalThis as any;
  return (d.document?.modelContext ??
    d.navigator?.modelContext ??
    null) as ModelContextLike | null;
}

let cached: ModelContextLike | null | undefined;

export async function getModelContext(): Promise<ModelContextLike | null> {
  if (testOverride !== undefined) return testOverride;
  if (cached !== undefined) return cached;

  const native = nativeModelContext();
  if (native) {
    cached = native;
    return cached;
  }
  // No native API — load the polyfill so an agent/extension can still connect.
  try {
    await import("@mcp-b/global");
    cached = nativeModelContext();
  } catch {
    cached = null;
  }
  return cached ?? null;
}

/**
 * Register one tool. Returns an unregister fn. If no model context is
 * available the call is a no-op and the returned fn does nothing, so callers
 * never need to branch on support.
 */
export async function registerTool(
  descriptor: WebMcpToolDescriptor,
): Promise<() => void> {
  const mc = await getModelContext();
  if (!mc) return () => {};
  const controller = new AbortController();
  mc.registerTool(descriptor as object, { signal: controller.signal });
  return () => controller.abort();
}
