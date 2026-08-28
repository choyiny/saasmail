import { useEffect } from "react";
import { registerTool } from "./runtime";
import type { WebMcpToolDescriptor } from "./types";

/**
 * Register one WebMCP tool for the lifetime of the calling component.
 * Registration is async (the runtime may lazy-load a polyfill); teardown
 * runs the unregister fn once it resolves, even if the component unmounted
 * first.
 */
export function useWebMcpTool(
  descriptor: WebMcpToolDescriptor,
  enabled: boolean = true,
): void {
  const { name } = descriptor;
  useEffect(() => {
    if (!enabled) return;
    let unregister: (() => void) | null = null;
    let cancelled = false;
    registerTool(descriptor).then((u) => {
      if (cancelled) u();
      else unregister = u;
    });
    return () => {
      cancelled = true;
      unregister?.();
    };
    // Re-register only when identity changes, not on every render. Tool
    // closures capture live deps (api/bridge) which are stable singletons.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, enabled]);
}

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
