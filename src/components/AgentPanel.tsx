import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  MessageSquarePlus,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import {
  createAgentSession,
  deleteAgentSession,
  fetchAgentSessions,
  fetchAgentStatus,
  updateAgentSession,
  type AgentSession,
  type AgentStatus,
} from "@/lib/api";
import { showToast } from "@/lib/toast";
import AgentChatSession from "@/agent/AgentChatSession";
import type { ComposePrefill } from "@/pages/ComposeModal";

interface AgentPanelProps {
  onClose: () => void;
  onOpenCompose: (prefill?: ComposePrefill, contextKey?: string) => void;
}

function newestFirst(sessions: AgentSession[]): AgentSession[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function titleFromFirstMessage(text: string): string {
  return text.trim().slice(0, 60);
}

function errorDescription(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

export default function AgentPanel({
  onClose,
  onOpenCompose,
}: AgentPanelProps) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [serviceError, setServiceError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchAgentStatus(), fetchAgentSessions()])
      .then(([nextStatus, result]) => {
        if (cancelled) return;
        setStatus(nextStatus);
        // A session created with New before this list arrived must survive
        // it, and stay the active one.
        const loadedIds = new Set(result.sessions.map((s) => s.id));
        setSessions((current) =>
          newestFirst([
            ...current.filter((s) => !loadedIds.has(s.id)),
            ...result.sessions,
          ]),
        );
        const firstOpen =
          newestFirst(result.sessions).find(
            (session) => session.archivedAt === null,
          )?.id ?? null;
        setActiveId((current) => current ?? firstOpen);
      })
      .catch((error) => {
        if (cancelled) return;
        const message = "Couldn't reach the agent service";
        setServiceError(message);
        showToast({
          kind: "error",
          message,
          description: errorDescription(error),
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleSessions = useMemo(
    () =>
      sessions.filter((session) =>
        showArchived ? true : session.archivedAt === null,
      ),
    [sessions, showArchived],
  );
  const activeSession =
    sessions.find((session) => session.id === activeId) ?? null;

  async function createSession() {
    try {
      const created = await createAgentSession();
      setSessions((current) => newestFirst([created, ...current]));
      setActiveId(created.id);
    } catch (error) {
      showToast({
        kind: "error",
        message: "Couldn't create agent session",
        description: errorDescription(error),
      });
    }
  }

  async function renameSession(session: AgentSession) {
    const next = window.prompt("Rename agent session", session.title ?? "");
    if (next === null) return;
    try {
      const updated = await updateAgentSession(session.id, {
        title: next.trim() || null,
      });
      setSessions((current) =>
        newestFirst(
          current.map((item) => (item.id === updated.id ? updated : item)),
        ),
      );
    } catch (error) {
      showToast({
        kind: "error",
        message: "Couldn't rename agent session",
        description: errorDescription(error),
      });
    }
  }

  async function archiveSession(session: AgentSession) {
    try {
      const updated = await updateAgentSession(session.id, {
        archived: session.archivedAt === null,
      });
      setSessions((current) =>
        newestFirst(
          current.map((item) => (item.id === updated.id ? updated : item)),
        ),
      );
      if (updated.archivedAt !== null && activeId === updated.id) {
        setActiveId(
          sessions.find(
            (item) => item.id !== updated.id && item.archivedAt === null,
          )?.id ?? null,
        );
      }
    } catch (error) {
      showToast({
        kind: "error",
        message: "Couldn't update agent session",
        description: errorDescription(error),
      });
    }
  }

  async function removeSession(session: AgentSession) {
    if (!window.confirm("Delete this agent session? This cannot be undone.")) {
      return;
    }
    try {
      await deleteAgentSession(session.id);
      setSessions((current) =>
        current.filter((item) => item.id !== session.id),
      );
      if (activeId === session.id) {
        setActiveId(
          sessions.find(
            (item) => item.id !== session.id && item.archivedAt === null,
          )?.id ?? null,
        );
      }
    } catch (error) {
      showToast({
        kind: "error",
        message: "Couldn't delete agent session",
        description: errorDescription(error),
      });
    }
  }

  async function titleSessionFromFirstMessage(sessionId: string, text: string) {
    const current = sessions.find((session) => session.id === sessionId);
    if (!current || current.title) return;
    const title = titleFromFirstMessage(text);
    if (!title) return;

    try {
      const updated = await updateAgentSession(sessionId, { title });
      setSessions((items) =>
        newestFirst(
          items.map((item) => (item.id === updated.id ? updated : item)),
        ),
      );
    } catch (error) {
      showToast({
        kind: "error",
        message: "Couldn't title agent session",
        description: errorDescription(error),
      });
    }
  }

  const composerDisabled =
    loading || serviceError !== null || !status?.configured || !activeSession;

  return (
    <aside
      data-agent-panel
      aria-label="Mail agent"
      className="fixed inset-0 z-[70] flex min-h-0 min-w-0 flex-col overflow-hidden border-l border-border bg-card md:sticky md:inset-x-auto md:bottom-auto md:top-16 md:z-auto md:h-[calc(100dvh-4rem)] md:w-[400px] md:shrink-0 md:self-start"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">
            Mail agent
          </h2>
          <p className="text-[11px] text-text-tertiary">
            {status?.configured
              ? `${status.provider} · ${status.model}`
              : "Assistant workspace"}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close mail agent"
          onClick={onClose}
          className="rounded-[6px] p-1.5 text-text-secondary hover:bg-bg-muted"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="shrink-0 border-b border-border p-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="agent-new-session"
            onClick={() => void createSession()}
            className="inline-flex items-center gap-1.5 rounded-[6px] bg-text-primary px-2.5 py-1.5 text-xs font-medium text-bg"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            New
          </button>
          <label className="ml-auto flex items-center gap-1.5 text-[11px] text-text-secondary">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            Show archived
          </label>
        </div>

        <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
          {visibleSessions.map((session) => (
            <div
              key={session.id}
              className={`flex items-center gap-1 rounded-[6px] px-1 py-1 ${
                activeId === session.id ? "bg-bg-muted" : ""
              }`}
            >
              <button
                type="button"
                onClick={() => setActiveId(session.id)}
                className="min-w-0 flex-1 truncate px-1.5 py-1 text-left text-xs text-text-primary"
              >
                {session.title || "New conversation"}
              </button>
              <button
                type="button"
                aria-label={`Rename ${session.title || "session"}`}
                onClick={() => void renameSession(session)}
                className="rounded p-1 text-text-tertiary hover:bg-card"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                type="button"
                aria-label={
                  session.archivedAt === null
                    ? `Archive ${session.title || "session"}`
                    : `Restore ${session.title || "session"}`
                }
                onClick={() => void archiveSession(session)}
                className="rounded p-1 text-text-tertiary hover:bg-card"
              >
                {session.archivedAt === null ? (
                  <Archive className="h-3 w-3" />
                ) : (
                  <ArchiveRestore className="h-3 w-3" />
                )}
              </button>
              <button
                type="button"
                aria-label={`Delete ${session.title || "session"}`}
                onClick={() => void removeSession(session)}
                className="rounded p-1 text-text-tertiary hover:bg-card"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
          {!loading && visibleSessions.length === 0 && (
            <p className="px-1 py-2 text-xs text-text-tertiary">
              No agent sessions yet.
            </p>
          )}
        </div>
      </div>

      {serviceError ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center">
          <div
            data-testid="agent-service-error"
            className="rounded-[6px] border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-text-secondary"
          >
            {serviceError}
          </div>
        </div>
      ) : status?.configured && activeSession ? (
        <AgentChatSession
          key={activeSession.instanceName}
          session={activeSession}
          onOpenCompose={onOpenCompose}
          onFirstUserMessage={titleSessionFromFirstMessage}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center">
            <p className="max-w-xs text-sm text-text-tertiary">
              {activeSession
                ? "Conversation messages will appear here."
                : "Create a session to start a conversation."}
            </p>
          </div>

          {!loading && status && !status.configured && (
            <div
              data-testid="agent-not-configured"
              className="mx-3 mb-2 rounded-[6px] border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-text-secondary"
            >
              The mail agent is not configured. Set ANTHROPIC_API_KEY or
              OPENAI_API_KEY as a Worker secret, or configure the Workers AI
              binding (Workers Paid). See docs/agent.md in the repository.
            </div>
          )}

          <div className="shrink-0 border-t border-border p-3">
            <textarea
              data-testid="agent-composer"
              aria-label="Message the mail agent"
              disabled={composerDisabled}
              placeholder={
                status?.configured
                  ? "Create a session to start chatting"
                  : "Configure an agent provider to start chatting"
              }
              className="min-h-20 w-full resize-none rounded-[6px] border border-border bg-bg px-3 py-2 text-sm text-text-primary outline-none disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
        </div>
      )}
    </aside>
  );
}
