import { useMemo } from "react";
import { authClient } from "@/lib/auth-client";
import { renderPreview } from "@/lib/template-syntax";
import {
  fetchGroupedPeople,
  fetchPerson,
  fetchPeople,
  fetchPersonEmails,
  fetchConversationEmails,
  fetchEmail,
  fetchTemplates,
  fetchTemplate,
  fetchSequences,
  fetchStats,
  searchEmails,
  fetchMessages,
  setMessageState,
  markEmailRead,
  saveDraft,
  enrollPerson,
  fetchLists,
  fetchList,
  fetchCampaigns,
  fetchCampaign,
} from "@/lib/api";
import { dispatchInboxRefresh } from "@/lib/inbox-events";
import { dispatchMailRefresh } from "@/lib/mail-events";
import { dispatchAgentPlan } from "@/lib/agent-plan";
import { useWebMcpTools } from "./useWebMcpTool";
import { useWebMcpBridge } from "./bridge";
import { createReadTools } from "./tools/read";
import { createActionTools } from "./tools/actions";
import { withActivity } from "./activity";
import { WebMcpActivityFeed } from "./WebMcpActivityFeed";

// 17 read tools + 9 action tools. Pinned by
// src/webmcp/__tests__/registerTools.test.tsx so this can't silently drift
// from the tool factories it's built from.
export const WEBMCP_TOOL_COUNT = 26;

/**
 * Registers every WebMCP read + action tool with the runtime for the
 * lifetime this component is mounted. Wires the real api/auth/bridge deps
 * into the tool factories from ./tools/read and ./tools/actions. Every tool
 * is wrapped in {@link withActivity} so its calls surface in the
 * bottom-right activity feed rendered here.
 */
export function WebMcpTools({ enabled = true }: { enabled?: boolean }) {
  const bridge = useWebMcpBridge();

  const tools = useMemo(() => {
    const read = createReadTools({
      fetchGroupedPeople,
      fetchPerson,
      fetchPersonEmails,
      fetchConversationEmails,
      fetchEmail,
      fetchTemplates,
      fetchTemplate,
      fetchSequences,
      fetchStats,
      searchEmails,
      fetchMessages,
      getSession: () => authClient.getSession(),
      fetchLists,
      fetchList,
      fetchCampaigns,
      fetchCampaign,
    });
    const actions = createActionTools({
      bridge,
      fetchPeople,
      fetchEmail,
      markEmailRead,
      setMessageState,
      enrollPerson,
      saveDraft,
      fetchTemplate,
      renderTemplate: (tpl, vars) => renderPreview(tpl, vars),
      refreshInbox: dispatchInboxRefresh,
      refreshMail: dispatchMailRefresh,
      showPlan: dispatchAgentPlan,
    });
    return [...read, ...actions].map(withActivity);
  }, [bridge]);

  useWebMcpTools(tools, enabled);
  return <WebMcpActivityFeed />;
}
