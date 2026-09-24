import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAgent } from "agents/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { ChevronDown, ChevronRight, RotateCcw, Square } from "lucide-react";
import { AgentMarkdown } from "@/agent/AgentMarkdown";
import { useAgentContext } from "@/agent/AgentContext";
import {
  fetchAgentApprovalSummary,
  fetchDraft,
  type AgentSession,
} from "@/lib/api";
import { showToast } from "@/lib/toast";
import type { ComposePrefill } from "@/pages/ComposeModal";

type OpenCompose = (prefill?: ComposePrefill, contextKey?: string) => void;

interface AgentChatSessionProps {
  session: AgentSession;
  onOpenCompose: OpenCompose;
  onFirstUserMessage: (sessionId: string, text: string) => void | Promise<void>;
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<UIMessage["parts"][number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

function fallbackReasoningIndexes(message: UIMessage): Set<number> {
  let lastToolIndex = -1;
  message.parts.forEach((part, index) => {
    if (isToolUIPart(part)) lastToolIndex = index;
  });

  const answerStart = lastToolIndex + 1;
  const answerParts = message.parts.slice(answerStart);
  if (
    answerParts.some(
      (part) => part.type === "text" && part.text.trim().length > 0,
    )
  ) {
    return new Set();
  }

  const indexes = new Set<number>();
  message.parts.forEach((part, index) => {
    if (
      index >= answerStart &&
      part.type === "reasoning" &&
      part.text.trim().length > 0
    ) {
      indexes.add(index);
    }
  });
  return indexes;
}

function jsonForDisplay(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  const limit = 4096;
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… [truncated]`;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function ToolBadge({
  part,
  onOpenCompose,
  onApproval,
}: {
  part: UIMessage["parts"][number];
  onOpenCompose: OpenCompose;
  onApproval: (response: { id: string; approved: boolean }) => void;
}) {
  const navigate = useNavigate();
  const { context } = useAgentContext();
  const [expanded, setExpanded] = useState(false);

  if (!isToolUIPart(part)) return null;

  const toolName = getToolName(part);
  const state = (part as { state?: string }).state;
  const input = (part as { input?: unknown }).input;
  const output = (part as { output?: unknown }).output;
  const errorText = (part as { errorText?: string }).errorText;
  const approval = record((part as { approval?: unknown }).approval);
  const approvalId = typeof approval?.id === "string" ? approval.id : null;
  const approvalDecision =
    typeof approval?.approved === "boolean" ? approval.approved : null;
  const hasApproval = approvalId !== null;
  const needsApproval = state === "approval-requested" && approvalId !== null;
  const status =
    state === "output-available"
      ? "done"
      : state === "output-error" || state === "output-denied"
        ? "error"
        : state === "approval-requested"
          ? "approval"
          : state === "approval-responded"
            ? approvalDecision
              ? "approved"
              : "denied"
            : "running";
  const outputRecord = record(output);
  const inputRecord = record(input);
  const [approvalSummary, setApprovalSummary] = useState<string | null>(null);
  const approvalBlocked = approvalSummary?.startsWith("Can't ") ?? false;

  useEffect(() => {
    if (!approvalId) return;

    let cancelled = false;
    setApprovalSummary(null);
    void fetchAgentApprovalSummary(toolName, inputRecord ?? {})
      .then(({ summary }) => {
        if (!cancelled) setApprovalSummary(summary);
      })
      .catch(() => {
        if (!cancelled) setApprovalSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [approvalId, inputRecord, toolName]);

  const draftMessageContext =
    toolName === "draft_message" && typeof outputRecord?.contextKey === "string"
      ? outputRecord.contextKey
      : null;
  const replyEmailId =
    toolName === "draft_reply" && typeof inputRecord?.emailId === "string"
      ? inputRecord.emailId
      : null;
  const existingDraft =
    toolName === "draft_reply" &&
    outputRecord?.saved === false &&
    outputRecord?.reason === "existing_draft";

  async function openReplyDraft() {
    if (!replyEmailId) return;
    try {
      const draft = await fetchDraft(`reply:${replyEmailId}`);
      const inbox =
        draft?.fromAddress ??
        (typeof outputRecord?.fromAddress === "string"
          ? outputRecord.fromAddress
          : context.inbox);
      if (!inbox) {
        throw new Error("The reply draft inbox could not be determined.");
      }
      navigate({
        pathname: `/mail/${encodeURIComponent(inbox)}/inbox`,
        search: `?m=${encodeURIComponent(`received:${replyEmailId}`)}&reply=1`,
      });
    } catch (error) {
      showToast({
        kind: "error",
        message: "Couldn't open draft",
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }

  return (
    <div className="my-2 rounded-[6px] border border-border bg-bg-muted/50 text-xs">
      <button
        type="button"
        data-testid={`agent-tool-${toolName}`}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-text-secondary"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span className="font-medium text-text-primary">{toolName}</span>
        <span className="ml-auto rounded-full border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
          {status}
        </span>
      </button>

      {hasApproval && (
        <div
          data-testid={`agent-approval-${toolName}`}
          className="space-y-2 border-t border-border px-2.5 py-2"
        >
          <p className="text-sm text-text-primary">
            {approvalSummary ??
              `${toolName} ${jsonForDisplay(inputRecord ?? {})}`}
          </p>
          {needsApproval && approvalId && (
            <div className="flex gap-2">
              {!approvalBlocked && (
                <button
                  type="button"
                  onClick={() => onApproval({ id: approvalId, approved: true })}
                  className="rounded-[6px] bg-text-primary px-2.5 py-1 font-medium text-bg"
                >
                  Approve
                </button>
              )}
              <button
                type="button"
                onClick={() => onApproval({ id: approvalId, approved: false })}
                className="rounded-[6px] border border-border bg-card px-2.5 py-1 font-medium text-text-primary"
              >
                {approvalBlocked ? "Dismiss" : "Deny"}
              </button>
            </div>
          )}
          {!needsApproval && approvalDecision !== null && (
            <p className="font-medium text-text-secondary">
              {approvalDecision ? "Approved" : "Denied"}
            </p>
          )}
        </div>
      )}

      {existingDraft && (
        <div className="border-t border-border px-2.5 py-2 text-text-secondary">
          Your existing draft was kept.
        </div>
      )}

      {(draftMessageContext || replyEmailId) && status === "done" && (
        <div className="border-t border-border px-2.5 py-2">
          <button
            type="button"
            onClick={() => {
              if (draftMessageContext) {
                onOpenCompose(undefined, draftMessageContext);
              } else {
                void openReplyDraft();
              }
            }}
            className="rounded-[6px] border border-border bg-card px-2 py-1 font-medium text-text-primary hover:bg-bg-muted"
          >
            Open draft
          </button>
        </div>
      )}

      {expanded && (
        <div className="space-y-2 border-t border-border p-2.5">
          <div>
            <p className="mb-1 font-medium text-text-tertiary">Args</p>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-card p-2 text-[10px] text-text-secondary">
              {jsonForDisplay(input)}
            </pre>
          </div>
          {(output !== undefined || errorText) && (
            <div>
              <p className="mb-1 font-medium text-text-tertiary">Result</p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-card p-2 text-[10px] text-text-secondary">
                {errorText ?? jsonForDisplay(output)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AgentChatSession({
  session,
  onOpenCompose,
  onFirstUserMessage,
}: AgentChatSessionProps) {
  const { context } = useAgentContext();
  const contextRef = useRef(context);
  contextRef.current = context;
  const [input, setInput] = useState("");

  const agent = useAgent({
    agent: "MailAgent",
    name: session.instanceName,
  });

  const {
    messages,
    sendMessage,
    stop,
    regenerate,
    error,
    status,
    isStreaming,
    addToolApprovalResponse,
  } = useAgentChat({
    agent,
    body: () => ({ context: contextRef.current }),
  });

  const busy = isStreaming || status === "submitted";

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    setInput("");
    if (!session.title) {
      void onFirstUserMessage(session.id, text);
    }
    sendMessage({
      role: "user",
      parts: [{ type: "text", text }],
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        data-testid="agent-transcript"
        className="smooth-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
      >
        {messages.length === 0 && (
          <div className="flex h-full min-h-32 items-center justify-center text-center text-xs text-text-tertiary">
            Ask about the current inbox, message, or customer.
          </div>
        )}

        {messages.map((message, messageIndex) => {
          const isCurrentStreamingMessage =
            messageIndex === messages.length - 1 &&
            (status === "submitted" || status === "streaming");
          const fallbackReasoning =
            message.role === "assistant" && !isCurrentStreamingMessage
              ? fallbackReasoningIndexes(message)
              : new Set<number>();

          return (
            <div
              key={message.id}
              className={
                message.role === "user"
                  ? "ml-8 rounded-[8px] bg-bg-muted p-2.5 text-sm text-text-primary"
                  : "mr-2 rounded-[8px] border border-border bg-card p-2.5"
              }
            >
              {message.role === "user" ? (
                <p className="whitespace-pre-wrap text-sm">
                  {messageText(message)}
                </p>
              ) : (
                message.parts.map((part, index) => {
                  if (part.type === "text") {
                    return (
                      <AgentMarkdown
                        key={`${message.id}-text-${index}`}
                        text={part.text}
                      />
                    );
                  }
                  if (
                    part.type === "reasoning" &&
                    fallbackReasoning.has(index)
                  ) {
                    return (
                      <AgentMarkdown
                        key={`${message.id}-reasoning-${index}`}
                        text={part.text}
                      />
                    );
                  }
                  if (isToolUIPart(part)) {
                    return (
                      <ToolBadge
                        key={
                          (part as { toolCallId?: string }).toolCallId ??
                          `${message.id}-tool-${index}`
                        }
                        part={part}
                        onOpenCompose={onOpenCompose}
                        onApproval={addToolApprovalResponse}
                      />
                    );
                  }
                  return null;
                })
              )}
            </div>
          );
        })}

        {error && (
          <div
            data-testid="agent-chat-error"
            className="rounded-[6px] border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-700"
          >
            {error.message}
          </div>
        )}
      </div>

      <form onSubmit={submit} className="shrink-0 border-t border-border p-3">
        <textarea
          data-testid="agent-composer"
          aria-label="Message the mail agent"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask about your mail…"
          className="min-h-20 w-full resize-none rounded-[6px] border border-border bg-bg px-3 py-2 text-sm text-text-primary outline-none"
        />
        <div className="mt-2 flex items-center justify-end gap-2">
          {error && (
            <button
              type="button"
              onClick={() => void regenerate()}
              className="inline-flex items-center gap-1 rounded-[6px] border border-border px-2.5 py-1.5 text-xs text-text-primary"
            >
              <RotateCcw className="h-3 w-3" />
              Retry
            </button>
          )}
          {busy && (
            <button
              type="button"
              onClick={() => void stop()}
              className="inline-flex items-center gap-1 rounded-[6px] border border-border px-2.5 py-1.5 text-xs text-text-primary"
            >
              <Square className="h-3 w-3" />
              Stop
            </button>
          )}
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
