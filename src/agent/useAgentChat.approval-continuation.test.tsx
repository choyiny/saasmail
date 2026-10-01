import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { useAgent } from "agents/react";
import { isToolUIPart, type UIMessage } from "ai";
import { useAgentChat } from "@cloudflare/ai-chat/react";

function createFakeAgent() {
  const target = new EventTarget();
  const sent: string[] = [];
  const url = "ws://localhost:3000/agents/mail-agent/qa-r1?_pk=qa-r1";
  const name = "qa-r1";
  const agent = {
    _pkurl: url,
    _pk: name,
    _url: null as string | null,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    send: (data: string) => sent.push(data),
    close: () => {},
    agent: "MailAgent",
    id: "fake-agent",
    name,
    path: [{ agent: "MailAgent", name }],
    getHttpUrl: () => "http://localhost:3000/agents/mail-agent/qa-r1",
  } as unknown as ReturnType<typeof useAgent>;

  return { agent, target, sent };
}

function dispatch(target: EventTarget, data: Record<string, unknown>) {
  target.dispatchEvent(
    new MessageEvent("message", { data: JSON.stringify(data) }),
  );
}

function textOf(message: UIMessage | undefined) {
  return (
    message?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("") ?? ""
  );
}

describe("useAgentChat approval continuation", () => {
  it("continues an approved tool in the existing assistant message", async () => {
    const { agent, target, sent } = createFakeAgent();
    const toolCallId =
      "functions.assign_conversation:3::cf-wai-tool-call::qa-r1";
    const initialMessages: UIMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Assign it" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-assign_conversation",
            toolCallId,
            state: "approval-requested",
            input: { inbox: "support@example.com", personId: "person-1" },
            approval: { id: "approval-r1" },
          },
        ],
      },
    ];

    function Harness() {
      const chat = useAgentChat({
        agent,
        // Seed the transcript synchronously: an async getInitialMessages makes
        // useAgentChat suspend, and CI can time out on the Suspense fallback.
        getInitialMessages: null,
        messages: initialMessages,
        resume: false,
      });
      const assistant = chat.messages.find(
        (message) => message.id === "assistant-1",
      );
      const tool = assistant?.parts.find(
        (part) =>
          isToolUIPart(part) &&
          (part as { toolCallId?: string }).toolCallId === toolCallId,
      ) as { state?: string } | undefined;

      return (
        <div>
          <button
            type="button"
            onClick={() =>
              chat.addToolApprovalResponse({
                id: "approval-r1",
                approved: true,
              })
            }
          >
            Approve
          </button>
          <div data-testid="chat-error">{chat.error?.message ?? ""}</div>
          <div data-testid="tool-state">{tool?.state ?? ""}</div>
          <div data-testid="answer">{textOf(assistant)}</div>
          <div data-testid="assistant-count">
            {
              chat.messages.filter((message) => message.role === "assistant")
                .length
            }
          </div>
          {chat.error && <button type="button">Retry</button>}
        </div>
      );
    }

    render(<Harness />);

    await waitFor(() =>
      expect(screen.getByTestId("tool-state").textContent).toBe(
        "approval-requested",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      const types = sent.map((frame) => JSON.parse(frame).type as string);
      expect(types).toContain("cf_agent_tool_approval");
      expect(types).toContain("cf_agent_stream_resume_request");
    });

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_message_updated",
        message: {
          id: "assistant-1",
          role: "assistant",
          parts: [
            {
              type: "tool-assign_conversation",
              toolCallId,
              state: "approval-responded",
              input: { inbox: "support@example.com", personId: "person-1" },
              approval: { id: "approval-r1", approved: true },
            },
          ],
        },
      });
      dispatch(target, { type: "cf_agent_stream_pending" });
      dispatch(target, { type: "cf_agent_stream_resuming", id: "resume-r1" });
      await Promise.resolve();
    });

    await waitFor(() => {
      const frames = sent.map((frame) => JSON.parse(frame));
      expect(
        frames.some(
          (frame) =>
            frame.type === "cf_agent_stream_resume_ack" &&
            frame.id === "resume-r1",
        ),
      ).toBe(true);
    });

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "resume-r1",
        continuation: true,
        replay: true,
        body: JSON.stringify({ type: "start" }),
        done: false,
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "resume-r1",
        continuation: true,
        replay: true,
        replayComplete: true,
        body: "",
        done: false,
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "resume-r1",
        continuation: true,
        body: JSON.stringify({
          type: "tool-output-available",
          toolCallId,
          output: { assigned: true },
        }),
        done: false,
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "resume-r1",
        continuation: true,
        body: JSON.stringify({ type: "text-start", id: "answer-r1" }),
        done: false,
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "resume-r1",
        continuation: true,
        body: JSON.stringify({
          type: "text-delta",
          id: "answer-r1",
          delta: "Assigned to Alex.",
        }),
        done: false,
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "resume-r1",
        continuation: true,
        body: JSON.stringify({ type: "text-end", id: "answer-r1" }),
        done: false,
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "resume-r1",
        continuation: true,
        body: "",
        done: true,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("chat-error").textContent).toBe("");
      expect(screen.getByTestId("tool-state").textContent).toBe(
        "output-available",
      );
      expect(screen.getByTestId("answer").textContent).toContain(
        "Assigned to Alex.",
      );
      expect(screen.getByTestId("assistant-count").textContent).toBe("1");
    });

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_chat_messages",
        messages: [
          initialMessages[0],
          {
            id: "assistant-1",
            role: "assistant",
            parts: [
              {
                type: "tool-assign_conversation",
                toolCallId,
                state: "output-available",
                input: { inbox: "support@example.com", personId: "person-1" },
                output: { assigned: true },
                approval: { id: "approval-r1", approved: true },
              },
              { type: "text", text: "Assigned to Alex.", state: "done" },
            ],
          },
        ],
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("chat-error").textContent).toBe("");
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      expect(screen.getByTestId("tool-state").textContent).toBe(
        "output-available",
      );
      expect(screen.getByTestId("answer").textContent).toContain(
        "Assigned to Alex.",
      );
      expect(screen.getByTestId("assistant-count").textContent).toBe("1");
    });
  });
});
