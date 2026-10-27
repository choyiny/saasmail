import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { getModelContext } from "./runtime";

/**
 * Small header indicator. Shows whether the WebMCP tool surface is active in
 * this browser (native API present or polyfill loaded). Purely informational.
 */
export function WebMcpStatusBadge({ toolCount }: { toolCount: number }) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    let alive = true;
    getModelContext().then((mc) => alive && setActive(!!mc));
    return () => {
      alive = false;
    };
  }, []);
  if (!active) return null;
  return (
    <span
      className="hidden h-6 items-center gap-1.5 rounded-full border border-chrome-line px-2 text-[11px] font-medium text-chrome-dim md:inline-flex"
      title={`Your AI agent can use ${toolCount} saasmail tools on this page.`}
    >
      <Bot className="h-3 w-3" />
      WebMCP · {toolCount}
    </span>
  );
}
