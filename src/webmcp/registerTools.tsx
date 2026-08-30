import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { renderPreview } from "@/lib/template-syntax";
import {
  fetchGroupedPeople,
  fetchPerson,
  fetchPersonEmails,
  fetchConversationEmails,
  fetchEmail,
  fetchTemplates,
  fetchTemplate,
  fetchSequences,
  fetchSequence,
  fetchStats,
  searchEmails,
  markEmailRead,
  deleteEmail,
  replyToEmail,
} from "@/lib/api";
import { useWebMcpTools } from "./useWebMcpTool";
import { useWebMcpBridge } from "./bridge";
import { createReadTools } from "./tools/read";
import { createActionTools } from "./tools/actions";

// 12 read tools + 8 action tools. Pinned by
// src/webmcp/__tests__/registerTools.test.tsx so this can't silently drift
// from the tool factories it's built from.
export const WEBMCP_TOOL_COUNT = 20;

/**
 * Registers every WebMCP read + action tool with the runtime for the
 * lifetime this component is mounted. Wires the real api/auth/bridge deps
 * into the tool factories from ./tools/read and ./tools/actions. Renders
 * nothing.
 */
export function WebMcpTools({ enabled = true }: { enabled?: boolean }) {
  const bridge = useWebMcpBridge();
  const qc = useQueryClient();

  const tools = useMemo(() => {
    const invalidate = () => qc.invalidateQueries();
    const read = createReadTools({
      fetchGroupedPeople,
      fetchPerson,
      fetchPersonEmails,
      fetchConversationEmails,
      fetchEmail,
      fetchTemplates,
      fetchTemplate,
      fetchSequences,
      fetchSequence,
      fetchStats,
      searchEmails,
      getSession: () => authClient.getSession(),
    });
    const actions = createActionTools({
      bridge,
      fetchPerson,
      fetchEmail,
      markEmailRead,
      deleteEmail,
      replyToEmail,
      fetchTemplate,
      renderTemplate: (tpl, vars) => renderPreview(tpl, vars),
      invalidate,
    });
    return [...read, ...actions];
  }, [bridge, qc]);

  useWebMcpTools(tools, enabled);
  return null;
}
