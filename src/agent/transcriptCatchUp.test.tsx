import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { useAgent } from "agents/react";
import type { UIMessage } from "ai";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import {
  serverTranscriptIsAhead,
  useTranscriptCatchUp,
} from "./transcriptCatchUp";

const user: UIMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "List my inboxes" }],
};
const answer: UIMessage = {
  id: "assistant-1",
  role: "assistant",
  parts: [{ type: "text", text: "You have two inboxes." }],
};

describe("serverTranscriptIsAhead", () => {
  it("is true only when the server extends the client transcript", () => {
    expect(serverTranscriptIsAhead([user], [user, answer])).toBe(true);
    expect(serverTranscriptIsAhead([], [user])).toBe(true);
    expect(serverTranscriptIsAhead([user, answer], [user, answer])).toBe(false);
    expect(serverTranscriptIsAhead([user, answer], [user])).toBe(false);
    expect(
      serverTranscriptIsAhead([{ ...user, id: "other" }], [user, answer]),
    ).toBe(false);
  });
});

function createFakeAgent() {
  const target = new EventTarget();
  const name = "catch-up";
  const agent = {
    _pkurl: `ws://localhost:3000/agents/mail-agent/${name}?_pk=${name}`,
    _pk: name,
    _url: null as string | null,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    send: () => {},
    close: () => {},
    agent: "MailAgent",
    id: "fake-agent",
    name,
    path: [{ agent: "MailAgent", name }],
    getHttpUrl: () =>
      `http://localhost:3000/agents/mail-agent/${name}?_pk=${name}`,
  } as unknown as ReturnType<typeof useAgent>;
  return { agent, target };
}

function Harness({
  agent,
  initial = [user],
}: {
  agent: ReturnType<typeof useAgent>;
  initial?: UIMessage[];
}) {
  const chat = useAgentChat({
    agent,
    getInitialMessages: null,
    messages: initial,
    resume: false,
    syncMessagesToServer: false,
  });
  useTranscriptCatchUp({
    agent,
    messages: chat.messages,
    setMessages: chat.setMessages,
    busy: chat.status === "streaming" || chat.status === "submitted",
  });
  return (
    <div data-testid="transcript">
      {chat.messages
        .map((message) =>
          message.parts
            .map((part) => (part.type === "text" ? part.text : ""))
            .join(""),
        )
        .join(" / ")}
    </div>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useTranscriptCatchUp", () => {
  it("adopts the persisted answer when resume finds no active stream", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json([user, answer], { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { agent, target } = createFakeAgent();

    render(<Harness agent={agent} />);
    expect(screen.getByTestId("transcript").textContent).toBe(
      "List my inboxes",
    );

    await act(async () => {
      target.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "cf_agent_stream_resume_none" }),
        }),
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId("transcript").textContent).toBe(
        "List my inboxes / You have two inboxes.",
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/agents/mail-agent/catch-up/get-messages",
      { credentials: "include" },
    );
  });

  it("keeps the client transcript when the server has diverged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json([{ ...user, id: "someone-else" }, answer], {
          status: 200,
        }),
      ),
    );
    const { agent, target } = createFakeAgent();

    render(<Harness agent={agent} />);
    await act(async () => {
      target.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "cf_agent_stream_resume_none" }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(screen.getByTestId("transcript").textContent).toBe(
      "List my inboxes",
    );
  });

  it("does not refetch when the transcript already ends with an answer", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json([user, answer], { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { agent, target } = createFakeAgent();

    render(<Harness agent={agent} initial={[user, answer]} />);
    await act(async () => {
      target.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "cf_agent_stream_resume_none" }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
