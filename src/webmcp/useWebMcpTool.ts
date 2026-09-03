import { useEffect } from "react";
import { registerTool } from "./runtime";
import type { WebMcpToolDescriptor } from "./types";

/**
 * Register a set of WebMCP tools for the lifetime of the calling component.
 * Registration is async (the runtime may lazy-load a polyfill); each tool's
 * unregister fn runs on unmount, even for tools whose registration resolves
 * after the component has already unmounted.
 */
export function useWebMcpTools(
  descriptors: WebMcpToolDescriptor[],
  enabled: boolean = true,
): void {
  const key = descriptors.map((d) => d.name).join(",");
  useEffect(() => {
    if (!enabled) return;
    const unregisters: Array<() => void> = [];
    let cancelled = false;
    Promise.all(
      descriptors.map((d) =>
        registerTool(d).then((u) => {
          if (cancelled) u();
          else unregisters.push(u);
        }),
      ),
    );
    return () => {
      cancelled = true;
      unregisters.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
}
