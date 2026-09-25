import { useEffect, useRef } from "react";
import type { UIMessage } from "ai";

type AgentSocket = {
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent) => void,
  ) => void;
  removeEventListener: (
    type: "message",
    listener: (event: MessageEvent) => void,
  ) => void;
  getHttpUrl: () => string;
};

/**
 * True when the server transcript extends the client's: same ids in the same
 * order, plus at least one message the client doesn't have yet.
 */
export function serverTranscriptIsAhead(
  client: UIMessage[],
  server: UIMessage[],
): boolean {
  if (server.length <= client.length) return false;
  return client.every((message, index) => message.id === server[index]?.id);
}

function getMessagesUrl(agent: AgentSocket): string | null {
  const raw = agent.getHttpUrl();
  if (!raw) return null;
  const url = new URL(raw);
  url.searchParams.delete("_pk");
  url.pathname += "/get-messages";
  return url.toString();
}

/**
 * A page that reloads while a turn is finishing can fetch its initial
 * transcript just before the server persists the answer, then connect after
 * the stream has ended. The resume handshake answers "none" and nothing else
 * tells the client about the new message, so the answer stays hidden until
 * the next reload. When the handshake reports no active stream and the last
 * message is an unanswered user turn, re-read the server transcript once and
 * adopt it if it is strictly ahead.
 */
export function useTranscriptCatchUp({
  agent,
  messages,
  setMessages,
  busy,
}: {
  agent: AgentSocket;
  messages: UIMessage[];
  setMessages: (messages: UIMessage[]) => void;
  busy: boolean;
}) {
  const latest = useRef({ messages, setMessages, busy });
  latest.current = { messages, setMessages, busy };

  useEffect(() => {
    if (typeof agent.addEventListener !== "function") return;
    let cancelled = false;
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let type: unknown;
      try {
        type = (JSON.parse(event.data) as { type?: unknown }).type;
      } catch {
        return;
      }
      if (type !== "cf_agent_stream_resume_none") return;
      const url = getMessagesUrl(agent);
      if (!url || latest.current.busy) return;
      // Only a transcript that ends on an unanswered user turn can be behind.
      if (latest.current.messages.at(-1)?.role !== "user") return;
      void fetch(url, { credentials: "include" })
        .then((response) => (response.ok ? response.json() : null))
        .then((server: unknown) => {
          if (cancelled || !Array.isArray(server)) return;
          const current = latest.current;
          if (current.busy) return;
          if (
            serverTranscriptIsAhead(current.messages, server as UIMessage[])
          ) {
            current.setMessages(server as UIMessage[]);
          }
        })
        .catch(() => {
          // Best effort: the next reload shows the persisted transcript.
        });
    };
    agent.addEventListener("message", onMessage);
    return () => {
      cancelled = true;
      agent.removeEventListener("message", onMessage);
    };
  }, [agent]);
}
